/**
 * PASS Field Resolution Tests
 *
 * Verifies that PASS fields in HANDOFF contexts are resolved with type and
 * description from session memory declarations during compilation.
 *
 * Resolution chain:
 * 1. PASS field name → lookup in MEMORY.session → resolve type + description
 * 2. If not found in session memory, defaults to type='string', no description
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import type { ResolvedPassField } from '../platform/ir/schema.js';

describe('PASS Field Resolution', () => {
  test('resolves PASS field descriptions from session memory', () => {
    const dsl = `
AGENT: RouterAgent


GOAL: "Route user requests"

MEMORY:
  session:
    - customer_id
      DESCRIPTION: "Unique customer identifier"
    - plan_type
      DESCRIPTION: "Current subscription plan"

HANDOFF:
  - TO: BillingAgent
    WHEN: user.billing_question
    CONTEXT:
      pass: [customer_id, plan_type]
      summary: "User has a billing question."
`;

    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);
    expect(parseResult.document).not.toBeNull();

    const compiled = compileABLtoIR([parseResult.document!]);
    const agent = compiled.agents['RouterAgent'];
    expect(agent).toBeDefined();

    const handoff = agent.coordination.handoffs[0];
    expect(handoff).toBeDefined();
    expect(handoff.context.pass).toEqual([
      { name: 'customer_id', type: 'string', description: 'Unique customer identifier' },
      { name: 'plan_type', type: 'string', description: 'Current subscription plan' },
    ]);
  });

  test('resolves PASS field type from session memory TYPE declaration', () => {
    const dsl = `
AGENT: RouterAgent


GOAL: "Route user requests"

MEMORY:
  session:
    - outstanding_balance
      TYPE: number
      DESCRIPTION: "Amount owed by the customer in USD"

HANDOFF:
  - TO: BillingAgent
    WHEN: user.billing_question
    CONTEXT:
      pass: [outstanding_balance]
      summary: "User has a billing question."
`;

    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);
    expect(parseResult.document).not.toBeNull();

    // Verify parser captured type and description
    const doc = parseResult.document!;
    const sessionVar = doc.memory.session.find((s) => s.name === 'outstanding_balance');
    expect(sessionVar).toBeDefined();
    expect(sessionVar!.type).toBe('number');
    expect(sessionVar!.description).toBe('Amount owed by the customer in USD');

    const compiled = compileABLtoIR([doc]);
    const agent = compiled.agents['RouterAgent'];
    const handoff = agent.coordination.handoffs[0];

    expect(handoff.context.pass).toEqual([
      {
        name: 'outstanding_balance',
        type: 'number',
        description: 'Amount owed by the customer in USD',
      },
    ]);
  });

  test('defaults to type=string when PASS field not in session memory', () => {
    const dsl = `
AGENT: RouterAgent


GOAL: "Route user requests"

HANDOFF:
  - TO: BillingAgent
    WHEN: user.billing_question
    CONTEXT:
      pass: [customer_id, amount]
      summary: "User has a billing question."
`;

    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);

    const compiled = compileABLtoIR([parseResult.document!]);
    const agent = compiled.agents['RouterAgent'];
    const handoff = agent.coordination.handoffs[0];

    expect(handoff.context.pass).toEqual([
      { name: 'customer_id', type: 'string' },
      { name: 'amount', type: 'string' },
    ]);
  });

  test('handles mixed resolved and unresolved PASS fields', () => {
    const dsl = `
AGENT: RouterAgent


GOAL: "Route user requests"

MEMORY:
  session:
    - customer_id
      DESCRIPTION: "Customer ID from CRM"
      TYPE: string

HANDOFF:
  - TO: BillingAgent
    WHEN: user.billing_question
    CONTEXT:
      pass: [customer_id, unknown_field]
      summary: "Billing inquiry."
`;

    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);

    const compiled = compileABLtoIR([parseResult.document!]);
    const agent = compiled.agents['RouterAgent'];
    const handoff = agent.coordination.handoffs[0];

    const passFields: ResolvedPassField[] = handoff.context.pass;
    expect(passFields).toHaveLength(2);

    // customer_id should be resolved from session memory
    expect(passFields[0]).toEqual({
      name: 'customer_id',
      type: 'string',
      description: 'Customer ID from CRM',
    });

    // unknown_field should default to string, no description
    expect(passFields[1]).toEqual({
      name: 'unknown_field',
      type: 'string',
    });
  });

  test('handles empty PASS array', () => {
    const dsl = `
AGENT: RouterAgent


GOAL: "Route user requests"

HANDOFF:
  - TO: BillingAgent
    WHEN: user.billing_question
    CONTEXT:
      pass: []
      summary: "Billing inquiry."
`;

    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);

    const compiled = compileABLtoIR([parseResult.document!]);
    const agent = compiled.agents['RouterAgent'];
    const handoff = agent.coordination.handoffs[0];

    expect(handoff.context.pass).toEqual([]);
  });

  test('shorthand PASS outside CONTEXT block resolves from session memory', () => {
    const dsl = `
AGENT: RouterAgent


GOAL: "Route user requests"

MEMORY:
  session:
    - user_id
      DESCRIPTION: "Authenticated user ID"
      TYPE: string

HANDOFF:
  - TO: SupportAgent
    WHEN: user.needs_support
    PASS: [user_id, ticket_id]
    SUMMARY: "User needs support."
`;

    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);

    const compiled = compileABLtoIR([parseResult.document!]);
    const agent = compiled.agents['RouterAgent'];
    const handoff = agent.coordination.handoffs[0];

    expect(handoff.context.pass).toEqual([
      { name: 'user_id', type: 'string', description: 'Authenticated user ID' },
      { name: 'ticket_id', type: 'string' },
    ]);
  });

  test('multiple handoffs resolve independently', () => {
    const dsl = `
AGENT: RouterAgent


GOAL: "Route user requests"

MEMORY:
  session:
    - customer_id
      DESCRIPTION: "Customer identifier"
    - account_balance
      TYPE: number
      DESCRIPTION: "Current account balance"

HANDOFF:
  - TO: BillingAgent
    WHEN: user.billing_question
    CONTEXT:
      pass: [customer_id, account_balance]
      summary: "Billing inquiry."
  - TO: SupportAgent
    WHEN: user.support_needed
    CONTEXT:
      pass: [customer_id]
      summary: "Support needed."
`;

    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);

    const compiled = compileABLtoIR([parseResult.document!]);
    const agent = compiled.agents['RouterAgent'];

    expect(agent.coordination.handoffs).toHaveLength(2);

    // First handoff has both fields resolved
    expect(agent.coordination.handoffs[0].context.pass).toEqual([
      { name: 'customer_id', type: 'string', description: 'Customer identifier' },
      { name: 'account_balance', type: 'number', description: 'Current account balance' },
    ]);

    // Second handoff has only customer_id
    expect(agent.coordination.handoffs[1].context.pass).toEqual([
      { name: 'customer_id', type: 'string', description: 'Customer identifier' },
    ]);
  });
});

describe('Parser: Session Memory TYPE and DESCRIPTION', () => {
  test('parses TYPE for session memory variables', () => {
    const dsl = `
AGENT: TestAgent


GOAL: "Test memory parsing"

MEMORY:
  session:
    - balance
      TYPE: number
      INITIAL: 0
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.memory.session).toHaveLength(1);
    expect(doc.memory.session[0].name).toBe('balance');
    expect(doc.memory.session[0].type).toBe('number');
    expect(doc.memory.session[0].initial_value).toBe(0);
  });

  test('parses DESCRIPTION for session memory variables', () => {
    const dsl = `
AGENT: TestAgent


GOAL: "Test memory parsing"

MEMORY:
  session:
    - customer_id
      DESCRIPTION: "Unique customer identifier from CRM"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.memory.session).toHaveLength(1);
    expect(doc.memory.session[0].name).toBe('customer_id');
    expect(doc.memory.session[0].description).toBe('Unique customer identifier from CRM');
  });

  test('parses both TYPE and DESCRIPTION together', () => {
    const dsl = `
AGENT: TestAgent


GOAL: "Test memory parsing"

MEMORY:
  session:
    - outstanding_balance
      TYPE: number
      DESCRIPTION: "Amount owed by the customer in USD"
      INITIAL: 0
      RESET: per_session
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.memory.session).toHaveLength(1);

    const memVar = doc.memory.session[0];
    expect(memVar.name).toBe('outstanding_balance');
    expect(memVar.type).toBe('number');
    expect(memVar.description).toBe('Amount owed by the customer in USD');
    expect(memVar.initial_value).toBe(0);
    expect(memVar.reset).toBe('per_session');
  });

  test('handles multiple session vars with mixed attributes', () => {
    const dsl = `
AGENT: TestAgent


GOAL: "Test memory parsing"

MEMORY:
  session:
    - simple_var
    - typed_var
      TYPE: boolean
    - described_var
      DESCRIPTION: "A variable with a description"
    - full_var
      TYPE: number
      DESCRIPTION: "A fully specified variable"
      INITIAL: 42
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const doc = result.document!;
    expect(doc.memory.session).toHaveLength(4);

    expect(doc.memory.session[0]).toEqual({ name: 'simple_var' });
    expect(doc.memory.session[1]).toEqual({ name: 'typed_var', type: 'boolean' });
    expect(doc.memory.session[2]).toEqual({
      name: 'described_var',
      description: 'A variable with a description',
    });
    expect(doc.memory.session[3]).toEqual({
      name: 'full_var',
      type: 'number',
      description: 'A fully specified variable',
      initial_value: 42,
    });
  });
});
