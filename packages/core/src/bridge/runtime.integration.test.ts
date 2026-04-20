import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { artifactTable, closeDb, db, taskTable } from "../db"
import { linkOpsRepo } from "../project"
import { startStep } from "../step"
import { startTask } from "../task"
import { BridgeRuntimeEnvError, startupBridgeRuntime } from "./runtime"

const tempDirs: string[] = []

function writeOpsWorkflowFiles(opsRoot: string) {
  ;(globalThis as { __sonata_test_zod?: typeof z }).__sonata_test_zod = z
  writeOpsWorkflowFilesFromSource(
    opsRoot,
    `const z = globalThis.__sonata_test_zod

export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      opencode: {
        tools: {
          custom_echo: {
            description: "Echo custom input",
            argsSchema: { text: z.string().min(1) },
            async execute(_ctx, args) {
              return { echoed: args.text }
            },
          },
        },
      },
      artifacts: [{ name: "ticket_summary", kind: "markdown", required: true, once: true }],
      async run() {},
      async on() {},
    },
  ],
}
`,
  )
}

function writeOpsWorkflowFilesFromSource(opsRoot: string, workflowSource: string) {
  mkdirSync(path.join(opsRoot, "workflows"), { recursive: true })
  writeFileSync(path.join(opsRoot, "workflows", "default.ts"), workflowSource, "utf8")
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
  delete (globalThis as { __sonata_test_zod?: typeof z }).__sonata_test_zod
  delete (globalThis as { __sonata_bridge_events?: string[] }).__sonata_bridge_events
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("bridge runtime integration", () => {
  it("validates required env, declares dynamic tools, and executes write + custom + complete", async () => {
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
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const runtime = await startupBridgeRuntime({
      env: {
        SONATA_TASK_ID: started.taskId,
        SONATA_STEP_ID: step.stepId,
        SONATA_PROJECT_ROOT: projectRoot,
        SONATA_OPS_ROOT: opsRoot,
      },
    })

    expect(runtime.toolset.tools.map((tool) => tool.name)).toEqual(runtime.tools.map((tool) => tool.name))

    const artifactTool = runtime.tools.find((tool) => tool.name === "sonata_write_ticket_summary_artifact_markdown")
    const customTool = runtime.tools.find((tool) => tool.name === "sonata_step_plan__custom_echo")
    const completeTool = runtime.tools.find((tool) => tool.name === "sonata_complete_step")

    expect(artifactTool).toBeDefined()
    expect(customTool).toBeDefined()
    expect(completeTool).toBeDefined()

    await artifactTool?.invoke({ markdown: "Bridge write" }, { sessionId: "session-bridge" })
    const customResult = await customTool?.invoke({ text: "hello" }, { sessionId: "session-bridge" })
    expect(customResult).toEqual({ echoed: "hello" })
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
    expect(taskRow?.status).toBe("active")
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

  it("emits opencode.complete + step.completed hooks via runtime completion", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-bridge-runtime-hooks-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })

    ;(globalThis as { __sonata_bridge_events?: string[] }).__sonata_bridge_events = []
    writeOpsWorkflowFilesFromSource(
      opsRoot,
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      next: "ship",
      opencode: {},
      artifacts: [{ name: "ticket_summary", kind: "markdown", required: true, once: true }],
      async run() {},
      async on(_ctx, event) {
        if (event.type === "opencode.complete") {
          globalThis.__sonata_bridge_events.push("opencode.complete:" + event.sessionId)
        }
        if (event.type === "step.completed") {
          globalThis.__sonata_bridge_events.push("step.completed")
        }
      },
    },
    {
      id: "ship",
      title: "Ship",
      async run() {},
      async on() {},
    },
  ],
}
`,
    )

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_bridge_hooks" }, tx)
    })
    const started = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const runtime = await startupBridgeRuntime({
      env: {
        SONATA_TASK_ID: started.taskId,
        SONATA_STEP_ID: step.stepId,
        SONATA_PROJECT_ROOT: projectRoot,
        SONATA_OPS_ROOT: opsRoot,
      },
    })

    const artifactTool = runtime.tools.find((tool) => tool.name === "sonata_write_ticket_summary_artifact_markdown")
    const completeTool = runtime.tools.find((tool) => tool.name === "sonata_complete_step")

    await artifactTool?.invoke({ markdown: "Bridge write" }, { sessionId: "session-hooks" })
    const completion = await completeTool?.invoke({}, { sessionId: "session-hooks" })

    expect(completion).toEqual({ status: "completed", suggestedNextStepKey: "ship" })
    expect((globalThis as { __sonata_bridge_events?: string[] }).__sonata_bridge_events).toEqual([
      "opencode.complete:session-hooks",
      "step.completed",
    ])
  })
})
