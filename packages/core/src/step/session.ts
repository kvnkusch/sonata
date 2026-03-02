import { eq } from "drizzle-orm"
import { db, stepTable, type DbExecutor } from "../db"

export function setStepSession(
  input: { taskId: string; stepId: string; sessionId: string; baseUrl: string },
  executor: DbExecutor = db(),
) {
  executor
    .update(stepTable)
    .set({
      sessionId: input.sessionId,
      opencodeBaseUrl: input.baseUrl,
    })
    .where(eq(stepTable.stepId, input.stepId))
    .run()

  return {
    taskId: input.taskId,
    stepId: input.stepId,
    sessionId: input.sessionId,
    baseUrl: input.baseUrl,
  }
}
