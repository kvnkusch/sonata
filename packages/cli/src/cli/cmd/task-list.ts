import { createCaller } from "@sonata/core/rpc"
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"

type TaskListArgs = {
  "project-id": string
}

export const TaskListCommand = cmd<object, TaskListArgs>({
  command: "list",
  describe: "List active tasks for a project",
  builder: (y: Argv<object>) =>
    y.option("project-id", {
      type: "string",
      demandOption: true,
      describe: "Linked project id",
    }),
  handler: async (args) => {
    const caller = createCaller()
    const tasks = caller.task.listActive({ projectId: args["project-id"] })

    if (tasks.length === 0) {
      UI.println("No active tasks")
      return
    }

    for (const task of tasks) {
      UI.println(
        `${task.taskId} ${task.workflowName} step_id=${task.currentStepId ?? "?"} step_index=${task.currentStepIndex ?? "?"}`,
      )
    }
  },
})
