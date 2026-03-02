import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { startupBridgeRuntime } from "../bridge"

type ToolArgSchema = ReturnType<typeof tool.schema.any>

function toToolArgsSchema(inputSchema: Record<string, unknown>): Record<string, ToolArgSchema> {
  const properties =
    typeof inputSchema.properties === "object" && inputSchema.properties !== null
      ? (inputSchema.properties as Record<string, unknown>)
      : {}

  const args: Record<string, ToolArgSchema> = {}
  for (const key of Object.keys(properties)) {
    args[key] = tool.schema.any()
  }
  return args
}

export const SonataBridgePlugin: Plugin = async () => {
  const params = new URL(import.meta.url).searchParams
  const runtime = await startupBridgeRuntime({
    runtimeEnv:
      params.get("taskId") && params.get("stepId")
        ? {
            taskId: params.get("taskId")!,
            stepId: params.get("stepId")!,
            projectRoot: params.get("projectRoot") ?? undefined,
            opsRoot: params.get("opsRoot") ?? undefined,
          }
        : undefined,
  })
  const dynamicTools: Record<string, ReturnType<typeof tool>> = {}

  for (const item of runtime.tools) {
    dynamicTools[item.name] = tool({
      description: item.description,
      args: toToolArgsSchema(item.inputSchema),
      async execute(args: Record<string, unknown>, ctx: { sessionID: string }) {
        const result = await item.invoke(args, { sessionId: ctx.sessionID })
        return typeof result === "string" ? result : JSON.stringify(result)
      },
    })
  }

  return {
    tool: dynamicTools,
  }
}

export default SonataBridgePlugin
