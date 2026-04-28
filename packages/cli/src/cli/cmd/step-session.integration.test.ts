import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
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

function parseKey(stderrOutput: string, key: string): string {
  const match = stderrOutput.match(new RegExp(`${key}:\\s+(\\S+)`))
  if (!match?.[1]) {
    throw new Error(`Missing ${key} in output: ${stderrOutput}`)
  }
  return match[1]
}

function writeOpsWorkflowFiles(opsRoot: string) {
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
}

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("step session cli", () => {
  it("lists step sessions and rejects attaching to a step without one", () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-cli-step-session-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    const dbPath = path.join(sandbox, "db", "sonata.db")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = dbPath
    const env = { ...process.env, SONATA_DB_PATH: dbPath } as Record<string, string>

    const link = runCli(["project", "link", opsRoot, "--project-root", projectRoot, "--project-id", "prj_step_session"], env)
    expect(link.exitCode).toBe(0)

    const start = runCli(["task", "start", "default", "--project-id", "prj_step_session"], env)
    expect(start.exitCode).toBe(0)
    const taskId = parseKey(Buffer.from(start.stderr).toString("utf8"), "task_id")

    const stepStart = runCli(["step", "start", "plan", "--task-id", taskId], env)
    expect(stepStart.exitCode).toBe(0)
    const stepId = parseKey(Buffer.from(stepStart.stderr).toString("utf8"), "step_id")

    const attach = runCli(["step", "attach", stepId, "--task-id", taskId], env)
    expect(attach.exitCode).not.toBe(0)
    expect(Buffer.from(attach.stderr).toString("utf8")).toContain(`Step ${stepId} does not have an attachable OpenCode session`)

    const sqlite = new Database(dbPath)
    sqlite
      .query("UPDATE step SET session_id = ?, opencode_base_url = ? WHERE step_id = ?")
      .run("ses_cli", "http://127.0.0.1:1234", stepId)
    sqlite.close(false)

    const sessions = runCli(["step", "sessions", "--task-id", taskId], env)
    expect(sessions.exitCode).toBe(0)
    const output = Buffer.from(sessions.stderr).toString("utf8")
    expect(output).toContain("step_sessions:")
    expect(output).toContain(`step_id=${stepId}`)
    expect(output).toContain("step_key=plan")
    expect(output).toContain("session_id=ses_cli")
    expect(output).toContain("opencode_base_url=present")
  })
})
