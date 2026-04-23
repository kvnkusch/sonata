import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { closeDb, db, stepTable } from "../db"
import { executeStep } from "../execution"
import { linkOpsRepo } from "../project"
import { startTask } from "../task"
import { cancelStep, startStep } from "./index"

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

function writeOpsWorkflowFilesFromSource(opsRoot: string, workflowSource: string) {
  mkdirSync(path.join(opsRoot, "workflows"), { recursive: true })
  writeFileSync(path.join(opsRoot, "workflows", "default.ts"), workflowSource, "utf8")

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

describe("step.cancel integration", () => {
  it("cancels a waiting step and clears persisted wait state", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-cancel-waiting-step-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_cancel_waiting_step" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    db()
      .update(stepTable)
      .set({
        status: "waiting",
        waitSpecJson: JSON.stringify({ kind: "children", childStepKey: "plan", until: "all_completed" }),
        waitSnapshotJson: JSON.stringify({ totalCount: 1, activeCount: 1 }),
      })
      .where(eq(stepTable.stepId, step.stepId))
      .run()

    const cancelled = cancelStep({ taskId: started.taskId, stepId: step.stepId })
    expect(cancelled.status).toBe("cancelled")

    const stepRow = db().select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    expect(stepRow?.status).toBe("cancelled")
    expect(stepRow?.waitSpecJson).toBeNull()
    expect(stepRow?.waitSnapshotJson).toBeNull()
  })

  it("rejects cancelling a root step while child steps are still open", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-cancel-root-open-children-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFilesFromSource(
      opsRoot,
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "controller",
      title: "Controller",
      async run(ctx) {
        await ctx.children.spawn({ stepKey: "worker", workKey: "alpha" })
      },
      async waitFor() {
        return {
          kind: "children",
          childStepKey: "worker",
          workKeys: ["alpha"],
          until: "all_terminal",
        }
      },
      async on() {},
    },
    {
      id: "worker",
      title: "Worker",
      async run() {},
      async on() {},
    },
  ],
}
`,
    )
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_cancel_root_open_children" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const controller = await startStep({ taskId: started.taskId, stepKey: "controller" })

    const controllerResult = await executeStep({ taskId: started.taskId, stepId: controller.stepId })
    expect(controllerResult.status).toBe("waiting")

    expect(() => cancelStep({ taskId: started.taskId, stepId: controller.stepId })).toThrow(
      `Cannot cancel root step ${controller.stepId} while child steps are still open`,
    )

    const parentRow = db().select().from(stepTable).where(eq(stepTable.stepId, controller.stepId)).get()
    expect(parentRow?.status).toBe("waiting")
  })

  it("wakes a waiting parent when a child is cancelled via step.cancel", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-cancel-wakes-parent-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFilesFromSource(
      opsRoot,
      `export default {
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Default",
  steps: [
    {
      id: "controller",
      title: "Controller",
      async run(ctx) {
        await ctx.children.spawn({ stepKey: "worker", workKey: "alpha" })
      },
      async waitFor() {
        return {
          kind: "children",
          childStepKey: "worker",
          workKeys: ["alpha"],
          until: "all_terminal",
        }
      },
      async on() {},
    },
    {
      id: "worker",
      title: "Worker",
      async run() {},
      async on() {},
    },
  ],
}
`,
    )
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_cancel_wakes_parent" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
    const controller = await startStep({ taskId: started.taskId, stepKey: "controller" })

    const controllerResult = await executeStep({ taskId: started.taskId, stepId: controller.stepId })
    expect(controllerResult.status).toBe("waiting")

    const child = db().select().from(stepTable).where(eq(stepTable.parentStepId, controller.stepId)).get()
    const cancelled = cancelStep({ taskId: started.taskId, stepId: child!.stepId })
    expect(cancelled.status).toBe("cancelled")

    const parentRow = db().select().from(stepTable).where(eq(stepTable.stepId, controller.stepId)).get()
    expect(parentRow?.status).toBe("active")
    expect(parentRow?.waitSpecJson).toBeNull()
    expect(parentRow?.waitSnapshotJson).toBeNull()
  })
})
