import { and, desc, eq } from "drizzle-orm"
import { db, stepTable, taskTable, type DbExecutor } from "../db"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { newStepId } from "../id"
import { ErrorCode, RpcError } from "../rpc/base"
import type { ChildSpawnResult } from "../workflow/module"
import type { StepInputsSnapshot } from "../workflow/module"
import { loadWorkflowForTask } from "../workflow/loader"
import { resolveStepInputs, type ArtifactSelectionOverride } from "./inputs"
import { parseStepInputsSnapshot } from "./parse-inputs"

export type SpawnChildStepInput = {
  taskId: string
  parentStepId: string
  stepKey: string
  workKey: string
  invocation?: unknown
  artifactSelections?: Record<string, ArtifactSelectionOverride>
}

function canonicalInputs(input: { taskId: string; stepId: string; value: string }): string {
  return JSON.stringify(parseStepInputsSnapshot(input))
}

function canonicalResolvedInputs(taskId: string, stepKey: string, resolvedInputs: unknown): string {
  return canonicalInputs({ taskId, stepId: stepKey, value: JSON.stringify(resolvedInputs) })
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeJsonValue(entry)]),
    )
  }
  return value
}

type SpawnIdentity = {
  invocation?: unknown
  artifactSelections?: Record<string, ArtifactSelectionOverride>
}

function spawnIdentity(input: Pick<SpawnChildStepInput, "invocation" | "artifactSelections">): SpawnIdentity {
  return {
    ...(typeof input.invocation === "undefined" ? {} : { invocation: input.invocation }),
    ...(typeof input.artifactSelections === "undefined" ? {} : { artifactSelections: input.artifactSelections }),
  }
}

function canonicalSpawnIdentity(input: Pick<SpawnChildStepInput, "invocation" | "artifactSelections">): string {
  return JSON.stringify(normalizeJsonValue(spawnIdentity(input)))
}

function storedSpawnIdentity(inputsJson: string): string | null {
  const parsed = JSON.parse(inputsJson) as StepInputsSnapshot & { __spawnIdentity?: SpawnIdentity }
  if (!parsed.__spawnIdentity) {
    return null
  }
  return JSON.stringify(normalizeJsonValue(parsed.__spawnIdentity))
}

function storedChildInputsJson(input: { resolvedInputs: StepInputsSnapshot; identity: SpawnIdentity }): string {
  return JSON.stringify({
    ...input.resolvedInputs,
    __spawnIdentity: input.identity,
  })
}

function conflictError(input: SpawnChildStepInput, existingStepId: string): RpcError {
  return new RpcError(
    ErrorCode.CHILD_STEP_CONFLICT,
    409,
    `Child step already exists with conflicting invocation or artifact selections for parent=${input.parentStepId} step=${input.stepKey} workKey=${input.workKey}`,
    {
      parentStepId: input.parentStepId,
      stepKey: input.stepKey,
      workKey: input.workKey,
      existingStepId,
    },
  )
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("UNIQUE constraint failed")
}

function reuseExistingChild(
  input: SpawnChildStepInput & { resolvedInputsJson: string; spawnIdentityJson: string },
  executor: DbExecutor,
): ChildSpawnResult | null {
  const existing = executor
    .select()
    .from(stepTable)
    .where(
      and(
        eq(stepTable.taskId, input.taskId),
        eq(stepTable.parentStepId, input.parentStepId),
        eq(stepTable.stepKey, input.stepKey),
        eq(stepTable.workKey, input.workKey),
      ),
    )
    .get()

  if (!existing) {
    return null
  }

  const existingSpawnIdentity = storedSpawnIdentity(existing.inputs)
  if (existingSpawnIdentity !== null && existingSpawnIdentity !== input.spawnIdentityJson) {
    throw conflictError(input, existing.stepId)
  }

  if (
    canonicalInputs({ taskId: input.taskId, stepId: existing.stepId, value: existing.inputs }) !== input.resolvedInputsJson
  ) {
    throw conflictError(input, existing.stepId)
  }

  return {
    stepId: existing.stepId,
    stepKey: existing.stepKey,
    workKey: existing.workKey ?? input.workKey,
    status: existing.status,
    existing: true,
  }
}

export async function spawnChildStep(
  input: SpawnChildStepInput,
  executor: DbExecutor = db(),
): Promise<ChildSpawnResult> {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }
  if (task.status !== "active") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot spawn child step for task=${input.taskId} from current task state`,
    )
  }

  const parentStep = executor.select().from(stepTable).where(eq(stepTable.stepId, input.parentStepId)).get()
  if (!parentStep || parentStep.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.parentStepId}`)
  }
  if (parentStep.status !== "active") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Cannot spawn child step from inactive parent step: ${input.parentStepId}`,
    )
  }
  if (parentStep.parentStepId !== null) {
    throw new RpcError(ErrorCode.INVALID_INPUT, 409, `Only root steps may spawn child steps: ${input.parentStepId}`)
  }

  const loaded = await loadWorkflowForTask(input.taskId, executor)
  const workflowStep = loaded.workflow.steps.find((step) => step.id === input.stepKey)
  if (!workflowStep) {
    throw new RpcError(
      ErrorCode.STEP_NOT_FOUND,
      404,
      `Step key not found in workflow ${loaded.workflow.id}: ${input.stepKey}`,
    )
  }

  const resolvedInputs = await resolveStepInputs({
    taskId: input.taskId,
    stepInputs: workflowStep.inputs,
    invocation: input.invocation,
    artifactSelections: input.artifactSelections,
    executor,
  })
  const rawSpawnIdentity = spawnIdentity(input)
  const spawnIdentityJson = canonicalSpawnIdentity(input)
  const resolvedInputsJson = canonicalResolvedInputs(input.taskId, input.stepKey, resolvedInputs)

  const reused = reuseExistingChild({ ...input, resolvedInputsJson, spawnIdentityJson }, executor)
  if (reused) {
    return reused
  }

  const lastStep = executor
    .select()
    .from(stepTable)
    .where(eq(stepTable.taskId, input.taskId))
    .orderBy(desc(stepTable.stepIndex))
    .limit(1)
    .get()

  const stepId = newStepId()
  const stepIndex = (lastStep?.stepIndex ?? 0) + 1
  const now = Date.now()

  try {
    executor
      .insert(stepTable)
      .values({
        stepId,
        taskId: input.taskId,
        stepKey: workflowStep.id,
        stepIndex,
        status: "active",
        parentStepId: input.parentStepId,
        workKey: input.workKey,
        inputs: storedChildInputsJson({ resolvedInputs, identity: rawSpawnIdentity }),
        startedAt: now,
      })
      .run()
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error
    }

    const concurrent = reuseExistingChild({ ...input, resolvedInputsJson, spawnIdentityJson }, executor)
    if (concurrent) {
      return concurrent
    }
    throw error
  }

  executor.update(taskTable).set({ updatedAt: now }).where(eq(taskTable.taskId, input.taskId)).run()

  writeTaskEvent({
    executor,
    taskId: input.taskId,
    stepId,
    eventType: TaskEventType.STEP_STARTED,
    payload: {
      stepId,
      stepKey: workflowStep.id,
      stepIndex,
      inputs: resolvedInputs,
    },
    createdAt: now,
  })

  return {
    stepId,
    stepKey: workflowStep.id,
    workKey: input.workKey,
    status: "active",
    existing: false,
  }
}
