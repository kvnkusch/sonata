import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { closeDb, db, stepTable, taskEventTable, taskTable } from "../db"
import { linkOpsRepo } from "../project"
import { startTask } from "../task"
import { failStep, startStep } from "./index"

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

describe("step.fail integration", () => {
  it("fails the step and keeps task active", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-fail-step-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_fail_step" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const failed = failStep({
      taskId: started.taskId,
      stepId: step.stepId,
      reason: "manual failure",
    })

    expect(failed.status).toBe("failed")

    const stepRow = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(stepRow?.status).toBe("failed")

    const taskRow = db().select().from(taskTable).where(eq(taskTable.taskId, started.taskId)).get()
    expect(taskRow?.status).toBe("active")

    const taskFailedEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "task.failed"))
      .all()
    expect(taskFailedEvents).toHaveLength(0)
  })
})
