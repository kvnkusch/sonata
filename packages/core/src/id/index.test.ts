import { describe, expect, it } from "bun:test"
import {
  newArtifactId,
  newEventId,
  newProjectId,
  newStepId,
  newTaskId,
} from "./index"

describe("id helpers", () => {
  it("creates prefixed ids", () => {
    expect(newProjectId()).toStartWith("prj_")
    expect(newTaskId()).toStartWith("tsk_")
    expect(newStepId()).toStartWith("stp_")
    expect(newArtifactId()).toStartWith("art_")
    expect(newEventId()).toStartWith("evt_")
  })

  it("creates unique ids in a batch", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTaskId()))
    expect(ids.size).toBe(200)
  })
})
