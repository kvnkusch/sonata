import { eq } from "drizzle-orm"
import { db, taskTable, stepTable, type DbExecutor } from "../db"
import { RpcError, ErrorCode } from "../rpc/base"
import { loadWorkflowStepForTask } from "../workflow/loader"
import type { WorkflowStepArtifact } from "../workflow/module"
import { zodToStrictJsonSchema } from "../workflow/json-schema"

function isZodSchema(value: unknown): value is { _zod: object } {
  return typeof value === "object" && value !== null && "_zod" in value
}

function toSafeToolName(value: string): string {
  const slug = value
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
  return slug || "artifact"
}

function artifactInputSchema(artifact: WorkflowStepArtifact): Record<string, unknown> {
  if (artifact.kind === "markdown") {
    return {
      type: "object",
      properties: {
        markdown: { type: "string", minLength: 1 },
      },
      required: ["markdown"],
      additionalProperties: false,
    }
  }

  return {
    type: "object",
    properties: {
      data: isZodSchema(artifact.schema) ? zodToStrictJsonSchema(artifact.schema) : {},
    },
    required: ["data"],
    additionalProperties: false,
  }
}

export async function getStepToolset(
  input: { taskId: string; stepId: string },
  executor: DbExecutor = db(),
) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  const step = executor
    .select()
    .from(stepTable)
    .where(eq(stepTable.stepId, input.stepId))
    .get()
  if (!step || step.taskId !== task.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
  }

  const { loaded, step: workflowStep } = await loadWorkflowStepForTask({
    taskId: input.taskId,
    stepKey: step.stepKey,
    tx: executor,
  })

  const artifactDeclarations = workflowStep.artifacts ?? []
  const inputDeclarations = workflowStep.inputs?.artifacts ?? []
  const artifacts = artifactDeclarations.map((artifact) => ({
    name: artifact.name,
    kind: artifact.kind,
    required: Boolean(artifact.required),
    once: artifact.once !== false,
    schema: artifact.kind === "json" && isZodSchema(artifact.schema) ? zodToStrictJsonSchema(artifact.schema) : undefined,
  }))

  const writeTools = artifactDeclarations.map((artifact) => {
    const safe = toSafeToolName(artifact.name)
    return {
      name: `sonata_write_${safe}_artifact_${artifact.kind}`,
      description: `Write ${artifact.name} ${artifact.kind} artifact for the current Sonata step`,
      artifactName: artifact.name,
      artifactKind: artifact.kind,
      inputSchema: artifactInputSchema(artifact),
    }
  })

  const completeTool = {
    name: "sonata_complete_step",
    description: "Complete current Sonata step",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  }

  return {
    taskId: task.taskId,
    workflowId: loaded.workflow.id,
    stepId: step.stepId,
    stepKey: step.stepKey,
    stepIndex: step.stepIndex,
    inputs: inputDeclarations.map((input) => ({
      as: input.as,
      from: input.from,
      cardinality: input.cardinality,
    })),
    artifacts,
    tools: [...writeTools, completeTool],
  }
}
