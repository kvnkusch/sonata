import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeDb, db } from "../db"
import { linkOpsRepo } from "../project"
import { ErrorCode } from "./base"
import { createCaller } from "./caller"

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
      artifacts: [{ name: "ticket_summary", kind: "markdown", required: true, once: true }],
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

describe("rpc error contract", () => {
  it("returns stable code/status/message for expected failures", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-rpc-errors-"))
    tempDirs.push(sandbox)

    const projectRoot = path.join(sandbox, "project")
    const opsRoot = path.join(sandbox, "ops")
    mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    mkdirSync(opsRoot, { recursive: true })
    writeOpsWorkflowFiles(opsRoot)

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_rpc_errors" }, tx)
    })

    const caller = createCaller()
    const started = await caller.task.start({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })

    await expect(
      caller.step.writeArtifact({
        taskId: started.taskId,
        stepId: started.currentStepId,
        artifactName: "not_declared",
        artifactKind: "markdown",
        payload: { markdown: "x" },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.ARTIFACT_NOT_DECLARED,
      status: 400,
      message: expect.stringContaining("not_declared"),
    })

    await expect(
      caller.step.complete({
        taskId: started.taskId,
        stepId: started.currentStepId,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.REQUIRED_ARTIFACT_MISSING,
      status: 409,
      message: expect.stringContaining("missing required artifacts"),
    })

    await caller.step.writeArtifact({
      taskId: started.taskId,
      stepId: started.currentStepId,
      artifactName: "ticket_summary",
      artifactKind: "markdown",
      payload: { markdown: "ready" },
    })

    await caller.step.complete({
      taskId: started.taskId,
      stepId: started.currentStepId,
    })

    await expect(
      caller.step.complete({
        taskId: started.taskId,
        stepId: started.currentStepId,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_STEP_TRANSITION,
      status: 409,
      message: expect.stringContaining("Cannot complete"),
    })
  })
})
