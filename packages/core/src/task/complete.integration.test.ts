import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { closeDb, db, taskEventTable, taskTable } from "../db"
import { linkOpsRepo } from "../project"
import { startStep } from "../step"
import { completeTask, startTask } from "./index"

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

describe("task.complete integration", () => {
  it("completes an active task and emits task.completed", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-task-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_task" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })

    const completed = completeTask({ taskId: started.taskId, completionPayload: { done: true } })
    expect(completed).toEqual({ taskId: started.taskId, status: "completed" })

    const task = db().select().from(taskTable).where(eq(taskTable.taskId, started.taskId)).get()
    expect(task?.status).toBe("completed")

    const events = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "task.completed"))
      .all()
    expect(events).toHaveLength(1)
  })

  it("rejects completion when task still has an active step", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-task-active-step-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_task_active_step" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    await startStep({ taskId: started.taskId, stepKey: "plan" })

    expect(() => completeTask({ taskId: started.taskId })).toThrow(
      `Cannot complete task=${started.taskId} while step=`,
    )

    const task = db().select().from(taskTable).where(eq(taskTable.taskId, started.taskId)).get()
    expect(task?.status).toBe("active")
    const completedEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "task.completed"))
      .all()
    expect(completedEvents).toHaveLength(0)
  })
})
