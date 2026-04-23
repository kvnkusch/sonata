import { and, eq, inArray } from "drizzle-orm"
import { db, stepTable, taskTable, type DbExecutor } from "../db"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { ErrorCode, RpcError } from "../rpc/base"
import { assertStepTransition, openStepStatuses } from "./transitions"
import { wakeWaitingParentIfReady } from "./waiting"

export type FailStepInput = {
  taskId: string
  stepId: string
  reason?: string
  sessionId?: string
}

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

export function failStep(input: FailStepInput, executor: DbExecutor = db()) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }
  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
  }

  assertStepTransition(step.status, "failed", `Cannot fail task=${input.taskId} step=${input.stepId} from current state`)

  if (step.parentStepId === null) {
    const openChild = executor
      .select()
      .from(stepTable)
      .where(
        and(
          eq(stepTable.taskId, input.taskId),
          eq(stepTable.parentStepId, input.stepId),
          inArray(stepTable.status, openStepStatuses),
        ),
      )
      .get()

    if (openChild) {
      throw new RpcError(
        ErrorCode.INVALID_STEP_TRANSITION,
        409,
        `Cannot fail root step ${input.stepId} while child steps are still open`,
      )
    }
  }

  const now = Date.now()
  const effectiveSessionId = input.sessionId ?? step.sessionId ?? undefined
  const updateResult = executor
    .update(stepTable)
    .set({
      status: "failed",
      completedAt: now,
      sessionId: effectiveSessionId,
      completionPayloadJson: input.reason ? JSON.stringify({ reason: input.reason }) : step.completionPayloadJson,
      waitSpecJson: null,
      waitSnapshotJson: null,
    })
    .where(and(eq(stepTable.stepId, input.stepId), eq(stepTable.status, step.status)))
    .run()

  if (affectedRowCount(updateResult) === 0) {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot fail task=${input.taskId} step=${input.stepId} from current state`,
    )
  }

  writeTaskEvent({
    executor,
    taskId: input.taskId,
    stepId: input.stepId,
    eventType: TaskEventType.STEP_FAILED,
    payload: {
      stepId: input.stepId,
      stepIndex: step.stepIndex,
      reason: input.reason ?? null,
      sessionId: effectiveSessionId,
    },
    createdAt: now,
  })

  executor
    .update(taskTable)
    .set({
      updatedAt: now,
    })
    .where(and(eq(taskTable.taskId, input.taskId), eq(taskTable.status, "active")))
    .run()

  wakeWaitingParentIfReady({ taskId: input.taskId, stepId: input.stepId, executor })

  return {
    taskId: input.taskId,
    stepId: input.stepId,
    status: "failed" as const,
  }
}
