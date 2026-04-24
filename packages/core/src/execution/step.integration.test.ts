import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { artifactTable, closeDb, db, stepTable } from "../db"
import { executeStep } from "../execution"
import { stepLogPath, taskWorkflowLogPath } from "../logging"
import { linkOpsRepo } from "../project"
import { getStep } from "../step/get"
import { completeStep, startStep, writeStepArtifact } from "../step"
import { startTask } from "../task"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  delete (globalThis as { __sonata_test_zod?: typeof z }).__sonata_test_zod
  delete (globalThis as { __sonata_test_stepResult?: { completed: (input?: { completionPayload?: unknown }) => unknown } })
    .__sonata_test_stepResult
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function setupSandbox(name: string, workflowSource: string) {
  const sandbox = mkdtempSync(path.join(tmpdir(), `sonata-exec-step-${name}-`))
  tempDirs.push(sandbox)

  const projectRoot = path.join(sandbox, "project")
  const opsRoot = path.join(sandbox, "ops")
  mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
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

  process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")
  const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId: `prj_${name}` }, tx))
  return { projectRoot, opsRoot, linked }
}

describe("execution.step integration", () => {
  it("writes workflow log streams to ops logs", async () => {
    const { linked, opsRoot } = setupSandbox(
      "logs",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      async run(ctx) {
        ctx.log.info("preparing plan", { phase: "plan", count: 1 })
        await ctx.completeStep({ logged: true })
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })
    const result = await executeStep({ taskId: task.taskId, stepId: step.stepId })

    expect(result.status).toBe("completed")

    const workflowRecords = readFileSync(
      taskWorkflowLogPath({ opsRootRealpath: opsRoot, taskId: task.taskId }),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message: string; level: string; details?: { phase?: string; count?: number } })

    expect(workflowRecords).toContainEqual(
      expect.objectContaining({
        stream: "workflow",
        level: "info",
        message: "preparing plan",
        details: { phase: "plan", count: 1 },
      }),
    )

    const stepLog = readFileSync(
      stepLogPath({
        opsRootRealpath: opsRoot,
        taskId: task.taskId,
        stepId: step.stepId,
        stepKey: "plan",
        stepIndex: 1,
      }),
      "utf8",
    )
    expect(stepLog).toContain('"message":"preparing plan"')
  })

  it("exposes frozen start-time inputs as ctx.inputs", async () => {
    const { linked } = setupSandbox(
      "inputs",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "intake",
      title: "Intake",
      artifacts: [{ name: "topic", kind: "markdown", required: true, once: true }],
      async run() {},
      async on() {},
    },
    {
      id: "plan",
      title: "Plan",
      inputs: {
        artifacts: [
          {
            as: "topic",
            from: { step: "intake", artifact: "topic" },
            cardinality: { mode: "single", required: true },
          },
        ],
        invocation: {
          schema: {
            parse(input) {
              return input
            },
          },
        },
      },
      async run(ctx) {
        if (ctx.inputs.invocation?.strictness !== "high") {
          throw new Error("missing invocation snapshot")
        }
        if (ctx.inputs.artifacts.topic?.trim() !== "topic v1") {
          throw new Error("missing artifact value")
        }
        await ctx.completeStep({ ok: true })
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const intake1 = await startStep({ taskId: task.taskId, stepKey: "intake" })
    await writeStepArtifact({
      taskId: task.taskId,
      stepId: intake1.stepId,
      artifactName: "topic",
      artifactKind: "markdown",
      payload: { markdown: "topic v1" },
    })
    await completeStep({ taskId: task.taskId, stepId: intake1.stepId })

    const intake2 = await startStep({ taskId: task.taskId, stepKey: "intake" })
    await writeStepArtifact({
      taskId: task.taskId,
      stepId: intake2.stepId,
      artifactName: "topic",
      artifactKind: "markdown",
      payload: { markdown: "topic v2" },
    })
    await completeStep({ taskId: task.taskId, stepId: intake2.stepId })

    const plan = await startStep({
      taskId: task.taskId,
      stepKey: "plan",
      invocation: { strictness: "high" },
      artifactSelections: {
        topic: { mode: "indices", indices: [1] },
      },
    })

    const result = await executeStep({ taskId: task.taskId, stepId: plan.stepId })
    expect(result.status).toBe("completed")
  })

  it("loads json artifact inputs into ctx.inputs as parsed values", async () => {
    const { linked } = setupSandbox(
      "json-input-values",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "intake",
      title: "Intake",
      artifacts: [
        {
          name: "config",
          kind: "json",
          required: true,
          once: true,
          schema: {
            parse(input) {
              if (!input || typeof input !== "object") {
                throw new Error("invalid config")
              }
              return input
            },
          },
        },
      ],
      async run() {},
      async on() {},
    },
    {
      id: "plan",
      title: "Plan",
      inputs: {
        artifacts: [
          {
            as: "config",
            from: { step: "intake", artifact: "config" },
            cardinality: { mode: "single", required: true },
          },
        ],
      },
      async run(ctx) {
        const config = ctx.inputs.artifacts.config
        if (!config || typeof config !== "object" || config.mode !== "fast") {
          throw new Error("missing parsed json artifact value")
        }
        await ctx.completeStep({ ok: true })
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const intake = await startStep({ taskId: task.taskId, stepKey: "intake" })
    await writeStepArtifact({
      taskId: task.taskId,
      stepId: intake.stepId,
      artifactName: "config",
      artifactKind: "json",
      payload: { source: "inline", data: { mode: "fast", retries: 3 } },
    })
    await completeStep({ taskId: task.taskId, stepId: intake.stepId })

    const plan = await startStep({
      taskId: task.taskId,
      stepKey: "plan",
    })

    const result = await executeStep({ taskId: task.taskId, stepId: plan.stepId })
    expect(result.status).toBe("completed")
  })

  it("supports inline json artifact writes from ctx.writeJsonArtifact", async () => {
    const { linked, opsRoot } = setupSandbox(
      "json-inline-write",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      artifacts: [
        {
          name: "plan_structured",
          kind: "json",
          required: true,
          once: true,
          schema: {
            parse(input) {
              return input
            },
          },
        },
      ],
      async run(ctx) {
        await ctx.writeJsonArtifact({ slug: "plan_structured", data: { bullets: ["inline"] } })
        await ctx.completeStep({ ok: true })
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })

    const result = await executeStep({ taskId: task.taskId, stepId: step.stepId })
    expect(result.status).toBe("completed")

    const artifact = db()
      .select()
      .from(artifactTable)
      .all()
      .find((row) => row.taskId === task.taskId && row.stepId === step.stepId && row.artifactName === "plan_structured")
    expect(artifact).toBeDefined()
    expect(readFileSync(path.join(opsRoot, artifact!.relativePath), "utf8")).toContain('"inline"')
  })

  it("auto-completes when run returns completed result", async () => {
    const { linked } = setupSandbox(
      "return-completed",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      async run() {
        return { status: "completed", completionPayload: { ok: true } }
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })

    const result = await executeStep({ taskId: task.taskId, stepId: step.stepId })
    expect(result.status).toBe("completed")

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(row?.status).toBe("completed")
  })

  it("returns active when run returns completed but canComplete rejects", async () => {
    ;(globalThis as {
      __sonata_test_stepResult?: { completed: (input?: { completionPayload?: unknown }) => unknown }
    }).__sonata_test_stepResult = {
      completed(input) {
        return { status: "completed", completionPayload: input?.completionPayload }
      },
    }

    const { linked } = setupSandbox(
      "return-completed-guard-rejected",
      `const stepResult = globalThis.__sonata_test_stepResult

export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      canComplete() {
        return { ok: false, code: "approval_required", message: "Approval required" }
      },
      async run() {
        return stepResult.completed({ completionPayload: { ok: true } })
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })

    const result = await executeStep({ taskId: task.taskId, stepId: step.stepId })
    expect(result).toMatchObject({ status: "active", suggestedNextStepKey: null })

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(row?.status).toBe("active")
  })

  it("auto-fails when run returns failed result", async () => {
    const { linked } = setupSandbox(
      "return-failed",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      async run() {
        return { status: "failed", reason: "validation failed", details: { code: "E_VALIDATION" } }
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })

    const result = await executeStep({ taskId: task.taskId, stepId: step.stepId })
    expect(result.status).toBe("failed")
    expect(result.failure).toEqual({
      reason: "validation failed",
      details: { code: "E_VALIDATION" },
    })

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(row?.status).toBe("failed")
  })

  it("auto-fails when run throws", async () => {
    const { linked } = setupSandbox(
      "throw-failed",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      async run() {
        throw new Error("boom")
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })

    const result = await executeStep({ taskId: task.taskId, stepId: step.stepId })
    expect(result.status).toBe("failed")
    expect(result.failure?.reason).toBe("boom")

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(row?.status).toBe("failed")
  })

  it("returns active for an open agent-driven step", async () => {
    const { linked } = setupSandbox(
      "void-active",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      async run() {},
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })

    const result = await executeStep({ taskId: task.taskId, stepId: step.stepId })
    expect(result.status).toBe("active")

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(row?.status).toBe("active")
  })

  it("returns waiting for a controller step with waitFor", async () => {
    const { linked } = setupSandbox(
      "controller-waiting",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "controller",
      title: "Controller",
      async run(ctx) {
        await ctx.children.spawn({ stepKey: "worker", workKey: "alpha" })
      },
      async waitFor() {
        return {
          kind: "children",
          childStepKey: "worker",
          workKeys: ["alpha"],
          until: "all_completed",
          label: "Waiting for worker",
        }
      },
      async on() {},
    },
    {
      id: "worker",
      title: "Worker",
      async run() {},
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const controller = await startStep({ taskId: task.taskId, stepKey: "controller" })

    const result = await executeStep({ taskId: task.taskId, stepId: controller.stepId })
    expect(result.status).toBe("waiting")

    expect(getStep({ taskId: task.taskId, stepId: controller.stepId })).toMatchObject({
      status: "waiting",
      waitSpec: {
        kind: "children",
        childStepKey: "worker",
        workKeys: ["alpha"],
        until: "all_completed",
        label: "Waiting for worker",
      },
      waitSnapshot: {
        totalCount: 1,
        activeCount: 1,
        completedCount: 0,
      },
    })
  })

  it("fails a child step that declares waitFor", async () => {
    const { linked } = setupSandbox(
      "child-waitfor-invalid",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "controller",
      title: "Controller",
      async run(ctx) {
        await ctx.children.spawn({ stepKey: "worker", workKey: "alpha" })
      },
      async on() {},
    },
    {
      id: "worker",
      title: "Worker",
      async run() {},
      async waitFor() {
        return {
          kind: "children",
          childStepKey: "worker",
          workKeys: ["alpha"],
          until: "all_completed",
        }
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const controller = await startStep({ taskId: task.taskId, stepKey: "controller" })
    const controllerResult = await executeStep({ taskId: task.taskId, stepId: controller.stepId })
    expect(controllerResult.status).toBe("active")

    const child = db().select().from(stepTable).where(eq(stepTable.parentStepId, controller.stepId)).get()
    const childResult = await executeStep({ taskId: task.taskId, stepId: child!.stepId })

    expect(childResult.status).toBe("failed")
    expect(childResult.failure?.reason).toContain("Only root steps may wait for persisted conditions")

    const childRow = db().select().from(stepTable).where(eq(stepTable.stepId, child!.stepId)).get()
    expect(childRow?.status).toBe("failed")
  })

  it("returns failed when run returns void and the step is failed during execution", async () => {
    const { linked } = setupSandbox(
      "void-failed",
      `import { Database } from "bun:sqlite"

export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      async run(ctx) {
        const sqlite = new Database(process.env.SONATA_DB_PATH)
        sqlite.run(
          "UPDATE step SET status = ?, completed_at = ?, completion_payload_json = ? WHERE step_id = ?",
          ["failed", Date.now(), JSON.stringify({ reason: "external fail" }), ctx.stepId],
        )
        sqlite.close(false)
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })

    const result = await executeStep({ taskId: task.taskId, stepId: step.stepId })
    expect(result.status).toBe("failed")
    expect(result.failure).toEqual({ reason: "external fail" })

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(row?.status).toBe("failed")
  })

  it("rejects invalid frozen inputs JSON", async () => {
    const { linked } = setupSandbox(
      "invalid-inputs",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      async run() {},
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })
    db().update(stepTable).set({ inputs: "{" }).where(eq(stepTable.stepId, step.stepId)).run()

    await expect(executeStep({ taskId: task.taskId, stepId: step.stepId })).rejects.toThrow(
      `Invalid frozen step inputs JSON for task=${task.taskId} step=${step.stepId}`,
    )
  })

  it("injects resolved custom OpenCode tool names into ctx.opencode.tools", async () => {
    ;(globalThis as { __sonata_test_zod?: typeof z }).__sonata_test_zod = z
    const { linked } = setupSandbox(
      "opencode-tool-mapping",
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
          "repo_lookup": {
            description: "Lookup repo",
            argsSchema: { query: z.string().min(1) },
            async execute() { return { ok: true } },
          },
        },
      },
      async run(ctx) {
        if (ctx.opencode.tools.repo_lookup.name !== "sonata_step_plan__repo_lookup") {
          throw new Error("missing resolved OpenCode tool mapping")
        }
        await ctx.completeStep()
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })
    const result = await executeStep({ taskId: task.taskId, stepId: step.stepId })
    expect(result.status).toBe("completed")
  })

  it("exposes stable ctx.children APIs to controller steps", async () => {
    const { linked } = setupSandbox(
      "controller-children-context",
      `let startedChildren = null
let startedOpsRoot = null

export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "controller",
      title: "Controller",
      async run(ctx) {
        if (!startedChildren) {
          throw new Error("missing children context on step.started")
        }
        if (startedChildren.spawn !== ctx.children.spawn) {
          throw new Error("children.spawn was not stable")
        }
        if (startedChildren.list !== ctx.children.list) {
          throw new Error("children.list was not stable")
        }
        if (startedChildren.summary !== ctx.children.summary) {
          throw new Error("children.summary was not stable")
        }
        if (startedChildren.readArtifacts !== ctx.children.readArtifacts) {
          throw new Error("children.readArtifacts was not stable")
        }
        if (startedOpsRoot !== ctx.opsRoot) {
          throw new Error("opsRoot changed between callbacks")
        }

        const first = await ctx.children.spawn({ stepKey: "worker", workKey: "alpha" })
        const second = await ctx.children.spawn({ stepKey: "worker", workKey: "alpha" })
        if (!second.existing || second.stepId !== first.stepId) {
          throw new Error("child spawn was not idempotent")
        }

        const children = await ctx.children.list({ stepKey: "worker" })
        const summary = await ctx.children.summary({ stepKey: "worker" })
        if (children.length !== 1 || summary.totalCount !== 1 || summary.activeCount !== 1) {
          throw new Error("child APIs returned unexpected data")
        }

        await ctx.completeStep({ childStepId: first.stepId })
      },
      async on(ctx, event) {
        if (event.type === "step.started") {
          startedChildren = ctx.children
          startedOpsRoot = ctx.opsRoot
        }
      },
    },
    {
      id: "worker",
      title: "Worker",
      async run() {},
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const step = await startStep({ taskId: task.taskId, stepKey: "controller" })
    const result = await executeStep({ taskId: task.taskId, stepId: step.stepId })

    expect(result.status).toBe("active")

    const controllerRow = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(controllerRow?.status).toBe("active")

    const children = db()
      .select()
      .from(stepTable)
      .where(eq(stepTable.parentStepId, step.stepId))
      .all()
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ stepKey: "worker", workKey: "alpha", parentStepId: step.stepId })
  })

  it("rejects child spawn attempts from child steps at runtime", async () => {
    const { linked } = setupSandbox(
      "child-spawn-guard",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "controller",
      title: "Controller",
      async run(ctx) {
        await ctx.children.spawn({ stepKey: "worker", workKey: "alpha" })
        await ctx.completeStep()
      },
      async on() {},
    },
    {
      id: "worker",
      title: "Worker",
      async run(ctx) {
        try {
          await ctx.children.spawn({ stepKey: "worker", workKey: "nested" })
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("Only root steps may spawn child steps")) {
            throw error
          }
          await ctx.completeStep({ guarded: true })
          return
        }
        throw new Error("expected child spawn to be rejected")
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const controller = await startStep({ taskId: task.taskId, stepKey: "controller" })
    const controllerResult = await executeStep({ taskId: task.taskId, stepId: controller.stepId })
    expect(controllerResult.status).toBe("active")

    const controllerRow = db().select().from(stepTable).where(eq(stepTable.stepId, controller.stepId)).get()
    expect(controllerRow?.status).toBe("active")

    const child = db().select().from(stepTable).where(eq(stepTable.parentStepId, controller.stepId)).get()
    expect(child?.stepKey).toBe("worker")

    const childResult = await executeStep({ taskId: task.taskId, stepId: child!.stepId })
    expect(childResult.status).toBe("completed")
  })

  it("wakes a waiting parent to active when its child completes", async () => {
    const { linked } = setupSandbox(
      "waiting-parent-wakeup",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "controller",
      title: "Controller",
      async run(ctx) {
        await ctx.children.spawn({ stepKey: "worker", workKey: "alpha" })
      },
      async waitFor() {
        return {
          kind: "children",
          childStepKey: "worker",
          workKeys: ["alpha"],
          until: "all_completed",
        }
      },
      async on() {},
    },
    {
      id: "worker",
      title: "Worker",
      async run(ctx) {
        await ctx.completeStep({ ok: true })
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const controller = await startStep({ taskId: task.taskId, stepKey: "controller" })

    const controllerResult = await executeStep({ taskId: task.taskId, stepId: controller.stepId })
    expect(controllerResult.status).toBe("waiting")

    const child = db().select().from(stepTable).where(eq(stepTable.parentStepId, controller.stepId)).get()
    expect(child?.status).toBe("active")

    const childResult = await executeStep({ taskId: task.taskId, stepId: child!.stepId })
    expect(childResult.status).toBe("completed")

    expect(getStep({ taskId: task.taskId, stepId: controller.stepId })).toMatchObject({
      status: "active",
      waitSpec: null,
      waitSnapshot: null,
    })
  })

  it("keeps a waiting parent asleep while requested workKeys are still missing", async () => {
    const { linked } = setupSandbox(
      "waiting-parent-missing-workkeys",
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "controller",
      title: "Controller",
      async run(ctx) {
        const children = await ctx.children.list({ stepKey: "worker" })
        if (children.length === 0) {
          await ctx.children.spawn({ stepKey: "worker", workKey: "alpha" })
        }
      },
      async waitFor() {
        return {
          kind: "children",
          childStepKey: "worker",
          workKeys: ["alpha", "beta"],
          until: "all_completed",
        }
      },
      async on() {},
    },
    {
      id: "worker",
      title: "Worker",
      async run(ctx) {
        await ctx.completeStep({ ok: true })
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const controller = await startStep({ taskId: task.taskId, stepKey: "controller" })

    const controllerResult = await executeStep({ taskId: task.taskId, stepId: controller.stepId })
    expect(controllerResult.status).toBe("waiting")

    const child = db().select().from(stepTable).where(eq(stepTable.parentStepId, controller.stepId)).get()
    expect(child?.workKey).toBe("alpha")

    const childResult = await executeStep({ taskId: task.taskId, stepId: child!.stepId })
    expect(childResult.status).toBe("completed")

    expect(getStep({ taskId: task.taskId, stepId: controller.stepId })).toMatchObject({
      status: "waiting",
      waitSpec: {
        kind: "children",
        childStepKey: "worker",
        workKeys: ["alpha", "beta"],
        until: "all_completed",
      },
      waitSnapshot: {
        totalCount: 2,
        pendingCount: 1,
        completedCount: 1,
        incompleteWorkKeys: ["beta"],
      },
    })
  })

  it("handles controller fan-out, wake-up, fan-in, and completion guard rejection", async () => {
    const { linked } = setupSandbox(
      "controller-fanin-guard",
      `let completionAttempts = 0

export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "controller",
      title: "Controller",
      async run(ctx) {
        const children = await ctx.children.list({ stepKey: "worker" })
        if (children.length === 0) {
          await ctx.children.spawn({ stepKey: "worker", workKey: "alpha" })
          await ctx.children.spawn({ stepKey: "worker", workKey: "beta" })
          return
        }

        const summary = await ctx.children.summary({ stepKey: "worker", workKeys: ["alpha", "beta"] })
        if (summary.totalCount !== 2 || summary.completedCount !== 2) {
          throw new Error("expected both child steps to be complete before fan-in")
        }
        await ctx.completeStep({ completedChildren: summary.completedCount })
      },
      async waitFor() {
        return {
          kind: "children",
          childStepKey: "worker",
          workKeys: ["alpha", "beta"],
          until: "all_completed",
          label: "Waiting for workers",
        }
      },
      canComplete() {
        completionAttempts += 1
        if (completionAttempts === 1) {
          return { ok: false, code: "fan_in_review", message: "Review aggregated child output first" }
        }
        return { ok: true }
      },
      async on() {},
    },
    {
      id: "worker",
      title: "Worker",
      async run(ctx) {
        await ctx.completeStep({ ok: true })
      },
      async on() {},
    },
  ],
}
`,
    )

    const task = await startTask({ projectId: linked.projectId })
    const controller = await startStep({ taskId: task.taskId, stepKey: "controller" })

    const initial = await executeStep({ taskId: task.taskId, stepId: controller.stepId })
    expect(initial.status).toBe("waiting")

    const children = db()
      .select()
      .from(stepTable)
      .where(eq(stepTable.parentStepId, controller.stepId))
      .all()
      .sort((a, b) => a.stepKey.localeCompare(b.stepKey) || (a.workKey ?? "").localeCompare(b.workKey ?? ""))
    expect(children).toHaveLength(2)
    expect(children.map((child) => child.workKey)).toEqual(["alpha", "beta"])

    for (const child of children) {
      const childResult = await executeStep({ taskId: task.taskId, stepId: child.stepId })
      expect(childResult.status).toBe("completed")
    }

    expect(getStep({ taskId: task.taskId, stepId: controller.stepId }).status).toBe("active")

    const guardRejected = await executeStep({ taskId: task.taskId, stepId: controller.stepId })
    expect(guardRejected).toMatchObject({ status: "active", suggestedNextStepKey: null })
    expect(getStep({ taskId: task.taskId, stepId: controller.stepId }).status).toBe("active")

    const completed = await executeStep({ taskId: task.taskId, stepId: controller.stepId })
    expect(completed.status).toBe("completed")

    const controllerRow = db().select().from(stepTable).where(eq(stepTable.stepId, controller.stepId)).get()
    expect(controllerRow?.status).toBe("completed")
  })
})
