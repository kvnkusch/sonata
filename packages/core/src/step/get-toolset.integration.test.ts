import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeDb, db } from "../db"
import { linkOpsRepo } from "../project"
import { startTask } from "../task"
import { getStepToolset } from "./get-toolset"
import { startStep } from "./start"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("step.getToolset integration", () => {
  it("returns deterministic artifact and tool declarations", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-toolset-"))
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
      id: "plan",
      title: "Plan",
      artifacts: [
        { name: "ticket_summary", kind: "markdown", required: true, once: true },
        { name: "plan_structured", kind: "json", required: false, once: true, schema: { parse: (value) => value } },
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

    process.env.SONATA_DB_PATH = path.join(sandbox, "db", "sonata.db")

    const linked = db().transaction((tx) => {
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_toolset" }, tx)
    })

    const started = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const initial = await startStep({ taskId: started.taskId, stepKey: "plan" })

    const toolsetA = await getStepToolset({
      taskId: started.taskId,
      stepId: initial.stepId,
    })
    const toolsetB = await getStepToolset({
      taskId: started.taskId,
      stepId: initial.stepId,
    })

    expect(toolsetA).toEqual(toolsetB)
    expect(toolsetA.artifacts.map((artifact) => artifact.name)).toEqual([
      "ticket_summary",
      "plan_structured",
    ])
    expect(toolsetA.tools.map((tool) => tool.name)).toEqual([
      "sonata_write_ticket_summary_artifact_markdown",
      "sonata_write_plan_structured_artifact_json",
      "sonata_complete_step",
    ])
  })
})
