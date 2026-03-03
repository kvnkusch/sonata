import { rmSync } from "node:fs"
import path from "node:path"
import { eq } from "drizzle-orm"
import { db } from "../db"
import { projectTable } from "../db/project.sql"
import { taskTable } from "../db/task.sql"
import { getProjectById, linkOpsRepo } from "../project"
import { resolveFromCwd } from "../scope"
import { cancelStep, completeStep, failStep, getStepToolset, listStepsForTask, startStep, writeStepArtifact } from "../step"
import { completeTask, deleteTask, listActiveTasks, startTask } from "../task"
import {
  ErrorCode,
  ProjectLinkInput,
  RpcError,
  ScopeResolveInput,
  StepCancelInput,
  StepCompleteInput,
  StepFailInput,
  StepGetToolsetInput,
  StepListInput,
  StepStartInput,
  StepWriteArtifactInput,
  TaskListActiveInput,
  TaskCompleteInput,
  TaskDeleteInput,
  TaskStartInput,
} from "./base"

function invalidInput(error: unknown): RpcError {
  const message = error instanceof Error ? error.message : "Invalid input"
  return new RpcError(ErrorCode.INVALID_INPUT, 400, message)
}

export const router = {
  scope: {
    resolveFromCwd(input?: unknown) {
      const parsed = ScopeResolveInput.safeParse(input ?? {})
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      try {
        return resolveFromCwd(parsed.data)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Project is not linked"
        throw new RpcError(ErrorCode.PROJECT_NOT_LINKED, 412, message)
      }
    },
  },
  project: {
    linkOpsRepo(input: unknown) {
      const parsed = ProjectLinkInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      try {
        return db().transaction((tx) => linkOpsRepo(parsed.data, tx))
      } catch (error) {
        throw invalidInput(error)
      }
    },
  },
  task: {
    async start(input: unknown) {
      const parsed = TaskStartInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      if (!getProjectById(parsed.data.projectId)) {
        throw new RpcError(ErrorCode.PROJECT_NOT_FOUND, 404, `Project not found: ${parsed.data.projectId}`)
      }
      try {
        return await startTask(parsed.data)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Workflow not found"
        if (message.includes("Workflow module not configured")) {
          throw new RpcError(ErrorCode.WORKFLOW_NOT_FOUND, 404, message)
        }
        throw error
      }
    },
    listActive(input: unknown) {
      const parsed = TaskListActiveInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      return db().transaction((tx) => {
        if (!getProjectById(parsed.data.projectId, tx)) {
          throw new RpcError(ErrorCode.PROJECT_NOT_FOUND, 404, `Project not found: ${parsed.data.projectId}`)
        }
        return listActiveTasks(parsed.data, tx)
      })
    },
    complete(input: unknown) {
      const parsed = TaskCompleteInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      return completeTask(parsed.data)
    },
    delete(input: unknown) {
      const parsed = TaskDeleteInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      const deleted = db().transaction((tx) => {
        const task = tx
          .select({ projectId: taskTable.projectId })
          .from(taskTable)
          .where(eq(taskTable.taskId, parsed.data.taskId))
          .get()
        if (!task) {
          throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${parsed.data.taskId}`)
        }

        const project = tx
          .select({ opsRootRealpath: projectTable.opsRootRealpath })
          .from(projectTable)
          .where(eq(projectTable.projectId, task.projectId))
          .get()
        if (!project) {
          throw new RpcError(ErrorCode.PROJECT_NOT_FOUND, 404, `Project not found: ${task.projectId}`)
        }

        const result = deleteTask(parsed.data, tx)
        return {
          ...result,
          opsRootRealpath: project.opsRootRealpath,
        }
      })

      let cleanupWarning: string | undefined
      try {
        rmSync(path.join(deleted.opsRootRealpath, "tasks", parsed.data.taskId), { recursive: true, force: true })
      } catch (error) {
        cleanupWarning = error instanceof Error ? error.message : "Failed to clean up task artifact directory"
      }

      return cleanupWarning
        ? { taskId: deleted.taskId, status: deleted.status, cleanupWarning }
        : { taskId: deleted.taskId, status: deleted.status }
    },
  },
  step: {
    async start(input: unknown) {
      const parsed = StepStartInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      return startStep(parsed.data)
    },
    list(input: unknown) {
      const parsed = StepListInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      return listStepsForTask(parsed.data)
    },
    async getToolset(input: unknown) {
      const parsed = StepGetToolsetInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      return getStepToolset(parsed.data)
    },
    async writeArtifact(input: unknown) {
      const parsed = StepWriteArtifactInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      return writeStepArtifact(parsed.data)
    },
    async complete(input: unknown) {
      const parsed = StepCompleteInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      return completeStep(parsed.data)
    },
    fail(input: unknown) {
      const parsed = StepFailInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      return failStep(parsed.data)
    },
    cancel(input: unknown) {
      const parsed = StepCancelInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      return cancelStep(parsed.data)
    },
  },
}
