import { describe, expect, it } from "bun:test";
import type { createCaller } from "@sonata/core/rpc";
import { createEffectRunner, type EffectRuntime } from "./effect-runner";

const CANCEL = Symbol("cancel");

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
      get: () => ({
        stepId: "stp_default",
        stepKey: "plan",
        stepIndex: 1,
        status: "active" as const,
        parentStepId: null,
        workKey: null,
        sessionId: null,
        opencodeBaseUrl: null,
        waitSpec: null,
        waitSnapshot: null,
        blockPayload: null,
        orphanedReason: null,
      }),
      getToolset: async () => ({ tools: [] }),
      writeArtifact: async () => ({ relativePath: "" }),
      complete: async () => ({
        status: "completed",
        suggestedNextStepKey: null,
      }),
      resumeBlocked: async () => ({
        status: "active" as const,
        taskId: "tsk_default",
        stepId: "stp_default",
      }),
      retryOrphanedInNewSession: () => ({
        status: "active" as const,
        taskId: "tsk_default",
        stepId: "stp_default",
      }),
      fail: () => ({ status: "failed" }),
      cancel: () => ({ status: "cancelled" }),
    },
  };

  return {
    ...(base as object),
    ...(overrides as object),
    task: { ...(base.task as object), ...(overrides?.task as object) },
    step: { ...(base.step as object), ...(overrides?.step as object) },
  } as ReturnType<typeof createCaller>;
}

function makePrompts(selectValue: unknown) {
  return {
    async select<Value>(_opts: unknown): Promise<Value | symbol> {
      return selectValue as Value;
    },
    isCancel(value: unknown) {
      return value === CANCEL;
    },
    outro() {},
  };
}

async function readOpsConfig() {
  return {
    config: {
      version: 1 as const,
      defaultWorkflowId: "default",
      workflowModules: [{ id: "default", path: "./workflows/default.ts" }],
    },
    configPath: "/tmp/ops/config.json",
  };
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
    lastStepDetail: null,
  };
}

describe("interactive effect runner", () => {
  it("maps main menu selections to events", async () => {
    const eventsSeen: string[] = [];
    const runEffect = createEffectRunner({
      prompts: makePrompts("start"),
      ui: {
        println(...args: string[]) {
          eventsSeen.push(args.join(" "));
        },
        error(message: string) {
          eventsSeen.push(message);
        },
      },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const result = await runEffect({ type: "PROMPT_MAIN_MENU" }, makeRuntime());
    expect(result).toEqual([{ type: "MAIN_START_TASK" }]);
    expect(eventsSeen).toHaveLength(0);
  });

  it("selects a workflow before starting a task", async () => {
    const runEffect = createEffectRunner({
      prompts: makePrompts("secondary"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      async readOpsConfig() {
        return {
          config: {
            version: 1 as const,
            defaultWorkflowId: "default",
            workflowModules: [
              { id: "default", path: "./workflows/default.ts" },
              { id: "secondary", path: "./workflows/secondary.ts" },
            ],
          },
          configPath: "/tmp/ops/config.json",
        };
      },
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const result = await runEffect(
      { type: "PROMPT_SELECT_WORKFLOW", opsRoot: "/tmp/ops" },
      makeRuntime(),
    );
    expect(result).toEqual([
      { type: "WORKFLOW_SELECTED", workflowName: "secondary" },
    ]);
  });

  it("passes the selected workflow when starting a task", async () => {
    const calls: unknown[] = [];
    const caller = makeCallerStub({
      task: {
        start: async (input: unknown) => {
          calls.push(input);
          return {
            taskId: "tsk_default",
            projectId: "prj_test",
            workflowName: "secondary",
            status: "active" as const,
          };
        },
      },
    });
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const result = await runEffect(
      { type: "START_TASK", projectId: "prj_test", workflowName: "secondary" },
      makeRuntime(caller),
    );

    expect(result).toEqual([{ type: "TASK_START_OK", taskId: "tsk_default" }]);
    expect(calls).toEqual([
      { projectId: "prj_test", workflowRef: { name: "secondary" } },
    ]);
  });

  it("returns USER_BACK and prints when no active tasks", async () => {
    const printed: string[] = [];
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
    });
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: {
        println(...args: string[]) {
          printed.push(args.join(" "));
        },
        error(message: string) {
          printed.push(message);
        },
      },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const result = await runEffect(
      { type: "LIST_ACTIVE_TASKS", projectId: "prj_test" },
      makeRuntime(caller),
    );
    expect(result).toEqual([{ type: "USER_BACK" }]);
    expect(printed).toContain("No active tasks");
  });

  it("includes current root step status when selecting a task", async () => {
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
            currentRootStepId: "stp_1",
            currentRootStepKey: "plan",
            currentRootStepStatus: "active",
          },
        ],
      },
    });
    const runEffect = createEffectRunner({
      prompts: makePrompts("tsk_1"),
      ui: {
        println() {},
        error() {},
      },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime(caller);
    await runEffect(
      { type: "LIST_ACTIVE_TASKS", projectId: "prj_test" },
      runtime,
    );
    const selected = await runEffect(
      { type: "PROMPT_SELECT_TASK", taskIds: ["tsk_1"] },
      runtime,
    );
    expect(selected).toEqual([
      {
        type: "TASK_SELECTED",
        taskId: "tsk_1",
        currentRootStepId: "stp_1",
        currentRootStepStatus: "active",
      },
    ]);
  });

  for (const status of ["waiting", "blocked", "orphaned"] as const) {
    it(`does not resume directly when the current root step is ${status}`, async () => {
      const caller = makeCallerStub({
        task: {
          listActive: () => [
            {
              taskId: "tsk_1",
              projectId: "prj_test",
              workflowName: "default",
              status: "active",
              createdAt: 1,
              updatedAt: 1,
              currentRootStepId: "stp_1",
              currentRootStepKey: "plan",
              currentRootStepStatus: status,
            },
          ],
        },
      });
      const runEffect = createEffectRunner({
        prompts: makePrompts("tsk_1"),
        ui: {
          println() {},
          error() {},
        },
        async ensureLinkedProject() {
          return {
            projectId: "prj_test",
            projectRoot: "/tmp/project",
            opsRoot: "/tmp/ops",
          };
        },
        readOpsConfig,
        async loadWorkflowForTask() {
          return { workflow: { steps: [] } } as never;
        },
        async collectStepInputs() {
          return {};
        },
        async executeStep() {
          return { status: "completed", suggestedNextStepKey: null };
        },
        async attachOpencodeTui() {},
      });

      const runtime = makeRuntime(caller);
      await runEffect(
        { type: "LIST_ACTIVE_TASKS", projectId: "prj_test" },
        runtime,
      );
      const selected = await runEffect(
        { type: "PROMPT_SELECT_TASK", taskIds: ["tsk_1"] },
        runtime,
      );
      expect(selected).toEqual([
        {
          type: "TASK_SELECTED",
          taskId: "tsk_1",
          currentRootStepId: "stp_1",
          currentRootStepStatus: status,
        },
      ]);
    });
  }

  it("stores last step result from execute effect", async () => {
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: {
        println() {},
        error() {},
      },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return {
          status: "blocked" as const,
          suggestedNextStepKey: "implement",
          opencode: {
            baseUrl: "http://127.0.0.1:1234",
            sessionId: "ses_1",
            reused: false,
            join: "auto",
          },
        };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime();
    const result = await runEffect(
      { type: "EXECUTE_STEP", taskId: "tsk_1", stepId: "stp_1" },
      runtime,
    );

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
            join: "auto",
            attach: true,
          },
        },
      },
    ]);
    expect(runtime.lastStepResult).toEqual({
      status: "blocked",
      suggestedNextStepKey: "implement",
    });
  });

  it("marks ask join sessions for background when declined", async () => {
    const runEffect = createEffectRunner({
      prompts: makePrompts("background"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return {
          status: "active" as const,
          suggestedNextStepKey: null,
          opencode: {
            baseUrl: "http://127.0.0.1:1234",
            sessionId: "ses_ask",
            reused: false,
            join: "ask" as const,
          },
        };
      },
      async attachOpencodeTui() {},
    });

    const result = await runEffect(
      { type: "EXECUTE_STEP", taskId: "tsk_1", stepId: "stp_1" },
      makeRuntime(),
    );

    expect(result).toEqual([
      {
        type: "STEP_EXECUTE_OK",
        result: {
          status: "active",
          suggestedNextStepKey: null,
          opencodeSession: {
            baseUrl: "http://127.0.0.1:1234",
            sessionId: "ses_ask",
            reused: false,
            join: "ask",
            attach: false,
          },
        },
      },
    ]);
  });

  it("marks ask join sessions for background when cancelled", async () => {
    const runEffect = createEffectRunner({
      prompts: makePrompts(CANCEL),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return {
          status: "active" as const,
          suggestedNextStepKey: null,
          opencode: {
            baseUrl: "http://127.0.0.1:1234",
            sessionId: "ses_cancelled_ask",
            reused: false,
            join: "ask" as const,
          },
        };
      },
      async attachOpencodeTui() {},
    });

    const result = await runEffect(
      { type: "EXECUTE_STEP", taskId: "tsk_1", stepId: "stp_1" },
      makeRuntime(),
    );

    expect(result).toEqual([
      {
        type: "STEP_EXECUTE_OK",
        result: {
          status: "active",
          suggestedNextStepKey: null,
          opencodeSession: {
            baseUrl: "http://127.0.0.1:1234",
            sessionId: "ses_cancelled_ask",
            reused: false,
            join: "ask",
            attach: false,
          },
        },
      },
    ]);
  });

  it("prints attach details for background sessions", async () => {
    const lines: string[] = [];
    const runEffect = createEffectRunner({
      prompts: makePrompts("start"),
      ui: {
        println(...args: string[]) {
          lines.push(args.join(" "));
        },
        error() {},
      },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed" as const, suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    await runEffect(
      {
        type: "PRINT_OPENCODE_SESSION",
        taskId: "tsk_1",
        stepId: "stp_1",
        baseUrl: "http://127.0.0.1:1234",
        sessionId: "ses_bg",
      },
      makeRuntime(),
    );

    expect(lines).toContain("step_id: stp_1");
    expect(lines).toContain("task_id: tsk_1");
    expect(lines).toContain("opencode_session: ses_bg");
    expect(lines).toContain("opencode_base_url: http://127.0.0.1:1234");
    expect(lines).toContain("attach_command: sonata step attach stp_1 --task-id tsk_1");
  });

  it("maps task continuation selections to lifecycle events", async () => {
    const runComplete = createEffectRunner({
      prompts: makePrompts("complete"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const completeResult = await runComplete(
      { type: "PROMPT_TASK_CONTINUATION", taskId: "tsk_1" },
      makeRuntime(),
    );
    expect(completeResult).toEqual([{ type: "TASK_CONTINUE_COMPLETE" }]);

    const runDelete = createEffectRunner({
      prompts: makePrompts("delete"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const deleteResult = await runDelete(
      { type: "PROMPT_TASK_CONTINUATION", taskId: "tsk_1" },
      makeRuntime(),
    );
    expect(deleteResult).toEqual([{ type: "TASK_CONTINUE_DELETE" }]);
  });

  it("labels first continuation option with suggested next step", async () => {
    let observedFirstLabel: string | undefined;
    const runEffect = createEffectRunner({
      prompts: {
        async select<Value>(opts: any): Promise<Value> {
          observedFirstLabel = opts.options[0]?.label;
          return "next" as Value;
        },
        isCancel(value: unknown) {
          return value === CANCEL;
        },
        outro() {},
      },
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return {
          workflow: { steps: [{ id: "intake" }, { id: "research" }] },
        } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime();
    runtime.lastStepResult = {
      status: "completed",
      suggestedNextStepKey: "research",
    };
    await runEffect(
      { type: "PROMPT_TASK_CONTINUATION", taskId: "tsk_1" },
      runtime,
    );

    expect(observedFirstLabel).toBe("Start next step (research)");
  });

  it("emits continuation event with suggested step key", async () => {
    const runEffect = createEffectRunner({
      prompts: makePrompts("next"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return {
          workflow: { steps: [{ id: "intake" }, { id: "research" }] },
        } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime();
    runtime.lastStepResult = {
      status: "completed",
      suggestedNextStepKey: "research",
    };
    const result = await runEffect(
      { type: "PROMPT_TASK_CONTINUATION", taskId: "tsk_1" },
      runtime,
    );

    expect(result).toEqual([
      { type: "TASK_CONTINUE_START_NEXT_STEP", stepKey: "research" },
    ]);
  });

  it("falls back to generic continuation label when suggested step is already completed", async () => {
    let observedFirstLabel: string | undefined;
    const caller = makeCallerStub({
      step: {
        list: () => [
          { stepId: "stp_1", stepKey: "research", status: "completed" },
        ],
      },
    });
    const runEffect = createEffectRunner({
      prompts: {
        async select<Value>(opts: any): Promise<Value> {
          observedFirstLabel = opts.options[0]?.label;
          return "next" as Value;
        },
        isCancel(value: unknown) {
          return value === CANCEL;
        },
        outro() {},
      },
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return {
          workflow: { steps: [{ id: "intake" }, { id: "research" }] },
        } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime(caller);
    runtime.lastStepResult = {
      status: "completed",
      suggestedNextStepKey: "research",
    };
    await runEffect(
      { type: "PROMPT_TASK_CONTINUATION", taskId: "tsk_1" },
      runtime,
    );

    expect(observedFirstLabel).toBe("Start another step");
  });

  it("runs task complete and delete effects", async () => {
    const caller = makeCallerStub();
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime(caller);
    await expect(
      runEffect({ type: "COMPLETE_TASK", taskId: "tsk_1" }, runtime),
    ).resolves.toEqual([{ type: "TASK_COMPLETE_OK" }]);
    await expect(
      runEffect({ type: "DELETE_TASK", taskId: "tsk_1" }, runtime),
    ).resolves.toEqual([{ type: "TASK_DELETE_OK" }]);
  });

  it("returns USER_BACK when choosing back from step selection", async () => {
    const runEffect = createEffectRunner({
      prompts: makePrompts("__back_to_task_menu__"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [{ id: "intake" }] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const result = await runEffect(
      { type: "PROMPT_SELECT_STEP", taskId: "tsk_1" },
      makeRuntime(),
    );
    expect(result).toEqual([{ type: "USER_BACK" }]);
  });

  it("derives suggested step from current step statuses", async () => {
    let observedInitialValue: unknown;
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
    });
    const runEffect = createEffectRunner({
      prompts: {
        async select<Value>(opts: { initialValue?: unknown }): Promise<Value> {
          observedInitialValue = opts.initialValue;
          return "research" as Value;
        },
        isCancel(value: unknown) {
          return value === CANCEL;
        },
        outro() {},
      },
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return {
          workflow: { steps: [{ id: "intake" }, { id: "research" }] },
        } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const result = await runEffect(
      { type: "PROMPT_SELECT_STEP", taskId: "tsk_1" },
      makeRuntime(caller),
    );
    expect(observedInitialValue).toBe("research");
    expect(result).toEqual([{ type: "STEP_SELECTED", stepKey: "research" }]);
  });

  it("loads step details with step.get", async () => {
    const caller = makeCallerStub({
      step: {
        get: () => ({
          stepId: "stp_1",
          stepKey: "plan",
          stepIndex: 1,
          status: "waiting",
          parentStepId: null,
          workKey: null,
          sessionId: null,
          opencodeBaseUrl: null,
          waitSpec: { kind: "children", childStepKey: "worker" },
          waitSnapshot: { totalCount: 1, activeCount: 1, completedCount: 0 },
          blockPayload: null,
          orphanedReason: null,
        }),
      },
    });

    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime(caller);
    await expect(
      runEffect(
        { type: "GET_STEP", taskId: "tsk_1", stepId: "stp_1" },
        runtime,
      ),
    ).resolves.toEqual([{ type: "STEP_STATUS_LOADED", status: "waiting" }]);
    expect(runtime.lastStepDetail).toMatchObject({
      status: "waiting",
      waitSnapshot: { totalCount: 1 },
    });
  });

  it("executes active child steps for a waiting children wait spec", async () => {
    const executed: string[] = [];
    const lines: string[] = [];
    let getCount = 0;
    const caller = makeCallerStub({
      step: {
        get: () => {
          getCount += 1;
          return {
            stepId: "stp_root",
            stepKey: "controller",
            stepIndex: 1,
            status: getCount === 1 ? "waiting" : "active",
            parentStepId: null,
            workKey: null,
            sessionId: null,
            opencodeBaseUrl: null,
            waitSpec: {
              kind: "children",
              childStepKey: "worker",
              workKeys: ["alpha"],
            },
            waitSnapshot: {
              totalCount: 1,
              activeCount: getCount === 1 ? 1 : 0,
              completedCount: getCount === 1 ? 0 : 1,
            },
            blockPayload: null,
            orphanedReason: null,
          };
        },
        list: () => [
          {
            stepId: "stp_child_alpha",
            stepKey: "worker",
            stepIndex: 2,
            status: "pending",
            parentStepId: "stp_root",
            workKey: "alpha",
          },
          {
            stepId: "stp_child_beta",
            stepKey: "worker",
            stepIndex: 3,
            status: "pending",
            parentStepId: "stp_root",
            workKey: "beta",
          },
        ],
      },
    });

    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: {
        println(...args: string[]) {
          lines.push(args.join(" "));
        },
        error() {},
      },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep(input) {
        executed.push(input.stepId);
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime(caller);
    await expect(
      runEffect(
        {
          type: "EXECUTE_WAITING_CHILDREN",
          taskId: "tsk_1",
          stepId: "stp_root",
        },
        runtime,
      ),
    ).resolves.toEqual([]);

    expect(executed).toEqual(["stp_child_alpha"]);
    expect(runtime.lastStepDetail).toMatchObject({
      status: "active",
      waitSnapshot: { completedCount: 1 },
    });
    expect(lines).toContain("waiting_on_children: worker work=alpha");
    expect(lines).toContain("child_concurrency: 1");
    expect(lines).toContain(
      'child_progress: {"totalCount":1,"pendingCount":1,"activeCount":0,"blockedCount":0,"orphanedCount":0,"completedCount":0,"failedCount":0,"cancelledCount":0}',
    );
    expect(lines).toContain("pending_children: 1");
    expect(lines).toContain("running_child: [2] worker work=alpha");
    expect(lines).toContain("child_status: [2] completed");
    expect(lines).toContain("parent_status: active");
  });

  it("limits waiting child execution by declared concurrency", async () => {
    const executed: string[] = [];
    let getCallCount = 0;
    const caller = makeCallerStub({
      step: {
        get: () => {
          getCallCount += 1;
          if (getCallCount >= 2) {
            return {
              stepId: "stp_root",
              stepKey: "controller",
              stepIndex: 1,
              status: "active",
              parentStepId: null,
              workKey: null,
              sessionId: null,
              opencodeBaseUrl: null,
              waitSpec: null,
              waitSnapshot: null,
              blockPayload: null,
              orphanedReason: null,
            };
          }
          return {
            stepId: "stp_root",
            stepKey: "controller",
            stepIndex: 1,
            status: "waiting",
            parentStepId: null,
            workKey: null,
            sessionId: null,
            opencodeBaseUrl: null,
            waitSpec: {
              kind: "children",
              childStepKey: "worker",
              concurrency: 2,
            },
            waitSnapshot: { totalCount: 3, pendingCount: 2, activeCount: 1, completedCount: 0 },
            blockPayload: null,
            orphanedReason: null,
          };
        },
        list: () => [
          {
            stepId: "stp_running",
            stepKey: "worker",
            stepIndex: 2,
            status: "active",
            parentStepId: "stp_root",
            workKey: "running",
            sessionId: "ses_running",
          },
          {
            stepId: "stp_child_1",
            stepKey: "worker",
            stepIndex: 3,
            status: "pending",
            parentStepId: "stp_root",
            workKey: "one",
            sessionId: null,
          },
          {
            stepId: "stp_child_2",
            stepKey: "worker",
            stepIndex: 4,
            status: "pending",
            parentStepId: "stp_root",
            workKey: "two",
            sessionId: null,
          },
        ],
      },
    });

    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep(input) {
        executed.push(input.stepId);
        return { status: "active", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    await runEffect(
      { type: "EXECUTE_WAITING_CHILDREN", taskId: "tsk_1", stepId: "stp_root" },
      makeRuntime(caller),
    );

    expect(executed).toEqual(["stp_child_1"]);
  });

  it("refills waiting child execution when slots free up", async () => {
    const executed: string[] = [];
    let getCallCount = 0;
    const caller = makeCallerStub({
      step: {
        get: () => {
          getCallCount += 1;
          if (getCallCount >= 4) {
            return {
              stepId: "stp_root",
              stepKey: "controller",
              stepIndex: 1,
              status: "active",
              parentStepId: null,
              workKey: null,
              sessionId: null,
              opencodeBaseUrl: null,
              waitSpec: null,
              waitSnapshot: null,
              blockPayload: null,
              orphanedReason: null,
            };
          }

          return {
            stepId: "stp_root",
            stepKey: "controller",
            stepIndex: 1,
            status: "waiting",
            parentStepId: null,
            workKey: null,
            sessionId: null,
            opencodeBaseUrl: null,
            waitSpec: {
              kind: "children",
              childStepKey: "worker",
              concurrency: 1,
            },
            waitSnapshot:
              getCallCount === 1
                ? { totalCount: 2, pendingCount: 1, activeCount: 1, completedCount: 0 }
                : { totalCount: 2, pendingCount: 1, activeCount: 0, completedCount: 1 },
            blockPayload: null,
            orphanedReason: null,
          };
        },
        list: () =>
          getCallCount <= 1
            ? [
                {
                  stepId: "stp_running",
                  stepKey: "worker",
                  stepIndex: 2,
                  status: "active",
                  parentStepId: "stp_root",
                  workKey: "running",
                  sessionId: "ses_running",
                },
                {
                  stepId: "stp_child_1",
                  stepKey: "worker",
                  stepIndex: 3,
                  status: "pending",
                  parentStepId: "stp_root",
                  workKey: "one",
                  sessionId: null,
                },
              ]
            : [
                {
                  stepId: "stp_child_2",
                  stepKey: "worker",
                  stepIndex: 4,
                  status: "pending",
                  parentStepId: "stp_root",
                  workKey: "two",
                  sessionId: null,
                },
              ],
      },
    });

    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep(input) {
        executed.push(input.stepId);
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    await runEffect(
      { type: "EXECUTE_WAITING_CHILDREN", taskId: "tsk_1", stepId: "stp_root" },
      makeRuntime(caller),
    );

    expect(executed).toEqual(["stp_child_2"]);
  });

  it("returns a controlled failure when waiting child execution throws", async () => {
    const caller = makeCallerStub({
      step: {
        get: () => ({
          stepId: "stp_root",
          stepKey: "controller",
          stepIndex: 1,
          status: "waiting",
          parentStepId: null,
          workKey: null,
          sessionId: null,
          opencodeBaseUrl: null,
          waitSpec: { kind: "children", childStepKey: "worker" },
          waitSnapshot: { totalCount: 1, activeCount: 0, completedCount: 0 },
          blockPayload: null,
          orphanedReason: null,
        }),
        list: () => [
          {
            stepId: "stp_child_1",
            stepKey: "worker",
            stepIndex: 2,
            status: "pending",
            parentStepId: "stp_root",
            workKey: "one",
            sessionId: null,
          },
        ],
      },
    });

    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        throw new Error("child setup failed");
      },
      async attachOpencodeTui() {},
    });

    await expect(
      runEffect(
        {
          type: "EXECUTE_WAITING_CHILDREN",
          taskId: "tsk_1",
          stepId: "stp_root",
        },
        makeRuntime(caller),
      ),
    ).resolves.toEqual([
      { type: "STEP_ACTION_FAILED", message: "child setup failed" },
    ]);
  });

  it("prints status with step index/name/status", async () => {
    const lines: string[] = [];
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
        fail: () => ({
          taskId: "tsk_1",
          stepId: "stp_unused",
          status: "failed" as const,
        }),
        cancel: () => ({
          taskId: "tsk_1",
          stepId: "stp_unused",
          status: "cancelled" as const,
        }),
      },
    });

    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: {
        println(...args: string[]) {
          lines.push(args.join(" "));
        },
        error() {},
      },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime(caller);
    runtime.sharedCtx = {
      ...(runtime.sharedCtx as NonNullable<typeof runtime.sharedCtx>),
      activeTaskId: "tsk_1",
      activeStepId: "stp_2",
    };
    await runEffect({ type: "PRINT_STATUS" }, runtime);

    expect(lines).toContain("steps:");
    expect(lines).toContain("  [1] intake status=completed");
    expect(lines).toContain("  [2] plan status=active");
  });

  it("prints failed step reason/details when present", async () => {
    const lines: string[] = [];
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: {
        println(...args: string[]) {
          lines.push(args.join(" "));
        },
        error() {},
      },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return {
          status: "failed" as const,
          suggestedNextStepKey: null,
          failure: {
            reason: "validation failed",
            details: { code: "E_VALIDATION" },
          },
        };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime();
    await runEffect(
      { type: "EXECUTE_STEP", taskId: "tsk_1", stepId: "stp_1" },
      runtime,
    );
    await runEffect({ type: "PRINT_STEP_RESULT" }, runtime);

    expect(lines).toContain("step_status: failed");
    expect(lines).toContain("failure_reason: validation failed");
    expect(lines).toContain('failure_details: {"code":"E_VALIDATION"}');
  });

  it("prints waiting step details", async () => {
    const lines: string[] = [];
    const caller = makeCallerStub({
      step: {
        get: () => ({
          stepId: "stp_1",
          stepKey: "plan",
          stepIndex: 1,
          status: "waiting",
          parentStepId: null,
          workKey: null,
          sessionId: null,
          opencodeBaseUrl: null,
          waitSpec: { kind: "children", childStepKey: "worker" },
          waitSnapshot: { totalCount: 1, activeCount: 1, completedCount: 0 },
          blockPayload: null,
          orphanedReason: null,
        }),
      },
    });
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: {
        println(...args: string[]) {
          lines.push(args.join(" "));
        },
        error() {},
      },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime(caller);
    await runEffect(
      { type: "GET_STEP", taskId: "tsk_1", stepId: "stp_1" },
      runtime,
    );
    await runEffect({ type: "PRINT_STEP_DETAILS" }, runtime);

    expect(lines).toContain("step_detail_status: waiting");
    expect(lines).toContain("waiting_for: worker");
    expect(lines).toContain(
      'wait_snapshot: {"totalCount":1,"activeCount":1,"completedCount":0}',
    );
  });

  it("offers blocked step attach from persisted step detail", async () => {
    let labels: string[] = [];
    const runEffect = createEffectRunner({
      prompts: {
        async select<Value>(opts: any): Promise<Value> {
          labels = opts.options.map(
            (option: { label?: string }) => option.label ?? "",
          );
          return "attach" as Value;
        },
        isCancel(value: unknown) {
          return value === CANCEL;
        },
        outro() {},
      },
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime();
    runtime.lastStepDetail = {
      stepId: "stp_1",
      stepKey: "plan",
      stepIndex: 1,
      status: "blocked",
      parentStepId: null,
      workKey: null,
      sessionId: "ses_1",
      opencodeBaseUrl: "http://127.0.0.1:1234",
      waitSpec: null,
      waitSnapshot: null,
      blockPayload: { code: "needs_input" },
      orphanedReason: null,
    };

    const result = await runEffect(
      { type: "PROMPT_STEP_ACTIONS", rootStepStatus: "blocked" },
      runtime,
    );
    expect(labels).toContain("Attach to existing session");
    expect(result).toEqual([
      {
        type: "STEP_ACTION_ATTACH",
        baseUrl: "http://127.0.0.1:1234",
        sessionId: "ses_1",
      },
    ]);
  });

  it("offers and selects attachable child OpenCode sessions for waiting steps", async () => {
    const labels: string[] = [];
    const selections = ["attach_child", "stp_child_1"];
    const caller = makeCallerStub({
      step: {
        list: () => [
          {
            stepId: "stp_child_1",
            stepKey: "worker",
            stepIndex: 2,
            status: "active",
            parentStepId: "stp_1",
            workKey: "alpha",
            sessionId: "ses_child",
          },
          {
            stepId: "stp_child_2",
            stepKey: "worker",
            stepIndex: 3,
            status: "pending",
            parentStepId: "stp_1",
            workKey: "beta",
            sessionId: null,
          },
        ],
        get: ({ stepId }: { stepId: string }) => ({
          stepId,
          stepKey: stepId === "stp_child_1" ? "worker" : "controller",
          stepIndex: stepId === "stp_child_1" ? 2 : 1,
          status: stepId === "stp_child_1" ? "active" : "waiting",
          parentStepId: stepId === "stp_child_1" ? "stp_1" : null,
          workKey: stepId === "stp_child_1" ? "alpha" : null,
          sessionId: stepId === "stp_child_1" ? "ses_child" : null,
          opencodeBaseUrl:
            stepId === "stp_child_1" ? "http://127.0.0.1:4321" : null,
          waitSpec: null,
          waitSnapshot: null,
          blockPayload: null,
          orphanedReason: null,
        }),
      },
    });
    const runEffect = createEffectRunner({
      prompts: {
        async select<Value>(opts: any): Promise<Value> {
          labels.push(
            ...opts.options.map(
              (option: { label?: string }) => option.label ?? "",
            ),
          );
          return selections.shift() as Value;
        },
        isCancel(value: unknown) {
          return value === CANCEL;
        },
        outro() {},
      },
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime(caller);
    runtime.sharedCtx = {
      ...(runtime.sharedCtx as NonNullable<typeof runtime.sharedCtx>),
      activeTaskId: "tsk_1",
      activeStepId: "stp_1",
    };
    runtime.lastStepDetail = {
      stepId: "stp_1",
      stepKey: "controller",
      stepIndex: 1,
      status: "waiting",
      parentStepId: null,
      workKey: null,
      sessionId: null,
      opencodeBaseUrl: null,
      waitSpec: {
        kind: "children",
        childStepKey: "worker",
        workKeys: ["alpha"],
      },
      waitSnapshot: { totalCount: 1, activeCount: 1, completedCount: 0 },
      blockPayload: null,
      orphanedReason: null,
    };

    const result = await runEffect(
      { type: "PROMPT_STEP_ACTIONS", rootStepStatus: "waiting" },
      runtime,
    );

    expect(labels).toContain("Attach to child session");
    expect(labels).toContain("[2] worker work=alpha status=active");
    expect(result).toEqual([
      {
        type: "STEP_ACTION_ATTACH",
        baseUrl: "http://127.0.0.1:4321",
        sessionId: "ses_child",
      },
    ]);
  });

  it("prints child steps scoped to the current waiting controller", async () => {
    const lines: string[] = [];
    const caller = makeCallerStub({
      step: {
        list: () => [
          {
            stepId: "stp_child_1",
            stepKey: "worker",
            stepIndex: 2,
            status: "active",
            parentStepId: "stp_1",
            workKey: "alpha",
          },
          {
            stepId: "stp_child_2",
            stepKey: "worker",
            stepIndex: 3,
            status: "completed",
            parentStepId: "stp_1",
            workKey: "beta",
          },
          {
            stepId: "stp_other",
            stepKey: "worker",
            stepIndex: 4,
            status: "active",
            parentStepId: "other_parent",
            workKey: "gamma",
          },
        ],
      },
    });
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: {
        println(...args: string[]) {
          lines.push(args.join(" "));
        },
        error() {},
      },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    const runtime = makeRuntime(caller);
    runtime.sharedCtx = {
      ...(runtime.sharedCtx as NonNullable<typeof runtime.sharedCtx>),
      activeTaskId: "tsk_1",
      activeStepId: "stp_1",
    };
    runtime.lastStepDetail = {
      stepId: "stp_1",
      stepKey: "controller",
      stepIndex: 1,
      status: "waiting",
      parentStepId: null,
      workKey: null,
      sessionId: null,
      opencodeBaseUrl: null,
      waitSpec: {
        kind: "children",
        childStepKey: "worker",
        workKeys: ["alpha"],
      },
      waitSnapshot: { totalCount: 1, activeCount: 1, completedCount: 0 },
      blockPayload: null,
      orphanedReason: null,
    };

    await runEffect({ type: "PRINT_CHILD_STEPS" }, runtime);

    expect(lines).toContain("child_steps:");
    expect(lines).toContain("  [2] worker work=alpha status=active session=none");
    expect(lines).not.toContain("  [3] worker work=beta status=completed");
    expect(lines).not.toContain("  [4] worker work=gamma status=active");
  });

  it("resumes blocked steps through the new RPC", async () => {
    const caller = makeCallerStub({
      step: {
        resumeBlocked: async () => ({
          status: "orphaned" as const,
          taskId: "tsk_1",
          stepId: "stp_1",
        }),
      },
    });
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    await expect(
      runEffect(
        { type: "RESUME_BLOCKED_STEP", taskId: "tsk_1", stepId: "stp_1" },
        makeRuntime(caller),
      ),
    ).resolves.toEqual([{ type: "STEP_RESUME_OK", status: "orphaned" }]);
  });

  it("retries orphaned steps in a new session", async () => {
    const caller = makeCallerStub({
      step: {
        retryOrphanedInNewSession: () => ({
          status: "active" as const,
          taskId: "tsk_1",
          stepId: "stp_1",
        }),
      },
    });
    const runEffect = createEffectRunner({
      prompts: makePrompts("unused"),
      ui: { println() {}, error() {} },
      async ensureLinkedProject() {
        return {
          projectId: "prj_test",
          projectRoot: "/tmp/project",
          opsRoot: "/tmp/ops",
        };
      },
      readOpsConfig,
      async loadWorkflowForTask() {
        return { workflow: { steps: [] } } as never;
      },
      async collectStepInputs() {
        return {};
      },
      async executeStep() {
        return { status: "completed", suggestedNextStepKey: null };
      },
      async attachOpencodeTui() {},
    });

    await expect(
      runEffect(
        { type: "RETRY_ORPHANED_STEP", taskId: "tsk_1", stepId: "stp_1" },
        makeRuntime(caller),
      ),
    ).resolves.toEqual([{ type: "STEP_RETRY_OK" }]);
  });
});
