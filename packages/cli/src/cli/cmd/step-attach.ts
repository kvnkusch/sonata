import { getProjectByTaskId } from "@sonata/core/project"
import { createCaller } from "@sonata/core/rpc"
import type { Argv } from "yargs"
import { attachOpencodeTui } from "../opencode/attach"
import { cmd } from "./cmd"

type StepAttachArgs = {
  stepId: string
  "task-id": string
}

function projectRootForTask(taskId: string): string {
  const project = getProjectByTaskId(taskId)
  if (!project) {
    throw new Error(`Project not found for task: ${taskId}`)
  }
  return project.projectRootRealpath
}

export const StepAttachCommand = cmd<object, StepAttachArgs>({
  command: "attach <stepId>",
  describe: "Attach to a step OpenCode session",
  builder: (y: Argv<object>) =>
    y
      .positional("stepId", {
        type: "string",
        demandOption: true,
        describe: "Step id",
      })
      .option("task-id", {
        type: "string",
        demandOption: true,
        describe: "Task id",
      }),
  handler: async (args) => {
    const caller = createCaller()
    const step = caller.step.get({ taskId: args["task-id"], stepId: args.stepId })
    if (!step.sessionId || !step.opencodeBaseUrl) {
      throw new Error(`Step ${args.stepId} does not have an attachable OpenCode session`)
    }

    await attachOpencodeTui({
      projectRoot: projectRootForTask(args["task-id"]),
      baseUrl: step.opencodeBaseUrl,
      sessionId: step.sessionId,
      env: {},
    })
  },
})
