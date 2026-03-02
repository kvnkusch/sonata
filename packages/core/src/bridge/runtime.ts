import { createCaller } from "../rpc"

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
  caller?: ReturnType<typeof createCaller>
}) {
  const runtimeEnv = input?.runtimeEnv ?? resolveBridgeRuntimeEnv(input?.env ?? process.env)
  const caller = input?.caller ?? createCaller()

  const toolset = await caller.step.getToolset({
    taskId: runtimeEnv.taskId,
    stepId: runtimeEnv.stepId,
  })

  const tools: BridgeToolHandler[] = toolset.tools.map((tool) => {
    if (tool.name === "sonata_complete_step") {
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        invoke: async (_args, options) => {
          return caller.step.complete({
            taskId: runtimeEnv.taskId,
            stepId: runtimeEnv.stepId,
            sessionId: options?.sessionId,
          })
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
      invoke: async (args, options) => {
        return caller.step.writeArtifact({
          taskId: runtimeEnv.taskId,
          stepId: runtimeEnv.stepId,
          artifactName: tool.artifactName,
          artifactKind: tool.artifactKind,
          payload: args,
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
