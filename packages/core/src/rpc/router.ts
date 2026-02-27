import { db } from "../db"
import { getProjectById, linkOpsRepo } from "../project"
import { resolveFromCwd } from "../scope"
import { completeStep, getStepToolset, startStep, writeStepArtifact } from "../step"
import { listActiveTasks, startTask } from "../task"
import {
  ErrorCode,
  ProjectLinkInput,
  RpcError,
  ScopeResolveInput,
  StepCompleteInput,
  StepGetToolsetInput,
  StepStartInput,
  StepWriteArtifactInput,
  TaskListActiveInput,
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
  },
  step: {
    async start(input: unknown) {
      const parsed = StepStartInput.safeParse(input)
      if (!parsed.success) {
        throw invalidInput(parsed.error)
      }
      return startStep(parsed.data)
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
  },
}
