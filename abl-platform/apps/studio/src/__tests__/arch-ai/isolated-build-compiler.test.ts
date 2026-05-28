import { describe, expect, it } from 'vitest';
import {
  CompileWorkerTimeoutError,
  runIsolatedBuildSessionValidation,
  runIsolatedSingleAgentCompile,
} from '@/lib/arch-ai/helpers/isolated-build-compiler';

const VALID_AGENT_ABL = `AGENT: TestAgent
GOAL: "Test agent"

ENTITIES:
  cabin_class:
    TYPE: enum
    VALUES: [economy, business, first]
`;

describe('isolated-build-compiler', () => {
  it('compiles a simple agent in-process', async () => {
    const result = await runIsolatedSingleAgentCompile(
      {
        code: VALID_AGENT_ABL,
        compileOptions: {
          mode: 'preview',
          skipCrossAgentValidation: true,
        },
      },
      { timeoutMs: 5_000 },
    );

    expect(result.documentFound).toBe(true);
    expect(result.parseErrors).toEqual([]);
    expect(
      result.compileErrors.filter(
        (entry) => entry.severity === undefined || entry.severity === 'error',
      ),
    ).toEqual([]);
    expect(result.phaseDurationsMs.total).toBeGreaterThan(0);
    expect(result.phaseDurationsMs.parse).toBeGreaterThanOrEqual(0);
    expect(result.phaseDurationsMs.compile).toBeGreaterThanOrEqual(0);
  });

  it('compiles managed behavior profile references with companion profile documents', async () => {
    const profile = `BEHAVIOR_PROFILE: shared_voice_handoff
PRIORITY: 20
WHEN: true

INSTRUCTIONS: |
  Continue the same conversation.
`;
    const agent = `AGENT: OrdersAgent
GOAL: "Resolve order issues"
PERSONA: |
  Help with orders.

USE BEHAVIOR_PROFILE: shared_voice_handoff
`;

    const single = await runIsolatedSingleAgentCompile(
      {
        code: agent,
        additionalDocuments: [profile],
        compileOptions: {
          mode: 'preview',
          skipCrossAgentValidation: true,
        },
      },
      { timeoutMs: 5_000 },
    );

    expect(single.parseErrors).toEqual([]);
    expect(
      single.compileErrors.filter(
        (entry) => entry.severity === undefined || entry.severity === 'error',
      ),
    ).toEqual([]);

    const session = await runIsolatedBuildSessionValidation(
      {
        topologyAgents: [{ name: 'OrdersAgent', role: 'Orders specialist' }],
        agentFiles: { OrdersAgent: { content: agent } },
        behaviorProfileFiles: { shared_voice_handoff: { content: profile } },
      },
      { timeoutMs: 5_000 },
    );

    expect(session.parseErrorsByAgent).toEqual({});
    expect(session.errorsByAgent.OrdersAgent ?? []).toEqual([]);
  });

  it('throws CompileWorkerTimeoutError when the timeout budget is exceeded', async () => {
    let captured: unknown;
    try {
      await runIsolatedSingleAgentCompile(
        {
          code: VALID_AGENT_ABL,
          compileOptions: {
            mode: 'preview',
            skipCrossAgentValidation: true,
          },
        },
        {
          timeoutMs: 25,
          __phaseHook: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
          },
        },
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(CompileWorkerTimeoutError);
    const timeoutError = captured as CompileWorkerTimeoutError;
    expect(timeoutError.name).toBe('CompileWorkerTimeoutError');
    expect(timeoutError.timeoutMs).toBe(25);
    expect(['boot', 'parse', 'compile', 'diagnostics']).toContain(timeoutError.phase);
  });
});
