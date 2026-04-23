import { createServer } from "node:net"
import { createOpencodeClient, createOpencodeServer, type Config } from "@opencode-ai/sdk/v2"
import { eq } from "drizzle-orm"
import { db, projectTable, stepTable, taskTable, type DbExecutor } from "../db"
import { composeOpenCodeKickoffPrompt } from "./opencode-framework-prompt"
import { staticSonataBridgePluginUrl } from "../opencode"
import { ErrorCode, RpcError } from "../rpc/base"
import {
  completeStepWithGuards,
  createStepContextBase,
  failStep,
  hydrateStepInputs,
  parseStepInputsSnapshot,
  setStepSession,
} from "../step"
import { resolveCustomToolNameMap } from "../step/get-toolset"
import { enterWaitingIfNeeded, wakeWaitingParentIfReady } from "../step/waiting"
import { loadWorkflowForTask } from "../workflow"
import type {
  StepContextWithOpenCode,
  StepRunResult,
  WorkflowStepWithOpenCode,
} from "../workflow/module"

export type ExecuteStepInput = {
  taskId: string
  stepId: string
}

export type ExecuteStepResult = {
  status: "active" | "waiting" | "completed" | "blocked" | "failed"
  suggestedNextStepKey: string | null
  failure?: {
    reason: string
    details?: unknown
  }
  opencode?: {
    baseUrl: string
    sessionId: string
    reused: boolean
    close?: () => void
  }
}

export type CompleteStepInRuntimeInput = {
  taskId: string
  stepId: string
  completionPayload?: unknown
  sessionId?: string
  messageId?: string
  manual?: boolean
}

export type CompleteStepInRuntimeResult = {
  status: "completed"
  suggestedNextStepKey: string | null
}

type ActiveOpenCodeSession = {
  baseUrl: string
  sessionId: string
  reused: boolean
  close?: () => void
}

const REQUIRED_SONATA_TOOL_ID = "sonata_complete_step"

function isOpenCodeStep(step: unknown): step is WorkflowStepWithOpenCode {
  return typeof step === "object" && step !== null && "opencode" in step
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim()
  }
  return "Step execution failed"
}

function isStepRunResult(value: unknown): value is StepRunResult {
  if (!value || typeof value !== "object") {
    return false
  }
  const status = (value as { status?: unknown }).status
  return status === "completed" || status === "failed"
}

function failureReasonFromStep(step: { completionPayloadJson: string | null }): string | undefined {
  if (!step.completionPayloadJson) {
    return undefined
  }
  try {
    const parsed = JSON.parse(step.completionPayloadJson) as { reason?: unknown }
    if (typeof parsed.reason === "string" && parsed.reason.trim().length > 0) {
      return parsed.reason
    }
  } catch {
    return undefined
  }
  return undefined
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate an ephemeral port")))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolvePort(port)
      })
    })
  })
}

async function canReuseExistingSession(input: {
  projectRoot: string
  baseUrl: string
  sessionId: string
}): Promise<boolean> {
  try {
    const client = createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.projectRoot,
    })
    await client.session.messages({ sessionID: input.sessionId }, { throwOnError: true })
    return true
  } catch {
    return false
  }
}

async function withTemporaryEnv<T>(
  vars: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }

  try {
    return await run()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (typeof value === "string") {
        process.env[key] = value
      } else {
        delete process.env[key]
      }
    }
  }
}

export async function executeStep(
  input: ExecuteStepInput,
  executor: DbExecutor = db(),
): Promise<ExecuteStepResult> {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`)
  }
  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new Error(`Step not found: ${input.stepId}`)
  }
  const project = executor.select().from(projectTable).where(eq(projectTable.projectId, task.projectId)).get()
  if (!project) {
    throw new Error(`Project not found: ${task.projectId}`)
  }

  const loaded = await loadWorkflowForTask(input.taskId, executor)
  const workflowStep = loaded.workflow.steps.find((candidate) => candidate.id === step.stepKey)
  if (!workflowStep) {
    throw new Error(`Workflow step not found in ${loaded.workflow.id}: ${step.stepKey}`)
  }

  const snapshot = parseStepInputsSnapshot({
    taskId: input.taskId,
    stepId: input.stepId,
    value: step.inputs,
  })

  const inputs = await hydrateStepInputs({
    taskId: input.taskId,
    stepId: input.stepId,
    opsRoot: project.opsRootRealpath,
    workflowSteps: loaded.workflow.steps,
    snapshot,
  })

  const baseCtx = createStepContextBase({
    taskId: input.taskId,
    stepId: input.stepId,
    projectRoot: project.projectRootRealpath,
    opsRoot: project.opsRootRealpath,
    inputs,
    executor,
  })

  let activeSession: ActiveOpenCodeSession | undefined
  const resolvedOpenCodeTools = isOpenCodeStep(workflowStep)
    ? resolveCustomToolNameMap({ stepKey: step.stepKey, tools: workflowStep.opencode.tools })
    : undefined

  const ctx = isOpenCodeStep(workflowStep)
    ? ({
        ...baseCtx,
        opencode: {
          tools: resolvedOpenCodeTools ?? {},
          start: async (params: { title?: string; prompt: string }) => {
            const current = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
            if (current?.sessionId && current.opencodeBaseUrl) {
              const reusable = await canReuseExistingSession({
                projectRoot: project.projectRootRealpath,
                baseUrl: current.opencodeBaseUrl,
                sessionId: current.sessionId,
              })
              if (reusable) {
                activeSession = {
                  baseUrl: current.opencodeBaseUrl,
                  sessionId: current.sessionId,
                  reused: true,
                }
                await (workflowStep as WorkflowStepWithOpenCode).on(ctxRef! as never, {
                  type: "opencode.started",
                  sessionId: current.sessionId,
                  reused: true,
                } as never)
                return
              }
            }

            const pluginUrl = staticSonataBridgePluginUrl()
            const opencodeConfig: Config = { plugin: [pluginUrl] }
            const opencodeEnv = {
              SONATA_TASK_ID: input.taskId,
              SONATA_STEP_ID: input.stepId,
              SONATA_PROJECT_ROOT: project.projectRootRealpath,
              SONATA_OPS_ROOT: project.opsRootRealpath,
            }

            const port = await allocatePort()
            const server = await withTemporaryEnv(opencodeEnv, async () => {
              return createOpencodeServer({
                hostname: "127.0.0.1",
                port,
                timeout: 15_000,
                config: opencodeConfig,
              })
            })
            const client = createOpencodeClient({
              baseUrl: server.url,
              directory: project.projectRootRealpath,
            })
            const created = await client.session.create(
              { title: params.title ?? `Sonata ${workflowStep.title}` },
              { throwOnError: true },
            )
            const sessionId = created.data.id

            const toolIdsResult = await client.tool.ids({}, { throwOnError: true })
            const toolIds = toolIdsResult.data
            if (!toolIds.includes(REQUIRED_SONATA_TOOL_ID)) {
              throw new Error(
                `OpenCode session missing required Sonata bridge tool ${REQUIRED_SONATA_TOOL_ID} for task=${input.taskId} step=${input.stepId}. Available tools: ${toolIds.join(", ")}`,
              )
            }

            const prompt = composeOpenCodeKickoffPrompt({
              prompt: params.prompt,
              artifacts: workflowStep.artifacts,
            })

            await client.session.promptAsync(
              {
                sessionID: sessionId,
                parts: [{ type: "text", text: prompt }],
              },
              { throwOnError: true },
            )

            setStepSession(
              {
                taskId: input.taskId,
                stepId: input.stepId,
                sessionId,
                baseUrl: server.url,
              },
              executor,
            )

            activeSession = {
              baseUrl: server.url,
              sessionId,
              reused: false,
              close: server.close,
            }
            await (workflowStep as WorkflowStepWithOpenCode).on(ctxRef! as never, {
              type: "opencode.started",
              sessionId,
              reused: false,
            } as never)
          },
        },
      } satisfies StepContextWithOpenCode)
    : baseCtx

  const ctxRef = isOpenCodeStep(workflowStep) ? (ctx as StepContextWithOpenCode) : null

  await workflowStep.on(ctx as never, { type: "step.started" } as never)

  try {
    const runResult = await workflowStep.run(ctx as never)

    if (isStepRunResult(runResult)) {
      if (runResult.status === "completed") {
        const completion = await completeStepWithGuards({
          taskId: input.taskId,
          stepId: input.stepId,
          completionPayload: runResult.completionPayload,
        }, executor)
        wakeWaitingParentIfReady({ taskId: input.taskId, stepId: input.stepId, executor })
        await completion.workflowStep.on(completion.ctx as never, { type: "step.completed" } as never)
        return {
          status: "completed",
          suggestedNextStepKey: completion.suggestedNextStepKey,
          opencode: activeSession,
        }
      }

      failStep(
        {
          taskId: input.taskId,
          stepId: input.stepId,
          reason: runResult.reason,
        },
        executor,
      )
      await workflowStep.on(ctx as never, { type: "step.failed", error: new Error(runResult.reason) } as never)
      return {
        status: "failed",
        suggestedNextStepKey: null,
        failure: {
          reason: runResult.reason,
          details: runResult.details,
        },
        opencode: activeSession,
      }
    }

    const currentStep = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
    if (currentStep?.status === "active" && workflowStep.waitFor) {
      if (currentStep.parentStepId !== null) {
        throw new RpcError(ErrorCode.INVALID_INPUT, 409, `Only root steps may wait for persisted conditions: ${input.stepId}`)
      }

      const waitSpec = await workflowStep.waitFor(ctx as never)
      if (waitSpec) {
        const enteredWaiting = enterWaitingIfNeeded({
          taskId: input.taskId,
          stepId: input.stepId,
          stepIndex: currentStep.stepIndex,
          waitSpec,
          executor,
        })
        if (enteredWaiting) {
          return {
            status: "waiting",
            suggestedNextStepKey: null,
            opencode: activeSession,
          }
        }
      }
    }
  } catch (error) {
    if (
      error instanceof RpcError &&
      (error.code === ErrorCode.REQUIRED_ARTIFACT_MISSING || error.code === ErrorCode.STEP_COMPLETION_GUARD_REJECTED)
    ) {
      return {
        status: "active",
        suggestedNextStepKey: null,
        opencode: activeSession,
      }
    }

    const reason = safeErrorMessage(error)
    try {
      failStep(
        {
          taskId: input.taskId,
          stepId: input.stepId,
          reason,
        },
        executor,
      )
    } catch (failError) {
      if (!(failError instanceof RpcError) || failError.code !== ErrorCode.INVALID_STEP_TRANSITION) {
        throw failError
      }
    }
    const wrapped = new Error(reason)
    await workflowStep.on(ctx as never, { type: "step.failed", error: wrapped } as never)
    return {
      status: "failed",
      suggestedNextStepKey: null,
      failure: { reason },
      opencode: activeSession,
    }
  }

  const updated = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (updated?.status === "completed") {
    await workflowStep.on(ctx as never, { type: "step.completed" } as never)
    return {
      status: "completed",
      suggestedNextStepKey: updated.parentStepId === null ? workflowStep.next ?? null : null,
      opencode: activeSession,
    }
  }

  if (updated?.status === "failed") {
    const reason = failureReasonFromStep(updated) ?? "Step failed"
    await workflowStep.on(ctx as never, { type: "step.failed", error: new Error(reason) } as never)
    return {
      status: "failed",
      suggestedNextStepKey: null,
      failure: { reason },
      opencode: activeSession,
    }
  }

  if (updated?.status === "blocked") {
    await workflowStep.on(ctx as never, { type: "step.blocked" } as never)
    return {
      status: "blocked",
      suggestedNextStepKey: null,
      opencode: activeSession,
    }
  }

  if (updated?.status === "waiting") {
    return {
      status: "waiting",
      suggestedNextStepKey: null,
      opencode: activeSession,
    }
  }

  return {
    status: "active",
    suggestedNextStepKey: null,
    opencode: activeSession,
  }
}

export async function completeStepInRuntime(
  input: CompleteStepInRuntimeInput,
  executor: DbExecutor = db(),
): Promise<CompleteStepInRuntimeResult> {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`)
  }
  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new Error(`Step not found: ${input.stepId}`)
  }
  const project = executor.select().from(projectTable).where(eq(projectTable.projectId, task.projectId)).get()
  if (!project) {
    throw new Error(`Project not found: ${task.projectId}`)
  }

  const loaded = await loadWorkflowForTask(input.taskId, executor)
  const workflowStep = loaded.workflow.steps.find((candidate) => candidate.id === step.stepKey)
  if (!workflowStep) {
    throw new Error(`Workflow step not found in ${loaded.workflow.id}: ${step.stepKey}`)
  }

  const snapshot = parseStepInputsSnapshot({
    taskId: input.taskId,
    stepId: input.stepId,
    value: step.inputs,
  })

  const hydratedInputs = await hydrateStepInputs({
    taskId: input.taskId,
    stepId: input.stepId,
    opsRoot: project.opsRootRealpath,
    workflowSteps: loaded.workflow.steps,
    snapshot,
  })

  const baseCtx = createStepContextBase({
    taskId: input.taskId,
    stepId: input.stepId,
    projectRoot: project.projectRootRealpath,
    opsRoot: project.opsRootRealpath,
    inputs: hydratedInputs,
    executor,
  })

  const resolvedOpenCodeTools = isOpenCodeStep(workflowStep)
    ? resolveCustomToolNameMap({ stepKey: step.stepKey, tools: workflowStep.opencode.tools })
    : undefined

  const _ctx = isOpenCodeStep(workflowStep)
    ? ({
        ...baseCtx,
        opencode: {
          tools: resolvedOpenCodeTools ?? {},
          start: async () => {
            return
          },
        },
      } satisfies StepContextWithOpenCode)
    : baseCtx

  const completion = await completeStepWithGuards(
    {
      taskId: input.taskId,
      stepId: input.stepId,
      completionPayload: input.completionPayload,
      sessionId: input.sessionId,
    },
    executor,
  )
  wakeWaitingParentIfReady({ taskId: input.taskId, stepId: input.stepId, executor })

  const completionSessionId = input.sessionId ?? step.sessionId ?? undefined
  if (isOpenCodeStep(workflowStep) && completionSessionId) {
    await completion.workflowStep.on(
      completion.ctx as never,
      {
        type: "opencode.complete",
        manual: input.manual ?? false,
        sessionId: completionSessionId,
        ...(input.messageId ? { messageId: input.messageId } : {}),
      } as never,
    )
  }

  await completion.workflowStep.on(completion.ctx as never, { type: "step.completed" } as never)

  return {
    status: "completed",
    suggestedNextStepKey: completion.suggestedNextStepKey,
  }
}
