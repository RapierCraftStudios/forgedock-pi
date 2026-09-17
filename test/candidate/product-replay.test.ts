import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("product-like replay proves a failing consumer before and after the fix", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-product-");
  try {
    await mkdir(join(root, "test"));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node test/consumer-check.mjs" } }));
    await writeFile(join(root, "src-producer.mjs"), "export function value() { return \"wrong\"; }\n");
    await writeFile(join(root, "src-consumer.mjs"), "import { value } from './src-producer.mjs';\nexport function rendered() { return `value:${value()}`; }\n");
    await writeFile(join(root, "test", "consumer-check.mjs"), "import assert from 'node:assert/strict';\nimport { rendered } from '../src-consumer.mjs';\nassert.equal(rendered(), 'value:right');\n");

    await assert.rejects(execFileAsync("npm", ["test"], { cwd: root }));
    await writeFile(join(root, "src-producer.mjs"), "export function value() { return \"right\"; }\n");
    await execFileAsync("npm", ["test"], { cwd: root });
    assert.match(await readFile(join(root, "src-consumer.mjs"), "utf8"), /src-producer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
