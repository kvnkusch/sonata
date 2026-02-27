import { and, desc, eq, inArray } from "drizzle-orm"
import { db } from "../db"
import { stepTable } from "../db/step.sql"
import { taskTable } from "../db/task.sql"
import { getProjectById } from "../project"

type DbExecutor = ReturnType<typeof db>

export type ActiveTaskSummary = {
  taskId: string
  projectId: string
  workflowName: string
  status: "active"
  createdAt: number
  updatedAt: number
  currentStepId?: string
  currentStepIndex?: number
}

export function listActiveTasks(input: { projectId: string }, executor: DbExecutor = db()): ActiveTaskSummary[] {
  const project = getProjectById(input.projectId, executor)
  if (!project) {
    throw new Error(`Project not found: ${input.projectId}`)
  }

  const tasks = executor
    .select()
    .from(taskTable)
    .where(and(eq(taskTable.projectId, project.projectId), eq(taskTable.status, "active")))
    .orderBy(desc(taskTable.createdAt))
    .all()

  if (tasks.length === 0) return []

  const taskIds = tasks.map((task) => task.taskId)
  const activeSteps = executor
    .select()
    .from(stepTable)
    .where(and(inArray(stepTable.taskId, taskIds), eq(stepTable.status, "active")))
    .all()

  const activeStepByTask = new Map(activeSteps.map((step) => [step.taskId, step]))

  return tasks.map((task) => {
    const currentStep = activeStepByTask.get(task.taskId)
    return {
      taskId: task.taskId,
      projectId: task.projectId,
      workflowName: task.workflowName,
      status: "active",
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      currentStepId: currentStep?.stepId,
      currentStepIndex: currentStep?.stepIndex,
    }
  })
}
