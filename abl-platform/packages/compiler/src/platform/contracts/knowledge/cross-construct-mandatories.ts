import type { MandatoryRule } from './types.js';

/**
 * Cross-construct mandatory rules promoted from prompt-only guidance into a
 * typed compiler-owned registry.
 */
export const CROSS_CONSTRUCT_MANDATORIES: readonly MandatoryRule[] = [
  {
    ruleId: 'AGENT_REQUIRES_GOAL',
    description: 'Every AGENT must declare a GOAL.',
    appliesToConstruct: 'AGENT',
    coverage: 'advisory',
    rationale: 'Agents without explicit goals drift in long sessions.',
  },
  {
    ruleId: 'AGENT_REQUIRES_PERSONA',
    description: 'Every AGENT should declare a PERSONA.',
    appliesToConstruct: 'AGENT',
    coverage: 'advisory',
    rationale: 'Agents without persona guidance produce inconsistent output.',
  },
  {
    ruleId: 'AGENT_NEEDS_REASONING_OR_RESPOND',
    description:
      'An agent must have a reasoning zone, a FLOW respond step, a COMPLETE response, or a default HANDOFF.',
    appliesToConstruct: 'AGENT',
    coverage: 'enforced',
    rationale:
      'Empty-response behavior is a top production risk and is checked by Arch feasibility.',
  },
  {
    ruleId: 'TOOLS_REQUIRE_PROJECT_TOOL_BINDING',
    description: 'Every TOOLS reference must have a matching ProjectTool implementation.',
    appliesToConstruct: 'TOOLS',
    coverage: 'enforced',
    rationale: 'Tool references must resolve before Arch can safely propose a tool-binding change.',
  },
  {
    ruleId: 'VOICE_CHANNEL_NEEDS_REALTIME_MODEL',
    description:
      'A voice-channel agent must reference a model with realtime voice capability and usable credentials.',
    appliesToConstruct: 'CHANNEL',
    coverage: 'enforced',
    rationale: 'Voice/runtime compatibility is checked before proposal application.',
  },
  {
    ruleId: 'PROVIDER_MUST_BE_IN_TENANT_ALLOWLIST',
    description: "A model's provider must be allowed by the tenant policy.",
    appliesToConstruct: 'MODEL',
    coverage: 'enforced',
    rationale: 'Tenant model policy violations must be caught before users apply proposals.',
  },
];
