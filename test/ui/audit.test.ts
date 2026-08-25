import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  createForgeAuditBody,
  createForgeAuditPrompt,
  formatForgeAuditDraft,
  FORGEDOCK_ISSUE_REPOSITORY,
  normalizeAuditTitle,
  parseForgeAuditDraft,
  registerForgeAudit,
  reviewAndFileForgeAuditIssue,
  sanitizeAuditText,
} from "../../src/ui/audit.ts";

const diagnostics = {
  runStatuses: ["failed", "running", "failed"],
  orchestrationStatuses: ["needs-human"],
  privateRepositoryNames: ["private-owner/private-repo"],
};

const input = {
  title: "builder retries after a terminal failure",
  reproduction: "/forge:work-on reaches build and retries after failure",
  expectedBehavior: "The run should stop and preserve recovery state.",
  evidence:
    "private-owner/private-repo failed under /home/alice/work with token=ghp_abcdefghijklmnopqrstuvwxyz123456",
  impact: "The operator cannot safely resume the run.",
};

test("audit sanitization removes common secrets, paths, and known repository identity", () => {
  const sanitized = sanitizeAuditText(
    "https://github.com/PRIVATE-OWNER/PRIVATE-REPO /Users/alice/code password=hunter2 Bearer abcdefghijklmnop",
    diagnostics.privateRepositoryNames,
  );
  assert.doesNotMatch(
    sanitized,
    /private-owner|private-repo|alice|hunter2|abcdefghijklmnop/i,
  );
  assert.match(sanitized, /\[SOURCE_REPOSITORY\]/);
  assert.match(sanitized, /\$HOME/);
  assert.match(sanitized, /password=\[REDACTED\]/);
  assert.match(sanitized, /Bearer \[REDACTED_TOKEN\]/);
});

test("audit sanitization fails closed for unlinked repositories and arbitrary absolute paths", () => {
  const upstream = `https://github.com/${FORGEDOCK_ISSUE_REPOSITORY}/issues/12`;
  const sanitized = sanitizeAuditText(
    `SecretOwner/SecretRepo https://github.com/HiddenOrg/HiddenRepo ${upstream} /var/lib/acme/private/file.ts C:\\work\\secret-project\\src\\index.ts`,
  );
  assert.doesNotMatch(
    sanitized,
    /SecretOwner|SecretRepo|HiddenOrg|HiddenRepo|\/var\/lib|secret-project/,
  );
  assert.match(sanitized, /\[SOURCE_REPOSITORY_OR_PATH\]/);
  assert.match(sanitized, /\[ABSOLUTE_PATH\]/);
  assert.ok(sanitized.includes(upstream));
});

test("audit title normalization accepts every schema-valid input length", () => {
  const title = "x".repeat(160);
  assert.equal(normalizeAuditTitle(title), `bug: ${title}`);
});

test("audit body contains actionable sections and only sanitized runtime metadata", () => {
  const body = createForgeAuditBody(input, diagnostics);
  assert.match(body, /## Version or commit/);
  assert.match(body, /## Reproduction/);
  assert.match(body, /## Expected behavior/);
  assert.match(body, /## Evidence/);
  assert.match(body, /## Sanitized environment/);
  assert.match(body, /failed \(2\), running \(1\)/);
  assert.match(body, /needs-human \(1\)/);
  assert.match(body, /<!-- forgedock-audit\/v1 -->/);
  assert.doesNotMatch(body, /private-owner|private-repo|alice|ghp_/);
});

test("editable audit drafts preserve a normalized bug title and provenance marker", () => {
  const draft = formatForgeAuditDraft({
    title: "bug: original title",
    body: "## Evidence\nOriginal",
  });
  const parsed = parseForgeAuditDraft(
    draft
      .replace("original title", "edited title")
      .replace("Original", "Edited"),
  );
  assert.equal(parsed.title, "bug: edited title");
  assert.match(parsed.body, /Edited/);
  assert.match(parsed.body, /<!-- forgedock-audit\/v1 -->/);
  assert.throws(
    () => parseForgeAuditDraft("edited title\n\nbody"),
    /first draft line/,
  );
});

test("audit prompt is read-only, privacy-preserving, and routes public reports through the gated tool", () => {
  const prompt = createForgeAuditPrompt("current failed run", diagnostics);
  assert.match(prompt, /read-only ForgeDock workflow auditor/);
  assert.match(prompt, /do not include the source repository name/);
  assert.match(prompt, /private GitHub Security Advisory/);
  assert.match(prompt, /forge_file_audit_issue exactly once/);
  assert.match(prompt, /failed \(2\), running \(1\)/);
  assert.doesNotMatch(prompt, /private-owner|private-repo/);
});

test("audit registration exposes the command and sends the bounded audit prompt", async () => {
  let registeredCommand = "";
  let registeredTool = "";
  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  let sentPrompt = "";
  const pi = {
    registerCommand: (
      name: string,
      definition: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => {
      registeredCommand = name;
      handler = definition.handler;
    },
    registerTool: (definition: { name: string }) => {
      registeredTool = definition.name;
    },
    sendUserMessage: (prompt: string) => {
      sentPrompt = prompt;
    },
  } as unknown as ExtensionAPI;

  registerForgeAudit(pi, () => diagnostics);
  assert.equal(registeredCommand, "forge:audit");
  assert.equal(registeredTool, "forge_file_audit_issue");
  assert.ok(handler);
  await handler("merge gate failed", {
    hasUI: true,
  } as ExtensionCommandContext);
  assert.match(sentPrompt, /merge gate failed/);
  assert.match(sentPrompt, /forge_file_audit_issue exactly once/);
});

test("audit filing uses only the fixed upstream repository after edit and confirmation", async () => {
  let command = "";
  let args: string[] = [];
  let execSignal: AbortSignal | undefined;
  let editorDraft = "";
  const pi = {
    exec: async (
      nextCommand: string,
      nextArgs: string[],
      options?: { signal?: AbortSignal },
    ) => {
      command = nextCommand;
      args = nextArgs;
      execSignal = options?.signal;
      return {
        code: 0,
        stdout: `https://github.com/${FORGEDOCK_ISSUE_REPOSITORY}/issues/123\n`,
        stderr: "",
        killed: false,
      };
    },
  } as unknown as Pick<ExtensionAPI, "exec">;
  const ui = {
    editor: async (_title: string, draft: string) => {
      editorDraft = draft;
      return draft.replace("builder retries", "builder repeats");
    },
    confirm: async () => true,
  } as unknown as ExtensionContext["ui"];

  const controller = new AbortController();
  const result = await reviewAndFileForgeAuditIssue(
    pi,
    { cwd: "/tmp/project", hasUI: true, ui },
    input,
    diagnostics,
    controller.signal,
  );

  assert.equal(command, "gh");
  assert.equal(execSignal, controller.signal);
  assert.deepEqual(args.slice(0, 5), [
    "issue",
    "create",
    "--repo",
    FORGEDOCK_ISSUE_REPOSITORY,
    "--title",
  ]);
  assert.equal(args[5], "bug: builder repeats after a terminal failure");
  assert.equal(
    result.url,
    `https://github.com/${FORGEDOCK_ISSUE_REPOSITORY}/issues/123`,
  );
  assert.doesNotMatch(editorDraft, /private-owner|private-repo|ghp_|alice/);
});

test("audit filing stops before GitHub mutation when aborted", async () => {
  let executed = false;
  const pi = {
    exec: async () => {
      executed = true;
      throw new Error("must not execute");
    },
  } as unknown as Pick<ExtensionAPI, "exec">;
  const ui = {
    editor: async (_title: string, draft: string) => draft,
    confirm: async () => true,
  } as unknown as ExtensionContext["ui"];
  const controller = new AbortController();
  controller.abort(new Error("operator cancelled"));

  await assert.rejects(
    reviewAndFileForgeAuditIssue(
      pi,
      { cwd: "/tmp/project", hasUI: true, ui },
      input,
      diagnostics,
      controller.signal,
    ),
    /operator cancelled/,
  );
  assert.equal(executed, false);
});

test("audit filing fails closed without UI or operator confirmation", async () => {
  let executed = false;
  const pi = {
    exec: async () => {
      executed = true;
      throw new Error("must not execute");
    },
  } as unknown as Pick<ExtensionAPI, "exec">;
  const noUi = {} as ExtensionContext["ui"];
  await assert.rejects(
    reviewAndFileForgeAuditIssue(
      pi,
      { cwd: "/tmp/project", hasUI: false, ui: noUi },
      input,
      diagnostics,
    ),
    /requires interactive review/,
  );

  const deniedUi = {
    editor: async (_title: string, draft: string) => draft,
    confirm: async () => false,
  } as unknown as ExtensionContext["ui"];
  await assert.rejects(
    reviewAndFileForgeAuditIssue(
      pi,
      { cwd: "/tmp/project", hasUI: true, ui: deniedUi },
      input,
      diagnostics,
    ),
    /not confirmed/,
  );
  assert.equal(executed, false);
});
