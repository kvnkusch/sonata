import { afterEach, describe, expect, it } from "bun:test"
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { closeDb, db, stepTable, taskEventTable } from "../db"
import { TaskEventType } from "../event/task-event"
import { linkOpsRepo } from "../project"
import { startTask } from "../task"
import { setStepSession } from "./session"
import { blockStep } from "./block"
import { resumeBlockedStep } from "./resume-blocked"
import { retryOrphanedStepInNewSession } from "./retry-orphaned"
import { startStep } from "./start"

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
      opencode: {},
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

async function setupTask(projectId: string) {
  const sandbox = mkdtempSync(path.join(tmpdir(), `sonata-step-block-${projectId}-`))
  tempDirs.push(sandbox)

  const projectRoot = path.join(sandbox, "project")
  const opsRoot = path.join(sandbox, "ops")
  mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
  mkdirSync(opsRoot, { recursive: true })
  writeOpsWorkflowFiles(opsRoot)

  process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

  const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId }, tx))
  const started = await startTask({ projectId: linked.projectId, workflowRef: { name: "default" } })
  const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

  return { projectRoot, opsRoot, taskId: started.taskId, stepId: step.stepId }
}

describe("step.block integration", () => {
  it("transitions active to blocked, then resumes in the same session", async () => {
    const setup = await setupTask("prj_block_resume")
    const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0, timeout: 15_000, config: {} })

    try {
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: setup.projectRoot,
      })
      const session = await client.session.create({ title: "Resume session" }, { throwOnError: true })

      setStepSession(
        {
          taskId: setup.taskId,
          stepId: setup.stepId,
          sessionId: session.data.id,
          baseUrl: server.url,
        },
        db(),
      )

      const blocked = blockStep({
        taskId: setup.taskId,
        stepId: setup.stepId,
        blockPayload: {
          code: "needs_operator_input",
          message: "Need operator confirmation before proceeding",
          details: { choice: "target-environment" },
          resumeHint: "Attach to the existing session and continue",
        },
      })
      expect(blocked).toMatchObject({
        stepId: setup.stepId,
        status: "blocked",
        sessionId: session.data.id,
      })

      const blockedRow = db().select().from(stepTable).where(eq(stepTable.stepId, setup.stepId)).get()
      expect(blockedRow?.status).toBe("blocked")
      expect(blockedRow?.sessionId).toBe(session.data.id)
      expect(JSON.parse(blockedRow?.blockPayloadJson ?? "null")).toEqual({
        code: "needs_operator_input",
        message: "Need operator confirmation before proceeding",
        details: { choice: "target-environment" },
        resumeHint: "Attach to the existing session and continue",
      })

      const resumed = await resumeBlockedStep({
        taskId: setup.taskId,
        stepId: setup.stepId,
      })
      expect(resumed).toEqual({
        taskId: setup.taskId,
        stepId: setup.stepId,
        status: "active",
        sessionId: session.data.id,
      })

      const resumedRow = db().select().from(stepTable).where(eq(stepTable.stepId, setup.stepId)).get()
      expect(resumedRow?.status).toBe("active")
      expect(resumedRow?.sessionId).toBe(session.data.id)
      expect(resumedRow?.orphanedReasonJson).toBeNull()

      const events = db()
        .select()
        .from(taskEventTable)
        .where(eq(taskEventTable.stepId, setup.stepId))
        .all()
      expect(events.map((event) => event.eventType)).toEqual([
        TaskEventType.STEP_STARTED,
        TaskEventType.STEP_BLOCKED,
        TaskEventType.STEP_RESUMED,
      ])
    } finally {
      await server.close()
    }
  })

  it("transitions blocked to orphaned when the linked session is unavailable and can retry in a new session", async () => {
    const setup = await setupTask("prj_block_orphan")

    setStepSession(
      {
        taskId: setup.taskId,
        stepId: setup.stepId,
        sessionId: "sess_missing",
        baseUrl: "http://127.0.0.1:1",
      },
      db(),
    )

    blockStep({
      taskId: setup.taskId,
      stepId: setup.stepId,
      blockPayload: {
        code: "needs_external_input",
        message: "Waiting on external approval",
      },
    })

    const orphaned = await resumeBlockedStep({
      taskId: setup.taskId,
      stepId: setup.stepId,
    })

    expect(orphaned).toMatchObject({
      taskId: setup.taskId,
      stepId: setup.stepId,
      status: "orphaned",
      orphanedReason: {
        code: "missing_session",
        message: `OpenCode session for blocked step ${setup.stepId} is unavailable`,
        details: {
          sessionId: "sess_missing",
          opencodeBaseUrl: "http://127.0.0.1:1",
        },
      },
    })

    const orphanedRow = db().select().from(stepTable).where(eq(stepTable.stepId, setup.stepId)).get()
    expect(orphanedRow?.status).toBe("orphaned")
    expect(JSON.parse(orphanedRow?.orphanedReasonJson ?? "null")).toMatchObject({
      code: "missing_session",
      message: `OpenCode session for blocked step ${setup.stepId} is unavailable`,
      details: {
        sessionId: "sess_missing",
        opencodeBaseUrl: "http://127.0.0.1:1",
      },
    })

    const retried = retryOrphanedStepInNewSession({
      taskId: setup.taskId,
      stepId: setup.stepId,
    })
    expect(retried).toEqual({
      taskId: setup.taskId,
      stepId: setup.stepId,
      status: "active",
    })

    const retriedRow = db().select().from(stepTable).where(eq(stepTable.stepId, setup.stepId)).get()
    expect(retriedRow?.status).toBe("active")
    expect(retriedRow?.sessionId).toBeNull()
    expect(retriedRow?.opencodeBaseUrl).toBeNull()
    expect(retriedRow?.orphanedReasonJson).toBeNull()
    expect(JSON.parse(retriedRow?.blockPayloadJson ?? "null")).toEqual({
      code: "needs_external_input",
      message: "Waiting on external approval",
    })

    const events = db()
      .select()
      .from(taskEventTable)
      .where(eq(taskEventTable.stepId, setup.stepId))
      .all()
    expect(events.map((event) => event.eventType)).toEqual([
      TaskEventType.STEP_STARTED,
      TaskEventType.STEP_BLOCKED,
      TaskEventType.STEP_ORPHANED,
    ])
  })

  it("rejects resume when a blocked step has no persisted session linkage", async () => {
    const setup = await setupTask("prj_block_missing_session")

    db()
      .update(stepTable)
      .set({
        status: "blocked",
        blockPayloadJson: JSON.stringify({ code: "needs_input", message: "Need operator input" }),
      })
      .where(eq(stepTable.stepId, setup.stepId))
      .run()

    await expect(
      resumeBlockedStep({
        taskId: setup.taskId,
        stepId: setup.stepId,
      }),
    ).rejects.toMatchObject({
      code: "STEP_SESSION_MISSING",
      status: 409,
      message: `Blocked step ${setup.stepId} is missing required session linkage`,
    })

    const row = db().select().from(stepTable).where(eq(stepTable.stepId, setup.stepId)).get()
    expect(row?.status).toBe("blocked")
  })
})
