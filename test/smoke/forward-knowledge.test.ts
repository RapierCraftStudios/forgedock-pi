import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile);
const text = (path: string) => readFile(path, "utf8");

function record(id: number, kind: string, body: string, inputs: string[] = [], supersedes: string | null = null, head = "a".repeat(40)) {
  return { id, html_url: `https://github.com/example/repo/issues/42#issuecomment-${id}`,
    created_at: `2026-01-01T00:${String(id).padStart(2, "0")}:00Z`, updated_at: `2026-01-01T00:${String(id).padStart(2, "0")}:00Z`,
    user: { login: "fixture-bot" },
    body: `<!-- FORGE:${kind} -->\n<!-- FORGE:RECORD ${JSON.stringify({ v: 1, source_head: head, inputs, supersedes })} -->\n## ${kind}\n**Source head**: ${head}\n**Inputs**: ${inputs.join(", ") || "none"}\n**Supersedes**: ${supersedes || "none"}\n${body}` };
}

test("named pre-build knowledge is published before implementation without duplicate phase agents", async () => {
  const spec = await text("specs/knowledge-records.md");
  const root = await text("specs/original/commands/work-on.md");
  const build = await text("specs/original/commands/work-on/build.md");
  for (const kind of ["CLASSIFICATION", "CONTEXT", "CONTRACT", "ARCHITECT"]) assert.ok(spec.includes(`FORGE:${kind}`));
  assert.match(spec, /before.*first.*source.*edit/is);
  assert.match(build, /knowledge-records\.md/);
  assert.doesNotMatch(root, /existing four|four normal|creates only these records/);
  assert.match(root, /pre-build challenger.*subagent.*forbidden before review/is);
  assert.match(build, /one short, fresh, read-only challenge/);
  assert.match(spec, /not raw.*thought|not.*chain.of.thought/i);
});

test("documented query retrieves a forward graph and preserves revised decisions", async () => {
  const spec = await text("specs/knowledge-records.md");
  const query = spec.match(/```jq\n([\s\S]*?)\n```/)?.[1];
  assert.ok(query);
  const investigation = record(1, "INVESTIGATOR", "Cause: readers observe a partially written cache.");
  const classification = record(2, "CLASSIFICATION", "One atomic publication contract.", [investigation.html_url]);
  const context = record(3, "CONTEXT", "Prior constraint: retain format-v1 compatibility.", [investigation.html_url]);
  const contract = record(4, "CONTRACT", "Require atomic publication and backwards compatibility.", [classification.html_url, context.html_url]);
  const oldPlan = record(5, "ARCHITECT", "Initial plan: lock around a direct write.", [contract.html_url]);
  const plan = record(6, "ARCHITECT", "Changed plan: temp file then rename; direct writes rejected because unlocked readers exist.", [contract.html_url], oldPlan.html_url);
  const builder = record(7, "BUILDER", `Regression failed before and passed after; committed head ${"b".repeat(40)}.`, [plan.html_url], null, "b".repeat(40));
  const review = record(8, "REVIEW-PANEL", "Historical v1 constraint remains valid; no format rewrite required. No blockers.", [builder.html_url, context.html_url, contract.html_url], null, "b".repeat(40));
  const terminal = record(9, "TRAJECTORY", "Merged; cross-host atomicity remains unverified.", [builder.html_url, review.html_url], null, "b".repeat(40));
  const legacy = { ...record(10, "CONTEXT", ""), body: "<!-- FORGE:CONTEXT -->\n## Legacy context\nEarlier decision remains readable." };
  const malformed = { ...record(12, "CONTEXT", ""), body: "<!-- FORGE:CONTEXT -->\n<!-- FORGE:RECORD {invalid-json} -->\nKeep the human evidence, but do not invent metadata." };
  const records = [investigation, classification, context, contract, oldPlan, plan, builder, review, terminal, legacy, record(11, "HEARTBEAT", "noise"), malformed];
  const dir = await mkdtemp(join(tmpdir(), "forge-forward-graph-"));
  try {
    const file = join(dir, "comments.json"); await writeFile(file, JSON.stringify(records));
    const { stdout } = await exec("jq", [query, file]);
    const fetched = JSON.parse(stdout) as Array<{ id: number; url: string; body: string; record: { inputs: string[]; supersedes: string | null } | null }>;
    assert.equal(fetched.length, 11, "progress noise must not replace substantive records");
    assert.equal(fetched.find(r => r.id === 10)?.record, null, "legacy records are retained without fabricated metadata");
    assert.equal(fetched.find(r => r.id === 12)?.record, null);
    assert.match(fetched.find(r => r.id === 12)!.body, /Keep the human evidence/);
    const byUrl = new Map(fetched.map(r => [r.url, r]));
    const visited = new Set<string>(); const queue = [terminal.html_url];
    while (queue.length) {
      const url = queue.shift()!; if (visited.has(url)) continue;
      const node = byUrl.get(url); assert.ok(node, `missing input ${url}`); visited.add(url);
      queue.push(...(node.record?.inputs ?? []));
      if (node.record?.supersedes) queue.push(node.record.supersedes);
    }
    const reconstructed = [...visited].map(url => byUrl.get(url)!.body).join("\n");
    for (const fact of ["partially written", "format-v1", "Initial plan", "unlocked readers", "failed before", "Historical v1", "cross-host atomicity"]) assert.ok(reconstructed.includes(fact), fact);
    assert.ok(visited.has(oldPlan.html_url), "a changed plan must not erase its predecessor");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("non-build outcomes do not fabricate a build or review history", async () => {
  const records = await text("specs/knowledge-records.md");
  const close = await text("specs/original/commands/work-on/close.md");
  assert.match(records, /INVALID links its investigation/);
  assert.match(records, /DECOMPOSED links investigation/);
  assert.match(records, /Never require or invent nonexistent/);
  assert.match(close, /Never invent records from phases that did not execute/);
});

test("review uses the graph independently and writes evidence-based dispositions back", async () => {
  const review = await text("skills/forgedock-review-pr/SKILL.md");
  assert.match(review, /independent.*not.*historically blind/is);
  assert.match(review, /contract.*context.*plan/is);
  assert.match(review, /deliberate trade.off.*superseded|superseded.*deliberate trade.off/is);
  assert.match(review, /past approval.*not.*waiver/is);
  assert.match(review, /FORGE:REVIEW-PANEL/);
  assert.match(review, /knowledge-records\.md/);
});
