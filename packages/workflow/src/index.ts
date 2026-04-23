export const SONATA_WORKFLOW_API_VERSION = 1

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[]

export type JsonSchema = Record<string, unknown>

type SchemaParser = {
  parse: (input: unknown) => unknown
}

type SchemaOutput<TSchema> = TSchema extends { _output: infer TOutput }
  ? TOutput
  : TSchema extends { parse: (...args: never[]) => infer TOutput }
    ? TOutput
    : unknown

export type ArtifactKind = "markdown" | "json"

export type ArtifactRef = {
  kind: ArtifactKind
  path: string
}

export type StepInputsSnapshotArtifactRef = {
  artifactName: string
  artifactKind: ArtifactKind
  relativePath: string
  stepId: string
  stepKey: string
  stepIndex: number
  writtenAt: number
}

export type StepInputsSnapshotArtifactSelectionMode = "latest" | "all" | "indices"

export type StepInputsSnapshot = {
  invocation?: JsonValue
  artifacts: Record<
    string,
    {
      mode: "single" | "multiple"
      selectedBy: StepInputsSnapshotArtifactSelectionMode
      refs: StepInputsSnapshotArtifactRef[]
    }
  >
}

export type StepInputArtifactValue = JsonValue | string

type InvocationField<TInvocation> = undefined extends TInvocation
  ? { invocation?: TInvocation }
  : { invocation: TInvocation }

export type StepInputArtifactSingle<TValue = StepInputArtifactValue, TRequired extends boolean = boolean> = TRequired extends true
  ? TValue
  : TValue | undefined

export type StepInputArtifactMultiple<TValue = StepInputArtifactValue> = TValue[]

export type StepInputArtifactBinding = StepInputArtifactSingle | StepInputArtifactMultiple

export type StepInputs<
  TInvocation = JsonValue | undefined,
  TArtifacts extends Record<string, StepInputArtifactBinding> = Record<string, StepInputArtifactBinding>,
> = InvocationField<TInvocation> & {
  artifacts: TArtifacts
}

export type StepRunComplete = {
  status: "completed"
  completionPayload?: unknown
}

export type StepRunFail = {
  status: "failed"
  reason: string
  details?: unknown
}

export type StepRunResult = StepRunComplete | StepRunFail

export type WaitSpec = {
  kind: "children"
  childStepKey: string
  workKeys?: string[]
  until: "all_completed" | "all_terminal"
  label?: string
  details?: JsonValue
}

export type CompletionGuardResult =
  | { ok: true }
  | { ok: false; code: string; message: string; details?: JsonValue }

export type ChildSpawnParams = {
  stepKey: string
  workKey: string
  invocation?: unknown
  artifactSelections?: Record<string, unknown>
}

export type ChildSummary = {
  stepKey: string
  totalCount: number
  pendingCount: number
  activeCount: number
  blockedCount: number
  orphanedCount: number
  completedCount: number
  failedCount: number
  cancelledCount: number
  incompleteWorkKeys: string[]
  blockedWorkKeys: string[]
  orphanedWorkKeys: string[]
}

export type ChildSpawnResult = {
  stepId: string
  stepKey: string
  workKey: string
  status: string
  existing: boolean
}

export type ChildListEntry = {
  stepId: string
  stepKey: string
  workKey: string | null
  status: string
}

export type ChildArtifactRef = {
  stepId: string
  stepKey: string
  workKey: string | null
  artifactName: string
  artifactKind: ArtifactKind
  relativePath: string
}

export type StepChildrenContext = {
  spawn: (params: ChildSpawnParams) => Promise<ChildSpawnResult>
  list: (params?: { stepKey?: string; workKeys?: string[] }) => Promise<ChildListEntry[]>
  summary: (params: { stepKey: string; workKeys?: string[] }) => Promise<ChildSummary>
  readArtifacts: (params: { stepKey: string; artifactName: string; workKeys?: string[] }) => Promise<ChildArtifactRef[]>
}

export const stepResult = {
  completed(input?: { completionPayload?: unknown }): StepRunComplete {
    return {
      status: "completed",
      completionPayload: input?.completionPayload,
    }
  },
  failed(input: { reason: string; details?: unknown }): StepRunFail {
    return {
      status: "failed",
      reason: input.reason,
      details: input.details,
    }
  },
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

export type WorkflowStepArtifactJson<TSchema extends SchemaParser = SchemaParser> = {
  name: string
  kind: "json"
  schema: TSchema
  required?: boolean
  once?: boolean
  description?: string
}

export type WorkflowStepArtifact =
  | WorkflowStepArtifactMarkdown
  | WorkflowStepArtifactJson

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
  schema: SchemaParser
}

export type WorkflowStepInputs = {
  artifacts?: readonly WorkflowStepInputArtifact[]
  invocation?: WorkflowStepInvocationInput
}

type AnyWorkflowStep = {
  id: string
  artifacts?: readonly WorkflowStepArtifact[]
  inputs?: WorkflowStepInputs
}

type InferInvocation<TStep extends AnyWorkflowStep> =
  TStep["inputs"] extends { invocation: { schema: infer TSchema extends SchemaParser } }
    ? SchemaOutput<TSchema>
    : undefined

type BindingsOf<TStep extends AnyWorkflowStep> =
  TStep["inputs"] extends { artifacts: infer TArtifacts extends readonly WorkflowStepInputArtifact[] }
    ? TArtifacts[number]
    : never

type StepById<TSteps extends readonly AnyWorkflowStep[], TStepId extends string> = Extract<TSteps[number], { id: TStepId }>

type ArtifactByName<TStep extends AnyWorkflowStep, TArtifactName extends string> =
  TStep["artifacts"] extends readonly WorkflowStepArtifact[]
    ? Extract<TStep["artifacts"][number], { name: TArtifactName }>
    : never

type InferArtifactValue<
  TSteps extends readonly AnyWorkflowStep[],
  TBinding extends WorkflowStepInputArtifact,
> = TBinding extends {
  from: { step: infer TFromStep extends string; artifact: infer TFromArtifact extends string }
}
  ? ArtifactByName<StepById<TSteps, TFromStep>, TFromArtifact> extends infer TArtifact
    ? TArtifact extends { kind: "markdown" }
      ? string
      : TArtifact extends { kind: "json"; schema: infer TSchema extends SchemaParser }
        ? SchemaOutput<TSchema>
        : TArtifact extends { kind: "json" }
          ? JsonValue
          : never
    : never
  : never

type InferArtifactBinding<
  TSteps extends readonly AnyWorkflowStep[],
  TBinding extends WorkflowStepInputArtifact,
> = TBinding extends {
  cardinality: infer TCardinality
}
  ? TCardinality extends { mode: "single"; required: false }
    ? StepInputArtifactSingle<InferArtifactValue<TSteps, TBinding>, false>
    : TCardinality extends { mode: "single" }
      ? StepInputArtifactSingle<InferArtifactValue<TSteps, TBinding>, true>
      : StepInputArtifactMultiple<InferArtifactValue<TSteps, TBinding>>
  : never

type InferArtifacts<
  TSteps extends readonly AnyWorkflowStep[],
  TStep extends AnyWorkflowStep,
> = [BindingsOf<TStep>] extends [never]
  ? Record<string, never>
  : {
    [TBinding in BindingsOf<TStep> as TBinding["as"]]: InferArtifactBinding<TSteps, TBinding>
  }

export type InferStepInputs<
  TSteps extends readonly AnyWorkflowStep[],
  TStep extends AnyWorkflowStep,
> = StepInputs<InferInvocation<TStep>, InferArtifacts<TSteps, TStep>>

export type OpenCodeToolContext = {
  repoRoot: string
  opsRoot: string
  taskId: string
  stepId: string
  sessionId?: string
}

type OpenCodeToolArgs<TArgsSchema extends Record<string, any>> = {
  [K in keyof TArgsSchema]: SchemaOutput<TArgsSchema[K]>
}

export type OpenCodeToolDef<TArgsSchema extends Record<string, any> = Record<string, any>> = {
  description: string
  argsSchema: TArgsSchema
  execute: (ctx: OpenCodeToolContext, args: OpenCodeToolArgs<TArgsSchema>) => Promise<JsonValue | string>
}

type OpenCodeToolInput = {
  description: string
  argsSchema: Record<string, any>
  execute: (ctx: OpenCodeToolContext, args: any) => Promise<JsonValue | string>
}

export type OpenCodeTools = Record<string, OpenCodeToolInput>

export type OpenCodeConfig<TTools extends OpenCodeTools = OpenCodeTools> = {
  tools?: TTools
}

export function openCodeTool<const TArgsSchema extends Record<string, any>>(
  tool: OpenCodeToolDef<TArgsSchema>,
): OpenCodeToolDef<TArgsSchema> {
  return tool
}

export function openCodeConfig(): OpenCodeConfig<Record<string, never>>
export function openCodeConfig<const TTools extends OpenCodeTools>(config: {
  tools: TTools
}): OpenCodeConfig<TTools>
export function openCodeConfig<const TTools extends OpenCodeTools>(config?: {
  tools: TTools
}): OpenCodeConfig<TTools> {
  return config ?? ({} as OpenCodeConfig<TTools>)
}

export type StepContextBase<
  TInputs extends StepInputs<unknown, Record<string, StepInputArtifactBinding>> = StepInputs,
  TMarkdownSlug extends string = string,
  TJsonArtifactData extends Record<string, JsonValue> = Record<string, JsonValue>,
> = {
  repoRoot: string
  opsRoot: string
  taskId: string
  stepId: string
  inputs: TInputs
  children: StepChildrenContext
  writeMarkdownArtifact: (params: {
    slug: TMarkdownSlug
    markdown: string
  }) => Promise<ArtifactRef>
  writeJsonArtifact: <TSlug extends keyof TJsonArtifactData & string>(params: {
    slug: TSlug
    data: TJsonArtifactData[TSlug]
    schema?: JsonSchema
  }) => Promise<ArtifactRef>
  completeStep: (payload?: unknown) => Promise<unknown>
  completeTask?: (payload?: unknown) => Promise<unknown>
}

export type StepContextWithOpenCode<
  TToolMapping extends Record<string, { name: string }> = Record<string, { name: string }>,
> = StepContextBase & {
  opencode: {
    start: (params: { title?: string; prompt: string }) => Promise<void>
    tools: TToolMapping
  }
}

export type WorkflowStepWithoutOpenCodeDefinition = {
  id: string
  title: string
  description?: string
  next?: string
  inputs?: WorkflowStepInputs
  artifacts?: readonly WorkflowStepArtifact[]
  opencode?: undefined
}

export type WorkflowStepWithOpenCodeDefinition<TTools extends OpenCodeTools = OpenCodeTools> = {
  id: string
  title: string
  description?: string
  next?: string
  inputs?: WorkflowStepInputs
  artifacts?: readonly WorkflowStepArtifact[]
  opencode: OpenCodeConfig<TTools>
}

export type WorkflowStepDefinition = WorkflowStepWithoutOpenCodeDefinition | WorkflowStepWithOpenCodeDefinition

// Runtime enforcement still limits `waitFor` to root/controller steps.
// The authoring type surface does not model that distinction yet.
type WaitForHandler<TContext> = (ctx: TContext) => Promise<WaitSpec | null> | WaitSpec | null

type CanCompleteHandler<TContext> = (ctx: TContext) => Promise<CompletionGuardResult> | CompletionGuardResult

type TypedWorkflowStepWithoutOpenCode<
  TSteps extends readonly WorkflowStepDefinition[],
  TStep extends WorkflowStepWithoutOpenCodeDefinition,
> = Omit<TStep, "run" | "on"> & {
  run: (ctx: InferStepContextBase<TSteps, TStep>) => Promise<StepRunResult | void> | StepRunResult | void
  on: (ctx: InferStepContextBase<TSteps, TStep>, event: StepBaseEvent) => Promise<void> | void
  waitFor?: WaitForHandler<InferStepContextBase<TSteps, TStep>>
  canComplete?: CanCompleteHandler<InferStepContextBase<TSteps, TStep>>
}

type TypedWorkflowStepWithOpenCode<
  TSteps extends readonly WorkflowStepDefinition[],
  TStep extends WorkflowStepWithOpenCodeDefinition,
> = Omit<TStep, "run" | "on"> & {
  run: (
    ctx: InferStepContextWithOpenCode<TSteps, TStep>,
  ) => Promise<StepRunResult | void> | StepRunResult | void
  on: (
      ctx: InferStepContextWithOpenCode<TSteps, TStep>,
      event: StepBaseEvent | OpenCodeStartedEvent | OpenCodeCompleteEvent,
    ) => Promise<void> | void
  waitFor?: WaitForHandler<InferStepContextWithOpenCode<TSteps, TStep>>
  canComplete?: CanCompleteHandler<InferStepContextWithOpenCode<TSteps, TStep>>
}

export type WorkflowStepWithoutOpenCode<
  TSteps extends readonly WorkflowStepDefinition[] = readonly WorkflowStepDefinition[],
  TStep extends WorkflowStepWithoutOpenCodeDefinition = WorkflowStepWithoutOpenCodeDefinition,
> = TypedWorkflowStepWithoutOpenCode<TSteps, TStep>

export type WorkflowStepWithOpenCode<
  TSteps extends readonly WorkflowStepDefinition[] = readonly WorkflowStepDefinition[],
  TStep extends WorkflowStepWithOpenCodeDefinition = WorkflowStepWithOpenCodeDefinition,
> = TypedWorkflowStepWithOpenCode<TSteps, TStep>

export type WorkflowStep<
  TSteps extends readonly WorkflowStepDefinition[] = readonly WorkflowStepDefinition[],
  TStep extends WorkflowStepDefinition = WorkflowStepDefinition,
> = TStep extends WorkflowStepWithOpenCodeDefinition
  ? TypedWorkflowStepWithOpenCode<TSteps, TStep>
  : TStep extends WorkflowStepWithoutOpenCodeDefinition
    ? TypedWorkflowStepWithoutOpenCode<TSteps, TStep>
    : never

export function defineWorkflowStep<const TStep extends WorkflowStepDefinition>(step: TStep): TStep {
  return step
}

export const defineStep = defineWorkflowStep

export type SonataWorkflowModule<TSteps extends readonly WorkflowStep[] = readonly WorkflowStep[]> = {
  apiVersion: typeof SONATA_WORKFLOW_API_VERSION
  id: string
  version: string
  name: string
  description?: string
  steps: TSteps
}

type StepDefinitionById<TSteps extends readonly WorkflowStepDefinition[], TStepId extends string> = Extract<
  TSteps[number],
  { id: TStepId }
>

type ArtifactDefinitionsOf<TStep extends WorkflowStepDefinition> = TStep["artifacts"] extends readonly WorkflowStepArtifact[]
  ? TStep["artifacts"][number]
  : never

type MarkdownArtifactNamesOf<TStep extends WorkflowStepDefinition> = Extract<
  ArtifactDefinitionsOf<TStep>,
  { kind: "markdown" }
>["name"]

type JsonArtifactDefinitionsOf<TStep extends WorkflowStepDefinition> = Extract<
  ArtifactDefinitionsOf<TStep>,
  { kind: "json" }
>

type JsonArtifactNamesOf<TStep extends WorkflowStepDefinition> = JsonArtifactDefinitionsOf<TStep>["name"]

type JsonArtifactDataFor<
  TStep extends WorkflowStepDefinition,
  TArtifactName extends string,
> = Extract<JsonArtifactDefinitionsOf<TStep>, { name: TArtifactName }> extends infer TArtifact
  ? TArtifact extends { schema: infer TSchema extends SchemaParser }
    ? SchemaOutput<TSchema>
    : JsonValue
  : JsonValue

type JsonArtifactDataMapOf<TStep extends WorkflowStepDefinition> = [JsonArtifactNamesOf<TStep>] extends [never]
  ? Record<string, never>
  : {
    [TArtifactName in JsonArtifactNamesOf<TStep>]: JsonArtifactDataFor<TStep, TArtifactName>
  }

type InferStepContextBase<
  TSteps extends readonly WorkflowStepDefinition[],
  TStep extends WorkflowStepDefinition,
> = StepContextBase<InferStepInputs<TSteps, TStep>, MarkdownArtifactNamesOf<TStep>, JsonArtifactDataMapOf<TStep>>

type InferStepContextWithOpenCode<
  TSteps extends readonly WorkflowStepDefinition[],
  TStep extends WorkflowStepDefinition,
> = InferStepContextBase<TSteps, TStep> & {
  opencode: {
    start: (params: { title?: string; prompt: string }) => Promise<void>
    tools: InferOpenCodeToolNameMapping<TStep>
  }
}

type OpenCodeToolsOf<TStep extends WorkflowStepDefinition> =
  TStep extends { opencode: OpenCodeConfig<infer TTools extends OpenCodeTools> }
    ? TTools
    : Record<string, never>

type InferOpenCodeToolNameMapping<TStep extends WorkflowStepDefinition> = {
  [K in keyof OpenCodeToolsOf<TStep>]: { name: string }
}

type ArtifactNamesForStep<TStep extends WorkflowStepDefinition> =
  TStep["artifacts"] extends readonly WorkflowStepArtifact[]
    ? TStep["artifacts"][number] extends { name: infer TArtifactName extends string }
      ? TArtifactName
      : never
    : never

type ValidateBindingFrom<
  TSteps extends readonly WorkflowStepDefinition[],
  TBinding extends WorkflowStepInputArtifact,
> = TBinding extends {
  from: {
    step: infer TStepId extends string
    artifact: infer TArtifactName extends string
  }
}
  ? TStepId extends TSteps[number]["id"]
    ? TArtifactName extends ArtifactNamesForStep<StepDefinitionById<TSteps, TStepId>>
      ? TBinding
      : Omit<TBinding, "from"> & {
        from: {
          step: TStepId
          artifact: ArtifactNamesForStep<StepDefinitionById<TSteps, TStepId>>
        }
      }
    : Omit<TBinding, "from"> & {
      from: {
        step: TSteps[number]["id"]
        artifact: string
      }
    }
  : TBinding

type ValidateStepDefinition<
  TSteps extends readonly WorkflowStepDefinition[],
  TStep extends WorkflowStepDefinition,
> = ValidateStepNext<
  TSteps,
  TStep extends {
  inputs: infer TInputs
}
  ? TInputs extends {
    artifacts: infer TBindings extends readonly WorkflowStepInputArtifact[]
  }
    ? Omit<TStep, "inputs"> & {
      inputs: Omit<TInputs, "artifacts"> & {
        artifacts: {
          [K in keyof TBindings]: TBindings[K] extends WorkflowStepInputArtifact
            ? ValidateBindingFrom<TSteps, TBindings[K]>
            : TBindings[K]
        }
      }
    }
    : TStep
  : TStep
>

type ValidateStepNext<
  TSteps extends readonly WorkflowStepDefinition[],
  TStep extends WorkflowStepDefinition,
> = TStep extends { next: infer TNext extends string }
  ? Omit<TStep, "next"> & {
    next: TNext extends TSteps[number]["id"] ? TNext : TSteps[number]["id"]
  }
  : TStep

type ValidateWorkflowDefinitions<TSteps extends readonly WorkflowStepDefinition[]> = {
  [K in keyof TSteps]: TSteps[K] extends WorkflowStepDefinition ? ValidateStepDefinition<TSteps, TSteps[K]> : TSteps[K]
}

type WorkflowStepImplementation<
  TSteps extends readonly WorkflowStepDefinition[],
  TStep extends WorkflowStepDefinition,
> = TStep extends WorkflowStepWithOpenCodeDefinition
  ? {
    run: (ctx: InferStepContextWithOpenCode<TSteps, TStep>) => Promise<StepRunResult | void> | StepRunResult | void
    on: (
      ctx: InferStepContextWithOpenCode<TSteps, TStep>,
      event: StepBaseEvent | OpenCodeStartedEvent | OpenCodeCompleteEvent,
    ) => Promise<void> | void
    waitFor?: WaitForHandler<InferStepContextWithOpenCode<TSteps, TStep>>
    canComplete?: CanCompleteHandler<InferStepContextWithOpenCode<TSteps, TStep>>
  }
  : {
    run: (ctx: InferStepContextBase<TSteps, TStep>) => Promise<StepRunResult | void> | StepRunResult | void
    on: (ctx: InferStepContextBase<TSteps, TStep>, event: StepBaseEvent) => Promise<void> | void
    waitFor?: WaitForHandler<InferStepContextBase<TSteps, TStep>>
    canComplete?: CanCompleteHandler<InferStepContextBase<TSteps, TStep>>
  }

export type WorkflowStepImplementations<TSteps extends readonly WorkflowStepDefinition[]> = {
  [TStepId in TSteps[number]["id"]]: WorkflowStepImplementation<TSteps, StepDefinitionById<TSteps, TStepId>>
}

type ExecutableSteps<TSteps extends readonly WorkflowStepDefinition[]> = {
  [K in keyof TSteps]: TSteps[K] extends WorkflowStepDefinition ? WorkflowStep<TSteps, TSteps[K]> : never
}

export type WorkflowDefinitionBuilder<TSteps extends readonly WorkflowStepDefinition[]> = Omit<
  SonataWorkflowModule<ExecutableSteps<TSteps>>,
  "steps"
> & {
  steps: TSteps
  implement: (implementations: WorkflowStepImplementations<TSteps>) => SonataWorkflowModule<ExecutableSteps<TSteps>>
}

export function defineWorkflow<const TSteps extends readonly WorkflowStep[]>(module: SonataWorkflowModule<TSteps>): SonataWorkflowModule<TSteps>
export function defineWorkflow<const TSteps extends readonly WorkflowStepDefinition[]>(
  module: Omit<SonataWorkflowModule, "steps"> & { steps: [...TSteps] & ValidateWorkflowDefinitions<TSteps> },
): WorkflowDefinitionBuilder<TSteps>
export function defineWorkflow<const TSteps extends readonly (WorkflowStepDefinition | WorkflowStep)[]>(
  module: Omit<SonataWorkflowModule, "steps"> & {
    steps: [...TSteps]
  },
): SonataWorkflowModule | WorkflowDefinitionBuilder<Extract<TSteps, readonly WorkflowStepDefinition[]>> {
  const hasImplementations = module.steps.every(
    (step): step is WorkflowStep => typeof (step as { run?: unknown }).run === "function" && typeof (step as { on?: unknown }).on === "function",
  )

  if (hasImplementations) {
    return module as SonataWorkflowModule
  }

  return {
    ...module,
    implement(implementations: WorkflowStepImplementations<Extract<TSteps, readonly WorkflowStepDefinition[]>>) {
      const steps = module.steps.map((step) => {
        const implementation = implementations[step.id as keyof typeof implementations]
        if (!implementation || typeof implementation.run !== "function" || typeof implementation.on !== "function") {
          throw new Error(`Missing implementation for workflow step: ${step.id}`)
        }
        return {
          ...step,
          ...implementation,
        }
      })

      return {
        ...module,
        steps,
      } as SonataWorkflowModule
    },
  } as unknown as WorkflowDefinitionBuilder<Extract<TSteps, readonly WorkflowStepDefinition[]>>
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
