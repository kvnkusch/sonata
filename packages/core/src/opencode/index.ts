export function staticSonataBridgePluginUrl(input?: {
  taskId?: string
  stepId?: string
  projectRoot?: string
  opsRoot?: string
}): string {
  const url = new URL("./sonata-bridge-plugin.ts", import.meta.url)
  if (input?.taskId) {
    url.searchParams.set("taskId", input.taskId)
  }
  if (input?.stepId) {
    url.searchParams.set("stepId", input.stepId)
  }
  if (input?.projectRoot) {
    url.searchParams.set("projectRoot", input.projectRoot)
  }
  if (input?.opsRoot) {
    url.searchParams.set("opsRoot", input.opsRoot)
  }
  return url.toString()
}

export { SonataBridgePlugin } from "./sonata-bridge-plugin"
