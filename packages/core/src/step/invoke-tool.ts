import { eq } from "drizzle-orm"
import z from "zod"
import { db, projectTable, stepTable, taskTable, type DbExecutor } from "../db"
import { ErrorCode, RpcError } from "../rpc/base"
import { loadWorkflowStepForTask } from "../workflow/loader"

export type InvokeStepToolInput = {
  taskId: string
  stepId: string
  toolId: string
  args: unknown
  sessionId?: string
}

function toJsonSafeResult(value: unknown): unknown {
  if (typeof value === "string") {
    return value
  }

  try {
    const normalized = JSON.parse(JSON.stringify(value))
    if (typeof normalized === "undefined") {
      throw new Error("Custom OpenCode tool returned undefined")
    }
    return normalized
  } catch (error) {
    const message = error instanceof Error ? error.message : "Custom OpenCode tool returned a non-serializable value"
    throw new RpcError(ErrorCode.INVALID_INPUT, 400, message)
  }
}

export async function invokeStepTool(input: InvokeStepToolInput, executor: DbExecutor = db()) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
  }

  if (step.status !== "active") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Step ${input.stepId} is not active and cannot invoke custom OpenCode tools`,
    )
  }

  const project = executor.select().from(projectTable).where(eq(projectTable.projectId, task.projectId)).get()
  if (!project) {
    throw new RpcError(ErrorCode.PROJECT_NOT_FOUND, 404, `Project not found: ${task.projectId}`)
  }

  const { step: workflowStep } = await loadWorkflowStepForTask({
    taskId: input.taskId,
    stepKey: step.stepKey,
    tx: executor,
  })

  const tool = workflowStep.opencode?.tools?.[input.toolId]
  if (!tool) {
    throw new RpcError(
      ErrorCode.INVALID_INPUT,
      400,
      `Custom OpenCode tool is not declared for step ${step.stepKey}: ${input.toolId}`,
    )
  }

  let parsedArgs: Record<string, unknown>
  try {
    parsedArgs = z.object(tool.argsSchema).strict().parse(input.args)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid custom OpenCode tool arguments"
    throw new RpcError(ErrorCode.INVALID_INPUT, 400, message)
  }

  const output = await tool.execute(
    {
      repoRoot: project.projectRootRealpath,
      opsRoot: project.opsRootRealpath,
      taskId: input.taskId,
      stepId: input.stepId,
      sessionId: input.sessionId,
    },
    parsedArgs,
  )

  return {
    taskId: input.taskId,
    stepId: input.stepId,
    toolId: input.toolId,
    result: toJsonSafeResult(output),
  }
}
