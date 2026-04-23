import { and, eq } from "drizzle-orm"
import { db, stepTable, taskTable, type DbExecutor } from "../db"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { ErrorCode, RpcError } from "../rpc/base"
import { assertStepTransition } from "./transitions"

export type StepBlockPayload = {
  code: string
  message: string
  details?: unknown
  resumeHint?: string
}

export type BlockStepInput = {
  taskId: string
  stepId: string
  blockPayload: StepBlockPayload
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

export function blockStep(input: BlockStepInput, executor: DbExecutor = db()) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  if (task.status !== "active") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot block task=${input.taskId} step=${input.stepId} from current task state`,
    )
  }

  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
  }

  assertStepTransition(step.status, "blocked", `Cannot block task=${input.taskId} step=${input.stepId} from current state`)

  const now = Date.now()
  const sessionId = input.sessionId ?? step.sessionId ?? undefined
  const updateResult = executor
    .update(stepTable)
    .set({
      status: "blocked",
      sessionId,
      blockPayloadJson: JSON.stringify(input.blockPayload),
    })
    .where(and(eq(stepTable.stepId, input.stepId), eq(stepTable.status, "active")))
    .run()

  if (affectedRowCount(updateResult) === 0) {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot block task=${input.taskId} step=${input.stepId} from current state`,
    )
  }

  writeTaskEvent({
    executor,
    taskId: input.taskId,
    stepId: input.stepId,
    eventType: TaskEventType.STEP_BLOCKED,
    payload: {
      stepId: input.stepId,
      stepIndex: step.stepIndex,
      blockPayload: input.blockPayload,
      sessionId: sessionId ?? null,
    },
    createdAt: now,
  })

  executor
    .update(taskTable)
    .set({ updatedAt: now })
    .where(and(eq(taskTable.taskId, input.taskId), eq(taskTable.status, "active")))
    .run()

  return {
    taskId: input.taskId,
    stepId: input.stepId,
    status: "blocked" as const,
    blockPayload: input.blockPayload,
    ...(sessionId ? { sessionId } : {}),
  }
}
