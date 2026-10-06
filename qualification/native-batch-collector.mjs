import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

const ACCEPTED = new Set(["accepted", "checked", "verified", "attested", "reviewed", "not-required"]);
const TERMINAL_NATIVE = new Set(["completed", "failed", "stopped", "interrupted", "timed-out", "execution-limit"]);
const MARKER = /^FORGE_WORK_ON_RESULT status=(DONE|GATED|FAILED) issue=(\d+) pr=(\d+|none) dependency=(SATISFIED|UNSATISFIED)$/;

function fail(message) { throw new Error(`Native batch collection failed: ${message}`); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function detailsOf(result) { return result?.details ?? result?.structuredContent?.details ?? {}; }
function contentText(event) { return (event?.result?.content ?? event?.result?.structuredContent?.content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("\n"); }
function eventEnd(events, start) { return events.find((event) => event.type === "tool_execution_end" && event.toolCallId === start.toolCallId); }
function normalizedPath(value) { return typeof value === "string" && value ? resolve(value) : ""; }
function readJsonPath(file, label) {
  if (!isAbsolute(file) || !existsSync(file) || realpathSync(file) !== file) fail(`${label} is not an existing absolute regular path: ${file}`);
  const bytes = readFileSync(file);
  try { return { value: JSON.parse(bytes.toString("utf8")), bytes, sha256: sha256(bytes) }; }
  catch { fail(`${label} is not valid JSON: ${file}`); }
}
function readRootStatus(asyncDir, events, expected) {
  const statusPath = join(asyncDir, "status.json");
  let statusBytes;
  if (existsSync(statusPath)) {
    if (realpathSync(statusPath) !== statusPath) fail("native root status path is a symlink");
    statusBytes = readFileSync(statusPath);
  } else {
    const readEvent = events.find((event) => event.type === "tool_execution_start" && event.toolName === "read" && normalizedPath(event.args?.path) === statusPath);
    const end = readEvent && eventEnd(events, readEvent);
    const text = end ? contentText(end) : "";
    if (!text) fail(`native root status is missing and no exact readback exists: ${statusPath}`);
    statusBytes = Buffer.from(text);
  }
  let status;
  try { status = JSON.parse(statusBytes.toString("utf8")); }
  catch { fail(`native root status is not parseable JSON: ${statusPath}`); }
  if (status.runId !== expected.runId || status.toolCallId !== expected.toolCallId || status.mode !== "workflow" || normalizedPath(status.cwd) !== expected.cwd) fail("persisted root status does not match the exact native launch receipt/cwd");
  return { statusPath, status, bytes: statusBytes, sha256: sha256(statusBytes) };
}
function checkPlan(planFile, request, expected) {
  const { value: plan } = readJsonPath(planFile, "prepared dispatch plan");
  if (plan.schema !== "forgedock.candidate-dispatch/v1" || plan.repository !== expected.repository || plan.projectRoot !== expected.cwd || plan.deliveryMode !== "local-replay") fail("prepared plan identity does not match the disposable target");
  if (!Array.isArray(plan.issues) || plan.issues.length !== expected.issues.length || plan.issues.some((issue, index) => issue.number !== expected.issues[index])) fail("prepared issue order/set differs from the expected qualification pair");
  if (!request || request.async !== true || normalizedPath(request.cwd) !== expected.cwd || request.globalConcurrencyLimit !== 2) fail("prepared native request lacks the exact async fixture route/configuration");
  const byNumber = new Map(plan.issues.map((issue) => [issue.number, issue]));
  for (const [index, issue] of plan.issues.entries()) {
    const predecessorNumbers = expected.predecessors?.[issue.number] ?? (index === 0 ? [] : [expected.issues[index - 1]]);
    const wanted = predecessorNumbers.map((number) => byNumber.get(number)?.key);
    if (wanted.some((key) => !key) || JSON.stringify(issue.predecessors ?? []) !== JSON.stringify(wanted)) fail("prepared graph lost the exact prerequisite edge");
  }
  return plan;
}
function toolRoots(events, expected) {
  const roots = [];
  for (const start of events) {
    if (start.type !== "tool_execution_start" || start.toolName !== "subagent" || typeof start.args?.workflowScriptPath !== "string" || start.args?.action) continue;
    const workflowPath = normalizedPath(start.args.workflowScriptPath);
    const requestPath = join(dirname(workflowPath), "request.json");
    const planPath = join(dirname(workflowPath), "plan.json");
    const continuationPath = join(dirname(workflowPath), "continuation.json");
    if (!existsSync(requestPath) || (!existsSync(planPath) && !existsSync(continuationPath))) continue;
    const end = eventEnd(events, start);
    if (!end || end.result?.isError === true) continue;
    const receipt = detailsOf(end.result);
    const runId = receipt.runId ?? receipt.asyncId;
    const asyncDir = normalizedPath(receipt.asyncDir);
    if (start.args.async !== true || !runId || !asyncDir || receipt.mode !== "workflow" || (receipt.toolCallId && receipt.toolCallId !== start.toolCallId)) fail("dispatch launch receipt lacks its exact async root identity/path");
    const { statusPath, status, bytes, sha256: statusSha256 } = readRootStatus(asyncDir, events, { runId, toolCallId: start.toolCallId, cwd: expected.cwd });
    const request = readJsonPath(requestPath, "native workflow request").value;
    if (normalizedPath(request.workflowScriptPath) !== workflowPath || request.async !== true) fail("launched workflow path is not bound to its async request file");
    if (existsSync(planPath)) {
      const plan = checkPlan(planPath, request, expected);
      roots.push({ kind: "dispatch", toolCallId: start.toolCallId, runId, asyncDir, statusPath, statusSha256, status, bytes, workflowPath, requestPath, planPath, plan, request, start, end });
    } else {
      const continuationRecord = readJsonPath(continuationPath, "native continuation receipt");
      const continuation = continuationRecord.value;
      if (continuation.schema !== "forgedock.candidate-dispatch-continuation/v1" || continuation.repository !== expected.repository || continuation.deliveryMode !== "local-replay" || continuation.targetBase?.branch !== expected.target || !Array.isArray(continuation.issues) || continuation.issues.length !== expected.issues.length || continuation.issues.some((issue, index) => issue.issue !== expected.issues[index])) fail("continuation receipt does not preserve the prepared batch identity");
      roots.push({ kind: "continuation", toolCallId: start.toolCallId, runId, asyncDir, statusPath, statusSha256, status, bytes, workflowPath, requestPath, continuationPath, continuationSha256: continuationRecord.sha256, continuation, request, start, end });
    }
  }
  return roots;
}
function jsonObjectFrom(text, predicate) {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try { const value = JSON.parse(text.slice(start, index + 1)); if (predicate(value)) return value; }
        catch { /* Search the next object start. */ }
        break;
      }
    }
  }
  return undefined;
}
function continuationExecution(events, root, candidateBin) {
  const matching = [];
  for (const start of events) {
    if (start.type !== "tool_execution_start" || start.toolName !== "bash") continue;
    const command = start.args?.command;
    const planPath = root.continuation?.sourcePlanPath ?? root.planPath;
    if (typeof command !== "string" || !command.includes("continue-dispatch") || !command.includes(planPath)) continue;
    const end = eventEnd(events, start);
    if (!end || end.result?.isError === true) continue;
    const result = jsonObjectFrom(contentText(end), (value) => typeof value.continuationPath === "string" && typeof value.workflowPath === "string" && typeof value.requestPath === "string");
    if (!result || normalizedPath(result.continuationPath) !== root.continuationPath || normalizedPath(result.workflowPath) !== root.workflowPath || normalizedPath(result.requestPath) !== root.requestPath) continue;
    if (candidateBin && !command.includes(candidateBin) && !command.includes("$FORGEDOCK_CANDIDATE_BIN")) continue;
    matching.push({ start, end, result });
  }
  return matching.length === 1 ? matching[0] : undefined;
}
function validateContinuation(events, prior, current, candidateBin) {
  const receipt = current.continuation;
  if (!prior || current.kind !== "continuation" || !continuationExecution(events, current, candidateBin)) fail("continuation root has no successful ordinary-parent continue-dispatch tool receipt");
  const preparedPlanPath = prior.kind === "dispatch" ? prior.planPath : prior.continuation.sourcePlanPath;
  if (receipt.sourcePlanPath !== preparedPlanPath || receipt.sourceWorkflowRunId !== prior.runId || normalizedPath(receipt.sourceStatusPath) !== prior.statusPath || receipt.sourceStatusSha256 !== prior.statusSha256) fail("continuation is not linked to the exact immutable prior root status");
  const { value: input } = readJsonPath(receipt.sourceResultsPath, "continuation input");
  if (input.schema !== "forgedock.candidate-dispatch-continuation/v1" || !Array.isArray(input.initialResults) || JSON.stringify(input.initialResults) !== JSON.stringify(prior.status.workflow?.value)) fail("continuation input does not preserve the exact initial root workflow.value");
  if (prior.kind === "continuation") {
    const previousPath = prior.continuationPath;
    const previousSha256 = prior.continuationSha256;
    if (normalizedPath(receipt.previousContinuation?.path) !== previousPath || receipt.previousContinuation?.sha256 !== previousSha256 || normalizedPath(input.previousContinuation?.path) !== previousPath || input.previousContinuation?.sha256 !== previousSha256) fail("chained continuation does not link the exact previous continuation receipt");
  } else if (receipt.previousContinuation || input.previousContinuation) fail("first continuation unexpectedly claims a previous continuation receipt");
  if (normalizedPath(input.nativeStatus?.path) !== prior.statusPath || input.nativeStatus?.sha256 !== prior.statusSha256 || input.nativeStatus?.runId !== prior.runId) fail("continuation input does not bind the exact prior root status reference");
  const waiting = new Map((prior.status.workflow?.value ?? []).filter((row) => row.status === "WAITING" && row.nativeStatus === "detached").map((row) => [row.issue, row]));
  if (!Array.isArray(input.terminalResults) || input.terminalResults.length !== waiting.size) fail("continuation does not resolve exactly every detached owner from the prior root");
  for (const terminal of input.terminalResults) {
    const original = waiting.get(terminal.issue);
    if (!original || original.runId !== terminal.runId || !TERMINAL_NATIVE.has(terminal.nativeStatus)) fail("continuation terminal result is not linked to its exact detached owner run");
    const ref = terminal.nativeStatusRef;
    if (!ref || typeof ref.path !== "string" || ref.runId !== original.runId) fail("continuation terminal result lacks an exact native status/output reference");
    if (!isAbsolute(ref.path)) fail(`issue #${terminal.issue} native status reference is not absolute`);
    const nativeResult = readJsonPath(resolve(ref.path), `terminal result for issue #${terminal.issue}`);
    if (ref.sha256 !== nativeResult.sha256 || nativeResult.value.runId !== original.runId) fail(`issue #${terminal.issue} native status digest/run identity is invalid`);
    const outputFile = typeof nativeResult.value.outputFile === "string" ? nativeResult.value.outputFile : undefined;
    const nativeOutputPath = ref.outputPath ?? (outputFile ? isAbsolute(outputFile) ? outputFile : resolve(dirname(ref.path), outputFile) : undefined);
    if (typeof nativeOutputPath !== "string") fail(`issue #${terminal.issue} native status has no exact saved output reference`);
    const outputPath = resolve(nativeOutputPath);
    if (!isAbsolute(ref.outputPath) || !existsSync(outputPath) || realpathSync(outputPath) !== outputPath) fail(`issue #${terminal.issue} native saved output path is unavailable or aliased`);
    const outputBytes = readFileSync(outputPath);
    if (ref.outputSha256 !== sha256(outputBytes)) fail(`issue #${terminal.issue} native output digest changed`);
    if (typeof terminal.output === "string") {
      const markerLines = outputBytes.toString("utf8").replace(/\r\n?/g, "\n").split("\n").filter((line) => MARKER.test(line));
      const marker = terminal.output.match(MARKER);
      if (markerLines.length !== 1 || markerLines[0] !== terminal.output || !marker || Number(marker[2]) !== terminal.issue || marker[1] !== terminal.status || marker[4] !== terminal.dependency) fail(`issue #${terminal.issue} continuation marker is not copied from its exact native output`);
    } else if (terminal.status !== "FAILED") fail(`issue #${terminal.issue} non-failure terminal result has no saved native marker`);
    const nativeAcceptance = nativeResult.value.acceptance?.status ?? nativeResult.value.steps?.[0]?.acceptance?.status ?? "unknown";
    if (nativeAcceptance !== terminal.nativeAcceptanceStatus) fail(`issue #${terminal.issue} continuation acceptance does not match its native metadata`);
    const waited = events.some((event) => event.type === "tool_execution_start" && ["bg_wait", "subagent_wait"].includes(event.toolName) && event.args?.id === terminal.runId && eventEnd(events, event));
    const readBack = events.some((event) => event.type === "tool_execution_start" && event.toolName === "read" && [ref.path, outputPath].includes(event.args?.path) && eventEnd(events, event));
    if (!waited && !readBack) fail(`issue #${terminal.issue} terminal result was not observed through native wait or exact file readback`);
  }
  const chainRef = (receipt.fanoutHistory ?? []).find((entry) => entry.runId === prior.runId && normalizedPath(entry.path) === prior.statusPath && entry.sha256 === prior.statusSha256);
  if (!chainRef) fail("continuation receipt omits the exact prior root from its fanout history");
}
function batchRows(root, expected) {
  const rows = root.status.workflow?.value;
  if (!Array.isArray(rows)) return { rows: [], reconciled: false, reason: "persisted root has no workflow.value" };
  if (rows.length !== expected.issues.length) fail("persisted root issue count differs from the prepared pair");
  const byNumber = new Map();
  for (const row of rows) {
    if (!expected.issues.includes(row.issue) || byNumber.has(row.issue) || row.key !== `issue-${row.issue}` || row.repository !== expected.repository || row.target !== expected.target) fail("persisted result row does not match its exact prepared issue/repository/target identity");
    if (!["DONE", "GATED", "FAILED", "WAITING"].includes(row.status)) fail(`issue #${row.issue} has unknown persisted outcome ${row.status}`);
    if (row.status === "DONE") {
      const match = typeof row.output === "string" ? row.output.match(MARKER) : null;
      if (row.nativeStatus !== "completed" || row.ok !== true || row.dependency !== "SATISFIED" || !ACCEPTED.has(row.nativeAcceptanceStatus) || !match || match[1] !== "DONE" || Number(match[2]) !== row.issue || match[4] !== "SATISFIED") fail(`issue #${row.issue} DONE lacks terminal native acceptance and exact delivery marker`);
    } else if (row.status === "GATED" && row.nativeStatus === "completed") {
      const match = typeof row.output === "string" ? row.output.match(MARKER) : null;
      if (row.ok !== true || !match || match[1] !== "GATED" || Number(match[2]) !== row.issue || match[4] !== row.dependency) fail(`issue #${row.issue} GATED is not the exact completed native owner outcome`);
    } else if (row.status === "GATED" && row.nativeStatus === "not-started") {
      if (row.ok !== false || row.runId !== null || row.output !== null || !Array.isArray(row.blockedBy) || row.blockedBy.length === 0) fail(`issue #${row.issue} synthetic GATED row has invalid blocked/not-started evidence`);
    } else if (row.status === "WAITING") {
      if (row.ok !== false || !["detached", "not-started", "nonterminal"].includes(row.nativeStatus)) fail(`issue #${row.issue} WAITING row lacks a native pending/detached state`);
    } else if (row.status === "FAILED" && (!TERMINAL_NATIVE.has(row.nativeStatus) || row.ok !== false)) fail(`issue #${row.issue} FAILED lacks a terminal native failure`);
    byNumber.set(row.issue, row);
  }
  const ownerRunIds = rows.map((row) => row.runId).filter((runId) => typeof runId === "string");
  if (new Set(ownerRunIds).size !== ownerRunIds.length) fail("persisted batch reuses an owner run id across issues");
  for (const issue of root.plan.issues) {
    const row = byNumber.get(issue.number);
    const predecessors = issue.predecessors.map((key) => root.plan.issues.find((candidate) => candidate.key === key)?.number).filter(Number.isSafeInteger);
    const ready = predecessors.every((number) => { const predecessor = byNumber.get(number); return predecessor?.status === "DONE" && predecessor.dependency === "SATISFIED"; });
    if (!ready && row.nativeStatus === "completed") fail(`issue #${issue.number} launched before its prerequisite delivery was DONE/SATISFIED`);
  }
  const terminal = ["complete", "completed", "failed", "stopped"].includes(String(root.status.state).toLowerCase()) && rows.every((row) => TERMINAL_NATIVE.has(row.nativeStatus) || row.status === "GATED" && row.nativeStatus === "not-started");
  return { rows, reconciled: terminal, reason: terminal ? null : "one or more issue outcomes remain WAITING/nonterminal" };
}

export function collectNativeBatch(events, expected, candidateBin) {
  const roots = toolRoots(events, expected);
  const dispatchRoots = roots.filter((root) => root.kind === "dispatch");
  if (dispatchRoots.length !== 1) fail(`expected one original dispatch root; observed ${dispatchRoots.length}`);
  const initial = dispatchRoots[0];
  const ordered = [initial];
  for (const root of roots.filter((candidate) => candidate.kind === "continuation")) {
    validateContinuation(events, ordered.at(-1), root, candidateBin);
    ordered.push(root);
  }
  const finalRoot = ordered.at(-1);
  const outcome = batchRows(finalRoot, expected);
  const observedIds = new Set([finalRoot.runId, ...outcome.rows.map((row) => row.runId).filter(Boolean)]);
  const reads = events.filter((event) => event.type === "tool_execution_start" && event.toolName === "read" && typeof event.args?.path === "string").map((event) => event.args.path).filter((path) => path === finalRoot.statusPath || outcome.rows.some((row) => row.nativeStatusRef?.path === path || row.nativeStatusRef?.outputPath === path));
  const rootSummary = (root) => ({ runId: root.runId, toolCallId: root.toolCallId, asyncDir: root.asyncDir, statusPath: root.statusPath, statusSha256: root.statusSha256, state: root.status.state, kind: root.kind, startedAt: root.status.startedAt ?? null, endedAt: root.status.endedAt ?? null, durationMs: root.status.durationMs ?? null, totalTokens: root.status.totalTokens ?? null, totalCost: root.status.totalCost ?? null, runFanoutBudget: root.status.runFanoutBudget ?? null, workflowSteps: (root.status.steps ?? []).map((step) => ({ key: step.workflowKey ?? step.key ?? null, runId: step.runId ?? null, agent: step.agent ?? null, status: step.status ?? null, startedAt: step.startedAt ?? null, endedAt: step.endedAt ?? null, durationMs: step.durationMs ?? null, currentTool: step.currentTool ?? null, totalTokens: step.totalTokens ?? null, totalCost: step.totalCost ?? null })), workflowChildren: (root.status.workflowChildren?.children ?? []).map((child) => ({ key: child.workflowKey ?? child.childId ?? child.key ?? null, runId: child.runId ?? null, agent: child.agent ?? null, status: child.status ?? null, startedAt: child.startedAt ?? child.started ?? null, endedAt: child.completedAt ?? child.endedAt ?? null, durationMs: child.durationMs ?? null, usage: child.usage ?? null, totalCost: child.totalCost ?? null })) });
  const waitObservations = events.filter((event) => event.type === "tool_execution_start" && ["bg_wait", "subagent_wait"].includes(event.toolName) && observedIds.has(event.args?.id)).map((event) => ({ tool: event.toolName, id: event.args.id, toolCallId: event.toolCallId, result: contentText(eventEnd(events, event) ?? {}) }));
  return {
    status: outcome.reconciled ? "terminal" : "waiting",
    outcome: outcome.reconciled ? (outcome.rows.some((row) => row.status === "GATED") ? "terminal-gated" : outcome.rows.some((row) => row.status === "FAILED") ? "terminal-failed" : "terminal-done") : "not-reconciled",
    reason: outcome.reason,
    rootHistory: ordered.map(rootSummary),
    finalRoot: rootSummary(finalRoot),
    rows: outcome.rows,
    observations: { waits: waitObservations, readPaths: reads },
    continuationCount: ordered.length - 1,
  };
}
