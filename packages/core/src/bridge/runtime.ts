import { SONATA_COMPLETE_TOOL_NAME } from "../step/get-toolset"
import { getStepToolset } from "../step/get-toolset"
import { invokeStepTool } from "../step/invoke-tool"
import { writeStepArtifact } from "../step/write-artifact"

export class BridgeRuntimeEnvError extends Error {
  constructor(readonly envVar: string) {
    super(`Missing required Sonata bridge env var: ${envVar}`)
    this.name = "BridgeRuntimeEnvError"
  }
}

export type BridgeRuntimeEnv = {
  taskId: string
  stepId: string
  projectRoot?: string
  opsRoot?: string
}

export type BridgeToolHandler = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  argsSchema: Record<string, unknown>
  invoke: (args: unknown, options?: { sessionId?: string }) => Promise<unknown>
}

function requiredEnv(name: string, env: Record<string, string | undefined>): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new BridgeRuntimeEnvError(name)
  }
  return value
}

export function resolveBridgeRuntimeEnv(env: Record<string, string | undefined> = process.env): BridgeRuntimeEnv {
  const taskId = requiredEnv("SONATA_TASK_ID", env)
  const stepId = requiredEnv("SONATA_STEP_ID", env)

  return {
    taskId,
    stepId,
    projectRoot: env.SONATA_PROJECT_ROOT?.trim() || undefined,
    opsRoot: env.SONATA_OPS_ROOT?.trim() || undefined,
  }
}

export async function startupBridgeRuntime(input?: {
  env?: Record<string, string | undefined>
  runtimeEnv?: BridgeRuntimeEnv
}) {
  const runtimeEnv = input?.runtimeEnv ?? resolveBridgeRuntimeEnv(input?.env ?? process.env)

  const toolset = await getStepToolset({
    taskId: runtimeEnv.taskId,
    stepId: runtimeEnv.stepId,
  })

  const tools: BridgeToolHandler[] = toolset.tools.map((tool) => {
    if (tool.name === SONATA_COMPLETE_TOOL_NAME) {
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        argsSchema: {},
        invoke: async (_args, options) => {
          const { completeStepInRuntime } = await import("../execution/step")
          const completion = await completeStepInRuntime({
            taskId: runtimeEnv.taskId,
            stepId: runtimeEnv.stepId,
            sessionId: options?.sessionId,
            manual: false,
          })
          return completion
        },
      }
    }

    if ("customToolId" in tool) {
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        argsSchema: tool.argsSchema,
        invoke: async (args, options) => {
          const result = await invokeStepTool({
            taskId: runtimeEnv.taskId,
            stepId: runtimeEnv.stepId,
            toolId: tool.customToolId,
            args,
            sessionId: options?.sessionId,
          })
          return result.result
        },
      }
    }

    if (!("artifactName" in tool) || !("artifactKind" in tool)) {
      throw new Error(`Unsupported Sonata bridge tool declaration: ${tool.name}`)
    }

    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      argsSchema: tool.argsSchema,
      invoke: async (args, options) => {
        return writeStepArtifact({
          taskId: runtimeEnv.taskId,
          stepId: runtimeEnv.stepId,
          artifactName: tool.artifactName,
          artifactKind: tool.artifactKind,
          payload: args as { markdown: string } | { data: unknown },
          sessionId: options?.sessionId,
        })
      },
    }
  })

  return {
    env: runtimeEnv,
    toolset,
    tools,
  }
}
