import { createCaller } from "@sonata/core/rpc"
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"

type ProjectLinkArgs = {
  opsRoot: string
  "project-root"?: string
  "project-id"?: string
}

export const ProjectLinkCommand = cmd<object, ProjectLinkArgs>({
  command: "link <opsRoot>",
  describe: "Link current project root to an ops repository",
  builder: (y: Argv<object>) =>
    y
      .positional("opsRoot", {
        type: "string",
        demandOption: true,
        describe: "Path to ops repository",
      })
      .option("project-root", {
        type: "string",
        describe: "Override project root path",
      })
      .option("project-id", {
        type: "string",
        describe: "Override generated project id",
      }),
  handler: async (args) => {
    const caller = createCaller()
    const linked = caller.project.linkOpsRepo({
      opsRoot: args.opsRoot,
      projectRoot: args["project-root"],
      projectId: args["project-id"],
    })
    UI.println("project_id:", linked.projectId)
    UI.println("project_root:", linked.projectRootRealpath)
    UI.println("ops_root:", linked.opsRootRealpath)
  },
})
