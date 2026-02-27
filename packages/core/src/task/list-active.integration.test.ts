import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { closeDb, db, taskTable } from "../db"
import { linkOpsRepo } from "../project"
import { listActiveTasks } from "./list-active"
import { startTask } from "./start"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("task.listActive integration", () => {
  it("returns only active tasks", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-list-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    mkdirSync(path.join(opsRoot, "workflows"), { recursive: true })
    writeFileSync(
      path.join(opsRoot, "workflows", "default.ts"),
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [{ id: "plan", title: "Plan", artifacts: [], async run() {}, async on() {} }],
}
`,
      "utf8",
    )
    writeFileSync(
      path.join(opsRoot, "workflows", "secondary.ts"),
      `export default {
  apiVersion: 1,
  id: "secondary",
  version: "0.1.0",
  name: "Secondary",
  steps: [{ id: "plan", title: "Plan", artifacts: [], async run() {}, async on() {} }],
}
`,
      "utf8",
    )
    writeFileSync(
      path.join(opsRoot, "config.json"),
      JSON.stringify(
        {
          version: 1,
          defaultWorkflowId: "default",
          workflowModules: [
            { id: "default", path: "./workflows/default.ts" },
            { id: "secondary", path: "./workflows/secondary.ts" },
          ],
        },
        null,
        2,
      ),
      "utf8",
    )
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const { linked } = db().transaction((tx) => {
      const linked = linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_listactive" }, tx)
      return { linked }
    })

    const active = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const completed = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "secondary" },
    })

    db().update(taskTable).set({ status: "completed" }).where(eq(taskTable.taskId, completed.taskId)).run()

    const tasks = listActiveTasks({ projectId: linked.projectId })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.taskId).toBe(active.taskId)
    expect(tasks[0]?.status).toBe("active")
  })
})
