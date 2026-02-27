import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { ProjectLinkCommand } from "./project-link"

export const ProjectCommand = cmd({
  command: "project <command>",
  describe: "Project-related commands",
  builder: (y: Argv) => y.command(ProjectLinkCommand).demandCommand(1).strict(),
  handler: async () => {},
})
