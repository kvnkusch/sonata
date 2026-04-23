import { expectTypeOf, test } from "vitest"
import { z } from "zod"
import {
  type ChildArtifactRef,
  type ChildSummary,
  type CompletionGuardResult,
  defineStep,
  defineWorkflow,
  openCodeConfig,
  openCodeTool,
  type WaitSpec,
  type WorkflowStepImplementations,
} from "./index"

type ForeignSchema<T> = {
  parse: (input: unknown) => T
}

function foreignSchema<T>(): ForeignSchema<T> {
  return null as unknown as ForeignSchema<T>
}

const intake = defineStep({
  id: "intake",
  title: "Intake",
  artifacts: [
    { name: "topic", kind: "markdown" },
    {
      name: "config",
      kind: "json",
      schema: z.object({ mode: z.enum(["fast", "safe"]), retries: z.number().int() }),
    },
  ] as const,
})

const notes = defineStep({
  id: "notes",
  title: "Notes",
  artifacts: [{ name: "note", kind: "markdown" }] as const,
})

const plan = defineStep({
  id: "plan",
  title: "Plan",
  inputs: {
    invocation: {
      schema: z.object({ strictness: z.enum(["low", "high"]) }),
    },
    artifacts: [
      {
        as: "topic",
        from: { step: "intake", artifact: "topic" },
        cardinality: { mode: "single" },
      },
      {
        as: "config",
        from: { step: "intake", artifact: "config" },
        cardinality: { mode: "single", required: false },
      },
      {
        as: "notes",
        from: { step: "notes", artifact: "note" },
        cardinality: { mode: "multiple", min: 1 },
      },
    ] as const,
  },
})

const controller = defineStep({
  id: "controller",
  title: "Controller",
})

const implement = defineStep({
  id: "implement",
  title: "Implement",
  opencode: openCodeConfig({
    tools: {
      fetch_plan_context: openCodeTool({
        description: "Fetch planning context",
        argsSchema: {
          maxItems: z.number().int().positive(),
        },
        async execute(_ctx, args) {
          const _maxItems: number = args.maxItems
          // @ts-expect-error maxItems is a number, not string
          const _badMaxItems: string = args.maxItems
          return { ok: true }
        },
      }),
      list_repo_files: openCodeTool({
        description: "List repo files",
        argsSchema: {
          glob: z.string().min(1),
          includeHidden: z.boolean().optional(),
        },
        async execute(_ctx, args) {
          const _glob: string = args.glob
          const _includeHidden: boolean | undefined = args.includeHidden
          // @ts-expect-error includeHidden should not be a number
          const _badIncludeHidden: number = args.includeHidden
          return "ok"
        },
      }),
      parse_ticket: openCodeTool({
        description: "Parse ticket metadata",
        argsSchema: {
          ticketId: z.string().min(1),
          tags: z.array(z.string()).default([]),
          options: z
            .object({
              includeClosed: z.boolean().optional(),
            })
            .optional(),
        },
        async execute(_ctx, args) {
          const _ticketId: string = args.ticketId
          const _tags: string[] = args.tags
          const _includeClosed: boolean | undefined = args.options?.includeClosed
          // @ts-expect-error ticketId should be string
          const _badTicketId: number = args.ticketId
          // @ts-expect-error tags is string[]
          const _badTags: number[] = args.tags
          return { parsed: true }
        },
      }),
      checks: openCodeTool({
        description: "Run deterministic checks",
        argsSchema: {
          only: z.array(z.enum(["typecheck", "lint", "test"])).optional(),
        },
        async execute(_ctx, args) {
          const _only: Array<"typecheck" | "lint" | "test"> | undefined = args.only
          // @ts-expect-error only should not accept arbitrary strings
          const _invalidOnly: Array<"foo"> | undefined = args.only
          return { ok: true }
        },
      }),
    },
  }),
  artifacts: [{ name: "implementation_notes", kind: "markdown" }] as const,
  inputs: {
    artifacts: [
      {
        as: "config",
        from: { step: "intake", artifact: "config" },
        cardinality: { mode: "single" },
      },
    ] as const,
  },
})

const workflowBuilder = defineWorkflow({
  apiVersion: 1,
  id: "default",
  version: "0.1.0",
  name: "Type Test",
  steps: [intake, notes, plan, controller, implement] as const,
})

const implementations: WorkflowStepImplementations<typeof workflowBuilder.steps> = {
  intake: {
    async run(ctx) {
      expectTypeOf(ctx.inputs.invocation).toEqualTypeOf<undefined>()
      // @ts-expect-error non-opencode step context does not expose opencode tools
      void ctx.opencode.tools
      await ctx.completeStep({ ok: true })
    },
    async on() {},
  },
  notes: {
    async run(ctx) {
      expectTypeOf(ctx.inputs.invocation).toEqualTypeOf<undefined>()
      await ctx.writeMarkdownArtifact({ slug: "note", markdown: "ok" })
      // @ts-expect-error markdown slug must be declared markdown artifact name
      await ctx.writeMarkdownArtifact({ slug: "missing", markdown: "nope" })
      await ctx.completeStep({ ok: true })
    },
    async on() {},
  },
  plan: {
    async run(ctx) {
      expectTypeOf(ctx.inputs.invocation).toEqualTypeOf<{ strictness: "low" | "high" }>()
      expectTypeOf(ctx.inputs.artifacts.topic).toEqualTypeOf<string>()
      expectTypeOf(ctx.inputs.artifacts.config?.mode).toEqualTypeOf<"fast" | "safe" | undefined>()
      expectTypeOf(ctx.inputs.artifacts.notes[0]).toEqualTypeOf<string | undefined>()

      // @ts-expect-error plan step does not declare json artifact slug
      await ctx.writeJsonArtifact({ slug: "config", data: { mode: "fast", retries: 1 } })

      await ctx.completeStep({ ok: true })
    },
    async on() {},
  },
  controller: {
    async run(ctx) {
      expectTypeOf(ctx.opsRoot).toEqualTypeOf<string>()

      const child = await ctx.children.spawn({
        stepKey: "implement",
        workKey: "job-1",
        invocation: { strictness: "high" },
      })
      expectTypeOf(child.existing).toEqualTypeOf<boolean>()

      const children = await ctx.children.list({ stepKey: "implement", workKeys: ["job-1"] })
      expectTypeOf(children[0]).toEqualTypeOf<{
        stepId: string
        stepKey: string
        workKey: string | null
        status: string
      } | undefined>()

      const summary = await ctx.children.summary({ stepKey: "implement" })
      expectTypeOf(summary).toEqualTypeOf<ChildSummary>()

      const artifacts = await ctx.children.readArtifacts({
        stepKey: "implement",
        artifactName: "implementation_notes",
      })
      expectTypeOf(artifacts[0]).toEqualTypeOf<ChildArtifactRef | undefined>()
    },
    async on() {},
    waitFor(ctx) {
      expectTypeOf(ctx.opsRoot).toEqualTypeOf<string>()
      return {
        kind: "children",
        childStepKey: "implement",
        until: "all_completed",
        label: ctx.opsRoot,
      } satisfies WaitSpec
    },
    canComplete(ctx) {
      expectTypeOf(ctx.children.summary).toEqualTypeOf<(params: {
        stepKey: string
        workKeys?: string[]
      }) => Promise<ChildSummary>>()
      return { ok: true } satisfies CompletionGuardResult
    },
  },
  implement: {
    async run(ctx) {
      await ctx.opencode.start({ title: "Implement", prompt: "Ship it" })
      expectTypeOf(ctx.inputs.artifacts.config.mode).toEqualTypeOf<"fast" | "safe">()
      expectTypeOf(ctx.opencode.tools.fetch_plan_context!.name).toEqualTypeOf<string>()
      expectTypeOf(ctx.opencode.tools.list_repo_files!.name).toEqualTypeOf<string>()
      expectTypeOf(ctx.opencode.tools.parse_ticket!.name).toEqualTypeOf<string>()
      expectTypeOf(ctx.opencode.tools.checks!.name).toEqualTypeOf<string>()

      // @ts-expect-error undeclared OpenCode tool id should not exist on mapping
      void ctx.opencode.tools.missing_tool.name
      await ctx.writeMarkdownArtifact({ slug: "implementation_notes", markdown: "summary" })

      // @ts-expect-error implement step has no json artifact declarations
      await ctx.writeJsonArtifact({ slug: "config", data: { mode: "fast", retries: 3 } })
    },
    async on() {},
    canComplete() {
      return { ok: false, code: "blocked", message: "waiting on review" }
    },
  },
}

const moduleResult = workflowBuilder.implement(implementations)

const _invalidWaitForImplementation: WorkflowStepImplementations<typeof workflowBuilder.steps>["controller"] = {
  async run() {},
  async on() {},
  // @ts-expect-error waitFor must return WaitSpec or null
  waitFor() {
    return { kind: "children", childStepKey: "implement", until: "sometimes" }
  },
}
void _invalidWaitForImplementation

const _invalidCanCompleteImplementation: WorkflowStepImplementations<typeof workflowBuilder.steps>["controller"] = {
  async run() {},
  async on() {},
  // @ts-expect-error rejected completion results require a message
  canComplete() {
    return { ok: false, code: "missing-message" }
  },
}
void _invalidCanCompleteImplementation

const legacyModule = defineWorkflow({
  apiVersion: 1,
  id: "legacy",
  version: "0.1.0",
  name: "Legacy",
  steps: [
    {
      id: "legacy-step",
      title: "Legacy",
      async run(ctx) {
        expectTypeOf(ctx.inputs.invocation).toEqualTypeOf<undefined>()
        expectTypeOf(ctx.opsRoot).toEqualTypeOf<string>()
        await ctx.completeStep()
      },
      async on() {},
    },
  ] as const,
})

const _invalidStepRef = defineWorkflow({
  apiVersion: 1,
  id: "invalid-step-ref",
  version: "0.1.0",
  name: "Invalid Step Ref",
  steps: [
    defineStep({
      id: "a",
      title: "A",
      artifacts: [{ name: "doc", kind: "markdown" }] as const,
    }),
    // @ts-expect-error invalid referenced step id in artifact input binding
    defineStep({
      id: "b",
      title: "B",
      inputs: {
        artifacts: [
          {
            as: "doc",
            from: { step: "missing", artifact: "doc" },
            cardinality: { mode: "single" },
          },
        ] as const,
      },
    }),
  ] as const,
})
void _invalidStepRef

const _invalidArtifactRef = defineWorkflow({
  apiVersion: 1,
  id: "invalid-artifact-ref",
  version: "0.1.0",
  name: "Invalid Artifact Ref",
  steps: [
    defineStep({
      id: "a",
      title: "A",
      artifacts: [{ name: "doc", kind: "markdown" }] as const,
    }),
    // @ts-expect-error invalid referenced artifact name for existing step
    defineStep({
      id: "b",
      title: "B",
      inputs: {
        artifacts: [
          {
            as: "doc",
            from: { step: "a", artifact: "missing_artifact" },
            cardinality: { mode: "single" },
          },
        ] as const,
      },
    }),
  ] as const,
})
void _invalidArtifactRef

const _invalidNext = defineWorkflow({
  apiVersion: 1,
  id: "invalid-next-ref",
  version: "0.1.0",
  name: "Invalid Next Ref",
  steps: [
    // @ts-expect-error invalid next step id
    defineStep({
      id: "a",
      title: "A",
      next: "missing",
    }),
    defineStep({
      id: "b",
      title: "B",
    }),
  ] as const,
})
void _invalidNext

test("workflow type inference compiles", () => {
  expectTypeOf(moduleResult.name).toEqualTypeOf<string>()
  expectTypeOf(legacyModule.id).toEqualTypeOf<string>()
})

const noConstBuilder = defineWorkflow({
  apiVersion: 1,
  id: "no-const",
  version: "0.1.0",
  name: "No Const",
  steps: [
    defineStep({
      id: "author",
      title: "Author",
      artifacts: [{ name: "draft", kind: "markdown" }],
    }),
    defineStep({
      id: "publish",
      title: "Publish",
      inputs: {
        artifacts: [
          {
            as: "draft",
            from: { step: "author", artifact: "draft" },
            cardinality: { mode: "single" },
          },
        ],
      },
    }),
  ],
})

noConstBuilder.implement({
  author: {
    async run(ctx) {
      await ctx.writeMarkdownArtifact({ slug: "draft", markdown: "ok" })
      // @ts-expect-error invalid slug should fail without requiring as const
      await ctx.writeMarkdownArtifact({ slug: "not_declared", markdown: "nope" })
    },
    async on() {},
  },
  publish: {
    async run(ctx) {
      expectTypeOf(ctx.inputs.artifacts.draft).toEqualTypeOf<string>()
    },
    async on() {},
  },
})

const _noConstInvalidRef = defineWorkflow({
  apiVersion: 1,
  id: "no-const-invalid-ref",
  version: "0.1.0",
  name: "No Const Invalid Ref",
  steps: [
    defineStep({
      id: "a",
      title: "A",
      artifacts: [{ name: "doc", kind: "markdown" }],
    }),
    // @ts-expect-error invalid ref should fail without requiring as const
    defineStep({
      id: "b",
      title: "B",
      inputs: {
        artifacts: [
          {
            as: "doc",
            from: { step: "a", artifact: "missing" },
            cardinality: { mode: "single" },
          },
        ],
      },
    }),
  ],
})
void _noConstInvalidRef

const _foreignSchemaWorkflow = defineWorkflow({
  apiVersion: 1,
  id: "foreign-schema-opencode",
  version: "0.1.0",
  name: "Foreign Schema OpenCode",
  steps: [
    defineStep({
      id: "implement",
      title: "Implement",
      opencode: openCodeConfig({
        tools: {
          checks: openCodeTool({
            description: "Run deterministic checks",
            argsSchema: {
              only: foreignSchema<Array<"typecheck" | "lint" | "test"> | undefined>(),
            },
            async execute(_ctx, args) {
              const _only: Array<"typecheck" | "lint" | "test"> | undefined = args.only
              // @ts-expect-error wrong literal union should fail
              const _badOnly: Array<"foo"> | undefined = args.only
              return { ok: true }
            },
          }),
        },
      }),
    }),
  ] as const,
})
void _foreignSchemaWorkflow
