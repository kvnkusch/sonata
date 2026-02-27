import z from "zod"

export const ErrorCode = {
  PROJECT_NOT_LINKED: "PROJECT_NOT_LINKED",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  WORKFLOW_NOT_FOUND: "WORKFLOW_NOT_FOUND",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  STEP_NOT_FOUND: "STEP_NOT_FOUND",
  ARTIFACT_NOT_DECLARED: "ARTIFACT_NOT_DECLARED",
  ARTIFACT_KIND_MISMATCH: "ARTIFACT_KIND_MISMATCH",
  ARTIFACT_WRITE_ONCE_VIOLATION: "ARTIFACT_WRITE_ONCE_VIOLATION",
  REQUIRED_ARTIFACT_MISSING: "REQUIRED_ARTIFACT_MISSING",
  INVALID_STEP_TRANSITION: "INVALID_STEP_TRANSITION",
  INVALID_INPUT: "INVALID_INPUT",
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export class RpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "RpcError"
  }
}

export const ScopeResolveInput = z.object({
  cwd: z.string().min(1).optional(),
})

export const ProjectLinkInput = z.object({
  projectRoot: z.string().min(1).optional(),
  opsRoot: z.string().min(1),
  projectId: z.string().min(1).optional(),
})

export const TaskStartInput = z.object({
  taskId: z.string().min(1).optional(),
  projectId: z.string().min(1),
  workflowRef: z.object({
    name: z.string().min(1),
  }),
})

export const TaskListActiveInput = z.object({
  projectId: z.string().min(1),
})

export const StepGetToolsetInput = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
})

export const StepStartInput = z.object({
  taskId: z.string().min(1),
  stepKey: z.string().min(1),
  invocation: z.unknown().optional(),
  artifactSelections: z
    .record(
      z.string().min(1),
      z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("latest") }),
        z.object({ mode: z.literal("all") }),
        z.object({ mode: z.literal("indices"), indices: z.array(z.number().int().positive()).min(1) }),
      ]),
    )
    .optional(),
})

export const StepWriteArtifactInput = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  artifactName: z.string().min(1),
  artifactKind: z.enum(["markdown", "json"]),
  payload: z.union([z.object({ markdown: z.string().min(1) }), z.object({ data: z.unknown() })]),
  sessionId: z.string().min(1).optional(),
})

export const StepCompleteInput = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  completionPayload: z.unknown().optional(),
  sessionId: z.string().min(1).optional(),
})
