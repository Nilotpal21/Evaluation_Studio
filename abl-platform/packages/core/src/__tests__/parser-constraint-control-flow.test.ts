/**
 * Parser Tests: Structured ON_FAIL Blocks in Constraints
 *
 * Tests that the parser correctly handles the new structured ON_FAIL blocks
 * within CONSTRAINTS sections, including COLLECT, GOTO, RETRY, and rich
 * control flow actions.
 *
 * Most tests are expected to FAIL until the parser is updated to support
 * structured ON_FAIL (ConstraintOnFailBlock) parsing.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';
import type { ConstraintOnFailBlock } from '../types/agent-based.js';

describe('Parser: Structured ON_FAIL Blocks in Constraints', () => {
  test('warns when agent CONSTRAINTS uses plain natural-language bullets', () => {
    const dsl = `
AGENT: PolicyAgent
GOAL: "Apply policy guidance"

CONSTRAINTS:
  - "Verify identity before disclosure."
  - "Do not treat deadline language as consent."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.constraints).toHaveLength(0);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        line: 6,
        message: expect.stringContaining('CONSTRAINTS contains 2 plain list items'),
      }),
    ]);
  });

  test('should parse ON_FAIL with COLLECT and THEN', () => {
    const dsl = `
AGENT: BookingAgent
GOAL: "Book a hotel"

CONSTRAINTS:
  pre_booking:
    - REQUIRE user.email IS SET
      ON_FAIL:
        COLLECT: email
        THEN: continue
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.constraints).toBeDefined();
    expect(doc.constraints.length).toBeGreaterThan(0);

    const phase = doc.constraints.find((p) => p.name === 'pre_booking');
    expect(phase).toBeDefined();
    expect(phase!.requirements).toHaveLength(1);

    const req = phase!.requirements[0];
    expect(req.condition).toBe('user.email IS SET');

    // Verify structured ON_FAIL block (not a plain string)
    const onFail = req.onFail as ConstraintOnFailBlock;
    expect(typeof onFail).toBe('object');
    expect(onFail.collect).toEqual(['email']);
    expect(onFail.then).toBe('continue');
  });

  test('should parse ON_FAIL with GOTO and RESPOND', () => {
    const dsl = `
AGENT: SearchAgent
GOAL: "Search for items"

CONSTRAINTS:
  pre_search:
    - REQUIRE search_results.count > 0
      ON_FAIL:
        GOTO: search_step
        RESPOND: "Let me find alternatives."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    const phase = doc.constraints.find((p) => p.name === 'pre_search');
    expect(phase).toBeDefined();

    const req = phase!.requirements[0];
    const onFail = req.onFail as ConstraintOnFailBlock;
    expect(typeof onFail).toBe('object');
    expect(onFail.goto).toBe('search_step');
    expect(onFail.respond).toBe('Let me find alternatives.');
  });

  test('should parse ON_FAIL with RETRY', () => {
    const dsl = `
AGENT: ValidationAgent
GOAL: "Validate user data"

CONSTRAINTS:
  pre_submit:
    - REQUIRE user.age >= 18
      ON_FAIL:
        RETRY: true
        RESPOND: "You must be at least 18 years old."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    const phase = doc.constraints.find((p) => p.name === 'pre_submit');
    expect(phase).toBeDefined();

    const req = phase!.requirements[0];
    const onFail = req.onFail as ConstraintOnFailBlock;
    expect(typeof onFail).toBe('object');
    expect(onFail.retry).toBe(true);
    expect(onFail.respond).toBe('You must be at least 18 years old.');
  });

  test('should parse step-level CHECK with rich ON_FAIL block', () => {
    const dsl = `
AGENT: OrderAgent
GOAL: "Process orders"

FLOW:
  steps:
    - verify_stock
    - place_order

  verify_stock:
    REASONING: false
    CALL: check_inventory
    CHECK: inventory_check
    ON_FAIL:
      COLLECT: alternative_product
      THEN: retry
    THEN: place_order

  place_order:
    REASONING: false
    CALL: submit_order
    RESPOND: "Order placed!"

CONSTRAINTS:
  inventory_check:
    - REQUIRE inventory.available == true
      ON_FAIL: "Item is out of stock."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;

    // Verify the flow step has the CHECK and ON_FAIL block
    const verifyStep = doc.flow!.definitions['verify_stock'];
    expect(verifyStep).toBeDefined();
    expect(verifyStep.check).toBe('inventory_check');

    // The step-level ON_FAIL should be a structured block, not a string target
    const onFail = verifyStep.onFail;
    expect(onFail).toBeDefined();
    // When the parser supports structured ON_FAIL, it should be an object
    expect(typeof onFail).toBe('object');
    const block = onFail as unknown as ConstraintOnFailBlock;
    expect(block.collect).toEqual(['alternative_product']);
    expect(block.then).toBe('retry');
  });

  test('backward compat: string ON_FAIL still works', () => {
    const dsl = `
AGENT: SimpleAgent
GOAL: "Help users"

CONSTRAINTS:
  always:
    - REQUIRE user.verified == true
      ON_FAIL: "Sorry, that's not allowed."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.constraints.length).toBeGreaterThan(0);

    const phase = doc.constraints.find((p) => p.name === 'always');
    expect(phase).toBeDefined();
    expect(phase!.requirements).toHaveLength(1);

    const req = phase!.requirements[0];
    expect(req.condition).toBe('user.verified == true');
    expect(req.onFail).toBe("Sorry, that's not allowed.");
  });

  test('parses LIMIT and RESTRICT as retained constraint kinds', () => {
    const dsl = `
AGENT: PolicyAgent
GOAL: "Apply policy constraints"

CONSTRAINTS:
  limits:
    - LIMIT daily_wire_used + amount <= daily_wire_limit
      ON_FAIL: "Limit exceeded."
    - RESTRICT beneficiary_country IN ["CU", "IR"]
      ON_FAIL: "Destination prohibited."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const phase = result.document!.constraints.find((p) => p.name === 'limits');
    expect(phase).toBeDefined();
    expect(phase!.requirements).toHaveLength(2);
    expect(phase!.requirements[0].kind).toBe('limit');
    expect(phase!.requirements[0].condition).toBe('daily_wire_used + amount <= daily_wire_limit');
    expect(phase!.requirements[1].kind).toBe('restrict');
    expect(phase!.requirements[1].condition).toBe('beneficiary_country IN ["CU", "IR"]');
  });

  test('parses constraint-level WHEN as applicability metadata', () => {
    const dsl = `
AGENT: VoiceSafetyAgent
GOAL: "Apply channel-specific constraints"

CONSTRAINTS:
  always:
    - REQUIRE ssn IS NOT SET
      WHEN: channel == "voice"
      ON_FAIL: "SSN cannot be collected on voice."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const req = result.document!.constraints[0].requirements[0];
    expect(req.kind).toBe('require');
    expect(req.when).toBe('channel == "voice"');
    expect(req.condition).toBe('ssn IS NOT SET');
  });

  test('parses inline constraint-level WHEN as applicability metadata', () => {
    const dsl = `
AGENT: InlineWhenConstraintAgent
GOAL: "Retain inline WHEN syntax from examples"

CONSTRAINTS:
  always:
    - REQUIRE merchant_name != "" OR transaction_amount != null WHEN channel_type == "ivr"
      ON_FAIL: "Need either a merchant or an amount."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const req = result.document!.constraints[0].requirements[0];
    expect(req.when).toBe('channel_type == "ivr"');
    expect(req.condition).toBe('merchant_name != "" OR transaction_amount != null');
  });

  test('parses structural BEFORE targets without folding them into the condition', () => {
    const dsl = `
AGENT: SearchPolicyAgent
GOAL: "Guard structural checkpoints"

CONSTRAINTS:
  always:
    - REQUIRE measure_field IS SET BEFORE calling search_aggregate
      ON_FAIL: "Choose a measure first."
    - REQUIRE aggregation_validated == true BEFORE returning results
      ON_FAIL: "Validate the aggregation before responding."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const [toolReq, respondReq] = result.document!.constraints[0].requirements;
    expect(toolReq.condition).toBe('measure_field IS SET');
    expect(toolReq.before).toEqual({
      kind: 'tool_call',
      raw: 'calling search_aggregate',
      target: 'search_aggregate',
    });
    expect(respondReq.condition).toBe('aggregation_validated == true');
    expect(respondReq.before).toEqual({
      kind: 'respond',
      raw: 'returning results',
    });
  });

  test('retains unsupported BEFORE targets for compiler warnings instead of treating them as plain conditions', () => {
    const dsl = `
AGENT: LegacyBeforeAgent
GOAL: "Retain unsupported BEFORE targets"

CONSTRAINTS:
  - REQUIRE user_verified == true BEFORE action == "view_account"
    ON_FAIL: "Please verify your identity."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const req = result.document!.constraints[0].requirements[0];
    expect(req.condition).toBe('user_verified == true');
    expect(req.before).toEqual({
      kind: 'unsupported',
      raw: 'action == "view_account"',
    });
  });

  test('accepts colon-style constraint keywords from imported DSL', () => {
    const dsl = `
AGENT: ImportedConstraintAgent
GOAL: "Handle imported constraint syntax"

CONSTRAINTS:
  always:
    - REQUIRE: booking_reference IS SET
      ON_FAIL: "Need a booking reference."
    - WARN: traveler_id IS SET
      ON_FAIL: "Traveler context is recommended."
    - LIMIT: search_failures < 3
      ON_FAIL: "Too many search retries."
    - RESTRICT: channel == "voice"
      ON_FAIL: "Voice only."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const requirements = result.document!.constraints[0].requirements;
    expect(requirements).toHaveLength(4);
    expect(requirements[0]).toMatchObject({
      kind: 'require',
      condition: 'booking_reference IS SET',
      severity: 'error',
    });
    expect(requirements[1]).toMatchObject({
      condition: 'traveler_id IS SET',
      severity: 'warning',
    });
    expect(requirements[2]).toMatchObject({
      kind: 'limit',
      condition: 'search_failures < 3',
    });
    expect(requirements[3]).toMatchObject({
      kind: 'restrict',
      condition: 'channel == "voice"',
    });
  });

  test('reports malformed constraint rows without getting stuck on the section', () => {
    const dsl = `
AGENT: ConstraintRecoveryAgent
GOAL: "Recover from malformed imported constraints"

CONSTRAINTS:
  always:
    - REQUIRE:
      ON_FAIL: "Need a condition."
    - WARN traveler_id IS SET
      ON_FAIL: "Traveler context is recommended."
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.document).not.toBeNull();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('Malformed constraint requirement'),
        }),
      ]),
    );

    const requirements = result.document!.constraints[0].requirements;
    expect(requirements).toHaveLength(1);
    expect(requirements[0]).toMatchObject({
      condition: 'traveler_id IS SET',
      severity: 'warning',
    });
  });
});
