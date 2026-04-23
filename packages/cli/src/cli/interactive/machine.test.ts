import { describe, expect, it } from "bun:test"
import {
  initialInteractiveMachineState,
  transition,
  type InteractiveState,
} from "./machine"

function linkedMainMenuState(): InteractiveState {
  const booted = transition(initialInteractiveMachineState(), {
    type: "BOOTSTRAP_OK",
    projectId: "prj_test",
    projectRoot: "/tmp/project",
    opsRoot: "/tmp/ops",
  })
  return booted.state
}

describe("interactive machine transitions", () => {
  it("boots into main menu with prompt effect", () => {
    const result = transition(initialInteractiveMachineState(), {
      type: "BOOTSTRAP_OK",
      projectId: "prj_test",
      projectRoot: "/tmp/project",
      opsRoot: "/tmp/ops",
    })

    expect(result.state.status).toBe("main_menu")
    expect(result.effects).toEqual([{ type: "PROMPT_MAIN_MENU" }])
  })

  it("start task flow reaches step selection", () => {
    const main = linkedMainMenuState()
    const startRequested = transition(main, { type: "MAIN_START_TASK" })
    expect(startRequested.state.status).toBe("selecting_workflow")
    expect(startRequested.effects).toEqual([{ type: "PROMPT_SELECT_WORKFLOW", opsRoot: "/tmp/ops" }])

    const workflowSelected = transition(startRequested.state, {
      type: "WORKFLOW_SELECTED",
      workflowName: "default",
    })
    expect(workflowSelected.effects).toEqual([
      { type: "START_TASK", projectId: "prj_test", workflowName: "default" },
    ])

    const started = transition(workflowSelected.state, { type: "TASK_START_OK", taskId: "tsk_123" })
    expect(started.state.status).toBe("selecting_step")
    if (started.state.status === "selecting_step") {
      expect(started.state.taskId).toBe("tsk_123")
      expect(started.state.shared.activeTaskId).toBe("tsk_123")
    }
    expect(started.effects).toEqual([{ type: "PROMPT_SELECT_STEP", taskId: "tsk_123" }])
  })

  it("step completion transitions into task continuation check", () => {
    const main = linkedMainMenuState()
    const executing: InteractiveState = {
      status: "executing_step",
      taskId: "tsk_1",
      stepId: "stp_1",
      shared: {
        ...(main.status === "main_menu" ? main.shared : ({} as never)),
        activeTaskId: "tsk_1",
        activeStepId: "stp_1",
      },
    }

    const completed = transition(executing, {
      type: "STEP_EXECUTE_OK",
      result: {
        status: "completed",
        suggestedNextStepKey: "plan",
      },
    })

    expect(completed.state.status).toBe("task_continuation")
    if (completed.state.status === "task_continuation") {
      expect(completed.state.shared.activeStepId).toBeNull()
    }
    expect(completed.effects).toEqual([
      { type: "PRINT_STEP_RESULT" },
      { type: "CHECK_TASK_ACTIVE", projectId: "prj_test", taskId: "tsk_1" },
    ])
  })

  it("task continuation starts next step selection", () => {
    const main = linkedMainMenuState()
    const continuation: InteractiveState = {
      status: "task_continuation",
      taskId: "tsk_1",
      shared: main.status === "main_menu" ? main.shared : ({} as never),
    }

    const next = transition(continuation, { type: "TASK_CONTINUE_START_NEXT_STEP" })
    expect(next.state.status).toBe("selecting_step")
    expect(next.effects).toEqual([{ type: "PROMPT_SELECT_STEP", taskId: "tsk_1" }])
  })

  it("task continuation with suggested step starts that step flow directly", () => {
    const main = linkedMainMenuState()
    const continuation: InteractiveState = {
      status: "task_continuation",
      taskId: "tsk_1",
      shared: main.status === "main_menu" ? main.shared : ({} as never),
    }

    const next = transition(continuation, { type: "TASK_CONTINUE_START_NEXT_STEP", stepKey: "research" })
    expect(next.state.status).toBe("collecting_inputs")
    expect(next.effects).toEqual([{ type: "PROMPT_COLLECT_INPUTS", taskId: "tsk_1", stepKey: "research" }])
  })

  it("task continuation can request task completion", () => {
    const main = linkedMainMenuState()
    const continuation: InteractiveState = {
      status: "task_continuation",
      taskId: "tsk_1",
      shared: main.status === "main_menu" ? main.shared : ({} as never),
    }

    const next = transition(continuation, { type: "TASK_CONTINUE_COMPLETE" })
    expect(next.effects).toEqual([{ type: "COMPLETE_TASK", taskId: "tsk_1" }])
  })

  it("task completion clears active task and re-checks activity", () => {
    const main = linkedMainMenuState()
    const continuation: InteractiveState = {
      status: "task_continuation",
      taskId: "tsk_1",
      shared: {
        ...(main.status === "main_menu" ? main.shared : ({} as never)),
        activeTaskId: "tsk_1",
        activeStepId: null,
      },
    }

    const completed = transition(continuation, { type: "TASK_COMPLETE_OK" })
    expect(completed.state.status).toBe("task_continuation")
    if (completed.state.status === "task_continuation") {
      expect(completed.state.shared.activeTaskId).toBeNull()
      expect(completed.state.shared.activeStepId).toBeNull()
    }
    expect(completed.effects).toEqual([{ type: "CHECK_TASK_ACTIVE", projectId: "prj_test", taskId: "tsk_1" }])
  })

  it("step failure clears active step and goes to task continuation", () => {
    const main = linkedMainMenuState()
    const executing: InteractiveState = {
      status: "executing_step",
      taskId: "tsk_1",
      stepId: "stp_1",
      shared: {
        ...(main.status === "main_menu" ? main.shared : ({} as never)),
        activeTaskId: "tsk_1",
        activeStepId: "stp_1",
      },
    }

    const failed = transition(executing, {
      type: "STEP_EXECUTE_OK",
      result: {
        status: "failed",
        suggestedNextStepKey: null,
        failure: { reason: "boom" },
      },
    })

    expect(failed.state.status).toBe("task_continuation")
    if (failed.state.status === "task_continuation") {
      expect(failed.state.shared.activeStepId).toBeNull()
    }
    expect(failed.effects).toEqual([
      { type: "PRINT_STEP_RESULT" },
      { type: "CHECK_TASK_ACTIVE", projectId: "prj_test", taskId: "tsk_1" },
    ])
  })

  it("waiting execute loads step details before prompting for actions", () => {
    const main = linkedMainMenuState()
    const executing: InteractiveState = {
      status: "executing_step",
      taskId: "tsk_1",
      stepId: "stp_1",
      shared: {
        ...(main.status === "main_menu" ? main.shared : ({} as never)),
        activeTaskId: "tsk_1",
        activeStepId: "stp_1",
      },
    }

    const waiting = transition(executing, {
      type: "STEP_EXECUTE_OK",
      result: {
        status: "waiting",
        suggestedNextStepKey: "research",
      },
    })

    expect(waiting.state.status).toBe("step_actions")
    expect(waiting.effects).toEqual([
      { type: "PRINT_STEP_RESULT" },
      { type: "GET_STEP", taskId: "tsk_1", stepId: "stp_1" },
    ])
  })

  it("blocked execute loads step details before prompting for actions", () => {
    const main = linkedMainMenuState()
    const stepActions: InteractiveState = {
      status: "step_actions",
      taskId: "tsk_1",
      stepId: "stp_1",
      rootStepStatus: "blocked",
      shared: {
        ...(main.status === "main_menu" ? main.shared : ({} as never)),
        activeTaskId: "tsk_1",
        activeStepId: "stp_1",
      },
    }

    const transitioned = transition(stepActions, { type: "STEP_STATUS_LOADED", status: "blocked" })
    expect(transitioned.state.status).toBe("step_actions")
    expect(transitioned.effects).toEqual([
      { type: "PRINT_STEP_DETAILS" },
      { type: "PROMPT_STEP_ACTIONS", rootStepStatus: "blocked" },
    ])
  })

  it("step actions exits to task continuation when step becomes terminal", () => {
    const main = linkedMainMenuState()
    const stepActions: InteractiveState = {
      status: "step_actions",
      taskId: "tsk_1",
      stepId: "stp_1",
      rootStepStatus: "waiting",
      shared: {
        ...(main.status === "main_menu" ? main.shared : ({} as never)),
        activeTaskId: "tsk_1",
        activeStepId: "stp_1",
      },
    }

    const transitioned = transition(stepActions, { type: "STEP_STATUS_LOADED", status: "completed" })
    expect(transitioned.state.status).toBe("task_continuation")
    if (transitioned.state.status === "task_continuation") {
      expect(transitioned.state.shared.activeStepId).toBeNull()
    }
    expect(transitioned.effects).toEqual([{ type: "CHECK_TASK_ACTIVE", projectId: "prj_test", taskId: "tsk_1" }])
  })

  it("task continuation goes back to main menu when task is inactive", () => {
    const main = linkedMainMenuState()
    const continuation: InteractiveState = {
      status: "task_continuation",
      taskId: "tsk_1",
      shared: main.status === "main_menu" ? main.shared : ({} as never),
    }

    const inactive = transition(continuation, { type: "TASK_STILL_ACTIVE", active: false })
    expect(inactive.state.status).toBe("main_menu")
    expect(inactive.effects).toEqual([{ type: "PROMPT_MAIN_MENU" }])
  })

  it("task continuation with waiting root step returns to step actions", () => {
    const main = linkedMainMenuState()
    const continuation: InteractiveState = {
      status: "task_continuation",
      taskId: "tsk_1",
      shared: main.status === "main_menu" ? main.shared : ({} as never),
    }

    const waiting = transition(continuation, {
      type: "TASK_STILL_ACTIVE",
      active: true,
      currentRootStepId: "stp_1",
      currentRootStepStatus: "waiting",
    })

    expect(waiting.state.status).toBe("step_actions")
    if (waiting.state.status === "step_actions") {
      expect(waiting.state.stepId).toBe("stp_1")
      expect(waiting.state.rootStepStatus).toBe("waiting")
      expect(waiting.state.shared.activeStepId).toBe("stp_1")
    }
    expect(waiting.effects).toEqual([{ type: "GET_STEP", taskId: "tsk_1", stepId: "stp_1" }])
  })

  it("resume task with active root step jumps to execute", () => {
    const main = linkedMainMenuState()
    const selecting: InteractiveState = {
      status: "selecting_task",
      taskIds: ["tsk_1"],
      shared: main.status === "main_menu" ? main.shared : ({} as never),
    }

    const resumed = transition(selecting, {
      type: "TASK_SELECTED",
      taskId: "tsk_1",
      currentRootStepId: "stp_1",
      currentRootStepStatus: "active",
    })
    expect(resumed.state.status).toBe("executing_step")
    if (resumed.state.status === "executing_step") {
      expect(resumed.state.stepId).toBe("stp_1")
      expect(resumed.state.shared.activeStepId).toBe("stp_1")
    }
    expect(resumed.effects).toEqual([{ type: "EXECUTE_STEP", taskId: "tsk_1", stepId: "stp_1" }])
  })

  it("resume task with waiting root step loads details instead of executing", () => {
    const main = linkedMainMenuState()
    const selecting: InteractiveState = {
      status: "selecting_task",
      taskIds: ["tsk_1"],
      shared: main.status === "main_menu" ? main.shared : ({} as never),
    }

    const resumed = transition(selecting, {
      type: "TASK_SELECTED",
      taskId: "tsk_1",
      currentRootStepId: "stp_1",
      currentRootStepStatus: "waiting",
    })
    expect(resumed.state.status).toBe("step_actions")
    if (resumed.state.status === "step_actions") {
      expect(resumed.state.rootStepStatus).toBe("waiting")
      expect(resumed.state.shared.activeStepId).toBe("stp_1")
    }
    expect(resumed.effects).toEqual([{ type: "GET_STEP", taskId: "tsk_1", stepId: "stp_1" }])
  })

  it("back from waiting step actions returns to main menu", () => {
    const main = linkedMainMenuState()
    const stepActions: InteractiveState = {
      status: "step_actions",
      taskId: "tsk_1",
      stepId: "stp_1",
      rootStepStatus: "waiting",
      shared: {
        ...(main.status === "main_menu" ? main.shared : ({} as never)),
        activeTaskId: "tsk_1",
        activeStepId: "stp_1",
      },
    }

    const back = transition(stepActions, { type: "USER_BACK" })
    expect(back.state.status).toBe("main_menu")
    expect(back.effects).toEqual([{ type: "PROMPT_MAIN_MENU" }])
  })

  it("attach action carries persisted session details into attach effect", () => {
    const main = linkedMainMenuState()
    const stepActions: InteractiveState = {
      status: "step_actions",
      taskId: "tsk_1",
      stepId: "stp_1",
      rootStepStatus: "blocked",
      shared: {
        ...(main.status === "main_menu" ? main.shared : ({} as never)),
        activeTaskId: "tsk_1",
        activeStepId: "stp_1",
      },
    }

    const attach = transition(stepActions, {
      type: "STEP_ACTION_ATTACH",
      baseUrl: "http://127.0.0.1:1234",
      sessionId: "ses_1",
    })

    expect(attach.effects).toEqual([
      {
        type: "ATTACH_OPENCODE",
        projectRoot: "/tmp/project",
        baseUrl: "http://127.0.0.1:1234",
        sessionId: "ses_1",
      },
      { type: "GET_STEP", taskId: "tsk_1", stepId: "stp_1" },
    ])
  })

  it("cancel exits from main menu", () => {
    const main = linkedMainMenuState()
    const cancelled = transition(main, { type: "USER_CANCEL" })
    expect(cancelled.state.status).toBe("exiting")
    expect(cancelled.effects).toEqual([{ type: "OUTRO" }])
  })

  it("back from select step returns to task continuation", () => {
    const main = linkedMainMenuState()
    const selecting: InteractiveState = {
      status: "selecting_step",
      taskId: "tsk_1",
      shared: main.status === "main_menu" ? main.shared : ({} as never),
    }

    const back = transition(selecting, { type: "USER_BACK" })
    expect(back.state.status).toBe("task_continuation")
    if (back.state.status === "task_continuation") {
      expect(back.state.taskId).toBe("tsk_1")
    }
    expect(back.effects).toEqual([{ type: "CHECK_TASK_ACTIVE", projectId: "prj_test", taskId: "tsk_1" }])
  })
})
