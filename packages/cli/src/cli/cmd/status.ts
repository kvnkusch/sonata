import type { Argv } from "yargs"
import { paths } from "@sonata/core/paths"
import { cmd } from "./cmd"
import { UI } from "../ui"

export const StatusCommand = cmd({
  command: "status",
  describe: "Show local Sonata paths",
  builder: (y: Argv) => y,
  handler: async () => {
    const p = paths()
    UI.println("data:", p.data)
    UI.println("config:", p.config)
    UI.println("state:", p.state)
    UI.println("cache:", p.cache)
  },
})
