import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { artifactTable, closeDb, db, taskTable } from "@sonata/core/db"
import { linkOpsRepo } from "@sonata/core/project"
import { startTask } from "@sonata/core/task"
import { BridgeRuntimeEnvError, startupBridgeRuntime } from "./runtime"

const tempDirs: string[] = []

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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("bridge runtime integration", () => {
  it("validates required env, declares dynamic tools, and executes write + complete", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-bridge-runtime-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_bridge" }, tx)
    })
    const started = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })

    const runtime = await startupBridgeRuntime({
      env: {
        SONATA_TASK_ID: started.taskId,
        SONATA_STEP_ID: started.currentStepId,
        SONATA_PROJECT_ROOT: projectRoot,
        SONATA_OPS_ROOT: opsRoot,
      },
    })

    expect(runtime.toolset.tools.map((tool) => tool.name)).toEqual(runtime.tools.map((tool) => tool.name))

    const artifactTool = runtime.tools.find((tool) => tool.name === "sonata_write_ticket_summary_artifact_markdown")
    const completeTool = runtime.tools.find((tool) => tool.name === "sonata_complete_step")

    expect(artifactTool).toBeDefined()
    expect(completeTool).toBeDefined()

    await artifactTool?.invoke({ markdown: "Bridge write" }, { sessionId: "session-bridge" })
    const completion = await completeTool?.invoke({}, { sessionId: "session-bridge" })
    expect(completion).toMatchObject({ status: "completed" })

    const artifacts = db()
      .select()
      .from(artifactTable)
      .all()
      .filter((artifact) => artifact.taskId === started.taskId)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.sessionId).toBe("session-bridge")

    const taskRow = db()
      .select()
      .from(taskTable)
      .all()
      .find((task) => task.taskId === started.taskId)
    expect(taskRow?.status).toBe("completed")
  })

  it("fails fast when required env is missing", async () => {
    await expect(
      startupBridgeRuntime({
        env: {
          SONATA_STEP_ID: "stp_missing_task",
        },
      }),
    ).rejects.toBeInstanceOf(BridgeRuntimeEnvError)
  })
})
