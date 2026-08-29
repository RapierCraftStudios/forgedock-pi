import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyVerificationOutput,
  formatSkippedVerification,
  isVerificationDiagnosticReport,
  parseVerificationDiagnostics,
} from "../../src/core/verification-diagnostics.ts";

test("passing container fallback makes missing host imports environment-only", () => {
  const report = classifyVerificationOutput(
    'app/main.py:1: error: Import "fastapi" could not be resolved',
    {
      host: {
        name: "host Python 3.12 (no project dependencies)",
        attemptedCommand: "pyright app/main.py",
      },
      fallbacks: [
        {
          name: "api-test-container",
          kind: "container",
          command: "docker compose run --rm api pyright app/main.py",
          status: "passed",
        },
      ],
    },
  );

  assert.equal(report.schema, "forgedock.verification-diagnostics/v1");
  assert.equal(report.outcome, "environment-only");
  assert.equal(report.blockingDiagnostics.length, 0);
  assert.equal(report.selectedFallback?.name, "api-test-container");
  assert.equal(report.diagnostics[0]?.module, "fastapi");
});

test("missing dependency without a fallback remains blocked and records skip evidence", () => {
  const report = classifyVerificationOutput(
    "ModuleNotFoundError: No module named 'sqlalchemy'",
    {
      host: {
        name: "host Python 3.12",
        attemptedCommand: "pyright services/api",
      },
    },
  );

  assert.equal(report.outcome, "blocked");
  assert.equal(report.diagnostics[0]?.kind, "environment-unavailable");
  assert.equal(report.blockingDiagnostics.length, 1);
  assert.match(
    formatSkippedVerification(report.skipped[0]!),
    /SKIPPED — environment not provisioned/,
  );
  assert.match(formatSkippedVerification(report.skipped[0]!), /pyright services\/api/);
});

test("changed-code errors remain blocking after dependencies resolve", () => {
  const report = classifyVerificationOutput(
    "services/api.py:42: error: Argument of type 'str' is not assignable to parameter of type 'int'",
    {
      fallbacks: [
        {
          name: "api-venv",
          kind: "venv",
          command: ".venv/bin/pyright services/api.py",
          status: "passed",
        },
      ],
    },
  );

  assert.equal(report.outcome, "blocked");
  assert.equal(report.diagnostics[0]?.kind, "changed-code");
  assert.equal(report.blockingDiagnostics[0]?.message.includes("Argument"), true);
  assert.equal(report.selectedFallback, undefined);
});

test("relative module failures are changed-code diagnostics", () => {
  const report = classifyVerificationOutput(
    "src/index.ts:4: error TS2307: Cannot find module './missing'",
    {
      fallbacks: [
        {
          name: "unrelated-check",
          kind: "other",
          command: "npm test",
          status: "passed",
        },
      ],
    },
  );
  assert.equal(report.outcome, "blocked");
  assert.equal(report.diagnostics[0]?.kind, "changed-code");
  assert.equal(report.selectedFallback, undefined);
});

test("code diagnostics retain blocking precedence on an import line", () => {
  const report = classifyVerificationOutput(
    'Import "fastapi" could not be resolved; TypeError: invalid value',
    {
      fallbacks: [{ name: "container", kind: "container", command: "docker test", status: "passed" }],
    },
  );
  assert.equal(report.outcome, "blocked");
  assert.ok(report.diagnostics.some((entry) => entry.kind === "changed-code"));
});

test("diagnostic report validation rejects contradictory machine results", () => {
  const report = classifyVerificationOutput("SyntaxError: invalid syntax");
  assert.equal(isVerificationDiagnosticReport(report), true);
  assert.equal(
    isVerificationDiagnosticReport({ ...report, outcome: "environment-only" }),
    false,
  );
});

test("syntax errors are never treated as missing-environment noise", () => {
  const diagnostics = parseVerificationDiagnostics("app/main.py:7: SyntaxError: invalid syntax");
  assert.equal(diagnostics[0]?.kind, "syntax-error");
  assert.equal(diagnostics[0]?.blocking, true);
});
