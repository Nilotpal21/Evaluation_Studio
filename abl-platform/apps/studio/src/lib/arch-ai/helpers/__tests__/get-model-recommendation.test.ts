import { describe, expect, it } from 'vitest';

import { getModelRecommendation } from '../get-model-recommendation';

describe('getModelRecommendation', () => {
  it('treats gemini tenant policy entries as equivalent to google catalog providers', () => {
    const recommendation = getModelRecommendation({
      agentRole: 'lead qualification assistant',
      executionMode: 'scripted',
      requiresToolCalling: true,
      requiresVision: false,
      requiresStructuredOutput: true,
      complexityTier: 'simple',
      tenantModels: ['gemini-2.5-flash'],
      tenantPolicy: { allowedProviders: ['gemini'] },
    });

    expect(recommendation.primary).toMatchObject({
      provider: 'google',
      model: 'gemini-2.5-flash',
    });
    expect(recommendation.tenantFilterUnavailable).toBeUndefined();
  });

  it('does not recommend operation-specific models outside tenant policy constraints', () => {
    const recommendation = getModelRecommendation({
      agentRole: 'case intake coordinator',
      executionMode: 'hybrid',
      requiresToolCalling: true,
      requiresVision: false,
      requiresStructuredOutput: true,
      complexityTier: 'complex',
      operations: ['extraction', 'summarization', 'coordination'],
      tenantModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      tenantPolicy: { allowedProviders: ['gemini'] },
    });

    const operationProviders = Object.values(recommendation.perOperation ?? {}).map(
      (model) => model.provider,
    );
    expect(operationProviders).not.toContain('openai');
    expect(operationProviders).not.toContain('anthropic');
  });

  it('keeps unconstrained operation-specific recommendations unchanged', () => {
    const recommendation = getModelRecommendation({
      agentRole: 'document processor',
      executionMode: 'hybrid',
      requiresToolCalling: true,
      requiresVision: false,
      requiresStructuredOutput: true,
      complexityTier: 'moderate',
      operations: ['extraction'],
    });

    expect(recommendation.perOperation?.extraction).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
  });
});
