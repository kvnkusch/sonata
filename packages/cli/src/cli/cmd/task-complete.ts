import { createCaller } from "@sonata/core/rpc"
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"

type TaskCompleteArgs = {
  "task-id": string
}

export const TaskCompleteCommand = cmd<object, TaskCompleteArgs>({
  command: "complete",
  describe: "Mark an active task as completed",
  builder: (y: Argv<object>) =>
    y.option("task-id", {
      type: "string",
      demandOption: true,
      describe: "Task id",
    }),
  handler: async (args) => {
    const caller = createCaller()
    const completed = await caller.task.complete({
      taskId: args["task-id"],
    })
    UI.println("task_id:", completed.taskId)
    UI.println("status:", completed.status)
  },
})
