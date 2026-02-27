import { and, eq } from "drizzle-orm"
import { db, type DbExecutor } from "../db"
import { stepTable } from "../db/step.sql"
import { taskTable } from "../db/task.sql"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { newStepId, newTaskId } from "../id"
import { getProjectById } from "../project"
import { ErrorCode, RpcError } from "../rpc/base"
import { primeWorkflowForTaskStart } from "../workflow/loader"

export type StartTaskInput = {
  taskId?: string
  projectId: string
  workflowRef: {
    name: string
  }
}

export type StartedTask = {
  taskId: string
  projectId: string
  workflowName: string
  status: "active"
  currentStepId: string
  currentStepIndex: number
}

export async function startTask(
  input: StartTaskInput,
  executor: DbExecutor = db(),
): Promise<StartedTask> {
  const project = getProjectById(input.projectId, executor)
  if (!project) {
    throw new Error(`Project not found: ${input.projectId}`)
  }

  const taskId = input.taskId ?? newTaskId()

  const existingTask = executor.select().from(taskTable).where(eq(taskTable.taskId, taskId)).get()
  if (existingTask) {
    if (existingTask.projectId !== input.projectId || existingTask.workflowName !== input.workflowRef.name) {
      throw new RpcError(
        ErrorCode.INVALID_INPUT,
        409,
        `Task id already exists with different parameters: ${taskId}`,
      )
    }
    if (existingTask.status !== "active") {
      throw new RpcError(ErrorCode.INVALID_STEP_TRANSITION, 409, `Task already exists and is not active: ${taskId}`)
    }
    const activeStep = executor
      .select()
      .from(stepTable)
      .where(and(eq(stepTable.taskId, taskId), eq(stepTable.status, "active")))
      .get()
    if (!activeStep) {
      throw new RpcError(
        ErrorCode.INVALID_STEP_TRANSITION,
        409,
        `Task is active without an active step: ${taskId}`,
      )
    }
    return {
      taskId,
      projectId: existingTask.projectId,
      workflowName: existingTask.workflowName,
      status: "active",
      currentStepId: activeStep.stepId,
      currentStepIndex: activeStep.stepIndex,
    }
  }

  const workflow = await primeWorkflowForTaskStart({
    taskId,
    workflowName: input.workflowRef.name,
    opsRootRealpath: project.opsRootRealpath,
  })

  const firstStep = workflow.workflow.steps[0]
  if (!firstStep) {
    throw new Error(`Workflow ${workflow.workflow.id} has no steps`)
  }

  const stepId = newStepId()
  const now = Date.now()

  executor
    .insert(taskTable)
    .values({
      taskId,
      projectId: project.projectId,
      workflowName: workflow.workflow.id,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run()

  executor
    .insert(stepTable)
    .values({
      stepId,
      taskId,
      stepKey: firstStep.id,
      stepIndex: 1,
      status: "active",
      startedAt: now,
    })
    .run()

  writeTaskEvent({
    executor,
    taskId,
    stepId,
    eventType: TaskEventType.TASK_STARTED,
    payload: {
      taskId,
      projectId: project.projectId,
      workflowId: workflow.workflow.id,
    },
    createdAt: now,
  })

  writeTaskEvent({
    executor,
    taskId,
    stepId,
    eventType: TaskEventType.STEP_STARTED,
    payload: {
      stepId,
      stepKey: firstStep.id,
      stepIndex: 1,
    },
    createdAt: now,
  })

  return {
    taskId,
    projectId: project.projectId,
    workflowName: workflow.workflow.id,
    status: "active",
    currentStepId: stepId,
    currentStepIndex: 1,
  }
}
