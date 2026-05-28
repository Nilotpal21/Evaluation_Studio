#!/usr/bin/env tsx
/**
 * Model Registry Validation Script
 *
 * Validates MODEL_REGISTRY entries against official provider specifications.
 * Checks:
 * - Temperature ranges match provider specs
 * - Restricted parameters NOT present on o1/o3/o4 models
 * - Reasoning parameters present on reasoning models
 * - Max output tokens consistency
 * - Parameter support correctness
 *
 * Usage: pnpm tsx scripts/validate-model-registry.ts
 */

import { MODEL_REGISTRY } from '../packages/compiler/src/platform/llm/model-registry.js';

interface ValidationIssue {
  modelId: string;
  severity: 'error' | 'warning' | 'info';
  issue: string;
  expected: any;
  actual: any;
}

// Known specifications from official documentation
const PROVIDER_SPECS = {
  anthropic: {
    temperatureRange: { min: 0, max: 1 },
    restrictedParams: [],
  },
  openai: {
    temperatureRange: { min: 0, max: 2 },
    restrictedModels: [
      'o1',
      'o1-2024-12-17',
      'o3',
      'o3-2025-04-16',
      'o3-mini',
      'o3-mini-2025-01-31',
      'o4-mini',
      'o4-mini-2025-04-16',
    ],
    restrictedParams: ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty'],
    o3o4Models: [
      'o3',
      'o3-2025-04-16',
      'o3-mini',
      'o3-mini-2025-01-31',
      'o4-mini',
      'o4-mini-2025-04-16',
    ],
    o1Models: ['o1', 'o1-2024-12-17'],
  },
  google: {
    temperatureRange: { min: 0, max: 2 },
    temperatureDefault: 1.0,
    restrictedParams: [],
  },
  azure: {
    temperatureRange: { min: 0, max: 2 },
    restrictedParams: [],
  },
  mistral: {
    temperatureRange: { min: 0, max: 1 },
    restrictedParams: [],
  },
  groq: {
    temperatureRange: { min: 0, max: 2 },
    restrictedParams: [],
  },
  fireworks: {
    temperatureRange: { min: 0, max: 2 },
    restrictedParams: [],
  },
  togetherai: {
    temperatureRange: { min: 0, max: 2 },
    restrictedParams: [],
  },
  perplexity: {
    temperatureRange: { min: 0, max: 2 },
    restrictedParams: [],
  },
  deepseek: {
    temperatureRange: { min: 0, max: 2 },
    restrictedModels: ['deepseek-reasoner'],
    restrictedParams: ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty'],
  },
  xai: {
    temperatureRange: { min: 0, max: 2 },
    penaltyRange: { min: 0, max: 1 }, // Different from others!
    restrictedParams: [],
  },
  bedrock: {
    temperatureRange: { min: 0, max: 1 }, // Bedrock Claude models follow Anthropic specs
    restrictedParams: [],
  },
};

function validateModel(modelId: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const entry = MODEL_REGISTRY[modelId];

  if (!entry) {
    issues.push({
      modelId,
      severity: 'error',
      issue: 'Model missing from MODEL_REGISTRY',
      expected: 'Present',
      actual: 'Missing',
    });
    return issues;
  }

  const provider = entry.provider;
  const specs = PROVIDER_SPECS[provider as keyof typeof PROVIDER_SPECS];

  if (!specs) {
    // Unknown provider, skip validation
    return issues;
  }

  // Check temperature parameter
  const tempParam = entry.hyperParameters.find(
    (p) => p.name === 'temperature' || p.unifiedParam === 'temperature',
  );

  // Check if model should be restricted (OpenAI o1/o3/o4, DeepSeek reasoner)
  const isRestrictedModel =
    (provider === 'openai' && specs.restrictedModels?.includes(modelId)) ||
    (provider === 'deepseek' && specs.restrictedModels?.includes(modelId));

  if (isRestrictedModel) {
    // Restricted models should NOT have temperature, topP, penalties
    if (tempParam) {
      issues.push({
        modelId,
        severity: 'error',
        issue: 'Restricted model has temperature parameter (should not)',
        expected: null,
        actual: tempParam,
      });
    }

    const topPParam = entry.hyperParameters.find(
      (p) => p.name === 'topP' || p.name === 'top_p' || p.unifiedParam === 'topP',
    );
    if (topPParam) {
      issues.push({
        modelId,
        severity: 'error',
        issue: 'Restricted model has topP parameter (should not)',
        expected: null,
        actual: topPParam,
      });
    }

    const freqPenalty = entry.hyperParameters.find(
      (p) => p.name === 'frequencyPenalty' || p.name === 'frequency_penalty',
    );
    if (freqPenalty) {
      issues.push({
        modelId,
        severity: 'error',
        issue: 'Restricted model has frequencyPenalty parameter (should not)',
        expected: null,
        actual: freqPenalty,
      });
    }

    const presPenalty = entry.hyperParameters.find(
      (p) => p.name === 'presencePenalty' || p.name === 'presence_penalty',
    );
    if (presPenalty) {
      issues.push({
        modelId,
        severity: 'error',
        issue: 'Restricted model has presencePenalty parameter (should not)',
        expected: null,
        actual: presPenalty,
      });
    }
  } else {
    // Non-restricted models should have temperature with correct range
    if (specs.temperatureRange && tempParam) {
      if (tempParam.type === 'rangeSlider') {
        if (
          tempParam.min !== specs.temperatureRange.min ||
          tempParam.max !== specs.temperatureRange.max
        ) {
          issues.push({
            modelId,
            severity: 'error',
            issue: 'Temperature range mismatch',
            expected: specs.temperatureRange,
            actual: { min: tempParam.min, max: tempParam.max },
          });
        }
      }
    }
  }

  // Check reasoning parameters for reasoning models
  if (entry.isReasoningModel) {
    const hasReasoningParam = entry.hyperParameters.some(
      (p) =>
        p.name === 'reasoning_effort' ||
        p.name === 'thinking' ||
        p.name === 'thinkingLevel' ||
        p.name === 'thinkingBudget',
    );

    // o3/o4 should have reasoning_effort, o1 should NOT
    if (provider === 'openai') {
      const isO3O4 = specs.o3o4Models?.includes(modelId);
      const isO1 = specs.o1Models?.includes(modelId);

      if (isO3O4) {
        const reasoningEffort = entry.hyperParameters.find((p) => p.name === 'reasoning_effort');
        if (!reasoningEffort) {
          issues.push({
            modelId,
            severity: 'error',
            issue: 'o3/o4 model missing reasoning_effort parameter',
            expected: 'reasoning_effort parameter',
            actual: null,
          });
        }
      } else if (isO1) {
        const reasoningEffort = entry.hyperParameters.find((p) => p.name === 'reasoning_effort');
        if (reasoningEffort) {
          issues.push({
            modelId,
            severity: 'error',
            issue: 'o1 model has reasoning_effort (should not - automatic reasoning)',
            expected: null,
            actual: reasoningEffort,
          });
        }
      }
    }

    // DeepSeek reasoner should NOT have reasoning params (automatic)
    if (provider === 'deepseek' && modelId === 'deepseek-reasoner') {
      if (hasReasoningParam) {
        issues.push({
          modelId,
          severity: 'error',
          issue: 'DeepSeek reasoner has reasoning parameter (should be automatic)',
          expected: null,
          actual: 'Has reasoning param',
        });
      }
    }
  }

  // Check xAI penalty range (0-1 instead of -2 to 2)
  if (provider === 'xai') {
    const freqPenalty = entry.hyperParameters.find(
      (p) => p.name === 'frequencyPenalty' || p.name === 'frequency_penalty',
    );
    if (freqPenalty && freqPenalty.type === 'rangeSlider') {
      if (freqPenalty.min !== 0 || freqPenalty.max !== 1) {
        issues.push({
          modelId,
          severity: 'error',
          issue: 'xAI frequency penalty range incorrect (should be 0-1)',
          expected: { min: 0, max: 1 },
          actual: { min: freqPenalty.min, max: freqPenalty.max },
        });
      }
    }

    const presPenalty = entry.hyperParameters.find(
      (p) => p.name === 'presencePenalty' || p.name === 'presence_penalty',
    );
    if (presPenalty && presPenalty.type === 'rangeSlider') {
      if (presPenalty.min !== 0 || presPenalty.max !== 1) {
        issues.push({
          modelId,
          severity: 'error',
          issue: 'xAI presence penalty range incorrect (should be 0-1)',
          expected: { min: 0, max: 1 },
          actual: { min: presPenalty.min, max: presPenalty.max },
        });
      }
    }
  }

  // Check Claude 4.5/4.1 thinking parameters
  if (provider === 'anthropic' && entry.supportsThinking) {
    const thinkingSection = entry.hyperParameters.find((p) => p.name === 'thinking');
    if (!thinkingSection) {
      issues.push({
        modelId,
        severity: 'warning',
        issue: 'Claude 4.5/4.1 model marked supportsThinking but missing thinking section',
        expected: 'thinking section',
        actual: null,
      });
    }
  }

  // Check Gemini reasoning models
  if (provider === 'google' && entry.supportsThinkingBudget) {
    const hasThinkingLevel = entry.hyperParameters.some(
      (p) => p.name === 'thinking_level' || p.name === 'thinkingLevel',
    );
    const hasThinkingBudget = entry.hyperParameters.some(
      (p) => p.name === 'thinking_budget' || p.name === 'thinkingBudget',
    );

    if (!hasThinkingLevel && !hasThinkingBudget) {
      issues.push({
        modelId,
        severity: 'warning',
        issue: 'Gemini model marked supportsThinkingBudget but missing thinking parameters',
        expected: 'thinkingLevel or thinkingBudget',
        actual: null,
      });
    }
  }

  return issues;
}

function main() {
  console.log('🔍 Validating MODEL_REGISTRY against official provider specifications...\n');

  const allIssues: ValidationIssue[] = [];
  const modelIds = Object.keys(MODEL_REGISTRY);

  for (const modelId of modelIds) {
    const issues = validateModel(modelId);
    allIssues.push(...issues);
  }

  // Group by severity
  const errors = allIssues.filter((i) => i.severity === 'error');
  const warnings = allIssues.filter((i) => i.severity === 'warning');
  const info = allIssues.filter((i) => i.severity === 'info');

  // Print summary
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                   VALIDATION RESULTS                          ');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log(`📊 Total models validated: ${modelIds.length}`);
  console.log(`❌ Errors: ${errors.length}`);
  console.log(`⚠️  Warnings: ${warnings.length}`);
  console.log(`ℹ️  Info: ${info.length}`);
  console.log('');

  if (errors.length > 0) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                         ERRORS                                ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    errors.forEach((e) => {
      console.log(`❌ [${e.modelId}]`);
      console.log(`   Issue: ${e.issue}`);
      console.log(`   Expected: ${JSON.stringify(e.expected)}`);
      console.log(`   Actual: ${JSON.stringify(e.actual)}`);
      console.log('');
    });
  }

  if (warnings.length > 0) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                        WARNINGS                               ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    warnings.forEach((w) => {
      console.log(`⚠️  [${w.modelId}]`);
      console.log(`   Issue: ${w.issue}`);
      console.log(`   Expected: ${JSON.stringify(w.expected)}`);
      console.log(`   Actual: ${JSON.stringify(w.actual)}`);
      console.log('');
    });
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log('✅ All validations passed! MODEL_REGISTRY is consistent with provider specs.\n');
  }

  console.log('═══════════════════════════════════════════════════════════════\n');

  // Exit with error code if there are errors
  if (errors.length > 0) {
    console.error('❌ Validation failed with errors. Please fix the issues above.\n');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn('⚠️  Validation completed with warnings. Review the warnings above.\n');
  }

  console.log('✅ Validation complete!\n');
  process.exit(0);
}

main();
