import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { StepAttachCommand } from "./step-attach"
import { StepSessionsCommand } from "./step-sessions"
import { StepStartCommand } from "./step-start"

export const StepCommand = cmd({
  command: "step <command>",
  describe: "Step lifecycle commands",
  builder: (y: Argv) => y.command(StepStartCommand).command(StepAttachCommand).command(StepSessionsCommand).demandCommand(1).strict(),
  handler: async () => {},
})
