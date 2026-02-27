import { ulid } from "ulid"

function withPrefix(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`
}

export const newProjectId = () => withPrefix("prj")
export const newTaskId = () => withPrefix("tsk")
export const newStepId = () => withPrefix("stp")
export const newArtifactId = () => withPrefix("art")
export const newEventId = () => withPrefix("evt")
