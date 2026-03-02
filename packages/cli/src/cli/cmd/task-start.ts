import { createCaller } from "@sonata/core/rpc"
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"

type TaskStartArgs = {
  workflow?: string
  "project-id": string
}

export const TaskStartCommand = cmd<object, TaskStartArgs>({
  command: "start [workflow]",
  describe: "Start a workflow task",
  builder: (y: Argv<object>) =>
    y
      .positional("workflow", {
        type: "string",
        describe: "Workflow name",
      })
      .option("project-id", {
        type: "string",
        demandOption: true,
        describe: "Linked project id",
      }),
  handler: async (args) => {
    const caller = createCaller()
    const started = await caller.task.start({
      projectId: args["project-id"],
      workflowRef: args.workflow ? { name: args.workflow } : undefined,
    })

    UI.println("task_id:", started.taskId)
    UI.println("project_id:", started.projectId)
    UI.println("workflow:", started.workflowName)
  },
})
