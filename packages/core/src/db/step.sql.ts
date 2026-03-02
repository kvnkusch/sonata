import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core"
import { taskTable } from "./task.sql"

export const stepTable = sqliteTable(
  "step",
  {
    stepId: text("step_id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.taskId),
    stepKey: text("step_key").notNull(),
    stepIndex: integer("step_index").notNull(),
    status: text("status", {
      enum: ["pending", "active", "completed", "failed", "cancelled"],
    }).notNull(),
    sessionId: text("session_id").unique(),
    opencodeBaseUrl: text("opencode_base_url"),
    inputs: text("inputs").notNull().default("{}"),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    completionPayloadJson: text("completion_payload_json"),
  },
  (table) => [
    unique("uq_step_task_index").on(table.taskId, table.stepIndex),
    index("idx_step_task_index").on(table.taskId, table.stepIndex),
    index("idx_step_task_status").on(table.taskId, table.status),
  ],
)

export type StepRow = typeof stepTable.$inferSelect
