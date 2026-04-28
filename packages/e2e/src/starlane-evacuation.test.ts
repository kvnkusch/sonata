import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { artifactTable, closeDb, db } from "@sonata/core/db";
import { executeStep } from "@sonata/core/execution";
import { createCaller } from "@sonata/core/rpc";
import { getStep, listStepsForTask } from "@sonata/core/step";
import { completeTask } from "@sonata/core/task";
import { clearWorkflowCache, loadWorkflowForTask, readOpsConfig } from "@sonata/core/workflow";
import {
  createEffectRunner,
  type EffectRuntime,
} from "../../cli/src/cli/interactive/effect-runner";
import {
  createScenarioSandbox,
  destroyScenarioSandbox,
  parseKey,
  runCli,
  stderrText,
  type ScenarioSandbox,
} from "./harness";

const sandboxes: ScenarioSandbox[] = [];

async function runWaitingChildren(taskId: string, stepId: string) {
  const runEffect = createEffectRunner({
    prompts: {
      async select() {
        return "unused" as never;
      },
      isCancel(_value: unknown): _value is symbol {
        return false;
      },
      outro() {},
    },
    ui: { println() {}, error() {} },
    async ensureLinkedProject() {
      throw new Error("ensureLinkedProject is not used by this e2e helper");
    },
    readOpsConfig,
    loadWorkflowForTask,
    async collectStepInputs() {
      return {};
    },
    executeStep,
    async attachOpencodeTui() {},
  });
  const runtime: EffectRuntime = {
    caller: createCaller(),
    sharedCtx: null,
    listedTasks: new Map(),
    lastStepResult: null,
    lastStepDetail: null,
  };

  await runEffect({ type: "EXECUTE_WAITING_CHILDREN", taskId, stepId }, runtime);
}

afterEach(() => {
  clearWorkflowCache();
  closeDb();
  delete process.env.SONATA_DB_PATH;
  for (const sandbox of sandboxes.splice(0)) {
    destroyScenarioSandbox(sandbox);
  }
});

describe("starlane evacuation e2e", () => {
  it("runs guarded fan-out and fan-in through a committed scenario fixture", async () => {
    const sandbox = createScenarioSandbox("starlane-evacuation");
    sandboxes.push(sandbox);

    const link = runCli(
      [
        "project",
        "link",
        sandbox.opsRoot,
        "--project-root",
        sandbox.projectRoot,
        "--project-id",
        "prj_starlane",
      ],
      sandbox.env,
    );
    expect(link.exitCode).toBe(0);

    const startedTask = runCli(
      ["task", "start", "default", "--project-id", "prj_starlane"],
      sandbox.env,
    );
    expect(startedTask.exitCode).toBe(0);
    const startedTaskOutput = stderrText(startedTask);
    const taskId = parseKey(startedTaskOutput, "task_id");

    const startedStep = runCli(
      ["step", "start", "mission_control", "--task-id", taskId],
      sandbox.env,
    );
    expect(startedStep.exitCode).toBe(0);
    const startedStepOutput = stderrText(startedStep);
    const stepId = parseKey(startedStepOutput, "step_id");

    const listedBeforeRun = runCli(
      ["task", "list", "--project-id", "prj_starlane"],
      sandbox.env,
    );
    expect(stderrText(listedBeforeRun)).toContain(`root_step_status=active`);

    const firstRun = await executeStep({ taskId, stepId });
    expect(firstRun).toMatchObject({
      status: "waiting",
      suggestedNextStepKey: null,
    });
    expect(getStep({ taskId, stepId })).toMatchObject({
      status: "waiting",
      waitSpec: {
        kind: "children",
        childStepKey: "survey_sector",
        workKeys: ["aurora", "cinder", "glass"],
        concurrency: 2,
        until: "all_completed",
        label: "Waiting for survey squadrons",
      },
      waitSnapshot: {
        totalCount: 3,
        pendingCount: 3,
        activeCount: 0,
        completedCount: 0,
      },
    });

    const listedWaiting = runCli(
      ["task", "list", "--project-id", "prj_starlane"],
      sandbox.env,
    );
    expect(stderrText(listedWaiting)).toContain(`root_step_id=${stepId}`);
    expect(stderrText(listedWaiting)).toContain("root_step_status=waiting");

    const children = listStepsForTask({ taskId })
      .filter((step) => step.parentStepId === stepId)
      .sort((left, right) =>
        (left.workKey ?? "").localeCompare(right.workKey ?? ""),
      );
    expect(children.map((child) => child.workKey)).toEqual([
      "aurora",
      "cinder",
      "glass",
    ]);
    expect(children.map((child) => child.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);

    await runWaitingChildren(taskId, stepId);
    expect(getStep({ taskId, stepId }).status).toBe("active");

    const completedChildren = listStepsForTask({ taskId }).filter(
      (step) => step.parentStepId === stepId,
    );
    expect(completedChildren.map((child) => child.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);

    const listedAwake = runCli(
      ["task", "list", "--project-id", "prj_starlane"],
      sandbox.env,
    );
    expect(stderrText(listedAwake)).toContain("root_step_status=active");

    const guardRejected = await executeStep({ taskId, stepId });
    expect(guardRejected).toMatchObject({
      status: "active",
      suggestedNextStepKey: null,
    });
    expect(getStep({ taskId, stepId }).status).toBe("active");

    writeFileSync(
      path.join(sandbox.projectRoot, "captain-approval.md"),
      [
        "# Captain Approval",
        "",
        "Launch convoy Nightglass through the cleared starlanes.",
      ].join("\n"),
      "utf8",
    );

    const completed = await executeStep({ taskId, stepId });
    expect(completed).toMatchObject({
      status: "completed",
      suggestedNextStepKey: null,
    });
    expect(getStep({ taskId, stepId }).status).toBe("completed");

    const artifacts = db()
      .select()
      .from(artifactTable)
      .all()
      .filter((artifact) => artifact.taskId === taskId);
    expect(
      artifacts.filter((artifact) => artifact.artifactName === "sector_report"),
    ).toHaveLength(3);
    const surveyEventArtifacts = artifacts.filter(
      (artifact) => artifact.artifactName === "survey_events",
    );
    expect(surveyEventArtifacts).toHaveLength(3);
    expect(surveyEventArtifacts.every((artifact) => artifact.artifactKind === "jsonl"))
      .toBe(true);
    const firstSurveyEvents = readFileSync(
      path.join(sandbox.opsRoot, surveyEventArtifacts[0]!.relativePath),
      "utf8",
    );
    expect(firstSurveyEvents).toContain('"event":"survey-started"');
    expect(firstSurveyEvents.trim().split("\n")).toHaveLength(2);

    const planArtifact = artifacts.find(
      (artifact) =>
        artifact.stepId === stepId &&
        artifact.artifactName === "evacuation_plan",
    );
    expect(planArtifact).toBeDefined();

    const planMarkdown = readFileSync(
      path.join(sandbox.opsRoot, planArtifact!.relativePath),
      "utf8",
    );
    expect(planMarkdown).toContain("# Starlane Evacuation Plan");
    expect(planMarkdown).toContain("Aurora");
    expect(planMarkdown).toContain("Cinder");
    expect(planMarkdown).toContain("Glass");
    expect(planMarkdown).toContain("Lighthouse Corridor");
    expect(planMarkdown).toContain("captain-approval.md");

    const taskCompletion = completeTask({ taskId });
    expect(taskCompletion).toMatchObject({ taskId, status: "completed" });

    const listedCompleted = runCli(
      ["task", "list", "--project-id", "prj_starlane"],
      sandbox.env,
    );
    expect(stderrText(listedCompleted)).toContain("No active tasks");
  });
});
