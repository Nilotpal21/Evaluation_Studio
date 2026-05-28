/**
 * Compiler Auth Profile Tests
 *
 * Validates that auth_profile and auth_jit DSL properties compile
 * correctly to IR auth_profile_ref and jit_auth fields.
 */

import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';
import type { ToolDefinition } from '../../platform/ir/schema.js';

function compileAgent(dsl: string) {
  const parseResult = parseAgentBasedABL(dsl);
  if (parseResult.errors.length > 0) {
    throw new Error(`Parse errors: ${parseResult.errors.map((e) => e.message).join('; ')}`);
  }
  expect(parseResult.document).not.toBeNull();
  const output = compileABLtoIR([parseResult.document!]);
  // Check no compilation errors
  expect(output.compilation_errors ?? []).toHaveLength(0);
  return output;
}

describe('compiler auth_profile → IR', () => {
  it('compiles auth_profile to auth_profile_ref in IR', () => {
    const dsl = `AGENT: test_agent
GOAL: Test agent

TOOLS:
  call_api(query: string) -> Result
    auth_profile: "staging-api-key"
    description: "Call API"
`;

    const result = compileAgent(dsl);

    const agent = Object.values(result.agents)[0];
    expect(agent).toBeDefined();

    const tool = agent.tools?.find((t) => t.name === 'call_api');
    expect(tool).toBeDefined();
    expect(tool!.auth_profile_ref).toBe('staging-api-key');
  });

  it('compiles auth_jit to jit_auth in IR', () => {
    const dsl = `AGENT: test_agent
GOAL: Test agent

TOOLS:
  call_api(query: string) -> Result
    auth_profile: "google-oauth"
    auth_jit: true
    description: "Call API"
`;

    const result = compileAgent(dsl);

    const agent = Object.values(result.agents)[0];
    const tool = agent.tools?.find((t) => t.name === 'call_api');
    expect(tool).toBeDefined();
    expect(tool!.auth_profile_ref).toBe('google-oauth');
    expect(tool!.jit_auth).toBe(true);
  });

  it('preserves config variable template in auth_profile_ref', () => {
    const dsl = `AGENT: test_agent
GOAL: Test agent

TOOLS:
  call_api(query: string) -> Result
    auth_profile: "{{config.AUTH_PROFILE}}"
    description: "Call API"
`;

    const result = compileAgent(dsl);

    const agent = Object.values(result.agents)[0];
    const tool = agent.tools?.find((t) => t.name === 'call_api');
    expect(tool!.auth_profile_ref).toBe('{{config.AUTH_PROFILE}}');
  });

  it('does not set auth_profile_ref when not specified', () => {
    const dsl = `AGENT: test_agent
GOAL: Test agent

TOOLS:
  call_api(query: string) -> Result
    description: "Call API"
`;

    const result = compileAgent(dsl);

    const agent = Object.values(result.agents)[0];
    const tool = agent.tools?.find((t) => t.name === 'call_api');
    expect(tool!.auth_profile_ref).toBeUndefined();
    expect(tool!.jit_auth).toBeUndefined();
  });

  it('preserves agent-level auth and context metadata when merging resolved project tools', () => {
    const dsl = `AGENT: test_agent
GOAL: Test agent

MEMORY:
  SESSION:
    - customer_id
    - last_sync

TOOLS:
  call_api(query: string) -> Result
    auth_profile: "shared-oauth"
    auth_jit: true
    consent: inline
    connection: per_user
    pii_access: user
    confirm: always
    immutable: [query]
    consent_required_in: conversation
    consent_scope: [query]
    consent_action: "search"
    consent_fallback: explicit_prompt
    store_result: false
    CONTEXT_ACCESS:
      READ: [customer_id]
      WRITE: [last_sync]
`;

    const parseResult = parseAgentBasedABL(dsl);
    if (parseResult.errors.length > 0) {
      throw new Error(`Parse errors: ${parseResult.errors.map((e) => e.message).join('; ')}`);
    }

    const resolvedTool: ToolDefinition = {
      name: 'call_api',
      description: '',
      tool_type: 'http',
      parameters: [{ name: 'query', type: 'string' }],
      returns: { type: 'object' },
      hints: {
        cacheable: false,
        latency: 'medium',
        parallelizable: false,
        side_effects: true,
        requires_auth: false,
      },
      http_binding: {
        endpoint: 'https://example.com/search',
        method: 'POST',
      },
    };

    const output = compileABLtoIR([parseResult.document!], {
      resolvedToolImplementations: new Map([['test_agent', [resolvedTool]]]),
    });

    expect(output.compilation_errors ?? []).toHaveLength(0);

    const tool = output.agents['test_agent'].tools?.find(
      (candidate) => candidate.name === 'call_api',
    );

    expect(tool).toBeDefined();
    expect(tool?.tool_type).toBe('http');
    expect(tool?.http_binding?.endpoint).toBe('https://example.com/search');
    expect(tool?.auth_profile_ref).toBe('shared-oauth');
    expect(tool?.jit_auth).toBe(true);
    expect(tool?.consent_mode).toBe('inline');
    expect(tool?.connection_mode).toBe('per_user');
    expect(tool?.pii_access).toBe('user');
    expect(tool?.confirmation).toEqual({
      require: 'always',
      immutable_params: ['query'],
      consent_required_in: 'conversation',
      consent_scope: ['query'],
      consent_action: 'search',
      consent_fallback: 'explicit_prompt',
    });
    expect(tool?.store_result).toBe(false);
    expect(tool?.context_access).toEqual({
      read: ['customer_id'],
      write: ['last_sync'],
    });
  });
});
