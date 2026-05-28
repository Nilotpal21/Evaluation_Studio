import { describe, it, expect } from 'vitest';
import { collectAuthRequirements } from '../platform/ir/auth-requirement-collector.js';
import type { CompilationOutput, AgentIR, ToolDefinition } from '../platform/ir/schema.js';

function makeToolDef(overrides: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'A test tool',
    parameters: [],
    returns: { type: 'string' },
    hints: {},
    ...overrides,
  };
}

function makeAgentIR(tools: ToolDefinition[]): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test-agent',
      version: '1.0.0',
      source_hash: 'abc',
      compiled_at: new Date().toISOString(),
    },
    execution: {
      mode: 'reasoning',
      runtime_hints: {} as AgentIR['execution']['runtime_hints'],
    },
    identity: {
      goal: 'Test agent',
      persona: 'test',
    },
    tools,
    gather: { fields: [], strategy: 'adaptive', max_turns: 10 },
    memory: { session: { max_turns: 50 }, long_term: { enabled: false } },
    constraints: { rules: [], guardrails: [] },
    coordination: { handoffs: [], delegates: [], routing_hints: [] },
    completion: { conditions: [] },
    error_handling: { max_retries: 3, strategies: [] },
  } as unknown as AgentIR;
}

function makeOutput(agents: Record<string, AgentIR>): CompilationOutput {
  return {
    version: '1.0',
    compiled_at: new Date().toISOString(),
    agents,
    deployment: { min_replicas: 1, max_replicas: 1, requires_gpu: false },
  } as CompilationOutput;
}

describe('collectAuthRequirements', () => {
  it('returns empty array when no tools have auth requirements', () => {
    const output = makeOutput({
      agent1: makeAgentIR([makeToolDef({ name: 'plain_tool' })]),
    });
    const result = collectAuthRequirements(output);
    expect(result).toEqual([]);
  });

  it('collects a single preflight auth requirement', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'gmail_lookup',
          auth_profile_ref: 'google-creds',
          connection_mode: 'per_user',
          consent_mode: 'preflight',
        }),
      ]),
    });
    const result = collectAuthRequirements(output);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      connector: 'google-creds',
      auth_profile_ref: 'google-creds',
      connection_mode: 'per_user',
      consent_mode: 'preflight',
    });
  });

  it('deduplicates by auth_profile_ref and merges scopes', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'gmail_read',
          auth_profile_ref: 'google-creds',
          connection_mode: 'per_user',
          consent_mode: 'preflight',
          http_binding: {
            endpoint: '/gmail/read',
            method: 'GET',
            auth: {
              type: 'oauth2_client',
              config: {
                oauth: {
                  tokenUrl: 'https://oauth.google.com',
                  clientId: 'c',
                  scopes: ['gmail.readonly'],
                },
              },
            },
          },
        }),
        makeToolDef({
          name: 'gmail_send',
          auth_profile_ref: 'google-creds',
          connection_mode: 'per_user',
          consent_mode: 'preflight',
          http_binding: {
            endpoint: '/gmail/send',
            method: 'POST',
            auth: {
              type: 'oauth2_client',
              config: {
                oauth: {
                  tokenUrl: 'https://oauth.google.com',
                  clientId: 'c',
                  scopes: ['gmail.readonly', 'gmail.send'],
                },
              },
            },
          },
        }),
      ]),
    });
    const result = collectAuthRequirements(output);
    expect(result).toHaveLength(1);
    expect(result[0].auth_profile_ref).toBe('google-creds');
    expect(result[0].scopes).toEqual(['gmail.readonly', 'gmail.send']);
  });

  it('keeps templated auth profile refs separate across namespace contexts', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'gmail_read',
          auth_profile_ref: '{{config.AUTH_PROFILE_NAME}}',
          variable_namespace_ids: ['ns-a'],
          connection_mode: 'per_user',
          consent_mode: 'preflight',
        }),
        makeToolDef({
          name: 'gmail_send',
          auth_profile_ref: '{{config.AUTH_PROFILE_NAME}}',
          variable_namespace_ids: ['ns-b', 'ns-a'],
          connection_mode: 'per_user',
          consent_mode: 'preflight',
        }),
      ]),
    });

    const result = collectAuthRequirements(output);
    expect(result).toHaveLength(2);
    expect(result).toEqual([
      {
        connector: '{{config.AUTH_PROFILE_NAME}}',
        auth_profile_ref: '{{config.AUTH_PROFILE_NAME}}',
        variable_namespace_ids: ['ns-a'],
        connection_mode: 'per_user',
        consent_mode: 'preflight',
      },
      {
        connector: '{{config.AUTH_PROFILE_NAME}}',
        auth_profile_ref: '{{config.AUTH_PROFILE_NAME}}',
        variable_namespace_ids: ['ns-a', 'ns-b'],
        connection_mode: 'per_user',
        consent_mode: 'preflight',
      },
    ]);
  });

  it('deduplicates templated auth profile refs when namespace context matches', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'gmail_read',
          auth_profile_ref: '{{config.AUTH_PROFILE_NAME}}',
          variable_namespace_ids: ['ns-a'],
          connection_mode: 'per_user',
          consent_mode: 'preflight',
          http_binding: {
            endpoint: '/gmail/read',
            method: 'GET',
            auth: {
              type: 'oauth2_client',
              config: {
                oauth: {
                  tokenUrl: 'https://oauth.google.com',
                  clientId: 'c',
                  scopes: ['gmail.readonly'],
                },
              },
            },
          },
        }),
        makeToolDef({
          name: 'gmail_send',
          auth_profile_ref: '{{config.AUTH_PROFILE_NAME}}',
          variable_namespace_ids: ['ns-a', 'ns-a'],
          connection_mode: 'per_user',
          consent_mode: 'preflight',
          http_binding: {
            endpoint: '/gmail/send',
            method: 'POST',
            auth: {
              type: 'oauth2_client',
              config: {
                oauth: {
                  tokenUrl: 'https://oauth.google.com',
                  clientId: 'c',
                  scopes: ['gmail.send'],
                },
              },
            },
          },
        }),
      ]),
    });

    const result = collectAuthRequirements(output);
    expect(result).toEqual([
      {
        connector: '{{config.AUTH_PROFILE_NAME}}',
        auth_profile_ref: '{{config.AUTH_PROFILE_NAME}}',
        variable_namespace_ids: ['ns-a'],
        scopes: ['gmail.readonly', 'gmail.send'],
        connection_mode: 'per_user',
        consent_mode: 'preflight',
      },
    ]);
  });

  it('collects from 3 tools using 2 providers → 2 AuthRequirementIR entries', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'gmail_lookup',
          auth_profile_ref: 'google-creds',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        }),
        makeToolDef({
          name: 'calendar_check',
          auth_profile_ref: 'google-creds',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        }),
        makeToolDef({
          name: 'sf_query',
          auth_profile_ref: 'salesforce-creds',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        }),
      ]),
    });
    const result = collectAuthRequirements(output);
    expect(result).toHaveLength(2);
    const refs = result.map((r) => r.auth_profile_ref).sort();
    expect(refs).toEqual(['google-creds', 'salesforce-creds']);
  });

  it('ignores tools without consent_mode', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'tool_no_consent',
          auth_profile_ref: 'some-creds',
          // no consent_mode
        }),
      ]),
    });
    const result = collectAuthRequirements(output);
    expect(result).toEqual([]);
  });

  it('preflight takes precedence over inline for same profile', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'tool1',
          auth_profile_ref: 'creds',
          consent_mode: 'inline',
          connection_mode: 'per_user',
        }),
        makeToolDef({
          name: 'tool2',
          auth_profile_ref: 'creds',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        }),
      ]),
    });
    const result = collectAuthRequirements(output);
    expect(result).toHaveLength(1);
    expect(result[0].consent_mode).toBe('preflight');
  });

  it('collects across multiple agents', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'gmail_tool',
          auth_profile_ref: 'google-creds',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        }),
      ]),
      agent2: makeAgentIR([
        makeToolDef({
          name: 'slack_tool',
          auth_profile_ref: 'slack-creds',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        }),
      ]),
    });
    const result = collectAuthRequirements(output);
    expect(result).toHaveLength(2);
  });

  it('uses connector_binding.connector when available', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'my_tool',
          auth_profile_ref: 'google-creds',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
          connector_binding: { connector: 'gmail', action: 'search' },
        }),
      ]),
    });
    const result = collectAuthRequirements(output);
    expect(result).toHaveLength(1);
    expect(result[0].connector).toBe('gmail');
  });

  it('defaults connection_mode to per_user when not set', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'tool1',
          auth_profile_ref: 'creds',
          consent_mode: 'preflight',
          // connection_mode not set
        }),
      ]),
    });
    const result = collectAuthRequirements(output);
    expect(result).toHaveLength(1);
    expect(result[0].connection_mode).toBe('per_user');
  });

  it('keeps mixed connection modes separate for the same auth profile', () => {
    const sharedThenPerUser = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'tool_shared',
          auth_profile_ref: 'creds',
          consent_mode: 'inline',
          connection_mode: 'shared',
        }),
        makeToolDef({
          name: 'tool_per_user',
          auth_profile_ref: 'creds',
          consent_mode: 'inline',
          connection_mode: 'per_user',
        }),
      ]),
    });

    const perUserThenShared = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'tool_per_user',
          auth_profile_ref: 'creds',
          consent_mode: 'inline',
          connection_mode: 'per_user',
        }),
        makeToolDef({
          name: 'tool_shared',
          auth_profile_ref: 'creds',
          consent_mode: 'inline',
          connection_mode: 'shared',
        }),
      ]),
    });

    const firstOrder = collectAuthRequirements(sharedThenPerUser);
    const secondOrder = collectAuthRequirements(perUserThenShared);

    expect(firstOrder).toHaveLength(2);
    expect(secondOrder).toHaveLength(2);
    expect(firstOrder.map((entry) => entry.connection_mode)).toEqual(['per_user', 'shared']);
    expect(secondOrder.map((entry) => entry.connection_mode)).toEqual(['per_user', 'shared']);
  });

  it('merges connector field deterministically for same auth profile', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'tool_b',
          auth_profile_ref: 'creds',
          consent_mode: 'inline',
          connection_mode: 'per_user',
          connector_binding: { connector: 'zeta', action: 'read' },
        }),
        makeToolDef({
          name: 'tool_a',
          auth_profile_ref: 'creds',
          consent_mode: 'inline',
          connection_mode: 'per_user',
          connector_binding: { connector: 'alpha', action: 'write' },
        }),
      ]),
    });

    const result = collectAuthRequirements(output);
    expect(result).toHaveLength(1);
    expect(result[0].connector).toBe('alpha');
  });

  it('scopes collection to requested agent names when provided', () => {
    const output = makeOutput({
      agent1: makeAgentIR([
        makeToolDef({
          name: 'gmail_tool',
          auth_profile_ref: 'google-creds',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        }),
      ]),
      agent2: makeAgentIR([
        makeToolDef({
          name: 'slack_tool',
          auth_profile_ref: 'slack-creds',
          consent_mode: 'preflight',
          connection_mode: 'per_user',
        }),
      ]),
    });

    const result = collectAuthRequirements(output, {
      agentNames: ['agent2', 'missing-agent', 'agent2'],
    });

    expect(result).toEqual([
      {
        connector: 'slack-creds',
        auth_profile_ref: 'slack-creds',
        connection_mode: 'per_user',
        consent_mode: 'preflight',
      },
    ]);
  });
});
