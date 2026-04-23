import * as prompts from "@clack/prompts"
import { executeStep } from "@sonata/core/execution"
import { createCaller } from "@sonata/core/rpc"
import { loadWorkflowForTask, readOpsConfig } from "@sonata/core/workflow"
import { attachOpencodeTui } from "../opencode/attach"
import { UI } from "../ui"
import { collectStepInputs } from "./collect-step-inputs"
import type { Effect, InteractiveEvent, OpenRootStepStatus, SharedCtx } from "./machine"

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
    status: "active" | "waiting" | "completed" | "blocked" | "failed"
    suggestedNextStepKey: string | null
    failure?: { reason: string; details?: unknown }
  } | null
  lastStepDetail: ReturnType<ReturnType<typeof createCaller>["step"]["get"]> | null
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

function isOpenRootStepStatus(
  status: ActiveTask["currentRootStepStatus"] | undefined,
): status is OpenRootStepStatus {
  return status === "active" || status === "waiting" || status === "blocked" || status === "orphaned"
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
            const rootSummary =
              task?.currentRootStepId && task.currentRootStepKey && task.currentRootStepStatus
                ? `, root=${task.currentRootStepKey} ${task.currentRootStepStatus}`
                : ""
            return {
              label: task ? `${task.taskId} (${task.workflowName}${rootSummary})` : taskId,
              value: taskId,
            }
          }),
        })
        if (deps.prompts.isCancel(choice)) {
          return [{ type: "USER_BACK" }]
        }

        const selected = runtime.listedTasks.get(choice)
        return [
          {
            type: "TASK_SELECTED",
            taskId: choice,
            currentRootStepId: selected?.currentRootStepId ?? undefined,
            currentRootStepStatus: isOpenRootStepStatus(selected?.currentRootStepStatus)
              ? selected.currentRootStepStatus
              : undefined,
          },
        ]
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
          runtime.lastStepDetail = null
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

      case "GET_STEP": {
        try {
          const detail = caller.step.get({ taskId: effect.taskId, stepId: effect.stepId })
          runtime.lastStepDetail = detail
          return [{ type: "STEP_STATUS_LOADED", status: detail.status }]
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to load step details"
          return [{ type: "STEP_ACTION_FAILED", message }]
        }
      }

      case "PRINT_STEP_DETAILS": {
        const detail = runtime.lastStepDetail
        if (!detail) {
          return []
        }

        deps.ui.println("step_detail_status:", detail.status)
        deps.ui.println("step_detail_key:", detail.stepKey)
        deps.ui.println("step_detail_session:", detail.sessionId ?? "none")
        deps.ui.println("step_detail_base_url:", detail.opencodeBaseUrl ?? "none")
        if (detail.waitSpec) {
          deps.ui.println("wait_spec:", JSON.stringify(detail.waitSpec))
        }
        if (detail.waitSnapshot) {
          deps.ui.println("wait_snapshot:", JSON.stringify(detail.waitSnapshot))
        }
        if (detail.blockPayload) {
          deps.ui.println("block_payload:", JSON.stringify(detail.blockPayload))
        }
        if (detail.orphanedReason) {
          deps.ui.println("orphaned_reason:", JSON.stringify(detail.orphanedReason))
        }
        return []
      }

      case "PRINT_CHILD_STEPS": {
        if (!runtime.sharedCtx?.activeTaskId || !runtime.lastStepDetail) {
          return []
        }

        const detail = runtime.lastStepDetail
        const waitSpec = detail.waitSpec as { kind?: string; childStepKey?: string; workKeys?: string[] } | null | undefined
        const children = caller
          .step
          .list({ taskId: runtime.sharedCtx.activeTaskId })
          .filter((step) => step.parentStepId === detail.stepId)
          .filter((step) => (waitSpec?.kind === "children" && waitSpec.childStepKey ? step.stepKey === waitSpec.childStepKey : true))
          .filter((step) => (waitSpec?.kind === "children" && waitSpec.workKeys ? waitSpec.workKeys.includes(step.workKey ?? "") : true))

        if (children.length === 0) {
          deps.ui.println("child_steps:", "none")
          return []
        }

        deps.ui.println("child_steps:")
        for (const child of children) {
          deps.ui.println(`  [${child.stepIndex}]`, `${child.stepKey}`, `work=${child.workKey ?? "none"}`, `status=${child.status}`)
        }
        return []
      }

      case "PROMPT_STEP_ACTIONS": {
        const attachAvailable =
          effect.rootStepStatus === "blocked" &&
          runtime.lastStepDetail?.sessionId !== null &&
          typeof runtime.lastStepDetail?.sessionId === "string" &&
          runtime.lastStepDetail?.opencodeBaseUrl !== null &&
          typeof runtime.lastStepDetail?.opencodeBaseUrl === "string"

        const options =
          effect.rootStepStatus === "active"
            ? [
                { label: "Retry step", value: "retry" },
                { label: "Mark failed", value: "fail" },
                { label: "Cancel step", value: "cancel" },
                { label: "Back to task menu", value: "back" },
                { label: "Status", value: "status" },
              ]
            : effect.rootStepStatus === "waiting"
              ? [
                  { label: "Refresh waiting status", value: "refresh" },
                  { label: "Inspect child steps", value: "inspect_children" },
                  { label: "Back to main menu", value: "back" },
                ]
              : effect.rootStepStatus === "blocked"
                ? [
                    ...(attachAvailable ? ([{ label: "Attach to existing session", value: "attach" }] as const) : []),
                    { label: "Resume blocked step", value: "resume" },
                    { label: "Mark failed", value: "fail" },
                    { label: "Cancel step", value: "cancel" },
                    { label: "Back to main menu", value: "back" },
                    { label: "Status", value: "status" },
                  ]
                : [
                    { label: "Retry in new session", value: "retry_new_session" },
                    { label: "Mark failed", value: "fail" },
                    { label: "Cancel step", value: "cancel" },
                    { label: "Back to main menu", value: "back" },
                    { label: "Status", value: "status" },
                  ]

        const action = await deps.prompts.select({
          message: "Step actions",
          options,
        })
        if (deps.prompts.isCancel(action) || action === "back") {
          return [{ type: "USER_BACK" }]
        }
        if (action === "attach") {
          return [
            {
              type: "STEP_ACTION_ATTACH",
              baseUrl: runtime.lastStepDetail!.opencodeBaseUrl!,
              sessionId: runtime.lastStepDetail!.sessionId!,
            },
          ]
        }
        if (action === "inspect_children") return [{ type: "STEP_ACTION_INSPECT_CHILDREN" }]
        if (action === "refresh") return [{ type: "STEP_ACTION_REFRESH" }]
        if (action === "retry") return [{ type: "STEP_ACTION_RETRY" }]
        if (action === "resume") return [{ type: "STEP_ACTION_RESUME" }]
        if (action === "retry_new_session") return [{ type: "STEP_ACTION_RETRY_IN_NEW_SESSION" }]
        if (action === "fail") return [{ type: "STEP_ACTION_FAIL" }]
        if (action === "cancel") return [{ type: "STEP_ACTION_CANCEL" }]
        return [{ type: "STEP_ACTION_STATUS" }]
      }

      case "RESUME_BLOCKED_STEP": {
        try {
          const resumed = await caller.step.resumeBlocked({ taskId: effect.taskId, stepId: effect.stepId })
          runtime.lastStepDetail = null
          return [{ type: "STEP_RESUME_OK", status: resumed.status }]
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to resume blocked step"
          return [{ type: "STEP_ACTION_FAILED", message }]
        }
      }

      case "RETRY_ORPHANED_STEP": {
        try {
          caller.step.retryOrphanedInNewSession({ taskId: effect.taskId, stepId: effect.stepId })
          runtime.lastStepDetail = null
          return [{ type: "STEP_RETRY_OK" }]
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to retry orphaned step"
          return [{ type: "STEP_ACTION_FAILED", message }]
        }
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

      case "CHECK_TASK_ACTIVE": {
        const active = caller.task.listActive({ projectId: effect.projectId })
        const task = active.find((item) => item.taskId === effect.taskId)
        return [
          {
            type: "TASK_STILL_ACTIVE",
            active: Boolean(task),
            currentRootStepId: task?.currentRootStepId ?? undefined,
            currentRootStepStatus: isOpenRootStepStatus(task?.currentRootStepStatus) ? task.currentRootStepStatus : undefined,
          },
        ]
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
