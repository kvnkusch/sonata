import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startupBridgeRuntime } from "@sonata/core/bridge";
import { artifactTable, closeDb, db } from "@sonata/core/db";
import { executeStep } from "@sonata/core/execution";
import {
  getStep,
  resumeBlockedStep,
  retryOrphanedStepInNewSession,
} from "@sonata/core/step";
import { completeTask } from "@sonata/core/task";
import { clearWorkflowCache } from "@sonata/core/workflow";
import {
  createScenarioSandbox,
  destroyScenarioSandbox,
  parseKey,
  runCli,
  stderrText,
  type ScenarioSandbox,
} from "./harness";

const sandboxes: ScenarioSandbox[] = [];

afterEach(() => {
  clearWorkflowCache();
  closeDb();
  delete process.env.SONATA_DB_PATH;
  for (const sandbox of sandboxes.splice(0)) {
    destroyScenarioSandbox(sandbox);
  }
});

describe("aurelia beacon recovery e2e", () => {
  it("blocks, becomes orphaned, retries in a fresh session, and completes", async () => {
    const sandbox = createScenarioSandbox("aurelia-beacon-recovery");
    sandboxes.push(sandbox);

    const link = runCli(
      [
        "project",
        "link",
        sandbox.opsRoot,
        "--project-root",
        sandbox.projectRoot,
        "--project-id",
        "prj_aurelia",
      ],
      sandbox.env,
    );
    expect(link.exitCode).toBe(0);

    const startedTask = runCli(
      ["task", "start", "default", "--project-id", "prj_aurelia"],
      sandbox.env,
    );
    expect(startedTask.exitCode).toBe(0);
    const taskId = parseKey(stderrText(startedTask), "task_id");

    const startedStep = runCli(
      ["step", "start", "stabilize_beacon", "--task-id", taskId],
      sandbox.env,
    );
    expect(startedStep.exitCode).toBe(0);
    const stepId = parseKey(stderrText(startedStep), "step_id");

    const firstRun = await executeStep({ taskId, stepId });
    const firstSessionId = firstRun.opencode?.sessionId ?? null;
    expect(firstRun).toMatchObject({
      status: "active",
      opencode: {
        sessionId: expect.any(String),
        baseUrl: expect.any(String),
      },
    });
    expect(firstSessionId).not.toBeNull();

    const runtime = await startupBridgeRuntime({
      env: {
        SONATA_TASK_ID: taskId,
        SONATA_STEP_ID: stepId,
        SONATA_PROJECT_ROOT: sandbox.projectRoot,
        SONATA_OPS_ROOT: sandbox.opsRoot,
      },
    });

    const blockTool = runtime.tools.find(
      (tool) => tool.name === "sonata_block_step",
    );
    const writeTool = runtime.tools.find(
      (tool) => tool.name === "sonata_write_repair_manifest_artifact_markdown",
    );
    const completeTool = runtime.tools.find(
      (tool) => tool.name === "sonata_complete_step",
    );

    expect(blockTool).toBeDefined();
    expect(writeTool).toBeDefined();
    expect(completeTool).toBeDefined();

    const blocked = await blockTool!.invoke(
      {
        code: "operator_alignment_required",
        message: "The beacon needs a live operator to align the lens stack.",
        details: { station: "Aurelia", lens: "north-array" },
        resumeHint: "Reconnect to the session after the operator returns.",
      },
      { sessionId: firstSessionId! },
    );
    expect(blocked).toMatchObject({
      status: "blocked",
      sessionId: firstSessionId!,
    });
    expect(getStep({ taskId, stepId })).toMatchObject({
      status: "blocked",
      blockPayload: {
        code: "operator_alignment_required",
        message: "The beacon needs a live operator to align the lens stack.",
        details: { station: "Aurelia", lens: "north-array" },
        resumeHint: "Reconnect to the session after the operator returns.",
      },
    });

    const listedBlocked = runCli(
      ["task", "list", "--project-id", "prj_aurelia"],
      sandbox.env,
    );
    expect(stderrText(listedBlocked)).toContain("root_step_status=blocked");

    await firstRun.opencode?.close?.();

    const orphaned = await resumeBlockedStep({ taskId, stepId });
    expect(orphaned).toMatchObject({
      taskId,
      stepId,
      status: "orphaned",
      orphanedReason: {
        code: "missing_session",
        message: `OpenCode session for blocked step ${stepId} is unavailable`,
      },
    });
    expect(getStep({ taskId, stepId })).toMatchObject({
      status: "orphaned",
      orphanedReason: {
        code: "missing_session",
        message: `OpenCode session for blocked step ${stepId} is unavailable`,
        details: {
          sessionId: firstSessionId,
          opencodeBaseUrl: expect.any(String),
        },
      },
    });

    const listedOrphaned = runCli(
      ["task", "list", "--project-id", "prj_aurelia"],
      sandbox.env,
    );
    expect(stderrText(listedOrphaned)).toContain("root_step_status=orphaned");

    const retried = retryOrphanedStepInNewSession({ taskId, stepId });
    expect(retried).toEqual({ taskId, stepId, status: "active" });
    expect(getStep({ taskId, stepId })).toMatchObject({
      status: "active",
      sessionId: null,
      opencodeBaseUrl: null,
      orphanedReason: null,
      blockPayload: {
        code: "operator_alignment_required",
      },
    });

    const listedRetried = runCli(
      ["task", "list", "--project-id", "prj_aurelia"],
      sandbox.env,
    );
    expect(stderrText(listedRetried)).toContain("root_step_status=active");

    const secondRun = await executeStep({ taskId, stepId });
    const secondSessionId = secondRun.opencode?.sessionId ?? null;
    expect(secondRun).toMatchObject({
      status: "active",
      opencode: {
        sessionId: expect.any(String),
        baseUrl: expect.any(String),
      },
    });
    expect(secondSessionId).not.toBeNull();
    expect(secondSessionId).not.toBe(firstSessionId);

    const resumedRuntime = await startupBridgeRuntime({
      env: {
        SONATA_TASK_ID: taskId,
        SONATA_STEP_ID: stepId,
        SONATA_PROJECT_ROOT: sandbox.projectRoot,
        SONATA_OPS_ROOT: sandbox.opsRoot,
      },
    });

    const resumedWriteTool = resumedRuntime.tools.find(
      (tool) => tool.name === "sonata_write_repair_manifest_artifact_markdown",
    );
    const resumedCompleteTool = resumedRuntime.tools.find(
      (tool) => tool.name === "sonata_complete_step",
    );

    expect(resumedWriteTool).toBeDefined();
    expect(resumedCompleteTool).toBeDefined();

    await resumedWriteTool!.invoke(
      {
        markdown: [
          "# Repair Manifest",
          "",
          "Aurelia beacon lens stack realigned.",
          "Operator handoff verified after session recovery.",
        ].join("\n"),
      },
      { sessionId: secondSessionId! },
    );

    const completed = await resumedCompleteTool!.invoke(
      {},
      { sessionId: secondSessionId! },
    );
    expect(completed).toEqual({
      status: "completed",
      suggestedNextStepKey: null,
    });
    expect(getStep({ taskId, stepId }).status).toBe("completed");

    const manifestArtifact = db()
      .select()
      .from(artifactTable)
      .all()
      .find(
        (artifact) =>
          artifact.taskId === taskId &&
          artifact.stepId === stepId &&
          artifact.artifactName === "repair_manifest",
      );
    expect(manifestArtifact).toBeDefined();

    const manifestMarkdown = readFileSync(
      path.join(sandbox.opsRoot, manifestArtifact!.relativePath),
      "utf8",
    );
    expect(manifestMarkdown).toContain("# Repair Manifest");
    expect(manifestMarkdown).toContain("Aurelia beacon lens stack realigned.");

    await secondRun.opencode?.close?.();

    const taskCompletion = completeTask({ taskId });
    expect(taskCompletion).toMatchObject({ taskId, status: "completed" });

    const listedCompleted = runCli(
      ["task", "list", "--project-id", "prj_aurelia"],
      sandbox.env,
    );
    expect(stderrText(listedCompleted)).toContain("No active tasks");
  });
});
