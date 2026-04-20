import { db, type DbExecutor } from "../db"
import { loadWorkflowStepForTask } from "../workflow/loader"
import { listArtifactCandidatesForBinding, type ArtifactCandidate } from "./inputs"

export type ListStepInputArtifactCandidatesInput = {
  taskId: string
  stepKey: string
}

export type ListStepInputArtifactCandidatesResult = {
  taskId: string
  stepKey: string
  bindings: Array<{
    as: string
    from: {
      step: string
      artifact: string
    }
    cardinality: {
      mode: "single" | "multiple"
      required?: boolean
      min?: number
      max?: number
    }
    candidates: ArtifactCandidate[]
  }>
}

export async function listStepInputArtifactCandidates(
  input: ListStepInputArtifactCandidatesInput,
  executor: DbExecutor = db(),
): Promise<ListStepInputArtifactCandidatesResult> {
  const loaded = await loadWorkflowStepForTask({
    taskId: input.taskId,
    stepKey: input.stepKey,
    tx: executor,
  })

  const bindings = loaded.step.inputs?.artifacts ?? []
  const resultBindings = bindings.map((binding) => {
    const candidates = listArtifactCandidatesForBinding({
      taskId: input.taskId,
      fromStepKey: binding.from.step,
      artifactName: binding.from.artifact,
      executor,
    })

    return {
      as: binding.as,
      from: binding.from,
      cardinality: binding.cardinality,
      candidates,
    }
  })

  return {
    taskId: input.taskId,
    stepKey: input.stepKey,
    bindings: resultBindings,
  }
}
