// REGRESSION: ABLP-1031
/**
 * ABLP-1031 Reproduction Test — HANDOFF vs DELEGATE syntax inconsistency
 *
 * Tests that the parser accepts the unified syntax (`TO:` entry key, `PASS:` keyword)
 * for both HANDOFF and DELEGATE sections.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('ABLP-1031: HANDOFF and DELEGATE should accept unified syntax', () => {
  test('DELEGATE should accept TO: as entry key (like HANDOFF)', () => {
    const dsl = `
AGENT: UnifiedDelegate

GOAL: "Delegate using unified TO: syntax"

DELEGATE:
  - TO: BillingAgent
    WHEN: user asks about billing
    PURPOSE: "Handle billing queries"
    INPUT: { child_user: session.userId }
    RETURNS: { session.result: child.summary }
    USE_RESULT: "Answer based on billing result"
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.delegate).toHaveLength(1);
    expect(result.document!.delegate[0].agent).toBe('BillingAgent');
  });

  test('DELEGATE should accept SUMMARY: as alias for PURPOSE:', () => {
    const dsl = `
AGENT: SummaryAlias

GOAL: "Delegate using SUMMARY keyword"

DELEGATE:
  - AGENT: AnalyticsAgent
    WHEN: user asks for analytics
    SUMMARY: "Provide analytics summary"
    INPUT: {}
    RETURNS: {}
    USE_RESULT: "Show the analytics to the user"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.delegate).toHaveLength(1);

    expect(result.document!.delegate[0].purpose).toBe('Provide analytics summary');
  });

  test('DELEGATE should accept PASS: as alias for INPUT:', () => {
    const dsl = `
AGENT: PassAlias

GOAL: "Delegate using PASS keyword"

DELEGATE:
  - AGENT: SearchAgent
    WHEN: user wants to search
    PURPOSE: "Search for information"
    PASS: { query: session.lastMessage }
    RETURNS: { session.searchResult: child.result }
    USE_RESULT: "Show search results"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.delegate).toHaveLength(1);

    expect(result.document!.delegate[0].input).toEqual({ query: 'session.lastMessage' });
  });

  test('DELEGATE multiline PASS should not consume following SUMMARY alias', () => {
    const dsl = `
AGENT: PassBlockSummary

GOAL: "Delegate using multiline PASS and SUMMARY"

DELEGATE:
  - TO: SearchAgent
    WHEN: user wants to search
    PASS:
      query: session.lastMessage
    SUMMARY: "Search for information"
    RETURNS: { session.searchResult: child.result }
    USE_RESULT: "Show search results"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.delegate).toHaveLength(1);

    expect(result.document!.delegate[0].input).toEqual({ query: 'session.lastMessage' });
    expect(result.document!.delegate[0].purpose).toBe('Search for information');
  });

  test('HANDOFF should accept PASS: as alias for CONTEXT.pass:', () => {
    const dsl = `
AGENT: HandoffPass

GOAL: "Handoff using PASS keyword"

HANDOFF:
  - TO: SupportAgent
    WHEN: user needs support
    PASS: [userId, orderId]
    SUMMARY: "User needs help with order"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.handoff).toHaveLength(1);

    expect(result.document!.handoff[0].context.pass).toEqual(['userId', 'orderId']);
  });

  test('HANDOFF should accept multiline PASS block as alias for CONTEXT.pass', () => {
    const dsl = `
AGENT: HandoffPassBlock

GOAL: "Handoff using multiline PASS keyword"

HANDOFF:
  - TO: SupportAgent
    WHEN: user needs support
    PASS:
      - userId
      - orderId
    SUMMARY: "User needs help with order"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.handoff).toHaveLength(1);

    expect(result.document!.handoff[0].context.pass).toEqual(['userId', 'orderId']);
    expect(result.document!.handoff[0].context.summary).toBe('User needs help with order');
  });

  test('HANDOFF should accept multiline CONTEXT pass block', () => {
    const dsl = `
AGENT: HandoffContextPassBlock

GOAL: "Handoff using multiline CONTEXT pass"

HANDOFF:
  - TO: SupportAgent
    WHEN: user needs support
    CONTEXT:
      pass:
        - userId
        - orderId
      summary: "User needs help with order"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.handoff).toHaveLength(1);

    expect(result.document!.handoff[0].context.pass).toEqual(['userId', 'orderId']);
    expect(result.document!.handoff[0].context.summary).toBe('User needs help with order');
  });

  test('HANDOFF should accept SUMMARY: at top level (not nested under CONTEXT:)', () => {
    const dsl = `
AGENT: HandoffSummary

GOAL: "Handoff using top-level SUMMARY"

HANDOFF:
  - TO: EscalationAgent
    WHEN: user is frustrated
    SUMMARY: "User is frustrated about billing"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.handoff).toHaveLength(1);

    expect(result.document!.handoff[0].context.summary).toBe('User is frustrated about billing');
  });

  test('existing AGENT: syntax in DELEGATE still works (backward compat control)', () => {
    const dsl = `
AGENT: LegacyDelegate

GOAL: "Delegate using legacy AGENT: syntax"

DELEGATE:
  - AGENT: WorkerAgent
    WHEN: always
    PURPOSE: "Do work"
    INPUT: {}
    RETURNS: {}
    USE_RESULT: "Use the result"
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.delegate).toHaveLength(1);
    expect(result.document!.delegate[0].agent).toBe('WorkerAgent');
    expect(result.document!.delegate[0].purpose).toBe('Do work');
  });
});
