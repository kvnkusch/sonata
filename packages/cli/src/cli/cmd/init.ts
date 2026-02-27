import type { Argv } from "yargs"
import * as prompts from "@clack/prompts"
import { paths } from "@sonata/core/paths"
import { cmd } from "./cmd"
import { UI } from "../ui"

export const InitCommand = cmd({
  command: "init",
  describe: "Initialize Sonata user directories",
  builder: (y: Argv) => y,
  handler: async () => {
    const p = paths()
    prompts.intro("sonata init")
    UI.println("data:", p.data)
    UI.println("config:", p.config)
    UI.println("state:", p.state)
    UI.println("cache:", p.cache)
    prompts.outro("Done")
  },
})
