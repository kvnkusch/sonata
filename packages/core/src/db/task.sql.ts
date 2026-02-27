import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { projectTable } from "./project.sql"

export const taskTable = sqliteTable(
  "task",
  {
    taskId: text("task_id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.projectId),
    workflowName: text("workflow_name").notNull(),
    status: text("status", {
      enum: ["active", "completed", "failed", "cancelled"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_task_project_status_created").on(table.projectId, table.status, table.createdAt)],
)

export type TaskRow = typeof taskTable.$inferSelect
