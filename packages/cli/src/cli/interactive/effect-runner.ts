import * as prompts from "@clack/prompts"
import { executeStep } from "@sonata/core/execution"
import { createCaller } from "@sonata/core/rpc"
import { loadWorkflowForTask, readOpsConfig } from "@sonata/core/workflow"
import { attachOpencodeTui } from "../opencode/attach"
import { UI } from "../ui"
import { collectStepInputs } from "./collect-step-inputs"
import type { Effect, InteractiveEvent, SharedCtx } from "./machine"

export type LinkedProject = {
  projectId: string
  projectRoot: string
  opsRoot: string
}

export type ActiveTask = ReturnType<ReturnType<typeof createCaller>["task"]["listActive"]>[number]

export type EffectRuntime = {
  caller: ReturnType<typeof createCaller>
  sharedCtx: SharedCtx | null
  listedTasks: Map<string, ActiveTask>
  lastStepResult: {
    status: "completed" | "blocked" | "failed"
    suggestedNextStepKey: string | null
    failure?: { reason: string; details?: unknown }
  } | null
}

export type EffectRunnerDeps = {
  prompts: Pick<typeof prompts, "select" | "isCancel" | "outro">
  ui: Pick<typeof UI, "println" | "error">
  ensureLinkedProject: (caller: ReturnType<typeof createCaller>) => Promise<LinkedProject>
  readOpsConfig: typeof readOpsConfig
  loadWorkflowForTask: typeof loadWorkflowForTask
  collectStepInputs: typeof collectStepInputs
  executeStep: typeof executeStep
  attachOpencodeTui: typeof attachOpencodeTui
}

// TODO: Split this by effect family (prompt/core/output) into separate adapters as the
// interactive feature set grows, so each adapter can be tested in tighter isolation.
export function createEffectRunner(deps: EffectRunnerDeps) {
  return async function runEffect(effect: Effect, runtime: EffectRuntime): Promise<InteractiveEvent[]> {
    const { caller } = runtime
    const backToTaskMenuValue = "__back_to_task_menu__"

    switch (effect.type) {
      case "ENSURE_LINKED_PROJECT": {
        try {
          const linked = await deps.ensureLinkedProject(caller)
          return [
            {
              type: "BOOTSTRAP_OK",
              projectId: linked.projectId,
              projectRoot: linked.projectRoot,
              opsRoot: linked.opsRoot,
            },
          ]
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to resolve linked project"
          return [{ type: "BOOTSTRAP_FAILED", message }]
        }
      }

      case "PROMPT_MAIN_MENU": {
        const action = await deps.prompts.select({
          message: "Main menu",
          options: [
            { label: "Start new task", value: "start" },
            { label: "Resume existing task", value: "resume" },
            { label: "Status", value: "status" },
            { label: "Exit", value: "exit" },
          ],
        })
        if (deps.prompts.isCancel(action)) {
          return [{ type: "USER_CANCEL" }]
        }
        if (action === "start") return [{ type: "MAIN_START_TASK" }]
        if (action === "resume") return [{ type: "MAIN_RESUME_TASK" }]
        if (action === "status") return [{ type: "MAIN_STATUS" }]
        return [{ type: "MAIN_EXIT" }]
      }

      case "START_TASK": {
        try {
          const started = await caller.task.start({
            projectId: effect.projectId,
            workflowRef: { name: effect.workflowName },
          })
          return [{ type: "TASK_START_OK", taskId: started.taskId }]
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to start task"
          return [{ type: "TASK_START_FAILED", message }]
        }
      }

      case "PROMPT_SELECT_WORKFLOW": {
        const { config } = await deps.readOpsConfig(effect.opsRoot)
        if (config.workflowModules.length === 1) {
          return [{ type: "WORKFLOW_SELECTED", workflowName: config.workflowModules[0]!.id }]
        }

        const workflowName = await deps.prompts.select({
          message: "Select workflow",
          options: config.workflowModules.map((workflow) => ({
            label:
              workflow.id === config.defaultWorkflowId ? `${workflow.id} (default)` : workflow.id,
            value: workflow.id,
          })),
          initialValue: config.defaultWorkflowId,
        })
        if (deps.prompts.isCancel(workflowName)) {
          return [{ type: "USER_BACK" }]
        }
        return [{ type: "WORKFLOW_SELECTED", workflowName }]
      }

      case "LIST_ACTIVE_TASKS": {
        const tasks = caller.task.listActive({ projectId: effect.projectId })
        runtime.listedTasks = new Map(tasks.map((task) => [task.taskId, task]))
        if (tasks.length === 0) {
          deps.ui.println("No active tasks")
          return [{ type: "USER_BACK" }]
        }
        return [{ type: "TASKS_LOADED", taskIds: tasks.map((task) => task.taskId) }]
      }

      case "PROMPT_SELECT_TASK": {
        const choice = await deps.prompts.select({
          message: "Select active task",
          options: effect.taskIds.map((taskId) => {
            const task = runtime.listedTasks.get(taskId)
            return {
              label: task ? `${task.taskId} (${task.workflowName})` : taskId,
              value: taskId,
            }
          }),
        })
        if (deps.prompts.isCancel(choice)) {
          return [{ type: "USER_BACK" }]
        }

        const selected = runtime.listedTasks.get(choice)
        return [{ type: "TASK_SELECTED", taskId: choice, currentStepId: selected?.currentStepId }]
      }

      case "PROMPT_SELECT_STEP": {
        const loaded = await deps.loadWorkflowForTask(effect.taskId)
        const steps = caller.step.list({ taskId: effect.taskId })
        const workflowStepIds = loaded.workflow.steps.map((step) => step.id)
        const activeStep = steps.find((step) => step.status === "active")
        const completedStepKeys = new Set(steps.filter((step) => step.status === "completed").map((step) => step.stepKey))
        const defaultStepKey =
          activeStep?.stepKey ?? workflowStepIds.find((stepId) => !completedStepKeys.has(stepId)) ?? workflowStepIds[0]
        const selectedStepKey = await deps.prompts.select({
          message: "Select step",
          options: [
            ...loaded.workflow.steps.map((step) => ({
              label: `${step.id}${step.id === defaultStepKey ? " (suggested)" : ""}`,
              value: step.id,
            })),
            { label: "Back to task menu", value: backToTaskMenuValue },
          ],
          initialValue: defaultStepKey,
        })
        if (deps.prompts.isCancel(selectedStepKey)) {
          return [{ type: "USER_BACK" }]
        }
        if (selectedStepKey === backToTaskMenuValue) {
          return [{ type: "USER_BACK" }]
        }
        return [{ type: "STEP_SELECTED", stepKey: selectedStepKey }]
      }

      case "PROMPT_COLLECT_INPUTS": {
        const loaded = await deps.loadWorkflowForTask(effect.taskId)
        const step = loaded.workflow.steps.find((candidate) => candidate.id === effect.stepKey)
        if (!step) {
          return [{ type: "INPUTS_CANCELLED" }]
        }

        try {
          const inputs = await deps.collectStepInputs(step, { taskId: effect.taskId, caller })
          if (typeof inputs.invocation === "undefined" && typeof inputs.artifactSelections === "undefined") {
            return [{ type: "INPUTS_SKIPPED" }]
          }
          return [{ type: "INPUTS_COLLECTED", inputs }]
        } catch (error) {
          if (error instanceof Error && error.message === "Cancelled") {
            return [{ type: "INPUTS_CANCELLED" }]
          }
          const message = error instanceof Error ? error.message : "Failed to collect step inputs"
          return [{ type: "STEP_START_FAILED", message }]
        }
      }

      case "START_STEP": {
        try {
          const started = await caller.step.start({
            taskId: effect.taskId,
            stepKey: effect.stepKey,
            invocation: effect.inputs?.invocation,
            artifactSelections: effect.inputs?.artifactSelections,
          })
          return [{ type: "STEP_START_OK", stepId: started.stepId }]
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to start step"
          return [{ type: "STEP_START_FAILED", message }]
        }
      }

      case "EXECUTE_STEP": {
        try {
          const result = await deps.executeStep({ taskId: effect.taskId, stepId: effect.stepId })
          runtime.lastStepResult = {
            status: result.status,
            suggestedNextStepKey: result.suggestedNextStepKey,
            ...(result.failure ? { failure: result.failure } : {}),
          }
          return [
            {
              type: "STEP_EXECUTE_OK",
              result: {
                status: result.status,
                suggestedNextStepKey: result.suggestedNextStepKey,
                ...(result.failure ? { failure: result.failure } : {}),
                opencodeSession: result.opencode
                  ? {
                      baseUrl: result.opencode.baseUrl,
                      sessionId: result.opencode.sessionId,
                      reused: result.opencode.reused,
                    }
                  : undefined,
              },
            },
          ]
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to execute step"
          return [{ type: "STEP_EXECUTE_FAILED", message }]
        }
      }

      case "ATTACH_OPENCODE": {
        await deps.attachOpencodeTui({
          projectRoot: effect.projectRoot,
          baseUrl: effect.baseUrl,
          sessionId: effect.sessionId,
          env: {},
        })
        return []
      }

      case "PRINT_STEP_RESULT": {
        if (runtime.lastStepResult) {
          if (
            runtime.lastStepResult.status === "blocked" &&
            runtime.sharedCtx?.activeTaskId &&
            runtime.sharedCtx.activeStepId
          ) {
            const steps = caller.step.list({ taskId: runtime.sharedCtx.activeTaskId })
            const current = steps.find((step) => step.stepId === runtime.sharedCtx?.activeStepId)
            if (current?.status === "completed") {
              runtime.lastStepResult = {
                ...runtime.lastStepResult,
                status: "completed",
              }
            } else if (current?.status === "failed") {
              runtime.lastStepResult = {
                status: "failed",
                suggestedNextStepKey: null,
                ...(runtime.lastStepResult.failure ? { failure: runtime.lastStepResult.failure } : {}),
              }
            }
          }

          deps.ui.println("step_status:", runtime.lastStepResult.status)
          deps.ui.println("suggested_next_step:", runtime.lastStepResult.suggestedNextStepKey ?? "none")
          if (runtime.lastStepResult.failure) {
            deps.ui.println("failure_reason:", runtime.lastStepResult.failure.reason)
            if (typeof runtime.lastStepResult.failure.details !== "undefined") {
              deps.ui.println("failure_details:", JSON.stringify(runtime.lastStepResult.failure.details))
            }
          }
        }
        return []
      }

      case "PROMPT_STEP_ACTIONS": {
        const action = await deps.prompts.select({
          message: "Step actions",
          options: [
            { label: "Retry step", value: "retry" },
            { label: "Mark failed", value: "fail" },
            { label: "Cancel step", value: "cancel" },
            { label: "Back to task menu", value: "back" },
            { label: "Status", value: "status" },
          ],
        })
        if (deps.prompts.isCancel(action) || action === "back") {
          return [{ type: "USER_BACK" }]
        }
        if (action === "retry") return [{ type: "STEP_ACTION_RETRY" }]
        if (action === "fail") return [{ type: "STEP_ACTION_FAIL" }]
        if (action === "cancel") return [{ type: "STEP_ACTION_CANCEL" }]
        return [{ type: "STEP_ACTION_STATUS" }]
      }

      case "FAIL_STEP": {
        try {
          caller.step.fail({ taskId: effect.taskId, stepId: effect.stepId })
          return [{ type: "STEP_FAIL_OK" }]
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to mark step failed"
          return [{ type: "STEP_ACTION_FAILED", message }]
        }
      }

      case "CANCEL_STEP": {
        try {
          caller.step.cancel({ taskId: effect.taskId, stepId: effect.stepId })
          return [{ type: "STEP_CANCEL_OK" }]
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to cancel step"
          return [{ type: "STEP_ACTION_FAILED", message }]
        }
      }

      case "CHECK_STEP_ACTIVE": {
        const steps = caller.step.list({ taskId: effect.taskId })
        const current = steps.find((step) => step.stepId === effect.stepId)
        return [{ type: "STEP_STILL_ACTIVE", active: current?.status === "active" }]
      }

      case "CHECK_TASK_ACTIVE": {
        const active = caller.task.listActive({ projectId: effect.projectId })
        return [{ type: "TASK_STILL_ACTIVE", active: active.some((task) => task.taskId === effect.taskId) }]
      }

      case "PROMPT_TASK_CONTINUATION": {
        let nextLabel = "Start another step"
        let nextStepKeyToStart: string | undefined
        const suggestedStepKey = runtime.lastStepResult?.suggestedNextStepKey
        if (suggestedStepKey) {
          const loaded = await deps.loadWorkflowForTask(effect.taskId)
          const workflowStepIds = new Set(loaded.workflow.steps.map((step) => step.id))
          if (workflowStepIds.has(suggestedStepKey)) {
            const steps = caller.step.list({ taskId: effect.taskId })
            const hasCompletedSuggested = steps.some(
              (step) => step.stepKey === suggestedStepKey && step.status === "completed",
            )
            if (!hasCompletedSuggested) {
              nextLabel = `Start next step (${suggestedStepKey})`
              nextStepKeyToStart = suggestedStepKey
            }
          }
        }

        const action = await deps.prompts.select({
          message: "Task is still active",
          options: [
            { label: nextLabel, value: "next" },
            { label: "Mark task complete", value: "complete" },
            { label: "Delete task", value: "delete" },
            { label: "Status", value: "status" },
            { label: "Back to main menu", value: "back" },
          ],
          initialValue: "next",
        })
        if (deps.prompts.isCancel(action) || action === "back") {
          return [{ type: "USER_BACK" }]
        }
        if (action === "complete") {
          return [{ type: "TASK_CONTINUE_COMPLETE" }]
        }
        if (action === "delete") {
          return [{ type: "TASK_CONTINUE_DELETE" }]
        }
        if (action === "status") {
          return [{ type: "TASK_CONTINUE_STATUS" }]
        }
        return [{ type: "TASK_CONTINUE_START_NEXT_STEP", ...(nextStepKeyToStart ? { stepKey: nextStepKeyToStart } : {}) }]
      }

      case "COMPLETE_TASK": {
        try {
          caller.task.complete({ taskId: effect.taskId })
          return [{ type: "TASK_COMPLETE_OK" }]
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to complete task"
          return [{ type: "TASK_ACTION_FAILED", message }]
        }
      }

      case "DELETE_TASK": {
        try {
          caller.task.delete({ taskId: effect.taskId })
          return [{ type: "TASK_DELETE_OK" }]
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to delete task"
          return [{ type: "TASK_ACTION_FAILED", message }]
        }
      }

    case "PRINT_STATUS": {
      if (runtime.sharedCtx) {
        deps.ui.println("project_id:", runtime.sharedCtx.projectId)
        deps.ui.println("task_id:", runtime.sharedCtx.activeTaskId ?? "none")
        deps.ui.println("step_id:", runtime.sharedCtx.activeStepId ?? "none")
        deps.ui.println("opencode_session:", runtime.sharedCtx.lastOpencodeSession?.sessionId ?? "none")

        if (runtime.sharedCtx.activeTaskId) {
          const steps = caller.step.list({ taskId: runtime.sharedCtx.activeTaskId })
          if (steps.length === 0) {
            deps.ui.println("steps:", "none")
          } else {
            deps.ui.println("steps:")
            for (const step of steps) {
              deps.ui.println(`  [${step.stepIndex}]`, `${step.stepKey}`, `status=${step.status}`)
            }
          }
        }
      }
      return []
    }

      case "PRINT_ERROR": {
        deps.ui.error(effect.message)
        return []
      }

      case "OUTRO": {
        deps.prompts.outro("Done")
        return []
      }
    }
  }
}
