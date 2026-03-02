import { and, eq } from "drizzle-orm"
import { db, stepTable, taskTable, type DbExecutor } from "../db"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { ErrorCode, RpcError } from "../rpc/base"
import { assertStepTransition } from "./transitions"

export type FailStepInput = {
  taskId: string
  stepId: string
  reason?: string
  sessionId?: string
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

  const now = Date.now()
  executor
    .update(stepTable)
    .set({
      status: "failed",
      completedAt: now,
      sessionId: input.sessionId ?? step.sessionId,
      completionPayloadJson: input.reason ? JSON.stringify({ reason: input.reason }) : step.completionPayloadJson,
    })
    .where(and(eq(stepTable.stepId, input.stepId), eq(stepTable.status, "active")))
    .run()

  writeTaskEvent({
    executor,
    taskId: input.taskId,
    stepId: input.stepId,
    eventType: TaskEventType.STEP_FAILED,
    payload: {
      stepId: input.stepId,
      stepIndex: step.stepIndex,
      reason: input.reason ?? null,
      sessionId: input.sessionId,
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

  return {
    taskId: input.taskId,
    stepId: input.stepId,
    status: "failed" as const,
  }
}
