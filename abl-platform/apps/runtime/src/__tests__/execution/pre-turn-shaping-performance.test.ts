import { performance } from 'node:perf_hooks';

import type { PipelinePolicy } from '@abl/compiler';
import { describe, expect, it } from 'vitest';

import { buildSystemPrompt, buildTools } from '../../services/execution/prompt-builder.js';
import { preparePreTurnExecutionView } from '../../services/execution/pre-turn-execution-view.js';
import { getSessionGuardrailCacheScopeKey } from '../../services/execution/session-policy.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';

const HOT_PATH_WARMUP_ITERATIONS = 25;
const HOT_PATH_MEASURED_ITERATIONS = 150;
const HOT_PATH_AVG_BUDGET_MS = 6;
const HOT_PATH_P95_BUDGET_MS = 12;
const TOOL_COUNT = 40;
const BLOCKED_TOOL_COUNT = 10;
const JIT_ALLOWED_TOOL_COUNT = 10;

const SESSION_MEMORY_NAMES = Array.from({ length: 12 }, (_, index) => `session_var_${index + 1}`);
const EXECUTION_TREE_PATHS = [
  'workflow.auth_token',
  'workflow.case_id',
  'workflow.route',
  'workflow.entitlement',
  'workflow.region',
  'workflow.queue',
];

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function buildRepresentativeDsl(): string {
  const sessionMemoryBlock = SESSION_MEMORY_NAMES.map((name) => `    - ${name}`).join('\n');
  const persistentMemoryBlock = EXECUTION_TREE_PATHS.map(
    (path) => `    - PATH: ${path}
      SCOPE: execution_tree
      ACCESS: readwrite
      TYPE: string`,
  ).join('\n');
  const toolsBlock = Array.from({ length: TOOL_COUNT }, (_, index) => {
    const toolName = `tool_${index + 1}`;
    return `  ${toolName}(input: string) -> { status: string }
    DESCRIPTION: "${toolName} performance tool"`;
  }).join('\n');

  return `
AGENT: PreTurn_Perf_Agent

GOAL: "Measure steady-state pre-turn prompt and tool shaping"

MEMORY:
  session:
${sessionMemoryBlock}
  persistent:
${persistentMemoryBlock}

TOOLS:
${toolsBlock}
`;
}

function createRepresentativeSession(): RuntimeSession {
  const executor = new RuntimeExecutor();
  const session = executor.createSessionFromResolved(
    compileToResolvedAgent([buildRepresentativeDsl()], 'PreTurn_Perf_Agent'),
    {
      tenantId: 'tenant-perf',
      projectId: 'project-perf',
      authToken: 'session-auth-token',
    },
  );

  session.userId = undefined;
  session._activationAuthContext = {
    tenantId: 'tenant-perf',
    projectId: 'project-perf',
    authScope: 'session',
  };

  session.agentIR?.tools?.forEach((tool, index) => {
    if (index < BLOCKED_TOOL_COUNT) {
      tool.auth_profile_ref = 'crm-user-profile';
      tool.connection_mode = 'per_user';
      return;
    }

    if (index < BLOCKED_TOOL_COUNT + JIT_ALLOWED_TOOL_COUNT) {
      tool.auth_profile_ref = 'crm-jit-profile';
      tool.jit_auth = true;
      tool.connection_mode = 'per_user';
    }
  });

  SESSION_MEMORY_NAMES.forEach((name, index) => {
    session.data.values[name] = `value-${index + 1}`;
  });

  Object.assign(session.data.values, {
    'workflow.auth_token': 'verified-token',
    'workflow.case_id': 'case-123',
    'workflow.route': 'billing',
    'workflow.entitlement': 'gold',
    'workflow.region': 'us',
    'workflow.queue': 'priority',
    execution_tree: {
      workflow: {
        auth_token: 'verified-token',
        case_id: 'case-123',
        route: 'billing',
        entitlement: 'gold',
        region: 'us',
        queue: 'priority',
      },
    },
    _granted_memory: {
      'workflow.auth_token': 'verified-token',
      'workflow.case_id': 'case-123',
      'workflow.entitlement': 'gold',
    },
  });

  session.state.gatherProgress = {
    requested_action: 'billing_lookup',
    pii_confirmed: true,
    account_tail: '6789',
  };
  session.conversationHistory = [
    { role: 'user', content: 'I need help with billing.' },
    { role: 'assistant', content: 'I can help with that.' },
    { role: 'user', content: 'Please use the authenticated billing workflow.' },
  ];

  session._guardrailPolicy = {
    settings: { failMode: 'closed' },
    disabledGuardrails: ['policy-disabled'],
    additionalGuardrails: [
      { name: 'billing_tool_input_pii' },
      { name: 'policy-safe' },
      { name: 'policy-output' },
    ],
  } as PipelinePolicy;
  session._guardrailPolicyEpoch = 0;
  session._guardrailPolicyScopeKey = getSessionGuardrailCacheScopeKey(session);

  return session;
}

async function runShapingPass(session: RuntimeSession): Promise<{
  latencyMs: number;
  prompt: string;
  tools: ReturnType<typeof buildTools>;
  traces: Array<{ type: string; data: Record<string, unknown> }>;
}> {
  const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
  const startedAt = performance.now();

  await preparePreTurnExecutionView(session, (event) => traces.push(event));
  const prompt = buildSystemPrompt(session);
  const tools = buildTools(session);

  return {
    latencyMs: performance.now() - startedAt,
    prompt,
    tools,
    traces,
  };
}

describe('Pre-turn shaping performance guard', () => {
  it('keeps hot-path prompt and tool reshaping within the bounded budget', async () => {
    const session = createRepresentativeSession();

    for (let index = 0; index < HOT_PATH_WARMUP_ITERATIONS; index += 1) {
      await runShapingPass(session);
    }

    const latencies: number[] = [];
    let sample:
      | {
          latencyMs: number;
          prompt: string;
          tools: ReturnType<typeof buildTools>;
          traces: Array<{ type: string; data: Record<string, unknown> }>;
        }
      | undefined;

    for (let index = 0; index < HOT_PATH_MEASURED_ITERATIONS; index += 1) {
      const result = await runShapingPass(session);
      latencies.push(result.latencyMs);
      sample ??= result;
    }

    const avgMs = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
    const p95Ms = percentile(latencies, 0.95);

    expect(sample).toBeDefined();
    expect(sample!.prompt).toContain('## Granted Memory');
    expect(sample!.prompt).toContain('## Current Policy');
    expect(sample!.prompt).toContain('"additionalGuardrailCount": 3');
    expect(sample!.tools.some((tool) => tool.name === 'tool_1')).toBe(false);
    expect(sample!.tools.some((tool) => tool.name === 'tool_11')).toBe(true);
    expect(sample!.tools.some((tool) => tool.name === 'tool_21')).toBe(true);
    expect(
      sample!.traces.some(
        (trace) =>
          trace.type === 'decision' &&
          trace.data.type === 'pre_turn_surface' &&
          typeof trace.data.latencyMs === 'number',
      ),
    ).toBe(true);

    expect(avgMs).toBeLessThanOrEqual(HOT_PATH_AVG_BUDGET_MS);
    expect(p95Ms).toBeLessThanOrEqual(HOT_PATH_P95_BUDGET_MS);
  });
});
