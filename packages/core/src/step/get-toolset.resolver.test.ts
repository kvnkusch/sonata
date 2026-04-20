import { describe, expect, it } from "bun:test"
import { resolveCustomToolName, resolveCustomToolNameMap } from "./get-toolset"

describe("step.getToolset resolver", () => {
  it("resolves deterministic names from step key and tool id", () => {
    expect(resolveCustomToolName({ stepKey: "plan", toolId: "fetch_context" })).toBe(
      "sonata_step_plan__fetch_context",
    )
    expect(resolveCustomToolName({ stepKey: "Plan Step", toolId: "fetch-context" })).toBe(
      "sonata_step_Plan_Step__fetch_context",
    )
  })

  it("accepts literal artifact as a valid normalized name part", () => {
    expect(resolveCustomToolName({ stepKey: "artifact", toolId: "artifact" })).toBe(
      "sonata_step_artifact__artifact",
    )
  })

  it("rejects tool ids that normalize to empty", () => {
    expect(() => resolveCustomToolName({ stepKey: "plan", toolId: "!!!" })).toThrow(
      "Tool identifier normalizes to an empty name",
    )
  })

  it("builds tool id to resolved name mapping", () => {
    const mapping = resolveCustomToolNameMap({
      stepKey: "plan",
      tools: {
        fetch_context: {
          description: "Fetch context",
          argsSchema: {},
          async execute() {
            return "ok"
          },
        },
      },
    })

    expect(mapping.fetch_context?.name).toBe("sonata_step_plan__fetch_context")
    expect(Object.keys(mapping)).toEqual(["fetch_context"])
  })
})
