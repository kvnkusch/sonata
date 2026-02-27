import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { and, eq } from "drizzle-orm"
import { closeDb, db, stepTable, taskEventTable } from "../db"
import { linkOpsRepo } from "../project"
import { ErrorCode } from "../rpc/base"
import { startTask } from "../task"
import { completeStep } from "./complete"
import { startStep } from "./start"
import { writeStepArtifact } from "./write-artifact"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

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
      artifacts: [{ name: "plan_summary", kind: "markdown", required: true, once: true }],
      next: "execute",
      async run() {},
      async on() {},
    },
    {
      id: "execute",
      title: "Execute",
      artifacts: [],
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

function writeOpsWorkflowFilesWithInputs(opsRoot: string) {
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
              const strictness = input && typeof input === "object" ? input.strictness : undefined
              if (strictness === undefined) {
                return { strictness: "medium" }
              }
              if (strictness !== "low" && strictness !== "medium" && strictness !== "high") {
                throw new Error("invalid strictness")
              }
              return { strictness }
            },
          },
        },
      },
      artifacts: [],
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

describe("step.start integration", () => {
  it("starts a selected step only when task has no active step", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-start-step-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_start_step" }, tx)
    })

    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })

    await expect(
      startStep({
        taskId: started.taskId,
        stepKey: "execute",
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_STEP_TRANSITION,
    })

    await writeStepArtifact({
      taskId: started.taskId,
      stepId: started.currentStepId,
      artifactName: "plan_summary",
      artifactKind: "markdown",
      payload: { markdown: "done" },
    })
    await completeStep({ taskId: started.taskId, stepId: started.currentStepId })

    const selected = await startStep({
      taskId: started.taskId,
      stepKey: "execute",
    })

    expect(selected.stepKey).toBe("execute")
    expect(selected.stepIndex).toBe(2)

    const activeStep = db()
      .select()
      .from(stepTable)
      .where(and(eq(stepTable.taskId, started.taskId), eq(stepTable.status, "active")))
      .get()
    expect(activeStep?.stepId).toBe(selected.stepId)

    const startedEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "step.started"))
      .all()
    expect(startedEvents.length).toBe(2)
  })

  it("resolves and freezes artifact + invocation inputs at step start", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-start-step-inputs-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFilesWithInputs(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_start_step_inputs" }, tx)
    })

    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })

    await writeStepArtifact({
      taskId: started.taskId,
      stepId: started.currentStepId,
      artifactName: "topic",
      artifactKind: "markdown",
      payload: { markdown: "topic v1" },
    })
    await completeStep({ taskId: started.taskId, stepId: started.currentStepId })

    const intakeReplay = await startStep({ taskId: started.taskId, stepKey: "intake" })
    await writeStepArtifact({
      taskId: started.taskId,
      stepId: intakeReplay.stepId,
      artifactName: "topic",
      artifactKind: "markdown",
      payload: { markdown: "topic v2" },
    })
    await completeStep({ taskId: started.taskId, stepId: intakeReplay.stepId })

    const planStart = await startStep({
      taskId: started.taskId,
      stepKey: "plan",
      invocation: {},
      artifactSelections: {
        topic: { mode: "latest" },
      },
    })

    expect(planStart.resolvedInputs.invocation).toEqual({ strictness: "medium" })
    expect(planStart.resolvedInputs.artifacts.topic!.refs).toHaveLength(1)
    expect(planStart.resolvedInputs.artifacts.topic!.refs[0]?.relativePath).toContain("002-intake-topic.md")

    await completeStep({ taskId: started.taskId, stepId: planStart.stepId })

    const planStartReplay = await startStep({
      taskId: started.taskId,
      stepKey: "plan",
      invocation: { strictness: "high" },
      artifactSelections: {
        topic: { mode: "indices", indices: [1] },
      },
    })
    expect(planStartReplay.resolvedInputs.invocation).toEqual({ strictness: "high" })
    expect(planStartReplay.resolvedInputs.artifacts.topic!.refs[0]?.relativePath).toContain("001-intake-topic.md")
  })
})
