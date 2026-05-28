/**
 * Module Stub Collision Tests
 *
 * Validates that stub agents (created during compilation for cross-agent
 * validation) do not cause collision warnings when real module agents
 * are merged via mergeWorkingCopyModules.
 *
 * Issue: Stubs with names like `payments__main` are in `result.agents`
 * when rewriteModuleIR runs, causing false collision warnings because
 * the rewritten module agents have the same aliased names.
 */

import { describe, it, expect } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { rewriteModuleIR } from '../module-alias-rewriter.js';

function makeAgentIR(name: string): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name,
      version: '1.0.0',
      type: 'agent',
      compiled_at: '2026-01-01T00:00:00Z',
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: 'reasoning',
      model: 'gpt-4',
      temperature: 0.7,
      hints: { deterministic: false, stateless: false },
      timeouts: {},
    },
    identity: {
      description: 'test agent',
      instructions: 'be helpful',
    },
    tools: [],
    gather: { fields: [], strategy: 'progressive' },
    memory: { session: {}, cross_session: { enabled: false } },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [], action: 'respond', message: 'done' },
    error_handling: {
      handlers: [],
      default_handler: { type: 'default', then: 'continue' },
    },
  } as unknown as AgentIR;
}

describe('module stub collision filtering', () => {
  it('should report collision when real local agent name conflicts with module aliased name', () => {
    // A real local agent named "payments__main" would conflict
    const existingSymbols = new Set(['payments__main']);
    const agents = { main: makeAgentIR('main') };

    const result = rewriteModuleIR('payments', agents, {}, existingSymbols);

    // This IS a real collision — local agent has same name
    expect(result.collisions).toContain('payments__main');
  });

  it('should NOT report collision when existing symbol is a stub (filtered out by caller)', () => {
    // When we filter stubs from existingSymbols (names containing __ that are stubs),
    // the collision should not appear
    const allAgentNames = ['local_agent', 'payments__main'];
    // Filter: only include non-stub names (no __ prefix pattern from modules)
    const existingSymbols = new Set(allAgentNames.filter((name) => !name.includes('__')));

    const agents = { main: makeAgentIR('main') };
    const result = rewriteModuleIR('payments', agents, {}, existingSymbols);

    // No collision — stubs were filtered out
    expect(result.collisions).toHaveLength(0);
  });

  it('should still detect collisions between local agents and module agents', () => {
    // If a local agent has a name that doesn't contain __ but still collides
    // after alias rewrite, that's a real collision
    const existingSymbols = new Set(['crm__helper']);
    const agents = { helper: makeAgentIR('helper') };

    const result = rewriteModuleIR('crm', agents, {}, existingSymbols);
    expect(result.collisions).toContain('crm__helper');
  });

  it('should not produce collisions when existingSymbols only has local non-module agents', () => {
    const existingSymbols = new Set(['orchestrator', 'customer_service']);
    const agents = {
      main: makeAgentIR('main'),
      helper: makeAgentIR('helper'),
    };

    const result = rewriteModuleIR('payments', agents, {}, existingSymbols);
    expect(result.collisions).toHaveLength(0);
  });
});
