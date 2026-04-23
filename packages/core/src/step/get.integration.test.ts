import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { closeDb, db, stepTable } from "../db"
import { linkOpsRepo } from "../project"
import { ErrorCode } from "../rpc/base"
import { startTask } from "../task"
import { getStep } from "./get"
import { startStep } from "./start"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function writeWorkflowFiles(opsRoot: string) {
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

describe("step.get integration", () => {
  it("returns waiting-state detail fields", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-step-get-waiting-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_step_get" }, tx))
    const task = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })

    db()
      .update(stepTable)
      .set({
        status: "waiting",
        waitSpecJson: JSON.stringify({ kind: "children", childStepKey: "plan", until: "all_completed" }),
        waitSnapshotJson: JSON.stringify({ completed: 1, total: 3 }),
      })
      .where(eq(stepTable.stepId, step.stepId))
      .run()

    expect(getStep({ taskId: task.taskId, stepId: step.stepId })).toEqual({
      stepId: step.stepId,
      stepKey: "plan",
      stepIndex: step.stepIndex,
      status: "waiting",
      parentStepId: null,
      workKey: null,
      sessionId: null,
      opencodeBaseUrl: null,
      waitSpec: { kind: "children", childStepKey: "plan", until: "all_completed" },
      waitSnapshot: { completed: 1, total: 3 },
      blockPayload: null,
      orphanedReason: null,
    })
  })

  it("returns orphaned-state detail fields", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-step-get-orphaned-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_step_get_orphaned" }, tx))
    const task = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const step = await startStep({ taskId: task.taskId, stepKey: "plan" })

    db()
      .update(stepTable)
      .set({
        status: "orphaned",
        sessionId: "ses_123",
        blockPayloadJson: JSON.stringify({ reason: "awaiting-operator", detail: { ticket: 42 } }),
        orphanedReasonJson: JSON.stringify({ code: "missing_session", message: "Session not found" }),
      })
      .where(eq(stepTable.stepId, step.stepId))
      .run()

    expect(getStep({ taskId: task.taskId, stepId: step.stepId })).toEqual({
      stepId: step.stepId,
      stepKey: "plan",
      stepIndex: step.stepIndex,
      status: "orphaned",
      parentStepId: null,
      workKey: null,
      sessionId: "ses_123",
      opencodeBaseUrl: null,
      waitSpec: null,
      waitSnapshot: null,
      blockPayload: { reason: "awaiting-operator", detail: { ticket: 42 } },
      orphanedReason: { code: "missing_session", message: "Session not found" },
    })
  })

  it("rejects lookup when the step is not part of the task", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-step-get-missing-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_step_get_missing" }, tx))
    const taskA = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const taskB = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const step = await startStep({ taskId: taskA.taskId, stepKey: "plan" })

    try {
      getStep({ taskId: taskB.taskId, stepId: step.stepId })
      throw new Error("Expected step.get to throw")
    } catch (error) {
      expect(error).toMatchObject({
        code: ErrorCode.STEP_NOT_FOUND,
        status: 404,
      })
    }
  })
})
