import { ErrorCode, RpcError } from "../rpc/base"

export const stepTransitions = {
  pending: ["active", "cancelled"],
  active: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const

export type StepStatus = keyof typeof stepTransitions

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return (stepTransitions[from] as readonly StepStatus[]).includes(to)
}

export function assertStepTransition(from: StepStatus, to: StepStatus, detail: string) {
  if (canTransitionStep(from, to)) {
    return
  }
  throw new RpcError(ErrorCode.INVALID_STEP_TRANSITION, 409, detail)
}
