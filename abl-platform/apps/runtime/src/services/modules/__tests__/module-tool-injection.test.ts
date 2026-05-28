/**
 * Module Tool Injection Tests
 *
 * Validates that injectMissingModuleTools correctly injects module tools
 * into consumer agents (by flow step reference) and module agents (by alias prefix),
 * does not duplicate existing tools, and handles agents with no tools array.
 */

import { describe, it, expect } from 'vitest';
import type { AgentIR, ToolDefinition } from '@abl/compiler';
import type { ResolvedToolDefinition } from '../types.js';
import { collectToolReferences, injectMissingModuleTools } from '../module-tool-injection.js';

// =============================================================================
// HELPERS
// =============================================================================

/** Minimal valid AgentIR scaffold — only required fields filled. */
function makeAgentIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test-agent',
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

function makeToolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    parameters: [],
    returns: { type: 'string', description: 'result' },
    hints: {},
    tool_type: 'http',
    http_binding: { url: 'https://example.com/api', method: 'POST' },
  } as unknown as ToolDefinition;
}

function makeResolvedTool(
  name: string,
  alias: string,
  sourceToolName?: string,
): ResolvedToolDefinition {
  return {
    name,
    description: `Resolved tool ${name}`,
    parameters: [],
    returns: { type: 'string', description: 'result' },
    hints: {},
    tool_type: 'http',
    http_binding: { url: 'https://module.example.com/api', method: 'POST' },
    _moduleProvenance: {
      alias,
      moduleProjectId: 'mod-proj-1',
      moduleReleaseId: 'mod-rel-1',
      sourceToolName: sourceToolName ?? name,
    },
  } as unknown as ResolvedToolDefinition;
}

// =============================================================================
// TESTS
// =============================================================================

describe('injectMissingModuleTools', () => {
  it('should inject a module tool into an agent that references it in flow steps', () => {
    const agent = makeAgentIR({
      tools: [makeToolDefinition('local-tool')],
      flow: {
        steps: ['step1', 'step2'],
        definitions: {
          step1: {
            name: 'step1',
            call: 'payments__charge',
            respond: 'Payment processed',
          },
          step2: {
            name: 'step2',
            call_spec: { tool: 'payments__refund', with: { reason: 'user_request' } },
            respond: 'Refund issued',
          },
        },
      },
    });

    const resolvedTools: Record<string, ResolvedToolDefinition> = {
      payments__charge: makeResolvedTool('payments__charge', 'payments', 'charge'),
      payments__refund: makeResolvedTool('payments__refund', 'payments', 'refund'),
    };

    injectMissingModuleTools(agent, resolvedTools);

    expect(agent.tools).toHaveLength(3); // local-tool + 2 injected
    const toolNames = agent.tools.map((t) => t.name);
    expect(toolNames).toContain('local-tool');
    expect(toolNames).toContain('payments__charge');
    expect(toolNames).toContain('payments__refund');
  });

  it('should inject module tools for module agents by matching alias prefix', () => {
    const agent = makeAgentIR({
      metadata: {
        name: 'payments__order-agent',
        version: '1.0.0',
        type: 'agent',
        compiled_at: '2026-01-01T00:00:00Z',
        source_hash: 'abc123',
        compiler_version: '1.0.0',
      },
      tools: [],
    });

    // Attach module provenance to the agent
    (agent as unknown as Record<string, unknown>)._moduleProvenance = {
      alias: 'payments',
      moduleProjectId: 'mod-proj-1',
      moduleReleaseId: 'mod-rel-1',
      sourceAgentName: 'order-agent',
    };

    const resolvedTools: Record<string, ResolvedToolDefinition> = {
      payments__charge: makeResolvedTool('payments__charge', 'payments', 'charge'),
      payments__refund: makeResolvedTool('payments__refund', 'payments', 'refund'),
      analytics__track: makeResolvedTool('analytics__track', 'analytics', 'track'),
    };

    injectMissingModuleTools(agent, resolvedTools);

    expect(agent.tools).toHaveLength(2); // only payments/* tools, not analytics/*
    const toolNames = agent.tools.map((t) => t.name);
    expect(toolNames).toContain('payments__charge');
    expect(toolNames).toContain('payments__refund');
    expect(toolNames).not.toContain('analytics__track');
  });

  it('should not duplicate tools already present in the agent', () => {
    const existingTool = makeToolDefinition('payments__charge');
    const agent = makeAgentIR({
      tools: [existingTool],
      flow: {
        steps: ['step1'],
        definitions: {
          step1: {
            name: 'step1',
            call: 'payments__charge',
            respond: 'done',
          },
        },
      },
    });

    const resolvedTools: Record<string, ResolvedToolDefinition> = {
      payments__charge: makeResolvedTool('payments__charge', 'payments', 'charge'),
    };

    injectMissingModuleTools(agent, resolvedTools);

    expect(agent.tools).toHaveLength(1); // no duplicate
    expect(agent.tools[0].name).toBe('payments__charge');
    // Should still be the original tool (not replaced — that's Phase 1's job)
    expect(agent.tools[0]).toBe(existingTool);
  });

  it('should handle agents with no tools array', () => {
    const agentData = makeAgentIR({
      flow: {
        steps: ['step1'],
        definitions: {
          step1: {
            name: 'step1',
            call: 'payments__charge',
            respond: 'done',
          },
        },
      },
    });
    // Simulate an agent with undefined tools
    delete (agentData as unknown as Record<string, unknown>).tools;

    const resolvedTools: Record<string, ResolvedToolDefinition> = {
      payments__charge: makeResolvedTool('payments__charge', 'payments', 'charge'),
    };

    injectMissingModuleTools(agentData, resolvedTools);

    expect(agentData.tools).toHaveLength(1);
    expect(agentData.tools[0].name).toBe('payments__charge');
  });

  it('should inject tools referenced in reasoning_zone.available_tools', () => {
    const agent = makeAgentIR({
      tools: [],
      flow: {
        steps: ['reason-step'],
        definitions: {
          'reason-step': {
            name: 'reason-step',
            reasoning_zone: {
              goal: 'Process the order',
              available_tools: ['payments__charge', 'payments__validate'],
              max_turns: 5,
            },
          },
        },
      },
    });

    const resolvedTools: Record<string, ResolvedToolDefinition> = {
      payments__charge: makeResolvedTool('payments__charge', 'payments', 'charge'),
      payments__validate: makeResolvedTool('payments__validate', 'payments', 'validate'),
    };

    injectMissingModuleTools(agent, resolvedTools);

    expect(agent.tools).toHaveLength(2);
    const toolNames = agent.tools.map((t) => t.name);
    expect(toolNames).toContain('payments__charge');
    expect(toolNames).toContain('payments__validate');
  });

  it('should inject tools referenced in escalation connector_action', () => {
    const agent = makeAgentIR({
      tools: [],
      coordination: {
        delegates: [],
        handoffs: [],
        escalation: {
          triggers: [{ when: 'user requests human', reason: 'user request', priority: 'medium' }],
          context_for_human: ['order_id'],
          on_human_complete: [],
          connector_action: 'itsm__create_incident',
        },
      },
    });

    const resolvedTools: Record<string, ResolvedToolDefinition> = {
      itsm__create_incident: makeResolvedTool('itsm__create_incident', 'itsm', 'create_incident'),
    };

    injectMissingModuleTools(agent, resolvedTools);

    expect(agent.tools).toHaveLength(1);
    expect(agent.tools[0].name).toBe('itsm__create_incident');
  });

  it('should inject tools referenced in staticGraph nodes', () => {
    const agent = makeAgentIR({
      tools: [],
      flow: {
        steps: ['step1'],
        definitions: {
          step1: {
            name: 'step1',
            respond: 'done',
          },
        },
        staticGraph: {
          entryPoint: 'node-1',
          nodes: [
            {
              id: 'node-1',
              type: 'step',
              label: 'Charge',
              deterministic: true,
              step: { call: 'payments__charge' },
            },
          ],
          edges: [],
        },
      },
    });

    const resolvedTools: Record<string, ResolvedToolDefinition> = {
      payments__charge: makeResolvedTool('payments__charge', 'payments', 'charge'),
    };

    injectMissingModuleTools(agent, resolvedTools);

    expect(agent.tools).toHaveLength(1);
    expect(agent.tools[0].name).toBe('payments__charge');
  });

  it('should not inject when resolvedTools is empty', () => {
    const agent = makeAgentIR({ tools: [] });
    injectMissingModuleTools(agent, {});
    expect(agent.tools).toHaveLength(0);
  });

  it('should skip tools referenced but not in resolvedTools', () => {
    const agent = makeAgentIR({
      tools: [],
      flow: {
        steps: ['step1'],
        definitions: {
          step1: {
            name: 'step1',
            call: 'nonexistent_tool',
            respond: 'done',
          },
        },
      },
    });
    const resolvedTools: Record<string, ResolvedToolDefinition> = {
      'benefits/lookup': makeResolvedTool('benefits/lookup', 'benefits', 'lookup'),
    };
    injectMissingModuleTools(agent, resolvedTools);
    // nonexistent_tool is referenced but not in resolvedTools — nothing injected
    // benefits/lookup is in resolvedTools but not referenced — nothing injected
    expect(agent.tools).toHaveLength(0);
  });

  it('should handle module agent with all tools already present', () => {
    const existingTool = makeToolDefinition('payments__lookup');
    const agent = makeAgentIR({
      metadata: {
        name: 'payments__triage',
        version: '1.0.0',
        type: 'agent',
        compiled_at: '2026-01-01T00:00:00Z',
        source_hash: 'abc123',
        compiler_version: '1.0.0',
      },
      tools: [existingTool],
    });
    (agent as unknown as Record<string, unknown>)._moduleProvenance = {
      alias: 'payments',
      moduleProjectId: 'p1',
      moduleReleaseId: 'r1',
      sourceAgentName: 'triage',
    };
    const resolvedTools: Record<string, ResolvedToolDefinition> = {
      payments__lookup: makeResolvedTool('payments__lookup', 'payments', 'lookup'),
    };
    injectMissingModuleTools(agent, resolvedTools);
    expect(agent.tools).toHaveLength(1); // no duplicate
  });

  it('should process multiple agents independently', () => {
    const agent1 = makeAgentIR({
      metadata: {
        name: 'consumer1',
        version: '1.0.0',
        type: 'agent',
        compiled_at: '2026-01-01T00:00:00Z',
        source_hash: 'abc123',
        compiler_version: '1.0.0',
      },
      tools: [],
      flow: {
        steps: ['step1'],
        definitions: {
          step1: { name: 'step1', call: 'mod__tool_a', respond: 'done' },
        },
      },
    });
    const agent2 = makeAgentIR({
      metadata: {
        name: 'consumer2',
        version: '1.0.0',
        type: 'agent',
        compiled_at: '2026-01-01T00:00:00Z',
        source_hash: 'abc123',
        compiler_version: '1.0.0',
      },
      tools: [],
      flow: {
        steps: ['step1'],
        definitions: {
          step1: { name: 'step1', call: 'mod__tool_b', respond: 'done' },
        },
      },
    });
    const resolvedTools: Record<string, ResolvedToolDefinition> = {
      mod__tool_a: makeResolvedTool('mod__tool_a', 'mod', 'tool_a'),
      mod__tool_b: makeResolvedTool('mod__tool_b', 'mod', 'tool_b'),
    };
    injectMissingModuleTools(agent1, resolvedTools);
    injectMissingModuleTools(agent2, resolvedTools);
    expect(agent1.tools).toHaveLength(1);
    expect(agent1.tools[0].name).toBe('mod__tool_a');
    expect(agent2.tools).toHaveLength(1);
    expect(agent2.tools[0].name).toBe('mod__tool_b');
  });
});

describe('collectToolReferences', () => {
  it('should collect references from escalation connector_action', () => {
    const agent = makeAgentIR({
      coordination: {
        delegates: [],
        handoffs: [],
        escalation: {
          triggers: [{ when: 'always', reason: 'test', priority: 'medium' }],
          context_for_human: [],
          on_human_complete: [],
          connector_action: 'itsm__create_ticket',
        },
      },
    });

    const refs = collectToolReferences(agent);

    expect(refs.has('itsm__create_ticket')).toBe(true);
  });

  it('should return empty set for agent with no flow, no coordination, no tools', () => {
    const agent = makeAgentIR({});
    const refs = collectToolReferences(agent);
    expect(refs.size).toBe(0);
  });

  it('should handle flow with empty definitions object', () => {
    const agent = makeAgentIR({ flow: { steps: [], definitions: {} } });
    const refs = collectToolReferences(agent);
    expect(refs.size).toBe(0);
  });

  it('should handle flow step with call_spec but no tool property', () => {
    const malformedStep = {
      name: 's1',
      call_spec: { params: {} },
    } as unknown as NonNullable<AgentIR['flow']>['definitions'][string];

    const agent = makeAgentIR({
      flow: { steps: ['s1'], definitions: { s1: malformedStep } },
    });
    const refs = collectToolReferences(agent);
    expect(refs.size).toBe(0);
  });

  it('should handle staticGraph with empty nodes array', () => {
    const agent = makeAgentIR({
      flow: { steps: [], definitions: {}, staticGraph: { entryPoint: 'n1', nodes: [], edges: [] } },
    });
    const refs = collectToolReferences(agent);
    expect(refs.size).toBe(0);
  });

  it('should handle coordination without escalation', () => {
    const agent = makeAgentIR({
      coordination: { handoffs: [], delegates: [] },
    });
    const refs = collectToolReferences(agent);
    expect(refs.size).toBe(0);
  });

  it('should collect references from on_success and on_failure call blocks', () => {
    const stepWithResultCalls = {
      name: 'step1',
      call: 'primary_tool',
      on_success: { call: 'success_tool' },
      on_failure: { call: 'failure_tool' },
    } as unknown as NonNullable<AgentIR['flow']>['definitions'][string];

    const agent = makeAgentIR({
      flow: {
        steps: ['step1'],
        definitions: {
          step1: stepWithResultCalls,
        },
      },
    });
    const refs = collectToolReferences(agent);
    expect(refs.has('primary_tool')).toBe(true);
    expect(refs.has('success_tool')).toBe(true);
    expect(refs.has('failure_tool')).toBe(true);
    expect(refs.size).toBe(3);
  });

  it('should collect references from both call and call_spec in same step', () => {
    const agent = makeAgentIR({
      flow: {
        steps: ['step1'],
        definitions: {
          step1: {
            name: 'step1',
            call: 'tool_a',
            call_spec: { tool: 'tool_b', with: {} },
          },
        },
      },
    });
    const refs = collectToolReferences(agent);
    expect(refs.has('tool_a')).toBe(true);
    expect(refs.has('tool_b')).toBe(true);
  });

  it('should handle staticGraph node with step but no call', () => {
    const agent = makeAgentIR({
      flow: {
        steps: [],
        definitions: {},
        staticGraph: {
          entryPoint: 'n1',
          nodes: [
            { id: 'n1', type: 'step', label: 'X', deterministic: true, step: { respond: 'hi' } },
          ],
          edges: [],
        },
      },
    });
    const refs = collectToolReferences(agent);
    expect(refs.size).toBe(0);
  });

  it('should collect references from flow definitions and staticGraph without duplicates', () => {
    const agent = makeAgentIR({
      flow: {
        steps: ['step1'],
        definitions: {
          step1: {
            name: 'step1',
            call: 'payments__charge',
            respond: 'done',
          },
        },
        staticGraph: {
          entryPoint: 'node-1',
          nodes: [
            {
              id: 'node-1',
              type: 'step',
              label: 'Charge',
              deterministic: true,
              step: { call: 'payments__charge' },
            },
          ],
          edges: [],
        },
      },
    });

    const refs = collectToolReferences(agent);

    expect(refs.size).toBe(1);
    expect(refs.has('payments__charge')).toBe(true);
  });
});
