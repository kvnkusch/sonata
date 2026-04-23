import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, type AnySQLiteColumn, unique } from "drizzle-orm/sqlite-core"
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
      enum: ["pending", "active", "waiting", "blocked", "orphaned", "completed", "failed", "cancelled"],
    }).notNull(),
    parentStepId: text("parent_step_id").references((): AnySQLiteColumn => stepTable.stepId),
    workKey: text("work_key"),
    sessionId: text("session_id").unique(),
    opencodeBaseUrl: text("opencode_base_url"),
    inputs: text("inputs").notNull().default("{}"),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    completionPayloadJson: text("completion_payload_json"),
    waitSpecJson: text("wait_spec_json"),
    waitSnapshotJson: text("wait_snapshot_json"),
    blockPayloadJson: text("block_payload_json"),
    orphanedReasonJson: text("orphaned_reason_json"),
  },
  (table) => [
    unique("uq_step_task_index").on(table.taskId, table.stepIndex),
    unique("uq_step_child_identity").on(table.parentStepId, table.stepKey, table.workKey),
    check(
      "ck_step_parent_work_key_pairing",
      sql`(${table.parentStepId} IS NULL AND ${table.workKey} IS NULL) OR (${table.parentStepId} IS NOT NULL AND ${table.workKey} IS NOT NULL)`,
    ),
    index("idx_step_task_index").on(table.taskId, table.stepIndex),
    index("idx_step_task_status").on(table.taskId, table.status),
  ],
)

export type StepRow = typeof stepTable.$inferSelect
