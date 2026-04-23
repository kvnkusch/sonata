import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { closeDb, db } from "../db"
import { linkOpsRepo } from "../project"
import { ErrorCode } from "../rpc/base"
import { startTask } from "../task"
import { getStepToolset } from "./get-toolset"
import { startStep } from "./start"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  delete (globalThis as { __sonata_test_zod?: typeof z }).__sonata_test_zod
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("step.getToolset integration", () => {
  it("returns deterministic artifact and tool declarations", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-toolset-"))
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
          fetch_context: {
            description: "Fetch context",
            argsSchema: { limit: z.number().int().positive() },
            async execute() {
              return { ok: true }
            },
          },
        },
      },
      artifacts: [
        { name: "ticket_summary", kind: "markdown", required: true, once: true },
        { name: "plan_structured", kind: "json", required: false, once: true, schema: { parse: (value) => value } },
      ],
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

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_toolset" }, tx)
    })

    const started = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const initial = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const toolsetA = await getStepToolset({
      taskId: started.taskId,
      stepId: initial.stepId,
    })
    const toolsetB = await getStepToolset({
      taskId: started.taskId,
      stepId: initial.stepId,
    })

    expect({
      taskId: toolsetA.taskId,
      workflowId: toolsetA.workflowId,
      stepId: toolsetA.stepId,
      stepKey: toolsetA.stepKey,
      stepIndex: toolsetA.stepIndex,
      inputs: toolsetA.inputs,
      artifacts: toolsetA.artifacts,
      tools: toolsetA.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }).toEqual({
      taskId: toolsetB.taskId,
      workflowId: toolsetB.workflowId,
      stepId: toolsetB.stepId,
      stepKey: toolsetB.stepKey,
      stepIndex: toolsetB.stepIndex,
      inputs: toolsetB.inputs,
      artifacts: toolsetB.artifacts,
      tools: toolsetB.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    })
    expect(toolsetA.artifacts.map((artifact) => artifact.name)).toEqual([
      "ticket_summary",
      "plan_structured",
    ])
    expect(toolsetA.tools.map((tool) => tool.name)).toEqual([
      "sonata_write_ticket_summary_artifact_markdown",
      "sonata_write_plan_structured_artifact_json",
      "sonata_step_plan__fetch_context",
      "sonata_block_step",
      "sonata_complete_step",
    ])
  })

  it("does not expose sonata_block_step for steps without opencode", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-toolset-no-block-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
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

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_toolset_no_block" }, tx))
    const started = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const initial = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const toolset = await getStepToolset({ taskId: started.taskId, stepId: initial.stepId })
    expect(toolset.tools.map((tool) => tool.name)).toEqual([
      "sonata_write_ticket_summary_artifact_markdown",
      "sonata_complete_step",
    ])
  })

  it("fails fast when custom tool names normalize to collisions", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-toolset-collision-"))
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
          "tool-a": { description: "A", argsSchema: { x: z.string() }, async execute() { return "a" } },
          "tool a": { description: "B", argsSchema: { y: z.string() }, async execute() { return "b" } },
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

    const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_toolset_collision" }, tx))
    const started = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const initial = await startStep({ taskId: started.taskId, stepKey: "plan" })

    await expect(
      getStepToolset({
        taskId: started.taskId,
        stepId: initial.stepId,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
      status: 400,
      message: expect.stringContaining("normalize to the same OpenCode tool name"),
    })
  })

  it("namespaces custom tool ids that resemble reserved bridge names", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-toolset-reserved-like-"))
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
          sonata_complete_step: {
            description: "Looks reserved",
            argsSchema: { text: z.string().min(1) },
            async execute() { return { ok: true } },
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

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_toolset_reserved_like" }, tx))
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const initial = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const toolset = await getStepToolset({ taskId: started.taskId, stepId: initial.stepId })
    expect(toolset.tools.map((tool) => tool.name)).toEqual([
      "sonata_write_ticket_summary_artifact_markdown",
      "sonata_step_plan__sonata_complete_step",
      "sonata_block_step",
      "sonata_complete_step",
    ])
  })
})
