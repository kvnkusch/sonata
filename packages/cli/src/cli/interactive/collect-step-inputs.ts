import * as prompts from "@clack/prompts"
import type { createCaller } from "@sonata/core/rpc"
import type { WorkflowStep } from "@sonata/core/workflow"
import {
  isPromptableZodObjectSchema,
  parseIndicesSelection,
  promptJsonInput,
  promptZodObjectInput,
} from "../prompting/zod-prompter"
import { UI } from "../ui"

export async function collectStepInputs(
  step: WorkflowStep,
  context?: {
    taskId: string
    caller: ReturnType<typeof createCaller>
  },
): Promise<{
  invocation?: unknown
  artifactSelections?: Record<string, { mode: "latest" | "all" | "indices"; indices?: number[] }>
}> {
  let invocation: unknown | undefined
  const artifactSelections: Record<string, { mode: "latest" | "all" | "indices"; indices?: number[] }> = {}

  const invocationSchema = step.inputs?.invocation?.schema
  const artifactBindings = step.inputs?.artifacts ?? []
  const artifactCandidatesByBinding = new Map<string, Awaited<ReturnType<ReturnType<typeof createCaller>["step"]["listInputArtifacts"]>>["bindings"][number]["candidates"]>()

  if (context && artifactBindings.length > 0) {
    try {
      const listed = await context.caller.step.listInputArtifacts({ taskId: context.taskId, stepKey: step.id })
      for (const binding of listed.bindings) {
        artifactCandidatesByBinding.set(binding.as, binding.candidates)
      }
    } catch {
      // Fall back to static selection prompts if artifact preview cannot be loaded.
    }
  }

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
    const candidates = artifactCandidatesByBinding.get(binding.as) ?? []
    if (binding.cardinality.mode === "single" && candidates.length === 1) {
      artifactSelections[binding.as] = { mode: "latest" }
      UI.println(`artifact_input_${binding.as}:`, `auto-selected only candidate (${candidates[0]?.relativePath ?? "unknown"})`)
      continue
    }

    const defaultMode = binding.cardinality.mode === "single" ? "latest" : "all"
    const modeOptions =
      binding.cardinality.mode === "single"
        ? [
            { label: "latest", value: "latest" },
            { label: "indices", value: "indices" },
          ]
        : [
            { label: "latest", value: "latest" },
            { label: "all", value: "all" },
            { label: "indices", value: "indices" },
          ]
    const modeResult = await prompts.select({
      message: `Artifact input ${binding.as} selector`,
      options: modeOptions,
      initialValue: defaultMode,
    })
    if (prompts.isCancel(modeResult)) {
      throw new Error("Cancelled")
    }
    const mode = modeResult as "latest" | "all" | "indices"

    if (mode === "indices") {
      if (candidates.length > 0) {
        const selections = await prompts.multiselect<number>({
          message: `Select artifacts for ${binding.as}`,
          options: candidates.map((candidate, idx) => ({
            label: `[${idx + 1}] ${candidate.stepKey}#${candidate.stepIndex} ${candidate.artifactName} (${candidate.artifactKind})`,
            hint: candidate.relativePath,
            value: idx + 1,
          })),
          required: true,
        })
        if (prompts.isCancel(selections)) {
          throw new Error("Cancelled")
        }
        artifactSelections[binding.as] = {
          mode,
          indices: parseIndicesSelection((selections as number[]).join(",")),
        }
        continue
      }

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
