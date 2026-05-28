import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resolveTurnPlan } from '../../engine/coordinator-bridge.js';
import { composeInProjectPrompt } from '../../prompts/index.js';
import { ToolRegistry } from '../../tools/v2/registry.js';
import { IN_PROJECT_TOOLS } from '../../types/tools.js';
import {
  findAgentRefs,
  findMemoryRefs,
  type ProjectAgentReferenceSource,
} from '../../references/index.js';

const REQUIRED_VALIDATION_TOOLS = [
  'read_agent',
  'read_topology',
  'find_agent_refs',
  'find_memory_refs',
  'find_gather_field_refs',
  'find_tool_consumers',
  'find_cel_var_refs',
  'get_construct_spec',
  'list_valid_combinations',
  'get_cel_grammar',
  'lookup_validation_code',
  'propose_plan',
  'dry_run_compile',
  'run_feasibility_check',
  'propose_modification',
] as const;

const REPRESENTATIVE_IN_PROJECT_REQUESTS = [
  'fix the flow step to handle delegate better',
  'rename customer_id to user_id everywhere it is used',
  'remove the unused gather field from Triage without breaking returns',
  'add a billing lookup tool to BillingAgent and wire auth correctly',
  'change the supervisor routing so refunds go to RefundAgent',
  'make LeadIntake delegate enrichment to EnrichmentAgent and return',
  'fix COMPLETE so the return target does not go silent',
  'update memory so AccountAgent recalls customer preferences',
  'diagnose why the handoff to SupportAgent fails',
  'compare tool readiness before adding the new MCP search tool',
] as const;

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  for (const toolName of IN_PROJECT_TOOLS) {
    if (toolName === 'ask_user' || toolName === 'collect_file' || toolName === 'collect_secret') {
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
      execute: async () => ({ success: true }),
    });
  }

  return registry;
}

function buildLargeProject(agentCount: number): ProjectAgentReferenceSource[] {
  return Array.from({ length: agentCount }, (_, index) => {
    const current = `Agent_${index}`;
    const next = `Agent_${(index + 1) % agentCount}`;
    const previous = `Agent_${(index + agentCount - 1) % agentCount}`;
    const field = `customer_${index}_id`;

    return {
      name: current,
      dslContent: `AGENT: ${current}
GOAL: "Handle project slice ${index}"
PERSONA: "Helpful specialist"
MEMORY:
  session:
    ${field}:
      type: string
GATHER:
  ${field}:
    type: string
    required: true
TOOLS:
  - lookup_${index}(${field})
HANDOFF:
  - TO: ${next}
    WHEN: ${field} != null
    CONTEXT:
      pass: [${field}]
    RETURN: true
  - TO: ${previous}
    WHEN: ${field} == null
    RETURN: false
COMPLETE:
  - WHEN: ${field} != null
    RESPOND: "Done"
`,
    };
  });
}

describe('in-project accuracy golden corpus gates', () => {
  it('routes representative proposal requests to the unified architect with validation tools available', async () => {
    const registry = makeRegistry();
    let validationToolReadyTurns = 0;

    for (const [index, userInput] of REPRESENTATIVE_IN_PROJECT_REQUESTS.entries()) {
      const plan = await resolveTurnPlan({
        session: {
          _id: `golden-${index}`,
          metadata: {
            phase: 'BUILD',
            mode: 'in-project',
            specification: {},
            projectId: 'project-123',
          },
        },
        userInput,
        registry,
      });

      const toolNames = new Set(plan.allowedTools.map((tool) => tool.name));
      const hasRequiredTools = REQUIRED_VALIDATION_TOOLS.every((toolName) =>
        toolNames.has(toolName),
      );

      expect(plan.specialist).toBe('in-project-architect');
      expect(hasRequiredTools).toBe(true);
      if (hasRequiredTools) {
        validationToolReadyTurns += 1;
      }
    }

    const readinessRate = validationToolReadyTurns / REPRESENTATIVE_IN_PROJECT_REQUESTS.length;
    expect(readinessRate).toBeGreaterThanOrEqual(0.3);
  });

  it('keeps the in-project prompt explicit about read, reference, spine, plan, and dry-run order', () => {
    const prompt = composeInProjectPrompt(
      'in-project-architect',
      undefined,
      'fix the flow step to handle delegate better',
    );

    expect(prompt).toContain('Read the current project shape');
    expect(prompt).toContain('Run targeted dependency analysis');
    expect(prompt).toContain('Check compiler-backed knowledge');
    expect(prompt).toContain('call get_construct_spec');
    expect(prompt).toContain('call propose_plan before any mutation-capable tool');
    expect(prompt).toContain('Wait for plan approval');
    expect(prompt).toContain('call dry_run_compile');
  });

  it('keeps reference analysis within a loose regression budget for 50-agent projects', () => {
    const projectAgents = buildLargeProject(50);
    const durations: number[] = [];

    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      const agentRefs = findAgentRefs(projectAgents, `Agent_${(index * 7) % 50}`);
      const memoryRefs = findMemoryRefs(projectAgents, `customer_${(index * 11) % 50}_id`);
      durations.push(performance.now() - startedAt);

      expect(agentRefs.references.length).toBeGreaterThan(0);
      expect(memoryRefs.references.length).toBeGreaterThan(0);
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;

    expect(p95).toBeLessThan(1_000);
  });
});
