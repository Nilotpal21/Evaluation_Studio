/**
 * E2E: DSL -> Compile -> IR -> Runtime Pipeline (Suite 4)
 *
 * Tests the full pipeline from DSL text to runtime behavior for auth profiles.
 *
 * Real components (ALL pure, no mocks needed):
 * - parseAgentBasedABL (DSL parser)
 * - compileABLtoIR (DSL compiler)
 * - collectAuthRequirements (post-compilation auth requirement collector)
 * - validateAuthJitRequiresProfile (preflight validator)
 */

import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';
import { collectAuthRequirements } from '../../platform/ir/auth-requirement-collector.js';
import { validateAuthJitRequiresProfile } from '../../platform/ir/validate-preflight.js';
import type { CompilationOutput, ToolDefinition } from '../../platform/ir/schema.js';

// ── Helpers ─────────────────────────────────────────────────────────

function compileDSL(dsl: string): CompilationOutput {
  const parseResult = parseAgentBasedABL(dsl);
  if (parseResult.errors.length > 0) {
    throw new Error(`Parse errors: ${parseResult.errors.map((e) => e.message).join('; ')}`);
  }
  expect(parseResult.document).not.toBeNull();
  const output = compileABLtoIR([parseResult.document!]);
  expect(output.compilation_errors ?? []).toHaveLength(0);
  return output;
}

function getFirstAgentTools(output: CompilationOutput): ToolDefinition[] {
  const agent = Object.values(output.agents)[0];
  expect(agent).toBeDefined();
  return agent.tools;
}

function findTool(output: CompilationOutput, toolName: string): ToolDefinition {
  const tools = getFirstAgentTools(output);
  const tool = tools.find((t) => t.name === toolName);
  expect(tool).toBeDefined();
  return tool!;
}

// ── Helpers for IR construction (used by 4.7, 4.8 which test runtime consumers) ──

function makeToolDef(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'A test tool',
    parameters: [],
    returns: { type: 'string' },
    hints: {
      cacheable: false,
      latency: 'medium' as const,
      parallelizable: false,
      side_effects: false,
      requires_auth: false,
    },
    ...overrides,
  } as ToolDefinition;
}

function makeAgentIR(tools: ToolDefinition[]) {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test-agent',
      type: 'agent',
      version: '1.0.0',
      source_hash: 'abc',
      compiled_at: new Date().toISOString(),
    },
    execution: {
      mode: 'reasoning',
      runtime_hints: {},
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
  } as unknown as ReturnType<typeof Object.values<CompilationOutput['agents']>>[number];
}

function makeOutput(agents: Record<string, ReturnType<typeof makeAgentIR>>): CompilationOutput {
  return {
    version: '1.0',
    compiled_at: new Date().toISOString(),
    agents,
    deployment: { min_replicas: 1, max_replicas: 1, requires_gpu: false },
  } as CompilationOutput;
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('Suite 4: DSL -> Compile -> IR -> Runtime E2E', () => {
  describe('DSL parsing and compilation of auth fields', () => {
    it('4.1: DSL auth_profile: "x" -> IR auth_profile_ref: "x"', () => {
      const dsl = `AGENT: booking_agent
GOAL: Book appointments

TOOLS:
  gmail_lookup(query: string) -> Result
    auth_profile: "google-creds"
    description: "Look up Gmail messages"
`;

      const output = compileDSL(dsl);
      const tool = findTool(output, 'gmail_lookup');

      expect(tool.auth_profile_ref).toBe('google-creds');
    });

    it('4.2: DSL auth_jit: true -> IR jit_auth: true', () => {
      const dsl = `AGENT: booking_agent
GOAL: Book appointments

TOOLS:
  gmail_lookup(query: string) -> Result
    auth_profile: "google-creds"
    auth_jit: true
    description: "Look up Gmail messages"
`;

      const output = compileDSL(dsl);
      const tool = findTool(output, 'gmail_lookup');

      expect(tool.auth_profile_ref).toBe('google-creds');
      expect(tool.jit_auth).toBe(true);
    });

    it('4.3: DSL consent: preflight -> IR consent_mode: "preflight"', () => {
      const dsl = `AGENT: booking_agent
GOAL: Book appointments

TOOLS:
  gmail_lookup(query: string) -> Result
    auth_profile: "google-creds"
    consent: preflight
    description: "Look up Gmail messages"
`;

      const output = compileDSL(dsl);
      const tool = findTool(output, 'gmail_lookup');

      expect(tool.auth_profile_ref).toBe('google-creds');
      expect(tool.consent_mode).toBe('preflight');
    });

    it('4.4: DSL connection: per_user -> IR connection_mode: "per_user"', () => {
      const dsl = `AGENT: booking_agent
GOAL: Book appointments

TOOLS:
  gmail_lookup(query: string) -> Result
    auth_profile: "google-creds"
    connection: per_user
    description: "Look up Gmail messages"
`;

      const output = compileDSL(dsl);
      const tool = findTool(output, 'gmail_lookup');

      expect(tool.auth_profile_ref).toBe('google-creds');
      expect(tool.connection_mode).toBe('per_user');
    });

    it('4.5: DSL auth_profile: "{{config.X}}" -> IR preserves template', () => {
      const dsl = `AGENT: booking_agent
GOAL: Book appointments

TOOLS:
  dynamic_tool(query: string) -> Result
    auth_profile: "{{config.GOOGLE_AUTH_PROFILE}}"
    description: "Dynamic auth profile"
`;

      const output = compileDSL(dsl);
      const tool = findTool(output, 'dynamic_tool');

      expect(tool.auth_profile_ref).toBe('{{config.GOOGLE_AUTH_PROFILE}}');
      expect(tool.auth_profile_ref).toContain('{{config.');
    });
  });

  describe('collectAuthRequirements from compiled IR', () => {
    it('4.6: compiled IR with auth tools -> collectAuthRequirements -> correct preflight requirements', () => {
      const dsl = `AGENT: booking_agent
GOAL: Book appointments

TOOLS:
  gmail_lookup(query: string) -> Result
    auth_profile: "google-creds"
    consent: preflight
    connection: per_user
    description: "Look up Gmail"

  sf_query(query: string) -> Result
    auth_profile: "salesforce-creds"
    consent: preflight
    connection: per_user
    description: "Query Salesforce"

  plain_tool(input: string) -> Result
    description: "A plain tool with no auth"
`;

      const output = compileDSL(dsl);
      const requirements = collectAuthRequirements(output);

      expect(requirements).toHaveLength(2);
      const refs = requirements.map((r) => r.auth_profile_ref).sort();
      expect(refs).toEqual(['google-creds', 'salesforce-creds']);

      for (const req of requirements) {
        expect(req.consent_mode).toBe('preflight');
        expect(req.connection_mode).toBe('per_user');
      }
    });

    it('4.7: IR tools -> collectAuthRequirements -> deduplication with scope merging', () => {
      // This test constructs IR directly because scope merging depends on
      // http_binding.auth.config.oauth.scopes which is not expressible in DSL tool properties
      const output = makeOutput({
        agent1: makeAgentIR([
          makeToolDef({
            name: 'gmail_read',
            auth_profile_ref: 'google-creds',
            consent_mode: 'preflight',
            connection_mode: 'per_user',
            http_binding: {
              endpoint: '/read',
              method: 'GET' as const,
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
            consent_mode: 'preflight',
            connection_mode: 'per_user',
            http_binding: {
              endpoint: '/send',
              method: 'POST' as const,
              auth: {
                type: 'oauth2_client',
                config: {
                  oauth: {
                    tokenUrl: 'https://oauth.google.com',
                    clientId: 'c',
                    scopes: ['gmail.send', 'gmail.readonly'],
                  },
                },
              },
            },
          }),
        ]),
      });

      const requirements = collectAuthRequirements(output);

      expect(requirements).toHaveLength(1);
      expect(requirements[0].auth_profile_ref).toBe('google-creds');
      expect(requirements[0].scopes).toEqual(
        expect.arrayContaining(['gmail.readonly', 'gmail.send']),
      );
    });

    it('4.8: compiled IR tool with jit_auth -> has correct fields for middleware compatibility', () => {
      const dsl = `AGENT: booking_agent
GOAL: Book appointments

TOOLS:
  gmail_lookup(query: string) -> Result
    auth_profile: "google-creds"
    auth_jit: true
    consent: inline
    connection: per_user
    description: "Look up Gmail"
`;

      const output = compileDSL(dsl);
      const tool = findTool(output, 'gmail_lookup');

      // Verify tool has the fields the auth middleware checks
      expect(tool.auth_profile_ref).toBe('google-creds');
      expect(tool.jit_auth).toBe(true);
      expect(tool.consent_mode).toBe('inline');
      expect(tool.connection_mode).toBe('per_user');
    });
  });

  describe('Validation', () => {
    it('4.9: auth_jit: true without auth_profile -> compile-time warning from validateAuthJitRequiresProfile', () => {
      const dsl = `AGENT: booking_agent
GOAL: Book appointments

TOOLS:
  orphan_jit_tool(query: string) -> Result
    auth_jit: true
    description: "Tool with JIT but no profile"
`;

      const output = compileDSL(dsl);
      const agent = Object.values(output.agents)[0];
      expect(agent).toBeDefined();

      // Verify the tool has jit_auth but no auth_profile_ref
      const tool = agent.tools.find((t) => t.name === 'orphan_jit_tool');
      expect(tool).toBeDefined();
      expect(tool!.jit_auth).toBe(true);
      expect(tool!.auth_profile_ref).toBeUndefined();

      // Run the validator and check it flags the issue
      const agentName = Object.keys(output.agents)[0];
      const diagnostics = validateAuthJitRequiresProfile(agent, agentName);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].severity).toBe('warning');
      expect(diagnostics[0].code).toBe('AUTH_JIT_WITHOUT_PROFILE');
      expect(diagnostics[0].message).toContain('auth_jit');
      expect(diagnostics[0].message).toContain('auth_profile');
    });

    it('4.10: consent: preflight without auth_profile -> collectAuthRequirements ignores it', () => {
      const dsl = `AGENT: booking_agent
GOAL: Book appointments

TOOLS:
  orphan_consent_tool(query: string) -> Result
    consent: preflight
    description: "Tool with consent but no profile"
`;

      const output = compileDSL(dsl);
      const tool = findTool(output, 'orphan_consent_tool');

      // Verify the tool has consent_mode but no auth_profile_ref
      expect(tool.consent_mode).toBe('preflight');
      expect(tool.auth_profile_ref).toBeUndefined();

      // collectAuthRequirements ignores tools without auth_profile_ref
      const requirements = collectAuthRequirements(output);
      expect(requirements).toHaveLength(0);
    });
  });

  describe('Cross-agent auth requirement collection', () => {
    it('collects requirements from multiple agents compiled from DSL', () => {
      const dsl1 = `AGENT: booking_agent
GOAL: Book appointments

TOOLS:
  gmail_lookup(query: string) -> Result
    auth_profile: "google-creds"
    consent: preflight
    connection: per_user
    description: "Gmail"
`;

      const dsl2 = `AGENT: support_agent
GOAL: Support users

TOOLS:
  sf_query(query: string) -> Result
    auth_profile: "salesforce-creds"
    consent: preflight
    connection: per_user
    description: "Salesforce"
`;

      const dsl3 = `AGENT: internal_agent
GOAL: Internal operations

TOOLS:
  internal_tool(input: string) -> Result
    description: "No auth"
`;

      const parsed1 = parseAgentBasedABL(dsl1);
      const parsed2 = parseAgentBasedABL(dsl2);
      const parsed3 = parseAgentBasedABL(dsl3);

      expect(parsed1.errors).toHaveLength(0);
      expect(parsed2.errors).toHaveLength(0);
      expect(parsed3.errors).toHaveLength(0);

      const output = compileABLtoIR([parsed1.document!, parsed2.document!, parsed3.document!]);
      expect(output.compilation_errors ?? []).toHaveLength(0);

      const requirements = collectAuthRequirements(output);

      expect(requirements).toHaveLength(2);
      const refs = requirements.map((r) => r.auth_profile_ref).sort();
      expect(refs).toEqual(['google-creds', 'salesforce-creds']);
    });

    it('preflight takes precedence over inline when same profile appears in different agents', () => {
      const dsl1 = `AGENT: agent1
GOAL: Agent 1

TOOLS:
  tool1(input: string) -> Result
    auth_profile: "shared-creds"
    consent: inline
    connection: per_user
    description: "Inline consent"
`;

      const dsl2 = `AGENT: agent2
GOAL: Agent 2

TOOLS:
  tool2(input: string) -> Result
    auth_profile: "shared-creds"
    consent: preflight
    connection: per_user
    description: "Preflight consent"
`;

      const parsed1 = parseAgentBasedABL(dsl1);
      const parsed2 = parseAgentBasedABL(dsl2);

      expect(parsed1.errors).toHaveLength(0);
      expect(parsed2.errors).toHaveLength(0);

      const output = compileABLtoIR([parsed1.document!, parsed2.document!]);
      expect(output.compilation_errors ?? []).toHaveLength(0);

      const requirements = collectAuthRequirements(output);

      expect(requirements).toHaveLength(1);
      expect(requirements[0].consent_mode).toBe('preflight');
    });

    it('uses connector_binding.connector name when available (IR-level)', () => {
      // connector_binding is not expressible in DSL — test at IR level
      const output = makeOutput({
        agent1: makeAgentIR([
          makeToolDef({
            name: 'gmail_tool',
            auth_profile_ref: 'google-creds',
            consent_mode: 'preflight',
            connection_mode: 'per_user',
            connector_binding: { connector: 'gmail', action: 'search' },
          }),
        ]),
      });

      const requirements = collectAuthRequirements(output);

      expect(requirements).toHaveLength(1);
      expect(requirements[0].connector).toBe('gmail');
      expect(requirements[0].auth_profile_ref).toBe('google-creds');
    });
  });
});
