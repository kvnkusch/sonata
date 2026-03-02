import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { StepStartCommand } from "./step-start"

export const StepCommand = cmd({
  command: "step <command>",
  describe: "Step lifecycle commands",
  builder: (y: Argv) => y.command(StepStartCommand).demandCommand(1).strict(),
  handler: async () => {},
})
