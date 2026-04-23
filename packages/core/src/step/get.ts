import { eq } from "drizzle-orm"
import { db, stepTable, taskTable, type DbExecutor } from "../db"
import type { StepRow } from "../db/step.sql"
import { ErrorCode, RpcError } from "../rpc/base"

export type GetStepInput = {
  taskId: string
  stepId: string
}

export type GetStepResult = {
  stepId: string
  stepKey: string
  stepIndex: number
  status: StepRow["status"]
  parentStepId: string | null
  workKey: string | null
  sessionId: string | null
  opencodeBaseUrl: string | null
  waitSpec: unknown | null
  waitSnapshot: unknown | null
  blockPayload: unknown | null
  orphanedReason: unknown | null
}

function parseOptionalJson(value: string | null): unknown | null {
  if (value === null) {
    return null
  }
  return JSON.parse(value)
}

export function getStep(input: GetStepInput, executor: DbExecutor = db()): GetStepResult {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
  }

  return {
    stepId: step.stepId,
    stepKey: step.stepKey,
    stepIndex: step.stepIndex,
    status: step.status,
    parentStepId: step.parentStepId,
    workKey: step.workKey,
    sessionId: step.sessionId,
    opencodeBaseUrl: step.opencodeBaseUrl,
    waitSpec: parseOptionalJson(step.waitSpecJson),
    waitSnapshot: parseOptionalJson(step.waitSnapshotJson),
    blockPayload: parseOptionalJson(step.blockPayloadJson),
    orphanedReason: parseOptionalJson(step.orphanedReasonJson),
  }
}
