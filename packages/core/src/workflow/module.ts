import type { z } from "zod"

export const SONATA_WORKFLOW_API_VERSION = 1

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[]

export type JsonSchema = Record<string, unknown>

export type ArtifactKind = "markdown" | "json"

export type ArtifactRef = {
  kind: ArtifactKind
  path: string
}

export type StepStartedEvent = { type: "step.started" }
export type StepBlockedEvent = { type: "step.blocked" }
export type StepCompletedEvent = { type: "step.completed" }
export type StepFailedEvent = { type: "step.failed"; error: Error }

export type StepBaseEvent =
  | StepStartedEvent
  | StepBlockedEvent
  | StepCompletedEvent
  | StepFailedEvent

export type OpenCodeStartedEvent = {
  type: "opencode.started"
  sessionId: string
  reused: boolean
}

export type OpenCodeCompleteEvent = {
  type: "opencode.complete"
  manual: boolean
  sessionId: string
  messageId?: string
}

export type WorkflowStepArtifactMarkdown = {
  name: string
  kind: "markdown"
  required?: boolean
  once?: boolean
  description?: string
}

export type WorkflowStepArtifactJson<TSchema extends z.ZodTypeAny> = {
  name: string
  kind: "json"
  schema: TSchema
  required?: boolean
  once?: boolean
  description?: string
}

export type WorkflowStepArtifact =
  | WorkflowStepArtifactMarkdown
  | WorkflowStepArtifactJson<z.ZodTypeAny>

export type WorkflowStepInputArtifactSelectorMode = "latest" | "all" | "indices"

export type WorkflowStepInputArtifact = {
  as: string
  from: {
    step: string
    artifact: string
  }
  cardinality:
    | {
      mode: "single"
      required?: boolean
    }
    | {
      mode: "multiple"
      min?: number
      max?: number
    }
}

export type WorkflowStepInvocationInput = {
  schema: z.ZodTypeAny
}

export type WorkflowStepInputs = {
  artifacts?: WorkflowStepInputArtifact[]
  invocation?: WorkflowStepInvocationInput
}

export type OpenCodeConfig = {
  kickoffPrompt: string
  allowManualComplete?: boolean
}

export function openCodeConfig(input: {
  kickoffPrompt: string
  allowManualComplete?: boolean
}): OpenCodeConfig {
  return input
}

export type StepContextBase = {
  repoRoot: string
  taskId: string
  stepId: string
  writeMarkdownArtifact: (params: {
    slug: string
    markdown: string
  }) => Promise<ArtifactRef>
  writeJsonArtifact: (params: {
    slug: string
    data: JsonValue
    schema?: JsonSchema
  }) => Promise<ArtifactRef>
}

export type StepContextWithOpenCode = StepContextBase & {
  opencode: {
    start: (params?: { title?: string; kickoffPrompt?: string }) => Promise<void>
  }
}

export type WorkflowStepWithoutOpenCode = {
  id: string
  title: string
  description?: string
  next?: string
  inputs?: WorkflowStepInputs
  artifacts?: WorkflowStepArtifact[]
  run: (ctx: StepContextBase) => Promise<void> | void
  on: (ctx: StepContextBase, event: StepBaseEvent) => Promise<void> | void
  opencode?: undefined
}

export type WorkflowStepWithOpenCode = {
  id: string
  title: string
  description?: string
  next?: string
  inputs?: WorkflowStepInputs
  artifacts?: WorkflowStepArtifact[]
  opencode: OpenCodeConfig
  run: (ctx: StepContextWithOpenCode) => Promise<void> | void
  on: (
    ctx: StepContextWithOpenCode,
    event: StepBaseEvent | OpenCodeStartedEvent | OpenCodeCompleteEvent,
  ) => Promise<void> | void
}

export type WorkflowStep = WorkflowStepWithoutOpenCode | WorkflowStepWithOpenCode

export function defineWorkflowStep(step: WorkflowStepWithOpenCode): WorkflowStepWithOpenCode
export function defineWorkflowStep(step: WorkflowStepWithoutOpenCode): WorkflowStepWithoutOpenCode
export function defineWorkflowStep(step: WorkflowStep): WorkflowStep {
  return step
}

export const defineStep = defineWorkflowStep

export type SonataWorkflowModule = {
  apiVersion: typeof SONATA_WORKFLOW_API_VERSION
  id: string
  version: string
  name: string
  description?: string
  steps: WorkflowStep[]
}

export function defineWorkflow(module: SonataWorkflowModule): SonataWorkflowModule {
  return module
}

export function isSonataWorkflowModule(value: unknown): value is SonataWorkflowModule {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as Partial<SonataWorkflowModule>
  return (
    candidate.apiVersion === SONATA_WORKFLOW_API_VERSION &&
    typeof candidate.id === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.name === "string" &&
    Array.isArray(candidate.steps)
  )
}

export function assertSonataWorkflowModule(value: unknown): asserts value is SonataWorkflowModule {
  if (!isSonataWorkflowModule(value)) {
    throw new Error(
      "Workflow module default export must match SonataWorkflowModule (apiVersion, id, version, name, steps).",
    )
  }
}
