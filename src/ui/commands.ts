import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ForgeWorkOnController } from "../workflows/work-on.ts";
import {
  FORGEDOCK_EVENT_SCHEMA,
  FORGEDOCK_LEASE_SCHEMA,
  FORGEDOCK_PI_VERSION,
} from "../core/version.ts";

export function registerForgeCommands(
  pi: ExtensionAPI,
  controller: ForgeWorkOnController,
): void {
  pi.registerCommand("forge:about", {
    description: "Show the installed ForgeDock Pi core and schema versions",
    handler: (_args, ctx) => {
      const hasSubagents = pi
        .getAllTools()
        .some((tool) => tool.name === "subagent");
      const lines = [
        `ForgeDock Pi ${FORGEDOCK_PI_VERSION}`,
        `event schema: ${FORGEDOCK_EVENT_SCHEMA}`,
        `lease schema: ${FORGEDOCK_LEASE_SCHEMA}`,
        `pi-subagents tool: ${hasSubagents ? "available" : "unavailable"}`,
      ];
      ctx.ui.notify(lines.join("\n"), hasSubagents ? "info" : "warning");
      return Promise.resolve();
    },
  });

  pi.registerCommand("forge:init", {
    description:
      "Create a tracked .forge/config.json for the current GitHub repository",
    handler: async (_args, ctx) => {
      const rootResult = await pi.exec(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd: ctx.cwd, timeout: 30_000 },
      );
      if (rootResult.code !== 0)
        throw new Error("/forge:init must run inside a Git repository.");
      const root = rootResult.stdout.trim();
      const configPath = join(root, ".forge", "config.json");
      if (await pathExists(configPath))
        throw new Error(
          `${configPath} already exists; refusing to overwrite tracked policy.`,
        );
      const repoResult = await pi.exec(
        "gh",
        ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        {
          cwd: root,
          timeout: 30_000,
        },
      );
      if (repoResult.code !== 0 || !repoResult.stdout.trim())
        throw new Error("Unable to resolve the GitHub repository through gh.");
      const templatePath = fileURLToPath(
        new URL("../../templates/config.json", import.meta.url),
      );
      const config = parseTemplateConfig(await readFile(templatePath, "utf8"));
      config.repository.name = repoResult.stdout.trim();
      config.verification = {
        commands: await discoverVerificationCommands(root),
      };
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify(config, null, 2)}\n`,
        "utf8",
      );
      const workflowLabels = [
        [
          "workflow:investigating",
          "D4C5F9",
          "ForgeDock investigation is in progress",
        ],
        [
          "workflow:ready-to-build",
          "FBCA04",
          "Investigation complete and ready to build",
        ],
        [
          "workflow:building",
          "1D76DB",
          "ForgeDock implementation is in progress",
        ],
        [
          "workflow:in-review",
          "5319E7",
          "ForgeDock isolated review is in progress",
        ],
        [
          "workflow:awaiting-merge",
          "0E8A16",
          "All gates passed and merge authority is pending",
        ],
        ["workflow:merged", "0E8A16", "ForgeDock run merged successfully"],
        [
          "workflow:invalid",
          "B60205",
          "Investigation determined the issue is invalid",
        ],
        [
          "workflow:decomposed",
          "C5DEF5",
          "Issue was decomposed into child work",
        ],
        ["needs-human", "D93F0B", "ForgeDock requires human intervention"],
      ] as const;
      for (const [name, color, description] of workflowLabels) {
        const labelResult = await pi.exec(
          "gh",
          [
            "label",
            "create",
            name,
            "--repo",
            config.repository.name,
            "--color",
            color,
            "--description",
            description,
            "--force",
          ],
          { cwd: root, timeout: 30_000 },
        );
        if (labelResult.code !== 0) {
          throw new Error(
            `Unable to create workflow label ${name}: ${labelResult.stderr || labelResult.stdout}`,
          );
        }
      }
      ctx.ui.notify(
        `Created ${configPath} and reconciled canonical workflow labels. Review and commit the policy before running /forge:work-on.`,
        "info",
      );
    },
  });

  pi.registerCommand("forge:work-on", {
    description:
      "Run one GitHub issue through Pi-native work-on and nested review",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^#?(\d+)$/);
      if (!match) throw new Error("Usage: /forge:work-on <issue-number>");
      const issueNumber = Number(match[1]);
      const result = await controller.startIssue(issueNumber, ctx);
      ctx.ui.notify(
        `Launched ForgeDock run ${result.runId} for issue #${result.issueNumber}.\nSubagent: ${result.subagentRunId}\nWorktree: ${result.worktreePath}`,
        "info",
      );
    },
  });

  pi.registerCommand("forge:status", {
    description: "Show ForgeDock runs linked to this Pi session",
    handler: async (_args, ctx) => {
      const runs = controller.listRuns();
      if (runs.length === 0) {
        ctx.ui.notify("No ForgeDock runs are linked to this session.", "info");
        return;
      }
      ctx.ui.notify(
        runs
          .map(
            (run) =>
              `${run.status.padEnd(9)} issue #${run.issueNumber} · ${run.forgeRunId} · child ${run.subagentRunId}`,
          )
          .join("\n"),
        "info",
      );
    },
  });
}

interface TemplateConfig {
  repository: { name: string };
  verification?: {
    commands?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

function parseTemplateConfig(text: string): TemplateConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Bundled Forge config template is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Bundled Forge config template must be an object.");
  const repository = (value as Record<string, unknown>).repository;
  if (
    !repository ||
    typeof repository !== "object" ||
    Array.isArray(repository)
  )
    throw new Error(
      "Bundled Forge config template is missing repository settings.",
    );
  if (typeof (repository as Record<string, unknown>).name !== "string")
    throw new Error(
      "Bundled Forge config template repository name must be a string.",
    );
  return {
    ...(value as Record<string, unknown>),
    repository: {
      ...(repository as Record<string, unknown>),
      name: (repository as Record<string, unknown>).name as string,
    },
  };
}

interface InitVerificationCommand {
  argv: string[];
  required: boolean;
  timeoutMs: number;
  cwd: string;
}

export async function discoverVerificationCommands(
  repositoryRoot: string,
): Promise<Record<string, InitVerificationCommand>> {
  const packageDirectories = await packageManifestDirectories(repositoryRoot);
  for (const directory of packageDirectories) {
    const manifest = await readPackageManifest(directory);
    if (hasScript(manifest, "test")) {
      const cwd = relative(repositoryRoot, directory).split("\\").join("/") || ".";
      return {
        test: {
          argv: ["npm", "test"],
          required: true,
          timeoutMs: 600_000,
          cwd,
        },
      };
    }
  }
  return {};
}

async function packageManifestDirectories(repositoryRoot: string): Promise<string[]> {
  const directories: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    directories.push(directory);
    if (depth >= 3) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries
      .filter(
        (candidate) =>
          candidate.isDirectory() &&
          !candidate.name.startsWith(".") &&
          !["node_modules", "dist", "build", "coverage"].includes(candidate.name),
      )
      .sort((left, right) => left.name.localeCompare(right.name))) {
      await visit(join(directory, entry.name), depth + 1);
    }
  };
  await visit(repositoryRoot, 0);
  return directories;
}

async function readPackageManifest(
  directory: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function hasScript(
  manifest: Record<string, unknown> | undefined,
  name: string,
): boolean {
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
    return false;
  const value = (scripts as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim().length > 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
