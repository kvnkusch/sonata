import { and, asc, eq } from "drizzle-orm"
import { artifactTable, stepTable, type DbExecutor } from "../db"
import { ErrorCode, RpcError } from "../rpc/base"
import type { JsonValue } from "../workflow/module"
import type { StepInputsSnapshot } from "../workflow/module"
import type { WorkflowStepInputs } from "../workflow/module"

export type ArtifactSelectionOverride = {
  mode: "latest" | "all" | "indices"
  indices?: number[]
}

export type ArtifactCandidate = {
  artifactName: string
  artifactKind: "markdown" | "json"
  relativePath: string
  stepId: string
  stepKey: string
  stepIndex: number
  parentStepId: string | null
  workKey: string | null
  writtenAt: number
}

export function listArtifactCandidatesForBinding(input: {
  taskId: string
  fromStepKey: string
  artifactName: string
  executor: DbExecutor
}): ArtifactCandidate[] {
  return input.executor
    .select()
    .from(artifactTable)
    .innerJoin(stepTable, eq(stepTable.stepId, artifactTable.stepId))
    .where(
      and(
        eq(artifactTable.taskId, input.taskId),
        eq(stepTable.taskId, input.taskId),
        eq(stepTable.stepKey, input.fromStepKey),
        eq(artifactTable.artifactName, input.artifactName),
      ),
    )
    .orderBy(asc(stepTable.stepIndex), asc(artifactTable.writtenAt))
    .all()
    .map(({ artifact, step }) => ({
      artifactName: artifact.artifactName,
      artifactKind: artifact.artifactKind,
      relativePath: artifact.relativePath,
      stepId: step.stepId,
      stepKey: step.stepKey,
      stepIndex: step.stepIndex,
      parentStepId: step.parentStepId,
      workKey: step.workKey,
      writtenAt: artifact.writtenAt,
    }))
}

function assertNonRepeatedChildBinding(bindingName: string, fromStepKey: string, candidates: ArtifactCandidate[]) {
  const workKeys = new Set(
    candidates
      .filter((candidate) => candidate.parentStepId !== null && candidate.workKey !== null)
      .map((candidate) => candidate.workKey as string),
  )

  if (workKeys.size > 1) {
    throw new RpcError(
      ErrorCode.INVALID_INPUT,
      409,
      `Input ${bindingName} cannot bind directly to repeated child step ${fromStepKey}; use ctx.children.readArtifacts(...) fan-in instead`,
    )
  }
}

function validateIndices(indices: number[] | undefined): number[] {
  if (!indices || indices.length === 0) {
    throw new RpcError(ErrorCode.INVALID_INPUT, 400, "indices selector requires at least one 1-based index")
  }

  const deduped = new Set<number>()
  for (const value of indices) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RpcError(ErrorCode.INVALID_INPUT, 400, `Invalid selector index: ${value}`)
    }
    deduped.add(value)
  }
  return [...deduped].sort((a, b) => a - b)
}

function selectCandidates(
  candidates: ArtifactCandidate[],
  selection: ArtifactSelectionOverride,
): ArtifactCandidate[] {
  switch (selection.mode) {
    case "latest":
      return candidates.length > 0 ? [candidates[candidates.length - 1]!] : []
    case "all":
      return candidates
    case "indices": {
      const validated = validateIndices(selection.indices)
      const selected: ArtifactCandidate[] = []
      for (const ordinal of validated) {
        const candidate = candidates[ordinal - 1]
        if (!candidate) {
          throw new RpcError(
            ErrorCode.INVALID_INPUT,
            400,
            `Selector index out of range: ${ordinal} (available=${candidates.length})`,
          )
        }
        selected.push(candidate)
      }
      return selected
    }
  }
}

function parseInvocation(input: unknown): JsonValue | undefined {
  if (input === undefined) {
    return undefined
  }
  try {
    return JSON.parse(JSON.stringify(input)) as JsonValue
  } catch {
    throw new RpcError(ErrorCode.INVALID_INPUT, 400, "Invocation input must be JSON-serializable")
  }
}

export async function resolveStepInputs(input: {
  taskId: string
  stepInputs: WorkflowStepInputs | undefined
  invocation?: unknown
  artifactSelections?: Record<string, ArtifactSelectionOverride>
  executor: DbExecutor
}): Promise<StepInputsSnapshot> {
  const artifactBindings = input.stepInputs?.artifacts ?? []
  const resolved: StepInputsSnapshot = {
    artifacts: {},
  }

  if (input.stepInputs?.invocation?.schema) {
    const parsed = input.stepInputs.invocation.schema.parse(input.invocation)
    resolved.invocation = parseInvocation(parsed)
  } else if (input.invocation !== undefined) {
    resolved.invocation = parseInvocation(input.invocation)
  }

  for (const binding of artifactBindings) {
    const rows = listArtifactCandidatesForBinding({
      taskId: input.taskId,
      fromStepKey: binding.from.step,
      artifactName: binding.from.artifact,
      executor: input.executor,
    })
    assertNonRepeatedChildBinding(binding.as, binding.from.step, rows)

    const selection = input.artifactSelections?.[binding.as] ?? {
      mode: binding.cardinality.mode === "single" ? "latest" : "all",
    }

    const selected = selectCandidates(rows, selection)

    if (binding.cardinality.mode === "single") {
      const required = binding.cardinality.required !== false
      if (required && selected.length !== 1) {
        throw new RpcError(
          ErrorCode.INVALID_INPUT,
          409,
          `Input ${binding.as} requires exactly one artifact; resolved ${selected.length}`,
        )
      }
      if (!required && selected.length > 1) {
        throw new RpcError(
          ErrorCode.INVALID_INPUT,
          409,
          `Input ${binding.as} allows at most one artifact; resolved ${selected.length}`,
        )
      }
    } else {
      const min = binding.cardinality.min ?? 0
      const max = binding.cardinality.max
      if (selected.length < min) {
        throw new RpcError(
          ErrorCode.INVALID_INPUT,
          409,
          `Input ${binding.as} requires at least ${min} artifacts; resolved ${selected.length}`,
        )
      }
      if (typeof max === "number" && selected.length > max) {
        throw new RpcError(
          ErrorCode.INVALID_INPUT,
          409,
          `Input ${binding.as} allows at most ${max} artifacts; resolved ${selected.length}`,
        )
      }
    }

    resolved.artifacts[binding.as] = {
      mode: binding.cardinality.mode,
      selectedBy: selection.mode,
      refs: selected,
    }
  }

  return resolved
}
