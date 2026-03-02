import * as prompts from "@clack/prompts"
import type { WorkflowStep } from "@sonata/core/workflow"
import {
  isPromptableZodObjectSchema,
  parseIndicesSelection,
  promptJsonInput,
  promptZodObjectInput,
} from "../prompting/zod-prompter"
import { UI } from "../ui"

export async function collectStepInputs(step: WorkflowStep): Promise<{
  invocation?: unknown
  artifactSelections?: Record<string, { mode: "latest" | "all" | "indices"; indices?: number[] }>
}> {
  let invocation: unknown | undefined
  const artifactSelections: Record<string, { mode: "latest" | "all" | "indices"; indices?: number[] }> = {}

  const invocationSchema = step.inputs?.invocation?.schema
  const artifactBindings = step.inputs?.artifacts ?? []

  if (!invocationSchema && artifactBindings.length === 0) {
    return {}
  }

  if (invocationSchema) {
    const promptable = isPromptableZodObjectSchema(invocationSchema)
    const modeResult = await prompts.select({
      message: `Invocation input mode for ${step.id}`,
      options: [
        ...(promptable ? [{ label: "Guided fields", value: "guided" }] : []),
        { label: "Raw JSON", value: "json" },
      ],
      initialValue: promptable ? "guided" : "json",
    })
    if (prompts.isCancel(modeResult)) {
      throw new Error("Cancelled")
    }

    const mode = modeResult as "guided" | "json"
    if (mode === "guided" && promptable) {
      invocation = await promptZodObjectInput(invocationSchema)
    } else {
      while (true) {
        try {
          const value = await promptJsonInput(`Invocation JSON for ${step.id} (optional)`)
          if (typeof value === "undefined") {
            invocation = undefined
            break
          }
          invocation = invocationSchema.parse(value)
          break
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid invocation"
          prompts.log.error(message)
        }
      }
    }
  }

  for (const binding of artifactBindings) {
    const defaultMode = binding.cardinality.mode === "single" ? "latest" : "all"
    const modeResult = await prompts.select({
      message: `Artifact input ${binding.as} selector`,
      options: [
        { label: "latest", value: "latest" },
        { label: "all", value: "all" },
        { label: "indices", value: "indices" },
      ],
      initialValue: defaultMode,
    })
    if (prompts.isCancel(modeResult)) {
      throw new Error("Cancelled")
    }
    const mode = modeResult as "latest" | "all" | "indices"

    if (mode === "indices") {
      while (true) {
        const raw = await prompts.text({
          message: `Indices for ${binding.as} (comma separated, 1-based)`,
          placeholder: "1,2",
        })
        if (prompts.isCancel(raw)) {
          throw new Error("Cancelled")
        }

        try {
          artifactSelections[binding.as] = {
            mode,
            indices: parseIndicesSelection(raw),
          }
          break
        } catch (error) {
          prompts.log.error(error instanceof Error ? error.message : "Invalid indices")
        }
      }
    } else {
      artifactSelections[binding.as] = { mode }
    }
  }

  UI.println("invocation:", JSON.stringify(invocation ?? null))
  UI.println("artifact_selections:", JSON.stringify(artifactSelections))
  const approved = await prompts.confirm({
    message: "Start step with these inputs?",
    initialValue: true,
  })
  if (prompts.isCancel(approved) || !approved) {
    throw new Error("Cancelled")
  }

  const result: {
    invocation?: unknown
    artifactSelections?: Record<string, { mode: "latest" | "all" | "indices"; indices?: number[] }>
  } = {}
  if (typeof invocation !== "undefined") {
    result.invocation = invocation
  }
  if (Object.keys(artifactSelections).length > 0) {
    result.artifactSelections = artifactSelections
  }
  return result
}
