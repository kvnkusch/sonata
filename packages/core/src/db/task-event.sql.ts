import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { stepTable } from "./step.sql"
import { taskTable } from "./task.sql"

export const taskEventTable = sqliteTable(
  "task_event",
  {
    eventId: text("event_id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.taskId),
    stepId: text("step_id").references(() => stepTable.stepId),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull().default(1),
    eventPayloadJson: text("event_payload_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_task_event_task_created").on(table.taskId, table.createdAt)],
)

export type TaskEventRow = typeof taskEventTable.$inferSelect
