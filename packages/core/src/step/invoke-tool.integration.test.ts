import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { closeDb, db } from "../db"
import { linkOpsRepo } from "../project"
import { ErrorCode } from "../rpc/base"
import { createCaller } from "../rpc/caller"
import { completeStep } from "./complete"
import { startStep } from "./start"
import { writeStepArtifact } from "./write-artifact"

const tempDirs: string[] = []

function writeOpsWorkflowFiles(opsRoot: string) {
  mkdirSync(path.join(opsRoot, "workflows"), { recursive: true })
  ;(globalThis as { __sonata_test_zod?: typeof z }).__sonata_test_zod = z
  writeFileSync(
    path.join(opsRoot, "workflows", "default.ts"),
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
          format_summary: {
            description: "Format summary",
            argsSchema: {
              title: z.string().min(1),
              includeFooter: z.boolean().optional(),
            },
            async execute(_ctx, args) {
              return {
                content: args.includeFooter ? args.title + "\\n--" : args.title,
              }
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
  delete (globalThis as { __sonata_test_zod?: typeof z }).__sonata_test_zod
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("step.invokeTool integration", () => {
  it("invokes a declared custom OpenCode tool and validates args", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-invoke-tool-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_invoke_tool" }, tx))
    const caller = createCaller()
    const started = await caller.task.start({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const invoked = await caller.step.invokeTool({
      taskId: started.taskId,
      stepId: step.stepId,
      toolId: "format_summary",
      args: { title: "Ship feature", includeFooter: true },
      sessionId: "session-custom",
    })
    expect(invoked.result).toEqual({ content: "Ship feature\n--" })

    await expect(
      caller.step.invokeTool({
        taskId: started.taskId,
        stepId: step.stepId,
        toolId: "format_summary",
        args: { includeFooter: true },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
      status: 400,
      message: expect.stringContaining("title"),
    })
  })

  it("rejects invocation when step is not active", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-invoke-tool-inactive-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_invoke_tool_inactive" }, tx))
    const caller = createCaller()
    const started = await caller.task.start({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    await writeStepArtifact({
      taskId: started.taskId,
      stepId: step.stepId,
      artifactName: "ticket_summary",
      artifactKind: "markdown",
      payload: { markdown: "ready" },
    })
    await completeStep({ taskId: started.taskId, stepId: step.stepId })

    await expect(
      caller.step.invokeTool({
        taskId: started.taskId,
        stepId: step.stepId,
        toolId: "format_summary",
        args: { title: "after complete" },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_STEP_TRANSITION,
      status: 409,
      message: expect.stringContaining("is not active"),
    })
  })

  it("rejects non-JSON-serializable custom tool return values", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-invoke-tool-nonjson-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(path.join(opsRoot, "workflows"), { recursive: true })
    ;(globalThis as { __sonata_test_zod?: typeof z }).__sonata_test_zod = z

    writeFileSync(
      path.join(opsRoot, "workflows", "default.ts"),
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
          return_non_json: {
            description: "Return unsupported payload",
            argsSchema: { input: z.string().min(1) },
            async execute() {
              return { value: 1n }
            },
          },
        },
      },
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

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_invoke_tool_nonjson" }, tx))
    const caller = createCaller()
    const started = await caller.task.start({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    await expect(
      caller.step.invokeTool({
        taskId: started.taskId,
        stepId: step.stepId,
        toolId: "return_non_json",
        args: { input: "x" },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
      status: 400,
    })
  })
})
