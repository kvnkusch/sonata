import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { getDeclaredArtifact, missingRequiredArtifacts } from "./validation"
import type { WorkflowStepArtifact } from "../workflow/module"

describe("step.validation", () => {
  it("finds declared artifacts", () => {
    const artifacts: WorkflowStepArtifact[] = [
      { name: "plan_summary", kind: "markdown", required: true, once: true } as const,
      {
        name: "plan_structured",
        kind: "json",
        schema: z.object({ bullets: z.array(z.string()) }),
      } as const,
    ]

    expect(getDeclaredArtifact(artifacts, "plan_summary")?.kind).toBe("markdown")
    expect(getDeclaredArtifact(artifacts, "missing")).toBeUndefined()
  })

  it("gates completion on missing required artifacts", () => {
    const artifacts: WorkflowStepArtifact[] = [
      { name: "plan_summary", kind: "markdown", required: true } as const,
      {
        name: "plan_structured",
        kind: "json",
        required: false,
        schema: z.object({ ok: z.boolean() }),
      },
    ]

    expect(
      missingRequiredArtifacts({
        artifacts,
        writtenArtifactNames: new Set(["plan_structured"]),
      }),
    ).toEqual(["plan_summary"])
  })
})
