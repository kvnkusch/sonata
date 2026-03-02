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
    expect(startRequested.effects).toEqual([{ type: "START_TASK", projectId: "prj_test" }])

    const started = transition(main, { type: "TASK_START_OK", taskId: "tsk_123" })
    expect(started.state.status).toBe("selecting_step")
    if (started.state.status === "selecting_step") {
      expect(started.state.taskId).toBe("tsk_123")
      expect(started.state.shared.activeTaskId).toBe("tsk_123")
    }
    expect(started.effects).toEqual([{ type: "PROMPT_SELECT_STEP", taskId: "tsk_123", suggestedStepKey: undefined }])
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
      expect(completed.state.suggestedStepKey).toBe("plan")
    }
    expect(completed.effects).toEqual([
      { type: "PRINT_STEP_RESULT" },
      { type: "CHECK_TASK_ACTIVE", projectId: "prj_test", taskId: "tsk_1" },
    ])
  })

  it("task continuation carries suggested step into next selection", () => {
    const main = linkedMainMenuState()
    const continuation: InteractiveState = {
      status: "task_continuation",
      taskId: "tsk_1",
      suggestedStepKey: "implement",
      shared: main.status === "main_menu" ? main.shared : ({} as never),
    }

    const next = transition(continuation, { type: "TASK_CONTINUE_START_NEXT_STEP" })
    expect(next.state.status).toBe("selecting_step")
    if (next.state.status === "selecting_step") {
      expect(next.state.suggestedStepKey).toBe("implement")
    }
    expect(next.effects).toEqual([
      { type: "PROMPT_SELECT_STEP", taskId: "tsk_1", suggestedStepKey: "implement" },
    ])
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
      expect(failed.state.suggestedStepKey).toBeUndefined()
    }
    expect(failed.effects).toEqual([
      { type: "PRINT_STEP_RESULT" },
      { type: "CHECK_TASK_ACTIVE", projectId: "prj_test", taskId: "tsk_1" },
    ])
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

  it("resume task with active step jumps to execute", () => {
    const main = linkedMainMenuState()
    const selecting: InteractiveState = {
      status: "selecting_task",
      taskIds: ["tsk_1"],
      shared: main.status === "main_menu" ? main.shared : ({} as never),
    }

    const resumed = transition(selecting, { type: "TASK_SELECTED", taskId: "tsk_1", currentStepId: "stp_1" })
    expect(resumed.state.status).toBe("executing_step")
    if (resumed.state.status === "executing_step") {
      expect(resumed.state.stepId).toBe("stp_1")
      expect(resumed.state.shared.activeStepId).toBe("stp_1")
    }
    expect(resumed.effects).toEqual([{ type: "EXECUTE_STEP", taskId: "tsk_1", stepId: "stp_1" }])
  })

  it("cancel exits from main menu", () => {
    const main = linkedMainMenuState()
    const cancelled = transition(main, { type: "USER_CANCEL" })
    expect(cancelled.state.status).toBe("exiting")
    expect(cancelled.effects).toEqual([{ type: "OUTRO" }])
  })
})
