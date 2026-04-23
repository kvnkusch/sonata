import type { WorkflowStepArtifact } from "../workflow/module"

function toSafeToolName(value: string): string {
  const slug = value
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
  return slug || "artifact"
}

function writeArtifactToolName(artifact: WorkflowStepArtifact): string {
  return `sonata_write_${toSafeToolName(artifact.name)}_artifact_${artifact.kind}`
}

export function composeOpenCodeKickoffPrompt(input: {
  prompt: string
  artifacts?: readonly WorkflowStepArtifact[]
}): string {
  const artifacts = input.artifacts ?? []
  const requiredArtifacts = artifacts.filter((artifact) => Boolean(artifact.required))
  const artifactToolLines = artifacts.map((artifact) => `- \`${writeArtifactToolName(artifact)}\` for artifact \`${artifact.name}\``)

  const contract = [
    "You are executing a Sonata workflow step.",
    "Completion contract:",
    "- Use Sonata bridge tools for step artifact writes.",
    "- Use the provided frozen step inputs; do not assume unstated context.",
    "- If the step cannot proceed autonomously and needs operator or external input, call `sonata_block_step` once with a structured reason.",
    "- After required artifacts are written, call `sonata_complete_step` exactly once.",
    "- Do not claim the step is complete unless `sonata_complete_step` succeeds.",
    requiredArtifacts.length > 0
      ? `- Required artifacts: ${requiredArtifacts.map((artifact) => `\`${artifact.name}\``).join(", ")}.`
      : "- Required artifacts: none.",
    artifactToolLines.length > 0
      ? ["Artifact write tools for this step:", ...artifactToolLines].join("\n")
      : "No artifact write tools are declared for this step.",
  ].join("\n")

  return `${contract}\n\nStep instructions:\n${input.prompt}`
}
