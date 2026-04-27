import { z } from "zod"

type JsonSchema = Record<string, unknown>

export function zodToStrictJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return z.toJSONSchema(schema, { target: "draft-7" }) as JsonSchema
}
