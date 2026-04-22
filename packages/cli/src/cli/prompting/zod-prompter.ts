import { readFile } from "node:fs/promises"
import * as prompts from "@clack/prompts"
import z from "zod"

const zAny = z as any
type PromptApi = Pick<typeof prompts, "text" | "select" | "isCancel"> & {
  log: Pick<typeof prompts.log, "error">
}

function unwrapSchema(schema: any): any {
  let current = schema
  while (true) {
    if (current instanceof zAny.ZodOptional || current instanceof zAny.ZodNullable) {
      current = current.unwrap()
      continue
    }
    if (current instanceof zAny.ZodDefault) {
      current = current.removeDefault()
      continue
    }
    return current
  }
}

function isPromptableFieldSchema(schema: any): boolean {
  const unwrapped = unwrapSchema(schema)
  return (
    unwrapped instanceof zAny.ZodString ||
    unwrapped instanceof zAny.ZodNumber ||
    unwrapped instanceof zAny.ZodBoolean ||
    unwrapped instanceof zAny.ZodEnum
  )
}

export function isPromptableZodObjectSchema(schema: unknown): boolean {
  if (!(schema instanceof zAny.ZodObject)) {
    return false
  }
  const shape = (schema as any).shape
  return Object.values(shape).every((field) => isPromptableFieldSchema(field))
}

export function parseIndicesSelection(raw: string): number[] {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) {
    throw new Error("Provide at least one index")
  }

  const parsed = parts.map((part) => Number(part))
  if (parsed.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error("Indices must be positive integers")
  }
  return [...new Set(parsed)].sort((a, b) => a - b)
}

async function promptField(name: string, schema: any, promptApi: PromptApi = prompts): Promise<unknown> {
  const optional = schema.safeParse(undefined).success
  const unwrapped = unwrapSchema(schema)

  if (unwrapped instanceof zAny.ZodBoolean) {
    const value = await promptApi.select({
      message: `${name}${optional ? " (optional)" : ""}`,
      options: [
        { label: "true", value: true },
        { label: "false", value: false },
        ...(optional ? [{ label: "skip", value: undefined }] : []),
      ],
    })
    if (promptApi.isCancel(value)) {
      throw new Error("Cancelled")
    }
    return value
  }

  if (unwrapped instanceof zAny.ZodEnum) {
    while (true) {
      const value = await promptApi.select({
        message: `${name}${optional ? " (optional)" : ""}`,
        options: [
          ...unwrapped.options.map((option: string) => ({ label: option, value: option })),
          { label: "type custom...", value: "__custom__" },
          ...(optional ? [{ label: "skip", value: undefined }] : []),
        ],
      })
      if (promptApi.isCancel(value)) {
        throw new Error("Cancelled")
      }
      if (value !== "__custom__") {
        return value
      }

      const raw = await promptApi.text({
        message: `${name} custom value`,
        placeholder: String(unwrapped.options[0] ?? "value"),
      })
      if (promptApi.isCancel(raw)) {
        throw new Error("Cancelled")
      }
      const parsed = schema.safeParse(raw.trim())
      if (parsed.success) {
        return parsed.data
      }
      promptApi.log.error(parsed.error.issues[0]?.message ?? `Invalid value for ${name}`)
    }
  }

  if (unwrapped instanceof zAny.ZodString) {
    while (true) {
      const mode = await promptApi.select({
        message: `${name}${optional ? " (optional)" : ""}`,
        options: [
          { label: "Enter text", value: "text" },
          { label: "Load from file", value: "file" },
          ...(optional ? [{ label: "skip", value: "skip" }] : []),
        ],
        initialValue: "text",
      })
      if (promptApi.isCancel(mode)) {
        throw new Error("Cancelled")
      }
      if (mode === "skip") {
        return undefined
      }

      if (mode === "file") {
        const rawPath = await promptApi.text({
          message: `${name} file path`,
          placeholder: "./request.md",
        })
        if (promptApi.isCancel(rawPath)) {
          throw new Error("Cancelled")
        }

        const filePath = rawPath.trim()
        if (!filePath) {
          promptApi.log.error("File path is required")
          continue
        }

        try {
          const candidate = await readFile(filePath, "utf8")
          const parsed = schema.safeParse(candidate)
          if (parsed.success) {
            return parsed.data
          }
          promptApi.log.error(parsed.error.issues[0]?.message ?? `Invalid value for ${name}`)
          continue
        } catch (error) {
          promptApi.log.error(error instanceof Error ? error.message : `Failed to read ${filePath}`)
          continue
        }
      }

      const raw = await promptApi.text({
        message: `${name}${optional ? " (optional)" : ""}`,
        placeholder: "value",
      })
      if (promptApi.isCancel(raw)) {
        throw new Error("Cancelled")
      }

      const text = raw.trim()
      if (!text && optional) {
        return undefined
      }
      if (!text) {
        promptApi.log.error(`${name} is required`)
        continue
      }

      const parsed = schema.safeParse(raw)
      if (parsed.success) {
        return parsed.data
      }
      promptApi.log.error(parsed.error.issues[0]?.message ?? `Invalid value for ${name}`)
    }
  }

  while (true) {
    const raw = await promptApi.text({
      message: `${name}${optional ? " (optional)" : ""}`,
      placeholder: unwrapped instanceof zAny.ZodNumber ? "42" : "value",
    })
    if (promptApi.isCancel(raw)) {
      throw new Error("Cancelled")
    }

    const text = raw.trim()
    if (!text && optional) {
      return undefined
    }
    if (!text) {
      prompts.log.error(`${name} is required`)
      continue
    }

    const candidate: unknown = unwrapped instanceof zAny.ZodNumber ? Number(text) : text
    const parsed = schema.safeParse(candidate)
    if (parsed.success) {
      return parsed.data
    }
    promptApi.log.error(parsed.error.issues[0]?.message ?? `Invalid value for ${name}`)
  }
}

export async function promptZodObjectInput(schema: any, promptApi: PromptApi = prompts): Promise<unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, fieldSchema] of Object.entries(schema.shape as Record<string, unknown>)) {
    const value = await promptField(name, fieldSchema, promptApi)
    if (typeof value !== "undefined") {
      result[name] = value
    }
  }
  return schema.parse(result)
}

export async function promptJsonInput(message: string): Promise<unknown | undefined> {
  const raw = await prompts.text({
    message,
    placeholder: '{"key":"value"}',
  })
  if (prompts.isCancel(raw)) {
    throw new Error("Cancelled")
  }
  const text = raw.trim()
  if (!text) {
    return undefined
  }
  return JSON.parse(text)
}
