import { mkdirSync } from "node:fs"
import path from "node:path"
import { Database as BunDatabase } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { paths } from "../paths"
import * as schema from "./schema"

export { artifactTable } from "./artifact.sql"
export { projectTable } from "./project.sql"
export { stepTable } from "./step.sql"
export { taskTable } from "./task.sql"
export { taskEventTable } from "./task-event.sql"

type SonataDb = BunSQLiteDatabase<typeof schema>
export type DbExecutor = SonataDb
export type DbTx = Parameters<Parameters<DbExecutor["transaction"]>[0]>[0]

const state: {
  sqlite?: BunDatabase
  db?: SonataDb
} = {}

export function databasePath(): string {
  const explicit = process.env.SONATA_DB_PATH
  if (explicit) return explicit
  return path.join(paths().data, "sonata.db")
}

export function db(): SonataDb {
  if (state.db) return state.db

  const location = databasePath()
  mkdirSync(path.dirname(location), { recursive: true })

  const sqlite = new BunDatabase(location, { create: true })
  sqlite.run("PRAGMA journal_mode = WAL")
  sqlite.run("PRAGMA synchronous = NORMAL")
  sqlite.run("PRAGMA busy_timeout = 5000")
  sqlite.run("PRAGMA foreign_keys = ON")

  const client = drizzle({ client: sqlite, schema })
  const migrationsFolder = path.join(import.meta.dir, "../../migrations")
  migrate(client, { migrationsFolder })

  state.sqlite = sqlite
  state.db = client
  return client
}

export function closeDb() {
  if (state.sqlite) {
    state.sqlite.close(false)
  }
  state.sqlite = undefined
  state.db = undefined
}
