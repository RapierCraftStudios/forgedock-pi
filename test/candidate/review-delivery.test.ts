import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import { isStagingMutationBlocked } from "../../candidate/extension.ts";
import registerCandidateTools from "../../candidate/tools.ts";
import registerReviewerTools from "../../candidate/reviewer-tools.ts";

const repository = "example/product";
const pullRequest = 7;
const head = "a".repeat(40);
const baseSha = "b".repeat(40);
const baseRef = "main";
const roles = ["correctness", "security", "specialist"];
const commonKey = "common-review-key-33800";
const nativeRunId = "native-specialist-run-33800";
const reviewerBody = [
  "### Scope and decisions considered",
  "Reviewed the exact frozen patch and required consumers.",
  "### Evidence and findings",
  "No unstructured conclusions are substituted for observations.",
  "### Verification limitations",
  "This isolated fixture uses a controlled publication transport.",
  "### Recommendation",
  "Parent adjudication follows only after report readback.",
].join("\n\n");

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reportText(role: string, reportId: string, body = "", observations: unknown[] = []): string {
  return `<!-- FORGE:REVIEWER_REPORT ${JSON.stringify({ v: 1, kind: "REVIEW", repository, pullRequest, head, baseRef, baseSha, role, reportId })} -->\n<!-- FORGE:REVIEW_OBSERVATIONS ${JSON.stringify(observations)} -->\n\n## ForgeDock review\n\n${body.trim()}\n`;
}

async function writeReviewerEvidence(root: string, review: Record<string, any>, role: string, body = reviewerBody, observations: unknown[] = []): Promise<void> {
  const bodyBytes = `${body.trim()}\n`;
  const observationsBytes = `${JSON.stringify(observations, null, 2)}\n`;
  const bodyPath = join(root, `${role}.body.md`);
  const reportPath = join(root, `${role}.report.md`);
  const observationsPath = join(root, `${role}.observations.json`);
  await writeFile(bodyPath, bodyBytes);
  await writeFile(observationsPath, observationsBytes);
  await writeFile(reportPath, reportText(role, review.roleArtifactKeys[role], body, observations));
  await writeFile(join(root, `${role}.publication-recovery.json`), `${JSON.stringify({
    schema: "forgedock.candidate-review-publication-recovery/v1",
    state: review.publish ? "published" : "saved",
    recoveryAttempts: 0,
    nativeRunId: `native-${role}-run-33800`,
    reviewArtifactKey: review.artifactKey,
    roleArtifactKey: review.roleArtifactKeys[role],
    suppliedArtifactKey: review.roleArtifactKeys[role],
    repository, pullRequest, head, baseRef, baseSha, role,
    publish: review.publish,
    bodyPath, reportPath, observationsPath, body: body.trim(), observations,
    bodySha256: digest(bodyBytes), observationsSha256: digest(observationsBytes),
    publication: review.publish ? "published" : "saved",
  }, null, 2)}\n`);
}

async function preparedRoot(): Promise<{ root: string; review: Record<string, any> }> {
  const root = await mkdtemp("/tmp/forgedock-review-delivery-");
  const workflowPath = join(root, "workflow.js");
  const workflow = "const assignments = [];\n";
  await writeFile(workflowPath, workflow);
  const roleArtifactKeys = Object.fromEntries(roles.map((role) => [role, `${role}-authorization-key`])) as Record<string, string>;
  const review = {
    schema: "forgedock.candidate-review/v1",
    artifactRoot: root,
    artifactKey: commonKey,
    repository,
    pullRequest,
    head,
    baseRef,
    baseSha,
    sourceRoot: root,
    configRoot: root,
    publish: true,
    mode: "staging",
    roles,
    roleArtifactKeys,
    workflowPath,
    workflowSha256: digest(workflow),
    config: { protectedBranch: "main", review: { maxConcurrent: 2, reviewerTimeoutMs: 600_000 }, verificationCommands: {} },
  };
  await writeFile(join(root, "review.json"), `${JSON.stringify(review, null, 2)}\n`);
  for (const role of roles) {
    await writeFile(join(root, `${role}.authorization.json`), `${JSON.stringify({
      schema: "forgedock.candidate-review-role/v1",
      artifactRoot: root,
      artifactKey: roleArtifactKeys[role],
      role,
      repository,
      pullRequest,
      head,
      baseRef,
      baseSha,
      publish: true,
    }, null, 2)}\n`);
  }
  await writeReviewerEvidence(root, review, "correctness");
  await writeReviewerEvidence(root, review, "security");
  const policy = {
    schema: "forgedock.candidate-pr-policy/v1",
    repository,
    pullRequest,
    identity: { head, baseRef, baseSha },
    policy: {
      requirements: { applicability: "confirmed-none", requiredNames: [] },
      evaluatedRequiredChecks: { status: "available", exitCode: 0, data: [] },
    },
    configuration: { verificationCommands: {} },
  };
  await writeFile(join(root, "policy.json"), `${JSON.stringify({ schema: "forgedock.candidate-policy/v1", artifactKey: commonKey, repository, pullRequest, head, baseRef, baseSha, current: policy, prepared: policy }, null, 2)}\n`);
  return { root, review };
}

function registry(root: string, options: { failRecovery?: boolean; publisherGate?: { started: () => void; wait: Promise<void> } } = {}) {
  const tools = new Map<string, any>();
  const calls: Array<{ name: string; args: string[] }> = [];
  const records: string[] = [];
  const publishedRoles = new Set(["correctness", "security"]);
  const policy = {
    schema: "forgedock.candidate-pr-policy/v1",
    repository,
    pullRequest,
    identity: { head, baseRef, baseSha },
    policy: {
      requirements: { applicability: "confirmed-none", requiredNames: [] },
      evaluatedRequiredChecks: { status: "available", exitCode: 0, data: [] },
    },
    configuration: { verificationCommands: {} },
  };
  const fakePi = {
    registerTool(definition: any) { tools.set(definition.name, definition); },
    async exec(name: string, args: string[] = []) {
      calls.push({ name, args });
      if (name === "gh") return { code: 0, stdout: "[]", stderr: "" };
      if (args.includes("inspect-pr")) return { code: 0, stdout: JSON.stringify(policy), stderr: "" };
      if (args.includes("verify-reviewer")) {
        const role = args[args.indexOf("--role") + 1]!;
        if (!publishedRoles.has(role)) return { code: 1, stdout: "", stderr: "exact report comment absent" };
        return { code: 0, stdout: JSON.stringify({ schema: "forgedock.candidate-review-report-verification/v1", publication: "published", repository, pullRequest, head, baseRef, baseSha, role, reportId: args[args.indexOf("--report-id") + 1], commentId: role === "correctness" ? 77 : role === "security" ? 78 : 79, url: `https://github.com/${repository}/pull/${pullRequest}#issuecomment-${role}` }), stderr: "" };
      }
      if (args.includes("record") && args.includes("reviewer")) {
        const role = args[args.indexOf("--role") + 1]!;
        const reportPath = args[args.indexOf("--report-file") + 1]!;
        const reportId = args[args.indexOf("--report-id") + 1]!;
        const body = await readFile(args[args.indexOf("--body-file") + 1]!, "utf8");
        const observations = JSON.parse(await readFile(args[args.indexOf("--observations-file") + 1]!, "utf8"));
        const canonical = reportText(role, reportId, body, observations);
        if (!args.includes("--publish")) {
          let existing: string | undefined;
          try { existing = await readFile(reportPath, "utf8"); } catch {}
          if (existing !== undefined && existing !== canonical) return { code: 1, stdout: "", stderr: "Refusing to overwrite report with different authored content" };
          if (existing === undefined) await writeFile(reportPath, canonical);
          return { code: 0, stdout: JSON.stringify({ publication: "saved", reportFile: reportPath }), stderr: "" };
        }
        options.publisherGate?.started();
        await options.publisherGate?.wait;
        if (options.failRecovery && role === "specialist") return { code: 1, stdout: "", stderr: "controlled publication failure" };
        await writeFile(reportPath, canonical);
        publishedRoles.add(role);
        return { code: 0, stdout: JSON.stringify({ publication: "published", id: 79, url: `https://github.com/${repository}/pull/${pullRequest}#issuecomment-79`, reconciliation: "created" }), stderr: "" };
      }
      if (args.includes("adjudication")) {
        const inputPath = args[args.indexOf("--input") + 1]!;
        const input = JSON.parse(await readFile(inputPath, "utf8"));
        const decisionPath = join(root, "adjudication.json");
        const prepared = JSON.parse(await readFile(join(root, "review.json"), "utf8"));
        const artifact = {
          schema: "forgedock.candidate-adjudication/v1",
          artifactKey: commonKey,
          repository,
          pullRequest,
          head,
          baseRef,
          baseSha,
          mode: input.mode,
          gate: input.gate,
          verdict: input.verdict,
          roles,
          reports: roles.map((role) => ({ role, reportId: prepared.roleArtifactKeys[role] })),
          decisions: input.decisions,
          panelUrl: `https://github.com/${repository}/pull/${pullRequest}#issuecomment-99`,
          trackingPublication: "complete",
          gateBody: "## REVIEW-PANEL\nParent accepted the completed panel.",
        };
        await writeFile(decisionPath, `${JSON.stringify(artifact, null, 2)}\n`);
        return { code: 0, stdout: JSON.stringify({ publication: "published", decisionPath, panelUrl: artifact.panelUrl }), stderr: "" };
      }
      if (args.includes("--kind") && (args[args.indexOf("--kind") + 1] === "GATED" || args[args.indexOf("--kind") + 1] === "STAGING_GATE")) {
        const bodyPath = args[args.indexOf("--body-file") + 1]!;
        records.push(await readFile(bodyPath, "utf8"));
        const reportPath = args[args.indexOf("--report-file") + 1]!;
        await writeFile(reportPath, "controlled durable record\n");
        return { code: 0, stdout: JSON.stringify({ publication: "published", id: 88, url: `https://github.com/${repository}/pull/${pullRequest}#issuecomment-88` }), stderr: "" };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    },
  };
  registerCandidateTools(fakePi as never);
  registerReviewerTools(fakePi as never);
  return { tools, calls, records };
}

function reviewerParams(root: string, review: Record<string, any>, artifactKey: string, role = "specialist") {
  return {
    repository,
    pullRequest,
    head,
    baseRef,
    baseSha,
    role,
    body: reviewerBody,
    bodyPath: join(root, `${role}.body.md`),
    reportPath: join(root, `${role}.report.md`),
    reviewRoot: root,
    authorizationPath: join(root, `${role}.authorization.json`),
    artifactKey,
    publish: review.publish,
    observations: [],
  };
}

function recoveryParams(root: string, role = "specialist", runId = nativeRunId) {
  return { repository, pullRequest, head, baseRef, baseSha, reviewRoot: root, artifactKey: commonKey, role, nativeRunId: runId, nativeTerminal: "completed" as const };
}

function adjudicationParams(root: string) {
  return {
    repository,
    pullRequest,
    head,
    baseRef,
    baseSha,
    mode: "staging",
    reviewRoot: root,
    artifactKey: commonKey,
    verdict: "APPROVE",
    gate: "PASS",
    decisions: [],
    historicalDecisions: [],
    checks: [],
    limitations: [],
    nextAction: "No follow-up.",
    allowIssueWrites: false,
    publish: true,
  };
}

async function writeReviewerExecutionReceipt(root: string, review: Record<string, any>, overrides: Record<string, { nativeRunId: string | null; nativeStatus: string; exitCode: number | null }> = {}): Promise<void> {
  const roleResults = review.roles.map((role: string) => ({
    role,
    ...(overrides[role] ?? { nativeRunId: role === "specialist" ? nativeRunId : `native-${role}-run-33800`, nativeStatus: "completed", exitCode: 0 }),
    reportPath: join(root, `${role}.report.md`),
    recoveryPath: join(root, `${role}.publication-recovery.json`),
  }));
  await writeFile(join(root, "reviewer-execution.json"), `${JSON.stringify({
    schema: "forgedock.candidate-review-execution/v1",
    repository, pullRequest, head, baseRef, baseSha, artifactKey: review.artifactKey, mode: review.mode,
    workflowPath: review.workflowPath, workflowSha256: review.workflowSha256,
    toolCallId: "fixture-reviewer-tool-call", workflowRunId: "fixture-workflow-run-33800",
    completedAt: "2026-09-23T00:00:00.000Z", roleResults,
  }, null, 2)}\n`);
}

async function createInitialFailure(tools: Map<string, any>, root: string, review: Record<string, any>, executionOverrides: Record<string, { nativeRunId: string | null; nativeStatus: string; exitCode: number | null }> = {}): Promise<void> {
  const priorRunId = process.env.PI_SUBAGENT_RUN_ID;
  process.env.PI_SUBAGENT_RUN_ID = nativeRunId;
  try {
    await assert.rejects(
      tools.get("forge_publish_reviewer").execute("review-specialist", reviewerParams(root, review, commonKey)),
      /No report was written or published.*publication-recovery\.json/,
    );
  } finally {
    if (priorRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
    else process.env.PI_SUBAGENT_RUN_ID = priorRunId;
  }
  await writeReviewerExecutionReceipt(root, review, executionOverrides);
}

test("recover one exact completed reviewer, preserve prior reports, then adjudicate and gate", async () => {
  const { root, review } = await preparedRoot();
  const { tools, calls, records } = registry(root);
  const before = await Promise.all(["correctness", "security"].map((role) => readFile(join(root, `${role}.report.md`), "utf8")));
  try {
    await createInitialFailure(tools, root, review);
    const sidecarPath = join(root, "specialist.publication-recovery.json");
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    assert.equal(sidecar.state, "recovery-available");
    assert.equal(sidecar.nativeRunId, nativeRunId);
    assert.equal(sidecar.roleArtifactKey, review.roleArtifactKeys.specialist);
    assert.equal(sidecar.suppliedArtifactKey, commonKey);
    assert.equal(sidecar.bodySha256, digest(`${reviewerBody}\n`));
    assert.equal(await readFile(join(root, "specialist.report.md"), "utf8").catch(() => ""), "");
    assert.equal(calls.filter((call) => call.args[1] === "record" && call.args[2] === "reviewer" && call.args.includes("--publish")).length, 0);

    const adjudication = tools.get("forge_publish_adjudication");
    await assert.rejects(adjudication.execute("wrong-mode", { ...adjudicationParams(root), mode: "standard" }), /mode does not match the route/);
    assert.equal(calls.filter((call) => call.args.includes("adjudication")).length, 0);
    await assert.rejects(adjudication.execute("adjudicate", adjudicationParams(root)), /Adjudication was not attempted: exact authored report exists but publication is not verified for role specialist/);
    assert.equal((await readdir(root)).some((name) => name.startsWith("adjudication-input-r0-")), false);
    await assert.rejects(tools.get("forge_publish_incomplete_review").execute("preempt-recovery", { repository, pullRequest, head, baseRef, baseSha, reviewRoot: root, artifactKey: commonKey, role: "specialist", nativeRunId, nativeTerminal: "completed", deliveryError: "normal recovery available", publish: true }), /authorized unused recovery/);
    assert.equal(calls.filter((call) => call.args.includes("--kind") && call.args.includes("GATED")).length, 0);
    const incomplete = await tools.get("forge_publish_incomplete_review").execute("execution-limit", { repository, pullRequest, head, baseRef, baseSha, reviewRoot: root, artifactKey: commonKey, role: "specialist", nativeRunId, nativeTerminal: "completed", deliveryError: "Parent execution limit reached before recovery.", recoveryBlocker: "execution-limit", blockerEvidence: "bounded parent operation budget reached", publish: true });
    assert.equal(incomplete.details.recordKind, "GATED");
    const incompleteBody = records.at(-1)!;
    assert.match(incompleteBody, /recovery remains authorized and unconsumed/);
    assert.doesNotMatch(incompleteBody, /recovery attempt is exhausted/);
    assert.equal(JSON.parse(await readFile(join(root, "specialist.publication-recovery.json"), "utf8")).recoveryAttempts, 0);

    await assert.rejects(tools.get("forge_recover_reviewer_publication").execute("wrong-run", recoveryParams(root, "specialist", "another-native-run")), /native run identity/);
    await assert.rejects(tools.get("forge_recover_reviewer_publication").execute("wrong-role", recoveryParams(root, "security")), /native run identity/);
    await assert.rejects(tools.get("forge_recover_reviewer_publication").execute("wrong-head", { ...recoveryParams(root), head: "c".repeat(40) }), /prepared frozen review/);
    const timedOutReadback = await tools.get("forge_recover_reviewer_publication").execute("timed-out", { ...recoveryParams(root), nativeTerminal: "timed-out" });
    assert.equal(timedOutReadback.details.publication, "unverified");
    assert.equal(timedOutReadback.details.recovered, false);
    assert.equal(calls.filter((call) => call.args[1] === "record" && call.args[2] === "reviewer" && call.args.includes("--publish")).length, 0);
    const authPath = join(root, "specialist.authorization.json");
    const authorization = JSON.parse(await readFile(authPath, "utf8"));
    authorization.artifactKey = "wrong-role-key";
    await writeFile(authPath, JSON.stringify(authorization));
    await assert.rejects(tools.get("forge_recover_reviewer_publication").execute("wrong-authorization", recoveryParams(root)), /exact prepared role/);
    authorization.artifactKey = review.roleArtifactKeys.specialist;
    await writeFile(authPath, JSON.stringify(authorization));
    sidecar.roleArtifactKey = "wrong-role-key";
    await writeFile(sidecarPath, JSON.stringify(sidecar));
    await assert.rejects(tools.get("forge_recover_reviewer_publication").execute("wrong-sidecar-key", recoveryParams(root)), /exact prepared role/);
    sidecar.roleArtifactKey = review.roleArtifactKeys.specialist;
    await writeFile(sidecarPath, JSON.stringify(sidecar));

    const recovered = await tools.get("forge_recover_reviewer_publication").execute("recover", recoveryParams(root));
    assert.equal(recovered.details.publication, "published");
    assert.equal(recovered.details.nativeRunId, nativeRunId);
    assert.equal(calls.filter((call) => call.args[1] === "record" && call.args[2] === "reviewer" && call.args.includes("--publish")).length, 1);
    const publisher = calls.find((call) => call.args[1] === "record" && call.args[2] === "reviewer" && call.args.includes("--publish"))!;
    assert.equal(publisher.args[publisher.args.indexOf("--role") + 1], "specialist");
    assert.equal(publisher.args[publisher.args.indexOf("--report-id") + 1], review.roleArtifactKeys.specialist);
    assert.equal(publisher.args.includes(commonKey), false);
    assert.match(await readFile(join(root, "specialist.report.md"), "utf8"), /specialist-authorization-key/);
    assert.deepEqual(await Promise.all(["correctness", "security"].map((role) => readFile(join(root, `${role}.report.md`), "utf8"))), before);

    const repeated = await tools.get("forge_recover_reviewer_publication").execute("recover-again", recoveryParams(root));
    assert.equal(repeated.details.repeated, true);
    assert.equal(calls.filter((call) => call.args[1] === "record" && call.args[2] === "reviewer" && call.args.includes("--publish")).length, 1);
    const specialistReportPath = join(root, "specialist.report.md");
    const specialistReport = await readFile(specialistReportPath, "utf8");
    const alteredBody = specialistReport.replace("Reviewed the exact frozen patch and required consumers.", "Altered findings not present in retained authorship.");
    assert.notEqual(alteredBody, specialistReport);
    await writeFile(specialistReportPath, alteredBody);
    await assert.rejects(adjudication.execute("altered-body", adjudicationParams(root)), /authored recovery content does not match its prepared role/);
    const alteredObservations = specialistReport.replace("FORGE:REVIEW_OBSERVATIONS []", "FORGE:REVIEW_OBSERVATIONS [{\"id\":\"specialist:F1\"}]");
    assert.notEqual(alteredObservations, specialistReport);
    await writeFile(specialistReportPath, alteredObservations);
    await assert.rejects(adjudication.execute("altered-observations", adjudicationParams(root)), /authored recovery content does not match its prepared role/);
    const wrongIdentity = specialistReport.replace(review.roleArtifactKeys.specialist, "wrong-report-key");
    await writeFile(specialistReportPath, wrongIdentity);
    await assert.rejects(adjudication.execute("wrong-report-key", adjudicationParams(root)), /authored recovery content does not match its prepared role/);
    await writeFile(specialistReportPath, specialistReport);
    const panel = await adjudication.execute("adjudicate", adjudicationParams(root));
    assert.equal(panel.details.publication, "published");
    const adjudicationCall = calls.find((call) => call.args.includes("adjudication"));
    assert.ok(adjudicationCall);
    const adjudicationInputPath = adjudicationCall.args[adjudicationCall.args.indexOf("--input") + 1]!;
    const adjudicationInput = JSON.parse(await readFile(adjudicationInputPath, "utf8"));
    assert.equal(adjudicationInput.supersedes, incomplete.details.recordUrl);
    assert.equal((await readdir(root)).filter((name) => name.startsWith("adjudication-input-r0-")).length, 1);

    const adjudicationPath = join(root, "adjudication.json");
    const adjudicationArtifact = JSON.parse(await readFile(adjudicationPath, "utf8"));
    adjudicationArtifact.mode = "standard";
    await writeFile(adjudicationPath, JSON.stringify(adjudicationArtifact));
    const gateTool = tools.get("forge_publish_record");
    await assert.rejects(gateTool.execute("wrong-route-gate", {
      repository,
      pullRequest,
      kind: "STAGING_GATE",
      head,
      baseRef,
      baseSha,
      gate: "PASS",
      checks: [],
      body: "This is rendered from parent adjudication.",
      reviewRoot: root,
      artifactKey: commonKey,
      adjudicationPath,
      publish: true,
    }), /protected-route parent adjudication artifact/);
    assert.equal(calls.filter((call) => call.args.includes("STAGING_GATE")).length, 0);
    adjudicationArtifact.mode = "staging";
    await writeFile(adjudicationPath, JSON.stringify(adjudicationArtifact));
    const gate = await gateTool.execute("gate", {
      repository,
      pullRequest,
      kind: "STAGING_GATE",
      head,
      baseRef,
      baseSha,
      gate: "PASS",
      checks: [],
      body: "This is rendered from parent adjudication.",
      reviewRoot: root,
      artifactKey: commonKey,
      adjudicationPath: join(root, "adjudication.json"),
      publish: true,
    });
    assert.equal(gate.details.publication, "published");
    const gateCall = calls.find((call) => call.args.includes("STAGING_GATE"));
    assert.ok(gateCall);
    assert.equal(gateCall.args[gateCall.args.indexOf("--gate") + 1], "PASS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified adjudication supersedes an incomplete receipt without a native run id", async () => {
  const { root, review } = await preparedRoot();
  const { tools, calls } = registry(root);
  try {
    await createInitialFailure(tools, root, review);
    const incomplete = await tools.get("forge_publish_incomplete_review").execute("execution-limit-no-input-run-id", {
      repository, pullRequest, head, baseRef, baseSha, reviewRoot: root, artifactKey: commonKey,
      role: "specialist", nativeTerminal: "completed", deliveryError: "Parent execution limit stopped before normal recovery.", recoveryBlocker: "execution-limit", blockerEvidence: "The bounded parent operation budget was exhausted.", publish: true,
    });
    assert.equal(incomplete.details.recordKind, "GATED");
    const receipt = JSON.parse(await readFile(incomplete.details.receiptPath, "utf8"));
    assert.equal(typeof receipt.nativeRunId, "string");
    receipt.nativeRunId = null;
    await writeFile(incomplete.details.receiptPath, JSON.stringify(receipt));
    assert.equal(JSON.parse(await readFile(incomplete.details.receiptPath, "utf8")).nativeRunId, null);

    const recovered = await tools.get("forge_recover_reviewer_publication").execute("recover-known-run", recoveryParams(root));
    assert.equal(recovered.details.publication, "published");
    const adjudicated = await tools.get("forge_publish_adjudication").execute("adjudicate-after-readback", adjudicationParams(root));
    assert.equal(adjudicated.details.publication, "published");
    const adjudicationCall = calls.find((call) => call.args.includes("adjudication"));
    assert.ok(adjudicationCall);
    const inputPath = adjudicationCall.args[adjudicationCall.args.indexOf("--input") + 1]!;
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    assert.equal(input.supersedes, incomplete.details.recordUrl);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incomplete GATED records require durable post-preparation delivery evidence", async () => {
  const { root, review } = await preparedRoot();
  const { tools, calls, records } = registry(root);
  try {
    const incompleteInput = {
      repository, pullRequest, head, baseRef, baseSha, reviewRoot: root, artifactKey: commonKey,
      role: "specialist", nativeTerminal: "nonterminal", deliveryError: "Native reviewer result remains nonterminal.", publish: true,
    };
    await assert.rejects(tools.get("forge_publish_incomplete_review").execute("pre-review-gated", incompleteInput), /requires a completed per-role native execution receipt or exact role-bound publication recovery input/);
    assert.equal(calls.some((call) => call.args.includes("--kind") && call.args.includes("GATED")), false);
    const panelClaim = {
      schema: "forgedock.candidate-review-panel-launch/v1",
      artifactKey: commonKey,
      workflowSha256: review.workflowSha256,
      claimedAt: "2026-09-23T00:00:00.000Z",
    };
    await writeFile(join(root, "panel-launch.claim"), `${JSON.stringify(panelClaim)}\n`);
    await assert.rejects(tools.get("forge_publish_incomplete_review").execute("claimed-before-result", incompleteInput), /requires a completed per-role native execution receipt or exact role-bound publication recovery input/);
    assert.equal(calls.some((call) => call.args.includes("--kind") && call.args.includes("GATED")), false);
    const roleResults = roles.map((role) => ({
      role,
      nativeRunId: role === "specialist" ? nativeRunId : `native-${role}-run-33800`,
      nativeStatus: role === "specialist" ? "nonterminal" : "completed",
      reportPath: join(root, `${role}.report.md`),
      recoveryPath: join(root, `${role}.publication-recovery.json`),
      exitCode: role === "specialist" ? null : 0,
    }));
    await writeFile(join(root, "reviewer-execution.json"), `${JSON.stringify({
      schema: "forgedock.candidate-review-execution/v1", repository, pullRequest, head, baseRef, baseSha,
      artifactKey: commonKey, mode: review.mode, workflowPath: review.workflowPath, workflowSha256: review.workflowSha256,
      toolCallId: "review-tool-call", workflowRunId: "native-workflow-run", completedAt: "2026-09-23T00:01:00.000Z", roleResults,
    }, null, 2)}\n`);
    const afterLaunch = await tools.get("forge_publish_incomplete_review").execute("post-launch-gated", incompleteInput);
    assert.equal(afterLaunch.details.recordKind, "GATED");
    assert.equal(afterLaunch.details.nativeRunId, nativeRunId);
    assert.equal(JSON.parse(await readFile(afterLaunch.details.receiptPath, "utf8")).nativeRunId, nativeRunId);
    assert.equal(records.length, 1);
    assert.equal(calls.filter((call) => call.args.includes("--kind") && call.args.includes("GATED")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parent adjudication validates each role authorization before writing its input", async () => {
  const { root, review } = await preparedRoot();
  const { tools, calls } = registry(root);
  try {
    await createInitialFailure(tools, root, review);
    const authorizationPath = join(root, "security.authorization.json");
    const authorization = JSON.parse(await readFile(authorizationPath, "utf8"));
    authorization.artifactKey = "wrong-role-key";
    await writeFile(authorizationPath, JSON.stringify(authorization));
    await assert.rejects(tools.get("forge_publish_adjudication").execute("missing-role-auth", adjudicationParams(root)), /Reviewer report or authored recovery content does not match its prepared role/);
    assert.equal(calls.some((call) => call.args.includes("adjudication")), false);
    assert.equal(calls.filter((call) => call.args[1] === "record" && call.args[2] === "reviewer").length, 0);
    assert.equal((await readdir(root)).some((name) => name.startsWith("adjudication-input-r0-")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery requires durable completed role result before claiming publication", async () => {
  const { root, review } = await preparedRoot();
  const { tools, calls } = registry(root);
  try {
    await createInitialFailure(tools, root, review);
    const recovery = tools.get("forge_recover_reviewer_publication");
    const executionPath = join(root, "reviewer-execution.json");
    await rm(executionPath, { force: true });
    const missingReceipt = await recovery.execute("missing-native-result", recoveryParams(root));
    assert.equal(missingReceipt.details.recovered, false);
    assert.equal(JSON.parse(await readFile(join(root, "specialist.publication-recovery.json"), "utf8")).recoveryAttempts, 0);
    assert.equal(await readFile(join(root, "specialist.publication-recovery.lock"), "utf8").catch(() => ""), "");

    await writeReviewerExecutionReceipt(root, review, { specialist: { nativeRunId, nativeStatus: "failed", exitCode: 1 } });
    const failedReceipt = await recovery.execute("failed-native-result", recoveryParams(root));
    assert.equal(failedReceipt.details.recovered, false);
    assert.equal(JSON.parse(await readFile(join(root, "specialist.publication-recovery.json"), "utf8")).recoveryAttempts, 0);
    assert.equal(await readFile(join(root, "specialist.publication-recovery.lock"), "utf8").catch(() => ""), "");
    assert.equal(calls.filter((call) => call.args[1] === "record" && call.args[2] === "reviewer" && call.args.includes("--publish")).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent exact-role recovery calls claim only one publication attempt", async () => {
  const { root, review } = await preparedRoot();
  let signalStarted!: () => void;
  let releasePublisher!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const wait = new Promise<void>((resolve) => { releasePublisher = resolve; });
  const { tools, calls } = registry(root, { publisherGate: { started: signalStarted, wait } });
  try {
    await createInitialFailure(tools, root, review);
    const recovery = tools.get("forge_recover_reviewer_publication");
    const attempts = [recovery.execute("first", recoveryParams(root)), recovery.execute("second", recoveryParams(root))];
    await started;
    releasePublisher();
    const results = await Promise.allSettled(attempts);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
    assert.equal(results.filter((result) => result.status === "rejected").length, 0);
    const publications = results.filter((item): item is PromiseFulfilledResult<any> => item.status === "fulfilled").map((item) => item.value.details.publication).sort();
    assert.ok(publications.every((status: string) => status === "published" || status === "unverified"));
    assert.ok(publications.includes("published"));
    assert.equal(calls.filter((call) => call.args[1] === "record" && call.args[2] === "reviewer" && call.args.includes("--publish")).length, 1);
    assert.equal(JSON.parse(await readFile(join(root, "specialist.publication-recovery.json"), "utf8")).recoveryAttempts, 1);
  } finally {
    releasePublisher();
    await rm(root, { recursive: true, force: true });
  }
});

test("one failed recovery records GATED delivery without adjudication or a fabricated verdict", async () => {
  const { root, review } = await preparedRoot();
  const { tools, calls, records } = registry(root, { failRecovery: true });
  try {
    await createInitialFailure(tools, root, review);
    const failed = await tools.get("forge_recover_reviewer_publication").execute("recover", recoveryParams(root));
    assert.equal(failed.details.publication, "unverified");
    const afterFirst = calls.filter((call) => call.args[1] === "record" && call.args[2] === "reviewer" && call.args.includes("--publish")).length;
    assert.equal(afterFirst, 1);
    const sidecarPath = join(root, "specialist.publication-recovery.json");
    assert.equal(JSON.parse(await readFile(sidecarPath, "utf8")).state, "recovery-unresolved");
    const finalized = await tools.get("forge_recover_reviewer_publication").execute("recover-again", recoveryParams(root));
    assert.equal(finalized.details.publication, "unverified");
    assert.equal(calls.filter((call) => call.args[1] === "record" && call.args[2] === "reviewer" && call.args.includes("--publish")).length, afterFirst);

    const incomplete = await tools.get("forge_publish_incomplete_review").execute("gated", {
      repository,
      pullRequest,
      head,
      baseRef,
      baseSha,
      reviewRoot: root,
      artifactKey: commonKey,
      role: "specialist",
      nativeRunId,
      nativeTerminal: "completed",
      deliveryError: String(failed.details.error),
      publish: true,
    });
    assert.equal(incomplete.details.recordKind, "GATED");
    assert.equal(incomplete.details.adjudicationPublished, false);
    assert.equal(records.length, 1);
    assert.match(records[0]!, /canonical role-bound report saved/);
    assert.match(records[0]!, /body=/);
    assert.match(records[0]!, /controlled publication failure/);
    assert.match(records[0]!, /readback\/finalization only/);
    assert.doesNotMatch(records[0]!, /recovery attempt is exhausted/);
    assert.match(records[0]!, /not a pre-review infrastructure failure/);
    assert.doesNotMatch(records[0]!, /APPROVE|gate PASS\/FAIL is claimed/);

    const adjudicationCallCount = calls.filter((call) => call.args.includes("adjudication")).length;
    await assert.rejects(tools.get("forge_publish_adjudication").execute("adjudicate", adjudicationParams(root)), /Adjudication was not attempted: exact authored report exists but publication is not verified for role specialist/);
    assert.equal(calls.filter((call) => call.args.includes("adjudication")).length, adjudicationCallCount);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery tools expose only the bounded publication recovery operations", () => {
  assert.equal(isStagingMutationBlocked("forge_recover_reviewer_publication", {}), false);
  assert.equal(isStagingMutationBlocked("forge_publish_incomplete_review", {}), false);
  assert.equal(isStagingMutationBlocked("subagent", { agent: "forgedock-writer" }), true);
  assert.equal(isStagingMutationBlocked("bash", { command: "touch product-file" }), true);
});
