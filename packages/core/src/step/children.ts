import { and, asc, eq, inArray } from "drizzle-orm"
import { artifactTable, db, stepTable, taskTable, type DbExecutor } from "../db"
import { ErrorCode, RpcError } from "../rpc/base"
import type { ChildArtifactRef, ChildListEntry, ChildSummary } from "../workflow/module"

type ChildScope = {
  taskId: string
  parentStepId: string
}

function uniqueWorkKeys(workKeys: string[] | undefined): string[] | undefined {
  if (!workKeys) {
    return undefined
  }

  const seen = new Set<string>()
  const unique: string[] = []
  for (const workKey of workKeys) {
    if (seen.has(workKey)) {
      continue
    }
    seen.add(workKey)
    unique.push(workKey)
  }

  return unique
}

function assertTaskAndParentStep(input: ChildScope, executor: DbExecutor) {
  const task = executor.select().from(taskTable).where(eq(taskTable.taskId, input.taskId)).get()
  if (!task) {
    throw new RpcError(ErrorCode.TASK_NOT_FOUND, 404, `Task not found: ${input.taskId}`)
  }

  const parentStep = executor.select().from(stepTable).where(eq(stepTable.stepId, input.parentStepId)).get()
  if (!parentStep || parentStep.taskId !== input.taskId) {
    throw new RpcError(ErrorCode.STEP_NOT_FOUND, 404, `Step not found: ${input.parentStepId}`)
  }
}

export function listChildSteps(
  input: ChildScope & { stepKey?: string; workKeys?: string[] },
  executor: DbExecutor = db(),
): ChildListEntry[] {
  assertTaskAndParentStep(input, executor)

  if (input.workKeys && input.workKeys.length === 0) {
    return []
  }

  const conditions = [eq(stepTable.taskId, input.taskId), eq(stepTable.parentStepId, input.parentStepId)]
  if (input.stepKey) {
    conditions.push(eq(stepTable.stepKey, input.stepKey))
  }
  if (input.workKeys) {
    conditions.push(inArray(stepTable.workKey, input.workKeys))
  }

  return executor
    .select()
    .from(stepTable)
    .where(and(...conditions))
    .orderBy(asc(stepTable.stepIndex))
    .all()
    .map((row) => ({
      stepId: row.stepId,
      stepKey: row.stepKey,
      workKey: row.workKey,
      status: row.status,
    }))
}

export function summarizeChildSteps(
  input: ChildScope & { stepKey: string; workKeys?: string[] },
  executor: DbExecutor = db(),
): ChildSummary {
  const requestedWorkKeys = uniqueWorkKeys(input.workKeys)
  const children = listChildSteps({ ...input, workKeys: requestedWorkKeys }, executor)
  const summary: ChildSummary = {
    stepKey: input.stepKey,
    totalCount: requestedWorkKeys?.length ?? children.length,
    pendingCount: 0,
    activeCount: 0,
    blockedCount: 0,
    orphanedCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    incompleteWorkKeys: [],
    blockedWorkKeys: [],
    orphanedWorkKeys: [],
  }
  const childByWorkKey = requestedWorkKeys ? new Map<string, ChildListEntry>() : null

  for (const child of children) {
    if (childByWorkKey && child.workKey) {
      childByWorkKey.set(child.workKey, child)
    }

    switch (child.status) {
      case "pending":
        summary.pendingCount += 1
        break
      case "active":
      case "waiting":
        summary.activeCount += 1
        break
      case "blocked":
        summary.blockedCount += 1
        break
      case "orphaned":
        summary.orphanedCount += 1
        break
      case "completed":
        summary.completedCount += 1
        break
      case "failed":
        summary.failedCount += 1
        break
      case "cancelled":
        summary.cancelledCount += 1
        break
    }

    if (!requestedWorkKeys) {
      if (child.status !== "completed" && child.status !== "failed" && child.status !== "cancelled" && child.workKey) {
        summary.incompleteWorkKeys.push(child.workKey)
      }
      if (child.status === "blocked" && child.workKey) {
        summary.blockedWorkKeys.push(child.workKey)
      }
      if (child.status === "orphaned" && child.workKey) {
        summary.orphanedWorkKeys.push(child.workKey)
      }
    }
  }

  if (requestedWorkKeys && childByWorkKey) {
    for (const workKey of requestedWorkKeys) {
      const child = childByWorkKey.get(workKey)
      if (!child) {
        summary.pendingCount += 1
        summary.incompleteWorkKeys.push(workKey)
        continue
      }

      if (child.status !== "completed" && child.status !== "failed" && child.status !== "cancelled") {
        summary.incompleteWorkKeys.push(workKey)
      }
      if (child.status === "blocked") {
        summary.blockedWorkKeys.push(workKey)
      }
      if (child.status === "orphaned") {
        summary.orphanedWorkKeys.push(workKey)
      }
    }
  }

  return summary
}

export function readChildArtifacts(
  input: ChildScope & { stepKey: string; artifactName: string; workKeys?: string[] },
  executor: DbExecutor = db(),
): ChildArtifactRef[] {
  assertTaskAndParentStep(input, executor)

  if (input.workKeys && input.workKeys.length === 0) {
    return []
  }

  const conditions = [
    eq(artifactTable.taskId, input.taskId),
    eq(stepTable.taskId, input.taskId),
    eq(stepTable.parentStepId, input.parentStepId),
    eq(stepTable.stepKey, input.stepKey),
    eq(artifactTable.artifactName, input.artifactName),
  ]
  if (input.workKeys) {
    conditions.push(inArray(stepTable.workKey, input.workKeys))
  }

  return executor
    .select()
    .from(artifactTable)
    .innerJoin(stepTable, eq(stepTable.stepId, artifactTable.stepId))
    .where(and(...conditions))
    .orderBy(asc(stepTable.stepIndex), asc(artifactTable.writtenAt))
    .all()
    .map(({ artifact, step }) => ({
      stepId: step.stepId,
      stepKey: step.stepKey,
      workKey: step.workKey,
      artifactName: artifact.artifactName,
      artifactKind: artifact.artifactKind,
      relativePath: artifact.relativePath,
    }))
}
