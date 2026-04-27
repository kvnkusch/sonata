import { describe, expect, it } from "bun:test"
import { composeOpenCodeKickoffPrompt } from "./opencode-framework-prompt"

describe("composeOpenCodeKickoffPrompt", () => {
  it("prepends standard framework completion contract and tool names", () => {
    const text = composeOpenCodeKickoffPrompt({
      prompt: "Write artifacts and complete.",
      artifacts: [
        { name: "topic", kind: "markdown", required: true },
        { name: "design-decisions", kind: "markdown" },
        { name: "plan-structured", kind: "json", schema: { parse(value: unknown) { return value } } },
      ],
    })

    expect(text).toContain("Sonata workflow step contract:")
    expect(text).toContain("`sonata_complete_step`")
    expect(text).toContain("call `sonata_block_step` once")
    expect(text).toContain("Required artifacts: `topic`.")
    expect(text).toContain("`sonata_write_topic_artifact_markdown`")
    expect(text).toContain("`sonata_write_design_decisions_artifact_markdown`")
    expect(text).toContain("`SONATA_OPS_ROOT/.sonata/staging/<taskId>/<stepId>/...`")
    expect(text).toContain('`{ source: "file", filePath }`')
    expect(text).toContain("Step instructions:\nWrite artifacts and complete.")
  })

  it("uses a shorter compact contract for child-style prompts", () => {
    const text = composeOpenCodeKickoffPrompt({
      contract: "compact",
      prompt: "Survey this sector.",
      artifacts: [{ name: "sector_report", kind: "json", required: true, schema: { parse(value: unknown) { return value } } }],
    })

    expect(text).toContain("Use Sonata tools to finish this step:")
    expect(text).toContain("call `sonata_block_step` once")
    expect(text).toContain("call `sonata_complete_step` exactly once")
    expect(text).toContain("Required artifacts: `sector_report`.")
    expect(text).toContain("`sonata_write_sector_report_artifact_json`")
    expect(text).not.toContain("Sonata workflow step contract:")
    expect(text).not.toContain("Do not claim the step is complete unless")
  })
})
