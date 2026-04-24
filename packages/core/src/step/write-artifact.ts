import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { and, eq } from "drizzle-orm"
import { artifactAbsolutePath, artifactRelativePath } from "../artifact/path"
import {
  artifactTable,
  db,
  projectTable,
  stepTable,
  taskTable,
  type DbExecutor,
} from "../db"
import { TaskEventType, writeTaskEvent } from "../event/task-event"
import { newArtifactId } from "../id"
import { ErrorCode, RpcError } from "../rpc/base"
import { getDeclaredArtifact } from "./validation"
import { loadWorkflowStepForTask } from "../workflow/loader"
import {
  jsonArtifactPayloadSchema,
  markdownArtifactPayloadSchema,
  type JsonArtifactPayload,
  type WriteArtifactPayload,
} from "./artifact-args"

function canonicalPath(targetPath: string): string {
  try {
    return realpathSync(targetPath)
  } catch {
    return path.resolve(targetPath)
  }
}

function artifactImportStagingRoot(input: { opsRootRealpath: string; taskId: string; stepId: string }) {
  return path.join(input.opsRootRealpath, ".sonata", "staging", input.taskId, input.stepId)
}

function resolveStagedImportPath(input: {
  opsRootRealpath: string
  taskId: string
  stepId: string
  filePath: string
}): string {
  const stagingRoot = canonicalPath(artifactImportStagingRoot(input))
  const unresolvedPath = path.isAbsolute(input.filePath)
    ? path.resolve(input.filePath)
    : path.resolve(input.opsRootRealpath, input.filePath)
  const resolvedPath = canonicalPath(unresolvedPath)
  const stagingRootWithSep = stagingRoot.endsWith(path.sep) ? stagingRoot : `${stagingRoot}${path.sep}`
  if (resolvedPath !== stagingRoot && !resolvedPath.startsWith(stagingRootWithSep)) {
    throw new RpcError(
      ErrorCode.INVALID_INPUT,
      400,
      `Artifact import path must be inside ${stagingRoot}: ${input.filePath}`,
    )
  }
  return resolvedPath
}

function cleanupImportedStagedFile(input: { opsRootRealpath: string; taskId: string; stepId: string; filePath: string }) {
  const stagingRoot = artifactImportStagingRoot(input)
  const resolvedPath = resolveStagedImportPath(input)
  rmSync(resolvedPath, { force: true })

  let currentDir = path.dirname(resolvedPath)
  while (currentDir.startsWith(stagingRoot)) {
    try {
      rmSync(currentDir)
    } catch {
      break
    }
    if (currentDir === stagingRoot) {
      break
    }
    currentDir = path.dirname(currentDir)
  }
}

function loadJsonArtifactContent(input: {
  opsRootRealpath: string
  taskId: string
  stepId: string
  payload: unknown
  parse: (input: unknown) => unknown
}): { content: string; importedFilePath?: string } {
  let payload: JsonArtifactPayload
  try {
    payload = jsonArtifactPayloadSchema().parse(input.payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON artifact payload"
    throw new RpcError(ErrorCode.INVALID_INPUT, 400, message)
  }

  const parseJsonContent = (value: unknown) => {
    try {
      return `${JSON.stringify(input.parse(value), null, 2)}\n`
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JSON artifact payload"
      throw new RpcError(ErrorCode.INVALID_INPUT, 400, message)
    }
  }

  if (payload.source === "file") {
    const importedFilePath = resolveStagedImportPath({
      opsRootRealpath: input.opsRootRealpath,
      taskId: input.taskId,
      stepId: input.stepId,
      filePath: payload.filePath,
    })

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(readFileSync(importedFilePath, "utf8"))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RpcError(ErrorCode.INVALID_INPUT, 400, `Invalid JSON artifact import file: ${message}`)
    }

    return {
      content: parseJsonContent(parsedJson),
      importedFilePath,
    }
  }

  return {
    content: parseJsonContent(payload.data),
  }
}

function writeAtomicFile(targetPath: string, content: string) {
  const dir = path.dirname(targetPath)
  mkdirSync(dir, { recursive: true })
  const tempPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  writeFileSync(tempPath, content, "utf8")
  renameSync(tempPath, targetPath)
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("UNIQUE constraint failed")
}

export type WriteArtifactInput = {
  taskId: string
  stepId: string
  artifactName: string
  artifactKind: "markdown" | "json"
  payload: WriteArtifactPayload
  sessionId?: string
}

export type WriteArtifactFromExecutionContextInput = {
  taskId: string
  stepId: string
  slug: string
  kind: "markdown" | "json"
  payload: WriteArtifactPayload
  sessionId?: string
}

export function writeArtifactFromExecutionContext(
  input: WriteArtifactFromExecutionContextInput,
  executor: DbExecutor = db(),
) {
  return writeStepArtifact(
    {
      taskId: input.taskId,
      stepId: input.stepId,
      artifactName: input.slug,
      artifactKind: input.kind,
      payload: input.payload,
      sessionId: input.sessionId,
    },
    executor,
  )
}

export async function writeStepArtifact(input: WriteArtifactInput, executor: DbExecutor = db()) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  const step = executor.select().from(stepTable).where(eq(stepTable.stepId, input.stepId)).get()
  if (!step || step.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.stepId}`)
  }
  if (step.status !== "active") {
    throw new RpcError(
      ErrorCode.INVALID_STEP_TRANSITION,
      409,
      `Step ${input.stepId} is not active and cannot accept artifact writes`,
    )
  }

  const project = executor
    .select()
    .from(projectTable)
    .where(eq(projectTable.projectId, task.projectId))
    .get()
  if (!project) {
    throw new RpcError(ErrorCode.PROJECT_NOT_FOUND, 404, `Project not found: ${task.projectId}`)
  }

  const { step: workflowStep } = await loadWorkflowStepForTask({
    taskId: input.taskId,
    stepKey: step.stepKey,
    tx: executor,
  })

  const declaredArtifact = getDeclaredArtifact(workflowStep.artifacts, input.artifactName)
  if (!declaredArtifact) {
    throw new RpcError(
      ErrorCode.ARTIFACT_NOT_DECLARED,
      400,
      `Artifact is not declared for step ${step.stepKey}: ${input.artifactName}`,
    )
  }

  if (declaredArtifact.kind !== input.artifactKind) {
    throw new RpcError(
      ErrorCode.ARTIFACT_KIND_MISMATCH,
      400,
      `Artifact kind mismatch for ${input.artifactName}: expected ${declaredArtifact.kind}, got ${input.artifactKind}`,
    )
  }

  const existingArtifact = executor
    .select()
    .from(artifactTable)
    .where(
      and(
        eq(artifactTable.taskId, input.taskId),
        eq(artifactTable.stepId, input.stepId),
        eq(artifactTable.artifactName, input.artifactName),
      ),
    )
    .get()

  const jsonPayload =
    input.artifactKind === "json"
      ? loadJsonArtifactContent({
          opsRootRealpath: project.opsRootRealpath,
          taskId: input.taskId,
          stepId: input.stepId,
          payload: input.payload,
          parse: (value) =>
            declaredArtifact.kind === "json" ? declaredArtifact.schema.parse(value) : value,
        })
      : null

  const content =
    input.artifactKind === "markdown"
      ? `${markdownArtifactPayloadSchema.parse(input.payload).markdown}\n`
      : jsonPayload!.content

  const relativePath = artifactRelativePath({
    taskId: input.taskId,
    stepIndex: step.stepIndex,
    stepKey: step.stepKey,
    artifactName: input.artifactName,
    artifactKind: input.artifactKind,
  })
  const absolutePath = artifactAbsolutePath({
    opsRootRealpath: project.opsRootRealpath,
    taskId: input.taskId,
    stepIndex: step.stepIndex,
    stepKey: step.stepKey,
    artifactName: input.artifactName,
    artifactKind: input.artifactKind,
  })

  const now = Date.now()
  const hash = contentHash(content)

  const cleanupImportedFile = () => {
    if (!jsonPayload?.importedFilePath) {
      return
    }
    cleanupImportedStagedFile({
      opsRootRealpath: project.opsRootRealpath,
      taskId: input.taskId,
      stepId: input.stepId,
      filePath: jsonPayload.importedFilePath,
    })
  }

  if (declaredArtifact.once !== false && existingArtifact) {
    if (existingArtifact.artifactKind === input.artifactKind && existingArtifact.contentHash === hash) {
      cleanupImportedFile()
      return {
        taskId: input.taskId,
        stepId: input.stepId,
        artifactName: input.artifactName,
        artifactKind: existingArtifact.artifactKind,
        relativePath: existingArtifact.relativePath,
        contentHash: existingArtifact.contentHash,
        writtenAt: existingArtifact.writtenAt,
      }
    }

    throw new RpcError(
      ErrorCode.ARTIFACT_WRITE_ONCE_VIOLATION,
      409,
      `Artifact can only be written once: ${input.artifactName}`,
    )
  }

  if (existingArtifact && existingArtifact.artifactKind === input.artifactKind && existingArtifact.contentHash === hash) {
    cleanupImportedFile()
    return {
      taskId: input.taskId,
      stepId: input.stepId,
      artifactName: input.artifactName,
      artifactKind: existingArtifact.artifactKind,
      relativePath: existingArtifact.relativePath,
      contentHash: existingArtifact.contentHash,
      writtenAt: existingArtifact.writtenAt,
    }
  }

  let wroteArtifact = false
  if (existingArtifact) {
    writeAtomicFile(absolutePath, content)
    executor
      .update(artifactTable)
      .set({
        artifactKind: input.artifactKind,
        relativePath,
        contentHash: hash,
        sessionId: input.sessionId,
        writtenAt: now,
      })
      .where(eq(artifactTable.artifactId, existingArtifact.artifactId))
      .run()
    wroteArtifact = true
  } else {
    writeAtomicFile(absolutePath, content)
    try {
      executor
        .insert(artifactTable)
        .values({
          artifactId: newArtifactId(),
          taskId: input.taskId,
          stepId: input.stepId,
          artifactName: input.artifactName,
          artifactKind: input.artifactKind,
          relativePath,
          contentHash: hash,
          sessionId: input.sessionId,
          writtenAt: now,
        })
        .run()
      wroteArtifact = true
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error
      }

      const concurrentArtifact = executor
        .select()
        .from(artifactTable)
        .where(
          and(
            eq(artifactTable.taskId, input.taskId),
            eq(artifactTable.stepId, input.stepId),
            eq(artifactTable.artifactName, input.artifactName),
          ),
        )
        .get()

      if (!concurrentArtifact) {
        throw error
      }

      if (concurrentArtifact.artifactKind === input.artifactKind && concurrentArtifact.contentHash === hash) {
        cleanupImportedFile()
        return {
          taskId: input.taskId,
          stepId: input.stepId,
          artifactName: input.artifactName,
          artifactKind: concurrentArtifact.artifactKind,
          relativePath: concurrentArtifact.relativePath,
          contentHash: concurrentArtifact.contentHash,
          writtenAt: concurrentArtifact.writtenAt,
        }
      }

      if (declaredArtifact.once !== false) {
        throw new RpcError(
          ErrorCode.ARTIFACT_WRITE_ONCE_VIOLATION,
          409,
          `Artifact can only be written once: ${input.artifactName}`,
        )
      }

      executor
        .update(artifactTable)
        .set({
          artifactKind: input.artifactKind,
          relativePath,
          contentHash: hash,
          sessionId: input.sessionId,
          writtenAt: now,
        })
        .where(eq(artifactTable.artifactId, concurrentArtifact.artifactId))
        .run()
      wroteArtifact = true
    }
  }

  if (!wroteArtifact) {
    cleanupImportedFile()
    return {
      taskId: input.taskId,
      stepId: input.stepId,
      artifactName: input.artifactName,
      artifactKind: input.artifactKind,
      relativePath,
      contentHash: hash,
      writtenAt: now,
    }
  }

  writeTaskEvent({
    executor,
    taskId: input.taskId,
    stepId: input.stepId,
    eventType: TaskEventType.ARTIFACT_WRITTEN,
    payload: {
      stepId: input.stepId,
      stepIndex: step.stepIndex,
      artifactName: input.artifactName,
      artifactKind: input.artifactKind,
      relativePath,
      sessionId: input.sessionId,
    },
    createdAt: now,
  })

  cleanupImportedFile()

  return {
    taskId: input.taskId,
    stepId: input.stepId,
    artifactName: input.artifactName,
    artifactKind: input.artifactKind,
    relativePath,
    contentHash: hash,
    writtenAt: now,
  }
}
