import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseCandidateConfig, sanitizeCandidateConfig } from "../../src/candidate/config.ts";

const yaml = `
project:
  owner: example
  repo: product
paths:
  root: .
branches:
  default: main
  staging: integration
  feature_pattern: feature/{slug}
agents:
  subagent_model: provider/model
  thinking: medium
orchestration:
  max_concurrent: 8
verification:
  commands:
    test: npm test
review:
  reviewer_timeout_ms: 1000
  panel_timeout_ms: 4000
  publication_timeout_ms: 1000
  max_concurrent: 2
  remediation_max_rounds: 1
`;

test("parses one canonical configuration and caps qualification owners", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-config-");
  try {
    const configPath = join(root, "forge.yaml");
    await writeFile(configPath, yaml);
    const config = parseCandidateConfig(yaml, configPath, root);
    assert.equal(config.repository, "example/product");
    assert.equal(config.integrationBranch, "integration");
    assert.equal(config.protectedBranch, "main");
    assert.equal(config.ownerModel, "provider/model");
    assert.equal(config.ownerThinking, "medium");
    assert.equal(config.configuredOwnerConcurrency, 8);
    assert.deepEqual(sanitizeCandidateConfig(config).qualificationOwnerConcurrency, 2);
    assert.deepEqual(config.verificationCommands, { test: "npm test" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unrecognized thinking suffix instead of generating a double suffix", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-config-");
  try {
    const configPath = join(root, "forge.yaml");
    const invalid = yaml.replace("provider/model", "provider/model:invalid");
    await writeFile(configPath, invalid);
    assert.throws(() => parseCandidateConfig(invalid, configPath, root), /Unsupported model thinking suffix/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects shared integration and protected branches", async () => {
  const root = await mkdtemp("/tmp/forgedock-candidate-config-");
  try {
    const configPath = join(root, "forge.yaml");
    const invalid = yaml.replace("staging: integration", "staging: main");
    await writeFile(configPath, invalid);
    assert.throws(() => parseCandidateConfig(invalid, configPath, root), /must be distinct/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
