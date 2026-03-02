import { createCaller } from "@sonata/core/rpc"
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"

type StepStartArgs = {
  stepKey: string
  "task-id": string
}

export const StepStartCommand = cmd<object, StepStartArgs>({
  command: "start <stepKey>",
  describe: "Start a step for an active task",
  builder: (y: Argv<object>) =>
    y
      .positional("stepKey", {
        type: "string",
        demandOption: true,
        describe: "Step key in workflow",
      })
      .option("task-id", {
        type: "string",
        demandOption: true,
        describe: "Task id",
      }),
  handler: async (args) => {
    const caller = createCaller()
    const started = await caller.step.start({
      taskId: args["task-id"],
      stepKey: args.stepKey,
    })
    UI.println("task_id:", started.taskId)
    UI.println("step_id:", started.stepId)
    UI.println("step_key:", started.stepKey)
    UI.println("step_index:", String(started.stepIndex))
  },
})
