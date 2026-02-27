import { z } from "zod"

type JsonSchema = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strictifyJsonSchema(input: unknown): JsonSchema {
  if (!isRecord(input)) {
    return {}
  }

  const schema: JsonSchema = { ...input }
  const properties = isRecord(schema.properties) ? schema.properties : null

  if (properties) {
    schema.required = Object.keys(properties)
    if (typeof schema.additionalProperties === "undefined") {
      schema.additionalProperties = false
    }
    for (const [key, value] of Object.entries(properties)) {
      properties[key] = strictifyJsonSchema(value)
    }
    schema.properties = properties
  }

  if (Array.isArray(schema.items)) {
    schema.items = schema.items.map((item) => strictifyJsonSchema(item))
  } else if (typeof schema.items !== "undefined") {
    schema.items = strictifyJsonSchema(schema.items)
  }

  if (Array.isArray(schema.oneOf)) {
    schema.oneOf = schema.oneOf.map((item) => strictifyJsonSchema(item))
  }

  if (Array.isArray(schema.anyOf)) {
    schema.anyOf = schema.anyOf.map((item) => strictifyJsonSchema(item))
  }

  if (Array.isArray(schema.allOf)) {
    schema.allOf = schema.allOf.map((item) => strictifyJsonSchema(item))
  }

  if (typeof schema.not !== "undefined") {
    schema.not = strictifyJsonSchema(schema.not)
  }

  return schema
}

export function zodToStrictJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const base = z.toJSONSchema(schema, { target: "draft-7" }) as JsonSchema
  return strictifyJsonSchema(base)
}
