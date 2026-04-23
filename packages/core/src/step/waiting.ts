import { and, eq } from "drizzle-orm"
import { stepTable, taskTable, type DbExecutor } from "../db"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import type { WaitSpec } from "../workflow/module"
import { summarizeChildSteps } from "./children"

function affectedRowCount(result: unknown): number | null {
  if (typeof result !== "object" || result === null) {
    return null
  }

  if ("changes" in result && typeof result.changes === "number") {
    return result.changes
  }

  if ("rowsAffected" in result && typeof result.rowsAffected === "number") {
    return result.rowsAffected
  }

  return null
}

function isTerminalStatus(status: string): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function isWaitSpec(value: unknown): value is WaitSpec {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as Partial<WaitSpec>
  return (
    candidate.kind === "children" &&
    typeof candidate.childStepKey === "string" &&
    (candidate.workKeys === undefined || Array.isArray(candidate.workKeys)) &&
    (candidate.until === "all_completed" || candidate.until === "all_terminal")
  )
}

function evaluateWaitSpecForParent(input: {
  taskId: string
  parentStepId: string
  waitSpec: WaitSpec
  executor: DbExecutor
}): { satisfied: boolean; snapshot: unknown } {
  switch (input.waitSpec.kind) {
    case "children": {
      const summary = summarizeChildSteps(
        {
          taskId: input.taskId,
          parentStepId: input.parentStepId,
          stepKey: input.waitSpec.childStepKey,
          workKeys: input.waitSpec.workKeys,
        },
        input.executor,
      )

      const satisfied =
        input.waitSpec.until === "all_completed"
          ? summary.totalCount > 0 && summary.completedCount === summary.totalCount
          : summary.pendingCount === 0 &&
            summary.activeCount === 0 &&
            summary.blockedCount === 0 &&
            summary.orphanedCount === 0

      return { satisfied, snapshot: summary }
    }
  }
}

export function enterWaitingIfNeeded(input: {
  taskId: string
  stepId: string
  stepIndex: number
  waitSpec: WaitSpec
  executor: DbExecutor
}): boolean {
  const evaluated = evaluateWaitSpecForParent({
    taskId: input.taskId,
    parentStepId: input.stepId,
    waitSpec: input.waitSpec,
    executor: input.executor,
  })
  if (evaluated.satisfied) {
    return false
  }

  const now = Date.now()
  const updateResult = input.executor
    .update(stepTable)
    .set({
      status: "waiting",
      waitSpecJson: JSON.stringify(input.waitSpec),
      waitSnapshotJson: JSON.stringify(evaluated.snapshot),
    })
    .where(and(eq(stepTable.stepId, input.stepId), eq(stepTable.status, "active")))
    .run()

  if (affectedRowCount(updateResult) === 0) {
    return false
  }

  writeTaskEvent({
    executor: input.executor,
    taskId: input.taskId,
    stepId: input.stepId,
    eventType: TaskEventType.STEP_WAITING,
    payload: {
      stepId: input.stepId,
      stepIndex: input.stepIndex,
      waitSpec: input.waitSpec,
      waitSnapshot: evaluated.snapshot,
    },
    createdAt: now,
  })

  input.executor.update(taskTable).set({ updatedAt: now }).where(eq(taskTable.taskId, input.taskId)).run()
  return true
}

export function wakeWaitingParentIfReady(input: { taskId: string; stepId: string; executor: DbExecutor }) {
  const child = input.executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!child || child.taskId !== input.taskId || child.parentStepId === null || !isTerminalStatus(child.status)) {
    return
  }

  const parent = input.executor.select().from(stepTable).where(eq(stepTable.stepId, child.parentStepId)).get()
  if (!parent || parent.taskId !== input.taskId || parent.status !== "waiting" || !parent.waitSpecJson) {
    return
  }

  let waitSpec: unknown
  try {
    waitSpec = JSON.parse(parent.waitSpecJson)
  } catch {
    return
  }

  if (!isWaitSpec(waitSpec)) {
    return
  }
  if (waitSpec.kind === "children" && waitSpec.childStepKey !== child.stepKey) {
    return
  }
  if (waitSpec.kind === "children" && waitSpec.workKeys && !waitSpec.workKeys.includes(child.workKey ?? "")) {
    return
  }

  const evaluated = evaluateWaitSpecForParent({
    taskId: input.taskId,
    parentStepId: parent.stepId,
    waitSpec,
    executor: input.executor,
  })
  const now = Date.now()

  if (evaluated.satisfied) {
    const updateResult = input.executor
      .update(stepTable)
      .set({
        status: "active",
        waitSpecJson: null,
        waitSnapshotJson: null,
      })
      .where(and(eq(stepTable.stepId, parent.stepId), eq(stepTable.status, "waiting")))
      .run()

    if (affectedRowCount(updateResult) === 0) {
      return
    }

    writeTaskEvent({
      executor: input.executor,
      taskId: input.taskId,
      stepId: parent.stepId,
      eventType: TaskEventType.STEP_READY,
      payload: {
        stepId: parent.stepId,
        stepIndex: parent.stepIndex,
        waitSpec,
      },
      createdAt: now,
    })
    input.executor.update(taskTable).set({ updatedAt: now }).where(eq(taskTable.taskId, input.taskId)).run()
    return
  }

  input.executor
    .update(stepTable)
    .set({ waitSnapshotJson: JSON.stringify(evaluated.snapshot) })
    .where(and(eq(stepTable.stepId, parent.stepId), eq(stepTable.status, "waiting")))
    .run()
}
