import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [runRoot, preflightRoot, outerTaskPath, outputPath] = process.argv.slice(2);
if (!runRoot || !preflightRoot || !outerTaskPath || !outputPath) throw new Error("usage: node evaluate-run.mjs <saved-run-root> <preflight-root> <outer-task.json> <output.json>");
function json(file) { return JSON.parse(readFileSync(file, "utf8")); }
function jsonl(file) { return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => ({ index, ...JSON.parse(line) })); }
function text(content) { return Array.isArray(content) ? content.filter((item) => item?.type === "text").map((item) => item.text ?? "").join("\n") : ""; }
function kind(body = "") {
  if (body.includes("FORGE:REVIEWER_REPORT")) return "REVIEWER_REPORT";
  if (body.includes("FORGE:REVIEW-PANEL")) return "REVIEW-PANEL";
  if (body.includes("FORGE:CANDIDATE:STAGING_GATE")) return "STAGING_GATE";
  return "other";
}
const runtime = json(path.join(runRoot, "runtime.json"));
const runMeta = json(path.join(runRoot, "run-meta.json"));
const nativeSummary = json(path.join(runRoot, "native-summary.json"));
const currentCollector = json(path.join(runRoot, "native-summary-collected.json"));
const collectorValidation = json(path.join(runRoot, "collector-validation.json"));
const receipt = json(path.join(runRoot, "prepared-review", "checks", "test.json"));
const review = json(path.join(runRoot, "prepared-review", "review.json"));
const execution = json(path.join(runRoot, "prepared-review", "reviewer-execution.json"));
const reportDelivery = json(path.join(runRoot, "prepared-review", "correctness.publication-recovery.json"));
const adjudication = json(path.join(runRoot, "prepared-review", "adjudication-r0.json"));
const policySummary = json(path.join(runRoot, "prepared-review", "policy-summary.json"));
const preparedPolicy = policySummary.prepared ?? {};
const currentPolicy = policySummary.current ?? {};
const preflight = json(path.join(preflightRoot, "preflight-pass.json"));
const resourceProcess = json(path.join(preflightRoot, "resource-process-verified.json"));
const resourceProcessResult = json(path.join(preflightRoot, "resource-process-verified-result.json"));
const outerTask = json(outerTaskPath);
const preSpawnFailure = json(outerTask.preSpawnFailureEvidence);
const preSpawnFailureContext = {
  taskId: preSpawnFailure.taskId,
  status: preSpawnFailure.status,
  error: preSpawnFailure.error,
  cause: preSpawnFailure.cause,
  processStartedAt: preSpawnFailure.processStartedAt,
  modelInvoked: preSpawnFailure.modelInvoked,
  originalResolutionText: preSpawnFailure.resolution,
  subsequentAuthorizedNativeTask: outerTask.taskId,
  chronology: "This no-Pi pre-spawn failure was preserved; the new b64ae7db7 native parent ran afterward. The copied failure record's resolution text is historical and intentionally unchanged."
};
const events = jsonl(path.join(runRoot, "parent.observed.jsonl"));
const state = json(path.join(runRoot, "gh-state.json"));
const reviewerRunId = execution.roleResults?.[0]?.nativeRunId;
const reviewerMetaPath = path.join(runRoot, "sessions", "subagent-artifacts", `${reviewerRunId}_forgedock-reviewer_0_meta.json`);
const reviewerMeta = json(reviewerMetaPath);
const reviewerOutputPath = path.join(runRoot, "sessions", "subagent-artifacts", `${reviewerRunId}_forgedock-reviewer_0_output.md`);
const reviewerTranscriptPath = path.join(runRoot, "sessions", "subagent-artifacts", `${reviewerRunId}_forgedock-reviewer_0_transcript.jsonl`);
const sessionArtifactPaths = [reviewerMetaPath, reviewerOutputPath, reviewerTranscriptPath];
const reviewerEvidenceRetained = sessionArtifactPaths.every((file) => existsSync(file)) && existsSync(path.join(runRoot, "prepared-review", "correctness.report.md")) && existsSync(path.join(runRoot, "prepared-review", "correctness.publication-recovery.json"));
const sourceRootArtifactsPresent = existsSync(path.join(runtime.runtimeSourceRoot, ".pi", "subagents", "artifacts"));
const eventsByTool = { starts: [], ends: [] };
const assistants = [];
for (const row of events) {
  const event = row.event;
  if (event.type === "tool_execution_start") eventsByTool.starts.push({ index: row.index, at: row.receivedAt, id: event.toolCallId, name: event.toolName, args: event.args ?? {} });
  if (event.type === "tool_execution_end") eventsByTool.ends.push({ index: row.index, at: row.receivedAt, id: event.toolCallId, name: event.toolName, isError: event.isError === true, result: event.result ?? {} });
  if (event.type === "agent_end") {
    const last = [...(event.messages ?? [])].reverse().find((message) => message.role === "assistant");
    if (last) assistants.push(text(last.content));
  }
}
const callResult = (start) => eventsByTool.ends.find((end) => end.id === start.id && end.name === start.name);
const startBy = (name, predicate = () => true) => eventsByTool.starts.find((start) => start.name === name && predicate(start));
const prepareStart = startBy("forge_prepare_review");
const checkStart = startBy("forge_run_check");
const reviewerListStart = startBy("subagent", (start) => start.args.action === "list");
const reviewerWorkflowStart = startBy("subagent", (start) => typeof start.args.workflowScriptPath === "string");
const adjudicationStart = startBy("forge_publish_adjudication");
const gateStarts = eventsByTool.starts.filter((start) => start.name === "forge_publish_record");
const prepareResult = prepareStart ? callResult(prepareStart) : null;
const checkResult = checkStart ? callResult(checkStart) : null;
const reviewerWorkflowResult = reviewerWorkflowStart ? callResult(reviewerWorkflowStart) : null;
const reviewerWorkflowPayload = reviewerWorkflowResult?.result?.details?.workflow ?? null;
const reviewerChildResult = reviewerWorkflowPayload?.value?.[0] ?? null;
const adjudicationResult = adjudicationStart ? callResult(adjudicationStart) : null;
const gateResults = gateStarts.map((start) => ({ start, end: callResult(start) }));
const successfulGate = [...gateResults].reverse().find(({ end }) => end && !end.isError);
const failedGate = gateResults.find(({ end }) => end?.isError);
const toolErrors = eventsByTool.ends.filter((end) => end.isError).map((end) => ({ index: end.index, at: end.at, name: end.name, callId: end.id, text: text(end.result.content).slice(0, 500) }));
const comments = state.comments ?? [];
const reports = comments.filter((comment) => kind(comment.body) === "REVIEWER_REPORT");
const panels = comments.filter((comment) => kind(comment.body) === "REVIEW-PANEL");
const gates = comments.filter((comment) => kind(comment.body) === "STAGING_GATE");
const finalPanel = panels.at(-1);
const finalGate = gates.at(-1);
const panelUrl = finalPanel?.html_url ?? null;
const gateUrl = finalGate?.html_url ?? null;
const gatePanelLink = finalGate?.body?.split(/\r?\n/).find((line) => line.startsWith("**Parent decision permalink**: "))?.slice("**Parent decision permalink**: ".length) ?? null;
const tlsReads = (state.commentReads ?? []).filter((row) => row.id === state.provisionalReadbackFailureId);
const actualFinalResponse = assistants.at(-1) ?? "";
const sourceRoot = runtime.runtimeSourceRoot;
const sourceTreeStatus = (await import("node:child_process")).execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: sourceRoot, encoding: "utf8" }).trim();
const localArtifactsDir = path.join(sourceRoot, ".pi", "subagents", "artifacts");
const outerStatus = nativeSummary.status ?? {};
const wrapperFalseAssertions = Object.entries({
  reviewerEvidenceRetained: outerStatus.reviewerEvidenceRetained,
  runtimeArtifactsVisible: outerStatus.runtimeArtifactsVisible,
  receiptPrecedesReviewerArtifacts: nativeSummary.toolSequence?.receiptPrecedesReviewerArtifacts,
  noFinalizerErrors: outerStatus.noFinalizerErrors,
}).filter(([, value]) => value === false).map(([name]) => name);
const gateFirstArgs = failedGate?.start.args ?? {};
const gateFinalArgs = successfulGate?.start.args ?? {};
const selfRecovery = failedGate?.end?.isError === true
  && text(failedGate.end.result.content).includes("Missing completed check receipt: CI")
  && Array.isArray(gateFirstArgs.checks) && gateFirstArgs.checks.includes("CI") && gateFirstArgs.checks.includes("test")
  && successfulGate && Array.isArray(gateFinalArgs.checks) && gateFinalArgs.checks.length === 1 && gateFinalArgs.checks[0] === "test"
  && successfulGate.end.result.details?.publication === "published";
const blockedBash = toolErrors.find((error) => error.name === "bash" && error.text.includes("staging review route is non-mutating"));
const gateArgumentError = toolErrors.find((error) => error.name === "forge_publish_record" && error.text.includes("Missing completed check receipt: CI"));
const resolvedIntermediateErrors = [
  ...(blockedBash ? [{ name: "bash", status: "resolved intermediate guard block", index: blockedBash.index, evidence: "No shell operation ran; parent continued with read-only inspection and the configured check, and the frozen source remained clean." }] : []),
  ...(selfRecovery && gateArgumentError ? [{ name: "forge_publish_record", status: "resolved intermediate argument error", index: gateArgumentError.index, evidence: "The first checks argument requested a local CI receipt; the parent retried with only configured test, used exact-head CI policy evidence, and the final gate published/read back." }] : []),
];
const unresolvedToolErrors = toolErrors.filter((error) => !resolvedIntermediateErrors.some((resolved) => resolved.index === error.index));
const failures = [];
if (!preflight.statuses || Object.values(preflight.statuses).some((value) => value !== true)) failures.push("preflight did not pass");
if (preSpawnFailure.status !== "failed-before-Pi-spawn" || preSpawnFailure.processStartedAt !== null || preSpawnFailure.modelInvoked !== false) failures.push("pre-spawn parser failure not retained correctly");
if (unresolvedToolErrors.length !== 0 || toolErrors.length !== resolvedIntermediateErrors.length) failures.push("an intermediate tool error was not classified/resolved or a terminal tool error remains");
if (runtime.sourceHeadAtLaunch !== "392daed1a178e9081d86ec6c85430ba893cb0f9c") failures.push("tested candidate SHA mismatch");
if (runtime.piVersion !== "0.87.1" || runtime.piSubagentsVersion !== "0.60.0" || runtime.piSubagentsHead !== "0931cbbb98ab253177b181bd334fe02dd919dca5") failures.push("runtime pins mismatch");
if (!resourceProcess.assertions?.passed || resourceProcess.forbiddenInstalledForgeDockResources?.length) failures.push("isolated resource audit failed");
if (runtime.isolatedPackageSources?.length !== 0) failures.push("isolated Pi settings include a package source");
if (!runtime.launcherCommand?.includes("--no-extensions") || !runtime.launcherCommand?.includes("--no-skills") || !runtime.launcherCommand?.includes("--no-prompt-templates")) failures.push("native launch did not use supported resource isolation flags");
if (!preparedPolicy.requiredChecks?.some((check) => check.name === "CI" && check.state === "SUCCESS") || !preparedPolicy.exactHeadCheckRuns?.checks?.some((check) => check.name === "CI" && check.conclusion === "success") || !currentPolicy.requiredChecks?.some((check) => check.name === "CI" && check.state === "SUCCESS") || !currentPolicy.exactHeadCheckRuns?.checks?.some((check) => check.name === "CI" && check.conclusion === "success")) failures.push("prepared/refreshed exact-head CI proof missing");
if (!prepareStart || prepareResult?.isError || !checkStart || checkResult?.isError) failures.push("prepare or configured check failed");
if (!receipt || receipt.status !== "passed" || receipt.name !== "test" || receipt.head !== runtime.targetHead || receipt.sourceRoot !== sourceRoot || !existsSync(path.join(runRoot, "prepared-review", "checks", "test.json"))) failures.push("bound configured-check receipt missing or invalid");
if (!reviewerWorkflowStart || !reviewerWorkflowResult || reviewerWorkflowResult.isError || reviewerWorkflowStart.index <= (checkResult?.index ?? Number.MAX_SAFE_INTEGER)) failures.push("single reviewer workflow did not follow the completed configured check");
if (!reviewerChildResult || reviewerChildResult.role !== "correctness" || reviewerChildResult.nativeStatus !== "completed" || reviewerChildResult.exitCode !== 0 || reviewerChildResult.nativeRunId !== execution.roleResults?.[0]?.nativeRunId) failures.push("workflow result does not match the one completed correctness reviewer");
if (!execution.roleResults || execution.roleResults.length !== 1 || execution.roleResults[0].nativeStatus !== "completed" || execution.roleResults[0].exitCode !== 0 || !reviewerMeta.model?.includes("gpt-5.6-luna:medium") || reviewerMeta.durationMs <= 0 || reviewerMeta.launchResolvedExtensions?.disableAmbientExtensions !== true) failures.push("normal reviewer did not complete on the declared model with isolated extensions");
if (!reportDelivery || reportDelivery.state !== "published" || reports.length !== 1 || reviewerEvidenceRetained !== true) failures.push("reviewer report publication or retained reviewer evidence missing");
const ciDecision = adjudication.checks?.find((check) => check.name === "CI");
const testDecision = adjudication.checks?.find((check) => check.name === "test");
if (!adjudication || adjudication.verdict !== "APPROVE" || adjudication.gate !== "PASS" || !adjudicationResult || adjudicationResult.isError || adjudicationResult.result.details?.readbackVerified !== true) failures.push("final adjudication missing, unverified, or failed");
if (!ciDecision || ciDecision.conclusion !== "success" || ciDecision.executedProof !== true || !testDecision || testDecision.conclusion !== "pass" || testDecision.executedProof !== true || testDecision.proofSource !== "forge_run_check configured test receipt") failures.push("adjudication check proof does not bind external CI and local receipt");
if (!successfulGate || !finalGate || !successfulGate.end.result.details?.readbackVerified || !gateUrl || gatePanelLink !== panelUrl || !finalGate.body.includes("FORGE:STAGING_GATE:PASS")) failures.push("final gate readback or panel linkage failed");
if (tlsReads.length !== 2 || tlsReads[0].outcome !== "injected-transient-failure" || tlsReads[1].outcome !== "success" || tlsReads[0].id !== tlsReads[1].id || tlsReads[0].id !== 1001) failures.push("controlled same-comment TLS retry not verified");
if (!actualFinalResponse.includes(panelUrl) || !actualFinalResponse.includes(gateUrl)) failures.push("final response omitted panel or gate permalink");
if (state.issueWrites !== 0 || (state.unsupportedCalls ?? []).length !== 0) failures.push("fake transport observed issue/unsupported writes");
if (sourceTreeStatus !== "") failures.push("frozen source tree is not clean after review");
if (runMeta.processExitCode !== 0 || !runMeta.agentEndObserved) failures.push("native Pi parent did not settle successfully");
if (!selfRecovery) failures.push("gate argument self-recovery could not be proven");

const evaluation = {
  schema: "forgedock.pr583.authorized-native-evaluation/v1",
  outcome: failures.length === 0 ? "PASS WITH SELF-RECOVERY" : "NOT QUALIFIED",
  evaluationMode: "offline; saved run only; no model/reviewer invocation",
  testedCode: runtime.sourceHeadAtLaunch,
  target: { repository: "example/product (local fake transport)", pullRequest: 7, head: runtime.targetHead, baseRef: runtime.baseRef ?? "main", baseSha: runtime.targetBase },
  identities: {
    backgroundTask: outerTask.taskId,
    parentSession: runMeta.parentSessionId,
    reviewerWorkflow: execution.workflowRunId,
    reviewerNativeRun: execution.roleResults[0]?.nativeRunId,
    reviewAttempt: review.artifactKey,
  },
  runtime: {
    piVersion: runtime.piVersion,
    parent: { provider: "openai-codex", model: runtime.parentDefaultModel, thinking: runtime.parentDefaultThinking, cliOverrides: null },
    reviewer: { provider: "openai-codex", model: reviewerMeta.model, thinking: reviewerMeta.thinkingLevel, durationMs: reviewerMeta.durationMs, exitCode: reviewerMeta.exitCode },
    piSubagents: { version: runtime.piSubagentsVersion, commit: runtime.piSubagentsHead },
  },
  resolvedResources: {
    verifiedByFreshPiProcess: resourceProcessResult.status === "passed" && resourceProcessResult.noAgentOrModelTurn === true,
    candidateExtension: path.join(runtime.sourceRepo, "candidate/extension.ts"),
    helper: resourceProcess.helper.path,
    parentSkills: resourceProcess.skills.filter((skill) => skill.path.startsWith(path.join(runtime.sourceRepo, "candidate/skills"))).map((skill) => skill.path),
    prompts: resourceProcess.prompts.map((prompt) => prompt.path),
    reviewerProfile: resourceProcess.reviewer.profilePath,
    reviewerTools: resourceProcess.reviewer.subagentOnlyExtensions,
    ordinaryInstalledForgeDockVisible: resourceProcess.forbiddenInstalledForgeDockResources.length > 0,
    isolatedSettingsPackages: runtime.isolatedPackageSources,
  },
  externalRequiredCheck: { name: "CI", preparedConclusion: preparedPolicy.requiredChecks?.find((check) => check.name === "CI")?.state, preparedExactHeadConclusion: preparedPolicy.exactHeadCheckRuns?.checks?.find((check) => check.name === "CI")?.conclusion, refreshedConclusion: currentPolicy.requiredChecks?.find((check) => check.name === "CI")?.state, refreshedExactHeadConclusion: currentPolicy.exactHeadCheckRuns?.checks?.find((check) => check.name === "CI")?.conclusion },
  configuredCheck: {
    command: "npm test",
    receipt: path.join(runRoot, "prepared-review/checks/test.json"),
    status: receipt.status,
    head: receipt.head,
    configPath: receipt.configPath,
    configSha256: receipt.configSha256,
    tests: { passed: 1, failed: 0 },
    completedBeforeActualReviewerWorkflow: checkResult.index < reviewerWorkflowStart.index,
  },
  reviewer: {
    actionListWasManagementOnly: reviewerListStart?.args.action === "list" && callResult(reviewerListStart)?.result.details?.mode === "management",
    reviewerEvidenceRetained,
    reviewerEvidencePaths: sessionArtifactPaths.map((file) => path.relative(runRoot, file)),
    sourceRootPiArtifactsPresent: sourceRootArtifactsPresent,
    managementListCallAt: reviewerListStart?.at ?? null,
    actualWorkflowStartIndex: reviewerWorkflowStart.index,
    actualWorkflowStartAt: reviewerWorkflowStart.at,
    actualWorkflowSettledAt: reviewerWorkflowResult?.at ?? null,
    actualWorkflowCallId: reviewerWorkflowStart.id,
    childDurationMs: reviewerMeta.durationMs,
    nativeStatus: execution.roleResults[0].nativeStatus,
    reportStatus: reportDelivery.state,
    reportUrl: reports[0].html_url,
    observations: review.roles,
  },
  adjudication: { verdict: adjudication.verdict, gate: adjudication.gate, panelUrl, gateUrl, gateReadbackVerified: successfulGate?.end.result.details?.readbackVerified === true, gateLinksFinalPanel: gatePanelLink === panelUrl },
  controlledReadback: { commentId: 1001, outcomes: tlsReads.map((row) => row.outcome), sameCommentRetrySucceeded: tlsReads.length === 2 && tlsReads.every((row) => row.id === 1001) },
  finalResponse: { text: actualFinalResponse, includesPanelUrl: actualFinalResponse.includes(panelUrl), includesGateUrl: actualFinalResponse.includes(gateUrl) },
  selfRecovery: {
    status: selfRecovery ? "resolved intermediate error" : "unresolved",
    gateFailure: { argsChecks: gateFirstArgs.checks, error: text(failedGate?.end?.result?.content), at: failedGate?.end?.at },
    correctedGateArgs: { checks: gateFinalArgs.checks, at: successfulGate?.start.at },
    evaluatorIntervention: "none; the parent Pi session corrected its own gate arguments",
  },
  resolvedIntermediateErrors,
  unresolvedTerminalFailures: unresolvedToolErrors.map((error) => ({ name: error.name, index: error.index, text: error.text.slice(0, 400) })),
  terminalFailures: failures,
  elapsed: { parentStartedAt: runMeta.parentStartedAt, parentSettledAt: runMeta.parentSettledAt, totalMs: runMeta.totalElapsedMs, reviewerMs: reviewerMeta.durationMs },
  outerLauncher: {
    taskStatus: outerTask.status,
    postRunAssertionsFalse: wrapperFalseAssertions,
    nativePiExitCode: runMeta.processExitCode,
    preSpawnFailure: preSpawnFailureContext,
    exitCode: outerTask.exitCode,
    explanation: "Pi parent settled exit 0 and the corrected collector completed; the outer launcher returned 1 because its stale assertions required reviewer artifacts in sourceRoot/.pi/subagents/artifacts and no intermediate finalizer errors. The actual child artifacts are retained under sessions/subagent-artifacts, and the only finalizer error was the parent-corrected missing-CI-receipt gate call.",
    initialCollectorReviewerTimingWasMisattributed: "The prior summary selected the first successful subagent tool call, which was action=list management; this corrected evaluator selects the actual workflowScriptPath call and uses reviewer execution metadata for child duration.",
    correctedReviewerWorkflowStartedAt: reviewerWorkflowStart.at,
    correctedReviewerWorkflowToolSettledAt: reviewerWorkflowResult.at,
    reviewerChildDurationMs: reviewerMeta.durationMs,
    originalHarnessSummaryPath: path.join(runRoot, "native-summary.json"),
    correctedCollectorPath: path.join(runRoot, "native-summary-collected.json"),
    reviewerEvidenceLocations: sessionArtifactPaths.map((file) => path.relative(runRoot, file)),
  },
  preservedFailures: {
    preSpawnParserFailure: preSpawnFailureContext,
    historicalSeptember29Attempt: "qualification/evidence/review-pr-performance-20260928/corrective-native-result.json (unchanged)",
    currentRunnerExit1Retained: true,
  },
  evidence: {
    runRoot,
    preflightRoot,
    report: path.join(runRoot, "prepared-review/correctness.report.md"),
    receipt: path.join(runRoot, "prepared-review/checks/test.json"),
    reviewerExecution: path.join(runRoot, "prepared-review/reviewer-execution.json"),
    fakeGithubState: path.join(runRoot, "gh-state.json"),
    parentObservedEvents: path.join(runRoot, "parent.observed.jsonl"),
    preflightResourceAudit: path.join(preflightRoot, "resource-process-verified.json"),
  },
};
assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
writeFileSync(outputPath, JSON.stringify(evaluation, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ outcome: evaluation.outcome, testedCode: evaluation.testedCode, task: evaluation.identities.backgroundTask, session: evaluation.identities.parentSession, reviewer: evaluation.identities.reviewerNativeRun, check: evaluation.configuredCheck, panelUrl, gateUrl, selfRecovery: evaluation.selfRecovery.status, evaluatorIntervention: evaluation.selfRecovery.evaluatorIntervention, outerLauncherExitCode: evaluation.outerLauncher.exitCode, terminalFailures: evaluation.terminalFailures }, null, 2));
