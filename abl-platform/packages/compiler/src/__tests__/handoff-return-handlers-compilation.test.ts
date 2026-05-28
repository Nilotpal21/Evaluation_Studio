import { describe, expect, test } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';

import { compileABLtoIR } from '../platform/ir/compiler.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';

describe('handoff return handlers compilation', () => {
  test('compiles named RETURN_HANDLERS into coordination.return_handlers', () => {
    const dsl = `
AGENT: RouterAgent
GOAL: "Route conversations"

RETURN_HANDLERS:
  await_next_request:
    RESPOND: "What else can I help with?"
    CONTINUE: true

HANDOFF:
  - TO: SpecialistAgent
    WHEN: needs_specialist == true
    RETURN: true
    ON_RETURN:
      HANDLER: await_next_request
    CONTEXT:
      pass: [customer_id]
      summary: "Route to specialist"
`;

    const specialistDsl = `
AGENT: SpecialistAgent
GOAL: "Handle specialist work"
`;

    const router = parseAgentBasedABL(dsl);
    const specialist = parseAgentBasedABL(specialistDsl);

    expect(router.errors).toHaveLength(0);
    expect(specialist.errors).toHaveLength(0);

    const output = compileABLtoIR([router.document!, specialist.document!]);
    const agent = output.agents.RouterAgent;

    expect(agent.coordination?.return_handlers).toEqual({
      await_next_request: {
        respond: 'What else can I help with?',
        continue: true,
        resume_intent: undefined,
        clear: undefined,
      },
    });
    expect(agent.coordination?.handoffs[0].on_return).toEqual({
      handler: 'await_next_request',
    });
  });

  test('compiles handoff ON_FAILURE respond into coordination failure fields', () => {
    const dsl = `
AGENT: RouterAgent
GOAL: "Route conversations"

HANDOFF:
  - TO: SpecialistAgent
    WHEN: needs_specialist == true
    ON_FAILURE: RESPOND "Specialist handoff failed"
    CONTEXT:
      pass: [customer_id]
      summary: "Route to specialist"
    RETURN: true
`;

    const specialistDsl = `
AGENT: SpecialistAgent
GOAL: "Handle specialist work"
`;

    const router = parseAgentBasedABL(dsl);
    const specialist = parseAgentBasedABL(specialistDsl);

    expect(router.errors).toHaveLength(0);
    expect(specialist.errors).toHaveLength(0);

    const output = compileABLtoIR([router.document!, specialist.document!]);
    const agent = output.agents.RouterAgent;

    expect(agent.coordination?.handoffs[0].on_failure).toBe('respond');
    expect(agent.coordination?.handoffs[0].failure_message).toBe('Specialist handoff failed');
  });

  test('does not silently coerce unsupported handoff ON_FAILURE actions', () => {
    const dsl = `
AGENT: RouterAgent
GOAL: "Route conversations"

HANDOFF:
  - TO: SpecialistAgent
    WHEN: needs_specialist == true
    ON_FAILURE: RETRY 3
    CONTEXT:
      pass: [customer_id]
      summary: "Route to specialist"
    RETURN: true
`;

    const specialistDsl = `
AGENT: SpecialistAgent
GOAL: "Handle specialist work"
`;

    const router = parseAgentBasedABL(dsl);
    const specialist = parseAgentBasedABL(specialistDsl);

    expect(router.errors).toHaveLength(0);
    expect(specialist.errors).toHaveLength(0);

    const output = compileABLtoIR([router.document!, specialist.document!]);

    expect(output.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.INVALID_HANDOFF_FAILURE_ACTION,
          path: 'coordination.handoffs[0].on_failure',
          severity: 'error',
        }),
      ]),
    );
  });

  test('preserves legacy inline ON_RETURN shorthand as warning-only compatibility syntax', () => {
    const dsl = `
AGENT: RouterAgent
GOAL: "Route conversations"

HANDOFF:
  - TO: SpecialistAgent
    WHEN: needs_specialist == true
    RETURN: true
    ON_RETURN: "route_authenticated_billing"
    CONTEXT:
      pass: [customer_id]
      summary: "Route to specialist"
`;

    const specialistDsl = `
AGENT: SpecialistAgent
GOAL: "Handle specialist work"
`;

    const router = parseAgentBasedABL(dsl);
    const specialist = parseAgentBasedABL(specialistDsl);

    expect(router.errors).toHaveLength(0);
    expect(specialist.errors).toHaveLength(0);

    const output = compileABLtoIR([router.document!, specialist.document!]);
    const agent = output.agents.RouterAgent;

    expect(output.compilation_errors).toBeUndefined();
    expect(agent.coordination?.handoffs[0].on_return).toBe('route_authenticated_billing');
    expect(output.compilation_warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: VALIDATION_CODES.LEGACY_HANDOFF_ON_RETURN_SHORTHAND,
          path: 'coordination.handoffs[0].on_return',
          severity: 'warning',
        }),
      ]),
    );
  });
});
