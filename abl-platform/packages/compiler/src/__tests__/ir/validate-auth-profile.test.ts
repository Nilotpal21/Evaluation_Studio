/**
 * Validate auth_profile preflight tests
 *
 * Ensures compile-time warning when auth_jit: true is used without auth_profile.
 */

import { describe, it, expect } from 'vitest';
import { validateAuthJitRequiresProfile } from '../../platform/ir/validate-preflight.js';
import type { AgentIR } from '../../platform/ir/schema.js';

function makeAgentIR(
  tools: Array<{ name: string; auth_profile_ref?: string; jit_auth?: boolean }>,
): AgentIR {
  return {
    metadata: { name: 'test_agent', type: 'agent', version: '1.0' },
    execution: {},
    tools: tools.map((t) => ({
      name: t.name,
      description: `Tool ${t.name}`,
      parameters: [],
      returns: { type: 'string' },
      hints: {
        cacheable: false,
        latency: 'medium' as const,
        parallelizable: false,
        side_effects: false,
        requires_auth: false,
      },
      auth_profile_ref: t.auth_profile_ref,
      jit_auth: t.jit_auth,
    })),
  } as unknown as AgentIR;
}

describe('validateAuthJitRequiresProfile', () => {
  it('returns warning when auth_jit is true but no auth_profile', () => {
    const agentIR = makeAgentIR([{ name: 'tool1', jit_auth: true }]);

    const diagnostics = validateAuthJitRequiresProfile(agentIR, 'test_agent');

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].code).toBe('AUTH_JIT_WITHOUT_PROFILE');
    expect(diagnostics[0].message).toContain('auth_jit');
    expect(diagnostics[0].message).toContain('auth_profile');
  });

  it('returns no warning when auth_jit is true with auth_profile', () => {
    const agentIR = makeAgentIR([
      { name: 'tool1', jit_auth: true, auth_profile_ref: 'my-profile' },
    ]);

    const diagnostics = validateAuthJitRequiresProfile(agentIR, 'test_agent');

    expect(diagnostics).toHaveLength(0);
  });

  it('returns no warning when auth_jit is not set', () => {
    const agentIR = makeAgentIR([{ name: 'tool1', auth_profile_ref: 'my-profile' }]);

    const diagnostics = validateAuthJitRequiresProfile(agentIR, 'test_agent');

    expect(diagnostics).toHaveLength(0);
  });

  it('returns no warning when no tools have auth properties', () => {
    const agentIR = makeAgentIR([{ name: 'tool1' }]);

    const diagnostics = validateAuthJitRequiresProfile(agentIR, 'test_agent');

    expect(diagnostics).toHaveLength(0);
  });

  it('returns warnings for multiple tools with auth_jit but no auth_profile', () => {
    const agentIR = makeAgentIR([
      { name: 'tool1', jit_auth: true },
      { name: 'tool2', jit_auth: true, auth_profile_ref: 'ok' },
      { name: 'tool3', jit_auth: true },
    ]);

    const diagnostics = validateAuthJitRequiresProfile(agentIR, 'test_agent');

    expect(diagnostics).toHaveLength(2);
  });
});
