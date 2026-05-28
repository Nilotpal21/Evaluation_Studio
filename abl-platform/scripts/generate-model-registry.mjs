#!/usr/bin/env node
/**
 * Generate Model Registry
 *
 * Reads ml-model-config (CJS library outside the monorepo) and generates
 * a typed ESM module with model hyperparameters and capabilities.
 *
 * Usage: node scripts/generate-model-registry.mjs
 *
 * Output: packages/compiler/src/platform/llm/model-registry.ts
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load ml-model-config CJS module
const mlConfigPath = resolve(__dirname, '../../ml-model-config/modelConfig');
const { default: modelConfigFn, modelsProvider } = (() => {
  try {
    const mod = require(mlConfigPath);
    return {
      default: mod.modelConfig || mod,
      modelsProvider: mod.modelsProvider || require(resolve(mlConfigPath, 'providerMap.js')).modelsProvider,
    };
  } catch (err) {
    console.error('Failed to load ml-model-config:', err.message);
    console.error('Ensure /kore/ml-model-config exists relative to the monorepo root.');
    process.exit(1);
  }
})();

// Normalize provider name to our enum
function normalizeProvider(rawProvider) {
  if (!rawProvider) return 'custom';
  const p = rawProvider.toLowerCase().replace(/\s+/g, '');
  if (p.includes('openai') && p.includes('azure')) return 'azure';
  if (p.includes('openai') || p === 'openai') return 'openai';
  if (p.includes('anthropic')) return 'anthropic';
  if (p.includes('google') || p.includes('gemini')) return 'google';
  if (p.includes('cohere')) return 'cohere';
  if (p.includes('groq')) return 'groq';
  return 'custom';
}

// Check if an object looks like a valid HyperParameter (has name/displayName)
function isValidHyperParam(obj) {
  return obj && typeof obj === 'object' && obj.name && obj.displayName;
}

// Convert a hyperParameter object from ml-model-config to our shape
function convertHyperParam(hp) {
  // Skip objects that don't have enough data to be a valid param
  if (!hp || !hp.name) return null;

  let rawType = hp.type === 'textArea' ? 'text' : hp.type || 'rangeSlider';
  // Normalize 'radio' to 'radioButton'
  if (rawType === 'radio') rawType = 'radioButton';
  const result = {
    type: rawType,
    name: hp.name,
    unifiedParam: hp.unifiedParam || hp.name,
    displayName: hp.displayName || hp.name,
    required: hp.required || false,
    description: hp.description || '',
  };

  if (hp.defaultvalueInputNum !== undefined) {
    result.defaultValue = Array.isArray(hp.defaultvalueInputNum)
      ? hp.defaultvalueInputNum[0]
      : hp.defaultvalueInputNum;
  }

  if (rawType === 'rangeSlider') {
    if (hp.minRange !== undefined) result.min = hp.minRange;
    if (hp.maxRange !== undefined) result.max = hp.maxRange;
    if (hp.sliderStep !== undefined) result.step = hp.sliderStep;
  }

  // Handle nested options (radioButton with sub-params that ARE full HyperParam objects)
  if (hp.options && Array.isArray(hp.options)) {
    const validOptions = hp.options
      .filter(isValidHyperParam)
      .map(convertHyperParam)
      .filter(Boolean);
    if (validOptions.length > 0) {
      result.options = validOptions;
    }
    // For dropdown options that are just labels (no name/displayName), store as valueMap
    const labelOptions = hp.options
      .filter(o => !isValidHyperParam(o))
      .map(o => typeof o === 'string' ? o : (o.label || o.value || o.displayName || String(o)));
    if (labelOptions.length > 0 && !result.options) {
      result.valueMap = labelOptions;
    }
  }

  // Handle valueMap for enum sliders
  if (hp.valueMap && Array.isArray(hp.valueMap)) {
    result.valueMap = hp.valueMap;
  }

  return result;
}

// Process all models
const registry = {};
const modelNames = Object.keys(modelsProvider);

let successCount = 0;
let errorCount = 0;

for (const modelName of modelNames) {
  // Skip KoreHosted and API generic models
  const providerDir = modelsProvider[modelName];
  if (providerDir === 'KoreHosted' || providerDir === 'API') continue;

  try {
    const config = typeof modelConfigFn === 'function'
      ? modelConfigFn(modelName)
      : modelConfigFn;

    if (!config) continue;

    const hyperParameters = [];
    if (config.modelConfigs?.hyperParameters) {
      for (const hp of config.modelConfigs.hyperParameters) {
        const converted = convertHyperParam(hp);
        if (converted) hyperParameters.push(converted);
      }
    }

    const entry = {
      provider: normalizeProvider(config.provider || providerDir),
      hyperParameters,
      capabilities: config.IOMappings || [],
      supportsTools: config.support_tools ?? false,
      supportsParallelToolCalls: config.support_parallel_tool_calls ?? false,
      supportsStructuredOutput: config.supportsStructuredOutput ?? false,
    };

    registry[modelName] = entry;
    successCount++;
  } catch (err) {
    errorCount++;
    // Some models may fail to load — skip silently
    if (process.env.DEBUG) {
      console.warn(`  Skipped ${modelName}: ${err.message}`);
    }
  }
}

console.log(`Processed ${successCount} models (${errorCount} skipped)`);

// Generate TypeScript output
const outputPath = resolve(__dirname, '../packages/compiler/src/platform/llm/model-registry.ts');

function jsonValue(val) {
  return JSON.stringify(val);
}

let output = `/**
 * AUTO-GENERATED — DO NOT EDIT
 *
 * Generated by: scripts/generate-model-registry.mjs
 * Source: ml-model-config (${successCount} models)
 * Date: ${new Date().toISOString().split('T')[0]}
 *
 * Regenerate: node scripts/generate-model-registry.mjs
 */

// =============================================================================
// TYPES
// =============================================================================

export interface HyperParameter {
  type: 'rangeSlider' | 'text' | 'dropdown' | 'radioButton';
  name: string;
  unifiedParam: string;
  displayName: string;
  required: boolean;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  description: string;
  valueMap?: string[];
  options?: HyperParameter[];
}

export interface ModelRegistryEntry {
  provider: string;
  hyperParameters: HyperParameter[];
  capabilities: string[];
  supportsTools: boolean;
  supportsParallelToolCalls: boolean;
  supportsStructuredOutput: boolean;
}

// =============================================================================
// REGISTRY DATA
// =============================================================================

export const MODEL_REGISTRY: Record<string, ModelRegistryEntry> = {\n`;

const entries = Object.entries(registry);
for (const [modelName, entry] of entries) {
  output += `  ${jsonValue(modelName)}: {\n`;
  output += `    provider: ${jsonValue(entry.provider)},\n`;

  // hyperParameters
  if (entry.hyperParameters.length === 0) {
    output += `    hyperParameters: [],\n`;
  } else {
    output += `    hyperParameters: [\n`;
    for (const hp of entry.hyperParameters) {
      output += `      {\n`;
      output += `        type: ${jsonValue(hp.type)},\n`;
      output += `        name: ${jsonValue(hp.name)},\n`;
      output += `        unifiedParam: ${jsonValue(hp.unifiedParam)},\n`;
      output += `        displayName: ${jsonValue(hp.displayName)},\n`;
      output += `        required: ${hp.required},\n`;
      if (hp.defaultValue !== undefined) output += `        defaultValue: ${hp.defaultValue},\n`;
      if (hp.min !== undefined) output += `        min: ${hp.min},\n`;
      if (hp.max !== undefined) output += `        max: ${hp.max},\n`;
      if (hp.step !== undefined) output += `        step: ${hp.step},\n`;
      output += `        description: ${jsonValue(hp.description)},\n`;
      if (hp.valueMap) output += `        valueMap: ${jsonValue(hp.valueMap)},\n`;
      if (hp.options) output += `        options: ${JSON.stringify(hp.options, null, 8).replace(/\n/g, '\n      ')},\n`;
      output += `      },\n`;
    }
    output += `    ],\n`;
  }

  output += `    capabilities: ${jsonValue(entry.capabilities)},\n`;
  output += `    supportsTools: ${entry.supportsTools},\n`;
  output += `    supportsParallelToolCalls: ${entry.supportsParallelToolCalls},\n`;
  output += `    supportsStructuredOutput: ${entry.supportsStructuredOutput},\n`;
  output += `  },\n`;
}

output += `};\n\n`;
output += `/** All model IDs in the registry */\n`;
output += `export const MODEL_IDS = Object.keys(MODEL_REGISTRY);\n`;

writeFileSync(outputPath, output, 'utf-8');
console.log(`Written to: ${outputPath}`);
console.log(`Total models: ${entries.length}`);
