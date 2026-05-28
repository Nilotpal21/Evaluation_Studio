import { describe, it, expect } from 'vitest';
import { MODEL_REGISTRY, type HyperParameter } from '../model-registry.js';

function hasHyperParameterNamed(params: HyperParameter[], names: string[]): boolean {
  return params.some((param) => {
    if (names.includes(param.name) || names.includes(param.unifiedParam)) {
      return true;
    }
    return hasHyperParameterNamed(
      [...(param.options ?? []), ...(param.hyperParameters ?? [])],
      names,
    );
  });
}

describe('MODEL_REGISTRY', () => {
  describe('Registry structure', () => {
    it('should have valid entries', () => {
      expect(MODEL_REGISTRY).toBeDefined();
      expect(Object.keys(MODEL_REGISTRY).length).toBe(209);
    });

    it('all entries should have required fields', () => {
      Object.entries(MODEL_REGISTRY).forEach(([modelId, entry]) => {
        expect(entry.provider, `${modelId} missing provider`).toBeDefined();
        expect(entry.displayName, `${modelId} missing displayName`).toBeDefined();
        expect(entry.contextWindow, `${modelId} missing contextWindow`).toBeGreaterThanOrEqual(0);
        expect(entry.maxOutputTokens, `${modelId} missing maxOutputTokens`).toBeGreaterThanOrEqual(
          0,
        );
        expect(entry.hyperParameters, `${modelId} missing hyperParameters`).toBeInstanceOf(Array);
        expect(entry.capabilities, `${modelId} missing capabilities`).toBeInstanceOf(Array);
        expect(typeof entry.supportsTools, `${modelId} supportsTools not boolean`).toBe('boolean');
      });
    });
  });

  describe('Anthropic models', () => {
    const anthropicModels = Object.entries(MODEL_REGISTRY).filter(
      ([, model]) => model.provider === 'anthropic',
    );

    it('should have Anthropic models', () => {
      expect(anthropicModels.length).toBeGreaterThan(0);
    });

    it('all Anthropic models should have temperature range 0-1', () => {
      anthropicModels.forEach(([modelId, model]) => {
        const tempParam = model.hyperParameters.find(
          (p) => p.name === 'temperature' || p.unifiedParam === 'temperature',
        );
        if (tempParam && tempParam.type === 'rangeSlider') {
          expect(tempParam.min, `${modelId} temperature min should be 0`).toBe(0);
          expect(tempParam.max, `${modelId} temperature max should be 1`).toBe(1);
        }
      });
    });

    it('Claude 4.7/4.6/4.5/4.1 models with supportsThinking should have thinking parameters', () => {
      anthropicModels
        .filter(
          ([modelId]) =>
            modelId.includes('4-7') ||
            modelId.includes('4-6-') ||
            modelId.includes('4-5-') ||
            modelId.includes('4-1-'),
        )
        .forEach(([modelId, model]) => {
          if (model.supportsThinking) {
            const thinkingParam = model.hyperParameters.find(
              (p) => p.name === 'thinking' || p.unifiedParam === 'thinking',
            );
            expect(
              thinkingParam,
              `${modelId} marked supportsThinking but missing thinking parameter`,
            ).toBeDefined();
          }
        });
    });

    it('Claude Opus 4.7 does not advertise removed sampling parameters', () => {
      const model = MODEL_REGISTRY['claude-opus-4-7'];

      expect(model.temperatureDisabled).toBe(true);
      expect(model.topPDisabled).toBe(true);
      expect(hasHyperParameterNamed(model.hyperParameters, ['temperature'])).toBe(false);
      expect(hasHyperParameterNamed(model.hyperParameters, ['top_p', 'topP'])).toBe(false);
      expect(hasHyperParameterNamed(model.hyperParameters, ['top_k', 'topK'])).toBe(false);
    });
  });

  describe('OpenAI restricted models (o1/o3/o4)', () => {
    const restrictedModels = [
      'o1',
      'o1-2024-12-17',
      'o3',
      'o3-2025-04-16',
      'o3-mini',
      'o3-mini-2025-01-31',
      'o4-mini',
      'o4-mini-2025-04-16',
    ];

    restrictedModels.forEach((modelId) => {
      const model = MODEL_REGISTRY[modelId];

      if (model) {
        it(`${modelId} should NOT have temperature parameter`, () => {
          const tempParam = model.hyperParameters.find(
            (p) => p.name === 'temperature' || p.unifiedParam === 'temperature',
          );
          expect(tempParam).toBeUndefined();
        });

        it(`${modelId} should NOT have topP parameter`, () => {
          const topPParam = model.hyperParameters.find(
            (p) => p.name === 'topP' || p.name === 'top_p' || p.unifiedParam === 'topP',
          );
          expect(topPParam).toBeUndefined();
        });

        it(`${modelId} should NOT have frequency/presence penalty`, () => {
          const freqParam = model.hyperParameters.find(
            (p) => p.name === 'frequencyPenalty' || p.name === 'frequency_penalty',
          );
          const presParam = model.hyperParameters.find(
            (p) => p.name === 'presencePenalty' || p.name === 'presence_penalty',
          );
          expect(freqParam).toBeUndefined();
          expect(presParam).toBeUndefined();
        });

        it(`${modelId} should be marked as reasoning model`, () => {
          expect(model.isReasoningModel).toBe(true);
        });
      }
    });

    it('o3/o4 models should have reasoning_effort parameter', () => {
      const o3o4Models = [
        'o3',
        'o3-2025-04-16',
        'o3-mini',
        'o3-mini-2025-01-31',
        'o4-mini',
        'o4-mini-2025-04-16',
      ];

      o3o4Models.forEach((modelId) => {
        const model = MODEL_REGISTRY[modelId];
        if (model) {
          const reasoningParam = model.hyperParameters.find((p) => p.name === 'reasoning_effort');
          expect(reasoningParam, `${modelId} should have reasoning_effort parameter`).toBeDefined();
          expect(reasoningParam?.valueMap).toEqual(['low', 'medium', 'high']);
          expect(model.supportsReasoningEffort).toBe(true);
        }
      });
    });

    it('o1 models should NOT have reasoning_effort parameter (automatic)', () => {
      const o1Models = ['o1', 'o1-2024-12-17'];

      o1Models.forEach((modelId) => {
        const model = MODEL_REGISTRY[modelId];
        if (model) {
          const reasoningParam = model.hyperParameters.find((p) => p.name === 'reasoning_effort');
          expect(
            reasoningParam,
            `${modelId} should NOT have reasoning_effort (automatic reasoning)`,
          ).toBeUndefined();
        }
      });
    });
  });

  describe('Gemini reasoning models', () => {
    it('Gemini 3 Pro should have thinkingLevel with Low/High', () => {
      const model = MODEL_REGISTRY['gemini-3-pro-preview'];
      if (model) {
        const thinkingParam = model.hyperParameters.find(
          (p) => p.name === 'thinking_level' || p.name === 'thinkingLevel',
        );
        expect(thinkingParam).toBeDefined();
        // Gemini 3 Pro has Low/High as valueMap values
        expect(thinkingParam?.valueMap?.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('Gemini 3 Flash should have thinkingLevel with all 4 levels', () => {
      const model = MODEL_REGISTRY['gemini-3-flash-preview'];
      if (model) {
        const thinkingParam = model.hyperParameters.find(
          (p) => p.name === 'thinking_level' || p.name === 'thinkingLevel',
        );
        expect(thinkingParam).toBeDefined();
        // Gemini 3 Flash supports all 4 levels
        expect(thinkingParam?.valueMap?.length).toBe(4);
      }
    });

    it('Gemini 2.5 Pro should have thinkingBudget parameter', () => {
      const model = MODEL_REGISTRY['gemini-2.5-pro'];
      if (model) {
        const budgetParam = model.hyperParameters.find(
          (p) => p.name === 'thinking_budget' || p.name === 'thinkingBudget',
        );
        expect(budgetParam).toBeDefined();
        expect(budgetParam?.min).toBe(-1);
        expect(model.supportsThinkingBudget).toBe(true);
      }
    });
  });

  describe('New providers', () => {
    it('should have Mistral models', () => {
      const mistralModels = Object.entries(MODEL_REGISTRY).filter(
        ([, model]) => model.provider === 'mistral',
      );
      expect(mistralModels.length).toBeGreaterThan(0);

      // Check temperature range for Mistral (should be 0-1)
      mistralModels.forEach(([modelId, model]) => {
        const tempParam = model.hyperParameters.find((p) => p.name === 'temperature');
        if (tempParam && tempParam.type === 'rangeSlider') {
          expect(tempParam.min, `${modelId} temperature min`).toBe(0);
          expect(tempParam.max, `${modelId} temperature max`).toBe(1);
        }
      });
    });

    it('should have Groq models', () => {
      const groqModels = Object.entries(MODEL_REGISTRY).filter(
        ([, model]) => model.provider === 'groq',
      );
      expect(groqModels.length).toBeGreaterThan(0);

      // Groq uses OpenAI-compatible params (temp 0-2)
      groqModels.forEach(([modelId, model]) => {
        if (!modelId.includes('whisper')) {
          // Skip transcription models
          const tempParam = model.hyperParameters.find((p) => p.name === 'temperature');
          if (tempParam && tempParam.type === 'rangeSlider') {
            expect(tempParam.max, `${modelId} temperature max should be 2`).toBe(2);
          }
        }
      });
    });

    it('should have Fireworks models', () => {
      const fireworksModels = Object.entries(MODEL_REGISTRY).filter(
        ([, model]) => model.provider === 'fireworks',
      );
      expect(fireworksModels.length).toBeGreaterThan(0);
    });

    it('should have Together AI models', () => {
      const togetherModels = Object.entries(MODEL_REGISTRY).filter(
        ([, model]) => model.provider === 'togetherai',
      );
      expect(togetherModels.length).toBeGreaterThan(0);
    });

    it('should have Perplexity models with web search parameters', () => {
      const perplexityModels = Object.entries(MODEL_REGISTRY).filter(
        ([, model]) => model.provider === 'perplexity',
      );
      expect(perplexityModels.length).toBeGreaterThan(0);

      // Check for web search parameters
      perplexityModels.forEach(([modelId, model]) => {
        const searchDomainParam = model.hyperParameters.find(
          (p) => p.name === 'search_domain_filter',
        );
        const citationsParam = model.hyperParameters.find((p) => p.name === 'return_citations');
        expect(searchDomainParam, `${modelId} should have search_domain_filter`).toBeDefined();
        expect(citationsParam, `${modelId} should have return_citations`).toBeDefined();
      });
    });

    it('should have DeepSeek models', () => {
      const deepseekModels = Object.entries(MODEL_REGISTRY).filter(
        ([, model]) => model.provider === 'deepseek',
      );
      expect(deepseekModels.length).toBeGreaterThan(0);

      // DeepSeek reasoner should NOT have temperature (automatic)
      const reasoner = MODEL_REGISTRY['deepseek-reasoner'];
      if (reasoner) {
        const tempParam = reasoner.hyperParameters.find((p) => p.name === 'temperature');
        expect(tempParam, 'deepseek-reasoner should not have temperature').toBeUndefined();
        expect(reasoner.isReasoningModel).toBe(true);
      }

      // DeepSeek chat should have temperature
      const chat = MODEL_REGISTRY['deepseek-chat'];
      if (chat) {
        const tempParam = chat.hyperParameters.find((p) => p.name === 'temperature');
        expect(tempParam, 'deepseek-chat should have temperature').toBeDefined();
      }
    });

    it('should have xAI (Grok) models', () => {
      const xaiModels = Object.entries(MODEL_REGISTRY).filter(
        ([, model]) => model.provider === 'xai',
      );
      expect(xaiModels.length).toBeGreaterThan(0);

      // xAI has unique penalty range (0-1 instead of -2 to 2)
      xaiModels.forEach(([modelId, model]) => {
        const freqPenalty = model.hyperParameters.find(
          (p) => p.name === 'frequencyPenalty' || p.name === 'frequency_penalty',
        );
        if (freqPenalty && freqPenalty.type === 'rangeSlider') {
          expect(freqPenalty.min, `${modelId} frequency penalty min should be 0`).toBe(0);
          expect(freqPenalty.max, `${modelId} frequency penalty max should be 1`).toBe(1);
        }
      });
    });

    it('should have AWS Bedrock models', () => {
      const bedrockModels = Object.entries(MODEL_REGISTRY).filter(
        ([, model]) => model.provider === 'bedrock',
      );
      expect(bedrockModels.length).toBe(4); // Claude Opus 4.7, Sonnet 4.6, Sonnet 4, Haiku 4.5

      // Bedrock Claude models follow Anthropic temperature range (0-1)
      bedrockModels.forEach(([modelId, model]) => {
        const tempParam = model.hyperParameters.find((p) => p.name === 'temperature');
        if (tempParam && tempParam.type === 'rangeSlider') {
          expect(tempParam.min, `${modelId} temperature min`).toBe(0);
          expect(tempParam.max, `${modelId} temperature max`).toBe(1);
        }

        // Bedrock models should have guardrailConfig section
        const guardrailSection = model.hyperParameters.find((p) => p.name === 'guardrailConfig');
        expect(guardrailSection, `${modelId} should have guardrailConfig`).toBeDefined();
      });
    });
  });

  describe('HyperParameter validation', () => {
    it('all hyperParameters should have required fields', () => {
      Object.entries(MODEL_REGISTRY).forEach(([modelId, entry]) => {
        entry.hyperParameters.forEach((param, index) => {
          expect(param.type, `${modelId} param[${index}] missing type`).toBeDefined();
          expect(param.name, `${modelId} param[${index}] missing name`).toBeDefined();
          expect(param.displayName, `${modelId} param[${index}] missing displayName`).toBeDefined();
          expect(
            typeof param.required,
            `${modelId} param[${index}] required should be boolean`,
          ).toBe('boolean');
          expect(param.description, `${modelId} param[${index}] missing description`).toBeDefined();

          // Type-specific validation
          if (param.type === 'rangeSlider') {
            expect(typeof param.min, `${modelId} param[${index}] rangeSlider missing min`).toBe(
              'number',
            );
            expect(typeof param.max, `${modelId} param[${index}] rangeSlider missing max`).toBe(
              'number',
            );
          }

          if (param.type === 'dropdown' || param.type === 'radioButton') {
            expect(
              param.valueMap,
              `${modelId} param[${index}] dropdown/radio missing valueMap`,
            ).toBeDefined();
          }
        });
      });
    });

    it('rangeSlider parameters should have min < max', () => {
      Object.entries(MODEL_REGISTRY).forEach(([modelId, entry]) => {
        entry.hyperParameters.forEach((param) => {
          if (param.type === 'rangeSlider') {
            expect(param.min! < param.max!, `${modelId} param ${param.name} has min >= max`).toBe(
              true,
            );
          }
        });
      });
    });
  });

  describe('Provider consistency', () => {
    it('should have reasonable number of models per provider', () => {
      const providerCounts: Record<string, number> = {};

      Object.values(MODEL_REGISTRY).forEach((entry) => {
        providerCounts[entry.provider] = (providerCounts[entry.provider] || 0) + 1;
      });

      // Check we have the expected providers
      expect(providerCounts['anthropic']).toBeGreaterThan(0);
      expect(providerCounts['openai']).toBeGreaterThan(0);
      expect(providerCounts['google']).toBeGreaterThan(0);
      expect(providerCounts['mistral']).toBeGreaterThan(0);
      expect(providerCounts['groq']).toBeGreaterThan(0);
      expect(providerCounts['deepseek']).toBeGreaterThan(0);
      expect(providerCounts['xai']).toBeGreaterThan(0);
      expect(providerCounts['bedrock']).toBeGreaterThan(0);
    });
  });

  describe('Azure models', () => {
    it('GPT-5.1 Azure models should have reasoning_effort with "none" default', () => {
      const gpt51 = MODEL_REGISTRY['GPT-5.1'];
      const gpt51Chat = MODEL_REGISTRY['GPT-5.1-Chat'];

      if (gpt51) {
        const reasoningParam = gpt51.hyperParameters.find((p) => p.name === 'reasoning_effort');
        expect(reasoningParam, 'GPT-5.1 should have reasoning_effort').toBeDefined();
        expect(reasoningParam?.defaultValue).toBe('none');
        expect(reasoningParam?.valueMap).toContain('none');
      }

      if (gpt51Chat) {
        const reasoningParam = gpt51Chat.hyperParameters.find((p) => p.name === 'reasoning_effort');
        expect(reasoningParam, 'GPT-5.1-Chat should have reasoning_effort').toBeDefined();
        expect(reasoningParam?.defaultValue).toBe('none');
      }
    });
  });
});
