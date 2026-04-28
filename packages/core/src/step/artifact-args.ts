import z from "zod"

const jsonArtifactImportFilePathDescription =
  "Path under opsRoot/.sonata/staging/<taskId>/<stepId>/ containing the JSON payload to import"
const jsonlArtifactImportFilePathDescription =
  "Path under opsRoot/.sonata/staging/<taskId>/<stepId>/ containing the JSONL payload to import"

export const markdownArtifactArgsShape = {
  markdown: z.string().min(1),
} satisfies z.ZodRawShape

export const markdownArtifactPayloadSchema = z.object(markdownArtifactArgsShape)

export type MarkdownArtifactPayload = z.infer<typeof markdownArtifactPayloadSchema>

export const jsonArtifactImportFilePathSchema = z
  .string()
  .min(1)
  .describe(jsonArtifactImportFilePathDescription)

export const jsonlArtifactImportFilePathSchema = z
  .string()
  .min(1)
  .describe(jsonlArtifactImportFilePathDescription)

export function jsonArtifactArgsShape(input?: {
  dataSchema?: z.ZodTypeAny
}): z.ZodRawShape {
  return {
    source: z.enum(["inline", "file"]),
    data: (input?.dataSchema ?? z.unknown()).optional(),
    filePath: jsonArtifactImportFilePathSchema.optional(),
  }
}

export function jsonArtifactPayloadSchema(input?: {
  dataSchema?: z.ZodTypeAny
}) {
  return z.discriminatedUnion("source", [
    z.object({
      source: z.literal("inline"),
      data: input?.dataSchema ?? z.unknown(),
    }),
    z.object({
      source: z.literal("file"),
      filePath: jsonArtifactImportFilePathSchema,
    }),
  ])
}

export const jsonlArtifactArgsShape = {
  source: z.enum(["inline", "file"]),
  jsonl: z.string().min(1).optional(),
  filePath: jsonlArtifactImportFilePathSchema.optional(),
} satisfies z.ZodRawShape

export const jsonlArtifactPayloadSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("inline"),
    jsonl: z.string().min(1),
  }),
  z.object({
    source: z.literal("file"),
    filePath: jsonlArtifactImportFilePathSchema,
  }),
])

export type JsonArtifactPayload =
  | { source: "inline"; data: unknown }
  | { source: "file"; filePath: string }

export type JsonlArtifactPayload = z.infer<typeof jsonlArtifactPayloadSchema>

export type WriteArtifactPayload =
  | MarkdownArtifactPayload
  | JsonArtifactPayload
  | JsonlArtifactPayload
