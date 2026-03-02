import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeDb } from "@sonata/core/db"

const tempDirs: string[] = []

function runCli(args: string[], env: Record<string, string>) {
  return Bun.spawnSync({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: path.join(import.meta.dir, "../../../"),
    env,
  })
}

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("task start cli", () => {
  it("starts a task for a linked project", () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-cli-start-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    const dbPath = path.join(sandbox, "db", "sonata.db")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(path.join(opsRoot, "workflows"), { recursive: true })
    writeFileSync(
      path.join(opsRoot, "workflows", "default.ts"),
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [{ id: "plan", title: "Plan", artifacts: [], async run() {}, async on() {} }],
}
`,
      "utf8",
    )
    writeFileSync(
      path.join(opsRoot, "config.json"),
      JSON.stringify(
        {
          version: 1,
          defaultWorkflowId: "default",
          workflowModules: [{ id: "default", path: "./workflows/default.ts" }],
        },
        null,
        2,
      ),
      "utf8",
    )

    process.env.SONATA_DB_PATH = dbPath

    const linkResult = runCli(
      ["project", "link", opsRoot, "--project-root", projectRoot, "--project-id", "prj_cli_task"],
      { ...process.env, SONATA_DB_PATH: dbPath } as Record<string, string>,
    )
    expect(linkResult.exitCode).toBe(0)

    const startResult = runCli(
      ["task", "start", "default", "--project-id", "prj_cli_task"],
      { ...process.env, SONATA_DB_PATH: dbPath } as Record<string, string>,
    )
    expect(startResult.exitCode).toBe(0)
    expect(Buffer.from(startResult.stderr).toString()).toContain("task_id: tsk_")
    expect(Buffer.from(startResult.stderr).toString()).toContain("workflow: default")
  })
})
