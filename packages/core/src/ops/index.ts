import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from "node:fs"
import path from "node:path"

export const SONATA_WORKFLOWS_SKILL_NAME = "sonata-workflows"

export type OpsSkillInstallStatus = "installed" | "already-installed"

export type OpsSkillInstallResult = {
  skillName: string
  status: OpsSkillInstallStatus
  opsSkillPath: string
  sourceSkillPath: string
}

export type OpsSkillInstallState = {
  skillName: string
  installed: boolean
  opsSkillPath: string
  sourceSkillPath: string
  reason?: string
}

function sourceSkillPath(): string {
  return path.resolve(import.meta.dir, "../../../../skills", SONATA_WORKFLOWS_SKILL_NAME)
}

function opsSkillPath(opsRoot: string): string {
  return path.join(realpathSync(opsRoot), ".agents", "skills", SONATA_WORKFLOWS_SKILL_NAME)
}

function tryLstat(filePath: string) {
  try {
    return lstatSync(filePath)
  } catch {
    return undefined
  }
}

function sameTarget(linkPath: string, targetPath: string): boolean {
  try {
    const resolvedLink = realpathSync(linkPath)
    const resolvedTarget = realpathSync(targetPath)
    return resolvedLink === resolvedTarget
  } catch {
    return false
  }
}

export function getOpsSkillInstallState(input: { opsRoot: string }): OpsSkillInstallState {
  const source = sourceSkillPath()
  const destination = opsSkillPath(input.opsRoot)

  if (!existsSync(source)) {
    return {
      skillName: SONATA_WORKFLOWS_SKILL_NAME,
      installed: false,
      opsSkillPath: destination,
      sourceSkillPath: source,
      reason: "source skill is missing",
    }
  }

  const destinationStat = tryLstat(destination)
  if (!destinationStat) {
    return {
      skillName: SONATA_WORKFLOWS_SKILL_NAME,
      installed: false,
      opsSkillPath: destination,
      sourceSkillPath: source,
      reason: "not installed",
    }
  }

  if (!destinationStat.isSymbolicLink()) {
    return {
      skillName: SONATA_WORKFLOWS_SKILL_NAME,
      installed: false,
      opsSkillPath: destination,
      sourceSkillPath: source,
      reason: "destination exists and is not a symlink",
    }
  }

  return {
    skillName: SONATA_WORKFLOWS_SKILL_NAME,
    installed: sameTarget(destination, source),
    opsSkillPath: destination,
    sourceSkillPath: source,
    reason: sameTarget(destination, source) ? undefined : `points to ${readlinkSync(destination)}`,
  }
}

export function installOpsSkills(input: { opsRoot: string }): OpsSkillInstallResult {
  const source = sourceSkillPath()
  if (!existsSync(source)) {
    throw new Error(`Missing Sonata skill source: ${source}`)
  }

  const destination = opsSkillPath(input.opsRoot)
  const parent = path.dirname(destination)
  mkdirSync(parent, { recursive: true })

  const destinationStat = tryLstat(destination)
  if (destinationStat) {
    if (destinationStat.isSymbolicLink() && sameTarget(destination, source)) {
      return {
        skillName: SONATA_WORKFLOWS_SKILL_NAME,
        status: "already-installed",
        opsSkillPath: destination,
        sourceSkillPath: source,
      }
    }

    const detail = destinationStat.isSymbolicLink()
      ? `existing symlink points to ${readlinkSync(destination)}`
      : "destination exists and is not a symlink"
    throw new Error(`Cannot install ${SONATA_WORKFLOWS_SKILL_NAME}: ${destination} already exists (${detail})`)
  }

  symlinkSync(source, destination, "dir")
  return {
    skillName: SONATA_WORKFLOWS_SKILL_NAME,
    status: "installed",
    opsSkillPath: destination,
    sourceSkillPath: source,
  }
}
