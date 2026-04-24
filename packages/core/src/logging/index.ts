import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { JsonValue, StepLogContext, StepLogInput, StepLogLevel } from "../workflow/module"

type StepLogTarget = {
  opsRootRealpath: string
  taskId: string
  stepId: string
  stepKey: string
  stepIndex: number
  workKey?: string | null
}

type LogRecord = Record<string, unknown>

function safeSegment(value: string): string {
  const segment = value
    .trim()
    .replace(/[^a-zA-Z0-9._=-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return segment || "log"
}

function zeroPadStepIndex(stepIndex: number): string {
  return String(stepIndex).padStart(3, "0")
}

function normalizeForLog(value: unknown): unknown {
  if (typeof value === "undefined") {
    return undefined
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    }
  }

  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return String(value)
  }
}

function appendJsonLine(filePath: string, record: LogRecord) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

function taskLogsRoot(opsRootRealpath: string, taskId: string): string {
  return path.join(opsRootRealpath, "logs", "tasks", safeSegment(taskId))
}

export function taskWorkflowLogPath(input: { opsRootRealpath: string; taskId: string }): string {
  return path.join(taskLogsRoot(input.opsRootRealpath, input.taskId), "workflow.log")
}

export function stepLogPath(input: StepLogTarget): string {
  const workKeySuffix = input.workKey ? `-${safeSegment(input.workKey)}` : ""
  return path.join(
    taskLogsRoot(input.opsRootRealpath, input.taskId),
    "steps",
    `${zeroPadStepIndex(input.stepIndex)}-${safeSegment(input.stepKey)}${workKeySuffix}.log`,
  )
}

export function writeWorkflowLog(input: StepLogTarget & StepLogInput & { createdAt?: number }) {
  const createdAt = input.createdAt ?? Date.now()
  const level: StepLogLevel = input.level ?? "info"
  const record: LogRecord = {
    time: new Date(createdAt).toISOString(),
    stream: "workflow",
    level,
    taskId: input.taskId,
    stepId: input.stepId,
    stepKey: input.stepKey,
    stepIndex: input.stepIndex,
    ...(input.workKey ? { workKey: input.workKey } : {}),
    message: input.message,
    ...(typeof input.details === "undefined" ? {} : { details: normalizeForLog(input.details) }),
  }

  appendJsonLine(taskWorkflowLogPath(input), record)
  appendJsonLine(stepLogPath(input), record)
}

export function createStepLogContext(input: StepLogTarget): StepLogContext {
  const write = (params: StepLogInput) => {
    writeWorkflowLog({ ...input, ...params })
  }

  return {
    write,
    debug: (message, details) => write({ level: "debug", message, details }),
    info: (message, details) => write({ level: "info", message, details }),
    warn: (message, details) => write({ level: "warn", message, details }),
    error: (message, details) => write({ level: "error", message, details }),
  }
}
