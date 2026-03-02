import { eq } from "drizzle-orm"
import { db, stepTable, taskTable, type DbExecutor } from "../db"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { ErrorCode, RpcError } from "../rpc/base"
import { assertStepTransition } from "./transitions"

export type CancelStepInput = {
  taskId: string
  stepId: string
}

export function cancelStep(input: CancelStepInput, executor: DbExecutor = db()) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }
  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
  }

  assertStepTransition(
    step.status,
    "cancelled",
    `Cannot cancel task=${input.taskId} step=${input.stepId} from current state`,
  )

  const now = Date.now()
  executor
    .update(stepTable)
    .set({
      status: "cancelled",
      completedAt: now,
    })
    .where(eq(stepTable.stepId, input.stepId))
    .run()

  executor.update(taskTable).set({ updatedAt: now }).where(eq(taskTable.taskId, input.taskId)).run()

  writeTaskEvent({
    executor,
    taskId: input.taskId,
    stepId: input.stepId,
    eventType: TaskEventType.STEP_CANCELLED,
    payload: {
      stepId: input.stepId,
      stepIndex: step.stepIndex,
    },
    createdAt: now,
  })

  return {
    taskId: input.taskId,
    stepId: input.stepId,
    status: "cancelled" as const,
  }
}
