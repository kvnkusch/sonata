import { createHash } from "node:crypto"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { and, eq } from "drizzle-orm"
import z from "zod"
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

const markdownPayloadSchema = z.object({ markdown: z.string().min(1) }).strict()
const jsonPayloadSchema = z.object({ data: z.unknown() }).strict()

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
  payload: { markdown: string } | { data: unknown }
  sessionId?: string
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

  const content =
    input.artifactKind === "markdown"
      ? `${markdownPayloadSchema.parse(input.payload).markdown}\n`
      : `${JSON.stringify(
          declaredArtifact.kind === "json"
            ? declaredArtifact.schema.parse(jsonPayloadSchema.parse(input.payload).data)
            : jsonPayloadSchema.parse(input.payload).data,
          null,
          2,
        )}\n`

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

  if (declaredArtifact.once !== false && existingArtifact) {
    if (existingArtifact.artifactKind === input.artifactKind && existingArtifact.contentHash === hash) {
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
