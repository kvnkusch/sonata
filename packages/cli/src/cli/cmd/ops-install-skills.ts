import { createCaller } from "@sonata/core/rpc"
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"

type OpsInstallSkillsArgs = {
  opsRoot: string
}

export const OpsInstallSkillsCommand = cmd<object, OpsInstallSkillsArgs>({
  command: "install-skills <opsRoot>",
  describe: "Install Sonata agent skills into an ops repository",
  builder: (y: Argv<object>) =>
    y.positional("opsRoot", {
      type: "string",
      demandOption: true,
      describe: "Path to ops repository",
    }),
  handler: async (args) => {
    const caller = createCaller()
    const result = caller.ops.installSkills({ opsRoot: args.opsRoot })
    UI.println("skill:", result.skillName)
    UI.println("status:", result.status)
    UI.println("ops_path:", result.opsSkillPath)
    UI.println("source_path:", result.sourceSkillPath)
  },
})
