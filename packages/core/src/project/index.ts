import { realpathSync } from "node:fs"
import { eq } from "drizzle-orm"
import { db, type DbExecutor, type DbTx } from "../db"
import { projectTable, type ProjectRow } from "../db/project.sql"
import { newProjectId } from "../id"
import { resolveFromCwd } from "../scope"

export type LinkOpsRepoInput = {
  projectRoot?: string
  opsRoot: string
  projectId?: string
}

export function getProjectById(projectId: string, executor: DbExecutor = db()): ProjectRow | undefined {
  return executor.select().from(projectTable).where(eq(projectTable.projectId, projectId)).get()
}

export function getProjectByRoot(projectRoot: string, executor: DbExecutor = db()): ProjectRow | undefined {
  const root = realpathSync(projectRoot)
  return executor.select().from(projectTable).where(eq(projectTable.projectRootRealpath, root)).get()
}

export function linkOpsRepo(input: LinkOpsRepoInput, tx: DbTx): ProjectRow {
  const scope = input.projectRoot ? undefined : resolveFromCwd()
  const projectRootRealpath = realpathSync(input.projectRoot ?? scope!.projectRoot)
  const opsRootRealpath = realpathSync(input.opsRoot)

  const existing = getProjectByRoot(projectRootRealpath, tx)
  const now = Date.now()

  if (existing) {
    if (input.projectId && input.projectId !== existing.projectId) {
      throw new Error(
        `Project ID is immutable for linked root ${projectRootRealpath}: existing=${existing.projectId}, requested=${input.projectId}`,
      )
    }

    tx
      .update(projectTable)
      .set({
        opsRootRealpath,
        updatedAt: now,
      })
      .where(eq(projectTable.projectRootRealpath, projectRootRealpath))
      .run()

    return getProjectByRoot(projectRootRealpath, tx)!
  }

  const created: ProjectRow = {
    projectId: input.projectId ?? newProjectId(),
    projectRootRealpath,
    opsRootRealpath,
    createdAt: now,
    updatedAt: now,
  }

  tx.insert(projectTable).values(created).run()
  return created
}
