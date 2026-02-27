import path from "node:path"

export type ArtifactKind = "markdown" | "json"

const extensionByKind: Record<ArtifactKind, string> = {
  markdown: "md",
  json: "json",
}

export function slugifyArtifactSegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return slug || "artifact"
}

export function zeroPadStepIndex(stepIndex: number): string {
  return String(stepIndex).padStart(3, "0")
}

export function artifactFileName(input: {
  stepIndex: number
  stepKey: string
  artifactName: string
  artifactKind: ArtifactKind
}): string {
  const ext = extensionByKind[input.artifactKind]
  return `${zeroPadStepIndex(input.stepIndex)}-${slugifyArtifactSegment(input.stepKey)}-${slugifyArtifactSegment(input.artifactName)}.${ext}`
}

export function artifactRelativePath(input: {
  taskId: string
  stepIndex: number
  stepKey: string
  artifactName: string
  artifactKind: ArtifactKind
}): string {
  return path.join(
    "tasks",
    input.taskId,
    artifactFileName({
      stepIndex: input.stepIndex,
      stepKey: input.stepKey,
      artifactName: input.artifactName,
      artifactKind: input.artifactKind,
    }),
  )
}

export function artifactAbsolutePath(input: {
  opsRootRealpath: string
  taskId: string
  stepIndex: number
  stepKey: string
  artifactName: string
  artifactKind: ArtifactKind
}): string {
  return path.join(
    input.opsRootRealpath,
    artifactRelativePath({
      taskId: input.taskId,
      stepIndex: input.stepIndex,
      stepKey: input.stepKey,
      artifactName: input.artifactName,
      artifactKind: input.artifactKind,
    }),
  )
}
