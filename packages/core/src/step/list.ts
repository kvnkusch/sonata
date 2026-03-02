import { asc, eq } from "drizzle-orm"
import { db, stepTable, taskTable, type DbExecutor } from "../db"
import { ErrorCode, RpcError } from "../rpc/base"

export function listStepsForTask(input: { taskId: string }, executor: DbExecutor = db()) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  const rows = executor
    .select({
      stepId: stepTable.stepId,
      stepKey: stepTable.stepKey,
      stepIndex: stepTable.stepIndex,
      status: stepTable.status,
      startedAt: stepTable.startedAt,
      completedAt: stepTable.completedAt,
    })
    .from(stepTable)
    .where(eq(stepTable.taskId, input.taskId))
    .orderBy(asc(stepTable.stepIndex))
    .all()

  return rows
}
