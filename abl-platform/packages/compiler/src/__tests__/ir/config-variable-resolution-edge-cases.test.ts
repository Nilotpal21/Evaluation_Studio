/**
 * Config Variable Resolution — Edge Case Tests
 *
 * Tests that expose bugs and gaps in the compile-time {{config.KEY}} resolution:
 *
 * 1. Mutation side-effect: resolveConfigVariables mutates the IR in-place.
 *    Calling it twice with different vars corrupts the IR.
 * 2. Regex state: CONFIG_VAR_PATTERN uses /g flag, which has lastIndex state.
 *    If the regex is reused across calls without reset, matches may be skipped.
 * 3. Value containing {{config.X}}: if a config var's value itself contains
 *    {{config.OTHER}}, it is NOT recursively resolved (single-pass).
 *    This is likely intentional but undocumented.
 * 4. Value containing regex special chars ($, \): replacement via .replace()
 *    may interpret $1, $&, etc. as special replacement patterns.
 * 5. Key case sensitivity: {{config.api_key}} vs {{config.API_KEY}} — keys
 *    are case-sensitive in the pattern but config vars may be stored uppercase.
 * 6. Partial match: {{config.}} (empty key) or {{config.KEY with spaces}}.
 * 7. Tool auth_profile_ref is preserved — but only for top-level. Nested refs
 *    in non-skipped fields could contain auth_profile_ref references.
 * 8. IR fields not walked: execution is never walked — config vars in execution
 *    fields (timeouts, hints) are silently ignored.
 * 9. flow.steps might contain config vars — verify they're resolved.
 */

import { describe, test, expect } from 'vitest';
import { resolveConfigVariables } from '../../platform/ir/compiler.js';
import type { AgentIR } from '../../platform/ir/schema.js';

// Helper: create a minimal IR for testing
function makeMinimalIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'Test_Agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    },
    execution: {
      hints: {
        voice_optimized: false,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        tool_timeout_ms: 30000,
        llm_timeout_ms: 30000,
        session_timeout_ms: 1800000,
        voice_latency_target_ms: 1000,
      },
    },
    identity: {
      goal: 'Help users',
      persona: 'A helpful assistant',
      limitations: [],
      system_prompt: {
        template: 'You are an agent.',
        sections: { context: true, tools: false, constraints: false, history: true },
      },
    },
    tools: [],
    gather: { fields: [], strategy: 'hybrid' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: {
      handlers: [],
      default_handler: {
        type: 'default',
        respond: 'Error occurred',
        retry: 1,
        retry_delay_ms: 1000,
        then: 'continue',
      },
    },
    ...overrides,
  };
}

// ===========================================================================
// Edge Case 1: In-place mutation — calling resolveConfigVariables twice
//
// BUG: resolveConfigVariables mutates the IR object directly. If called
// twice (e.g., first with partial vars, then with full vars), the first
// call's replacements are permanent and can't be undone.
// ===========================================================================

describe('resolveConfigVariables — in-place mutation hazard', () => {
  test('documents that calling twice consumes placeholders on first call (by design)', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'Use {{config.API_URL}} for API',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    // First call resolves API_URL — mutates IR in place
    resolveConfigVariables(ir, { API_URL: 'https://v1.example.com' });
    expect(ir.identity.goal).toBe('Use https://v1.example.com for API');

    // Second call: placeholder is already consumed, so the first
    // resolution is permanent. This is by design — callers must
    // re-compile from source if they need different values.
    resolveConfigVariables(ir, { API_URL: 'https://v2.example.com' });
    expect(ir.identity.goal).toBe('Use https://v1.example.com for API');
  });
});

// ===========================================================================
// Edge Case 2: Config value containing replacement pattern special chars
//
// BUG: String.prototype.replace() interprets $& (whole match), $1 (capture
// group), $` (before match), $' (after match) as special sequences.
// A config value like "price: $1.00" or "match: $&" will be mangled.
// ===========================================================================

describe('resolveConfigVariables — replacement pattern special characters', () => {
  test('config value containing $1 should not be interpreted as capture group', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'Price is {{config.PRICE}}',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    resolveConfigVariables(ir, { PRICE: '$1.00 per unit' });

    // BUG: If .replace() uses the value as-is, $1 is interpreted as
    // backreference to capture group 1 (the key name).
    // Expected: 'Price is $1.00 per unit'
    // Actual with bug: 'Price is PRICE.00 per unit' (or similar)
    expect(ir.identity.goal).toBe('Price is $1.00 per unit');
  });

  test('config value containing $& should not be interpreted as full match', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'Pattern: {{config.PATTERN}}',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    resolveConfigVariables(ir, { PATTERN: 'match $& here' });

    // BUG: $& in replacement string becomes the full match ({{config.PATTERN}})
    // Expected: 'Pattern: match $& here'
    // Actual with bug: 'Pattern: match {{config.PATTERN}} here'
    expect(ir.identity.goal).toBe('Pattern: match $& here');
  });

  test("config value containing $` and $' should be literal", () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'Template: {{config.TPL}}',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    resolveConfigVariables(ir, { TPL: "before $` and after $'" });

    // $` = text before match, $' = text after match
    expect(ir.identity.goal).toBe("Template: before $` and after $'");
  });
});

// ===========================================================================
// Edge Case 3: Config value containing another config placeholder
//
// Not a bug per se, but documents that resolution is single-pass.
// If a user sets config var A = "{{config.B}}", the nested reference
// is NOT resolved.
// ===========================================================================

describe('resolveConfigVariables — no recursive resolution', () => {
  test('nested {{config.X}} in config value is not resolved', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'URL: {{config.FULL_URL}}',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    resolveConfigVariables(ir, {
      FULL_URL: '{{config.BASE}}/api',
      BASE: 'https://example.com',
    });

    // Single-pass: FULL_URL is replaced, but its value containing
    // {{config.BASE}} is NOT further resolved.
    expect(ir.identity.goal).toBe('URL: {{config.BASE}}/api');
  });
});

// ===========================================================================
// Edge Case 4: execution block is NOT walked
//
// BUG: resolveConfigVariables walks identity, tools, gather, memory,
// constraints, coordination, completion, error_handling, flow, on_start,
// messages, hooks, nlu, routing, templates, conversation_behavior, and
// behavior_profiles — but NOT execution.
//
// If a user puts {{config.TIMEOUT}} in execution.timeouts, it's silently
// ignored.
// ===========================================================================

describe('resolveConfigVariables — execution block not walked', () => {
  test('config vars in execution fields are silently ignored', () => {
    const ir = makeMinimalIR({
      execution: {
        hints: {
          voice_optimized: false,
          requires_persistence: false,
          supports_hitl: false,
          parallel_tools: false,
          complexity: 'simple',
        },
        timeouts: {
          tool_timeout_ms: 30000,
          llm_timeout_ms: 30000,
          session_timeout_ms: 1800000,
          voice_latency_target_ms: 1000,
        },
      },
    });

    // Manually inject a config var reference into execution
    // (this simulates a DSL that allows config vars in TIMEOUT settings)
    (ir.execution as any).custom_field = '{{config.CUSTOM_VALUE}}';

    const result = resolveConfigVariables(ir, { CUSTOM_VALUE: 'resolved' });

    // BUG: execution block is not walked, so the config var remains unresolved.
    // No error is reported either — it's silently ignored.
    // This FAILS: the field is NOT resolved.
    expect((ir.execution as any).custom_field).toBe('resolved');
  });
});

// ===========================================================================
// Edge Case 5: Key case sensitivity
//
// The pattern \w+ matches [A-Za-z0-9_]. Config vars are typically stored
// uppercase (the API normalizes to uppercase). But the resolution is
// case-sensitive. {{config.api_url}} won't match a var stored as API_URL.
// ===========================================================================

describe('resolveConfigVariables — key case sensitivity', () => {
  test('lowercase key in template does not match uppercase stored var', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'Use {{config.api_url}} for API',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    const result = resolveConfigVariables(ir, { API_URL: 'https://example.com' });

    // Case mismatch: {{config.api_url}} vs key API_URL.
    // Resolution is case-sensitive, so this fails to resolve.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('api_url');
  });
});

// ===========================================================================
// Edge Case 6: Empty config value — is it valid?
//
// The API allows empty string values (Zod: z.string(), no min(1)).
// Resolution should handle empty values without error.
// ===========================================================================

describe('resolveConfigVariables — empty value handling', () => {
  test('empty string config value replaces placeholder with empty string', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'Prefix:{{config.SUFFIX}}',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    const result = resolveConfigVariables(ir, { SUFFIX: '' });

    expect(result.errors).toHaveLength(0);
    expect(ir.identity.goal).toBe('Prefix:');
    expect(result.used.has('SUFFIX')).toBe(true);
  });
});

// ===========================================================================
// Edge Case 7: Config value with newlines and special whitespace
// ===========================================================================

describe('resolveConfigVariables — multiline values', () => {
  test('config value with newlines is preserved', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'Instructions: {{config.INSTRUCTIONS}}',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    const multilineValue = 'Line 1\nLine 2\nLine 3';
    resolveConfigVariables(ir, { INSTRUCTIONS: multilineValue });

    expect(ir.identity.goal).toBe('Instructions: Line 1\nLine 2\nLine 3');
  });
});

// ===========================================================================
// Edge Case 8: Multiple same-key references in one string
//
// The /g flag on CONFIG_VAR_PATTERN means it should replace ALL occurrences.
// But since .replace() with /g resets lastIndex between calls to the
// replacer, this should work. Test it to be sure.
// ===========================================================================

describe('resolveConfigVariables — multiple same-key in one string', () => {
  test('same key referenced multiple times in one string', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: '{{config.APP}} is great. Use {{config.APP}} today!',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    const result = resolveConfigVariables(ir, { APP: 'MyApp' });

    expect(result.errors).toHaveLength(0);
    expect(ir.identity.goal).toBe('MyApp is great. Use MyApp today!');
  });
});

// ===========================================================================
// Edge Case 9: Config var in error_handling default_handler.respond
// ===========================================================================

describe('resolveConfigVariables — error handling fields', () => {
  test('resolves in default error handler respond message', () => {
    const ir = makeMinimalIR({
      error_handling: {
        handlers: [
          {
            type: 'custom',
            respond: 'Contact {{config.SUPPORT_EMAIL}} for help',
          } as any,
        ],
        default_handler: {
          type: 'default',
          respond: 'Error in {{config.APP_NAME}}. Try again.',
          retry: 1,
          retry_delay_ms: 1000,
          then: 'continue',
        },
      },
    });

    const result = resolveConfigVariables(ir, {
      SUPPORT_EMAIL: 'support@example.com',
      APP_NAME: 'TravelBot',
    });

    expect(result.errors).toHaveLength(0);
    expect(ir.error_handling.default_handler.respond).toBe('Error in TravelBot. Try again.');
    expect((ir.error_handling.handlers[0] as any).respond).toBe(
      'Contact support@example.com for help',
    );
  });
});

// ===========================================================================
// Edge Case 10: Very long config value (> 4096 chars)
//
// The API allows max 4096 chars. But at resolution time, there's no check.
// A resolved IR field could contain extremely long values.
// ===========================================================================

describe('resolveConfigVariables — large value handling', () => {
  test('handles config values at storage limit', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: '{{config.LONG_VAL}}',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    const longValue = 'X'.repeat(4096);
    const result = resolveConfigVariables(ir, { LONG_VAL: longValue });

    expect(result.errors).toHaveLength(0);
    expect(ir.identity.goal).toBe(longValue);
    expect(ir.identity.goal.length).toBe(4096);
  });
});
