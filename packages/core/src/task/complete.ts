import { and, eq } from "drizzle-orm"
import { db, stepTable, taskTable, type DbExecutor } from "../db"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { ErrorCode, RpcError } from "../rpc/base"

export type CompleteTaskInput = {
  taskId: string
  completionPayload?: unknown
}

export function completeTask(input: CompleteTaskInput, executor: DbExecutor = db()) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }
  if (task.status !== "active") {
    throw new RpcError(ErrorCode.INVALID_STEP_TRANSITION, 409, `Cannot complete task=${input.taskId} from current state`)
  }

  const activeStep = executor
    .select({ stepId: stepTable.stepId })
    .from(stepTable)
    .where(and(eq(stepTable.taskId, input.taskId), eq(stepTable.status, "active")))
    .get()
  if (activeStep) {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot complete task=${input.taskId} while step=${activeStep.stepId} is active`,
    )
  }

  const now = Date.now()
  executor
    .update(taskTable)
    .set({
      status: "completed",
      updatedAt: now,
    })
    .where(and(eq(taskTable.taskId, input.taskId), eq(taskTable.status, "active")))
    .run()

  writeTaskEvent({
    executor,
    taskId: input.taskId,
    eventType: TaskEventType.TASK_COMPLETED,
    payload: {
      taskId: input.taskId,
      completionPayload: input.completionPayload ?? null,
    },
    createdAt: now,
  })

  return {
    taskId: input.taskId,
    status: "completed" as const,
  }
}
