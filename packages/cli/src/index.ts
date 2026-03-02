import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { InitCommand } from "./cli/cmd/init"
import { ProjectCommand } from "./cli/cmd/project"
import { StepCommand } from "./cli/cmd/step"
import { StatusCommand } from "./cli/cmd/status"
import { TaskCommand } from "./cli/cmd/task"
import { runInteractive } from "./cli/interactive"
import { UI } from "./cli/ui"

const argv = hideBin(process.argv)
if (argv.length === 0) {
  await runInteractive()
  process.exit(0)
}

let cli = yargs(argv)
  .scriptName("sonata")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .command(InitCommand)
  .command(ProjectCommand)
  .command(StepCommand)
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
