import { randomBytes } from "node:crypto"

function withPrefix(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`
}

export const newProjectId = () => withPrefix("prj")
export const newTaskId = () => withPrefix("tsk")
export const newStepId = () => withPrefix("stp")
export const newArtifactId = () => withPrefix("art")
export const newEventId = () => withPrefix("evt")
