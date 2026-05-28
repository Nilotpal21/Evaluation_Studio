/**
 * Parser Tests: Handoff return expectation keys
 *
 * Both EXPECT_RETURN and RETURN are intentionally accepted in HANDOFF configs.
 * EXPECT_RETURN is the clearer preferred authored form, while RETURN remains
 * backward compatible.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('Parser: handoff return expectation keys', () => {
  test('should parse EXPECT_RETURN: true as handoff.return === true', () => {
    const dsl = `
AGENT: MainAgent
GOAL: "Route user requests"

HANDOFF:
  - TO: SupportAgent
    WHEN: user.needs_help
    EXPECT_RETURN: true
    CONTEXT:
      pass: [user_id, issue_category]
      summary: "User needs help with their account."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.warnings).toEqual([]);

    const doc = result.document!;
    expect(doc.handoff).toBeDefined();
    expect(doc.handoff).toHaveLength(1);

    const handoff = doc.handoff[0];
    expect(handoff.to).toBe('SupportAgent');
    expect(handoff.when).toBe('user.needs_help');
    expect(handoff.return).toBe(true);
    expect(handoff.context.pass).toEqual(['user_id', 'issue_category']);
    expect(handoff.context.summary).toBe('User needs help with their account.');
  });

  test('should parse EXPECT_RETURN: false overriding RETURN: true when both are present', () => {
    // Use both keys to prove EXPECT_RETURN remains the clearer authored form
    // while RETURN stays backward compatible.
    const dsl = `
AGENT: DispatchAgent
GOAL: "Dispatch tasks"

HANDOFF:
  - TO: BillingAgent
    WHEN: user.billing_question
    RETURN: true
    EXPECT_RETURN: false
    CONTEXT:
      pass: [user_id]
      summary: "Billing inquiry."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.warnings).toEqual([]);

    const doc = result.document!;
    expect(doc.handoff).toHaveLength(1);

    const handoff = doc.handoff[0];
    expect(handoff.to).toBe('BillingAgent');
    // EXPECT_RETURN: false should override RETURN: true
    expect(handoff.return).toBe(false);
  });

  test('backward compat: RETURN still works', () => {
    const dsl = `
AGENT: RouterAgent
GOAL: "Route conversations"

HANDOFF:
  - TO: SpecialistAgent
    WHEN: user.complex_issue
    RETURN: true
    ON_RETURN:
      action: resume_step
    CONTEXT:
      pass: [user_id, conversation_id]
      summary: "Complex issue requiring specialist."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.warnings).toEqual([]);

    const doc = result.document!;
    expect(doc.handoff).toBeDefined();
    expect(doc.handoff).toHaveLength(1);

    const handoff = doc.handoff[0];
    expect(handoff.to).toBe('SpecialistAgent');
    expect(handoff.when).toBe('user.complex_issue');
    expect(handoff.return).toBe(true);
    expect(handoff.onReturn).toEqual({ action: 'resume_step' });
    expect(handoff.context.pass).toEqual(['user_id', 'conversation_id']);
    expect(handoff.context.summary).toBe('Complex issue requiring specialist.');
  });

  test('parses RETURN_HANDLERS and handler shorthand references', () => {
    const dsl = `
AGENT: RouterAgent
GOAL: "Route conversations"

RETURN_HANDLERS:
  await_next_request:
    RESPOND: "What else can I help with?"
    CONTINUE: true

  reclassify_intent:
    CLEAR: [current_intent]
    CONTINUE: true

HANDOFF:
  - TO: SpecialistAgent
    WHEN: user.complex_issue
    RETURN: true
    ON_RETURN:
      handler: await_next_request
    CONTEXT:
      pass: [user_id, conversation_id]
      summary: "Complex issue requiring specialist."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.returnHandlers).toEqual({
      await_next_request: {
        respond: 'What else can I help with?',
        continue: true,
      },
      reclassify_intent: {
        clear: ['current_intent'],
        continue: true,
      },
    });
    expect(doc.handoff[0].onReturn).toEqual({ handler: 'await_next_request' });
  });

  test('parses legacy inline ON_RETURN shorthand as a compatibility string', () => {
    const dsl = `
AGENT: RouterAgent
GOAL: "Route conversations"

HANDOFF:
  - TO: SpecialistAgent
    WHEN: user.complex_issue
    RETURN: true
    ON_RETURN: "await_next_request"
    CONTEXT:
      pass: [user_id, conversation_id]
      summary: "Complex issue requiring specialist."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    expect(result.document!.handoff[0].onReturn).toBe('await_next_request');
  });

  test('parses explicit handoff memory_grants entries', () => {
    const dsl = `
AGENT: RouterAgent
GOAL: "Route with scoped grants"

HANDOFF:
  - TO: SpecialistAgent
    WHEN: needs_specialist
    CONTEXT:
      pass: [customer_id]
      summary: "Resume specialist work"
      memory_grants:
        - path: workflow.auth_token
          access: readwrite
        - path: user.preference
          access: read
    RETURN: false
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const handoff = result.document!.handoff[0];
    expect(handoff.context.memoryGrants).toEqual([
      { path: 'workflow.auth_token', access: 'readwrite' },
      { path: 'user.preference', access: 'read' },
    ]);
  });

  test('parses typed handoff history block in legacy ABL', () => {
    const dsl = `
AGENT: RouterAgent
GOAL: "Route with bounded history"

HANDOFF:
  - TO: SpecialistAgent
    WHEN: needs_specialist
    CONTEXT:
      summary: "Resume specialist work"
      history:
        mode: last_n
        count: 4
    RETURN: false
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    expect(result.document!.handoff[0].context.history).toEqual({
      mode: 'last_n',
      count: 4,
    });
  });

  test('parses handoff ON_FAILURE fallback actions', () => {
    const dsl = `
AGENT: RouterAgent
GOAL: "Route with explicit failure handling"

HANDOFF:
  - TO: SpecialistAgent
    WHEN: needs_specialist
    ON_FAILURE: RESPOND "Specialist handoff failed"
    CONTEXT:
      pass: [customer_id]
      summary: "Resume specialist work"
    RETURN: false
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const handoff = result.document!.handoff[0];
    expect(handoff.onFailure).toBe('RESPOND "Specialist handoff failed"');
  });
});
