import { createServer } from "node:net"
import { createOpencodeClient, createOpencodeServer, type Config } from "@opencode-ai/sdk/v2"
import { eq } from "drizzle-orm"
import { db, projectTable, stepTable, taskTable, type DbExecutor } from "../db"
import { staticSonataBridgePluginUrl } from "../opencode"
import { ErrorCode, RpcError } from "../rpc/base"
import { completeStep, failStep, parseStepInputsSnapshot, setStepSession, writeArtifactFromExecutionContext } from "../step"
import { completeTask } from "../task"
import { loadWorkflowForTask } from "../workflow"
import type {
  StepContextBase,
  StepContextWithOpenCode,
  StepRunResult,
  WorkflowStepWithOpenCode,
} from "../workflow/module"

export type ExecuteStepInput = {
  taskId: string
  stepId: string
}

export type ExecuteStepResult = {
  status: "completed" | "blocked" | "failed"
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

type ActiveOpenCodeSession = {
  baseUrl: string
  sessionId: string
  reused: boolean
  close?: () => void
}

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

  const inputs = parseStepInputsSnapshot({
    taskId: input.taskId,
    stepId: input.stepId,
    value: step.inputs,
  })

  const baseCtx: StepContextBase = {
    repoRoot: project.projectRootRealpath,
    taskId: input.taskId,
    stepId: input.stepId,
    inputs,
    writeMarkdownArtifact: async (params) => {
      const written = await writeArtifactFromExecutionContext({
        taskId: input.taskId,
        stepId: input.stepId,
        slug: params.slug,
        kind: "markdown",
        payload: { markdown: params.markdown },
      })
      return { kind: "markdown", path: written.relativePath }
    },
    writeJsonArtifact: async (params) => {
      const written = await writeArtifactFromExecutionContext({
        taskId: input.taskId,
        stepId: input.stepId,
        slug: params.slug,
        kind: "json",
        payload: { data: params.data },
      })
      return { kind: "json", path: written.relativePath }
    },
    completeStep: async (payload?: unknown) => {
      return completeStep({
        taskId: input.taskId,
        stepId: input.stepId,
        completionPayload: payload,
      })
    },
    completeTask: async (payload?: unknown) => {
      return completeTask({
        taskId: input.taskId,
        completionPayload: payload,
      })
    },
  }

  let activeSession: ActiveOpenCodeSession | undefined

  const ctx = isOpenCodeStep(workflowStep)
    ? ({
        ...baseCtx,
        opencode: {
          start: async (params?: { title?: string; kickoffPrompt?: string }) => {
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
                await workflowStep.on(ctxRef!, {
                  type: "opencode.started",
                  sessionId: current.sessionId,
                  reused: true,
                })
                return
              }
            }

            const pluginUrl = staticSonataBridgePluginUrl({
              taskId: input.taskId,
              stepId: input.stepId,
              projectRoot: project.projectRootRealpath,
              opsRoot: project.opsRootRealpath,
            })
            const opencodeConfig: Config = { plugin: [pluginUrl] }

            const port = await allocatePort()
            const server = await createOpencodeServer({
              hostname: "127.0.0.1",
              port,
              timeout: 15_000,
              config: opencodeConfig,
            })
            const client = createOpencodeClient({
              baseUrl: server.url,
              directory: project.projectRootRealpath,
            })
            const created = await client.session.create(
              { title: params?.title ?? `Sonata ${workflowStep.title}` },
              { throwOnError: true },
            )
            const sessionId = created.data.id

            await client.session.promptAsync(
              {
                sessionID: sessionId,
                parts: [{ type: "text", text: params?.kickoffPrompt ?? workflowStep.opencode.kickoffPrompt }],
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
            await workflowStep.on(ctxRef!, {
              type: "opencode.started",
              sessionId,
              reused: false,
            })
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
        await completeStep({
          taskId: input.taskId,
          stepId: input.stepId,
          completionPayload: runResult.completionPayload,
        })
        await workflowStep.on(ctx as never, { type: "step.completed" } as never)
        return {
          status: "completed",
          suggestedNextStepKey: workflowStep.next ?? null,
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
  } catch (error) {
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
      suggestedNextStepKey: workflowStep.next ?? null,
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

  await workflowStep.on(ctx as never, { type: "step.blocked" } as never)
  return {
    status: "blocked",
    suggestedNextStepKey: workflowStep.next ?? null,
    opencode: activeSession,
  }
}
