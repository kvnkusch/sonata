import { mkdirSync } from "node:fs"
import path from "node:path"
import type BetterSqlite3 from "better-sqlite3"
import type { Database as BunDatabase } from "bun:sqlite"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { paths } from "../paths"
import * as schema from "./schema"

export { artifactTable } from "./artifact.sql"
export { projectTable } from "./project.sql"
export { stepTable } from "./step.sql"
export { taskTable } from "./task.sql"
export { taskEventTable } from "./task-event.sql"

const isBunRuntime = typeof Bun !== "undefined"

const sqliteModule = isBunRuntime ? await import("bun:sqlite") : await import("better-sqlite3")
const bunDrizzleModule = isBunRuntime ? await import("drizzle-orm/bun-sqlite") : undefined
const betterSqliteDrizzleModule = isBunRuntime ? undefined : await import("drizzle-orm/better-sqlite3")
const migratorModule = isBunRuntime
  ? await import("drizzle-orm/bun-sqlite/migrator")
  : await import("drizzle-orm/better-sqlite3/migrator")

type SonataDb = BunSQLiteDatabase<typeof schema> | BetterSQLite3Database<typeof schema>
export type DbExecutor = SonataDb
export type DbTx = Parameters<Parameters<DbExecutor["transaction"]>[0]>[0]
type SqliteConnection = BunDatabase | BetterSqlite3.Database
type BunSqliteModule = { Database: typeof import("bun:sqlite").Database }
type BetterSqliteModule = { default: new (location: string) => BetterSqlite3.Database }

const state: {
  sqlite?: SqliteConnection
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

  const sqlite = isBunRuntime
    ? new (sqliteModule as unknown as BunSqliteModule).Database(location, { create: true })
    : new (sqliteModule as unknown as BetterSqliteModule).default(location)
  const sqliteWithRun = sqlite as { run: (statement: string) => unknown }
  sqliteWithRun.run("PRAGMA journal_mode = WAL")
  sqliteWithRun.run("PRAGMA synchronous = NORMAL")
  sqliteWithRun.run("PRAGMA busy_timeout = 5000")
  sqliteWithRun.run("PRAGMA foreign_keys = ON")

  const client = isBunRuntime
    ? (bunDrizzleModule!.drizzle({ client: sqlite as BunDatabase, schema }) as SonataDb)
    : (betterSqliteDrizzleModule!.drizzle({
        client: sqlite as BetterSqlite3.Database,
        schema,
      }) as SonataDb)
  const migrationsFolder = path.join(import.meta.dir, "../../migrations")
  migratorModule.migrate(client as never, { migrationsFolder })

  state.sqlite = sqlite
  state.db = client
  return client
}

export function closeDb() {
  if (state.sqlite) {
    if (isBunRuntime) {
      ;(state.sqlite as BunDatabase).close(false)
    } else {
      ;(state.sqlite as BetterSqlite3.Database).close()
    }
  }
  state.sqlite = undefined
  state.db = undefined
}
