import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveFromCwd } from "./index"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("resolveFromCwd", () => {
  it("resolves project root from nested directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sonata-scope-"))
    tempDirs.push(root)
    mkdirSync(path.join(root, ".git"))
    const nested = path.join(root, "a", "b", "c")
    mkdirSync(nested, { recursive: true })

    const result = resolveFromCwd({ cwd: nested })
    expect(result.projectRoot).toBe(realpathSync(root))
    expect(result.cwd).toBe(realpathSync(nested))
  })

  it("throws when no git root exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sonata-no-git-"))
    tempDirs.push(root)
    const nested = path.join(root, "x", "y")
    mkdirSync(nested, { recursive: true })

    expect(() => resolveFromCwd({ cwd: nested })).toThrow("No git repository found")
  })
})
