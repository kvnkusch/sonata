import { and, desc, eq } from "drizzle-orm"
import { db, stepTable, taskTable, type DbExecutor } from "../db"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { newStepId } from "../id"
import { ErrorCode, RpcError } from "../rpc/base"
import { loadWorkflowForTask } from "../workflow/loader"
import { resolveStepInputs, type ArtifactSelectionOverride } from "./inputs"

export type StartStepInput = {
  taskId: string
  stepKey: string
  invocation?: unknown
  artifactSelections?: Record<string, ArtifactSelectionOverride>
}

export async function startStep(input: StartStepInput, executor: DbExecutor = db()) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  if (task.status !== "active") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot start step for task=${input.taskId} from current task state`,
    )
  }

  const activeStep = executor
    .select()
    .from(stepTable)
    .where(and(eq(stepTable.taskId, input.taskId), eq(stepTable.status, "active")))
    .get()

  if (activeStep) {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Task already has an active step: ${activeStep.stepId}`,
    )
  }

  const loaded = await loadWorkflowForTask(input.taskId, executor)
  const workflowStep = loaded.workflow.steps.find((step) => step.id === input.stepKey)
  if (!workflowStep) {
    throw new RpcError(
      ErrorCode.STEP_NOT_FOUND,
      404,
      `Step key not found in workflow ${loaded.workflow.id}: ${input.stepKey}`,
    )
  }

  const lastStep = executor
    .select({ stepIndex: stepTable.stepIndex })
    .from(stepTable)
    .where(eq(stepTable.taskId, input.taskId))
    .orderBy(desc(stepTable.stepIndex))
    .limit(1)
    .get()

  const nextStepIndex = (lastStep?.stepIndex ?? 0) + 1
  const now = Date.now()
  const stepId = newStepId()
  const resolvedInputs = await resolveStepInputs({
    taskId: input.taskId,
    stepInputs: workflowStep.inputs,
    invocation: input.invocation,
    artifactSelections: input.artifactSelections,
    executor,
  })

  executor
    .insert(stepTable)
    .values({
      stepId,
      taskId: input.taskId,
      stepKey: workflowStep.id,
      stepIndex: nextStepIndex,
      status: "active",
      inputs: JSON.stringify(resolvedInputs),
      startedAt: now,
    })
    .run()

  executor
    .update(taskTable)
    .set({ updatedAt: now })
    .where(and(eq(taskTable.taskId, input.taskId), eq(taskTable.status, "active")))
    .run()

  writeTaskEvent({
    executor,
    taskId: input.taskId,
    stepId,
    eventType: TaskEventType.STEP_STARTED,
    payload: {
      stepId,
      stepKey: workflowStep.id,
      stepIndex: nextStepIndex,
      inputs: resolvedInputs,
    },
    createdAt: now,
  })

  return {
    taskId: input.taskId,
    stepId,
    stepKey: workflowStep.id,
    stepIndex: nextStepIndex,
    status: "active" as const,
    resolvedInputs,
  }
}
