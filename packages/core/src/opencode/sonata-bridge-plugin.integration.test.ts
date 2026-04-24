import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { closeDb, db } from "../db"
import { linkOpsRepo } from "../project"
import { ErrorCode } from "../rpc/base"
import { startStep } from "../step"
import { startTask } from "../task"
import { SonataBridgePlugin } from "./sonata-bridge-plugin"

const tempDirs: string[] = []

afterEach(() => {
  closeDb()
  delete process.env.SONATA_DB_PATH
  delete process.env.SONATA_TASK_ID
  delete process.env.SONATA_STEP_ID
  delete process.env.SONATA_PROJECT_ROOT
  delete process.env.SONATA_OPS_ROOT
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("Sonata bridge plugin integration", () => {
  it("publishes the strict json artifact schema and rejects invalid variants", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-bridge-plugin-"))
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
      artifacts: [{ name: "plan_structured", kind: "json", required: true, once: true, schema: { parse: (value) => value } }],
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
      return linkOpsRepo({ projectRoot, opsRoot, projectId: "prj_bridge_plugin" }, tx)
    })
    const started = await startTask({
      projectId: linked.projectId,
      workflowRef: { name: "default" },
    })
    const step = await startStep({ taskId: started.taskId, stepKey: "plan" })

    process.env.SONATA_TASK_ID = started.taskId
    process.env.SONATA_STEP_ID = step.stepId
    process.env.SONATA_PROJECT_ROOT = projectRoot
    process.env.SONATA_OPS_ROOT = opsRoot

    const plugin = await SonataBridgePlugin({} as never)
    const toolName = "sonata_write_plan_structured_artifact_json"
    const artifactTool = plugin.tool?.[toolName]
    expect(artifactTool).toBeDefined()
    expect(plugin["tool.definition"]).toBeDefined()

    const definition = { description: "", parameters: {} as Record<string, unknown> }
    await plugin["tool.definition"]?.({ toolID: toolName }, definition)
    expect(definition.parameters).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      anyOf: [
        {
          type: "object",
          properties: {
            source: { type: "string", const: "inline" },
            data: {},
          },
          required: ["source", "data"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            source: { type: "string", const: "file" },
            filePath: {
              type: "string",
              minLength: 1,
              description: "Path under opsRoot/.sonata/staging/<taskId>/<stepId>/ containing the JSON payload to import",
            },
          },
          required: ["source", "filePath"],
          additionalProperties: false,
        },
      ],
    })

    await expect(
      artifactTool?.execute(
        { source: "file", data: { nope: true } } as never,
        { sessionID: "session-plugin" } as never,
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
      message: expect.stringContaining("filePath"),
    })
  })
})
