import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { closeDb, db, stepTable, taskEventTable, taskTable } from "../db"
import { linkOpsRepo } from "../project"
import { createCaller } from "../rpc"
import { failStep, startStep } from "../step"
import { startTask } from "./index"

const tempDirs: string[] = []

function writeOpsWorkflowFiles(opsRoot: string) {
  mkdirSync(path.join(opsRoot, "workflows"), { recursive: true })
  writeFileSync(
    path.join(opsRoot, "workflows", "default.ts"),
    `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "plan",
      title: "Plan",
      async run() {},
      async on() {},
    },
  ],
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
        workflowModules: [{ id: "default", path: "./workflows/default.ts" }],
      },
      null,
      2,
    ),
    "utf8",
  )
}

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("task.delete integration", () => {
  it("deletes a task and its related rows", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-delete-task-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_delete_task" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })
    failStep({ taskId: started.taskId, stepId: step.stepId })

    const artifactDir = path.join(opsRoot, "tasks", started.taskId)
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(path.join(artifactDir, "leftover.md"), "leftover\n", "utf8")

    const caller = createCaller()
    const deleted = caller.task.delete({ taskId: started.taskId })
    expect(deleted).toEqual({ taskId: started.taskId, status: "deleted" })
    expect(existsSync(artifactDir)).toBe(false)

    const taskRow = db().select().from(taskTable).where(eq(taskTable.taskId, started.taskId)).get()
    expect(taskRow).toBeUndefined()

    const stepRows = db().select().from(stepTable).where(eq(stepTable.taskId, started.taskId)).all()
    expect(stepRows).toHaveLength(0)

    const eventRows = db().select().from(taskEventTable).where(eq(taskEventTable.taskId, started.taskId)).all()
    expect(eventRows).toHaveLength(0)
  })

  it("deletes task even when it has an active step", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-delete-task-active-step-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_delete_task_active_step" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    await startStep({ taskId: started.taskId, stepKey: "plan" })

    const caller = createCaller()
    const deleted = caller.task.delete({ taskId: started.taskId })
    expect(deleted).toEqual({ taskId: started.taskId, status: "deleted" })

    const taskRow = db().select().from(taskTable).where(eq(taskTable.taskId, started.taskId)).get()
    expect(taskRow).toBeUndefined()

    const stepRows = db().select().from(stepTable).where(eq(stepTable.taskId, started.taskId)).all()
    expect(stepRows).toHaveLength(0)

    const eventRows = db().select().from(taskEventTable).where(eq(taskEventTable.taskId, started.taskId)).all()
    expect(eventRows).toHaveLength(0)
  })
})
