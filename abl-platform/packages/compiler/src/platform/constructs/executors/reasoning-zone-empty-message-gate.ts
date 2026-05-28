export type ReasoningZoneEmptyMessageGateMode =
  | 'continue'
  | 'emit_present_and_park'
  | 'park_without_output'
  | 'execute_reasoning_with_goal';

export interface ReasoningZoneEmptyMessageGateInput {
  hasReasoningZone: boolean;
  currentMessage: string;
  present?: string;
  goal?: string;
}

export interface ReasoningZoneEmptyMessageGateDecision {
  mode: ReasoningZoneEmptyMessageGateMode;
}

export function resolveReasoningZoneEmptyMessageGate(
  input: ReasoningZoneEmptyMessageGateInput,
): ReasoningZoneEmptyMessageGateDecision {
  if (!input.hasReasoningZone || input.currentMessage) {
    return { mode: 'continue' };
  }

  if (input.present) {
    return { mode: 'emit_present_and_park' };
  }

  if (input.goal?.trim()) {
    return { mode: 'execute_reasoning_with_goal' };
  }

  return { mode: 'park_without_output' };
}
