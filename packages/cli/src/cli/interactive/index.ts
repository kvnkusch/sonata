import * as prompts from "@clack/prompts"
import { executeStep } from "@sonata/core/execution"
import { getProjectByRoot } from "@sonata/core/project"
import { createCaller } from "@sonata/core/rpc"
import { loadWorkflowForTask, readOpsConfig } from "@sonata/core/workflow"
import { attachOpencodeTui } from "../opencode/attach"
import { UI } from "../ui"
import { collectStepInputs } from "./collect-step-inputs"
import { createEffectRunner, type ActiveTask, type LinkedProject } from "./effect-runner"
import {
  initialInteractiveMachineState,
  transition,
  type InteractiveEvent,
  type InteractiveState as MachineState,
  type SharedCtx,
} from "./machine"

async function ensureLinkedProject(caller: ReturnType<typeof createCaller>): Promise<LinkedProject> {
  const scope = caller.scope.resolveFromCwd({})
  const existing = getProjectByRoot(scope.projectRoot)
  if (existing) {
    return {
      projectId: existing.projectId,
      projectRoot: existing.projectRootRealpath,
      opsRoot: existing.opsRootRealpath,
    }
  }

  const shouldLink = await prompts.confirm({
    message: `No Sonata project link for ${scope.projectRoot}. Link now?`,
    initialValue: true,
  })
  if (prompts.isCancel(shouldLink) || !shouldLink) {
    throw new Error("Project is not linked")
  }

  const opsRoot = await prompts.text({
    message: "Path to ops repo",
    placeholder: "../sonata-ops",
  })
  if (prompts.isCancel(opsRoot) || !opsRoot.trim()) {
    throw new Error("Ops repo path required")
  }

  const linked = caller.project.linkOpsRepo({
    projectRoot: scope.projectRoot,
    opsRoot: opsRoot.trim(),
  })
  return {
    projectId: linked.projectId,
    projectRoot: linked.projectRootRealpath,
    opsRoot: linked.opsRootRealpath,
  }
}

export async function runInteractive() {
  const caller = createCaller()
  prompts.intro("sonata interactive")

  let machineState: MachineState = initialInteractiveMachineState()
  const runtime = {
    caller,
    sharedCtx: null as SharedCtx | null,
    listedTasks: new Map<string, ActiveTask>(),
    lastStepResult: null as {
      status: "active" | "waiting" | "completed" | "blocked" | "failed"
      suggestedNextStepKey: string | null
      failure?: { reason: string; details?: unknown }
    } | null,
    lastStepDetail: null as ReturnType<ReturnType<typeof createCaller>["step"]["get"]> | null,
  }

  const runEffect = createEffectRunner({
    prompts,
    ui: UI,
    ensureLinkedProject,
    readOpsConfig,
    loadWorkflowForTask,
    collectStepInputs,
    executeStep,
    attachOpencodeTui,
  })

  function getShared(state: MachineState): SharedCtx | null {
    return "shared" in state && state.shared ? state.shared : null
  }

  const queue: InteractiveEvent[] = [{ type: "BOOT" }]
  while (queue.length > 0) {
    const event = queue.shift()!
    const result = transition(machineState, event)
    machineState = result.state

    const shared = getShared(machineState)
    if (shared) {
      runtime.sharedCtx = shared
    }

    for (const effect of result.effects) {
      const nextEvents = await runEffect(effect, runtime)
      queue.push(...nextEvents)
    }

    if (machineState.status === "exiting") {
      break
    }
  }
}
