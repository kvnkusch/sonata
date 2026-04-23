import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { and, eq } from "drizzle-orm"
import { db, projectTable, stepTable, taskTable, type DbExecutor } from "../db"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { ErrorCode, RpcError } from "../rpc/base"

export type ResumeBlockedStepInput = {
  taskId: string
  stepId: string
}

export type ResumeBlockedStepResult =
  | {
      status: "active"
      taskId: string
      stepId: string
      sessionId?: string
    }
  | {
      status: "orphaned"
      taskId: string
      stepId: string
      orphanedReason: {
        code: "missing_session"
        message: string
        details?: unknown
      }
      }

function affectedRowCount(result: unknown): number | null {
  if (typeof result !== "object" || result === null) {
    return null
  }

  if ("changes" in result && typeof result.changes === "number") {
    return result.changes
  }

  if ("rowsAffected" in result && typeof result.rowsAffected === "number") {
    return result.rowsAffected
  }

  return null
}

async function sessionExists(input: { projectRoot: string; baseUrl: string; sessionId: string }): Promise<boolean> {
  try {
    const client = createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.projectRoot,
    })
    await client.session.messages({ sessionID: input.sessionId }, { throwOnError: true })
    return true
  } catch {
    return false
  }
}

export async function resumeBlockedStep(
  input: ResumeBlockedStepInput,
  executor: DbExecutor = db(),
): Promise<ResumeBlockedStepResult> {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  if (task.status !== "active") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot resume task=${input.taskId} step=${input.stepId} from current task state`,
    )
  }

  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
  }

  if (step.status !== "blocked") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot resume task=${input.taskId} step=${input.stepId} from current state`,
    )
  }

  const project = executor.select().from(projectTable).where(eq(projectTable.projectId, task.projectId)).get()
  if (!project) {
    throw new RpcError(ErrorCode.PROJECT_NOT_FOUND, 404, `Project not found: ${task.projectId}`)
  }

  if (!step.sessionId || !step.opencodeBaseUrl) {
    throw new RpcError(
      ErrorCode.STEP_SESSION_MISSING,
      409,
      `Blocked step ${input.stepId} is missing required session linkage`,
      {
        stepId: input.stepId,
        sessionId: step.sessionId ?? null,
        opencodeBaseUrl: step.opencodeBaseUrl ?? null,
      },
    )
  }

  const reusable =
    await sessionExists({
      projectRoot: project.projectRootRealpath,
      baseUrl: step.opencodeBaseUrl,
      sessionId: step.sessionId,
    })

  const now = Date.now()
  if (reusable) {
    const updateResult = executor
      .update(stepTable)
      .set({
        status: "active",
        orphanedReasonJson: null,
      })
      .where(and(eq(stepTable.stepId, input.stepId), eq(stepTable.status, "blocked")))
      .run()

    if (affectedRowCount(updateResult) === 0) {
      throw new RpcError(
        ErrorCode.INVALID_STEP_TRANSITION,
        409,
        `Cannot resume task=${input.taskId} step=${input.stepId} from current state`,
      )
    }

    writeTaskEvent({
      executor,
      taskId: input.taskId,
      stepId: input.stepId,
      eventType: TaskEventType.STEP_RESUMED,
      payload: {
        stepId: input.stepId,
        stepIndex: step.stepIndex,
        sessionId: step.sessionId,
      },
      createdAt: now,
    })

    executor
      .update(taskTable)
      .set({ updatedAt: now })
      .where(and(eq(taskTable.taskId, input.taskId), eq(taskTable.status, "active")))
      .run()

    return {
      taskId: input.taskId,
      stepId: input.stepId,
      status: "active",
      ...(step.sessionId ? { sessionId: step.sessionId } : {}),
    }
  }

  const orphanedReason = {
    code: "missing_session" as const,
    message: `OpenCode session for blocked step ${input.stepId} is unavailable`,
    details:
      step.sessionId || step.opencodeBaseUrl
        ? {
            sessionId: step.sessionId ?? null,
            opencodeBaseUrl: step.opencodeBaseUrl ?? null,
          }
        : undefined,
  }

  const updateResult = executor
    .update(stepTable)
    .set({
      status: "orphaned",
      orphanedReasonJson: JSON.stringify(orphanedReason),
    })
    .where(and(eq(stepTable.stepId, input.stepId), eq(stepTable.status, "blocked")))
    .run()

  if (affectedRowCount(updateResult) === 0) {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot resume task=${input.taskId} step=${input.stepId} from current state`,
    )
  }

  writeTaskEvent({
    executor,
    taskId: input.taskId,
    stepId: input.stepId,
    eventType: TaskEventType.STEP_ORPHANED,
    payload: {
      stepId: input.stepId,
      stepIndex: step.stepIndex,
      orphanedReason,
      sessionId: step.sessionId ?? null,
    },
    createdAt: now,
  })

  executor
    .update(taskTable)
    .set({ updatedAt: now })
    .where(and(eq(taskTable.taskId, input.taskId), eq(taskTable.status, "active")))
    .run()

  return {
    taskId: input.taskId,
    stepId: input.stepId,
    status: "orphaned",
    orphanedReason,
  }
}
