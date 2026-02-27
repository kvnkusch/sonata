import { existsSync, realpathSync } from "node:fs"
import path from "node:path"

export type ScopeInfo = {
  cwd: string
  projectRoot: string
}

function hasGitBoundary(dir: string): boolean {
  return existsSync(path.join(dir, ".git"))
}

export function resolveFromCwd(input?: { cwd?: string }): ScopeInfo {
  const rawCwd = input?.cwd ?? process.cwd()
  const cwd = realpathSync(rawCwd)

  let cursor = cwd
  while (true) {
    if (hasGitBoundary(cursor)) {
      return {
        cwd,
        projectRoot: realpathSync(cursor),
      }
    }

    const parent = path.dirname(cursor)
    if (parent === cursor) {
      throw new Error(`No git repository found from cwd: ${cwd}`)
    }
    cursor = parent
  }
}
