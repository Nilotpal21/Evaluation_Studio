import { CONSTRAINT_CHECKPOINT_KIND_KEY, CONSTRAINT_CHECKPOINT_TARGET_KEY } from '../constants.js';

export const DEFAULT_HANDOFF_HISTORY_STRATEGY = 'auto' as const;
export const DEFAULT_AUTO_HANDOFF_HISTORY_FALLBACK_LAST_N = 5 as const;
export const HANDOFF_TIMEOUT_ACTION_VALUES = ['continue', 'escalate'] as const;
export const HANDOFF_ON_RETURN_ACTION_VALUES = ['continue', 'resume_intent'] as const;

export const GUARDRAIL_KIND_VALUES = [
  'input',
  'output',
  'tool_input',
  'tool_output',
  'handoff',
  'both',
] as const;

export const GUARDRAIL_ACTION_VALUES = [
  'block',
  'warn',
  'redact',
  'escalate',
  'fix',
  'reask',
  'filter',
] as const;

export const GUARDRAIL_EXECUTABLE_FIELD_VALUES = ['check', 'provider', 'llm_check'] as const;

export const GUARDRAIL_TIER_INFERENCE = [
  {
    field: 'check',
    tier: 'local',
    semantics:
      'CEL violation predicate evaluated locally; true means the guardrail fires and false means the content passes.',
  },
  {
    field: 'provider',
    tier: 'model',
    semantics:
      'Provider-backed classifier or guardrail service. Threshold applies to the provider score.',
  },
  {
    field: 'llm_check',
    tier: 'llm',
    semantics: 'Natural-language LLM-as-judge evaluation. Threshold applies to the LLM score.',
  },
] as const;

export const DEFAULT_CONTENT_SAFETY_GUARDRAIL = {
  name: 'content_safety',
  kind: 'input',
  field: 'llm_check',
  rule: 'Does the user message request harmful, abusive, threatening, harassing, or unsafe content?',
  action: 'block',
  threshold: 0.8,
  message: "I can't help with that request.",
} as const;

export const DEFAULT_LOCAL_GUARDRAIL_EXAMPLE = {
  name: 'pii_detection',
  kind: 'input',
  field: 'check',
  rule: 'abl.contains_pii(input)',
  action: 'redact',
} as const;

export const BUILTIN_FIELD_REFERENCE_VARS = [
  'channel',
  'language',
  'locale',
  'turn_count',
  'session_id',
  'project_id',
  'tenant_id',
  'user_id',
  'customer_id',
  'input',
  'last_input',
  'intent',
  'abl',
  'result',
  'always',
  'previous_system_message_was_offer',
  CONSTRAINT_CHECKPOINT_KIND_KEY,
  CONSTRAINT_CHECKPOINT_TARGET_KEY,
] as const;

export const TOOL_SESSION_CONTEXT_PARAM_MAP = {
  session_id: 'sessionId',
  tenant_id: 'tenantId',
  user_id: 'userId',
} as const;
