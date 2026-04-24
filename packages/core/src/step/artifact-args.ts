import z from "zod"

const jsonArtifactImportFilePathDescription =
  "Path under opsRoot/.sonata/staging/<taskId>/<stepId>/ containing the JSON payload to import"

export const markdownArtifactArgsShape = {
  markdown: z.string().min(1),
} satisfies z.ZodRawShape

export const markdownArtifactPayloadSchema = z.object(markdownArtifactArgsShape).strict()

export type MarkdownArtifactPayload = z.infer<typeof markdownArtifactPayloadSchema>

export const jsonArtifactImportFilePathSchema = z
  .string()
  .min(1)
  .describe(jsonArtifactImportFilePathDescription)

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
    z
      .object({
        source: z.literal("inline"),
        data: input?.dataSchema ?? z.unknown(),
      })
      .strict(),
    z
      .object({
        source: z.literal("file"),
        filePath: jsonArtifactImportFilePathSchema,
      })
      .strict(),
  ])
}

export type JsonArtifactPayload =
  | { source: "inline"; data: unknown }
  | { source: "file"; filePath: string }

export type WriteArtifactPayload =
  | MarkdownArtifactPayload
  | JsonArtifactPayload
