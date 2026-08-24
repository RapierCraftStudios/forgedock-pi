#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
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
  const issueMarkers = [
    "<!-- FORGE:INVESTIGATOR -->",
    "<!-- FORGE:FAST_PATH -->",
    "<!-- FORGE:CONTRACT -->",
    "<!-- FORGE:CONTEXT -->",
    "<!-- FORGE:ARCHITECT -->",
    "<!-- FORGE:BUILDER -->",
    "<!-- FORGE:BUILDER:COMPLETE -->",
    "<!-- FORGE:ACCEPTANCE_GATE:PASSED -->",
    "<!-- FORGE:REVIEW_STARTED -->",
    "<!-- FORGE:TRAJECTORY -->",
    "<!-- FORGE:CARD:",
  ];
  const missingIssue = issueMarkers.filter(
    (marker) => !issueComments.includes(marker),
  );
  if (issue.state !== "CLOSED")
    throw new Error(`Audit failed: issue #${issueNumber} is ${issue.state}.`);
  if (!labels.includes("workflow:merged"))
    throw new Error("Audit failed: workflow:merged label missing.");
  if (missingIssue.length)
    throw new Error(
      `Audit failed: issue markers missing: ${missingIssue.join(", ")}.`,
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
    "state,comments,headRefOid,baseRefName",
  ]);
  const pullComments = pull.comments.map((comment) => comment.body).join("\n");
  const prMarkers = [
    "<!-- FORGE:REVIEW_ROUTE",
    "<!-- FORGE:REVIEW-AGENT:correctness -->",
    "<!-- FORGE:REVIEW-AGENT:security -->",
    "<!-- FORGE:REVIEW -->",
    "<!-- FORGE:REVIEW_SUMMARY -->",
    "<!-- REVIEW-FINDINGS-START -->",
    "<!-- REVIEW-FINDINGS-END -->",
    "<!-- FORGE:DECISION_RECORD -->",
  ];
  const missingPr = prMarkers.filter(
    (marker) => !pullComments.includes(marker),
  );
  if (pull.state !== "MERGED")
    throw new Error(`Audit failed: PR #${pullNumber} is ${pull.state}.`);
  if (missingPr.length)
    throw new Error(
      `Audit failed: PR markers missing: ${missingPr.join(", ")}.`,
    );
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
