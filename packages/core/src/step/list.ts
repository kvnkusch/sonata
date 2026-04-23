import { asc, eq } from "drizzle-orm"
import { db, stepTable, taskTable, type DbExecutor } from "../db"
import { ErrorCode, RpcError } from "../rpc/base"

export function listStepsForTask(input: { taskId: string }, executor: DbExecutor = db()) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  const rows = executor
    .select()
    .from(stepTable)
    .where(eq(stepTable.taskId, input.taskId))
    .orderBy(asc(stepTable.stepIndex))
    .all()

  return rows.map((row) => ({
    stepId: row.stepId,
    stepKey: row.stepKey,
    stepIndex: row.stepIndex,
    status: row.status,
    parentStepId: row.parentStepId,
    workKey: row.workKey,
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }))
}
