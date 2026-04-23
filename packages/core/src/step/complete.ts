import { readFile } from "node:fs/promises"
import path from "node:path"
import { and, eq, inArray } from "drizzle-orm"
import { artifactTable, db, projectTable, stepTable, taskTable, type DbExecutor } from "../db"
import { TaskEventType, type StepCompletionRejectedPayload, writeTaskEvent } from "../event/task-event"
import { ErrorCode, RpcError } from "../rpc/base"
import { completeTask } from "../task"
import { loadWorkflowForTask } from "../workflow"
import type {
  JsonValue,
  StepContextBase,
  StepContextWithOpenCode,
  StepInputs,
  StepInputsSnapshot,
  WorkflowStep,
  WorkflowStepWithOpenCode,
} from "../workflow/module"
import { parseStepInputsSnapshot } from "./parse-inputs"
import { resolveCustomToolNameMap } from "./get-toolset"
import { assertStepTransition } from "./transitions"
import { missingRequiredArtifacts } from "./validation"
import { wakeWaitingParentIfReady } from "./waiting"
import { writeArtifactFromExecutionContext } from "./write-artifact"
import { listChildSteps, readChildArtifacts, summarizeChildSteps } from "./children"
import { spawnChildStep } from "./spawn-child"
import type { ArtifactSelectionOverride } from "./inputs"

export type CompleteStepInput = {
  taskId: string
  stepId: string
  completionPayload?: unknown
  sessionId?: string
}

export type CompleteStepWithGuardsResult = {
  taskId: string
  stepId: string
  status: "completed"
  suggestedNextStepKey: string | null
  workflowStep: WorkflowStep
  ctx: StepContextBase | StepContextWithOpenCode
}

function isOpenCodeStep(step: WorkflowStep): step is WorkflowStepWithOpenCode {
  return typeof step === "object" && step !== null && "opencode" in step
}

function toJsonValue(value: unknown, errorContext: string): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    throw new Error(`${errorContext} must be JSON-serializable`)
  }
}

function isParserSchema(value: unknown): value is { parse: (input: unknown) => unknown } {
  return typeof value === "object" && value !== null && "parse" in value && typeof value.parse === "function"
}

function affectedRowCount(result: unknown): number | null {
  if (typeof result !== "object" || result === null) {
    return null
  }

  if ("changes" in result && typeof result.changes === "number") {
    return result.changes
  }

  if ("rowsAffected" in result && typeof result.rowsAffected === "number") {
    return result.rowsAffected
  }

  return null
}

export async function hydrateStepInputs(input: {
  taskId: string
  stepId: string
  opsRoot: string
  workflowSteps: readonly WorkflowStep[]
  snapshot: StepInputsSnapshot
}): Promise<StepInputs> {
  const stepById = new Map(input.workflowSteps.map((step) => [step.id, step] as const))
  const hydratedArtifacts: StepInputs["artifacts"] = {}
  const opsRootWithSep = input.opsRoot.endsWith(path.sep) ? input.opsRoot : `${input.opsRoot}${path.sep}`

  for (const [bindingName, binding] of Object.entries(input.snapshot.artifacts)) {
    const values = await Promise.all(
      binding.refs.map(async (ref) => {
        const artifactPath = path.resolve(input.opsRoot, ref.relativePath)
        if (artifactPath !== input.opsRoot && !artifactPath.startsWith(opsRootWithSep)) {
          throw new Error(
            `Invalid artifact path outside ops root for task=${input.taskId} step=${input.stepId}: ${ref.relativePath}`,
          )
        }

        const sourceStep = stepById.get(ref.stepKey)
        const sourceArtifact = sourceStep?.artifacts?.find((artifact) => artifact.name === ref.artifactName)
        if (sourceArtifact && sourceArtifact.kind !== ref.artifactKind) {
          throw new Error(
            `Artifact kind mismatch for input ${bindingName}: expected ${sourceArtifact.kind}, got ${ref.artifactKind}`,
          )
        }

        const raw = await readFile(artifactPath, "utf8")
        if (ref.artifactKind === "markdown") {
          return raw
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          throw new Error(`Invalid JSON artifact for input ${bindingName}: ${ref.relativePath}`)
        }

        if (sourceArtifact?.kind === "json" && isParserSchema(sourceArtifact.schema)) {
          parsed = sourceArtifact.schema.parse(parsed)
        }

        return toJsonValue(parsed, `Artifact ${ref.artifactName}`)
      }),
    )

    hydratedArtifacts[bindingName] = binding.mode === "single" ? values[0] : values
  }

  return {
    ...(typeof input.snapshot.invocation === "undefined" ? {} : { invocation: input.snapshot.invocation }),
    artifacts: hydratedArtifacts,
  }
}

export function createStepContextBase(input: {
  taskId: string
  stepId: string
  projectRoot: string
  opsRoot: string
  inputs: StepInputs
  executor?: DbExecutor
}): StepContextBase {
  const executor = input.executor ?? db()

  return {
    repoRoot: input.projectRoot,
    opsRoot: input.opsRoot,
    taskId: input.taskId,
    stepId: input.stepId,
    inputs: input.inputs,
    children: {
      spawn: async (params) => {
        const currentStep = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
        if (!currentStep || currentStep.taskId !== input.taskId) {
          throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
        }
        if (currentStep.parentStepId !== null) {
          throw new RpcError(
            ErrorCode.INVALID_INPUT,
            409,
            `Only root steps may spawn child steps: ${input.stepId}`,
          )
        }

        return spawnChildStep(
          {
            taskId: input.taskId,
            parentStepId: input.stepId,
            stepKey: params.stepKey,
            workKey: params.workKey,
            invocation: params.invocation,
            artifactSelections: params.artifactSelections as Record<string, ArtifactSelectionOverride> | undefined,
          },
          executor,
        )
      },
      list: async (params) => {
        return listChildSteps(
          {
            taskId: input.taskId,
            parentStepId: input.stepId,
            stepKey: params?.stepKey,
            workKeys: params?.workKeys,
          },
          executor,
        )
      },
      summary: async (params) => {
        return summarizeChildSteps(
          {
            taskId: input.taskId,
            parentStepId: input.stepId,
            stepKey: params.stepKey,
            workKeys: params.workKeys,
          },
          executor,
        )
      },
      readArtifacts: async (params) => {
        return readChildArtifacts(
          {
            taskId: input.taskId,
            parentStepId: input.stepId,
            stepKey: params.stepKey,
            artifactName: params.artifactName,
            workKeys: params.workKeys,
          },
          executor,
        )
      },
    },
    writeMarkdownArtifact: async (params) => {
      const written = await writeArtifactFromExecutionContext(
        {
          taskId: input.taskId,
          stepId: input.stepId,
          slug: params.slug,
          kind: "markdown",
          payload: { markdown: params.markdown },
        },
        executor,
      )
      return { kind: "markdown", path: written.relativePath }
    },
    writeJsonArtifact: async (params) => {
      const written = await writeArtifactFromExecutionContext(
        {
          taskId: input.taskId,
          stepId: input.stepId,
          slug: params.slug,
          kind: "json",
          payload: { data: params.data },
        },
        executor,
      )
      return { kind: "json", path: written.relativePath }
    },
    completeStep: async (payload?: unknown) => {
      return completeStep(
        {
          taskId: input.taskId,
          stepId: input.stepId,
          completionPayload: payload,
        },
        executor,
      )
    },
    completeTask: async (payload?: unknown) => {
      return completeTask(
        {
          taskId: input.taskId,
          completionPayload: payload,
        },
        executor,
      )
    },
  }
}

function writeCompletionRejectedEvent(input: {
  executor: DbExecutor
  taskId: string
  stepId: string
  payload: StepCompletionRejectedPayload
}) {
  writeTaskEvent({
    executor: input.executor,
    taskId: input.taskId,
    stepId: input.stepId,
    eventType: TaskEventType.STEP_COMPLETION_REJECTED,
    payload: input.payload,
  })
}

function throwCompletionRejected(input: {
  executor: DbExecutor
  taskId: string
  stepId: string
  payload: StepCompletionRejectedPayload
}) {
  writeCompletionRejectedEvent(input)
  throw new RpcError(input.payload.code, 409, input.payload.message, input.payload)
}

function isCompletionGuardContext(step: WorkflowStep, ctx: StepContextBase): StepContextBase | StepContextWithOpenCode {
  if (!isOpenCodeStep(step)) {
    return ctx
  }

  return {
    ...ctx,
    opencode: {
      tools: resolveCustomToolNameMap({ stepKey: step.id, tools: step.opencode.tools }),
      start: async () => {
        return
      },
    },
  } satisfies StepContextWithOpenCode
}

function suggestedNextStepKey(step: { parentStepId: string | null }, workflowStep: WorkflowStep): string | null {
  return step.parentStepId === null ? workflowStep.next ?? null : null
}

export async function completeStepWithGuards(
  input: CompleteStepInput,
  executor: DbExecutor = db(),
): Promise<CompleteStepWithGuardsResult> {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
  }

  if (task.status !== "active") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot complete task=${input.taskId} step=${input.stepId} from current state`,
    )
  }

  assertStepTransition(
    step.status,
    "completed",
    `Cannot complete task=${input.taskId} step=${input.stepId} from current state`,
  )

  const project = executor.select().from(projectTable).where(eq(projectTable.projectId, task.projectId)).get()
  if (!project) {
    throw new RpcError(ErrorCode.PROJECT_NOT_FOUND, 404, `Project not found: ${task.projectId}`)
  }

  const loaded = await loadWorkflowForTask(input.taskId, executor)
  const workflowStep = loaded.workflow.steps.find((candidate) => candidate.id === step.stepKey)
  if (!workflowStep) {
    throw new Error(`Workflow step not found in ${loaded.workflow.id}: ${step.stepKey}`)
  }

  const snapshot = parseStepInputsSnapshot({
    taskId: input.taskId,
    stepId: input.stepId,
    value: step.inputs,
  })

  const hydratedInputs = await hydrateStepInputs({
    taskId: input.taskId,
    stepId: input.stepId,
    opsRoot: project.opsRootRealpath,
    workflowSteps: loaded.workflow.steps,
    snapshot,
  })

  const writtenArtifacts = executor
    .select()
    .from(artifactTable)
    .where(and(eq(artifactTable.taskId, input.taskId), eq(artifactTable.stepId, input.stepId)))
    .all()

  const missingArtifacts = missingRequiredArtifacts({
    artifacts: workflowStep.artifacts,
    writtenArtifactNames: new Set(writtenArtifacts.map((artifact) => artifact.artifactName)),
  })

  if (missingArtifacts.length > 0) {
    const message = `Cannot complete step ${input.stepId}; missing required artifacts: ${missingArtifacts.join(", ")}`
    throwCompletionRejected({
      executor,
      taskId: input.taskId,
      stepId: input.stepId,
      payload: {
        stepId: input.stepId,
        reason: "missing_required_artifacts",
        code: ErrorCode.REQUIRED_ARTIFACT_MISSING,
        message,
        details: { missingArtifacts },
      },
    })
  }

  const baseCtx = createStepContextBase({
    taskId: input.taskId,
    stepId: input.stepId,
    projectRoot: project.projectRootRealpath,
    opsRoot: project.opsRootRealpath,
    inputs: hydratedInputs,
    executor,
  })
  const ctx = isCompletionGuardContext(workflowStep, baseCtx)

  if (step.parentStepId === null) {
    const openChildren = executor
      .select()
      .from(stepTable)
      .where(
        and(
          eq(stepTable.taskId, input.taskId),
          eq(stepTable.parentStepId, input.stepId),
          inArray(stepTable.status, ["active", "blocked", "orphaned"]),
        ),
      )
      .all()

    if (openChildren.length > 0) {
      const message = `Cannot complete root step ${input.stepId} while child steps are still open`
      throwCompletionRejected({
        executor,
        taskId: input.taskId,
        stepId: input.stepId,
        payload: {
          stepId: input.stepId,
          reason: "can_complete_rejected",
          code: ErrorCode.STEP_COMPLETION_GUARD_REJECTED,
          message,
          details: {
            guardCode: "open_child_steps",
            guardMessage: message,
            guardDetails: {
              openChildStepIds: openChildren.map((child) => child.stepId),
              openChildWorkKeys: openChildren
                .map((child) => child.workKey)
                .filter((workKey): workKey is string => workKey !== null),
            },
          },
        },
      })
    }
  }

  if (workflowStep.canComplete) {
    const guardResult = await workflowStep.canComplete(ctx as never)
    if (!guardResult.ok) {
      const payload: StepCompletionRejectedPayload = {
        stepId: input.stepId,
        reason: "can_complete_rejected",
        code: ErrorCode.STEP_COMPLETION_GUARD_REJECTED,
        message: guardResult.message,
        details: {
          guardCode: guardResult.code,
          guardMessage: guardResult.message,
          ...(typeof guardResult.details === "undefined" ? {} : { guardDetails: guardResult.details }),
        },
      }
      throwCompletionRejected({
        executor,
        taskId: input.taskId,
        stepId: input.stepId,
        payload,
      })
    }
  }

  const now = Date.now()
  const effectiveSessionId = input.sessionId ?? step.sessionId ?? undefined

  const completionUpdate = executor
    .update(stepTable)
    .set({
      status: "completed",
      completedAt: now,
      completionPayloadJson:
        typeof input.completionPayload === "undefined" ? null : JSON.stringify(input.completionPayload),
      sessionId: effectiveSessionId,
    })
    .where(and(eq(stepTable.stepId, step.stepId), eq(stepTable.status, "active")))
    .run()

  if (affectedRowCount(completionUpdate) === 0) {
    const latestStep = executor.select().from(stepTable).where(eq(stepTable.stepId, step.stepId)).get()
    if (latestStep?.status === "completed") {
      return {
        taskId: input.taskId,
        stepId: input.stepId,
        status: "completed",
        suggestedNextStepKey: suggestedNextStepKey(step, workflowStep),
        workflowStep,
        ctx,
      }
    }

    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot complete task=${input.taskId} step=${input.stepId} from current state`,
    )
  }

  writeTaskEvent({
    executor,
    taskId: input.taskId,
    stepId: input.stepId,
    eventType: TaskEventType.STEP_COMPLETED,
      payload: {
        stepId: input.stepId,
        stepIndex: step.stepIndex,
        sessionId: effectiveSessionId,
        recommendedNextStepKey: suggestedNextStepKey(step, workflowStep),
      },
    createdAt: now,
  })
  executor.update(taskTable).set({ updatedAt: now }).where(eq(taskTable.taskId, input.taskId)).run()

  return {
    taskId: input.taskId,
    stepId: input.stepId,
    status: "completed",
    suggestedNextStepKey: suggestedNextStepKey(step, workflowStep),
    workflowStep,
    ctx,
  }
}

export async function completeStep(input: CompleteStepInput, executor: DbExecutor = db()) {
  const completion = await completeStepWithGuards(input, executor)
  wakeWaitingParentIfReady({ taskId: input.taskId, stepId: input.stepId, executor })

  return {
    taskId: completion.taskId,
    stepId: completion.stepId,
    status: completion.status,
    suggestedNextStepKey: completion.suggestedNextStepKey,
  }
}
