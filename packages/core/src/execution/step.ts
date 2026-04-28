import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createOpencodeClient,
  createOpencodeServer,
  type Config,
} from "@opencode-ai/sdk/v2";
import { and, eq } from "drizzle-orm";
import { db, projectTable, stepTable, taskTable, type DbExecutor } from "../db";
import { TaskEventType, writeTaskEvent } from "../event/task-event";
import { composeOpenCodeKickoffPrompt } from "./opencode-framework-prompt";
import { staticSonataBridgePluginUrl } from "../opencode";
import { ErrorCode, RpcError } from "../rpc/base";
import {
  completeStepWithGuards,
  createStepContextBase,
  failStep,
  hydrateStepInputs,
  parseStepInputsSnapshot,
  setStepSession,
} from "../step";
import { resolveCustomToolNameMap } from "../step/get-toolset";
import {
  enterWaitingIfNeeded,
  wakeWaitingParentIfReady,
} from "../step/waiting";
import { loadWorkflowForTask } from "../workflow";
import type {
  StepContextWithOpenCode,
  StepRunResult,
  OpenCodeConfig,
  OpenCodeSessionJoinPolicy,
  WorkflowStepWithOpenCode,
} from "../workflow/module";

export type ExecuteStepInput = {
  taskId: string;
  stepId: string;
};

export type ExecuteStepResult = {
  status: "active" | "waiting" | "completed" | "blocked" | "failed";
  suggestedNextStepKey: string | null;
  failure?: {
    reason: string;
    details?: unknown;
  };
  opencode?: {
    baseUrl: string;
    sessionId: string;
    reused: boolean;
    join: OpenCodeSessionJoinPolicy;
    close?: () => void;
  };
};

export type CompleteStepInRuntimeInput = {
  taskId: string;
  stepId: string;
  completionPayload?: unknown;
  sessionId?: string;
  messageId?: string;
  manual?: boolean;
};

export type CompleteStepInRuntimeResult = {
  status: "completed";
  suggestedNextStepKey: string | null;
};

function activatePendingStepForExecution(input: {
  taskId: string;
  step: typeof stepTable.$inferSelect;
  executor: DbExecutor;
}) {
  if (input.step.status !== "pending") {
    return input.step;
  }

  const now = Date.now();
  const activation = input.executor
    .update(stepTable)
    .set({ status: "active", startedAt: now })
    .where(
      and(
        eq(stepTable.stepId, input.step.stepId),
        eq(stepTable.status, "pending"),
      ),
    )
    .run() as { changes: number };

  if (activation.changes !== 1) {
    const current = input.executor
      .select()
      .from(stepTable)
      .where(eq(stepTable.stepId, input.step.stepId))
      .get();
    throw new Error(
      `Step ${input.step.stepId} was already claimed for execution${current ? ` (status=${current.status})` : ""}`,
    );
  }

  input.executor
    .update(taskTable)
    .set({ updatedAt: now })
    .where(eq(taskTable.taskId, input.taskId))
    .run();

  writeTaskEvent({
    executor: input.executor,
    taskId: input.taskId,
    stepId: input.step.stepId,
    eventType: TaskEventType.STEP_STARTED,
    payload: {
      stepId: input.step.stepId,
      stepKey: input.step.stepKey,
      stepIndex: input.step.stepIndex,
      inputs: parseStepInputsSnapshot({
        taskId: input.taskId,
        stepId: input.step.stepId,
        value: input.step.inputs,
      }),
    },
    createdAt: now,
  });

  return { ...input.step, status: "active" as const, startedAt: now };
}

type ActiveOpenCodeSession = {
  baseUrl: string;
  sessionId: string;
  reused: boolean;
  join: OpenCodeSessionJoinPolicy;
  close?: () => void;
};

const REQUIRED_SONATA_TOOL_ID = "sonata_complete_step";
const SKIP_OPENCODE_PROMPT_ENV = "SONATA_SKIP_OPENCODE_PROMPT_ASYNC";

function isOpenCodeStep(step: unknown): step is WorkflowStepWithOpenCode {
  return typeof step === "object" && step !== null && "opencode" in step;
}

function openCodeJoinPolicy(config: OpenCodeConfig): OpenCodeSessionJoinPolicy {
  return config.session?.join ?? "auto";
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return "Step execution failed";
}

function isStepRunResult(value: unknown): value is StepRunResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const status = (value as { status?: unknown }).status;
  return status === "completed" || status === "failed";
}

function failureReasonFromStep(step: {
  completionPayloadJson: string | null;
}): string | undefined {
  if (!step.completionPayloadJson) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(step.completionPayloadJson) as {
      reason?: unknown;
    };
    if (typeof parsed.reason === "string" && parsed.reason.trim().length > 0) {
      return parsed.reason;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(new Error("Could not allocate an ephemeral port")),
        );
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function canReuseExistingSession(input: {
  projectRoot: string;
  baseUrl: string;
  sessionId: string;
}): Promise<boolean> {
  try {
    const client = createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.projectRoot,
    });
    await client.session.messages(
      { sessionID: input.sessionId },
      { throwOnError: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function withTemporaryEnv<T>(
  vars: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

function stripJsonComments(input: string): string {
  return input.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

async function loadOpencodeUserConfig(): Promise<Config | undefined> {
  const home = process.env.HOME;
  if (!home) return undefined;

  const candidates = [
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    path.join(home, ".config", "opencode", "opencode.json"),
  ];

  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (!(await file.exists())) continue;
    const raw = await readFile(candidate, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw)) as Config;
    return parsed;
  }

  return undefined;
}

function assertValidOpenCodeModel(model: string): void {
  const [provider, modelId, ...extra] = model.split("/");
  if (!provider || !modelId || extra.length > 0) {
    throw new Error(
      `OpenCode model must use provider/model format, received: ${model}`,
    );
  }
}

async function buildOpencodeConfig(input: {
  pluginUrl: string;
  stepConfig: OpenCodeConfig;
}): Promise<Config> {
  assertValidOpenCodeModel(input.stepConfig.model);
  const userConfig = await loadOpencodeUserConfig();
  const userPlugins = Array.isArray(userConfig?.plugin)
    ? userConfig.plugin
    : [];
  const userAgent =
    userConfig?.agent && typeof userConfig.agent === "object"
      ? userConfig.agent
      : {};
  const userBuildAgent =
    userAgent.build && typeof userAgent.build === "object"
      ? userAgent.build
      : {};
  const userBuildAgentConfig = userBuildAgent as {
    options?: Config["agent"] extends Record<string, infer TAgent> ? TAgent extends { options?: infer TOptions } ? TOptions : never : never;
    permission?: Config["agent"] extends Record<string, infer TAgent> ? TAgent extends { permission?: infer TPermission } ? TPermission : never : never;
  };
  return {
    ...userConfig,
    model: input.stepConfig.model,
    provider: {
      ...userConfig?.provider,
      ...input.stepConfig.provider,
    },
    agent: {
      ...userAgent,
      build: {
        ...userBuildAgent,
        model: input.stepConfig.model,
        variant: input.stepConfig.agent.variant,
        temperature: input.stepConfig.agent.temperature,
        top_p: input.stepConfig.agent.top_p,
        permission: Object.assign({}, userBuildAgentConfig.permission, input.stepConfig.agent.permission),
        options: Object.assign({}, userBuildAgentConfig.options, input.stepConfig.agent.options),
      },
    },
    plugin: [...new Set([...userPlugins, input.pluginUrl])],
  };
}

export async function executeStep(
  input: ExecuteStepInput,
  executor: DbExecutor = db(),
): Promise<ExecuteStepResult> {
  const task = executor
    .select()
    .from(taskTable)
    .where(eq(taskTable.taskId, input.taskId))
    .get();
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }
  const storedStep = executor
    .select()
    .from(stepTable)
    .where(eq(stepTable.stepId, input.stepId))
    .get();
  if (!storedStep || storedStep.taskId !== input.taskId) {
    throw new Error(`Step not found: ${input.stepId}`);
  }
  const step = activatePendingStepForExecution({
    taskId: input.taskId,
    step: storedStep,
    executor,
  });
  const project = executor
    .select()
    .from(projectTable)
    .where(eq(projectTable.projectId, task.projectId))
    .get();
  if (!project) {
    throw new Error(`Project not found: ${task.projectId}`);
  }

  const loaded = await loadWorkflowForTask(input.taskId, executor);
  const workflowStep = loaded.workflow.steps.find(
    (candidate) => candidate.id === step.stepKey,
  );
  if (!workflowStep) {
    throw new Error(
      `Workflow step not found in ${loaded.workflow.id}: ${step.stepKey}`,
    );
  }

  const snapshot = parseStepInputsSnapshot({
    taskId: input.taskId,
    stepId: input.stepId,
    value: step.inputs,
  });

  const inputs = await hydrateStepInputs({
    taskId: input.taskId,
    stepId: input.stepId,
    opsRoot: project.opsRootRealpath,
    workflowSteps: loaded.workflow.steps,
    snapshot,
  });

  const baseCtx = createStepContextBase({
    taskId: input.taskId,
    stepId: input.stepId,
    projectRoot: project.projectRootRealpath,
    opsRoot: project.opsRootRealpath,
    inputs,
    executor,
  });

  let activeSession: ActiveOpenCodeSession | undefined;
  const resolvedOpenCodeTools = isOpenCodeStep(workflowStep)
    ? resolveCustomToolNameMap({
        stepKey: step.stepKey,
        tools: workflowStep.opencode.tools,
      })
    : undefined;

  const ctx = isOpenCodeStep(workflowStep)
    ? ({
        ...baseCtx,
        opencode: {
          tools: resolvedOpenCodeTools ?? {},
          start: async (params: { title?: string; prompt: string }) => {
            const current = executor
              .select()
              .from(stepTable)
              .where(eq(stepTable.stepId, input.stepId))
              .get();
            if (current?.sessionId && current.opencodeBaseUrl) {
              const reusable = await canReuseExistingSession({
                projectRoot: project.projectRootRealpath,
                baseUrl: current.opencodeBaseUrl,
                sessionId: current.sessionId,
              });
              if (reusable) {
                activeSession = {
                  baseUrl: current.opencodeBaseUrl,
                  sessionId: current.sessionId,
                  reused: true,
                  join: openCodeJoinPolicy(workflowStep.opencode),
                };
                try {
                  await ctxRef!.log.info("opencode session reused", {
                    baseUrl: current.opencodeBaseUrl,
                    sessionId: current.sessionId,
                    title: params.title ?? `Sonata ${workflowStep.title}`,
                  });
                } catch {
                  // Workflow logs should not prevent session reuse.
                }
                await (workflowStep as WorkflowStepWithOpenCode).on(
                  ctxRef! as never,
                  {
                    type: "opencode.started",
                    sessionId: current.sessionId,
                    reused: true,
                  } as never,
                );
                return;
              }
            }

            const pluginUrl = staticSonataBridgePluginUrl();
            const opencodeConfig = await buildOpencodeConfig({
              pluginUrl,
              stepConfig: workflowStep.opencode,
            });
            const opencodeEnv = {
              SONATA_TASK_ID: input.taskId,
              SONATA_STEP_ID: input.stepId,
              SONATA_PROJECT_ROOT: project.projectRootRealpath,
              SONATA_OPS_ROOT: project.opsRootRealpath,
            };

            const port = await allocatePort();
            const server = await withTemporaryEnv(opencodeEnv, async () => {
              return createOpencodeServer({
                hostname: "127.0.0.1",
                port,
                timeout: 15_000,
                config: opencodeConfig,
              });
            });
            const client = createOpencodeClient({
              baseUrl: server.url,
              directory: project.projectRootRealpath,
            });
            const created = await client.session.create(
              { title: params.title ?? `Sonata ${workflowStep.title}` },
              { throwOnError: true },
            );
            const sessionId = created.data.id;

            const toolIdsResult = await client.tool.ids(
              {},
              { throwOnError: true },
            );
            const toolIds = toolIdsResult.data;
            if (!toolIds.includes(REQUIRED_SONATA_TOOL_ID)) {
              throw new Error(
                `OpenCode session missing required Sonata bridge tool ${REQUIRED_SONATA_TOOL_ID} for task=${input.taskId} step=${input.stepId}. Available tools: ${toolIds.join(", ")}`,
              );
            }

            const prompt = composeOpenCodeKickoffPrompt({
              prompt: params.prompt,
              artifacts: workflowStep.artifacts,
              contract:
                workflowStep.opencode.prompt?.contract ??
                (step.parentStepId === null ? "standard" : "compact"),
            });

            if (process.env[SKIP_OPENCODE_PROMPT_ENV] !== "1") {
              await client.session.promptAsync(
                {
                  sessionID: sessionId,
                  parts: [{ type: "text", text: prompt }],
                },
                { throwOnError: true },
              );
            }

            setStepSession(
              {
                taskId: input.taskId,
                stepId: input.stepId,
                sessionId,
                baseUrl: server.url,
              },
              executor,
            );

            activeSession = {
              baseUrl: server.url,
              sessionId,
              reused: false,
              join: openCodeJoinPolicy(workflowStep.opencode),
              close: server.close,
            };
            try {
              await ctxRef!.log.info("opencode session started", {
                baseUrl: server.url,
                sessionId,
                title: params.title ?? `Sonata ${workflowStep.title}`,
              });
            } catch {
              // Workflow logs should not prevent session startup.
            }
            await (workflowStep as WorkflowStepWithOpenCode).on(
              ctxRef! as never,
              {
                type: "opencode.started",
                sessionId,
                reused: false,
              } as never,
            );
          },
        },
      } satisfies StepContextWithOpenCode)
    : baseCtx;

  const ctxRef = isOpenCodeStep(workflowStep)
    ? (ctx as StepContextWithOpenCode)
    : null;

  await workflowStep.on(ctx as never, { type: "step.started" } as never);

  try {
    const runResult = await workflowStep.run(ctx as never);

    if (isStepRunResult(runResult)) {
      if (runResult.status === "completed") {
        const completion = await completeStepWithGuards(
          {
            taskId: input.taskId,
            stepId: input.stepId,
            completionPayload: runResult.completionPayload,
          },
          executor,
        );
        wakeWaitingParentIfReady({
          taskId: input.taskId,
          stepId: input.stepId,
          executor,
        });
        await completion.workflowStep.on(
          completion.ctx as never,
          { type: "step.completed" } as never,
        );
        return {
          status: "completed",
          suggestedNextStepKey: completion.suggestedNextStepKey,
          opencode: activeSession,
        };
      }

      failStep(
        {
          taskId: input.taskId,
          stepId: input.stepId,
          reason: runResult.reason,
        },
        executor,
      );
      await workflowStep.on(
        ctx as never,
        { type: "step.failed", error: new Error(runResult.reason) } as never,
      );
      return {
        status: "failed",
        suggestedNextStepKey: null,
        failure: {
          reason: runResult.reason,
          details: runResult.details,
        },
        opencode: activeSession,
      };
    }

    const currentStep = executor
      .select()
      .from(stepTable)
      .where(eq(stepTable.stepId, input.stepId))
      .get();
    if (currentStep?.status === "active" && workflowStep.waitFor) {
      if (currentStep.parentStepId !== null) {
        throw new RpcError(
          ErrorCode.INVALID_INPUT,
          409,
          `Only root steps may wait for persisted conditions: ${input.stepId}`,
        );
      }

      const waitSpec = await workflowStep.waitFor(ctx as never);
      if (waitSpec) {
        const enteredWaiting = enterWaitingIfNeeded({
          taskId: input.taskId,
          stepId: input.stepId,
          stepIndex: currentStep.stepIndex,
          waitSpec,
          executor,
        });
        if (enteredWaiting) {
          return {
            status: "waiting",
            suggestedNextStepKey: null,
            opencode: activeSession,
          };
        }
      }
    }
  } catch (error) {
    if (
      error instanceof RpcError &&
      (error.code === ErrorCode.REQUIRED_ARTIFACT_MISSING ||
        error.code === ErrorCode.STEP_COMPLETION_GUARD_REJECTED)
    ) {
      return {
        status: "active",
        suggestedNextStepKey: null,
        opencode: activeSession,
      };
    }

    const reason = safeErrorMessage(error);
    try {
      failStep(
        {
          taskId: input.taskId,
          stepId: input.stepId,
          reason,
        },
        executor,
      );
    } catch (failError) {
      if (
        !(failError instanceof RpcError) ||
        failError.code !== ErrorCode.INVALID_STEP_TRANSITION
      ) {
        throw failError;
      }
    }
    const wrapped = new Error(reason);
    await workflowStep.on(
      ctx as never,
      { type: "step.failed", error: wrapped } as never,
    );
    return {
      status: "failed",
      suggestedNextStepKey: null,
      failure: { reason },
      opencode: activeSession,
    };
  }

  const updated = executor
    .select()
    .from(stepTable)
    .where(eq(stepTable.stepId, input.stepId))
    .get();
  if (updated?.status === "completed") {
    await workflowStep.on(ctx as never, { type: "step.completed" } as never);
    return {
      status: "completed",
      suggestedNextStepKey:
        updated.parentStepId === null ? (workflowStep.next ?? null) : null,
      opencode: activeSession,
    };
  }

  if (updated?.status === "failed") {
    const reason = failureReasonFromStep(updated) ?? "Step failed";
    await workflowStep.on(
      ctx as never,
      { type: "step.failed", error: new Error(reason) } as never,
    );
    return {
      status: "failed",
      suggestedNextStepKey: null,
      failure: { reason },
      opencode: activeSession,
    };
  }

  if (updated?.status === "blocked") {
    await workflowStep.on(ctx as never, { type: "step.blocked" } as never);
    return {
      status: "blocked",
      suggestedNextStepKey: null,
      opencode: activeSession,
    };
  }

  if (updated?.status === "waiting") {
    return {
      status: "waiting",
      suggestedNextStepKey: null,
      opencode: activeSession,
    };
  }

  return {
    status: "active",
    suggestedNextStepKey: null,
    opencode: activeSession,
  };
}

export async function completeStepInRuntime(
  input: CompleteStepInRuntimeInput,
  executor: DbExecutor = db(),
): Promise<CompleteStepInRuntimeResult> {
  const task = executor
    .select()
    .from(taskTable)
    .where(eq(taskTable.taskId, input.taskId))
    .get();
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }
  const step = executor
    .select()
    .from(stepTable)
    .where(eq(stepTable.stepId, input.stepId))
    .get();
  if (!step || step.taskId !== input.taskId) {
    throw new Error(`Step not found: ${input.stepId}`);
  }
  const project = executor
    .select()
    .from(projectTable)
    .where(eq(projectTable.projectId, task.projectId))
    .get();
  if (!project) {
    throw new Error(`Project not found: ${task.projectId}`);
  }

  const loaded = await loadWorkflowForTask(input.taskId, executor);
  const workflowStep = loaded.workflow.steps.find(
    (candidate) => candidate.id === step.stepKey,
  );
  if (!workflowStep) {
    throw new Error(
      `Workflow step not found in ${loaded.workflow.id}: ${step.stepKey}`,
    );
  }

  const snapshot = parseStepInputsSnapshot({
    taskId: input.taskId,
    stepId: input.stepId,
    value: step.inputs,
  });

  const hydratedInputs = await hydrateStepInputs({
    taskId: input.taskId,
    stepId: input.stepId,
    opsRoot: project.opsRootRealpath,
    workflowSteps: loaded.workflow.steps,
    snapshot,
  });

  const baseCtx = createStepContextBase({
    taskId: input.taskId,
    stepId: input.stepId,
    projectRoot: project.projectRootRealpath,
    opsRoot: project.opsRootRealpath,
    inputs: hydratedInputs,
    executor,
  });

  const resolvedOpenCodeTools = isOpenCodeStep(workflowStep)
    ? resolveCustomToolNameMap({
        stepKey: step.stepKey,
        tools: workflowStep.opencode.tools,
      })
    : undefined;

  const _ctx = isOpenCodeStep(workflowStep)
    ? ({
        ...baseCtx,
        opencode: {
          tools: resolvedOpenCodeTools ?? {},
          start: async () => {
            return;
          },
        },
      } satisfies StepContextWithOpenCode)
    : baseCtx;

  const completion = await completeStepWithGuards(
    {
      taskId: input.taskId,
      stepId: input.stepId,
      completionPayload: input.completionPayload,
      sessionId: input.sessionId,
    },
    executor,
  );
  wakeWaitingParentIfReady({
    taskId: input.taskId,
    stepId: input.stepId,
    executor,
  });

  const completionSessionId = input.sessionId ?? step.sessionId ?? undefined;
  if (isOpenCodeStep(workflowStep) && completionSessionId) {
    await completion.workflowStep.on(
      completion.ctx as never,
      {
        type: "opencode.complete",
        manual: input.manual ?? false,
        sessionId: completionSessionId,
        ...(input.messageId ? { messageId: input.messageId } : {}),
      } as never,
    );
  }

  await completion.workflowStep.on(
    completion.ctx as never,
    { type: "step.completed" } as never,
  );

  return {
    status: "completed",
    suggestedNextStepKey: completion.suggestedNextStepKey,
  };
}
