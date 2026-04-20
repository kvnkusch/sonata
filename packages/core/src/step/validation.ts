import type { WorkflowStepArtifact } from "../workflow/module"

export function normalizeArtifactDeclaration(artifact: WorkflowStepArtifact) {
  return {
    ...artifact,
    required: Boolean(artifact.required),
    once: artifact.once !== false,
  }
}

export function getDeclaredArtifact(
  artifacts: readonly WorkflowStepArtifact[] | undefined,
  artifactName: string,
): WorkflowStepArtifact | undefined {
  return (artifacts ?? []).find((artifact) => artifact.name === artifactName)
}

export function missingRequiredArtifacts(input: {
  artifacts: readonly WorkflowStepArtifact[] | undefined
  writtenArtifactNames: Set<string>
}): string[] {
  return (input.artifacts ?? [])
    .filter((artifact) => Boolean(artifact.required) && !input.writtenArtifactNames.has(artifact.name))
    .map((artifact) => artifact.name)
}
