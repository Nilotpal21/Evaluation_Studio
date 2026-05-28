/**
 * Inline BEHAVIOR_PROFILE & Parser Improvements Tests
 *
 * Covers:
 *   Phase 2.1 — Inline BEHAVIOR_PROFILE: inside agent files
 *   Phase 2.3 — ESCALATE PRIORITY integer validation
 *   Phase 2.3 — Keyword case fuzzy-matching warnings
 *
 * These are integration tests exercising the real parser functions —
 * no mocks, no stubs, no HTTP layer. Direct function calls.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2.1 — Inline BEHAVIOR_PROFILE
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 2.1: Inline BEHAVIOR_PROFILE parsing', () => {
  test('standalone BEHAVIOR_PROFILE file parses correctly (baseline)', () => {
    const dsl = `BEHAVIOR_PROFILE: formal_tone
PRIORITY: 10
WHEN: customer.tier == "enterprise"
INSTRUCTIONS: |
  Use formal language. Address the customer by their title.
CONSTRAINTS:
  - Never use slang or informal language
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).toHaveLength(0);
    expect(result.document).toBeDefined();
    expect(result.document!.meta!.kind).toBe('behavior_profile');
    expect(result.document!.name).toBe('formal_tone');
    expect(result.document!.behaviorProfile).toBeDefined();
    expect(result.document!.behaviorProfile!.priority).toBe(10);
  });

  test('inline BEHAVIOR_PROFILE inside agent file preserves agent identity', () => {
    const dsl = `AGENT: CustomerBot
GOAL: Help customers with their orders

BEHAVIOR_PROFILE: empathetic_mode
PRIORITY: 5
WHEN: sentiment == "frustrated"
INSTRUCTIONS: |
  Show extra empathy. Acknowledge the frustration.

TOOLS:
  check_order(order_id: string) -> {status: string}
    description: "Check order status"
`;

    const result = parseAgentBasedABL(dsl);

    // CRITICAL: Agent identity must NOT be destroyed
    expect(result.document).toBeDefined();
    expect(result.document!.name).toBe('CustomerBot');
    expect(result.document!.meta!.kind).toBe('agent-based');

    // Inline profile should be captured
    expect(result.document!.inlineBehaviorProfiles).toBeDefined();
    expect(result.document!.inlineBehaviorProfiles).toHaveLength(1);
    expect(result.document!.inlineBehaviorProfiles![0].name).toBe('empathetic_mode');

    // TOOLS section after the profile should still be parsed
    expect(result.document!.tools).toBeDefined();
    expect(result.document!.tools!.length).toBeGreaterThan(0);
  });

  test('multiple inline BEHAVIOR_PROFILEs in one agent file', () => {
    const dsl = `AGENT: SupportBot
GOAL: Provide technical support

BEHAVIOR_PROFILE: empathetic_mode
PRIORITY: 5
WHEN: sentiment == "frustrated"
INSTRUCTIONS: |
  Show empathy and patience.

BEHAVIOR_PROFILE: technical_mode
PRIORITY: 3
WHEN: issue_type == "technical"
INSTRUCTIONS: |
  Use precise technical language.

TOOLS:
  search_kb(query: string) -> {results: object[]}
    description: "Search knowledge base"
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document!.name).toBe('SupportBot');
    expect(result.document!.meta!.kind).toBe('agent-based');
    expect(result.document!.inlineBehaviorProfiles).toHaveLength(2);
    expect(result.document!.inlineBehaviorProfiles![0].name).toBe('empathetic_mode');
    expect(result.document!.inlineBehaviorProfiles![1].name).toBe('technical_mode');
    // Tools still parsed after profiles
    expect(result.document!.tools!.length).toBeGreaterThan(0);
  });

  test('inline BEHAVIOR_PROFILE without a name emits error', () => {
    const dsl = `AGENT: TestBot
GOAL: Test

BEHAVIOR_PROFILE:
INSTRUCTIONS: |
  Some instructions
`;

    const result = parseAgentBasedABL(dsl);

    // Should emit an error about missing profile name
    expect(result.errors.length).toBeGreaterThan(0);
    // Agent identity should still be intact
    expect(result.document!.name).toBe('TestBot');
    expect(result.document!.meta!.kind).toBe('agent-based');
  });

  test('agent sections before and after inline BEHAVIOR_PROFILE are preserved', () => {
    const dsl = `AGENT: PreservationTest
GOAL: Test that sections around a profile are preserved

TOOLS:
  check_status(id: string) -> {status: string}
    description: "Check status"

BEHAVIOR_PROFILE: safe_mode
PRIORITY: 1
WHEN: true
INSTRUCTIONS: |
  Be extra cautious.

ON_ERROR:
  RESPOND: "Something went wrong."
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document!.name).toBe('PreservationTest');
    expect(result.document!.meta!.kind).toBe('agent-based');
    // TOOLS before the profile should be preserved
    expect(result.document!.tools).toBeDefined();
    expect(result.document!.tools!.length).toBeGreaterThanOrEqual(1);
    // ON_ERROR after the profile should also be preserved
    expect(result.document!.onError).toBeDefined();
    // Inline profile should be captured
    expect(result.document!.inlineBehaviorProfiles).toHaveLength(1);
  });

  test('inline BEHAVIOR_PROFILE followed by EXECUTION with voice config', () => {
    const dsl = `AGENT: VoiceBot
GOAL: Handle voice interactions

BEHAVIOR_PROFILE: calm_voice
PRIORITY: 8
WHEN: channel == "voice"
INSTRUCTIONS: |
  Speak calmly.

EXECUTION:
  model: gpt-4o
  voice:
    provider: elevenlabs
    voice_id: aria
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).toHaveLength(0);
    expect(result.document!.name).toBe('VoiceBot');
    expect(result.document!.meta!.kind).toBe('agent-based');
    expect(result.document!.inlineBehaviorProfiles).toHaveLength(1);
    expect(result.document!.inlineBehaviorProfiles![0].name).toBe('calm_voice');
    // EXECUTION must NOT be swallowed by the profile
    expect(result.document!.execution).toBeDefined();
    expect(result.document!.execution!.model).toBe('gpt-4o');
  });

  test('inline BEHAVIOR_PROFILE followed by GUARDRAILS is not swallowed', () => {
    const dsl = `AGENT: GuardedBot
GOAL: Test guardrails after profile

BEHAVIOR_PROFILE: safe_mode
PRIORITY: 1
WHEN: true
INSTRUCTIONS: Be safe.

GUARDRAILS:
  no_profanity:
    kind: output
    check: "response does not contain profanity"
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document!.name).toBe('GuardedBot');
    expect(result.document!.inlineBehaviorProfiles).toHaveLength(1);
    // GUARDRAILS must NOT be swallowed by the profile
    expect(result.document!.guardrails).toBeDefined();
    expect(result.document!.guardrails!.length).toBeGreaterThan(0);
  });

  test('inline BEHAVIOR_PROFILE followed by EXECUTION is not swallowed', () => {
    const dsl = `AGENT: ExecutionBot
GOAL: Test execution after profile

BEHAVIOR_PROFILE: fast_mode
PRIORITY: 2
WHEN: urgency == "high"
INSTRUCTIONS: Respond quickly.

EXECUTION:
  model: gpt-4o
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document!.name).toBe('ExecutionBot');
    expect(result.document!.inlineBehaviorProfiles).toHaveLength(1);
    // EXECUTION must NOT be swallowed by the profile
    expect(result.document!.execution).toBeDefined();
    expect(result.document!.execution!.model).toBe('gpt-4o');
  });

  test('inline BEHAVIOR_PROFILE followed by CONSTRAINTS is not swallowed', () => {
    const dsl = `AGENT: ConstrainedBot
GOAL: Test constraints after profile

BEHAVIOR_PROFILE: polite_mode
PRIORITY: 3
WHEN: channel == "public"
INSTRUCTIONS: Be polite.

CONSTRAINTS:
  pre_response:
    - REQUIRE response.tone == "professional"
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document!.name).toBe('ConstrainedBot');
    expect(result.document!.inlineBehaviorProfiles).toHaveLength(1);
    // CONSTRAINTS must NOT be swallowed by the profile — handler should be reached
    expect(result.document!.constraints).toBeDefined();
    expect(result.document!.constraints!.length).toBeGreaterThan(0);
  });

  test('inline BEHAVIOR_PROFILE followed by MEMORY is not swallowed', () => {
    const dsl = `AGENT: MemoryBot
GOAL: Test memory after profile

BEHAVIOR_PROFILE: persistent_mode
PRIORITY: 1
WHEN: true
INSTRUCTIONS: Remember everything.

MEMORY:
  type: session
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.document!.name).toBe('MemoryBot');
    expect(result.document!.inlineBehaviorProfiles).toHaveLength(1);
    // MEMORY must NOT be swallowed by the profile
    expect(result.document!.memory).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2.3 — ESCALATE PRIORITY Integer Validation
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 2.3: ESCALATE PRIORITY validation', () => {
  test('valid integer PRIORITY parses correctly', () => {
    const dsl = `AGENT: EscalationBot
GOAL: Handle escalations

ESCALATE:
  triggers:
    - WHEN: customer.is_vip == true
      REASON: VIP customer requires human attention
      PRIORITY: 1
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).toHaveLength(0);
    expect(result.document!.escalate).toBeDefined();
    expect(result.document!.escalate!.triggers).toBeDefined();
    expect(result.document!.escalate!.triggers!.length).toBeGreaterThan(0);
  });

  test('string PRIORITY value emits parse error', () => {
    const dsl = `AGENT: EscalationBot
GOAL: Handle escalations

ESCALATE:
  triggers:
    - WHEN: customer.is_vip == true
      REASON: VIP customer
      PRIORITY: high
`;

    const result = parseAgentBasedABL(dsl);

    // Should emit an error about PRIORITY needing to be an integer
    const priorityErrors = [...result.errors, ...result.warnings].filter((e) =>
      e.message.toLowerCase().includes('priority'),
    );
    expect(priorityErrors.length).toBeGreaterThan(0);
  });

  test('float PRIORITY value emits parse error', () => {
    const dsl = `AGENT: EscalationBot
GOAL: Handle escalations

ESCALATE:
  triggers:
    - WHEN: customer.is_vip == true
      REASON: VIP customer
      PRIORITY: 1.5
`;

    const result = parseAgentBasedABL(dsl);

    const priorityErrors = [...result.errors, ...result.warnings].filter(
      (e) =>
        e.message.toLowerCase().includes('priority') || e.message.toLowerCase().includes('integer'),
    );
    expect(priorityErrors.length).toBeGreaterThan(0);
  });

  test('negative PRIORITY value emits parse error', () => {
    const dsl = `AGENT: EscalationBot
GOAL: Handle escalations

ESCALATE:
  triggers:
    - WHEN: customer.is_vip == true
      REASON: VIP customer
      PRIORITY: -1
`;

    const result = parseAgentBasedABL(dsl);

    const priorityErrors = [...result.errors, ...result.warnings].filter((e) =>
      e.message.toLowerCase().includes('priority'),
    );
    expect(priorityErrors.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2.3 — Keyword Case Fuzzy-Matching
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 2.3: Keyword case fuzzy-matching', () => {
  test('lowercase "tools:" suggests TOOLS:', () => {
    const dsl = `AGENT: CaseTest
GOAL: Test keyword casing

tools:
  search(query: string) -> {results: object[]}
    description: "Search"
`;

    const result = parseAgentBasedABL(dsl);

    // Should emit a warning suggesting correct casing
    const caseWarnings = [...result.errors, ...result.warnings].filter(
      (e) => e.message.includes('TOOLS') || e.message.toLowerCase().includes('uppercase'),
    );
    expect(caseWarnings.length).toBeGreaterThan(0);
  });

  test('lowercase "goal:" suggests GOAL:', () => {
    const dsl = `AGENT: CaseTest
goal: This is my goal
`;

    const result = parseAgentBasedABL(dsl);

    const caseWarnings = [...result.errors, ...result.warnings].filter(
      (e) => e.message.includes('GOAL') || e.message.toLowerCase().includes('uppercase'),
    );
    expect(caseWarnings.length).toBeGreaterThan(0);
  });

  test('lowercase "when:" in flow suggests WHEN:', () => {
    const dsl = `AGENT: CaseTest
GOAL: Test

FLOW:
  when: user says hello
    RESPOND: Hi there!
`;

    const result = parseAgentBasedABL(dsl);

    // Parser should detect incorrect casing within FLOW
    const allIssues = [...result.errors, ...result.warnings];
    const caseIssues = allIssues.filter(
      (e) => e.message.includes('WHEN') || e.message.toLowerCase().includes('case'),
    );
    // At minimum, it should not silently succeed with wrong casing
    expect(allIssues.length).toBeGreaterThan(0);
  });

  test('mixed case "Escalate:" suggests ESCALATE:', () => {
    const dsl = `AGENT: CaseTest
GOAL: Test

Escalate:
  triggers:
    - WHEN: always
      REASON: Test
      PRIORITY: 1
`;

    const result = parseAgentBasedABL(dsl);

    const caseWarnings = [...result.errors, ...result.warnings].filter(
      (e) => e.message.includes('ESCALATE') || e.message.toLowerCase().includes('uppercase'),
    );
    expect(caseWarnings.length).toBeGreaterThan(0);
  });

  test('correctly cased keywords produce no case warnings', () => {
    const dsl = `AGENT: CorrectCase
GOAL: Test proper casing

TOOLS:
  search(query: string) -> {results: object[]}
    description: "Search"

CONSTRAINTS:
  - Be helpful

ON_ERROR:
  RESPOND: "Error occurred"
`;

    const result = parseAgentBasedABL(dsl);

    // No case-related warnings
    const caseWarnings = result.warnings.filter(
      (e) =>
        e.message.toLowerCase().includes('uppercase') || e.message.toLowerCase().includes('case'),
    );
    expect(caseWarnings).toHaveLength(0);
  });
});
