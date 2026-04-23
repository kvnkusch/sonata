import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { closeDb, db, stepTable } from "../db"
import { linkOpsRepo } from "../project"
import { ErrorCode } from "../rpc/base"
import { startTask } from "../task"
import { listChildSteps, readChildArtifacts, spawnChildStep, startStep, summarizeChildSteps, writeStepArtifact } from "../step"
import { completeStep } from "./complete"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function setupSandbox(name: string) {
  const sandbox = mkdtempSync(path.join(tmpdir(), `sonata-step-children-${name}-`))
  tempDirs.push(sandbox)

  const projectRoot = path.join(sandbox, "project")
  const opsRoot = path.join(sandbox, "ops")
  mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
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
      id: "intake",
      title: "Intake",
      artifacts: [{ name: "topic", kind: "markdown", required: true, once: true }],
      async run() {},
      async on() {},
    },
    {
      id: "controller",
      title: "Controller",
      async run() {},
      async on() {},
    },
    {
      id: "worker",
      title: "Worker",
      inputs: {
        invocation: {
          schema: {
            parse(input) {
              return input
            },
          },
        },
        artifacts: [
          {
            as: "topic",
            from: { step: "intake", artifact: "topic" },
            cardinality: { mode: "single", required: true },
          },
        ],
      },
      artifacts: [{ name: "report", kind: "markdown", required: false, once: true }],
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
  const linked = db().transaction((tx) => linkOpsRepo({ projectRoot, opsRoot, projectId: `prj_${name}` }, tx))
  return { linked, opsRoot }
}

async function setupControllerTask(name: string) {
  const { linked, opsRoot } = setupSandbox(name)
  const task = await startTask({ projectId: linked.projectId })

  const intake1 = await startStep({ taskId: task.taskId, stepKey: "intake" })
  await writeStepArtifact({
    taskId: task.taskId,
    stepId: intake1.stepId,
    artifactName: "topic",
    artifactKind: "markdown",
    payload: { markdown: "topic one" },
  })
  await completeStep({ taskId: task.taskId, stepId: intake1.stepId })

  const intake2 = await startStep({ taskId: task.taskId, stepKey: "intake" })
  await writeStepArtifact({
    taskId: task.taskId,
    stepId: intake2.stepId,
    artifactName: "topic",
    artifactKind: "markdown",
    payload: { markdown: "topic two" },
  })
  await completeStep({ taskId: task.taskId, stepId: intake2.stepId })

  const controller = await startStep({ taskId: task.taskId, stepKey: "controller" })
  return { taskId: task.taskId, controllerStepId: controller.stepId, opsRoot }
}

describe("step.children integration", () => {
  it("reuses an existing child when spawn inputs are equivalent", async () => {
    const { taskId, controllerStepId } = await setupControllerTask("idempotent-spawn")

    const first = await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "alpha",
      invocation: { priority: "high" },
      artifactSelections: { topic: { mode: "indices", indices: [1] } },
    })
    const second = await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "alpha",
      invocation: { priority: "high" },
      artifactSelections: { topic: { mode: "indices", indices: [1] } },
    })

    expect(first.existing).toBe(false)
    expect(second).toMatchObject({ stepId: first.stepId, existing: true, workKey: "alpha" })
  })

  it("rejects conflicting child spawn requests for the same identity", async () => {
    const { taskId, controllerStepId } = await setupControllerTask("conflicting-spawn")

    await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "alpha",
      invocation: { priority: "high" },
      artifactSelections: { topic: { mode: "indices", indices: [1] } },
    })

    await expect(
      spawnChildStep({
        taskId,
        parentStepId: controllerStepId,
        stepKey: "worker",
        workKey: "alpha",
        invocation: { priority: "low" },
        artifactSelections: { topic: { mode: "latest" } },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CHILD_STEP_CONFLICT })
  })

  it("rejects respawn when raw artifact selections differ even if frozen inputs are equivalent", async () => {
    const { taskId, controllerStepId } = await setupControllerTask("conflicting-default-selection")

    await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "alpha",
    })

    await expect(
      spawnChildStep({
        taskId,
        parentStepId: controllerStepId,
        stepKey: "worker",
        workKey: "alpha",
        artifactSelections: { topic: { mode: "latest" } },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CHILD_STEP_CONFLICT })
  })

  it("lists children and summarizes counts by status", async () => {
    const { taskId, controllerStepId } = await setupControllerTask("list-summary")

    const alpha = await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "alpha",
    })
    const beta = await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "beta",
    })
    const gamma = await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "gamma",
    })

    db().update(stepTable).set({ status: "completed" }).where(eq(stepTable.stepId, beta.stepId)).run()
    db().update(stepTable).set({ status: "failed" }).where(eq(stepTable.stepId, gamma.stepId)).run()

    const children = listChildSteps({ taskId, parentStepId: controllerStepId, stepKey: "worker" })
    const summary = summarizeChildSteps({ taskId, parentStepId: controllerStepId, stepKey: "worker" })

    expect(children.map((child) => [child.workKey, child.status])).toEqual([
      ["alpha", "active"],
      ["beta", "completed"],
      ["gamma", "failed"],
    ])
    expect(summary).toEqual({
      stepKey: "worker",
      totalCount: 3,
      pendingCount: 0,
      activeCount: 1,
      blockedCount: 0,
      orphanedCount: 0,
      completedCount: 1,
      failedCount: 1,
      cancelledCount: 0,
      incompleteWorkKeys: ["alpha"],
      blockedWorkKeys: [],
      orphanedWorkKeys: [],
    })
    expect(alpha.existing).toBe(false)
  })

  it("treats missing requested workKeys as pending incomplete work", async () => {
    const { taskId, controllerStepId } = await setupControllerTask("summary-missing-workkeys")

    const alpha = await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "alpha",
    })
    db().update(stepTable).set({ status: "completed" }).where(eq(stepTable.stepId, alpha.stepId)).run()

    const summary = summarizeChildSteps({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKeys: ["alpha", "beta"],
    })

    expect(summary).toEqual({
      stepKey: "worker",
      totalCount: 2,
      pendingCount: 1,
      activeCount: 0,
      blockedCount: 0,
      orphanedCount: 0,
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      incompleteWorkKeys: ["beta"],
      blockedWorkKeys: [],
      orphanedWorkKeys: [],
    })
  })

  it("reads child artifacts scoped by workKey", async () => {
    const { taskId, controllerStepId, opsRoot } = await setupControllerTask("read-artifacts")

    const alpha = await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "alpha",
    })
    const beta = await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "beta",
    })

    await writeStepArtifact({
      taskId,
      stepId: alpha.stepId,
      artifactName: "report",
      artifactKind: "markdown",
      payload: { markdown: "alpha report" },
    })
    await writeStepArtifact({
      taskId,
      stepId: beta.stepId,
      artifactName: "report",
      artifactKind: "markdown",
      payload: { markdown: "beta report" },
    })

    const scoped = readChildArtifacts({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      artifactName: "report",
      workKeys: ["beta"],
    })

    expect(scoped).toHaveLength(1)
    expect(scoped[0]).toMatchObject({
      stepId: beta.stepId,
      stepKey: "worker",
      workKey: "beta",
      artifactName: "report",
      artifactKind: "markdown",
    })
    expect(path.isAbsolute(scoped[0]!.relativePath)).toBe(false)
    expect(path.resolve(opsRoot, scoped[0]!.relativePath).startsWith(opsRoot)).toBe(true)
  })

  it("prevents root completion while child steps are still open", async () => {
    const { taskId, controllerStepId } = await setupControllerTask("open-child-completion-guard")

    const child = await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "alpha",
    })

    await expect(
      completeStep({
        taskId,
        stepId: controllerStepId,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.STEP_COMPLETION_GUARD_REJECTED,
      details: {
        details: {
          guardCode: "open_child_steps",
          guardDetails: {
            openChildStepIds: [child.stepId],
            openChildWorkKeys: ["alpha"],
          },
        },
      },
    })

    const controller = db().select().from(stepTable).where(eq(stepTable.stepId, controllerStepId)).get()
    expect(controller?.status).toBe("active")
  })

  it("rejects direct nested child spawning through spawnChildStep", async () => {
    const { taskId, controllerStepId } = await setupControllerTask("nested-child-guard")

    const child = await spawnChildStep({
      taskId,
      parentStepId: controllerStepId,
      stepKey: "worker",
      workKey: "alpha",
    })

    await expect(
      spawnChildStep({
        taskId,
        parentStepId: child.stepId,
        stepKey: "worker",
        workKey: "nested",
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
      status: 409,
      message: `Only root steps may spawn child steps: ${child.stepId}`,
    })
  })
})
