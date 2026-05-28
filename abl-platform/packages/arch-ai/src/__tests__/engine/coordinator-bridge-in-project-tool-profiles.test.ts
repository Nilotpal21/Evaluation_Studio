import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resolveTurnPlan } from '../../engine/coordinator-bridge.js';
import { toolKind } from '../../tools/adapters/classification.js';
import { ToolRegistry } from '../../tools/v2/registry.js';
import { IN_PROJECT_TOOLS, getInProjectToolNamesForSpecialist } from '../../types/tools.js';

function makeInProjectRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  for (const toolName of IN_PROJECT_TOOLS) {
    if (toolName === 'ask_user' || toolName === 'collect_secret') {
      registry.register({
        name: toolName,
        kind: 'interactive',
        description: `${toolName} test stub`,
        inputSchema: z.object({}),
      });
      continue;
    }

    registry.register({
      name: toolName,
      kind: 'internal',
      description: `${toolName} test stub`,
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });
  }

  return registry;
}

describe('resolveTurnPlan — in-project tool profiles', () => {
  it('uses the unified architect profile for agent edits and config work', async () => {
    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-construct-tools',
        metadata: {
          phase: 'BUILD',
          mode: 'in-project',
          specification: {},
          projectId: 'project-123',
        },
      },
      userInput: 'change the persona of the triage agent',
      registry: makeInProjectRegistry(),
    });

    expect(plan.specialist).toBe('in-project-architect');

    const toolNames = plan.allowedTools.map((tool) => tool.name).sort();
    const expected = [...getInProjectToolNamesForSpecialist('in-project-architect')].sort();
    expect(toolNames).toEqual(expected);
    expect(toolNames).toContain('compile_abl');
    expect(toolNames).toContain('dry_run_compile');
    expect(toolNames).toContain('run_feasibility_check');
    expect(toolNames).toContain('get_construct_spec');
    expect(toolNames).toContain('list_valid_combinations');
    expect(toolNames).toContain('get_cel_grammar');
    expect(toolNames).toContain('lookup_validation_code');
    expect(toolNames).toContain('run_simulation');
    expect(toolNames).toContain('project_config');
    expect(toolNames).toContain('kb_manage');
    expect(toolNames).toContain('query_traces');
    expect(toolNames).toContain('trace_diagnosis');
  });

  it('uses the unified architect profile for broken-flow triage', async () => {
    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-diagnostic-tools',
        metadata: {
          phase: 'BUILD',
          mode: 'in-project',
          specification: {},
          projectId: 'project-123',
        },
      },
      userInput: 'the project is broken and not working correctly',
      registry: makeInProjectRegistry(),
    });

    expect(plan.specialist).toBe('in-project-architect');

    const toolNames = plan.allowedTools.map((tool) => tool.name).sort();
    const expected = [...getInProjectToolNamesForSpecialist('in-project-architect')].sort();
    expect(toolNames).toEqual(expected);
    expect(toolNames).toContain('diagnose_project');
    expect(toolNames).toContain('session_ops');
    expect(toolNames).toContain('query_traces');
    expect(toolNames).toContain('trace_diagnosis');
    expect(toolNames).toContain('run_simulation');
    expect(toolNames).toContain('kb_health');
    expect(toolNames).toContain('compile_abl');
    expect(toolNames).toContain('tools_ops');
  });

  it('keeps natural session lookups on the unified architect with trace tools', async () => {
    for (const userInput of [
      'check my last session',
      'show sessions from 3 days',
      'compare today vs yesterday sessions for Billing_Agent',
    ]) {
      const plan = await resolveTurnPlan({
        session: {
          _id: `sess-${userInput.replace(/\W+/g, '-').toLowerCase()}`,
          metadata: {
            phase: 'BUILD',
            mode: 'in-project',
            specification: {},
            projectId: 'project-123',
          },
        },
        userInput,
        registry: makeInProjectRegistry(),
      });

      expect(plan.specialist).toBe('in-project-architect');
      const toolNames = plan.allowedTools.map((tool) => tool.name);
      expect(toolNames).toContain('session_ops');
      expect(toolNames).toContain('trace_diagnosis');
      expect(toolNames).toContain('query_traces');
    }
  });

  it('keeps performance comparisons on the unified architect with trace tools available', async () => {
    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-performance-compare',
        metadata: {
          phase: 'BUILD',
          mode: 'in-project',
          specification: {},
          projectId: 'project-123',
        },
      },
      userInput: 'compare Billing_Agent performance in prod vs staging',
      registry: makeInProjectRegistry(),
    });

    expect(plan.specialist).toBe('in-project-architect');
    const toolNames = plan.allowedTools.map((tool) => tool.name);
    expect(toolNames).toContain('read_insights');
    expect(toolNames).toContain('session_ops');
    expect(toolNames).toContain('trace_diagnosis');
    expect(toolNames).toContain('query_traces');
  });

  it('ignores legacy specialist pins on follow-up interactive turns', async () => {
    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-pinned-specialist',
        metadata: {
          phase: 'BUILD',
          mode: 'in-project',
          specification: {},
          projectId: 'project-123',
        },
      },
      userInput: 'yes, apply it',
      specialistOverride: 'diagnostician',
      registry: makeInProjectRegistry(),
    });

    expect(plan.specialist).toBe('in-project-architect');

    const toolNames = plan.allowedTools.map((tool) => tool.name).sort();
    const expected = [...getInProjectToolNamesForSpecialist('in-project-architect')].sort();
    expect(toolNames).toEqual(expected);
    expect(toolNames).toContain('diagnose_project');
    expect(toolNames).toContain('compile_abl');
  });

  it('tracks the full in-project superset from the specialist profiles', () => {
    expect(IN_PROJECT_TOOLS).toContain('project_config');
    expect(IN_PROJECT_TOOLS).toContain('kb_manage');
    expect(IN_PROJECT_TOOLS).toContain('kb_ingest');
    expect(IN_PROJECT_TOOLS).toContain('kb_search');
    expect(IN_PROJECT_TOOLS).toContain('kb_health');
    expect(IN_PROJECT_TOOLS).toContain('kb_connector');
    expect(IN_PROJECT_TOOLS).toContain('kb_documents');
    expect(IN_PROJECT_TOOLS).toContain('session_ops');
    expect(IN_PROJECT_TOOLS).toContain('trace_diagnosis');
    expect(IN_PROJECT_TOOLS).toContain('run_simulation');
    expect(toolKind('run_simulation')).toBe('internal');
    expect(IN_PROJECT_TOOLS).toContain('variable_ops');
    expect(IN_PROJECT_TOOLS).toContain('integration_ops');
    expect(IN_PROJECT_TOOLS).toContain('mcp_server_ops');
  });

  it('gives the unified architect the tool + auth + variable orchestration surface', async () => {
    const plan = await resolveTurnPlan({
      session: {
        _id: 'sess-integration-tools',
        metadata: {
          phase: 'BUILD',
          mode: 'in-project',
          specification: {},
          projectId: 'project-123',
        },
      },
      userInput: 'help me finish wiring this tool',
      pageContext: {
        area: 'project',
        page: 'tools',
        tab: 'testing',
        entity: {
          type: 'tool',
          id: 'crm-sync',
          name: 'CRM Sync',
        },
        capabilities: ['tool_management', 'tool_testing', 'api_integration'],
      },
      registry: makeInProjectRegistry(),
    });

    expect(plan.specialist).toBe('in-project-architect');
    const toolNames = plan.allowedTools.map((tool) => tool.name).sort();
    expect(toolNames).toContain('tools_ops');
    expect(toolNames).toContain('mcp_server_ops');
    expect(toolNames).toContain('auth_ops');
    expect(toolNames).toContain('variable_ops');
    expect(toolNames).toContain('integration_ops');
    expect(toolNames).toContain('collect_secret');
  });
});
