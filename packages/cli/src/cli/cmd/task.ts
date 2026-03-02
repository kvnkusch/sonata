import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { TaskCompleteCommand } from "./task-complete"
import { TaskListCommand } from "./task-list"
import { TaskStartCommand } from "./task-start"

export const TaskCommand = cmd({
  command: "task <command>",
  describe: "Task lifecycle commands",
  builder: (y: Argv) =>
    y.command(TaskStartCommand).command(TaskListCommand).command(TaskCompleteCommand).demandCommand(1).strict(),
  handler: async () => {},
})
