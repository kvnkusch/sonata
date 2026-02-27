import { describe, expect, it } from "bun:test"
import { artifactFileName, artifactRelativePath, zeroPadStepIndex } from "./path"

describe("artifact path", () => {
  it("zero-pads step indexes to 3 digits", () => {
    expect(zeroPadStepIndex(1)).toBe("001")
    expect(zeroPadStepIndex(12)).toBe("012")
    expect(zeroPadStepIndex(123)).toBe("123")
  })

  it("slugifies segments and maps extension by kind", () => {
    expect(
      artifactFileName({
        stepIndex: 2,
        stepKey: "Plan & Research",
        artifactName: "Plan Summary",
        artifactKind: "markdown",
      }),
    ).toBe("002-plan-research-plan-summary.md")

    expect(
      artifactRelativePath({
        taskId: "tsk_abc",
        stepIndex: 3,
        stepKey: "Ship",
        artifactName: "Plan Structured",
        artifactKind: "json",
      }),
    ).toBe("tasks/tsk_abc/003-ship-plan-structured.json")
  })
})
