export type SharedCtx = {
  projectId: string
  projectRoot: string
  opsRoot: string
  activeTaskId: string | null
  activeStepId: string | null
  lastOpencodeSession: { baseUrl: string; sessionId: string } | null
  lastError: string | null
}

export type InvocationInputs = {
  invocation?: unknown
  artifactSelections?: Record<string, { mode: "latest" | "all" | "indices"; indices?: number[] }>
}

export type InteractiveState =
  | { status: "bootstrapping" }
  | { status: "main_menu"; shared: SharedCtx }
  | { status: "selecting_workflow"; shared: SharedCtx }
  | { status: "selecting_task"; shared: SharedCtx; taskIds: string[] }
  | { status: "selecting_step"; shared: SharedCtx; taskId: string }
  | { status: "collecting_inputs"; shared: SharedCtx; taskId: string; stepKey: string }
  | { status: "starting_step"; shared: SharedCtx; taskId: string; stepKey: string; inputs?: InvocationInputs }
  | { status: "executing_step"; shared: SharedCtx; taskId: string; stepId: string }
  | { status: "step_actions"; shared: SharedCtx; taskId: string; stepId: string }
  | { status: "task_continuation"; shared: SharedCtx; taskId: string }
  | { status: "exiting"; shared?: SharedCtx }
  | { status: "fatal_error"; message: string; shared?: SharedCtx }

export type InteractiveEvent =
  | { type: "BOOT" }
  | { type: "BOOTSTRAP_OK"; projectId: string; projectRoot: string; opsRoot: string }
  | { type: "BOOTSTRAP_FAILED"; message: string }
  | { type: "MAIN_START_TASK" }
  | { type: "MAIN_RESUME_TASK" }
  | { type: "MAIN_STATUS" }
  | { type: "MAIN_EXIT" }
  | { type: "USER_BACK" }
  | { type: "USER_CANCEL" }
  | { type: "WORKFLOW_SELECTED"; workflowName: string }
  | { type: "TASKS_LOADED"; taskIds: string[] }
  | { type: "TASK_SELECTED"; taskId: string; currentStepId?: string }
  | { type: "TASK_START_OK"; taskId: string }
  | { type: "TASK_START_FAILED"; message: string }
  | { type: "STEP_SELECTED"; stepKey: string }
  | { type: "INPUTS_COLLECTED"; inputs: InvocationInputs }
  | { type: "INPUTS_SKIPPED" }
  | { type: "INPUTS_CANCELLED" }
  | { type: "STEP_START_OK"; stepId: string }
  | { type: "STEP_START_FAILED"; message: string }
  | {
    type: "STEP_EXECUTE_OK"
      result: {
        status: "completed" | "blocked" | "failed"
        suggestedNextStepKey: string | null
        failure?: { reason: string; details?: unknown }
        opencodeSession?: { baseUrl: string; sessionId: string; reused: boolean }
      }
  }
  | { type: "STEP_EXECUTE_FAILED"; message: string }
  | { type: "STEP_ACTION_RETRY" }
  | { type: "STEP_ACTION_FAIL" }
  | { type: "STEP_ACTION_CANCEL" }
  | { type: "STEP_ACTION_STATUS" }
  | { type: "STEP_STILL_ACTIVE"; active: boolean }
  | { type: "STEP_FAIL_OK" }
  | { type: "STEP_CANCEL_OK" }
  | { type: "STEP_ACTION_FAILED"; message: string }
  | { type: "TASK_CONTINUE_START_NEXT_STEP"; stepKey?: string }
  | { type: "TASK_CONTINUE_COMPLETE" }
  | { type: "TASK_CONTINUE_DELETE" }
  | { type: "TASK_CONTINUE_STATUS" }
  | { type: "TASK_COMPLETE_OK" }
  | { type: "TASK_DELETE_OK" }
  | { type: "TASK_ACTION_FAILED"; message: string }
  | { type: "TASK_STILL_ACTIVE"; active: boolean }
  | { type: "ERROR_ACK" }

export type Effect =
  | { type: "ENSURE_LINKED_PROJECT" }
  | { type: "PROMPT_MAIN_MENU" }
  | { type: "PROMPT_SELECT_WORKFLOW"; opsRoot: string }
  | { type: "PRINT_STATUS" }
  | { type: "OUTRO" }
  | { type: "START_TASK"; projectId: string; workflowName: string }
  | { type: "LIST_ACTIVE_TASKS"; projectId: string }
  | { type: "PROMPT_SELECT_TASK"; taskIds: string[] }
  | { type: "PROMPT_SELECT_STEP"; taskId: string }
  | { type: "PROMPT_COLLECT_INPUTS"; taskId: string; stepKey: string }
  | { type: "START_STEP"; taskId: string; stepKey: string; inputs?: InvocationInputs }
  | { type: "EXECUTE_STEP"; taskId: string; stepId: string }
  | { type: "ATTACH_OPENCODE"; projectRoot: string; baseUrl: string; sessionId: string }
  | { type: "PRINT_STEP_RESULT" }
  | { type: "PROMPT_STEP_ACTIONS" }
  | { type: "FAIL_STEP"; taskId: string; stepId: string }
  | { type: "CANCEL_STEP"; taskId: string; stepId: string }
  | { type: "CHECK_STEP_ACTIVE"; taskId: string; stepId: string }
  | { type: "CHECK_TASK_ACTIVE"; projectId: string; taskId: string }
  | { type: "PROMPT_TASK_CONTINUATION"; taskId: string }
  | { type: "COMPLETE_TASK"; taskId: string }
  | { type: "DELETE_TASK"; taskId: string }
  | { type: "PRINT_ERROR"; message: string }

export type TransitionResult = {
  state: InteractiveState
  effects: Effect[]
}

export function initialInteractiveMachineState(): InteractiveState {
  return { status: "bootstrapping" }
}

function withError(shared: SharedCtx, message: string): SharedCtx {
  return {
    ...shared,
    lastError: message,
  }
}

function stepSelectionTarget(shared: SharedCtx, taskId: string): TransitionResult {
  return {
    state: { status: "selecting_step", shared, taskId },
    effects: [{ type: "PROMPT_SELECT_STEP", taskId }],
  }
}

export function transition(state: InteractiveState, event: InteractiveEvent): TransitionResult {
  switch (state.status) {
    case "bootstrapping": {
      switch (event.type) {
        case "BOOT":
          return { state, effects: [{ type: "ENSURE_LINKED_PROJECT" }] }
        case "BOOTSTRAP_OK": {
          const shared: SharedCtx = {
            projectId: event.projectId,
            projectRoot: event.projectRoot,
            opsRoot: event.opsRoot,
            activeTaskId: null,
            activeStepId: null,
            lastOpencodeSession: null,
            lastError: null,
          }
          return { state: { status: "main_menu", shared }, effects: [{ type: "PROMPT_MAIN_MENU" }] }
        }
        case "BOOTSTRAP_FAILED":
          return {
            state: { status: "fatal_error", message: event.message },
            effects: [{ type: "PRINT_ERROR", message: event.message }],
          }
        default:
          return { state, effects: [] }
      }
    }

    case "main_menu": {
      switch (event.type) {
        case "MAIN_START_TASK":
          return {
            state: { status: "selecting_workflow", shared: state.shared },
            effects: [{ type: "PROMPT_SELECT_WORKFLOW", opsRoot: state.shared.opsRoot }],
          }
        case "TASK_START_OK":
          return stepSelectionTarget(
            {
              ...state.shared,
              activeTaskId: event.taskId,
              activeStepId: null,
              lastError: null,
            },
            event.taskId,
          )
        case "TASK_START_FAILED":
          return {
            state: { status: "main_menu", shared: withError(state.shared, event.message) },
            effects: [{ type: "PRINT_ERROR", message: event.message }, { type: "PROMPT_MAIN_MENU" }],
          }
        case "MAIN_RESUME_TASK":
          return {
            state,
            effects: [{ type: "LIST_ACTIVE_TASKS", projectId: state.shared.projectId }],
          }
        case "TASKS_LOADED":
          return {
            state: { status: "selecting_task", shared: state.shared, taskIds: event.taskIds },
            effects: event.taskIds.length > 0 ? [{ type: "PROMPT_SELECT_TASK", taskIds: event.taskIds }] : [],
          }
        case "MAIN_STATUS":
          return { state, effects: [{ type: "PRINT_STATUS" }, { type: "PROMPT_MAIN_MENU" }] }
        case "USER_BACK":
          return { state, effects: [{ type: "PROMPT_MAIN_MENU" }] }
        case "MAIN_EXIT":
        case "USER_CANCEL":
          return { state: { status: "exiting", shared: state.shared }, effects: [{ type: "OUTRO" }] }
        default:
          return { state, effects: [] }
      }
    }

    case "selecting_workflow": {
      switch (event.type) {
        case "WORKFLOW_SELECTED":
          return {
            state: { status: "main_menu", shared: state.shared },
            effects: [{ type: "START_TASK", projectId: state.shared.projectId, workflowName: event.workflowName }],
          }
        case "USER_BACK":
        case "USER_CANCEL":
          return { state: { status: "main_menu", shared: state.shared }, effects: [{ type: "PROMPT_MAIN_MENU" }] }
        default:
          return { state, effects: [] }
      }
    }

    case "selecting_task": {
      switch (event.type) {
        case "TASK_SELECTED":
          if (event.currentStepId) {
            const shared = {
              ...state.shared,
              activeTaskId: event.taskId,
              activeStepId: event.currentStepId,
            }
            return {
              state: {
                status: "executing_step",
                shared,
                taskId: event.taskId,
                stepId: event.currentStepId,
              },
              effects: [{ type: "EXECUTE_STEP", taskId: event.taskId, stepId: event.currentStepId }],
            }
          }
          return stepSelectionTarget(
            {
              ...state.shared,
              activeTaskId: event.taskId,
              activeStepId: null,
            },
            event.taskId,
          )
        case "USER_BACK":
        case "USER_CANCEL":
          return { state: { status: "main_menu", shared: state.shared }, effects: [{ type: "PROMPT_MAIN_MENU" }] }
        default:
          return { state, effects: [] }
      }
    }

    case "selecting_step": {
      switch (event.type) {
        case "STEP_SELECTED":
          return {
            state: { status: "collecting_inputs", shared: state.shared, taskId: state.taskId, stepKey: event.stepKey },
            effects: [{ type: "PROMPT_COLLECT_INPUTS", taskId: state.taskId, stepKey: event.stepKey }],
          }
        case "USER_BACK":
        case "USER_CANCEL":
          return {
            state: {
              status: "task_continuation",
              shared: state.shared,
              taskId: state.taskId,
            },
            effects: [{ type: "CHECK_TASK_ACTIVE", projectId: state.shared.projectId, taskId: state.taskId }],
          }
        default:
          return { state, effects: [] }
      }
    }

    case "collecting_inputs": {
      switch (event.type) {
        case "INPUTS_COLLECTED":
          return {
            state: {
              status: "starting_step",
              shared: state.shared,
              taskId: state.taskId,
              stepKey: state.stepKey,
              inputs: event.inputs,
            },
            effects: [{ type: "START_STEP", taskId: state.taskId, stepKey: state.stepKey, inputs: event.inputs }],
          }
        case "INPUTS_SKIPPED":
          return {
            state: {
              status: "starting_step",
              shared: state.shared,
              taskId: state.taskId,
              stepKey: state.stepKey,
            },
            effects: [{ type: "START_STEP", taskId: state.taskId, stepKey: state.stepKey }],
          }
        case "INPUTS_CANCELLED":
        case "USER_CANCEL":
          return {
            state: {
              status: "task_continuation",
              shared: state.shared,
              taskId: state.taskId,
            },
            effects: [{ type: "CHECK_TASK_ACTIVE", projectId: state.shared.projectId, taskId: state.taskId }],
          }
        default:
          return { state, effects: [] }
      }
    }

    case "starting_step": {
      switch (event.type) {
        case "STEP_START_OK": {
          const shared = {
            ...state.shared,
            activeTaskId: state.taskId,
            activeStepId: event.stepId,
            lastError: null,
          }
          return {
            state: { status: "executing_step", shared, taskId: state.taskId, stepId: event.stepId },
            effects: [{ type: "EXECUTE_STEP", taskId: state.taskId, stepId: event.stepId }],
          }
        }
        case "STEP_START_FAILED":
          return {
            state: {
              status: "task_continuation",
              shared: withError(state.shared, event.message),
              taskId: state.taskId,
            },
            effects: [
              { type: "PRINT_ERROR", message: event.message },
              { type: "CHECK_TASK_ACTIVE", projectId: state.shared.projectId, taskId: state.taskId },
            ],
          }
        default:
          return { state, effects: [] }
      }
    }

    case "executing_step": {
      switch (event.type) {
        case "STEP_EXECUTE_OK": {
          const shared: SharedCtx = {
            ...state.shared,
            activeStepId: event.result.status === "blocked" ? state.stepId : null,
            lastOpencodeSession: event.result.opencodeSession
              ? {
                  baseUrl: event.result.opencodeSession.baseUrl,
                  sessionId: event.result.opencodeSession.sessionId,
                }
              : state.shared.lastOpencodeSession,
            lastError: null,
          }

          const attachEffect = event.result.opencodeSession
            ? ([
                {
                  type: "ATTACH_OPENCODE",
                  projectRoot: state.shared.projectRoot,
                  baseUrl: event.result.opencodeSession.baseUrl,
                  sessionId: event.result.opencodeSession.sessionId,
                },
              ] as Effect[])
            : []

          if (event.result.status === "completed") {
            return {
              state: {
                status: "task_continuation",
                shared,
                taskId: state.taskId,
              },
              effects: [
                ...attachEffect,
                { type: "PRINT_STEP_RESULT" },
                { type: "CHECK_TASK_ACTIVE", projectId: shared.projectId, taskId: state.taskId },
              ],
            }
          }

          if (event.result.status === "failed") {
            return {
              state: {
                status: "task_continuation",
                shared,
                taskId: state.taskId,
              },
              effects: [
                ...attachEffect,
                { type: "PRINT_STEP_RESULT" },
                { type: "CHECK_TASK_ACTIVE", projectId: shared.projectId, taskId: state.taskId },
              ],
            }
          }

          return {
            state: {
              status: "step_actions",
              shared,
              taskId: state.taskId,
              stepId: state.stepId,
            },
            effects: [...attachEffect, { type: "PRINT_STEP_RESULT" }, { type: "CHECK_STEP_ACTIVE", taskId: state.taskId, stepId: state.stepId }],
          }
        }
        case "STEP_EXECUTE_FAILED":
          return {
            state: {
              status: "step_actions",
              shared: withError(state.shared, event.message),
              taskId: state.taskId,
              stepId: state.stepId,
            },
            effects: [{ type: "PRINT_ERROR", message: event.message }, { type: "PROMPT_STEP_ACTIONS" }],
          }
        default:
          return { state, effects: [] }
      }
    }

    case "step_actions": {
      switch (event.type) {
        case "STEP_STILL_ACTIVE":
          if (event.active) {
            return { state, effects: [{ type: "PROMPT_STEP_ACTIONS" }] }
          }
          return {
            state: {
              status: "task_continuation",
              shared: {
                ...state.shared,
                activeStepId: null,
              },
              taskId: state.taskId,
            },
            effects: [{ type: "CHECK_TASK_ACTIVE", projectId: state.shared.projectId, taskId: state.taskId }],
          }
        case "STEP_ACTION_RETRY":
          return {
            state: { status: "executing_step", shared: state.shared, taskId: state.taskId, stepId: state.stepId },
            effects: [{ type: "EXECUTE_STEP", taskId: state.taskId, stepId: state.stepId }],
          }
        case "STEP_ACTION_FAIL":
          return {
            state,
            effects: [{ type: "FAIL_STEP", taskId: state.taskId, stepId: state.stepId }],
          }
        case "STEP_ACTION_CANCEL":
          return {
            state,
            effects: [{ type: "CANCEL_STEP", taskId: state.taskId, stepId: state.stepId }],
          }
        case "STEP_FAIL_OK":
        case "STEP_CANCEL_OK": {
          const shared = {
            ...state.shared,
            activeStepId: null,
          }
          return {
            state: { status: "task_continuation", shared, taskId: state.taskId },
            effects: [{ type: "CHECK_TASK_ACTIVE", projectId: shared.projectId, taskId: state.taskId }],
          }
        }
        case "STEP_ACTION_STATUS":
          return {
            state,
            effects: [
              { type: "PRINT_STATUS" },
              { type: "CHECK_STEP_ACTIVE", taskId: state.taskId, stepId: state.stepId },
            ],
          }
        case "USER_BACK":
        case "USER_CANCEL":
          return {
            state: {
              status: "task_continuation",
              shared: state.shared,
              taskId: state.taskId,
            },
            effects: [{ type: "CHECK_TASK_ACTIVE", projectId: state.shared.projectId, taskId: state.taskId }],
          }
        case "STEP_ACTION_FAILED":
          return {
            state: { ...state, shared: withError(state.shared, event.message) },
            effects: [{ type: "PRINT_ERROR", message: event.message }, { type: "PROMPT_STEP_ACTIONS" }],
          }
        default:
          return { state, effects: [] }
      }
    }

    case "task_continuation": {
      switch (event.type) {
        case "TASK_STILL_ACTIVE":
          if (!event.active) {
            return { state: { status: "main_menu", shared: state.shared }, effects: [{ type: "PROMPT_MAIN_MENU" }] }
          }
          return { state, effects: [{ type: "PROMPT_TASK_CONTINUATION", taskId: state.taskId }] }
        case "TASK_CONTINUE_START_NEXT_STEP":
          if (event.stepKey) {
            return {
              state: {
                status: "collecting_inputs",
                shared: state.shared,
                taskId: state.taskId,
                stepKey: event.stepKey,
              },
              effects: [{ type: "PROMPT_COLLECT_INPUTS", taskId: state.taskId, stepKey: event.stepKey }],
            }
          }
          return stepSelectionTarget(state.shared, state.taskId)
        case "TASK_CONTINUE_COMPLETE":
          return {
            state,
            effects: [{ type: "COMPLETE_TASK", taskId: state.taskId }],
          }
        case "TASK_CONTINUE_DELETE":
          return {
            state,
            effects: [{ type: "DELETE_TASK", taskId: state.taskId }],
          }
        case "TASK_COMPLETE_OK":
        case "TASK_DELETE_OK": {
          const shared = {
            ...state.shared,
            activeTaskId: null,
            activeStepId: null,
          }
          return {
            state: { ...state, shared },
            effects: [{ type: "CHECK_TASK_ACTIVE", projectId: shared.projectId, taskId: state.taskId }],
          }
        }
        case "TASK_CONTINUE_STATUS":
          return { state, effects: [{ type: "PRINT_STATUS" }, { type: "PROMPT_TASK_CONTINUATION", taskId: state.taskId }] }
        case "TASK_ACTION_FAILED":
          return {
            state: { ...state, shared: withError(state.shared, event.message) },
            effects: [{ type: "PRINT_ERROR", message: event.message }, { type: "PROMPT_TASK_CONTINUATION", taskId: state.taskId }],
          }
        case "USER_BACK":
        case "USER_CANCEL":
          return { state: { status: "main_menu", shared: state.shared }, effects: [{ type: "PROMPT_MAIN_MENU" }] }
        default:
          return { state, effects: [] }
      }
    }

    case "fatal_error": {
      switch (event.type) {
        case "ERROR_ACK":
        case "USER_CANCEL":
          return { state: { status: "exiting", shared: state.shared }, effects: [{ type: "OUTRO" }] }
        default:
          return { state, effects: [] }
      }
    }

    case "exiting":
      return { state, effects: [] }
  }
}
