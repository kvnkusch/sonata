import { eq } from "drizzle-orm"
import { artifactTable, db, stepTable, taskEventTable, taskTable, type DbExecutor } from "../db"
import { ErrorCode, RpcError } from "../rpc/base"

export type DeleteTaskInput = {
  taskId: string
}

export function deleteTask(input: DeleteTaskInput, executor: DbExecutor = db()) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  executor.delete(artifactTable).where(eq(artifactTable.taskId, input.taskId)).run()
  executor.delete(taskEventTable).where(eq(taskEventTable.taskId, input.taskId)).run()
  executor.delete(stepTable).where(eq(stepTable.taskId, input.taskId)).run()
  executor.delete(taskTable).where(eq(taskTable.taskId, input.taskId)).run()

  return {
    taskId: input.taskId,
    status: "deleted" as const,
  }
}
