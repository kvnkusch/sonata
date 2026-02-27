import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeDb } from "@sonata/core/db"
import { getProjectByRoot } from "@sonata/core/project"

const tempDirs: string[] = []

function runCli(args: string[], env: Record<string, string>) {
  return Bun.spawnSync({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: path.join(import.meta.dir, "../../../"),
    env,
  })
}

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("project link cli", () => {
  it("persists project mapping", () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-cli-link-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    const dbPath = path.join(sandbox, "db", "sonata.db")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })

    process.env.SONATA_DB_PATH = dbPath
    const result = runCli(
      ["project", "link", opsRoot, "--project-root", projectRoot, "--project-id", "prj_cli"],
      { ...process.env, SONATA_DB_PATH: dbPath } as Record<string, string>,
    )

    expect(result.exitCode).toBe(0)

    const row = getProjectByRoot(projectRoot)
    expect(row?.projectId).toBe("prj_cli")
  })
})
