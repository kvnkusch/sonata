import path from "node:path"
import { pathToFileURL } from "node:url"
import { eq } from "drizzle-orm"
import z from "zod"
import { type DbExecutor, db } from "../db"
import { projectTable } from "../db/project.sql"
import { taskTable } from "../db/task.sql"
import {
  assertSonataWorkflowModule,
  type SonataWorkflowModule,
  type WorkflowStep,
} from "./module"

const WorkflowModuleConfigSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
})

const SonataOpsConfigSchema = z.object({
  version: z.literal(1),
  defaultWorkflowId: z.string().min(1),
  workflowModules: z.array(WorkflowModuleConfigSchema).min(1),
})

type SonataOpsConfig = z.infer<typeof SonataOpsConfigSchema>

export type LoadedWorkflow = {
  taskId?: string
  opsRootRealpath: string
  configPath: string
  modulePath: string
  workflow: SonataWorkflowModule
}

const workflowCacheByTask = new Map<string, LoadedWorkflow>()

async function readSonataOpsConfig(opsRootRealpath: string): Promise<{
  configPath: string
  config: SonataOpsConfig
}> {
  const configPath = path.resolve(opsRootRealpath, "config.json")
  const file = Bun.file(configPath)
  if (!(await file.exists())) {
    throw new Error(`Missing Sonata ops repo config: ${configPath}`)
  }

  const raw = await file.json()
  return {
    configPath,
    config: SonataOpsConfigSchema.parse(raw),
  }
}

async function loadWorkflowFromOpsRepo(input: {
  opsRootRealpath: string
  workflowName: string
}): Promise<LoadedWorkflow> {
  const discovered = await readSonataOpsConfig(input.opsRootRealpath)
  const selected =
    discovered.config.workflowModules.find((module) => module.id === input.workflowName) ??
    null

  if (!selected) {
    throw new Error(`Workflow module not configured: ${input.workflowName}`)
  }

  const modulePath = path.resolve(input.opsRootRealpath, selected.path)
  const moduleUrl = pathToFileURL(modulePath).toString()
  const imported = await import(`${moduleUrl}?t=${Date.now()}`)
  assertSonataWorkflowModule(imported.default)

  return {
    opsRootRealpath: input.opsRootRealpath,
    configPath: discovered.configPath,
    modulePath,
    workflow: imported.default,
  }
}

function getTaskRow(taskId: string, tx: DbExecutor) {
  return tx.select().from(taskTable).where(eq(taskTable.taskId, taskId)).get()
}

function getProjectRow(projectId: string, tx: DbExecutor) {
  return tx.select().from(projectTable).where(eq(projectTable.projectId, projectId)).get()
}

function workflowStepByKey(loaded: LoadedWorkflow, stepKey: string): WorkflowStep | undefined {
  return loaded.workflow.steps.find((step) => step.id === stepKey)
}

export async function primeWorkflowForTaskStart(input: {
  taskId: string
  workflowName: string
  opsRootRealpath: string
}): Promise<LoadedWorkflow> {
  const loaded = await loadWorkflowFromOpsRepo({
    opsRootRealpath: input.opsRootRealpath,
    workflowName: input.workflowName,
  })
  const cached = { ...loaded, taskId: input.taskId }
  workflowCacheByTask.set(input.taskId, cached)
  return cached
}

export async function loadWorkflowForTask(taskId: string, tx: DbExecutor = db()): Promise<LoadedWorkflow> {
  const cached = workflowCacheByTask.get(taskId)
  if (cached) {
    return cached
  }

  const task = getTaskRow(taskId, tx)
  if (!task) {
    throw new Error(`Task not found: ${taskId}`)
  }

  const project = getProjectRow(task.projectId, tx)
  if (!project) {
    throw new Error(`Project not found for task: ${taskId}`)
  }

  const loaded = await loadWorkflowFromOpsRepo({
    opsRootRealpath: project.opsRootRealpath,
    workflowName: task.workflowName,
  })

  const cachedLoaded = { ...loaded, taskId }
  workflowCacheByTask.set(taskId, cachedLoaded)
  return cachedLoaded
}

export async function loadWorkflowStepForTask(input: {
  taskId: string
  stepKey: string
  tx?: DbExecutor
}): Promise<{ loaded: LoadedWorkflow; step: WorkflowStep }> {
  const loaded = await loadWorkflowForTask(input.taskId, input.tx)
  const step = workflowStepByKey(loaded, input.stepKey)
  if (!step) {
    throw new Error(`Workflow step not found in ${loaded.workflow.id}: ${input.stepKey}`)
  }
  return { loaded, step }
}

export function clearWorkflowCache() {
  workflowCacheByTask.clear()
}
