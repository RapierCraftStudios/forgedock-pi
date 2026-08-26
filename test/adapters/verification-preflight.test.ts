import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { VerificationCommandPolicy } from "../../src/core/policy.ts";
import {
  discoverNpmTestPackage,
  preflightVerificationCommands,
  VerificationPreflightError,
} from "../../src/adapters/verification-preflight.ts";

const TIMEOUT_MS = 600_000;

function npmTestCommand(workingDirectory: string): VerificationCommandPolicy {
  return {
    argv: ["npm", "test"],
    required: true,
    timeoutMs: TIMEOUT_MS,
    workingDirectory,
  };
}

async function packageJson(
  root: string,
  directory: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(root, directory), { recursive: true });
  await writeFile(
    join(root, directory, "package.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function fakeNpmEnvironment(): Promise<{
  directory: string;
  env: NodeJS.ProcessEnv;
}> {
  const directory = await mkdtemp(join(tmpdir(), "forge-npm-"));
  const executable = join(
    directory,
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  return {
    directory,
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("discovers and preflights a unique nested npm test package", async () => {
  const root = fileURLToPath(
    new URL("../fixtures/monorepo-no-root-test/", import.meta.url),
  );
  const fakeNpm = await fakeNpmEnvironment();
  try {
    assert.equal(await discoverNpmTestPackage(root), "web");
    await preflightVerificationCommands(
      root,
      { test: npmTestCommand("web") },
      { configPath: ".forge/config.json", env: fakeNpm.env },
    );
  } finally {
    await rm(fakeNpm.directory, { recursive: true, force: true });
  }
});

test("prefers a runnable repository-root npm test", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-root-"));
  try {
    await packageJson(root, ".", {
      name: "root-package",
      scripts: { test: "node --version" },
    });
    await packageJson(root, "nested", {
      name: "nested-package",
      scripts: { test: "node --version" },
    });
    assert.equal(await discoverNpmTestPackage(root), ".");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses CI-only mode when nested npm test packages are ambiguous", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-ambiguous-"));
  try {
    await packageJson(root, ".", { name: "root-package" });
    await packageJson(root, "first", {
      name: "first-package",
      scripts: { test: "node --version" },
    });
    await packageJson(root, "second", {
      name: "second-package",
      scripts: { test: "node --version" },
    });
    assert.equal(await discoverNpmTestPackage(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight checks npm scripts without executing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-no-exec-"));
  const marker = join(root, "executed");
  const executable = join(root, "check");
  try {
    await packageJson(root, ".", { name: "no-exec-package" });
    await writeFile(executable, `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(executable, 0o755);
    await preflightVerificationCommands(
      root,
      {
        check: {
          argv: [executable],
          required: true,
          timeoutMs: TIMEOUT_MS,
          workingDirectory: ".",
        },
      },
      { configPath: ".forge/config.json" },
    );
    assert.equal(await pathExists(marker), false);
    assert.equal((await readFile(executable, "utf8")).includes("touch"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports exact config paths and remediation for missing preconditions", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-errors-"));
  const fakeNpm = await fakeNpmEnvironment();
  try {
    await packageJson(root, ".", { name: "missing-script-package" });
    await assert.rejects(
      preflightVerificationCommands(
        root,
        { test: npmTestCommand(".") },
        { configPath: ".forge/config.json", env: fakeNpm.env },
      ),
      (error: unknown) => {
        assert.ok(error instanceof VerificationPreflightError);
        assert.match(
          error.message,
          /\.forge\/config\.json\.verification\.commands\.test/,
        );
        assert.match(error.message, /npm script 'test' is not defined/);
        assert.match(error.message, /\/forge:init/);
        return true;
      },
    );

    await assert.rejects(
      preflightVerificationCommands(
        root,
        { test: npmTestCommand("missing-package") },
        { configPath: ".forge/config.json", env: fakeNpm.env },
      ),
      /workingDirectory.*does not exist/,
    );

    await assert.rejects(
      preflightVerificationCommands(
        root,
        {
          check: {
            argv: ["forge-command-that-is-not-installed"],
            required: true,
            timeoutMs: TIMEOUT_MS,
            workingDirectory: ".",
          },
        },
        { configPath: ".forge/config.json" },
      ),
      /executable 'forge-command-that-is-not-installed'/,
    );
  } finally {
    await rm(fakeNpm.directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinked command directories that escape the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
  const fakeNpm = await fakeNpmEnvironment();
  try {
    await symlink(outside, join(root, "linked"), "dir");
    await assert.rejects(
      preflightVerificationCommands(
        root,
        { test: npmTestCommand("linked") },
        { configPath: ".forge/config.json", env: fakeNpm.env },
      ),
      /resolves outside the repository/,
    );
  } finally {
    await rm(fakeNpm.directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
