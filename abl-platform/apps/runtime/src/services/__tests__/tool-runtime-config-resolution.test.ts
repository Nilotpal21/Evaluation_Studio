import { describe, expect, it } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { resolveRuntimeConfigKeysInAgentIR } from '../tool-runtime-config-resolution.js';

function makeIr(tool: Record<string, unknown>): AgentIR {
  return {
    version: '1.0',
    metadata: { name: 'agent' },
    identity: { name: 'agent' },
    execution: {},
    tools: [tool],
  } as unknown as AgentIR;
}

describe('resolveRuntimeConfigKeysInAgentIR', () => {
  it('preserves namespace-scoped binding config templates for scoped runtime resolution', () => {
    const result = resolveRuntimeConfigKeysInAgentIR(
      makeIr({
        name: 'lookup_ticket',
        variable_namespace_ids: ['ns-tools'],
        http_binding: {
          endpoint: '{{config.API_BASE}}/tickets',
          timeout_ms: '{{config.HTTP_TIMEOUT_MS}}',
        },
      }),
      {
        API_BASE: 'https://project-wide.example.com',
        HTTP_TIMEOUT_MS: '7000',
      },
      'agent "agent"',
    );

    expect(result.errors).toEqual([]);
    expect(result.ir.tools[0]).toMatchObject({
      http_binding: {
        endpoint: '{{config.API_BASE}}/tickets',
        timeout_ms: '{{config.HTTP_TIMEOUT_MS}}',
      },
    });
  });

  it('resolves and coerces unscoped binding config templates from project-wide config', () => {
    const result = resolveRuntimeConfigKeysInAgentIR(
      makeIr({
        name: 'lookup_ticket',
        http_binding: {
          endpoint: '{{config.API_BASE}}/tickets',
          timeout_ms: '{{config.HTTP_TIMEOUT_MS}}',
        },
      }),
      {
        API_BASE: 'https://project-wide.example.com',
        HTTP_TIMEOUT_MS: '7000',
      },
      'agent "agent"',
    );

    expect(result.errors).toEqual([]);
    expect(result.ir.tools[0]).toMatchObject({
      http_binding: {
        endpoint: 'https://project-wide.example.com/tickets',
        timeout_ms: 7000,
      },
    });
  });

  it('fails unscoped bindings that reference missing project-wide config', () => {
    const result = resolveRuntimeConfigKeysInAgentIR(
      makeIr({
        name: 'lookup_ticket',
        http_binding: {
          timeout_ms: '{{config.HTTP_TIMEOUT_MS}}',
        },
      }),
      {},
      'agent "agent"',
    );

    expect(result.errors).toContain(
      'Undefined config variable "HTTP_TIMEOUT_MS" referenced in agent "agent"',
    );
  });
});
