import { describe, expect, it } from "bun:test"
import z from "zod"
import { isPromptableZodObjectSchema, parseIndicesSelection } from "./zod-prompter"

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
})
