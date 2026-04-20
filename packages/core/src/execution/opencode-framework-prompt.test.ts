import { describe, expect, it } from "bun:test"
import { composeOpenCodeKickoffPrompt } from "./opencode-framework-prompt"

describe("composeOpenCodeKickoffPrompt", () => {
  it("prepends framework completion contract and tool names", () => {
    const text = composeOpenCodeKickoffPrompt({
      prompt: "Write artifacts and complete.",
      artifacts: [
        { name: "topic", kind: "markdown", required: true },
        { name: "design-decisions", kind: "markdown" },
      ],
    })

    expect(text).toContain("Completion contract:")
    expect(text).toContain("`sonata_complete_step`")
    expect(text).toContain("Required artifacts: `topic`.")
    expect(text).toContain("`sonata_write_topic_artifact_markdown`")
    expect(text).toContain("`sonata_write_design_decisions_artifact_markdown`")
    expect(text).toContain("Step instructions:\nWrite artifacts and complete.")
  })
})
