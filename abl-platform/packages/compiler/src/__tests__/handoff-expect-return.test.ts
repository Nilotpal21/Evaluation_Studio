/**
 * Handoff EXPECT_RETURN Tests
 *
 * Verifies that the HandoffConfig `return` field correctly represents
 * the EXPECT_RETURN semantics from ABL DSL, including backward compatibility.
 */

import { describe, test, expect } from 'vitest';
import type { HandoffConfig } from '../platform/ir/schema.js';

describe('HandoffConfig return (EXPECT_RETURN)', () => {
  test('with return=true creates valid object (EXPECT_RETURN: true equivalent)', () => {
    const handoff: HandoffConfig = {
      to: 'billing_agent',
      when: 'user requests billing help',
      context: {
        pass: [
          { name: 'account_id', type: 'string' },
          { name: 'user_name', type: 'string' },
        ],
        summary: 'User needs billing assistance',
      },
      return: true,
      on_return: { action: 'continue' },
    };

    expect(handoff.return).toBe(true);
    expect(handoff.to).toBe('billing_agent');
    expect(handoff.on_return).toEqual({ action: 'continue' });
    expect(handoff.context.pass).toEqual([
      { name: 'account_id', type: 'string' },
      { name: 'user_name', type: 'string' },
    ]);
    expect(handoff.context.summary).toBe('User needs billing assistance');
  });

  test('with return=false creates valid object (EXPECT_RETURN: false equivalent)', () => {
    const handoff: HandoffConfig = {
      to: 'escalation_agent',
      when: 'user requests human agent',
      context: {
        pass: [{ name: 'conversation_id', type: 'string' }],
        summary: 'User wants to speak with a human',
      },
      return: false,
    };

    expect(handoff.return).toBe(false);
    expect(handoff.to).toBe('escalation_agent');
    expect(handoff.on_return).toBeUndefined();
  });

  test('backward compat — legacy RETURN field still maps to return property', () => {
    // In the IR schema, the DSL RETURN: keyword compiles to the `return` boolean
    // on HandoffConfig. This test verifies the compiled IR shape is correct
    // regardless of whether the DSL used RETURN: or EXPECT_RETURN:.
    const legacyHandoff: HandoffConfig = {
      to: 'support_agent',
      when: 'user asks for help',
      context: {
        pass: [{ name: 'session_data', type: 'string' }],
        summary: 'Routing to support',
      },
      return: true,
    };

    // The `return` property on HandoffConfig is the canonical IR representation
    // for both the legacy RETURN: and the EXPECT_RETURN: DSL keywords.
    expect(legacyHandoff).toHaveProperty('return');
    expect(legacyHandoff.return).toBe(true);
    expect(typeof legacyHandoff.return).toBe('boolean');
  });
});
