import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb } from "@sonata/core/db";

export type ScenarioSandbox = {
  sandboxRoot: string;
  workspaceRoot: string;
  fixtureName: string;
  projectRoot: string;
  opsRoot: string;
  dbPath: string;
  env: Record<string, string>;
};

function repoRoot(): string {
  return path.resolve(import.meta.dir, "../../..");
}

function fixtureRoot(fixtureName: string): string {
  return path.resolve(import.meta.dir, "../fixtures", fixtureName);
}

function workflowImportUrl(): string {
  return pathToFileURL(path.join(repoRoot(), "packages/workflow/src/index.ts"))
    .href;
}

function stringEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

function patchWorkflowFixture(opsRoot: string) {
  const workflowPath = path.join(opsRoot, "workflows", "default.ts");
  const original = readFileSync(workflowPath, "utf8");
  const patched = original.replaceAll(
    "__SONATA_WORKFLOW_IMPORT__",
    workflowImportUrl(),
  );
  writeFileSync(workflowPath, patched, "utf8");
}

export function createScenarioSandbox(fixtureName: string): ScenarioSandbox {
  const sandboxRoot = mkdtempSync(
    path.join(tmpdir(), `sonata-e2e-${fixtureName}-`),
  );
  const workspaceRoot = path.join(sandboxRoot, fixtureName);
  cpSync(fixtureRoot(fixtureName), workspaceRoot, { recursive: true });

  const projectRoot = path.join(workspaceRoot, "project");
  const opsRoot = path.join(workspaceRoot, "ops");
  const dbPath = path.join(sandboxRoot, "db", "sonata.db");

  mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  patchWorkflowFixture(opsRoot);

  process.env.SONATA_DB_PATH = dbPath;

  return {
    sandboxRoot,
    workspaceRoot,
    fixtureName,
    projectRoot,
    opsRoot,
    dbPath,
    env: stringEnv({ SONATA_DB_PATH: dbPath }),
  };
}

export function destroyScenarioSandbox(sandbox: ScenarioSandbox) {
  closeDb();
  delete process.env.SONATA_DB_PATH;
  rmSync(sandbox.sandboxRoot, { recursive: true, force: true });
}

export function runCli(args: string[], env: Record<string, string>) {
  closeDb();
  return Bun.spawnSync({
    cmd: ["bun", path.join(repoRoot(), "packages/cli/src/index.ts"), ...args],
    cwd: repoRoot(),
    env,
  });
}

export function stderrText(result: {
  stderr: ArrayBufferLike | Uint8Array;
}): string {
  const stderr =
    result.stderr instanceof Uint8Array
      ? result.stderr
      : new Uint8Array(result.stderr);
  return Buffer.from(stderr).toString("utf8");
}

export function parseKey(output: string, key: string): string {
  const match = output.match(new RegExp(`${key}:\\s+(\\S+)`));
  if (!match?.[1]) {
    throw new Error(`Missing ${key} in CLI output: ${output}`);
  }
  return match[1];
}
