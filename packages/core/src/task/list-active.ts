import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { db } from "../db"
import { stepTable } from "../db/step.sql"
import { taskTable } from "../db/task.sql"
import { getProjectById } from "../project"
import { openStepStatuses, type StepStatus } from "../step/transitions"

type DbExecutor = ReturnType<typeof db>

export type ActiveTaskSummary = {
  taskId: string
  projectId: string
  workflowName: string
  status: "active"
  createdAt: number
  updatedAt: number
  currentRootStepId: string | null
  currentRootStepKey: string | null
  currentRootStepStatus: StepStatus | null
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
  const openRootSteps = executor
    .select()
    .from(stepTable)
    .where(
      and(
        inArray(stepTable.taskId, taskIds),
        isNull(stepTable.parentStepId),
        inArray(stepTable.status, openStepStatuses),
      ),
    )
    .orderBy(desc(stepTable.stepIndex))
    .all()

  const openRootStepByTask = new Map<string, (typeof openRootSteps)[number]>()
  for (const step of openRootSteps) {
    if (!openRootStepByTask.has(step.taskId)) {
      openRootStepByTask.set(step.taskId, step)
    }
  }

  return tasks.map((task) => {
    const currentRootStep = openRootStepByTask.get(task.taskId)

    return {
      taskId: task.taskId,
      projectId: task.projectId,
      workflowName: task.workflowName,
      status: "active",
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      currentRootStepId: currentRootStep?.stepId ?? null,
      currentRootStepKey: currentRootStep?.stepKey ?? null,
      currentRootStepStatus: currentRootStep?.status ?? null,
    }
  })
}
