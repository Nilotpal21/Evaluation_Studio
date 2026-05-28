/**
 * Config Variable Resolution Tests
 *
 * Verifies that {{config.KEY}} placeholders are resolved at compile time,
 * while {{env.X}} and {{secrets.X}} remain untouched for runtime resolution.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR, resolveConfigVariables } from '../../platform/ir/compiler.js';
import type { AgentIR } from '../../platform/ir/schema.js';

// Helper: parse + compile and return compilation output
function compileFromDSL(dsl: string, configVariables?: Record<string, string>) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.errors).toHaveLength(0);
  expect(parseResult.document).not.toBeNull();
  return compileABLtoIR([parseResult.document!], { config_variables: configVariables });
}

// Helper: create a minimal IR for unit-testing resolveConfigVariables directly
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
      // mode is deprecated — execution style derived from flow presence
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

describe('resolveConfigVariables — unit tests', () => {
  test('resolves {{config.X}} in identity fields', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: '{{config.GOAL_TEXT}}',
        persona: '{{config.PERSONA_TEXT}}',
        limitations: ['Do not access {{config.BLOCKED_DOMAIN}}'],
        system_prompt: {
          template: 'You are an agent. Base: {{config.BASE_URL}}',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });
    const vars = {
      GOAL_TEXT: 'Help users book flights',
      PERSONA_TEXT: 'Friendly travel agent',
      BLOCKED_DOMAIN: 'competitor.com',
      BASE_URL: 'https://api.example.com',
    };

    const result = resolveConfigVariables(ir, vars);

    expect(result.errors).toHaveLength(0);
    expect(ir.identity.goal).toBe('Help users book flights');
    expect(ir.identity.persona).toBe('Friendly travel agent');
    expect(ir.identity.limitations[0]).toBe('Do not access competitor.com');
    expect(ir.identity.system_prompt.template).toBe(
      'You are an agent. Base: https://api.example.com',
    );
    expect(result.used).toEqual(
      new Set(['GOAL_TEXT', 'PERSONA_TEXT', 'BLOCKED_DOMAIN', 'BASE_URL']),
    );
  });

  test('resolves multiple {{config.X}} in one string', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'Use {{config.API_BASE}}/v{{config.API_VERSION}} for all calls',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    const result = resolveConfigVariables(ir, {
      API_BASE: 'https://api.example.com',
      API_VERSION: '2',
    });

    expect(result.errors).toHaveLength(0);
    expect(ir.identity.goal).toBe('Use https://api.example.com/v2 for all calls');
  });

  test('reports error for undefined config variable', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'Connect to {{config.MISSING_KEY}}',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    const result = resolveConfigVariables(ir, {});

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Undefined config variable "MISSING_KEY"');
    // Placeholder should remain in the string
    expect(ir.identity.goal).toBe('Connect to {{config.MISSING_KEY}}');
  });

  test('preserves {{env.X}} and {{secrets.X}} placeholders', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'Use {{env.DATABASE_URL}} with {{secrets.API_KEY}} and {{config.APP_NAME}}',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    const result = resolveConfigVariables(ir, { APP_NAME: 'MyApp' });

    expect(result.errors).toHaveLength(0);
    expect(ir.identity.goal).toBe('Use {{env.DATABASE_URL}} with {{secrets.API_KEY}} and MyApp');
  });

  test('handles empty config_variables gracefully', () => {
    const ir = makeMinimalIR({
      identity: {
        goal: 'No config vars here',
        persona: '',
        limitations: [],
        system_prompt: {
          template: '',
          sections: { context: true, tools: false, constraints: false, history: true },
        },
      },
    });

    const result = resolveConfigVariables(ir, {});

    expect(result.errors).toHaveLength(0);
    expect(result.used.size).toBe(0);
  });

  test('resolves config variables in tool definitions', () => {
    const ir = makeMinimalIR({
      tools: [
        {
          name: 'search',
          description: 'Search via {{config.SEARCH_PROVIDER}}',
          parameters: [
            {
              name: 'query',
              type: 'string',
              description: 'Search {{config.PRODUCT_NAME}}',
              required: true,
            },
          ],
          returns: { type: 'object' },
          hints: {
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            side_effects: false,
            requires_auth: false,
          },
          http_binding: {
            endpoint: '{{config.API_BASE}}/search',
            method: 'GET',
            auth: { type: 'bearer' },
            headers: {
              'X-Api-Version': '{{config.API_VERSION}}',
            },
          },
        },
      ],
    });

    const result = resolveConfigVariables(ir, {
      SEARCH_PROVIDER: 'Elasticsearch',
      PRODUCT_NAME: 'Hotels',
      API_BASE: 'https://api.example.com',
      API_VERSION: 'v3',
    });

    expect(result.errors).toHaveLength(0);
    expect(ir.tools[0].description).toBe('Search via Elasticsearch');
    expect(ir.tools[0].parameters[0].description).toBe('Search Hotels');
    expect(ir.tools[0].http_binding!.endpoint).toBe('https://api.example.com/search');
    expect(ir.tools[0].http_binding!.headers!['X-Api-Version']).toBe('v3');
  });

  test('preserves tool auth_profile_ref placeholders for runtime resolution', () => {
    const ir = makeMinimalIR({
      tools: [
        {
          name: 'gmail_search',
          description: 'Call {{config.PROVIDER_NAME}}',
          auth_profile_ref: '{{config.AUTH_PROFILE_NAME}}',
          parameters: [],
          returns: { type: 'object' },
          hints: {
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            side_effects: false,
            requires_auth: true,
          },
          http_binding: {
            endpoint: 'https://{{config.API_HOST}}/search',
            method: 'GET',
            auth: { type: 'bearer' },
          },
        },
      ],
    });

    const result = resolveConfigVariables(ir, {
      PROVIDER_NAME: 'Gmail',
      AUTH_PROFILE_NAME: 'google-prod-profile',
      API_HOST: 'api.example.com',
    });

    expect(result.errors).toHaveLength(0);
    expect(ir.tools[0].description).toBe('Call Gmail');
    expect(ir.tools[0].http_binding?.endpoint).toBe('https://api.example.com/search');
    expect(ir.tools[0].auth_profile_ref).toBe('{{config.AUTH_PROFILE_NAME}}');
  });

  test('preserves runtime binding config placeholders on namespace-scoped tools', () => {
    const ir = makeMinimalIR({
      tools: [
        {
          name: 'crm_lookup',
          description: 'Call {{config.PROVIDER_NAME}}',
          variable_namespace_ids: ['ns-crm-prod'],
          parameters: [
            {
              name: 'query',
              type: 'string',
              description: 'Search {{config.PRODUCT_NAME}}',
              required: true,
            },
          ],
          returns: { type: 'object' },
          hints: {
            cacheable: false,
            latency: 'medium',
            parallelizable: false,
            side_effects: false,
            requires_auth: false,
          },
          http_binding: {
            endpoint: '{{config.API_BASE}}/search',
            method: 'POST',
            auth: {
              type: 'api_key',
              config: {
                headerName: '{{config.API_KEY_HEADER}}',
              },
            },
            headers: {
              'X-Region': '{{config.REGION}}',
            },
            body_template: '{"tenant":"{{config.TENANT_SLUG}}","query":"{{input.query}}"}',
          },
        },
      ],
    });

    const result = resolveConfigVariables(ir, {
      PROVIDER_NAME: 'CRM',
      PRODUCT_NAME: 'Customers',
      API_BASE: 'https://global.example.com',
      API_KEY_HEADER: 'X-Global-Key',
      REGION: 'global',
      TENANT_SLUG: 'global-tenant',
    });

    expect(result.errors).toHaveLength(0);
    expect(ir.tools[0].description).toBe('Call CRM');
    expect(ir.tools[0].parameters[0].description).toBe('Search Customers');
    expect(ir.tools[0].http_binding!.endpoint).toBe('{{config.API_BASE}}/search');
    expect(ir.tools[0].http_binding!.auth.config?.headerName).toBe('{{config.API_KEY_HEADER}}');
    expect(ir.tools[0].http_binding!.headers!['X-Region']).toBe('{{config.REGION}}');
    expect(ir.tools[0].http_binding!.body_template).toBe(
      '{"tenant":"{{config.TENANT_SLUG}}","query":"{{input.query}}"}',
    );
  });

  test('resolves config variables in completion conditions', () => {
    const ir = makeMinimalIR({
      completion: {
        conditions: [
          {
            when: 'all_fields_collected',
            respond: 'Thank you for using {{config.PRODUCT_NAME}}!',
          },
        ],
      },
    });

    const result = resolveConfigVariables(ir, { PRODUCT_NAME: 'TravelBot' });

    expect(result.errors).toHaveLength(0);
    expect(ir.completion.conditions[0].respond).toBe('Thank you for using TravelBot!');
  });

  test('resolves config variables in nested arrays and objects', () => {
    const ir = makeMinimalIR({
      memory: {
        session: [
          {
            name: 'base_url',
            description: 'Base URL: {{config.BASE_URL}}',
            initial_value: '{{config.BASE_URL}}',
          },
        ],
        persistent: [],
        remember: [],
        recall: [],
      },
    });

    const result = resolveConfigVariables(ir, { BASE_URL: 'https://api.example.com' });

    expect(result.errors).toHaveLength(0);
    expect(ir.memory.session[0].description).toBe('Base URL: https://api.example.com');
    expect(ir.memory.session[0].initial_value).toBe('https://api.example.com');
  });

  test('handles non-string values without errors', () => {
    const ir = makeMinimalIR({
      execution: {
        // mode is deprecated — execution style derived from flow presence
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
        max_tokens: 4096,
        temperature: 0.7,
      },
    });

    // Should not throw on numbers, booleans, etc.
    const result = resolveConfigVariables(ir, {});
    expect(result.errors).toHaveLength(0);
  });
});

describe('compileABLtoIR — config variable integration', () => {
  const BASIC_DSL = `
AGENT: Test_Agent

GOAL: "Help users with {{config.PRODUCT_NAME}}"
PERSONA: "A helpful {{config.PRODUCT_NAME}} assistant"
LIMITATIONS:
  - "Never share {{config.INTERNAL_DOMAIN}} endpoints"
`;

  test('resolves config variables in compiled IR', () => {
    const output = compileFromDSL(BASIC_DSL, {
      PRODUCT_NAME: 'TravelBot',
      INTERNAL_DOMAIN: 'internal.example.com',
    });

    const agent = output.agents['Test_Agent'];
    expect(agent).toBeDefined();
    expect(agent.identity.goal).toBe('Help users with TravelBot');
    expect(agent.identity.persona).toBe('A helpful TravelBot assistant');
    expect(agent.identity.limitations[0]).toBe('Never share internal.example.com endpoints');
  });

  test('records resolved config variables in output metadata', () => {
    const output = compileFromDSL(BASIC_DSL, {
      PRODUCT_NAME: 'TravelBot',
      INTERNAL_DOMAIN: 'internal.example.com',
      UNUSED_VAR: 'not-used',
    });

    expect(output.resolved_config_variables).toBeDefined();
    expect(output.resolved_config_variables!.resolved).toEqual({
      PRODUCT_NAME: 'TravelBot',
      INTERNAL_DOMAIN: 'internal.example.com',
    });
    expect(output.resolved_config_variables!.unused).toContain('UNUSED_VAR');
    expect(output.resolved_config_variables!.unresolved).toHaveLength(0);
  });

  test('computes config_hash on agent metadata', () => {
    const output = compileFromDSL(BASIC_DSL, {
      PRODUCT_NAME: 'TravelBot',
      INTERNAL_DOMAIN: 'internal.example.com',
    });

    const agent = output.agents['Test_Agent'];
    expect(agent.metadata.config_hash).toBeDefined();
    expect(typeof agent.metadata.config_hash).toBe('string');
    expect(agent.metadata.config_hash!.length).toBeGreaterThan(0);
  });

  test('config_hash changes when config values change', () => {
    const output1 = compileFromDSL(BASIC_DSL, {
      PRODUCT_NAME: 'TravelBot',
      INTERNAL_DOMAIN: 'internal.example.com',
    });
    const output2 = compileFromDSL(BASIC_DSL, {
      PRODUCT_NAME: 'FlightBot',
      INTERNAL_DOMAIN: 'internal.example.com',
    });

    expect(output1.agents['Test_Agent'].metadata.config_hash).not.toBe(
      output2.agents['Test_Agent'].metadata.config_hash,
    );
  });

  test('config_hash absent when no config vars used', () => {
    const simpleDSL = `
AGENT: Simple_Agent

GOAL: "No config variables here"
PERSONA: "Simple"
`;
    const output = compileFromDSL(simpleDSL, { UNUSED: 'value' });
    const agent = output.agents['Simple_Agent'];
    expect(agent.metadata.config_hash).toBeUndefined();
  });

  test('reports errors for undefined config variables', () => {
    const dsl = `
AGENT: Test_Agent

GOAL: "Use {{config.UNDEFINED_KEY}}"
PERSONA: "Test"
`;
    // Must provide at least one config var to trigger resolution
    const output = compileFromDSL(dsl, { SOME_OTHER: 'value' });

    expect(output.compilation_errors).toBeDefined();
    expect(output.compilation_errors!.length).toBeGreaterThan(0);
    expect(output.compilation_errors![0].message).toContain('UNDEFINED_KEY');
    expect(output.resolved_config_variables!.unresolved).toContain('UNDEFINED_KEY');
  });

  test('no resolved_config_variables when no config vars provided', () => {
    const simpleDSL = `
AGENT: Simple_Agent

GOAL: "No config"
PERSONA: "Test"
`;
    const output = compileFromDSL(simpleDSL);
    expect(output.resolved_config_variables).toBeUndefined();
  });

  test('no resolved_config_variables when empty config vars provided', () => {
    const simpleDSL = `
AGENT: Simple_Agent

GOAL: "No config"
PERSONA: "Test"
`;
    const output = compileFromDSL(simpleDSL, {});
    expect(output.resolved_config_variables).toBeUndefined();
  });
});
