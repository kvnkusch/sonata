import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { db, closeDb, projectTable, stepTable, taskTable } from "../db"
import { linkOpsRepo } from "../project"
import { startTask } from "./start"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("task.start integration", () => {
  it("links project and creates initial task row without auto-step", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-start-"))
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
  steps: [
    {
      id: "plan",
      title: "Plan",
      artifacts: [{ name: "plan_summary", kind: "markdown", required: true, once: true }],
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

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const { linked } = db().transaction((tx) => {
      const linked = linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_testproject" }, tx)
      return { linked }
    })

    const started = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })

    const projects = db().select().from(projectTable).all()
    const tasks = db().select().from(taskTable).all()
    const steps = db().select().from(stepTable).all()

    expect(projects.length).toBe(1)
    expect(tasks.length).toBe(1)
    expect(steps.length).toBe(0)
    expect(tasks[0]?.status).toBe("active")
    expect(started.taskId).toStartWith("tsk_")
  })

  it("replays start idempotently for a client-provided task id", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-start-"))
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
  steps: [
    {
      id: "plan",
      title: "Plan",
      artifacts: [{ name: "plan_summary", kind: "markdown", required: true, once: true }],
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

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_stable_task_id" }, tx)
    })

    const taskId = "tsk_clientstable001"
    const first = await startTask({
      taskId,
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const replay = await startTask({
      taskId,
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })

    expect(first.taskId).toBe(taskId)
    expect(replay.taskId).toBe(taskId)
    expect(db().select().from(taskTable).all()).toHaveLength(1)
    expect(db().select().from(stepTable).all()).toHaveLength(0)
  })
})
