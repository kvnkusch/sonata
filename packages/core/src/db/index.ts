import { mkdirSync } from "node:fs"
import path from "node:path"
import type BetterSqlite3 from "better-sqlite3"
import type { Database as BunDatabase } from "bun:sqlite"
import type { ExtractTablesWithRelations } from "drizzle-orm"
import type { BaseSQLiteDatabase, SQLiteTransaction } from "drizzle-orm/sqlite-core"
import { paths } from "../paths"
import * as schema from "./schema"

export { artifactTable } from "./artifact.sql"
export { projectTable } from "./project.sql"
export { stepTable } from "./step.sql"
export { taskTable } from "./task.sql"
export { taskEventTable } from "./task-event.sql"

const isBunRuntime = typeof Bun !== "undefined"

const bunModules = isBunRuntime
  ? {
      sqlite: await import("bun:sqlite"),
      drizzle: await import("drizzle-orm/bun-sqlite"),
      migrator: await import("drizzle-orm/bun-sqlite/migrator"),
    }
  : null

const betterSqliteModules = isBunRuntime
  ? null
  : {
      sqlite: await import("better-sqlite3"),
      drizzle: await import("drizzle-orm/better-sqlite3"),
      migrator: await import("drizzle-orm/better-sqlite3/migrator"),
    }

type SonataSchema = typeof schema
type SonataRelations = ExtractTablesWithRelations<SonataSchema>
type SonataDb = BaseSQLiteDatabase<"sync", unknown, SonataSchema, SonataRelations>
export type DbExecutor = SonataDb
export type DbTx = SQLiteTransaction<"sync", unknown, SonataSchema, SonataRelations>

const state: {
  bunSqlite?: BunDatabase
  betterSqlite?: BetterSqlite3.Database
  db?: SonataDb
} = {}

function configureBunSqliteConnection(sqlite: BunDatabase) {
  sqlite.run("PRAGMA journal_mode = WAL")
  sqlite.run("PRAGMA synchronous = NORMAL")
  sqlite.run("PRAGMA busy_timeout = 5000")
  sqlite.run("PRAGMA foreign_keys = ON")
}

function configureBetterSqliteConnection(sqlite: BetterSqlite3.Database) {
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("synchronous = NORMAL")
  sqlite.pragma("busy_timeout = 5000")
  sqlite.pragma("foreign_keys = ON")
}

function initializeBunDb(location: string): { sqlite: BunDatabase; db: SonataDb } {
  if (!bunModules) {
    throw new Error("Bun SQLite modules are unavailable outside Bun runtime")
  }

  const sqlite = new bunModules.sqlite.Database(location, { create: true })
  configureBunSqliteConnection(sqlite)

  const client = bunModules.drizzle.drizzle({ client: sqlite, schema })
  bunModules.migrator.migrate(client, {
    migrationsFolder: path.join(import.meta.dir, "../../migrations"),
  })

  return { sqlite, db: client }
}

function initializeBetterSqliteDb(location: string): {
  sqlite: BetterSqlite3.Database
  db: SonataDb
} {
  if (!betterSqliteModules) {
    throw new Error("better-sqlite3 modules are unavailable in Bun runtime")
  }

  const sqlite = new betterSqliteModules.sqlite.default(location)
  configureBetterSqliteConnection(sqlite)

  const client = betterSqliteModules.drizzle.drizzle({ client: sqlite, schema })
  betterSqliteModules.migrator.migrate(client, {
    migrationsFolder: path.join(import.meta.dir, "../../migrations"),
  })

  return { sqlite, db: client }
}

export function databasePath(): string {
  const explicit = process.env.SONATA_DB_PATH
  if (explicit) return explicit
  return path.join(paths().data, "sonata.db")
}

export function db(): SonataDb {
  if (state.db) return state.db

  const location = databasePath()
  mkdirSync(path.dirname(location), { recursive: true })

  if (isBunRuntime) {
    const initialized = initializeBunDb(location)
    state.bunSqlite = initialized.sqlite
    state.betterSqlite = undefined
    state.db = initialized.db
    return initialized.db
  }

  const initialized = initializeBetterSqliteDb(location)
  state.bunSqlite = undefined
  state.betterSqlite = initialized.sqlite
  state.db = initialized.db
  return initialized.db
}

export function closeDb() {
  if (state.bunSqlite) {
    state.bunSqlite.close(false)
  }
  if (state.betterSqlite) {
    state.betterSqlite.close()
  }
  state.bunSqlite = undefined
  state.betterSqlite = undefined
  state.db = undefined
}
