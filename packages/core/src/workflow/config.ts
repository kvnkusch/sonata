import path from "node:path"
import z from "zod"

export type OpsWorkflowModuleConfig = { id: string; path: string }
export type OpsConfig = {
  version: 1
  defaultWorkflowId: string
  workflowModules: OpsWorkflowModuleConfig[]
}

const WorkflowModuleConfigSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
})

const OpsConfigSchema: z.ZodType<OpsConfig> = z.object({
  version: z.literal(1),
  defaultWorkflowId: z.string().min(1),
  workflowModules: z.array(WorkflowModuleConfigSchema).min(1),
})

export async function readOpsConfig(opsRootRealpath: string): Promise<{
  configPath: string
  config: OpsConfig
}> {
  const configPath = path.resolve(opsRootRealpath, "config.json")
  const file = Bun.file(configPath)
  if (!(await file.exists())) {
    throw new Error(`Missing Sonata ops repo config: ${configPath}`)
  }

  const raw = await file.json()
  return {
    configPath,
    config: OpsConfigSchema.parse(raw),
  }
}
