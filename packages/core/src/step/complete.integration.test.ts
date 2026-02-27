import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { and, eq } from "drizzle-orm"
import { closeDb, db, stepTable, taskEventTable, taskTable } from "../db"
import { linkOpsRepo } from "../project"
import { ErrorCode } from "../rpc/base"
import { startTask } from "../task"
import { completeStep } from "./complete"
import { startStep } from "./start"
import { writeStepArtifact } from "./write-artifact"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

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
      artifacts: [{ name: "plan_summary", kind: "markdown", required: true, once: true }],
      next: "execute",
      async run() {},
      async on() {},
    },
    {
      id: "execute",
      title: "Execute",
      artifacts: [],
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

describe("step.complete integration", () => {
  it("rejects when required artifacts are missing", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-step-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_missing" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })

    await expect(
      completeStep({
        taskId: started.taskId,
        stepId: started.currentStepId,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.REQUIRED_ARTIFACT_MISSING,
    })

    const rejectionEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "step.completion.rejected"))
      .all()
    expect(rejectionEvents).toHaveLength(1)
    expect(rejectionEvents[0]?.eventVersion).toBe(1)
  })

  it("completes current step and requires explicit start for the next step", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-complete-step-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)
    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_complete_success" }, tx)
    })
    const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })

    await writeStepArtifact({
      taskId: started.taskId,
      stepId: started.currentStepId,
      artifactName: "plan_summary",
      artifactKind: "markdown",
      payload: { markdown: "done" },
    })

    const firstComplete = await completeStep({
      taskId: started.taskId,
      stepId: started.currentStepId,
      completionPayload: { ok: true },
    })

    expect(firstComplete.status).toBe("completed")
    expect(firstComplete.suggestedNextStepKey).toBe("execute")

    const autoStartedStep = db()
      .select()
      .from(stepTable)
      .where(and(eq(stepTable.taskId, started.taskId), eq(stepTable.status, "active")))
      .get()
    expect(autoStartedStep).toBeUndefined()

    const startedExecute = await startStep({
      taskId: started.taskId,
      stepKey: "execute",
    })

    expect(startedExecute.stepIndex).toBe(2)
    expect(startedExecute.status).toBe("active")

    const finalComplete = await completeStep({
      taskId: started.taskId,
      stepId: startedExecute.stepId,
      completionPayload: { done: true },
    })

    expect(finalComplete.status).toBe("completed")
    expect(finalComplete.suggestedNextStepKey).toBeNull()

    const task = db().select().from(taskTable).where(eq(taskTable.taskId, started.taskId)).get()
    expect(task?.status).toBe("active")

    const completedStepEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "step.completed"))
      .all()
    const taskCompletedEvents = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.eventType, "task.completed"))
      .all()

    expect(completedStepEvents.length).toBe(2)
    expect(taskCompletedEvents.length).toBe(0)
  })
})
