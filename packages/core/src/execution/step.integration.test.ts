import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { closeDb, db, stepTable } from "../db"
import { executeStep } from "../execution"
import { linkOpsRepo } from "../project"
import { completeStep, startStep, writeStepArtifact } from "../step"
import { startTask } from "../task"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
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
        if (!ctx.inputs.artifacts.topic?.refs[0]?.relativePath.includes("001-intake-topic.md")) {
          throw new Error("missing artifact snapshot")
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

  it("returns blocked when run returns void and step stays active", async () => {
    const { linked } = setupSandbox(
      "void-blocked",
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
    expect(result.status).toBe("blocked")

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(row?.status).toBe("active")
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
})
