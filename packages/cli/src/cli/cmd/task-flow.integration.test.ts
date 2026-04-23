import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { artifactTable, closeDb, db, stepTable, taskTable } from "@sonata/core/db"
import { startupBridgeRuntime } from "@sonata/core/bridge"

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
  steps: [
    {
      id: "plan",
      title: "Plan",
      artifacts: [{ name: "ticket_summary", kind: "markdown", required: true, once: true }],
      async run() {},
      async on() {},
    },
  ],
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
  delete process.env.SONATA_TASK_ID
  delete process.env.SONATA_STEP_ID
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("task flow cli integration", () => {
  it("runs link -> start -> list -> bridge write -> bridge complete flow", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-cli-flow-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    const dbPath = path.join(sandbox, "db", "sonata.db")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = dbPath
    const env = { ...process.env, SONATA_DB_PATH: dbPath } as Record<string, string>

    const link = runCli(["project", "link", opsRoot, "--project-root", projectRoot, "--project-id", "prj_flow"], env)
    expect(link.exitCode).toBe(0)

    const start = runCli(["task", "start", "default", "--project-id", "prj_flow"], env)
    expect(start.exitCode).toBe(0)

    const startStderr = Buffer.from(start.stderr).toString("utf8")
    const taskId = parseKey(startStderr, "task_id")

    const stepStart = runCli(["step", "start", "plan", "--task-id", taskId], env)
    expect(stepStart.exitCode).toBe(0)
    const stepId = parseKey(Buffer.from(stepStart.stderr).toString("utf8"), "step_id")

    const listed = runCli(["task", "list", "--project-id", "prj_flow"], env)
    expect(listed.exitCode).toBe(0)
    const listOutput = Buffer.from(listed.stderr).toString("utf8")
    expect(listOutput).toContain(`root_step_id=${stepId}`)
    expect(listOutput).toContain("root_step_status=active")

    const runtime = await startupBridgeRuntime({
      env: {
        SONATA_TASK_ID: taskId,
        SONATA_STEP_ID: stepId,
        SONATA_PROJECT_ROOT: projectRoot,
        SONATA_OPS_ROOT: opsRoot,
      },
    })

    expect(runtime.toolset.tools.map((tool) => tool.name)).toContain("sonata_write_ticket_summary_artifact_markdown")
    expect(runtime.toolset.tools.map((tool) => tool.name)).toContain("sonata_complete_step")

    const artifactTool = runtime.tools.find((tool) => tool.name === "sonata_write_ticket_summary_artifact_markdown")
    expect(artifactTool).toBeDefined()
    const writeResult = await artifactTool?.invoke({ markdown: "## Flow artifact" })
    const writeJson = writeResult as { relativePath: string }
    expect(readFileSync(path.join(opsRoot, writeJson.relativePath), "utf8")).toBe("## Flow artifact\n")

    const completeTool = runtime.tools.find((tool) => tool.name === "sonata_complete_step")
    expect(completeTool).toBeDefined()
    const completeJson = (await completeTool?.invoke({})) as { status: string }
    expect(completeJson.status).toBe("completed")

    const taskRow = db()
      .select()
      .from(taskTable)
      .all()
      .find((task) => task.taskId === taskId)
    expect(taskRow?.status).toBe("active")
    expect(
      db()
        .select()
        .from(stepTable)
        .all()
        .find((step) => step.stepId === stepId)?.status,
    ).toBe("completed")
    expect(
      db()
        .select()
        .from(artifactTable)
        .all()
        .filter((artifact) => artifact.taskId === taskId),
    ).toHaveLength(1)
  })
})
