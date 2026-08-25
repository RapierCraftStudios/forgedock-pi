#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const commentContract = JSON.parse(
  readFileSync(
    resolve(
      packageRoot,
      "test/fixtures/comment-contract/claude-p0/contract.json",
    ),
    "utf8",
  ),
);
const targetCwd = resolve(process.argv[2] ?? "");
const issueNumber = Number(process.argv[3]);
const timeoutMs = Number(
  process.env.FORGEDOCK_E2E_TIMEOUT_MS ?? 45 * 60 * 1000,
);

if (!process.argv[2] || !Number.isSafeInteger(issueNumber) || issueNumber < 1) {
  console.error(
    "Usage: node scripts/e2e-rpc.mjs <target-repository> <issue-number>",
  );
  process.exit(2);
}

const piSubagentsEntry = resolve(
  packageRoot,
  "node_modules",
  "pi-subagents",
  "index.ts",
);
const forgeEntry = resolve(packageRoot, "src", "index.ts");
const child = spawn(
  "pi",
  [
    "--mode",
    "rpc",
    "--approve",
    "--no-extensions",
    "-e",
    piSubagentsEntry,
    "-e",
    forgeEntry,
    "--name",
    `ForgeDock E2E #${issueNumber}`,
  ],
  {
    cwd: targetCwd,
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  },
);

let buffer = "";
let complete = false;
let commandAccepted = false;
const timeout = setTimeout(
  () => finish(new Error(`E2E timed out after ${timeoutMs}ms`)),
  timeoutMs,
);
timeout.unref();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    handleRecord(line);
  }
});

child.once("error", (error) => finish(error));
child.once("exit", (code, signal) => {
  if (!complete)
    finish(
      new Error(
        `Pi RPC exited early: code=${String(code)} signal=${String(signal)}`,
      ),
    );
});

child.stdin.write(
  `${JSON.stringify({ id: "work-on", type: "prompt", message: `/forge:work-on ${issueNumber}` })}\n`,
);

function handleRecord(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch (error) {
    finish(new Error(`Invalid RPC JSON: ${error.message}\n${line}`));
    return;
  }

  if (record.type === "response" && record.id === "work-on") {
    if (!record.success) {
      finish(
        new Error(`Forge command rejected: ${record.error ?? "unknown error"}`),
      );
      return;
    }
    commandAccepted = true;
    console.log(
      "Forge command accepted; waiting for nested work-on and review.",
    );
    return;
  }

  if (record.type === "extension_error") {
    finish(new Error(`Extension error in ${record.event}: ${record.error}`));
    return;
  }

  if (record.type === "extension_ui_request" && record.method === "notify") {
    console.log(`[${record.notifyType ?? "info"}] ${record.message}`);
    if (
      record.notifyType === "error" ||
      (record.notifyType === "warning" &&
        typeof record.message === "string" &&
        (record.message.includes(" stopped:") ||
          record.message.includes(" not merged:")))
    ) {
      finish(
        new Error(
          String(
            record.message ??
              "ForgeDock extension reported a terminal failure.",
          ),
        ),
      );
      return;
    }
    if (
      typeof record.message === "string" &&
      record.message.includes("merged through PR #")
    ) {
      try {
        verifyRemoteAudit();
        complete = true;
        finish();
      } catch (error) {
        finish(error);
      }
    }
  }
}

function verifyRemoteAudit() {
  const repo = ghJson([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
  ]).nameWithOwner;
  const issue = ghJson([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "state,labels,comments",
  ]);
  const issueComments = issue.comments
    .map((comment) => comment.body)
    .join("\n");
  const labels = issue.labels.map((label) => label.name);
  const missingIssue = missingContractArtifacts(
    issue.comments.map((comment) => comment.body),
    commentContract.issueArtifacts,
  );
  if (issue.state !== "CLOSED")
    throw new Error(`Audit failed: issue #${issueNumber} is ${issue.state}.`);
  if (!labels.includes("workflow:merged"))
    throw new Error("Audit failed: workflow:merged label missing.");
  if (missingIssue.length)
    throw new Error(
      `Audit failed: issue artifacts missing or incomplete: ${missingIssue.join(", ")}.`,
    );
  const prMatch = issueComments.match(/PR #(\d+)/);
  if (!prMatch)
    throw new Error("Audit failed: no PR number in issue artifacts.");
  const pullNumber = prMatch[1];
  const pull = ghJson([
    "pr",
    "view",
    pullNumber,
    "--repo",
    repo,
    "--json",
    "state,comments,headRefOid,headRefName,baseRefName,mergeCommit",
  ]);
  const pullComments = pull.comments.map((comment) => comment.body).join("\n");
  const missingPr = missingContractArtifacts(
    pull.comments.map((comment) => comment.body),
    commentContract.pullRequestArtifacts,
  );
  if (pull.state !== "MERGED")
    throw new Error(`Audit failed: PR #${pullNumber} is ${pull.state}.`);
  if (missingPr.length)
    throw new Error(
      `Audit failed: PR artifacts missing or incomplete: ${missingPr.join(", ")}.`,
    );
  assertNoProhibitedContent([...issue.comments, ...pull.comments]);
  assertLogicalArtifactRevisions(issue.comments);
  assertSemanticParity({
    repo,
    issueNumber,
    pullNumber,
    issue,
    pull,
  });
  const branchProbe = spawnSync(
    "gh",
    ["api", `repos/${repo}/git/ref/heads/${pull.headRefName}`],
    { cwd: targetCwd, encoding: "utf8" },
  );
  if (branchProbe.status === 0) {
    throw new Error(
      `Audit failed: merged feature branch ${pull.headRefName} still exists remotely.`,
    );
  }
  console.log(
    `Remote audit passed for issue #${issueNumber} and PR #${pullNumber}.`,
  );
}

function missingContractArtifacts(comments, artifacts) {
  const missing = [];
  for (const artifact of artifacts) {
    const comment = comments.find((body) =>
      artifact.markers.every((marker) => body.includes(marker)),
    );
    if (!comment) {
      missing.push(artifact.name);
      continue;
    }
    assertSectionsNonEmpty(comment, artifact.name);
  }
  return missing;
}

function assertSectionsNonEmpty(body, artifactName) {
  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^#{2,4}\s+\S/.test(lines[index])) continue;
    let content = "";
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^#{2,4}\s+\S/.test(lines[cursor])) break;
      if (!lines[cursor].startsWith("<!--")) content += lines[cursor].trim();
    }
    if (!content)
      throw new Error(
        `Audit failed: ${artifactName} has empty section ${lines[index]}.`,
      );
  }
}

function assertNoProhibitedContent(comments) {
  const body = comments.map((comment) => comment.body).join("\n");
  for (const pattern of commentContract.prohibitedPatterns) {
    if (new RegExp(pattern, "i").test(body))
      throw new Error(`Audit failed: prohibited synthetic content matched ${pattern}.`);
  }
}

function assertLogicalArtifactRevisions(comments) {
  const identities = new Map();
  for (const comment of comments) {
    const match = comment.body.match(
      /<!-- FORGEDOCK-ARTIFACT-IDENTITY run=([^\s]+) key=([^\s]+) -->/,
    );
    if (!match) continue;
    const identity = `${match[1]}:${match[2]}`;
    const revisions = identities.get(identity) ?? [];
    revisions.push(comment);
    identities.set(identity, revisions);
  }
  for (const [identity, revisions] of identities) {
    for (const revision of revisions.slice(1)) {
      if (!revision.body.includes("<!-- FORGEDOCK-SUPERSEDES comment="))
        throw new Error(
          `Audit failed: logical artifact ${identity} has an unsuperseded older revision.`,
        );
    }
  }
}

function assertSemanticParity(input) {
  const finalDecisionComment = input.pull.comments.find((comment) =>
    comment.body.includes("<!-- FORGE:FINAL_REVIEW_DECISION -->"),
  );
  const finalDecision = extractFencedJson(
    finalDecisionComment?.body,
    "final review decision",
  );
  if (finalDecision.headSha !== input.pull.headRefOid)
    throw new Error("Audit failed: final decision head differs from live PR head.");
  if (!Array.isArray(finalDecision.checkResults) || !finalDecision.checkResults.length)
    throw new Error("Audit failed: final decision has no verification results.");
  if (
    finalDecision.checkResults.some((check) =>
      ["pending", "unknown", "failed", "skipped"].includes(check.status),
    )
  )
    throw new Error("Audit failed: final decision contains unresolved checks.");
  if (
    finalDecision.decision !== "approved" &&
    finalDecision.decision !== "approved-with-follow-ups"
  )
    throw new Error(
      `Audit failed: merged PR used decision ${finalDecision.decision}.`,
    );

  const identity = finalDecisionComment.body.match(
    /FORGE:FINAL-REVIEW-DECISION run=([^\s]+) round=(\d+) head=([^\s]+) -->/,
  );
  if (!identity) throw new Error("Audit failed: final decision identity is missing.");
  const [, runId, round, headSha] = identity;
  const summaryMarker = `<!-- FORGE:REVIEW-SUMMARY-INSTANCE run=${runId} round=${round} head=${headSha} -->`;
  const summary = input.pull.comments.filter((comment) =>
    comment.body.includes(summaryMarker),
  );
  if (summary.length !== 1)
    throw new Error("Audit failed: expected exactly one current joined summary.");
  for (const domain of ["correctness", "security"]) {
    const marker = `<!-- FORGE:REVIEW-INSTANCE run=${runId} domain=${domain} round=${round} head=${headSha} -->`;
    const reviewers = input.pull.comments.filter((comment) =>
      comment.body.includes(marker),
    );
    if (reviewers.length !== 1)
      throw new Error(
        `Audit failed: expected exactly one current ${domain} reviewer artifact.`,
      );
  }

  const checkpointComment = input.issue.comments.find(
    (comment) =>
      comment.body.includes("key=review-checkpoint") &&
      comment.body.includes("<!-- FORGE:CHECKPOINT -->"),
  );
  const checkpoint = extractInlineJson(
    checkpointComment?.body,
    "review checkpoint",
  );
  const decisionRecordComment = input.pull.comments.find((comment) =>
    comment.body.includes("<!-- FORGE:DECISION_RECORD -->"),
  );
  const decisionRecord = extractFencedJson(
    decisionRecordComment?.body,
    "decision record",
  );
  const mergeSha = input.pull.mergeCommit?.oid;
  if (!mergeSha) throw new Error("Audit failed: merged PR has no merge commit.");
  if (
    checkpoint.decision !== finalDecision.decision ||
    decisionRecord.review?.decision !== finalDecision.decision
  )
    throw new Error("Audit failed: review decision drifted across artifacts.");
  if (
    checkpoint.head !== finalDecision.headSha ||
    decisionRecord.head_sha !== finalDecision.headSha
  )
    throw new Error("Audit failed: reviewed head drifted across artifacts.");
  if (
    checkpoint.merge_commit !== mergeSha ||
    decisionRecord.merge_commit !== mergeSha
  )
    throw new Error("Audit failed: merge SHA drifted across artifacts.");

  const files = ghJson([
    "api",
    `repos/${input.repo}/pulls/${input.pullNumber}/files`,
  ]).map((file) => file.filename);
  const implementation = input.issue.comments.find((comment) =>
    comment.body.includes("<!-- FORGE:BUILDER -->"),
  )?.body;
  if (!implementation)
    throw new Error("Audit failed: implementation artifact is missing.");
  for (const file of files) {
    if (!implementation.includes(file))
      throw new Error(
        `Audit failed: implementation artifact omits changed file ${file}.`,
      );
  }
  if (decisionRecord.build?.files_changed !== files.length)
    throw new Error("Audit failed: decision record changed-file count differs from Git.");

  const close = input.issue.comments.find((comment) =>
    comment.body.includes("key=close-evidence"),
  )?.body;
  const trajectory = input.issue.comments.find((comment) =>
    comment.body.includes("<!-- FORGE:TRAJECTORY -->"),
  )?.body;
  if (
    !close?.includes(finalDecision.headSha) ||
    !close.includes(mergeSha) ||
    !trajectory?.includes(finalDecision.headSha) ||
    !trajectory.includes(mergeSha)
  )
    throw new Error("Audit failed: close or trajectory evidence differs from remote facts.");
  const cardMatch = trajectory.match(/<!-- FORGE:CARD: v1 sha:[^\s]+ b64:([^\s]+) -->/);
  if (!cardMatch) throw new Error("Audit failed: trajectory card is missing.");
  const card = JSON.parse(Buffer.from(cardMatch[1], "base64").toString("utf8"));
  if (
    card.review !== finalDecision.decision ||
    card.reviewed !== finalDecision.headSha ||
    card.commit !== mergeSha
  )
    throw new Error("Audit failed: trajectory card differs from the final decision.");
}

function extractFencedJson(body, name) {
  const match = body?.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) throw new Error(`Audit failed: ${name} JSON is missing.`);
  return JSON.parse(match[1]);
}

function extractInlineJson(body, name) {
  const marker = body?.indexOf("<!-- FORGE:CHECKPOINT -->") ?? -1;
  if (marker < 0) throw new Error(`Audit failed: ${name} is missing.`);
  const match = body.slice(marker).match(/\{[^\n]+\}/);
  if (!match) throw new Error(`Audit failed: ${name} JSON is missing.`);
  return JSON.parse(match[0]);
}

function ghJson(args) {
  const result = spawnSync("gh", args, { cwd: targetCwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `gh ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `gh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function finish(error) {
  if (complete && error) return;
  clearTimeout(timeout);
  if (error) {
    console.error(error.stack ?? error.message ?? String(error));
    process.exitCode = 1;
  } else if (commandAccepted) {
    console.log("ForgeDock E2E completed successfully.");
  } else {
    console.error("Forge command never returned an accepted response.");
    process.exitCode = 1;
  }
  complete = true;
  child.stdin.end();
  setTimeout(() => child.kill("SIGTERM"), 500).unref();
}
