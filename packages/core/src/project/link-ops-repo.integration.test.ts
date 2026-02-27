import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeDb, db } from "../db"
import { getProjectByRoot, linkOpsRepo } from "./index"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("project.linkOpsRepo integration", () => {
  it("relinks existing root and updates ops root without changing project id", () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-project-link-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRootA = path.join(sandbox, "ops-a")
    const opsRootB = path.join(sandbox, "ops-b")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRootA, { recursive: true })
    mkdirSync(opsRootB, { recursive: true })

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    db().transaction((tx) => {
      linkOpsRepo({ projectRoot, opsRoot: opsRootA, projectId: "prj_original" }, tx)
    })

    const relinked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot: opsRootB }, tx)
    })

    expect(relinked.projectId).toBe("prj_original")
    expect(relinked.opsRootRealpath).toBe(realpathSync(opsRootB))

    const linked = getProjectByRoot(projectRoot)
    expect(linked?.projectId).toBe("prj_original")
    expect(linked?.opsRootRealpath).toBe(realpathSync(opsRootB))
  })

  it("rejects project id rewrite for an existing linked root", () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-project-link-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRootA = path.join(sandbox, "ops-a")
    const opsRootB = path.join(sandbox, "ops-b")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRootA, { recursive: true })
    mkdirSync(opsRootB, { recursive: true })

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    db().transaction((tx) => {
      linkOpsRepo({ projectRoot, opsRoot: opsRootA, projectId: "prj_original" }, tx)
    })

    expect(() =>
      db().transaction((tx) => {
        linkOpsRepo({ projectRoot, opsRoot: opsRootB, projectId: "prj_rewrite" }, tx)
      }),
    ).toThrow("Project ID is immutable")

    const linked = getProjectByRoot(projectRoot)
    expect(linked?.projectId).toBe("prj_original")
    expect(linked?.opsRootRealpath).toBe(realpathSync(opsRootA))
  })
})
