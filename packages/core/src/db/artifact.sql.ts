import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core"
import { stepTable } from "./step.sql"
import { taskTable } from "./task.sql"

export const artifactTable = sqliteTable(
  "artifact",
  {
    artifactId: text("artifact_id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.taskId),
    stepId: text("step_id")
      .notNull()
      .references(() => stepTable.stepId),
    artifactName: text("artifact_name").notNull(),
    artifactKind: text("artifact_kind", {
      enum: ["markdown", "json"],
    }).notNull(),
    relativePath: text("relative_path").notNull(),
    contentHash: text("content_hash").notNull(),
    sessionId: text("session_id"),
    writtenAt: integer("written_at").notNull(),
  },
  (table) => [
    unique("uq_artifact_task_step_name").on(table.taskId, table.stepId, table.artifactName),
    index("idx_artifact_task_step_written").on(table.taskId, table.stepId, table.writtenAt),
  ],
)

export type ArtifactRow = typeof artifactTable.$inferSelect
