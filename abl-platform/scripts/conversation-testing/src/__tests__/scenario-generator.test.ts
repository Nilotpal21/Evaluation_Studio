import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateScenarios } from '../scenario-generator.js';
import type { AgentSummary, LLMClient, RunConfig } from '../types.js';

const agents: AgentSummary[] = [
  { name: 'sales', goal: 'Close deals', description: 'Handles presales questions' },
  { name: 'support', goal: 'Resolve issues', description: 'Handles troubleshooting' },
  { name: 'billing', goal: 'Fix billing', description: 'Handles invoices and refunds' },
];

function createScenario(index: number, targetAgent?: string) {
  return {
    intent: `intent-${index}`,
    persona: `persona-${index}`,
    goal: `goal-${index}`,
    behavior: `behavior-${index}`,
    endCondition: `end-${index}`,
    ...(targetAgent ? { targetAgent } : {}),
  };
}

describe('generateScenarios', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the exact all-agents run count and authoritative round-robin targeting', async () => {
    let capturedSystemPrompt = '';
    const llm: LLMClient = {
      async chat(_messages, system) {
        capturedSystemPrompt = system ?? '';
        return JSON.stringify(Array.from({ length: 5 }, (_, i) => createScenario(i + 1)));
      },
    };

    const config: RunConfig = {
      runs: 5,
      preset: 'balanced',
      domain: {
        projectName: 'TestBot',
        welcomeMessage: 'Welcome to TestBot',
      },
      agents,
      runsPerAgent: 3,
    };

    const scenarios = await generateScenarios(llm, config);

    expect(capturedSystemPrompt).toContain('Generate EXACTLY 5 scenarios');
    expect(capturedSystemPrompt).not.toContain('**Total scenarios:** 9');
    expect(scenarios).toHaveLength(5);
    expect(scenarios.map((scenario) => scenario.targetAgent)).toEqual([
      'sales',
      'support',
      'billing',
      'sales',
      'support',
    ]);
    expect(new Set(scenarios.map((scenario) => scenario.assignedPreset))).toEqual(
      new Set(['balanced']),
    );
  });

  it('fails when slot-driven generation returns fewer scenarios than requested', async () => {
    const llm: LLMClient = {
      async chat() {
        return JSON.stringify([createScenario(1)]);
      },
    };

    await expect(
      generateScenarios(llm, {
        runs: 2,
        preset: 'auto',
        domain: {
          projectName: 'TestBot',
          welcomeMessage: 'Welcome to TestBot',
        },
      }),
    ).rejects.toThrow('Expected exactly 2 scenarios');
  });

  it('rejects a model-supplied target agent that conflicts with the slot assignment', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const llm: LLMClient = {
      async chat() {
        return JSON.stringify([createScenario(1, 'wrong-agent')]);
      },
    };

    await expect(
      generateScenarios(llm, {
        runs: 1,
        preset: 'auto',
        domain: {
          projectName: 'TestBot',
          welcomeMessage: 'Welcome to TestBot',
        },
        agents: [{ name: 'sales', goal: 'Close deals', description: 'Handles presales questions' }],
      }),
    ).rejects.toThrow('slot assignment requires "sales"');
  });

  it('auto mode assigns each scenario the preset from its slot position', async () => {
    // Deterministic Math.random so buildScenarioSlots picks one of each preset
    // across the AUTO_PRESET_POOL (size 5) for 5 slots.
    const randomValues = [0.0, 0.2, 0.4, 0.6, 0.8];
    let rIdx = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => randomValues[rIdx++] ?? 0);

    const llm: LLMClient = {
      async chat() {
        return JSON.stringify(Array.from({ length: 5 }, (_, i) => createScenario(i + 1)));
      },
    };

    const scenarios = await generateScenarios(llm, {
      runs: 5,
      preset: 'auto',
      domain: {
        projectName: 'TestBot',
        welcomeMessage: 'Welcome to TestBot',
      },
    });

    expect(scenarios).toHaveLength(5);
    // AUTO_PRESET_POOL is PRESET_NAMES with 'auto' filtered out, in source order.
    expect(scenarios.map((s) => s.assignedPreset)).toEqual([
      'balanced',
      'stress-negative',
      'short-simple',
      'long-complex',
      'abandonment',
    ]);
  });

  it('retries once on malformed JSON and resolves with the retry response', async () => {
    const chat = vi
      .fn<(messages: unknown, system?: string) => Promise<string>>()
      .mockResolvedValueOnce('not valid json at all')
      .mockResolvedValueOnce(JSON.stringify([createScenario(1), createScenario(2)]));

    const llm: LLMClient = { chat };

    const scenarios = await generateScenarios(llm, {
      runs: 2,
      preset: 'balanced',
      domain: {
        projectName: 'TestBot',
        welcomeMessage: 'Welcome to TestBot',
      },
    });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(scenarios).toHaveLength(2);
    // Retry uses a stricter system prompt appended with the JSON-only instruction.
    const retryCall = chat.mock.calls[1];
    expect(retryCall[1]).toContain('Reply with JSON only, no markdown fences, no prose.');
  });
});
