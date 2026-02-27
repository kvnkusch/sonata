import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const projectTable = sqliteTable("project", {
  projectId: text("project_id").primaryKey(),
  projectRootRealpath: text("project_root_realpath").notNull().unique(),
  opsRootRealpath: text("ops_root_realpath").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export type ProjectRow = typeof projectTable.$inferSelect
