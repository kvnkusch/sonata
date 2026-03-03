import { describe, expect, it } from "bun:test"
import type { createCaller } from "@sonata/core/rpc"
import { createEffectRunner, type EffectRuntime } from "./effect-runner"

const CANCEL = Symbol("cancel")

function makeCallerStub(overrides?: any): ReturnType<typeof createCaller> {
  const base = {
    task: {
      start: async () => ({
        taskId: "tsk_default",
        projectId: "prj_test",
        workflowName: "default",
        status: "active" as const,
      }),
      listActive: () => [],
      complete: () => ({ taskId: "tsk_default", status: "completed" as const }),
      delete: () => ({ taskId: "tsk_default", status: "deleted" as const }),
    },
    step: {
      start: async () => ({ stepId: "stp_default" }),
      list: () => [],
      getToolset: async () => ({ tools: [] }),
      writeArtifact: async () => ({ relativePath: "" }),
      complete: async () => ({ status: "completed", suggestedNextStepKey: null }),
      fail: () => ({ status: "failed" }),
      cancel: () => ({ status: "cancelled" }),
    },
  }

  return {
    ...(base as object),
    ...(overrides as object),
    task: { ...(base.task as object), ...((overrides?.task as object) ?? {}) },
    step: { ...(base.step as object), ...((overrides?.step as object) ?? {}) },
  } as ReturnType<typeof createCaller>
}

function makePrompts(selectValue: unknown) {
  return {
    async select<Value>(_opts: unknown): Promise<Value | symbol> {
      return selectValue as Value
    },
    isCancel(value: unknown) {
      return value === CANCEL
    },
    outro() {},
  }
}

function makeRuntime(caller = makeCallerStub()): EffectRuntime {
  return {
    caller,
    sharedCtx: {
      projectId: "prj_test",
      projectRoot: "/tmp/project",
      opsRoot: "/tmp/ops",
      activeTaskId: null,
      activeStepId: null,
      lastOpencodeSession: null,
      lastError: null,
    },
    listedTasks: new Map(),
    lastStepResult: null,
  }
}

describe("interactive effect runner", () => {
  it("maps main menu selections to events", async () => {
    const eventsSeen: string[] = []
    const runEffect = createEffectRunner({
      prompts: makePrompts("start"),
      ui: {
        println(...args: string[]) {
          eventsSeen.push(args.join(" "))
        },
        error(message: string) {
          eventsSeen.push(message)
        },
      },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null }
      },
      async attachOpencodeTui() {},
    })

    const result = await runEffect({ type: "PROMPT_MAIN_MENU" }, makeRuntime())
    expect(result).toEqual([{ type: "MAIN_START_TASK" }])
    expect(eventsSeen).toHaveLength(0)
  })

  it("returns USER_BACK and prints when no active tasks", async () => {
    const printed: string[] = []
    const caller = makeCallerStub({
      task: {
        start: async () => ({
          taskId: "tsk_unused",
          projectId: "prj_test",
          workflowName: "default",
          status: "active" as const,
        }),
        listActive: () => [],
      },
    })
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: {
        println(...args: string[]) {
          printed.push(args.join(" "))
        },
        error(message: string) {
          printed.push(message)
        },
      },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null }
      },
      async attachOpencodeTui() {},
    })

    const result = await runEffect({ type: "LIST_ACTIVE_TASKS", projectId: "prj_test" }, makeRuntime(caller))
    expect(result).toEqual([{ type: "USER_BACK" }])
    expect(printed).toContain("No active tasks")
  })

  it("includes currentStepId when selecting active task", async () => {
    const caller = makeCallerStub({
      task: {
        start: async () => ({
          taskId: "tsk_unused",
          projectId: "prj_test",
          workflowName: "default",
          status: "active" as const,
        }),
        listActive: () => [
          {
            taskId: "tsk_1",
            projectId: "prj_test",
            workflowName: "default",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
            currentStepId: "stp_1",
            currentStepIndex: 1,
          },
        ],
      },
    })
    const runEffect = createEffectRunner({
      prompts: makePrompts("tsk_1"),
      ui: {
        println() {},
        error() {},
      },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null }
      },
      async attachOpencodeTui() {},
    })

    const runtime = makeRuntime(caller)
    await runEffect({ type: "LIST_ACTIVE_TASKS", projectId: "prj_test" }, runtime)
    const selected = await runEffect({ type: "PROMPT_SELECT_TASK", taskIds: ["tsk_1"] }, runtime)
    expect(selected).toEqual([{ type: "TASK_SELECTED", taskId: "tsk_1", currentStepId: "stp_1" }])
  })

  it("stores last step result from execute effect", async () => {
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: {
        println() {},
        error() {},
      },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return {
          status: "blocked" as const,
          suggestedNextStepKey: "implement",
          opencode: {
            baseUrl: "http://127.0.0.1:1234",
            sessionId: "ses_1",
            reused: false,
          },
        }
      },
      async attachOpencodeTui() {},
    })

    const runtime = makeRuntime()
    const result = await runEffect({ type: "EXECUTE_STEP", taskId: "tsk_1", stepId: "stp_1" }, runtime)

    expect(result).toEqual([
      {
        type: "STEP_EXECUTE_OK",
        result: {
          status: "blocked",
          suggestedNextStepKey: "implement",
          opencodeSession: {
            baseUrl: "http://127.0.0.1:1234",
            sessionId: "ses_1",
            reused: false,
          },
        },
      },
    ])
    expect(runtime.lastStepResult).toEqual({
      status: "blocked",
      suggestedNextStepKey: "implement",
    })
  })

  it("maps task continuation selections to lifecycle events", async () => {
    const runComplete = createEffectRunner({
      prompts: makePrompts("complete"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null }
      },
      async attachOpencodeTui() {},
    })

    const completeResult = await runComplete({ type: "PROMPT_TASK_CONTINUATION", taskId: "tsk_1" }, makeRuntime())
    expect(completeResult).toEqual([{ type: "TASK_CONTINUE_COMPLETE" }])

    const runDelete = createEffectRunner({
      prompts: makePrompts("delete"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null }
      },
      async attachOpencodeTui() {},
    })

    const deleteResult = await runDelete({ type: "PROMPT_TASK_CONTINUATION", taskId: "tsk_1" }, makeRuntime())
    expect(deleteResult).toEqual([{ type: "TASK_CONTINUE_DELETE" }])
  })

  it("runs task complete and delete effects", async () => {
    const caller = makeCallerStub()
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null }
      },
      async attachOpencodeTui() {},
    })

    const runtime = makeRuntime(caller)
    await expect(runEffect({ type: "COMPLETE_TASK", taskId: "tsk_1" }, runtime)).resolves.toEqual([
      { type: "TASK_COMPLETE_OK" },
    ])
    await expect(runEffect({ type: "DELETE_TASK", taskId: "tsk_1" }, runtime)).resolves.toEqual([
      { type: "TASK_DELETE_OK" },
    ])
  })

  it("returns USER_BACK when choosing back from step selection", async () => {
    const runEffect = createEffectRunner({
      prompts: makePrompts("__back_to_task_menu__"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [{ id: "intake" }] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null }
      },
      async attachOpencodeTui() {},
    })

    const result = await runEffect({ type: "PROMPT_SELECT_STEP", taskId: "tsk_1" }, makeRuntime())
    expect(result).toEqual([{ type: "USER_BACK" }])
  })

  it("derives suggested step from current step statuses", async () => {
    let observedInitialValue: unknown
    const caller = makeCallerStub({
      step: {
        list: () => [
          {
            stepId: "stp_1",
            stepKey: "intake",
            stepIndex: 1,
            status: "completed",
            startedAt: 1,
            completedAt: 2,
          },
        ],
      },
    })
    const runEffect = createEffectRunner({
      prompts: {
        async select<Value>(opts: { initialValue?: unknown }): Promise<Value> {
          observedInitialValue = opts.initialValue
          return "research" as Value
        },
        isCancel(value: unknown) {
          return value === CANCEL
        },
        outro() {},
      },
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [{ id: "intake" }, { id: "research" }] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null }
      },
      async attachOpencodeTui() {},
    })

    const result = await runEffect({ type: "PROMPT_SELECT_STEP", taskId: "tsk_1" }, makeRuntime(caller))
    expect(observedInitialValue).toBe("research")
    expect(result).toEqual([{ type: "STEP_SELECTED", stepKey: "research" }])
  })

  it("checks step activity against current DB status", async () => {
    const activeCaller = makeCallerStub({
      step: {
        list: () => [{ stepId: "stp_1", status: "active" }],
      },
    })
    const inactiveCaller = makeCallerStub({
      step: {
        list: () => [{ stepId: "stp_1", status: "completed" }],
      },
    })

    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null }
      },
      async attachOpencodeTui() {},
    })

    await expect(
      runEffect({ type: "CHECK_STEP_ACTIVE", taskId: "tsk_1", stepId: "stp_1" }, makeRuntime(activeCaller)),
    ).resolves.toEqual([{ type: "STEP_STILL_ACTIVE", active: true }])

    await expect(
      runEffect({ type: "CHECK_STEP_ACTIVE", taskId: "tsk_1", stepId: "stp_1" }, makeRuntime(inactiveCaller)),
    ).resolves.toEqual([{ type: "STEP_STILL_ACTIVE", active: false }])
  })

  it("prints status with step index/name/status", async () => {
    const lines: string[] = []
    const caller = makeCallerStub({
      step: {
        start: async () => ({
          taskId: "tsk_1",
          stepId: "stp_unused",
          stepKey: "intake",
          stepIndex: 1,
          status: "active" as const,
          resolvedInputs: { invocation: null, artifacts: {} },
        }),
        list: () => [
          {
            stepId: "stp_1",
            stepKey: "intake",
            stepIndex: 1,
            status: "completed",
            startedAt: 1,
            completedAt: 2,
          },
          {
            stepId: "stp_2",
            stepKey: "plan",
            stepIndex: 2,
            status: "active",
            startedAt: 3,
            completedAt: null,
          },
        ],
        fail: () => ({ taskId: "tsk_1", stepId: "stp_unused", status: "failed" as const }),
        cancel: () => ({ taskId: "tsk_1", stepId: "stp_unused", status: "cancelled" as const }),
      },
    })

    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: {
        println(...args: string[]) {
          lines.push(args.join(" "))
        },
        error() {},
      },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null }
      },
      async attachOpencodeTui() {},
    })

    const runtime = makeRuntime(caller)
    runtime.sharedCtx = {
      ...(runtime.sharedCtx as NonNullable<typeof runtime.sharedCtx>),
      activeTaskId: "tsk_1",
      activeStepId: "stp_2",
    }
    await runEffect({ type: "PRINT_STATUS" }, runtime)

    expect(lines).toContain("steps:")
    expect(lines).toContain("  [1] intake status=completed")
    expect(lines).toContain("  [2] plan status=active")
  })

  it("prints failed step reason/details when present", async () => {
    const lines: string[] = []
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: {
        println(...args: string[]) {
          lines.push(args.join(" "))
        },
        error() {},
      },
      async ensureLinkedProject() {
        return { projectId: "prj_test", projectRoot: "/tmp/project", opsRoot: "/tmp/ops" }
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never
      },
      async collectStepInputs() {
        return {}
      },
      async executeStep() {
        return {
          status: "failed" as const,
          suggestedNextStepKey: null,
          failure: { reason: "validation failed", details: { code: "E_VALIDATION" } },
        }
      },
      async attachOpencodeTui() {},
    })

    const runtime = makeRuntime()
    await runEffect({ type: "EXECUTE_STEP", taskId: "tsk_1", stepId: "stp_1" }, runtime)
    await runEffect({ type: "PRINT_STEP_RESULT" }, runtime)

    expect(lines).toContain("step_status: failed")
    expect(lines).toContain("failure_reason: validation failed")
    expect(lines).toContain('failure_details: {"code":"E_VALIDATION"}')
  })
})
