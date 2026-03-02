import z from "zod"
import type { StepInputsSnapshot } from "../workflow/module"

const snapshotSchema = z.object({
  invocation: z.unknown().nullable().optional(),
  artifacts: z
    .record(
      z.string(),
      z.object({
        mode: z.enum(["single", "multiple"]),
        selectedBy: z.enum(["latest", "all", "indices"]),
        refs: z.array(
          z.object({
            artifactName: z.string(),
            artifactKind: z.enum(["markdown", "json"]),
            relativePath: z.string(),
            stepId: z.string(),
            stepKey: z.string(),
            stepIndex: z.number().int(),
            writtenAt: z.number().int(),
          }),
        ),
      }),
    )
    .optional(),
})

export function parseStepInputsSnapshot(input: { taskId: string; stepId: string; value: string }): StepInputsSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.value)
  } catch {
    throw new Error(`Invalid frozen step inputs JSON for task=${input.taskId} step=${input.stepId}`)
  }

  const validated = snapshotSchema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`Invalid frozen step inputs shape for task=${input.taskId} step=${input.stepId}`)
  }

  return {
    invocation: (validated.data.invocation ?? null) as StepInputsSnapshot["invocation"],
    artifacts: validated.data.artifacts ?? {},
  }
}
