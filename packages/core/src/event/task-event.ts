import { taskEventTable, type DbExecutor, db } from "../db"
import { newEventId } from "../id"
import { ErrorCode } from "../rpc/base"
import type { JsonValue } from "../workflow/module"

export const TaskEventType = {
  TASK_STARTED: "task.started",
  STEP_STARTED: "step.started",
  ARTIFACT_WRITTEN: "artifact.written",
  STEP_WAITING: "step.waiting",
  STEP_READY: "step.ready",
  STEP_BLOCKED: "step.blocked",
  STEP_RESUMED: "step.resumed",
  STEP_ORPHANED: "step.orphaned",
  STEP_COMPLETION_REJECTED: "step.completion.rejected",
  STEP_COMPLETED: "step.completed",
  STEP_FAILED: "step.failed",
  STEP_CANCELLED: "step.cancelled",
  TASK_COMPLETED: "task.completed",
  TASK_FAILED: "task.failed",
} as const

export type TaskEventType = (typeof TaskEventType)[keyof typeof TaskEventType]

export type StepCompletionRejectedPayload = {
  stepId: string
  reason: "missing_required_artifacts" | "can_complete_rejected"
  code: typeof ErrorCode.REQUIRED_ARTIFACT_MISSING | typeof ErrorCode.STEP_COMPLETION_GUARD_REJECTED
  message: string
  details:
    | { missingArtifacts: string[] }
    | {
        guardCode: string
        guardMessage: string
        guardDetails?: JsonValue
      }
}

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
