import { describe, expect, it } from 'vitest';
import { getModelCapabilities } from '@abl/compiler/platform/llm/model-capabilities.js';
import { MODEL_REGISTRY } from '@abl/compiler/platform/llm/model-registry.js';
import type { ArchModelPolicyCandidate } from '@agent-platform/arch-ai/model-policy';

import { selectArchModelPolicyDefaults } from '@/lib/arch-ai/model-policy-defaults';

function findRegistryModel(predicate: (modelId: string) => boolean): string {
  const modelId = Object.keys(MODEL_REGISTRY).find(predicate);
  expect(modelId).toBeDefined();
  return modelId!;
}

function registryCandidate(
  modelId: string,
  overrides: Omit<ArchModelPolicyCandidate, 'modelId'> = {},
): ArchModelPolicyCandidate {
  const capabilities = getModelCapabilities(modelId);
  return {
    modelId,
    supportsTools: capabilities.supportsTools,
    isReasoningModel: capabilities.isReasoningModel,
    supportsReasoningEffort: capabilities.supportsReasoningEffort,
    supportsThinking: capabilities.supportsThinking,
    supportsThinkingBudget: capabilities.supportsThinkingBudget,
    ...overrides,
  };
}

describe('Arch model policy defaults', () => {
  it('prefers project fast tool-capable defaults for ordinary generated agents', () => {
    const defaults = selectArchModelPolicyDefaults([
      {
        modelId: 'slow-default-model',
        tier: 'powerful',
        isDefault: true,
        supportsTools: true,
      },
      {
        modelId: 'fast-default-model',
        tier: 'fast',
        isDefault: true,
        supportsTools: true,
      },
    ]);

    expect(defaults.fastToolCapable).toBe('fast-default-model');
  });

  it('uses powerful defaults for reasoning and research opt-in classes', () => {
    const defaults = selectArchModelPolicyDefaults([
      {
        modelId: 'fast-support-model',
        tier: 'fast',
        isDefault: true,
        supportsTools: true,
      },
      {
        modelId: 'powerful-reasoning-model',
        tier: 'powerful',
        isDefault: true,
        supportsTools: true,
        capabilities: ['reasoning'],
      },
    ]);

    expect(defaults.reasoning).toBe('powerful-reasoning-model');
    expect(defaults.research).toBe('powerful-reasoning-model');
  });

  it('does not select models that cannot call tools', () => {
    const defaults = selectArchModelPolicyDefaults([
      {
        modelId: 'vision-only-model',
        tier: 'fast',
        isDefault: true,
        supportsTools: false,
      },
      {
        modelId: 'tool-model',
        tier: 'balanced',
        isDefault: false,
        supportsTools: true,
      },
    ]);

    expect(defaults.fastToolCapable).toBe('tool-model');
  });

  it('does not select reasoning models for fast support defaults', () => {
    const reasoningCandidate = findRegistryModel(
      (modelId) =>
        getModelCapabilities(modelId).supportsTools &&
        getModelCapabilities(modelId).isReasoningModel,
    );
    const supportCandidate = findRegistryModel((modelId) => {
      const capabilities = getModelCapabilities(modelId);
      return capabilities.supportsTools && !capabilities.isReasoningModel;
    });
    const defaults = selectArchModelPolicyDefaults([
      registryCandidate(reasoningCandidate, {
        tier: 'fast',
        isDefault: true,
      }),
      registryCandidate(supportCandidate, {
        tier: 'balanced',
        isDefault: false,
      }),
    ]);

    expect(defaults.fastToolCapable).toBeDefined();
    expect(getModelCapabilities(defaults.fastToolCapable!).isReasoningModel).toBe(false);
    expect(defaults.reasoning).toBeDefined();
    expect(getModelCapabilities(defaults.reasoning!).isReasoningModel).toBe(true);
  });

  it('returns a partial policy when no tenant or project model is available', () => {
    expect(selectArchModelPolicyDefaults([])).toEqual({});
  });
});
