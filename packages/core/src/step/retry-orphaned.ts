import { and, eq } from "drizzle-orm"
import { db, stepTable, taskTable, type DbExecutor } from "../db"
import { ErrorCode, RpcError } from "../rpc/base"

export type RetryOrphanedStepInput = {
  taskId: string
  stepId: string
}

export type RetryOrphanedStepResult = {
  taskId: string
  stepId: string
  status: "active"
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

export function retryOrphanedStepInNewSession(
  input: RetryOrphanedStepInput,
  executor: DbExecutor = db(),
): RetryOrphanedStepResult {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  if (task.status !== "active") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot retry orphaned task=${input.taskId} step=${input.stepId} from current task state`,
    )
  }

  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
  }

  if (step.status !== "orphaned") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot retry orphaned task=${input.taskId} step=${input.stepId} from current state`,
    )
  }

  const now = Date.now()
  const updateResult = executor
    .update(stepTable)
    .set({
      status: "active",
      sessionId: null,
      opencodeBaseUrl: null,
      orphanedReasonJson: null,
    })
    .where(and(eq(stepTable.stepId, input.stepId), eq(stepTable.status, "orphaned")))
    .run()

  if (affectedRowCount(updateResult) === 0) {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot retry orphaned task=${input.taskId} step=${input.stepId} from current state`,
    )
  }

  executor
    .update(taskTable)
    .set({ updatedAt: now })
    .where(and(eq(taskTable.taskId, input.taskId), eq(taskTable.status, "active")))
    .run()

  return {
    taskId: input.taskId,
    stepId: input.stepId,
    status: "active",
  }
}
