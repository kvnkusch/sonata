import { EOL } from "os"

export namespace UI {
  export function println(...message: string[]) {
    Bun.stderr.write(message.join(" ") + EOL)
  }

  export function error(message: string) {
    const msg = message.startsWith("Error: ") ? message.slice("Error: ".length) : message
    println("Error:", msg)
  }
}
