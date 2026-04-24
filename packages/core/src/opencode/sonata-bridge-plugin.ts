import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { startupBridgeRuntime } from "../bridge"

export const SonataBridgePlugin: Plugin = async () => {
  const runtime = await startupBridgeRuntime()
  const dynamicTools: Record<string, ReturnType<typeof tool>> = {}

  for (const item of runtime.tools) {
    dynamicTools[item.name] = tool({
      description: item.description,
      args: item.argsSchema as never,
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
