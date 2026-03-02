import { eq } from "drizzle-orm"
import { db, type DbExecutor } from "../db"
import { taskTable } from "../db/task.sql"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { newTaskId } from "../id"
import { getProjectById } from "../project"
import { ErrorCode, RpcError } from "../rpc/base"
import { readOpsConfig } from "../workflow/config"
import { primeWorkflowForTaskStart } from "../workflow/loader"

export type StartTaskInput = {
  taskId?: string
  projectId: string
  workflowRef?: {
    name: string
  }
}

export type StartedTask = {
  taskId: string
  projectId: string
  workflowName: string
  status: "active"
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
  const workflowName =
    input.workflowRef?.name ?? (await readOpsConfig(project.opsRootRealpath)).config.defaultWorkflowId

  const existingTask = executor.select().from(taskTable).where(eq(taskTable.taskId, taskId)).get()
  if (existingTask) {
    if (existingTask.projectId !== input.projectId || existingTask.workflowName !== workflowName) {
      throw new RpcError(
        ErrorCode.INVALID_INPUT,
        409,
        `Task id already exists with different parameters: ${taskId}`,
      )
    }
    if (existingTask.status !== "active") {
      throw new RpcError(ErrorCode.INVALID_STEP_TRANSITION, 409, `Task already exists and is not active: ${taskId}`)
    }
    return {
      taskId,
      projectId: existingTask.projectId,
      workflowName: existingTask.workflowName,
      status: "active",
    }
  }

  const workflow = await primeWorkflowForTaskStart({
    taskId,
    workflowName,
    opsRootRealpath: project.opsRootRealpath,
  })
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

  writeTaskEvent({
    executor,
    taskId,
    eventType: TaskEventType.TASK_STARTED,
    payload: {
      taskId,
      projectId: project.projectId,
      workflowId: workflow.workflow.id,
    },
    createdAt: now,
  })

  return {
    taskId,
    projectId: project.projectId,
    workflowName: workflow.workflow.id,
    status: "active",
  }
}
