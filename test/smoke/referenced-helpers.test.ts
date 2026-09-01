import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const COMMANDS_ROOT = "specs/original/commands";
const PACKAGED_HELPERS_ROOT = "specs/original";

// These paths are intentionally runtime-only. They belong to the ForgeDock host or
// target repository rather than the npm package's self-contained original corpus.
const RUNTIME_ONLY_REFERENCES = new Set([
  "bin/engine-cli.mjs",
  "bin/engine.mjs",
  "bin/engine/phases.mjs",
  "bin/engine/state.mjs",
  "bin/hooks/interactive-engine.mjs",
  "bin/hooks/pre-tool-use.mjs",
  "bin/orchestrate-preflight.mjs",
  "bin/recall.mjs",
  "bin/runner.mjs",
  "bin/forge-utils.mjs",
  "bin/report.mjs",
  "bin/forgedock.mjs",
  "scripts/decrypt-secrets.sh",
  "scripts/doctor.sh",
  "scripts/registry.json",
]);

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function referencedPaths(source: string): Set<string> {
  const references = new Set<string>();
  for (const line of source.split("\n")) {
    // A shebang contains /usr/bin/env; it is not a packaged helper reference.
    if (line.startsWith("#!")) continue;
    for (const match of line.matchAll(/(?<![A-Za-z0-9_$.-])((?:bin|scripts)\/[A-Za-z0-9._/-]+)/g)) {
      const rawReference = match[1];
      if (!rawReference) continue;
      const reference = rawReference.replace(/[.,:;!?)}]+$/g, "");
      // Ignore directory names, globs, ellipses, and generated placeholders.
      if (!/\.[A-Za-z0-9]+$/.test(reference) || /[*?]|\.\.\.|\$\{|\{[^}]+\}/.test(reference)) continue;
      references.add(reference);
    }
  }
  return references;
}

test("every concrete helper path in original specs is packaged or explicitly runtime-only", async () => {
  const files = await markdownFiles(COMMANDS_ROOT);
  const references = new Set<string>();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const reference of referencedPaths(source)) references.add(reference);
  }

  assert.ok(references.size > 0, "expected original specs to contain helper references");
  const missing: string[] = [];
  for (const reference of [...references].sort()) {
    const packagedPath = join(PACKAGED_HELPERS_ROOT, reference);
    try {
      await readFile(packagedPath);
    } catch {
      if (!RUNTIME_ONLY_REFERENCES.has(reference)) missing.push(reference);
    }
  }

  assert.deepEqual(missing, [], `missing packaged helper references: ${missing.join(", ")}`);
});

test("runtime-only helper allowlist documents only concrete host or target-repository paths", async () => {
  const files = await markdownFiles(COMMANDS_ROOT);
  const references = new Set<string>();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const reference of referencedPaths(source)) references.add(reference);
  }

  for (const reference of RUNTIME_ONLY_REFERENCES) {
    assert.ok(
      references.has(reference),
      `${reference} is allowlisted but no longer referenced by original specs`,
    );
  }
});

