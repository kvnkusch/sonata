import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import z from "zod"
import { isPromptableZodObjectSchema, parseIndicesSelection, promptZodObjectInput } from "./zod-prompter"

describe("zod-prompter helpers", () => {
  it("parses and de-duplicates index selections", () => {
    expect(parseIndicesSelection("3, 1, 3,2")).toEqual([1, 2, 3])
  })

  it("rejects invalid index selections", () => {
    expect(() => parseIndicesSelection("")).toThrow("Provide at least one index")
    expect(() => parseIndicesSelection("0,2")).toThrow("Indices must be positive integers")
  })

  it("detects promptable zod object schemas", () => {
    const promptable = z.object({
      title: z.string().min(1),
      strictness: z.enum(["low", "medium", "high"]),
      retries: z.number().int().min(0).optional(),
      manual: z.boolean().optional(),
    })
    const notPromptable = z.object({
      items: z.array(z.string()),
    })

    expect(isPromptableZodObjectSchema(promptable)).toBe(true)
    expect(isPromptableZodObjectSchema(notPromptable)).toBe(false)
  })

  it("loads multiline string fields from a file", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "sonata-zod-prompter-"))
    const markdownPath = path.join(sandbox, "request.md")
    writeFileSync(markdownPath, "# Request\n\nLine one\nLine two\n", "utf8")

    const prompts = {
      async select() {
        return "file"
      },
      async text() {
        return markdownPath
      },
      isCancel(_value: unknown): _value is symbol {
        return false
      },
      log: {
        error() {},
      },
    } as Parameters<typeof promptZodObjectInput>[1]

    try {
      const result = await promptZodObjectInput(z.object({ request: z.string().min(1) }), prompts)
      expect(result).toEqual({ request: "# Request\n\nLine one\nLine two\n" })
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
