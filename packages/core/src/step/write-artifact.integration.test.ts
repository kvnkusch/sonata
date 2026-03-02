import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { artifactTable, closeDb, db, taskEventTable } from "../db"
import { linkOpsRepo } from "../project"
import { ErrorCode } from "../rpc/base"
import { startTask } from "../task"
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
      artifacts: [
        { name: "ticket_summary", kind: "markdown", required: true, once: true },
        { name: "plan_structured", kind: "json", once: false, schema: { parse: (value) => value } },
      ],
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

describe("step.writeArtifact integration", () => {
  it("writes markdown/json artifacts and persists artifact + task_event rows", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-write-artifact-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const { linked } = db().transaction((tx) => {
      const linked = linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_write_artifact" }, tx)
      return { linked }
    })

    const started = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const initial = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const markdownResult = await writeStepArtifact({
      taskId: started.taskId,
      stepId: initial.stepId,
      artifactName: "ticket_summary",
      artifactKind: "markdown",
      payload: { markdown: "## Ticket Summary" },
      sessionId: "session-a",
    })

    const jsonResult = await writeStepArtifact({
      taskId: started.taskId,
      stepId: initial.stepId,
      artifactName: "plan_structured",
      artifactKind: "json",
      payload: { data: { bullets: ["a", "b"] } },
      sessionId: "session-a",
    })

    const markdownPath = path.join(opsRoot, markdownResult.relativePath)
    const jsonPath = path.join(opsRoot, jsonResult.relativePath)

    expect(markdownResult.relativePath).toContain(`tasks/${started.taskId}/001-plan-ticket-summary.md`)
    expect(jsonResult.relativePath).toContain(`tasks/${started.taskId}/001-plan-plan-structured.json`)
    expect(readFileSync(markdownPath, "utf8")).toBe("## Ticket Summary\n")
    expect(readFileSync(jsonPath, "utf8")).toContain('"bullets"')

    const artifactRows = db().select().from(artifactTable).all()
    const eventRows = db().select().from(taskEventTable).all()

    expect(artifactRows).toHaveLength(2)
    expect(eventRows.filter((row) => row.eventType === "artifact.written")).toHaveLength(2)
    expect(eventRows.every((row) => row.eventVersion === 1)).toBe(true)
  })

  it("treats same-content replay as idempotent and rejects changed write-once content", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-write-artifact-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_write_once" }, tx)
    })

    const started = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const initial = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const first = await writeStepArtifact({
      taskId: started.taskId,
      stepId: initial.stepId,
      artifactName: "ticket_summary",
      artifactKind: "markdown",
      payload: { markdown: "First write" },
    })

    const replay = await writeStepArtifact({
      taskId: started.taskId,
      stepId: initial.stepId,
      artifactName: "ticket_summary",
      artifactKind: "markdown",
      payload: { markdown: "First write" },
    })

    expect(replay.contentHash).toBe(first.contentHash)
    expect(db().select().from(artifactTable).all()).toHaveLength(1)
    expect(db().select().from(taskEventTable).where(eq(taskEventTable.eventType, "artifact.written")).all()).toHaveLength(1)

    await expect(
      writeStepArtifact({
        taskId: started.taskId,
        stepId: initial.stepId,
        artifactName: "ticket_summary",
        artifactKind: "markdown",
        payload: { markdown: "Second write" },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.ARTIFACT_WRITE_ONCE_VIOLATION,
    })
  })

  it("keeps artifact writes isolated across concurrent tasks", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-write-artifact-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_concurrent" }, tx)
    })

    const [taskA, taskB] = await Promise.all([
      startTask({ projectId: linked.projectId, workflowRef: { name: "default" } }),
      startTask({ projectId: linked.projectId, workflowRef: { name: "default" } }),
    ])
    const [stepA, stepB] = await Promise.all([
      startStep({ taskId: taskA.taskId, stepKey: "plan" }),
      startStep({ taskId: taskB.taskId, stepKey: "plan" }),
    ])

    const [resultA, resultB] = await Promise.all([
      writeStepArtifact({
        taskId: taskA.taskId,
        stepId: stepA.stepId,
        artifactName: "ticket_summary",
        artifactKind: "markdown",
        payload: { markdown: "Task A" },
      }),
      writeStepArtifact({
        taskId: taskB.taskId,
        stepId: stepB.stepId,
        artifactName: "ticket_summary",
        artifactKind: "markdown",
        payload: { markdown: "Task B" },
      }),
    ])

    expect(resultA.relativePath).not.toBe(resultB.relativePath)
    expect(readFileSync(path.join(opsRoot, resultA.relativePath), "utf8")).toBe("Task A\n")
    expect(readFileSync(path.join(opsRoot, resultB.relativePath), "utf8")).toBe("Task B\n")

    const rows = db().select().from(artifactTable).all()
    expect(rows.map((row) => row.taskId).sort()).toEqual([taskA.taskId, taskB.taskId].sort())
  })
})
