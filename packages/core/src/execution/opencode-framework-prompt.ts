import type { WorkflowStepArtifact } from "../workflow/module"

export type OpenCodeKickoffPromptContract = "standard" | "compact"

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
  contract?: OpenCodeKickoffPromptContract
}): string {
  const artifacts = input.artifacts ?? []
  const requiredArtifacts = artifacts.filter((artifact) => Boolean(artifact.required))
  const hasJsonArtifacts = artifacts.some((artifact) => artifact.kind === "json")
  const hasJsonlArtifacts = artifacts.some((artifact) => artifact.kind === "jsonl")
  const artifactToolLines = artifacts.map((artifact) => `- \`${writeArtifactToolName(artifact)}\` for artifact \`${artifact.name}\``)
  const requiredArtifactLine = requiredArtifacts.length > 0
    ? `- Required artifacts: ${requiredArtifacts.map((artifact) => `\`${artifact.name}\``).join(", ")}.`
    : "- Required artifacts: none."
  const artifactToolBlock = artifactToolLines.length > 0
    ? ["Artifact write tools:", ...artifactToolLines].join("\n")
    : "No artifact write tools are declared."
  const jsonStagingLine = hasJsonArtifacts
    ? "- For large JSON artifacts, write JSON to `SONATA_OPS_ROOT/.sonata/staging/<taskId>/<stepId>/...` and call the JSON artifact tool with `{ source: \"file\", filePath }`."
    : null
  const jsonlStagingLine = hasJsonlArtifacts
    ? "- For large JSONL artifacts, write newline-delimited JSON to `SONATA_OPS_ROOT/.sonata/staging/<taskId>/<stepId>/...` and call the JSONL artifact tool with `{ source: \"file\", filePath }`."
    : null

  const contract = input.contract === "compact"
    ? [
      "Use Sonata tools to finish this step:",
      "- Write artifacts with Sonata artifact tools.",
      "- Use frozen step inputs only.",
      "- If blocked on operator/external input, call `sonata_block_step` once with a structured reason.",
      jsonStagingLine,
      jsonlStagingLine,
      "- After required artifacts are written, call `sonata_complete_step` exactly once and only claim completion if it succeeds.",
      requiredArtifactLine,
      artifactToolBlock,
    ]
    : [
      "Sonata workflow step contract:",
      "- Use Sonata bridge tools for artifact writes.",
      "- Use the provided frozen step inputs; do not assume unstated context.",
      "- If the step cannot proceed autonomously and needs operator or external input, call `sonata_block_step` once with a structured reason.",
      jsonStagingLine,
      jsonlStagingLine,
      "- After required artifacts are written, call `sonata_complete_step` exactly once.",
      "- Do not claim the step is complete unless `sonata_complete_step` succeeds.",
      requiredArtifactLine,
      artifactToolBlock,
    ]

  const contractText = contract.filter((line): line is string => Boolean(line)).join("\n")

  return `${contractText}\n\nStep instructions:\n${input.prompt}`
}
