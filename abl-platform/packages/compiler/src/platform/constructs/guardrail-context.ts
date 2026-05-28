import type { GuardrailKind } from '../ir/schema.js';

export interface GuardrailContextInput {
  content: string;
  agentGoal?: string;
  sessionTurnCount?: number;
  toolName?: string;
  toolParameters?: Record<string, unknown>;
  toolResult?: unknown;
  toolSuccess?: boolean;
  toolDurationMs?: number;
  sourceAgent?: string;
  targetAgent?: string;
  sourceAgentRole?: string;
  handoffContext?: string;
  handoffReason?: string;
  sessionValues?: Record<string, unknown>;
}

export function buildGuardrailCelContext(
  kind: GuardrailKind,
  input: GuardrailContextInput,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    agent_goal: input.agentGoal ?? '',
    session_turn_count: input.sessionTurnCount ?? 0,
    ...(input.sessionValues ?? {}),
  };

  switch (kind) {
    case 'input':
      return { ...base, input: input.content };
    case 'output':
      return { ...base, output: input.content };
    case 'tool_input':
      return {
        ...base,
        tool_input: input.content,
        tool_name: input.toolName ?? '',
        tool_parameters: input.toolParameters ?? {},
      };
    case 'tool_output':
      return {
        ...base,
        tool_output: input.content,
        tool_name: input.toolName ?? '',
        tool_result: input.toolResult ?? {},
        tool_success: input.toolSuccess ?? true,
        tool_duration_ms: input.toolDurationMs ?? 0,
      };
    case 'handoff':
      return {
        ...base,
        handoff: input.content,
        source_agent: input.sourceAgent ?? '',
        target_agent: input.targetAgent ?? '',
        source_agent_role: input.sourceAgentRole ?? '',
        handoff_context: input.handoffContext ?? '',
        handoff_reason: input.handoffReason ?? '',
      };
  }
}
