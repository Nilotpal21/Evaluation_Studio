import { describe, expect, it } from 'vitest';

import {
  buildModelResolutionCacheKey,
  buildModelResolutionSnapshotFingerprint,
  buildReasoningSettingsCacheKey,
  buildThinkingResolutionCacheKey,
  MODEL_RESOLUTION_EXECUTION_FIELD_PATHS,
} from '../services/llm/model-resolution-versioning.js';

function makeAgentIR(overrides: Record<string, unknown> = {}): any {
  return {
    metadata: { name: 'agent-1', description: '' },
    execution: {
      mode: 'reasoning',
      model: 'anthropic/claude-sonnet-4',
      operation_models: {
        reasoning: 'anthropic/claude-opus-4',
      },
      temperature: 0.2,
      max_tokens: 2048,
      reasoning_effort: 'high',
      enable_thinking: true,
      thinking_budget: 4096,
      thought_description: 'think carefully',
      compaction_threshold: 0.8,
    },
    tools: [{ name: 'tool-a' }],
    identity: { goal: 'help users' },
    ...overrides,
  };
}

describe('model-resolution-versioning', () => {
  it('documents the execution fields that participate in model-resolution invalidation', () => {
    expect(MODEL_RESOLUTION_EXECUTION_FIELD_PATHS).toEqual([
      'execution.model',
      'execution.operation_models',
      'execution.temperature',
      'execution.max_tokens',
      'execution.reasoning_effort',
      'execution.enable_thinking',
      'execution.thinking_budget',
      'execution.thought_description',
      'execution.compaction_threshold',
    ]);
  });

  it('keeps the snapshot fingerprint stable when unrelated AgentIR fields change', () => {
    const base = buildModelResolutionSnapshotFingerprint({
      agentIR: makeAgentIR(),
      settingsVersionId: 'sv-1',
    });

    const unrelatedChange = buildModelResolutionSnapshotFingerprint({
      agentIR: makeAgentIR({
        tools: [{ name: 'tool-b' }],
        identity: { goal: 'answer concisely' },
        gather: { fields: ['email'] },
      }),
      settingsVersionId: 'sv-1',
    });

    expect(unrelatedChange).toBe(base);
  });

  it('changes the snapshot fingerprint when resolution-relevant execution inputs change', () => {
    const base = buildModelResolutionSnapshotFingerprint({
      agentIR: makeAgentIR(),
      settingsVersionId: 'sv-1',
    });

    const modelChange = buildModelResolutionSnapshotFingerprint({
      agentIR: makeAgentIR({
        execution: {
          ...makeAgentIR().execution,
          model: 'openai/gpt-4.1',
        },
      }),
      settingsVersionId: 'sv-1',
    });

    const settingsVersionChange = buildModelResolutionSnapshotFingerprint({
      agentIR: makeAgentIR(),
      settingsVersionId: 'sv-2',
    });

    expect(modelChange).not.toBe(base);
    expect(settingsVersionChange).not.toBe(base);
  });

  it('treats userId as cache scope, not as a versioned snapshot input', () => {
    const agentIR = makeAgentIR();
    const snapshot = buildModelResolutionSnapshotFingerprint({
      agentIR,
      settingsVersionId: 'sv-1',
    });

    const userOneKey = buildModelResolutionCacheKey({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      operationType: 'response_gen',
      userId: 'user-1',
      agentIR,
      settingsVersionId: 'sv-1',
    });

    const userTwoKey = buildModelResolutionCacheKey({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      operationType: 'response_gen',
      userId: 'user-2',
      agentIR,
      settingsVersionId: 'sv-1',
    });

    expect(snapshot).toBe(
      buildModelResolutionSnapshotFingerprint({
        agentIR,
        settingsVersionId: 'sv-1',
      }),
    );
    expect(userTwoKey).not.toBe(userOneKey);
  });

  it('keeps userId out of the settings-only reasoning cache contract', () => {
    const input = {
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      agentIR: makeAgentIR(),
      settingsVersionId: 'sv-1',
    };

    const snapshot = buildModelResolutionSnapshotFingerprint(input);

    expect(buildReasoningSettingsCacheKey(input)).toBe(
      `tenant-1::proj-1::agent-1::reasoning::${snapshot}`,
    );
  });

  it('ignores accidental userId on the reasoning-settings input while full resolution keeps it scoped', () => {
    const input = {
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      operationType: 'response_gen',
      agentIR: makeAgentIR(),
      settingsVersionId: 'sv-1',
    };

    const userOneReasoningKey = buildReasoningSettingsCacheKey({
      ...input,
      userId: 'user-1',
    } as any);
    const userTwoReasoningKey = buildReasoningSettingsCacheKey({
      ...input,
      userId: 'user-2',
    } as any);

    const userOneFullKey = buildModelResolutionCacheKey({ ...input, userId: 'user-1' });
    const userTwoFullKey = buildModelResolutionCacheKey({ ...input, userId: 'user-2' });

    expect(userTwoReasoningKey).toBe(userOneReasoningKey);
    expect(userOneReasoningKey).not.toContain('user-1');
    expect(userOneReasoningKey).not.toContain('user-2');
    expect(userTwoFullKey).not.toBe(userOneFullKey);
  });

  it('keeps the legacy thinking-cache helper as an alias of the explicit reasoning-settings key', () => {
    const input = {
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'agent-1',
      agentIR: makeAgentIR(),
      settingsVersionId: 'sv-1',
    };

    expect(buildThinkingResolutionCacheKey(input)).toBe(buildReasoningSettingsCacheKey(input));
  });
});
