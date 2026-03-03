export function staticSonataBridgePluginUrl(): string {
  return new URL("./sonata-bridge-plugin.ts", import.meta.url).toString()
}

export { SonataBridgePlugin } from "./sonata-bridge-plugin"
