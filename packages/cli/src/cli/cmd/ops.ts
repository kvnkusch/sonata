import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { OpsInstallSkillsCommand } from "./ops-install-skills"

export const OpsCommand = cmd({
  command: "ops <command>",
  describe: "Ops repository commands",
  builder: (y: Argv) => y.command(OpsInstallSkillsCommand).demandCommand(1).strict(),
  handler: async () => {},
})
