import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { and, eq } from "drizzle-orm"
import { closeDb, db, stepTable, taskEventTable, taskTable } from "../db"
import { executeStep } from "../execution"
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
  delete (
    globalThis as {
      __sonata_test_stepResult?: { completed: (input?: { completionPayload?: unknown }) => unknown }
      __sonata_test_beforeComplete?: (stepId: string) => void
    }
  ).__sonata_test_stepResult
  delete (
    globalThis as {
      __sonata_test_stepResult?: { completed: (input?: { completionPayload?: unknown }) => unknown }
      __sonata_test_beforeComplete?: (stepId: string) => void
    }
  ).__sonata_test_beforeComplete
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function writeOpsWorkflowFiles(opsRoot: string) {
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

describe("step.complete integration", () => {
  it("rejects when required artifacts are missing", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-step-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_missing" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const initial = await startStep({ taskId: started.taskId, stepKey: "plan" })

    await expect(
      completeStep({
        taskId: started.taskId,
        stepId: initial.stepId,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.REQUIRED_ARTIFACT_MISSING,
    })

    const rejectionEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "step.completion.rejected"))
      .all()
    expect(rejectionEvents).toHaveLength(1)
    expect(rejectionEvents[0]?.eventVersion).toBe(1)
    expect(JSON.parse(rejectionEvents[0]?.eventPayloadJson ?? "{}")).toEqual({
      stepId: initial.stepId,
      reason: "missing_required_artifacts",
      code: ErrorCode.REQUIRED_ARTIFACT_MISSING,
      message: `Cannot complete step ${initial.stepId}; missing required artifacts: plan_summary`,
      details: { missingArtifacts: ["plan_summary"] },
    })
  })

  it("rejects canComplete when ctx.completeStep is called", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-step-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
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
      canComplete() {
        return { ok: false, code: "review_required", message: "Review is required", details: { lane: "review" } }
      },
      async run(ctx) {
        await ctx.completeStep({ ok: true })
      },
      async on() {},
    },
  ],
}
`,
    )
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_guard_ctx" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const result = await executeStep({ taskId: started.taskId, stepId: step.stepId })
    expect(result).toMatchObject({ status: "active", suggestedNextStepKey: null })

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(row?.status).toBe("active")

    const rejectionEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "step.completion.rejected"))
      .all()
    expect(rejectionEvents).toHaveLength(1)
    expect(JSON.parse(rejectionEvents[0]?.eventPayloadJson ?? "{}")).toEqual({
      stepId: step.stepId,
      reason: "can_complete_rejected",
      code: ErrorCode.STEP_COMPLETION_GUARD_REJECTED,
      message: "Review is required",
      details: {
        guardCode: "review_required",
        guardMessage: "Review is required",
        guardDetails: { lane: "review" },
      },
    })
  })

  it("rejects canComplete when run returns completed", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-step-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    ;(globalThis as {
      __sonata_test_stepResult?: { completed: (input?: { completionPayload?: unknown }) => unknown }
    }).__sonata_test_stepResult = {
      completed(input) {
        return { status: "completed", completionPayload: input?.completionPayload }
      },
    }
    writeOpsWorkflowFilesFromSource(
      opsRoot,
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
        return { ok: false, code: "approval_missing", message: "Approval missing", details: { approver: null } }
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
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_guard_return" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const result = await executeStep({ taskId: started.taskId, stepId: step.stepId })
    expect(result).toMatchObject({ status: "active", suggestedNextStepKey: null })

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(row?.status).toBe("active")

    const rejectionEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "step.completion.rejected"))
      .all()
    expect(rejectionEvents).toHaveLength(1)
    expect(JSON.parse(rejectionEvents[0]?.eventPayloadJson ?? "{}")).toMatchObject({
      stepId: step.stepId,
      reason: "can_complete_rejected",
      code: ErrorCode.STEP_COMPLETION_GUARD_REJECTED,
      message: "Approval missing",
      details: {
        guardCode: "approval_missing",
        guardMessage: "Approval missing",
        guardDetails: { approver: null },
      },
    })
  })

  it("rejects required artifacts when run returns completed", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-step-run-missing-artifacts-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    ;(globalThis as {
      __sonata_test_stepResult?: { completed: (input?: { completionPayload?: unknown }) => unknown }
    }).__sonata_test_stepResult = {
      completed(input) {
        return { status: "completed", completionPayload: input?.completionPayload }
      },
    }
    writeOpsWorkflowFilesFromSource(
      opsRoot,
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
      artifacts: [{ name: "plan_summary", kind: "markdown", required: true, once: true }],
      async run() {
        return stepResult.completed({ completionPayload: { ok: true } })
      },
      async on() {},
    },
  ],
}
`,
    )
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_missing_run_result" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const result = await executeStep({ taskId: started.taskId, stepId: step.stepId })
    expect(result).toMatchObject({ status: "active", suggestedNextStepKey: null })

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(row?.status).toBe("active")

    const rejectionEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "step.completion.rejected"))
      .all()
    expect(rejectionEvents).toHaveLength(1)
    expect(JSON.parse(rejectionEvents[0]?.eventPayloadJson ?? "{}")).toEqual({
      stepId: step.stepId,
      reason: "missing_required_artifacts",
      code: ErrorCode.REQUIRED_ARTIFACT_MISSING,
      message: `Cannot complete step ${step.stepId}; missing required artifacts: plan_summary`,
      details: { missingArtifacts: ["plan_summary"] },
    })
  })

  it("does not emit step.completed when guarded completion loses the active-state race", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-step-race-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
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
      canComplete(ctx) {
        globalThis.__sonata_test_beforeComplete?.(ctx.stepId)
        return { ok: true }
      },
      async run() {},
      async on() {},
    },
  ],
}
`,
    )
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_race" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    ;(globalThis as { __sonata_test_beforeComplete?: (stepId: string) => void }).__sonata_test_beforeComplete = (
      stepId,
    ) => {
      db().update(stepTable).set({ status: "failed" }).where(eq(stepTable.stepId, stepId)).run()
    }

    await expect(
      completeStep({
        taskId: started.taskId,
        stepId: step.stepId,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_STEP_TRANSITION,
    })

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(row?.status).toBe("failed")

    const completedEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "step.completed"))
      .all()
    expect(completedEvents).toHaveLength(0)
  })

  it("emits the effective session id on step.completed", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-step-session-event-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
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
      async run() {},
      async on() {},
    },
  ],
}
`,
    )
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_session_event" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })
    db().update(stepTable).set({ sessionId: "ses_existing" }).where(eq(stepTable.stepId, step.stepId)).run()

    const result = await completeStep({ taskId: started.taskId, stepId: step.stepId })
    expect(result.status).toBe("completed")

    const completedEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "step.completed"))
      .all()
    expect(completedEvents).toHaveLength(1)
    expect(JSON.parse(completedEvents[0]?.eventPayloadJson ?? "{}")).toMatchObject({
      stepId: step.stepId,
      sessionId: "ses_existing",
    })
  })

  it("wakes a waiting parent when a child completes via step.complete", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-step-wakes-parent-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFilesFromSource(
      opsRoot,
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
      async run() {},
      async on() {},
    },
  ],
}
`,
    )
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_wakes_parent" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const controller = await startStep({ taskId: started.taskId, stepKey: "controller" })

    const controllerResult = await executeStep({ taskId: started.taskId, stepId: controller.stepId })
    expect(controllerResult.status).toBe("waiting")

    const child = db().select().from(stepTable).where(eq(stepTable.parentStepId, controller.stepId)).get()
    const childComplete = await completeStep({ taskId: started.taskId, stepId: child!.stepId })
    expect(childComplete.status).toBe("completed")

    const parentRow = db().select().from(stepTable).where(eq(stepTable.stepId, controller.stepId)).get()
    expect(parentRow?.status).toBe("active")
    expect(parentRow?.waitSpecJson).toBeNull()
    expect(parentRow?.waitSnapshotJson).toBeNull()
  })

  it("completes current step and requires explicit start for the next step", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-step-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_success" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const initial = await startStep({ taskId: started.taskId, stepKey: "plan" })

    await writeStepArtifact({
      taskId: started.taskId,
      stepId: initial.stepId,
      artifactName: "plan_summary",
      artifactKind: "markdown",
      payload: { markdown: "done" },
    })

    const firstComplete = await completeStep({
      taskId: started.taskId,
      stepId: initial.stepId,
      completionPayload: { ok: true },
    })

    expect(firstComplete.status).toBe("completed")
    expect(firstComplete.suggestedNextStepKey).toBe("execute")

    const autoStartedStep = db()
      .select()
      .from(stepTable)
      .where(and(eq(stepTable.taskId, started.taskId), eq(stepTable.status, "active")))
      .get()
    expect(autoStartedStep).toBeUndefined()

    const startedExecute = await startStep({
      taskId: started.taskId,
      stepKey: "execute",
    })

    expect(startedExecute.stepIndex).toBe(2)
    expect(startedExecute.status).toBe("active")

    const finalComplete = await completeStep({
      taskId: started.taskId,
      stepId: startedExecute.stepId,
      completionPayload: { done: true },
    })

    expect(finalComplete.status).toBe("completed")
    expect(finalComplete.suggestedNextStepKey).toBeNull()

    const task = db().select().from(taskTable).where(eq(taskTable.taskId, started.taskId)).get()
    expect(task?.status).toBe("active")

    const completedStepEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "step.completed"))
      .all()
    const taskCompletedEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "task.completed"))
      .all()

    expect(completedStepEvents.length).toBe(2)
    expect(taskCompletedEvents.length).toBe(0)
  })
})
