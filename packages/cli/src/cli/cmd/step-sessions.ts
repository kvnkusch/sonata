import { createCaller } from "@sonata/core/rpc"
import type { Argv } from "yargs"
import { UI } from "../ui"
import { cmd } from "./cmd"

type StepSessionsArgs = {
  "task-id": string
}

export const StepSessionsCommand = cmd<object, StepSessionsArgs>({
  command: "sessions",
  describe: "List OpenCode sessions for task steps",
  builder: (y: Argv<object>) =>
    y.option("task-id", {
      type: "string",
      demandOption: true,
      describe: "Task id",
    }),
  handler: async (args) => {
    const caller = createCaller()
    const sessions = caller.step
      .list({ taskId: args["task-id"] })
      .filter((step) => step.sessionId || step.opencodeBaseUrl)

    if (sessions.length === 0) {
      UI.println("step_sessions:", "none")
      return
    }

    UI.println("step_sessions:")
    for (const step of sessions) {
      UI.println(
        `  [${step.stepIndex}]`,
        `step_id=${step.stepId}`,
        `step_key=${step.stepKey}`,
        `work_key=${step.workKey ?? "none"}`,
        `status=${step.status}`,
        `session_id=${step.sessionId ?? "none"}`,
        `opencode_base_url=${step.opencodeBaseUrl ? "present" : "none"}`,
      )
    }
  },
})
