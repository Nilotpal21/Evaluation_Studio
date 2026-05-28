import { describe, expect, it } from 'vitest';
import { buildProjectModelOptions } from '../useProjectModelOptions';
import type { ProjectModel, TenantModelSummary } from '../useProjectModelOptions';

function projectModel(overrides: Partial<ProjectModel>): ProjectModel {
  return {
    id: 'model-config-1',
    name: 'GPT-4o',
    modelId: 'gpt-4o',
    provider: 'openai',
    isDefault: false,
    ...overrides,
  };
}

function tenantModel(overrides: Partial<TenantModelSummary>): TenantModelSummary {
  return {
    id: 'tenant-model-1',
    modelId: 'gpt-4o',
    provider: 'openai',
    isActive: true,
    inferenceEnabled: true,
    _count: { connections: 1 },
    ...overrides,
  };
}

describe('buildProjectModelOptions', () => {
  it('marks linked project models without active tenant credentials as unavailable', () => {
    const options = buildProjectModelOptions(
      [
        projectModel({
          name: 'Claude Sonnet',
          modelId: 'claude-sonnet-4-5',
          provider: 'anthropic',
          tenantModelId: 'anthropic-model',
        }),
      ],
      [
        tenantModel({
          id: 'anthropic-model',
          modelId: 'claude-sonnet-4-5',
          provider: 'anthropic',
          _count: { connections: 0 },
        }),
      ],
    );

    expect(options).toEqual([
      expect.objectContaining({
        value: 'claude-sonnet-4-5',
        name: 'Claude Sonnet',
        isCredentialReady: false,
      }),
    ]);
  });

  it('marks linked project models with active tenant credentials as ready', () => {
    const options = buildProjectModelOptions(
      [
        projectModel({
          modelId: 'gpt-4o',
          provider: 'openai',
          tenantModelId: 'openai-model',
        }),
      ],
      [
        tenantModel({
          id: 'openai-model',
          modelId: 'gpt-4o',
          provider: 'openai',
          _count: { connections: 1 },
        }),
      ],
    );

    expect(options[0]).toEqual(
      expect.objectContaining({
        value: 'gpt-4o',
        isCredentialReady: true,
      }),
    );
  });

  it('keeps project-level credential overrides selectable', () => {
    const options = buildProjectModelOptions(
      [
        projectModel({
          name: 'Custom Anthropic',
          modelId: 'claude-sonnet-4-5',
          provider: 'anthropic',
          authProfileId: 'auth-profile-1',
        }),
      ],
      [],
    );

    expect(options[0]).toEqual(
      expect.objectContaining({
        value: 'claude-sonnet-4-5',
        isCredentialReady: true,
      }),
    );
  });

  it('sorts default models first without promoting unavailable models to ready', () => {
    const options = buildProjectModelOptions(
      [
        projectModel({
          name: 'Beta Model',
          modelId: 'beta-model',
          provider: 'openai',
          tenantModelId: 'beta-tenant-model',
          isDefault: false,
        }),
        projectModel({
          name: 'Alpha Default',
          modelId: 'alpha-model',
          provider: 'anthropic',
          tenantModelId: 'missing-tenant-model',
          isDefault: true,
        }),
      ],
      [
        tenantModel({
          id: 'beta-tenant-model',
          modelId: 'beta-model',
          provider: 'openai',
          _count: { connections: 1 },
        }),
      ],
    );

    expect(options.map((option) => option.value)).toEqual(['alpha-model', 'beta-model']);
    expect(options.map((option) => option.isCredentialReady)).toEqual([false, true]);
  });

  it('keeps models selectable when credential readiness cannot be evaluated', () => {
    const options = buildProjectModelOptions(
      [
        projectModel({
          name: 'Claude Sonnet',
          modelId: 'claude-sonnet-4-5',
          provider: 'anthropic',
          tenantModelId: 'anthropic-model',
        }),
      ],
      [],
      false,
    );

    expect(options[0]).toEqual(
      expect.objectContaining({
        value: 'claude-sonnet-4-5',
        isCredentialReady: true,
      }),
    );
  });
});
