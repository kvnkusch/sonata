import { and, eq } from "drizzle-orm"
import { artifactTable, db, stepTable, taskTable, type DbExecutor } from "../db"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { ErrorCode, RpcError } from "../rpc/base"
import { loadWorkflowStepForTask } from "../workflow/loader"
import { assertStepTransition } from "./transitions"
import { missingRequiredArtifacts } from "./validation"

export type CompleteStepInput = {
  taskId: string
  stepId: string
  completionPayload?: unknown
  sessionId?: string
}

export async function completeStep(input: CompleteStepInput, executor: DbExecutor = db()) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
  }

  if (task.status !== "active") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot complete task=${input.taskId} step=${input.stepId} from current state`,
    )
  }

  assertStepTransition(
    step.status,
    "completed",
    `Cannot complete task=${input.taskId} step=${input.stepId} from current state`,
  )

  const { step: workflowStep } = await loadWorkflowStepForTask({
    taskId: input.taskId,
    stepKey: step.stepKey,
    tx: executor,
  })

  const writtenArtifacts = executor
    .select({ artifactName: artifactTable.artifactName })
    .from(artifactTable)
    .where(and(eq(artifactTable.taskId, input.taskId), eq(artifactTable.stepId, input.stepId)))
    .all()

  const missingArtifacts = missingRequiredArtifacts({
    artifacts: workflowStep.artifacts,
    writtenArtifactNames: new Set(writtenArtifacts.map((artifact) => artifact.artifactName)),
  })

  if (missingArtifacts.length > 0) {
    writeTaskEvent({
      executor,
      taskId: input.taskId,
      stepId: input.stepId,
      eventType: TaskEventType.STEP_COMPLETION_REJECTED,
      payload: {
        stepId: input.stepId,
        reason: "missing_required_artifacts",
        missingArtifacts,
      },
    })

    throw new RpcError(
      ErrorCode.REQUIRED_ARTIFACT_MISSING,
      409,
      `Cannot complete step ${input.stepId}; missing required artifacts: ${missingArtifacts.join(", ")}`,
    )
  }

  const now = Date.now()

  executor
    .update(stepTable)
    .set({
      status: "completed",
      completedAt: now,
      completionPayloadJson:
        typeof input.completionPayload === "undefined"
          ? null
          : JSON.stringify(input.completionPayload),
      sessionId: input.sessionId ?? step.sessionId,
    })
    .where(and(eq(stepTable.stepId, step.stepId), eq(stepTable.status, "active")))
    .run()

  writeTaskEvent({
    executor,
    taskId: input.taskId,
    stepId: input.stepId,
    eventType: TaskEventType.STEP_COMPLETED,
    payload: {
      stepId: input.stepId,
      stepIndex: step.stepIndex,
      sessionId: input.sessionId,
      recommendedNextStepKey: workflowStep.next ?? null,
    },
    createdAt: now,
  })
  executor.update(taskTable).set({ updatedAt: now }).where(eq(taskTable.taskId, input.taskId)).run()

  return {
    taskId: input.taskId,
    stepId: input.stepId,
    status: "completed" as const,
    suggestedNextStepKey: workflowStep.next ?? null,
  }
}
