import { taskEventTable, type DbExecutor, db } from "../db"
import { newEventId } from "../id"

export const TaskEventType = {
  TASK_STARTED: "task.started",
  STEP_STARTED: "step.started",
  ARTIFACT_WRITTEN: "artifact.written",
  STEP_COMPLETION_REJECTED: "step.completion.rejected",
  STEP_COMPLETED: "step.completed",
  TASK_COMPLETED: "task.completed",
  TASK_FAILED: "task.failed",
} as const

export type TaskEventType = (typeof TaskEventType)[keyof typeof TaskEventType]

export function writeTaskEvent(input: {
  taskId: string
  stepId?: string
  eventType: TaskEventType
  payload: unknown
  eventVersion?: number
  createdAt?: number
  executor?: DbExecutor
}) {
  const createdAt = input.createdAt ?? Date.now()
  const eventId = newEventId()
  const executor = input.executor ?? db()
  const eventVersion = input.eventVersion ?? 1

  executor
    .insert(taskEventTable)
    .values({
      eventId,
      taskId: input.taskId,
      stepId: input.stepId,
      eventType: input.eventType,
      eventVersion,
      eventPayloadJson: JSON.stringify(input.payload ?? {}),
      createdAt,
    })
    .run()

  return eventId
}
