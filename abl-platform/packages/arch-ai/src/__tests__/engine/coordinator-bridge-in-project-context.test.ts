import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resolveTurnPlan } from '../../engine/coordinator-bridge.js';
import { ToolRegistry } from '../../tools/v2/registry.js';

describe('resolveTurnPlan — in-project context loading', () => {
  it('prefers loader-backed project context over stale session metadata', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'ask_user',
      kind: 'interactive',
      description: 'Ask the user a question.',
      inputSchema: z.object({ question: z.string() }),
    });
    registry.register({
      name: 'read_agent',
      kind: 'internal',
      readOnly: true,
      description: 'Read an agent definition.',
      inputSchema: z.object({ agentName: z.string() }),
      execute: async () => ({ code: 'AGENT: RouterAgent' }),
    });
    registry.register({
      name: 'compile_abl',
      kind: 'internal',
      description: 'Compile an ABL file.',
      inputSchema: z.object({ code: z.string(), agentName: z.string() }),
      execute: async () => ({ status: 'pass' }),
    });

    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-in-project',
        metadata: {
          phase: 'BUILD',
          mode: 'in-project',
          specification: {
            business: {
              projectName: 'Stale Session Project',
            },
          },
          projectId: 'project-123',
        },
      },
      userInput: 'Review the routing agent and keep the edits deterministic.',
      pageContext: {
        area: 'project',
        page: 'agents',
        tab: 'config',
        subSection: 'guardrails',
        project: {
          id: 'project-123',
          name: 'Fresh Project',
          agentCount: 4,
        },
        entity: {
          type: 'agent',
          id: 'RouterAgent',
          name: 'RouterAgent',
        },
        capabilities: ['agent_authoring', 'agents_tab_config'],
      },
      registry,
      specDocumentLoader: async () => ({
        business: {
          projectName: 'Fresh Project',
          objective: 'Keep routing deterministic',
        },
      }),
      projectMemoryLoader: async () =>
        '## Project Memory (from previous sessions)\n- [decision] Keep handoffs deterministic.',
    });

    expect(plan.systemPrompt).toContain('Fresh Project');
    expect(plan.systemPrompt).not.toContain('Stale Session Project');
    expect(plan.systemPrompt).toContain('Keep handoffs deterministic');
    expect(plan.systemPrompt).toContain('You are on the **agents** page (area: project).');
    expect(plan.systemPrompt).toContain('Focused tab: **config**.');
    expect(plan.systemPrompt).toContain('Focused section: **guardrails**.');
    expect(plan.systemPrompt).toContain(
      'Relevant surface areas: agent_authoring, agents_tab_config.',
    );
    expect(plan.systemPrompt).toContain('RouterAgent');
  });

  it('uses page-context bias for generic tool-page questions', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'ask_user',
      kind: 'interactive',
      description: 'Ask the user a question.',
      inputSchema: z.object({ question: z.string() }),
    });
    registry.register({
      name: 'tools_ops',
      kind: 'internal',
      description: 'Read or update tool configs.',
      inputSchema: z.object({
        action: z.enum(['read', 'list', 'create', 'update', 'test', 'delete']),
        toolId: z.string().optional(),
      }),
      execute: async () => ({ success: true }),
    });

    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-tool-context',
        metadata: {
          phase: 'BUILD',
          mode: 'in-project',
          specification: {},
          projectId: 'project-123',
        },
      },
      userInput: 'help me with this',
      pageContext: {
        area: 'project',
        page: 'tools',
        tab: 'testing',
        entity: {
          type: 'tool',
          id: 'tool-123',
          name: 'CRM Sync',
        },
        capabilities: ['tool_management', 'tool_testing', 'api_integration'],
      },
      registry,
    });

    expect(plan.specialist).toBe('in-project-architect');
    expect(plan.systemPrompt).toContain('CRM Sync');
    expect(plan.systemPrompt).toContain('Focused tab: **testing**.');
  });

  it('frames analytics session context as production containment and quality optimization', async () => {
    const registry = new ToolRegistry();
    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-analytics-context',
        metadata: {
          phase: 'BUILD',
          mode: 'in-project',
          specification: {},
          projectId: 'project-123',
        },
      },
      userInput: 'help me improve this',
      pageContext: {
        area: 'project',
        page: 'analytics',
        tab: 'sessions-explorer',
        project: {
          id: 'project-123',
          name: 'Payments',
          agentCount: 4,
        },
        capabilities: [
          'analytics',
          'production_agent_optimization',
          'containment_optimization',
          'quality_improvement',
          'session_observability',
          'containment_analysis',
        ],
        summary: {
          surfacePurpose: 'production_agent_optimization',
          optimizationFocus: 'containment_or_quality_improvement',
          analyticsTab: 'sessions-explorer',
          sessionStatusFilter: 'escalated',
          sessionEnvironmentFilter: 'production',
        },
      },
      registry,
    });

    expect(plan.specialist).toBe('in-project-architect');
    expect(plan.systemPrompt).toContain('Focused tab: **sessions-explorer**.');
    expect(plan.systemPrompt).toContain('production_agent_optimization');
    expect(plan.systemPrompt).toContain(
      'Production session focus: use conversation outcomes, traces, and failure evidence',
    );
    expect(plan.systemPrompt).toContain('improve containment, escalation handling, quality');
    expect(plan.systemPrompt).toContain('inspect the trace step-by-step');
    expect(plan.systemPrompt).toContain('read the relevant agent goal and flow steps');
    expect(plan.systemPrompt).toContain('propose targeted modifications without applying changes');
  });

  it('keeps integration_draft entity context on the unified architect', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'ask_user',
      kind: 'interactive',
      description: 'Ask the user a question.',
      inputSchema: z.object({ question: z.string() }),
    });

    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-integration-draft-context',
        metadata: {
          phase: 'BUILD',
          mode: 'in-project',
          specification: {},
          projectId: 'project-123',
        },
      },
      userInput: 'help me with this',
      pageContext: {
        area: 'project',
        page: 'integrations',
        entity: {
          type: 'integration_draft',
          id: 'draft_1',
          name: 'Stripe Draft',
          metadata: {
            providerKey: 'stripe',
            connection_id: 'conn_42',
          },
        },
        capabilities: ['integration_authoring', 'integration_drafting'],
      },
      registry,
    });

    expect(plan.specialist).toBe('in-project-architect');
  });

  it('keeps integrations page context on the unified architect', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'ask_user',
      kind: 'interactive',
      description: 'Ask the user a question.',
      inputSchema: z.object({ question: z.string() }),
    });

    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-integrations-page',
        metadata: {
          phase: 'BUILD',
          mode: 'in-project',
          specification: {},
          projectId: 'project-123',
        },
      },
      userInput: 'help me with this',
      pageContext: {
        area: 'project',
        page: 'integrations',
        capabilities: ['integration_authoring'],
      },
      registry,
    });

    expect(plan.specialist).toBe('in-project-architect');
  });
});
