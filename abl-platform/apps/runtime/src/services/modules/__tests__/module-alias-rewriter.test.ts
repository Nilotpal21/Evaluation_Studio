/**
 * Module Alias Rewriter Tests
 *
 * Validates: alias validation, rename map building, deep IR rewriting,
 * collision detection, tool rewriting, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { validateAlias, buildRenameMap, rewriteModuleIR } from '../module-alias-rewriter.js';

// =============================================================================
// HELPERS
// =============================================================================

/** Minimal valid AgentIR scaffold — only required fields filled. */
function makeAgentIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'main',
      version: '1.0.0',
      type: 'agent',
      compiled_at: '2026-01-01T00:00:00Z',
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: 'autonomous',
      model: 'gpt-4',
      temperature: 0.7,
      max_turns: 10,
      max_tool_rounds: 5,
      operations: {},
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
    ...overrides,
  } as AgentIR;
}

// =============================================================================
// TESTS
// =============================================================================

describe('module-alias-rewriter', () => {
  // ---------------------------------------------------------------------------
  // validateAlias
  // ---------------------------------------------------------------------------
  describe('validateAlias', () => {
    it('accepts valid aliases', () => {
      expect(validateAlias('payments')).toBeNull();
      expect(validateAlias('my_module')).toBeNull();
      expect(validateAlias('ab')).toBeNull();
      expect(validateAlias('a1')).toBeNull();
      expect(validateAlias('abc_def_ghi')).toBeNull();
      expect(validateAlias('mod123')).toBeNull();
    });

    it('rejects alias starting with a number', () => {
      expect(validateAlias('1abc')).not.toBeNull();
    });

    it('rejects alias with uppercase letters', () => {
      expect(validateAlias('Payments')).not.toBeNull();
      expect(validateAlias('myModule')).not.toBeNull();
    });

    it('rejects alias that is too short (1 char)', () => {
      expect(validateAlias('a')).not.toBeNull();
    });

    it('rejects alias that is too long (>25 chars)', () => {
      // 26 chars total: 'a' + 25 more = 26
      const long = 'a' + 'b'.repeat(25);
      expect(long.length).toBe(26);
      expect(validateAlias(long)).not.toBeNull();
    });

    it('accepts alias at maximum length (25 chars)', () => {
      // pattern is {1,24} after first char = 25 total
      const maxLen = 'a' + 'b'.repeat(24);
      expect(maxLen.length).toBe(25);
      expect(validateAlias(maxLen)).toBeNull();
    });

    it('rejects alias containing double underscore', () => {
      expect(validateAlias('my__mod')).not.toBeNull();
    });

    it('rejects reserved prefix system_', () => {
      expect(validateAlias('system_mod')).not.toBeNull();
    });

    it('rejects reserved prefix internal_', () => {
      expect(validateAlias('internal_x')).not.toBeNull();
    });

    it('rejects reserved prefix test_', () => {
      expect(validateAlias('test_foo')).not.toBeNull();
    });

    it('rejects empty string', () => {
      expect(validateAlias('')).not.toBeNull();
    });

    it('rejects alias with special characters', () => {
      expect(validateAlias('my-mod')).not.toBeNull();
      expect(validateAlias('my.mod')).not.toBeNull();
      expect(validateAlias('my mod')).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // buildRenameMap
  // ---------------------------------------------------------------------------
  describe('buildRenameMap', () => {
    it('maps agent names with alias prefix and double-underscore separator', () => {
      const map = buildRenameMap('pay', ['main'], []);
      expect(map).toEqual({ main: 'pay__main' });
    });

    it('maps tool names with alias prefix', () => {
      const map = buildRenameMap('pay', [], ['lookup_order']);
      expect(map).toEqual({ lookup_order: 'pay__lookup_order' });
    });

    it('handles multiple agents and tools', () => {
      const map = buildRenameMap('crm', ['main', 'helper'], ['search', 'update']);
      expect(map).toEqual({
        main: 'crm__main',
        helper: 'crm__helper',
        search: 'crm__search',
        update: 'crm__update',
      });
    });

    it('returns empty map for empty inputs', () => {
      const map = buildRenameMap('pay', [], []);
      expect(map).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // rewriteModuleIR — core rewriting
  // ---------------------------------------------------------------------------
  describe('rewriteModuleIR', () => {
    it('rewrites agent metadata.name', () => {
      const agents = { main: makeAgentIR() };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      expect(result.agents['pay__main']).toBeDefined();
      expect(result.agents['pay__main'].metadata.name).toBe('pay__main');
    });

    it('rewrites declared agent and tool names back to mounted artifact keys', () => {
      const main = makeAgentIR({
        metadata: {
          name: 'DeclaredMain',
          version: '1.0.0',
          type: 'agent',
          compiled_at: '2026-01-01T00:00:00Z',
          source_hash: 'declared-main',
          compiler_version: '1.0.0',
        },
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: 'DeclaredHelper',
              when: 'true',
              context: { pass: [], summary: '' },
              return: false,
            },
          ],
        },
        tools: [
          {
            name: 'DeclaredLookup',
            description: 'lookup',
            parameters: [],
            returns: { type: 'string' },
            hints: {
              cacheable: false,
              latency: 'fast',
              parallelizable: true,
              side_effects: false,
              requires_auth: false,
            },
          },
        ] as AgentIR['tools'],
      });
      const helper = makeAgentIR({
        metadata: {
          name: 'DeclaredHelper',
          version: '1.0.0',
          type: 'agent',
          compiled_at: '2026-01-01T00:00:00Z',
          source_hash: 'declared-helper',
          compiler_version: '1.0.0',
        },
      });

      const result = rewriteModuleIR(
        'pay',
        { stored_main: main, stored_helper: helper },
        {
          stored_lookup: {
            definition: { name: 'DeclaredLookup', description: 'lookup' },
            toolType: 'http',
          },
        },
        new Set(),
      );

      expect(result.agents['pay__stored_main'].metadata.name).toBe('pay__stored_main');
      expect(result.agents['pay__stored_main'].coordination.handoffs[0].to).toBe(
        'pay__stored_helper',
      );
      expect(result.agents['pay__stored_main'].tools[0].name).toBe('pay__stored_lookup');
      expect(result.tools['pay__stored_lookup'].name).toBe('pay__stored_lookup');
      expect(result.renameMap.DeclaredMain).toBe('pay__stored_main');
      expect(result.renameMap.DeclaredHelper).toBe('pay__stored_helper');
      expect(result.renameMap.DeclaredLookup).toBe('pay__stored_lookup');
    });

    it('fails closed when declared names map ambiguously across artifact keys', () => {
      const main = makeAgentIR({
        metadata: {
          name: 'helper',
          version: '1.0.0',
          type: 'agent',
          compiled_at: '2026-01-01T00:00:00Z',
          source_hash: 'ambiguous-main',
          compiler_version: '1.0.0',
        },
      });
      const helper = makeAgentIR({
        metadata: {
          name: 'helper',
          version: '1.0.0',
          type: 'agent',
          compiled_at: '2026-01-01T00:00:00Z',
          source_hash: 'helper',
          compiler_version: '1.0.0',
        },
      });

      expect(() => rewriteModuleIR('pay', { stored_main: main, helper }, {}, new Set())).toThrow(
        /ambiguous source symbol/,
      );
    });

    it('rewrites handoff targets', () => {
      const ir = makeAgentIR({
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: 'helper',
              when: 'true',
              context: { pass: [], summary: '' },
              return: false,
            },
          ],
        },
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'def456',
            compiler_version: '1.0.0',
          },
        }),
      };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      const mainIR = result.agents['pay__main'];
      expect(mainIR.coordination.handoffs[0].to).toBe('pay__helper');
    });

    it('rewrites tool references in agent tools array', () => {
      const ir = makeAgentIR({
        tools: [
          {
            name: 'lookup',
            description: 'lookup',
            parameters: [],
            returns: { type: 'string' },
            hints: {
              cacheable: false,
              latency: 'fast',
              parallelizable: true,
              side_effects: false,
              requires_auth: false,
            },
          },
        ] as AgentIR['tools'],
      });
      const result = rewriteModuleIR(
        'pay',
        { main: ir },
        { lookup: { definition: { name: 'lookup' }, toolType: 'http' } },
        new Set(),
      );
      const mainIR = result.agents['pay__main'];
      expect(mainIR.tools[0].name).toBe('pay__lookup');
    });

    it('rewrites routing rule targets and default_agent', () => {
      const ir = makeAgentIR({
        routing: {
          rules: [{ to: 'billing', when: 'true', description: 'billing', priority: 1 }],
          default_agent: 'main',
          intent_classification: {
            categories: [],
            min_confidence: 0.5,
            source: 'inferred' as const,
          },
        },
      });
      const agents = {
        main: ir,
        billing: makeAgentIR({
          metadata: {
            name: 'billing',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'ghi789',
            compiler_version: '1.0.0',
          },
        }),
      };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      const mainIR = result.agents['pay__main'];
      expect(mainIR.routing!.rules[0].to).toBe('pay__billing');
      expect(mainIR.routing!.default_agent).toBe('pay__main');
    });

    it('rewrites delegate targets', () => {
      const ir = makeAgentIR({
        coordination: {
          delegates: [
            {
              agent: 'helper',
              when: 'true',
              purpose: 'help',
              input: {},
              returns: {},
              use_result: 'store',
              on_failure: 'continue',
            },
          ],
          handoffs: [],
        },
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'jkl012',
            compiler_version: '1.0.0',
          },
        }),
      };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      const mainIR = result.agents['pay__main'];
      expect(mainIR.coordination.delegates[0].agent).toBe('pay__helper');
    });

    it('rewrites available_agents', () => {
      const ir = makeAgentIR({
        available_agents: ['billing', 'support'],
      });
      const agents = {
        main: ir,
        billing: makeAgentIR({
          metadata: {
            name: 'billing',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'aaa',
            compiler_version: '1.0.0',
          },
        }),
        support: makeAgentIR({
          metadata: {
            name: 'support',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'bbb',
            compiler_version: '1.0.0',
          },
        }),
      };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      const mainIR = result.agents['pay__main'];
      expect(mainIR.available_agents).toEqual(['pay__billing', 'pay__support']);
    });

    it('rewrites constraint on_fail handoff target', () => {
      const ir = makeAgentIR({
        constraints: {
          constraints: [
            {
              condition: 'amount > 0',
              on_fail: { type: 'handoff', target: 'helper' },
            },
          ],
          guardrails: [],
        },
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'ccc',
            compiler_version: '1.0.0',
          },
        }),
      };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      const mainIR = result.agents['pay__main'];
      expect(mainIR.constraints.constraints[0].on_fail.target).toBe('pay__helper');
    });

    it('does not rewrite constraint on_fail target when type is not handoff', () => {
      const ir = makeAgentIR({
        constraints: {
          constraints: [
            {
              condition: 'x > 0',
              on_fail: { type: 'respond', target: 'helper', message: 'no' },
            },
          ],
          guardrails: [],
        },
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'ddd',
            compiler_version: '1.0.0',
          },
        }),
      };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      const mainIR = result.agents['pay__main'];
      // target left as-is because on_fail.type is not 'handoff'
      expect(mainIR.constraints.constraints[0].on_fail.target).toBe('helper');
    });

    it('rewrites flow step call (tool name)', () => {
      const ir = makeAgentIR({
        flow: {
          entry_point: 'step1',
          steps: ['step1'],
          definitions: {
            step1: {
              name: 'step1',
              call: 'lookup',
              then: 'END',
            } as any,
          },
        },
      });
      const result = rewriteModuleIR(
        'pay',
        { main: ir },
        { lookup: { definition: { name: 'lookup' }, toolType: 'http' } },
        new Set(),
      );
      const mainIR = result.agents['pay__main'];
      expect((mainIR.flow!.definitions['step1'] as any).call).toBe('pay__lookup');
    });

    it('rewrites flow step digressions delegate and call', () => {
      const ir = makeAgentIR({
        flow: {
          entry_point: 'step1',
          steps: ['step1'],
          definitions: {
            step1: {
              name: 'step1',
              digressions: [
                { delegate: 'helper', when: 'true' },
                { call: 'lookup', when: 'true' },
              ],
              then: 'END',
            } as any,
          },
        },
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'eee',
            compiler_version: '1.0.0',
          },
        }),
      };
      const result = rewriteModuleIR(
        'pay',
        agents,
        { lookup: { definition: { name: 'lookup' }, toolType: 'http' } },
        new Set(),
      );
      const step = result.agents['pay__main'].flow!.definitions['step1'] as any;
      expect(step.digressions[0].delegate).toBe('pay__helper');
      expect(step.digressions[1].call).toBe('pay__lookup');
    });

    it('rewrites flow step on_error handoff_target', () => {
      const ir = makeAgentIR({
        flow: {
          entry_point: 'step1',
          steps: ['step1'],
          definitions: {
            step1: {
              name: 'step1',
              on_error: [{ handoff_target: 'helper' }],
              then: 'END',
            } as any,
          },
        },
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'fff',
            compiler_version: '1.0.0',
          },
        }),
      };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      const step = result.agents['pay__main'].flow!.definitions['step1'] as any;
      expect(step.on_error[0].handoff_target).toBe('pay__helper');
    });

    it('rewrites flow step on_success and on_failure call', () => {
      const ir = makeAgentIR({
        flow: {
          entry_point: 'step1',
          steps: ['step1'],
          definitions: {
            step1: {
              name: 'step1',
              on_success: { call: 'notify' },
              on_failure: {
                call: 'log_err',
                branches: [{ when: 'true', call: 'lookup' }],
              },
              then: 'END',
            } as any,
          },
        },
      });
      const tools = {
        notify: { definition: { name: 'notify' }, toolType: 'http' },
        log_err: { definition: { name: 'log_err' }, toolType: 'http' },
        lookup: { definition: { name: 'lookup' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('pay', { main: ir }, tools, new Set());
      const step = result.agents['pay__main'].flow!.definitions['step1'] as any;
      expect(step.on_success.call).toBe('pay__notify');
      expect(step.on_failure.call).toBe('pay__log_err');
      expect(step.on_failure.branches[0].call).toBe('pay__lookup');
    });

    it('rewrites flow step on_result and on_input call', () => {
      const ir = makeAgentIR({
        flow: {
          entry_point: 'step1',
          steps: ['step1'],
          definitions: {
            step1: {
              name: 'step1',
              on_result: [{ when: 'true', call: 'lookup' }],
              on_input: [{ when: 'true', call: 'notify' }],
              then: 'END',
            } as any,
          },
        },
      });
      const tools = {
        lookup: { definition: { name: 'lookup' }, toolType: 'http' },
        notify: { definition: { name: 'notify' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('pay', { main: ir }, tools, new Set());
      const step = result.agents['pay__main'].flow!.definitions['step1'] as any;
      expect(step.on_result[0].call).toBe('pay__lookup');
      expect(step.on_input[0].call).toBe('pay__notify');
    });

    it('rewrites flow step reasoning_zone available_tools', () => {
      const ir = makeAgentIR({
        flow: {
          entry_point: 'step1',
          steps: ['step1'],
          definitions: {
            step1: {
              name: 'step1',
              reasoning_zone: { available_tools: ['lookup', 'notify'] },
              then: 'END',
            } as any,
          },
        },
      });
      const tools = {
        lookup: { definition: { name: 'lookup' }, toolType: 'http' },
        notify: { definition: { name: 'notify' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('pay', { main: ir }, tools, new Set());
      const step = result.agents['pay__main'].flow!.definitions['step1'] as any;
      expect(step.reasoning_zone.available_tools).toEqual(['pay__lookup', 'pay__notify']);
    });

    it('rewrites flow step sub_intents call', () => {
      const ir = makeAgentIR({
        flow: {
          entry_point: 'step1',
          steps: ['step1'],
          definitions: {
            step1: {
              name: 'step1',
              sub_intents: [{ when: 'true', call: 'lookup' }],
              then: 'END',
            } as any,
          },
        },
      });
      const tools = {
        lookup: { definition: { name: 'lookup' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('pay', { main: ir }, tools, new Set());
      const step = result.agents['pay__main'].flow!.definitions['step1'] as any;
      expect(step.sub_intents[0].call).toBe('pay__lookup');
    });

    it('rewrites global_digressions delegate and call', () => {
      const ir = makeAgentIR({
        flow: {
          entry_point: 'step1',
          steps: ['step1'],
          definitions: {},
          global_digressions: [
            { delegate: 'helper', when: 'true' },
            { call: 'lookup', when: 'true' },
          ] as any,
        },
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'ggg',
            compiler_version: '1.0.0',
          },
        }),
      };
      const tools = {
        lookup: { definition: { name: 'lookup' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('pay', agents, tools, new Set());
      const mainIR = result.agents['pay__main'];
      expect((mainIR.flow!.global_digressions as any)[0].delegate).toBe('pay__helper');
      expect((mainIR.flow!.global_digressions as any)[1].call).toBe('pay__lookup');
    });

    it('rewrites error_handling handler handoff_target', () => {
      const ir = makeAgentIR({
        error_handling: {
          handlers: [{ type: 'timeout', then: 'handoff', handoff_target: 'helper' }],
          default_handler: {
            type: 'default',
            then: 'handoff',
            handoff_target: 'helper',
          },
        },
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'hhh',
            compiler_version: '1.0.0',
          },
        }),
      };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      const mainIR = result.agents['pay__main'];
      expect(mainIR.error_handling.handlers[0].handoff_target).toBe('pay__helper');
      expect(mainIR.error_handling.default_handler.handoff_target).toBe('pay__helper');
    });

    it('rewrites on_start call and delegate', () => {
      const ir = makeAgentIR({
        on_start: {
          call: 'init_tool',
          delegate: 'helper',
        },
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'iii',
            compiler_version: '1.0.0',
          },
        }),
      };
      const tools = {
        init_tool: { definition: { name: 'init_tool' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('pay', agents, tools, new Set());
      const mainIR = result.agents['pay__main'];
      expect(mainIR.on_start!.call).toBe('pay__init_tool');
      expect(mainIR.on_start!.delegate).toBe('pay__helper');
    });

    it('rewrites behavior_profiles tools_hide and tools_add', () => {
      const ir = makeAgentIR({
        behavior_profiles: [
          {
            name: 'vip',
            priority: 1,
            when: 'true',
            tools_hide: ['lookup'],
            tools_add: [
              {
                name: 'premium_lookup',
                description: 'premium',
                parameters: [],
                returns: { type: 'string' },
                hints: {
                  cacheable: false,
                  latency: 'fast',
                  parallelizable: true,
                  side_effects: false,
                  requires_auth: false,
                },
              },
            ] as AgentIR['tools'],
          },
        ],
      });
      const tools = {
        lookup: { definition: { name: 'lookup' }, toolType: 'http' },
        premium_lookup: {
          definition: { name: 'premium_lookup' },
          toolType: 'http',
        },
      };
      const result = rewriteModuleIR('pay', { main: ir }, tools, new Set());
      const mainIR = result.agents['pay__main'];
      expect(mainIR.behavior_profiles![0].tools_hide).toEqual(['pay__lookup']);
      expect(mainIR.behavior_profiles![0].tools_add![0].name).toBe('pay__premium_lookup');
    });

    it('rewrites behavior_profiles constraint handoff target', () => {
      const ir = makeAgentIR({
        behavior_profiles: [
          {
            name: 'strict',
            priority: 1,
            when: 'true',
            constraints: [
              {
                condition: 'x > 0',
                on_fail: { type: 'handoff', target: 'helper' },
              },
            ],
          },
        ],
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'jjj',
            compiler_version: '1.0.0',
          },
        }),
      };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      const mainIR = result.agents['pay__main'];
      expect(mainIR.behavior_profiles![0].constraints![0].on_fail.target).toBe('pay__helper');
    });

    it('rewrites hooks call references', () => {
      const ir = makeAgentIR({
        hooks: {
          before_agent: { call: 'setup_tool' },
          after_agent: { call: 'cleanup_tool' },
          before_turn: { call: 'check_tool' },
          after_turn: { call: 'log_tool' },
        },
      });
      const tools = {
        setup_tool: { definition: { name: 'setup_tool' }, toolType: 'http' },
        cleanup_tool: {
          definition: { name: 'cleanup_tool' },
          toolType: 'http',
        },
        check_tool: { definition: { name: 'check_tool' }, toolType: 'http' },
        log_tool: { definition: { name: 'log_tool' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('pay', { main: ir }, tools, new Set());
      const mainIR = result.agents['pay__main'];
      expect(mainIR.hooks!.before_agent!.call).toBe('pay__setup_tool');
      expect(mainIR.hooks!.after_agent!.call).toBe('pay__cleanup_tool');
      expect(mainIR.hooks!.before_turn!.call).toBe('pay__check_tool');
      expect(mainIR.hooks!.after_turn!.call).toBe('pay__log_tool');
    });

    it('does not rewrite CEL condition strings', () => {
      const ir = makeAgentIR({
        constraints: {
          constraints: [
            {
              condition: 'helper.status == "active"',
              on_fail: { type: 'respond', message: 'blocked' },
            },
          ],
          guardrails: [],
        },
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'kkk',
            compiler_version: '1.0.0',
          },
        }),
      };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      const mainIR = result.agents['pay__main'];
      // CEL condition string is not rewritten
      expect(mainIR.constraints.constraints[0].condition).toBe('helper.status == "active"');
    });

    it('does not rewrite step names', () => {
      const ir = makeAgentIR({
        flow: {
          entry_point: 'step1',
          steps: ['step1', 'step2'],
          definitions: {
            step1: {
              name: 'step1',
              then: 'step2',
            } as any,
            step2: {
              name: 'step2',
              then: 'END',
            } as any,
          },
        },
      });
      const result = rewriteModuleIR('pay', { main: ir }, {}, new Set());
      const mainIR = result.agents['pay__main'];
      // step names are NOT in renameMap, so they stay as-is
      expect(mainIR.flow!.definitions['step1']).toBeDefined();
      expect(mainIR.flow!.definitions['step2']).toBeDefined();
      expect((mainIR.flow!.definitions['step1'] as any).name).toBe('step1');
    });

    it('leaves unknown/unmapped names unchanged', () => {
      const ir = makeAgentIR({
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: 'external_agent',
              when: 'true',
              context: { pass: [], summary: '' },
              return: false,
            },
          ],
        },
      });
      // 'external_agent' is not in agents map, so not in renameMap
      const result = rewriteModuleIR('pay', { main: ir }, {}, new Set());
      const mainIR = result.agents['pay__main'];
      expect(mainIR.coordination.handoffs[0].to).toBe('external_agent');
    });

    it('throws on invalid alias', () => {
      expect(() => rewriteModuleIR('1bad', {}, {}, new Set())).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Collision detection
  // ---------------------------------------------------------------------------
  describe('collision detection', () => {
    it('detects collisions with existing symbols', () => {
      const existing = new Set(['pay__main']);
      const agents = { main: makeAgentIR() };
      const result = rewriteModuleIR('pay', agents, {}, existing);
      expect(result.collisions).toContain('pay__main');
    });

    it('reports multiple collisions', () => {
      const existing = new Set(['crm__main', 'crm__lookup']);
      const agents = { main: makeAgentIR() };
      const tools = {
        lookup: { definition: { name: 'lookup' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('crm', agents, tools, existing);
      expect(result.collisions).toEqual(expect.arrayContaining(['crm__main', 'crm__lookup']));
      expect(result.collisions).toHaveLength(2);
    });

    it('detects internal mounted-name collisions between module agents and tools', () => {
      const agents = { shared: makeAgentIR() };
      const tools = {
        shared: { definition: { name: 'shared' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('pay', agents, tools, new Set());

      expect(result.collisions).toContain('pay__shared');
    });

    it('returns empty collisions when none exist', () => {
      const agents = { main: makeAgentIR() };
      const result = rewriteModuleIR('pay', agents, {}, new Set());
      expect(result.collisions).toEqual([]);
    });

    it('still returns rewritten result even with collisions', () => {
      const existing = new Set(['pay__main']);
      const agents = { main: makeAgentIR() };
      const result = rewriteModuleIR('pay', agents, {}, existing);
      // collisions are reported but rewriting still happens
      expect(result.agents['pay__main']).toBeDefined();
      expect(result.collisions).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool rewriting
  // ---------------------------------------------------------------------------
  describe('tool rewriting', () => {
    it('rewrites tool definition names and keys', () => {
      const tools = {
        lookup: { definition: { name: 'lookup', description: 'find stuff' }, toolType: 'http' },
        update: { definition: { name: 'update', description: 'update stuff' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('pay', { main: makeAgentIR() }, tools, new Set());
      expect(result.tools['pay__lookup']).toBeDefined();
      expect(result.tools['pay__update']).toBeDefined();
      // Original keys should not exist
      expect(result.tools['lookup']).toBeUndefined();
      expect(result.tools['update']).toBeUndefined();
    });

    it('includes tool_type from source', () => {
      const tools = {
        lookup: { definition: { name: 'lookup' }, toolType: 'mcp' },
      };
      const result = rewriteModuleIR('pay', { main: makeAgentIR() }, tools, new Set());
      expect((result.tools['pay__lookup'] as any).tool_type).toBe('mcp');
    });

    it('strips variable_namespace_ids from tool definitions', () => {
      const agents: Record<string, AgentIR> = {
        lookup_agent: makeAgentIR({
          metadata: {
            name: 'lookup_agent',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'ns-strip',
            compiler_version: '1.0.0',
          },
          tools: [
            {
              name: 'search',
              tool_type: 'http',
              variable_namespace_ids: ['ns-source-123', 'ns-source-456'],
            } as any,
          ],
        }),
      };
      const tools = {
        search: { definition: { name: 'search' }, toolType: 'http' },
      };

      const result = rewriteModuleIR('benefits', agents, tools, new Set());

      const rewrittenAgent = result.agents['benefits__lookup_agent'];
      expect(rewrittenAgent).toBeDefined();
      const tool = rewrittenAgent.tools?.[0];
      expect(tool?.name).toBe('benefits__search');
      expect((tool as any).variable_namespace_ids).toBeUndefined();
    });

    it('renameMap includes tool entries', () => {
      const tools = {
        lookup: { definition: { name: 'lookup' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('pay', { main: makeAgentIR() }, tools, new Set());
      expect(result.renameMap['lookup']).toBe('pay__lookup');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty agents and tools maps', () => {
      const result = rewriteModuleIR('pay', {}, {}, new Set());
      expect(result.agents).toEqual({});
      expect(result.tools).toEqual({});
      expect(result.renameMap).toEqual({});
      expect(result.collisions).toEqual([]);
    });

    it('handles agent with no handoffs, tools, or routing', () => {
      const ir = makeAgentIR();
      const result = rewriteModuleIR('pay', { main: ir }, {}, new Set());
      expect(result.agents['pay__main']).toBeDefined();
      expect(result.agents['pay__main'].coordination.handoffs).toEqual([]);
      expect(result.agents['pay__main'].coordination.delegates).toEqual([]);
      expect(result.agents['pay__main'].tools).toEqual([]);
    });

    it('does not mutate original IR objects', () => {
      const ir = makeAgentIR({
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: 'helper',
              when: 'true',
              context: { pass: [], summary: '' },
              return: false,
            },
          ],
        },
      });
      const agents = {
        main: ir,
        helper: makeAgentIR({
          metadata: {
            name: 'helper',
            version: '1.0.0',
            type: 'agent',
            compiled_at: '2026-01-01T00:00:00Z',
            source_hash: 'lll',
            compiler_version: '1.0.0',
          },
        }),
      };
      // Capture original values
      const originalMainName = agents.main.metadata.name;
      const originalHandoffTo = agents.main.coordination.handoffs[0].to;

      rewriteModuleIR('pay', agents, {}, new Set());

      // Original objects should be unchanged
      expect(agents.main.metadata.name).toBe(originalMainName);
      expect(agents.main.coordination.handoffs[0].to).toBe(originalHandoffTo);
    });

    it('handles tool definition without name field', () => {
      const tools = {
        lookup: { definition: { description: 'no name field' }, toolType: 'http' },
      };
      const result = rewriteModuleIR('pay', { main: makeAgentIR() }, tools, new Set());
      // Should still be keyed under aliased name
      expect(result.tools['pay__lookup']).toBeDefined();
    });

    it('handles multiple agents each getting rewritten independently', () => {
      const mainIR = makeAgentIR({
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: 'helper',
              when: 'true',
              context: { pass: [], summary: '' },
              return: false,
            },
          ],
        },
      });
      const helperIR = makeAgentIR({
        metadata: {
          name: 'helper',
          version: '1.0.0',
          type: 'agent',
          compiled_at: '2026-01-01T00:00:00Z',
          source_hash: 'mmm',
          compiler_version: '1.0.0',
        },
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: 'main',
              when: 'true',
              context: { pass: [], summary: '' },
              return: false,
            },
          ],
        },
      });
      const result = rewriteModuleIR('pay', { main: mainIR, helper: helperIR }, {}, new Set());
      expect(result.agents['pay__main'].coordination.handoffs[0].to).toBe('pay__helper');
      expect(result.agents['pay__helper'].coordination.handoffs[0].to).toBe('pay__main');
      expect(result.agents['pay__helper'].metadata.name).toBe('pay__helper');
    });
  });
});
