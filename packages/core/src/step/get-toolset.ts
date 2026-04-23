import { eq } from "drizzle-orm"
import z from "zod"
import { db, taskTable, stepTable, type DbExecutor } from "../db"
import { RpcError, ErrorCode } from "../rpc/base"
import { loadWorkflowStepForTask } from "../workflow/loader"
import type { OpenCodeTools, WorkflowStepArtifact } from "../workflow/module"
import { zodToStrictJsonSchema } from "../workflow/json-schema"

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return typeof value === "object" && value !== null && "_zod" in value && "parse" in value
}

export const SONATA_COMPLETE_TOOL_NAME = "sonata_complete_step"
export const SONATA_BLOCK_TOOL_NAME = "sonata_block_step"

function toNormalizedToolName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
}

export function toSafeToolName(value: string): string {
  const slug = toNormalizedToolName(value)
  return slug || "artifact"
}

function toSafeCustomToolNamePart(value: string): string {
  const safe = toNormalizedToolName(value)
  if (!safe) {
    throw new RpcError(ErrorCode.INVALID_INPUT, 400, `Tool identifier normalizes to an empty name: ${value}`)
  }
  return safe
}

export function resolveCustomToolName(input: { stepKey: string; toolId: string }): string {
  return `sonata_step_${toSafeCustomToolNamePart(input.stepKey)}__${toSafeCustomToolNamePart(input.toolId)}`
}

export function resolveCustomToolNameMap(input: {
  stepKey: string
  tools?: OpenCodeTools
}): Record<string, { name: string }> {
  const tools = input.tools ?? {}
  const entries = Object.keys(tools).map((toolId) => [toolId, { name: resolveCustomToolName({ stepKey: input.stepKey, toolId }) }] as const)
  return Object.fromEntries(entries)
}

type WriteArtifactToolDeclaration = {
  name: string
  description: string
  artifactName: string
  artifactKind: "markdown" | "json"
  inputSchema: Record<string, unknown>
  argsSchema: Record<string, unknown>
}

type CompleteToolDeclaration = {
  name: typeof SONATA_COMPLETE_TOOL_NAME
  description: string
  inputSchema: Record<string, unknown>
  argsSchema: Record<string, unknown>
}

type BlockToolDeclaration = {
  name: typeof SONATA_BLOCK_TOOL_NAME
  description: string
  inputSchema: Record<string, unknown>
  argsSchema: Record<string, unknown>
}

type CustomToolDeclaration = {
  name: string
  description: string
  customToolId: string
  inputSchema: Record<string, unknown>
  argsSchema: Record<string, unknown>
}

export type StepToolDeclaration =
  | WriteArtifactToolDeclaration
  | BlockToolDeclaration
  | CompleteToolDeclaration
  | CustomToolDeclaration

function customToolInputSchema(tool: { argsSchema: Record<string, unknown> }): Record<string, unknown> {
  return zodToStrictJsonSchema(z.object(tool.argsSchema as z.ZodRawShape).strict())
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

  const writeTools: WriteArtifactToolDeclaration[] = artifactDeclarations.map((artifact) => {
    const safe = toSafeToolName(artifact.name)
    return {
      name: `sonata_write_${safe}_artifact_${artifact.kind}`,
      description: `Write ${artifact.name} ${artifact.kind} artifact for the current Sonata step`,
      artifactName: artifact.name,
      artifactKind: artifact.kind,
      inputSchema: artifactInputSchema(artifact),
      argsSchema:
        artifact.kind === "markdown"
          ? { markdown: z.string().min(1) }
          : { data: z.unknown() },
    }
  })

  const reservedNames = new Set<string>([
    ...writeTools.map((tool) => tool.name),
    SONATA_BLOCK_TOOL_NAME,
    SONATA_COMPLETE_TOOL_NAME,
  ])

  const customTools = workflowStep.opencode?.tools ?? {}
  const resolvedCustomByName = new Map<string, string>()
  const customToolEntries = Object.entries(customTools).sort(([a], [b]) => a.localeCompare(b))
  const customToolDeclarations: CustomToolDeclaration[] = customToolEntries.map(([toolId, toolDef]) => {
    const resolvedName = resolveCustomToolName({ stepKey: step.stepKey, toolId })

    const collidingToolId = resolvedCustomByName.get(resolvedName)
    if (collidingToolId) {
      throw new RpcError(
        ErrorCode.INVALID_INPUT,
        400,
        `Custom tool ids normalize to the same OpenCode tool name for step ${step.stepKey}: ${collidingToolId}, ${toolId}`,
      )
    }

    if (reservedNames.has(resolvedName)) {
      throw new RpcError(
        ErrorCode.INVALID_INPUT,
        400,
        `Resolved OpenCode tool name collides with a reserved Sonata bridge tool for step ${step.stepKey}: ${resolvedName}`,
      )
    }

    resolvedCustomByName.set(resolvedName, toolId)

    return {
      name: resolvedName,
      description: toolDef.description,
      customToolId: toolId,
      inputSchema: customToolInputSchema(toolDef),
      argsSchema: toolDef.argsSchema as Record<string, unknown>,
    }
  })

  const blockTool: BlockToolDeclaration = {
    name: SONATA_BLOCK_TOOL_NAME,
    description: "Block current Sonata step until external input is available",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        details: {},
        resumeHint: { type: "string", minLength: 1 },
      },
      required: ["code", "message"],
      additionalProperties: false,
    },
    argsSchema: {
      code: z.string().min(1),
      message: z.string().min(1),
      details: z.unknown().optional(),
      resumeHint: z.string().min(1).optional(),
    },
  }

  const completeTool: CompleteToolDeclaration = {
    name: SONATA_COMPLETE_TOOL_NAME,
    description: "Complete current Sonata step",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    argsSchema: {},
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
    tools: [
      ...writeTools,
      ...customToolDeclarations,
      ...(workflowStep.opencode ? [blockTool] : []),
      completeTool,
    ] as StepToolDeclaration[],
  }
}
