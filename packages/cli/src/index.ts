import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { InitCommand } from "./cli/cmd/init"
import { ProjectCommand } from "./cli/cmd/project"
import { StatusCommand } from "./cli/cmd/status"
import { TaskCommand } from "./cli/cmd/task"
import { UI } from "./cli/ui"

let cli = yargs(hideBin(process.argv))
  .scriptName("sonata")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .command(InitCommand)
  .command(ProjectCommand)
  .command(StatusCommand)
  .command(TaskCommand)
  .completion("completion", "generate shell completion script")
  .fail((msg: string | undefined, err: unknown) => {
    if (msg) {
      UI.error(msg)
      cli.showHelp("log")
      return
    }
    if (err) throw err
  })
  .strict()

await cli.parse()
