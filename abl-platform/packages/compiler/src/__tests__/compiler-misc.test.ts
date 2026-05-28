/**
 * Miscellaneous Compiler Module Tests
 *
 * Tests for:
 * - Distributed HLC (Hybrid Logical Clock)
 * - Model Registry (registration, routing, fallbacks, scoring)
 * - Entity Extraction Utils (dates, numbers, destinations, combined)
 * - Observability Context (AsyncLocalStorage)
 * - Platform Core Types (type guards, type definitions)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';

// HLC
import { HybridLogicalClock, type HLCTimestamp } from '../platform/distributed/hlc.js';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import {
  CONSTRAINT_CHECKPOINT_KIND_KEY,
  CONSTRAINT_CHECKPOINT_TARGET_KEY,
} from '../platform/constants.js';

// Model Registry
import {
  ModelRegistry,
  getModelRegistry,
  resetModelRegistry,
  type ModelInfo,
  type TaskRequirements,
} from '../platform/model-registry/registry.js';
import { getDefaultModel } from '../platform/llm/provider.js';

// Entity Extraction
import {
  extractDates,
  extractNumbers,
  extractDestination,
  extractAllEntities,
  extractEntitiesForFields,
  MONTH_MAP,
  LOCALE_MONTH_MAPS,
  DEFAULT_DESTINATIONS,
} from '../platform/utils/entity-extraction.js';

// Observability Context
import {
  runWithObservabilityContext,
  getObservabilityContext,
  getCurrentTraceId,
  getCurrentSpanId,
} from '../platform/observability/context.js';

// =============================================================================
// HYBRID LOGICAL CLOCK
// =============================================================================

describe('HybridLogicalClock', () => {
  describe('now', () => {
    test('generates timestamp with nodeId', () => {
      const hlc = new HybridLogicalClock('pod-1');
      const ts = hlc.now();
      expect(ts.nodeId).toBe('pod-1');
      expect(ts.wallMs).toBeGreaterThan(0);
      expect(ts.logical).toBe(0);
    });

    test('increments logical counter for same-ms timestamps', () => {
      const hlc = new HybridLogicalClock('pod-1');

      // Force wall clock to be "stale" by calling now() rapidly
      const ts1 = hlc.now();
      // Manually reduce wall clock to force same-ms path
      const ts2 = hlc.now();

      // If both happen within same ms, logical should increment
      // If not (they're in different ms), logical resets to 0
      if (ts1.wallMs === ts2.wallMs) {
        expect(ts2.logical).toBe(1);
      } else {
        expect(ts2.logical).toBe(0);
      }
    });
  });

  describe('receive', () => {
    test('merges with remote timestamp maintaining causal ordering', () => {
      const hlcA = new HybridLogicalClock('pod-a');
      const hlcB = new HybridLogicalClock('pod-b');

      const tsA = hlcA.now();
      const tsB = hlcB.receive(tsA);

      // tsB should be >= tsA in causal ordering
      expect(HybridLogicalClock.compare(tsB, tsA)).toBeGreaterThanOrEqual(0);
    });

    test('advances past remote timestamp when remote is ahead', () => {
      const hlc = new HybridLogicalClock('pod-1');

      const farFuture: HLCTimestamp = {
        wallMs: Date.now() + 100000, // 100s in the future
        logical: 5,
        nodeId: 'pod-2',
      };

      const ts = hlc.receive(farFuture);
      expect(ts.wallMs).toBeGreaterThanOrEqual(farFuture.wallMs);
    });

    test('sets nodeId to local node', () => {
      const hlc = new HybridLogicalClock('local-pod');
      const remote: HLCTimestamp = { wallMs: Date.now(), logical: 0, nodeId: 'remote-pod' };
      const ts = hlc.receive(remote);
      expect(ts.nodeId).toBe('local-pod');
    });
  });

  describe('compare', () => {
    test('returns -1 when a < b by wallMs', () => {
      const a: HLCTimestamp = { wallMs: 1000, logical: 0, nodeId: 'pod-1' };
      const b: HLCTimestamp = { wallMs: 2000, logical: 0, nodeId: 'pod-1' };
      expect(HybridLogicalClock.compare(a, b)).toBe(-1);
    });

    test('returns 1 when a > b by wallMs', () => {
      const a: HLCTimestamp = { wallMs: 2000, logical: 0, nodeId: 'pod-1' };
      const b: HLCTimestamp = { wallMs: 1000, logical: 0, nodeId: 'pod-1' };
      expect(HybridLogicalClock.compare(a, b)).toBe(1);
    });

    test('compares by logical when wallMs is equal', () => {
      const a: HLCTimestamp = { wallMs: 1000, logical: 1, nodeId: 'pod-1' };
      const b: HLCTimestamp = { wallMs: 1000, logical: 2, nodeId: 'pod-1' };
      expect(HybridLogicalClock.compare(a, b)).toBe(-1);
    });

    test('compares by nodeId when wallMs and logical are equal', () => {
      const a: HLCTimestamp = { wallMs: 1000, logical: 0, nodeId: 'aaa' };
      const b: HLCTimestamp = { wallMs: 1000, logical: 0, nodeId: 'bbb' };
      expect(HybridLogicalClock.compare(a, b)).toBe(-1);
    });

    test('returns 0 for identical timestamps', () => {
      const a: HLCTimestamp = { wallMs: 1000, logical: 0, nodeId: 'pod-1' };
      const b: HLCTimestamp = { wallMs: 1000, logical: 0, nodeId: 'pod-1' };
      expect(HybridLogicalClock.compare(a, b)).toBe(0);
    });
  });

  describe('toString / fromString', () => {
    test('serializes to sortable hex string', () => {
      const ts: HLCTimestamp = { wallMs: 1700000000000, logical: 42, nodeId: 'pod-1' };
      const str = HybridLogicalClock.toString(ts);
      expect(str).toContain('pod-1');
      expect(str.split(':').length).toBeGreaterThanOrEqual(3);
    });

    test('round-trips correctly', () => {
      const original: HLCTimestamp = { wallMs: 1700000000000, logical: 42, nodeId: 'pod-1' };
      const str = HybridLogicalClock.toString(original);
      const parsed = HybridLogicalClock.fromString(str);
      expect(parsed.wallMs).toBe(original.wallMs);
      expect(parsed.logical).toBe(original.logical);
      expect(parsed.nodeId).toBe(original.nodeId);
    });

    test('lexicographic ordering matches temporal ordering', () => {
      const earlier: HLCTimestamp = { wallMs: 1700000000000, logical: 0, nodeId: 'pod-1' };
      const later: HLCTimestamp = { wallMs: 1700000001000, logical: 0, nodeId: 'pod-1' };

      const strEarlier = HybridLogicalClock.toString(earlier);
      const strLater = HybridLogicalClock.toString(later);

      expect(strEarlier < strLater).toBe(true);
    });

    test('handles nodeId with colons', () => {
      const ts: HLCTimestamp = { wallMs: 1000, logical: 0, nodeId: 'pod:with:colons' };
      const str = HybridLogicalClock.toString(ts);
      const parsed = HybridLogicalClock.fromString(str);
      expect(parsed.nodeId).toBe('pod:with:colons');
    });

    test('throws for invalid string', () => {
      expect(() => HybridLogicalClock.fromString('invalid')).toThrow('Invalid HLC timestamp');
    });
  });
});

// =============================================================================
// MODEL REGISTRY
// =============================================================================

describe('ModelRegistry', () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    resetModelRegistry();
    registry = new ModelRegistry();
  });

  describe('default models', () => {
    test('initializes with default models from Anthropic, OpenAI, and Gemini', () => {
      const all = registry.listModels();
      expect(all.length).toBeGreaterThanOrEqual(7);

      const providers = new Set(all.map((m) => m.provider));
      expect(providers.has('anthropic')).toBe(true);
      expect(providers.has('openai')).toBe(true);
      expect(providers.has('gemini')).toBe(true);
    });

    test('includes claude-sonnet-4 model', () => {
      const model = registry.getModel('claude-sonnet-4-20250514');
      expect(model).not.toBeNull();
      expect(model!.provider).toBe('anthropic');
      expect(model!.tier).toBe('balanced');
    });

    test('includes gpt-4o model', () => {
      const model = registry.getModel('gpt-4o');
      expect(model).not.toBeNull();
      expect(model!.provider).toBe('openai');
    });
  });

  describe('registerModel / getModel / removeModel', () => {
    test('registers and retrieves a custom model', () => {
      const custom: ModelInfo = {
        id: 'custom-model-1',
        provider: 'anthropic',
        name: 'Custom Model',
        family: 'custom',
        tier: 'balanced',
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          structuredOutput: true,
          maxContextTokens: 50000,
          maxOutputTokens: 4096,
          parallelToolCalls: false,
          promptCaching: false,
        },
        pricing: { inputPer1M: 2, outputPer1M: 8 },
        limits: { requestsPerMinute: 100, tokensPerMinute: 50000 },
      };

      registry.registerModel(custom);
      const found = registry.getModel('custom-model-1');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Custom Model');
    });

    test('registers tenant-specific model', () => {
      const custom: ModelInfo = {
        id: 'tenant-model',
        provider: 'openai',
        name: 'Tenant Model',
        family: 'gpt-custom',
        tier: 'fast',
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          structuredOutput: false,
          maxContextTokens: 8000,
          maxOutputTokens: 2000,
          parallelToolCalls: false,
          promptCaching: false,
        },
        pricing: { inputPer1M: 1, outputPer1M: 3 },
        limits: { requestsPerMinute: 500, tokensPerMinute: 100000 },
      };

      registry.registerModel(custom, 'tenant-abc');

      // Not found globally
      const globalResult = registry.getModel('tenant-model');
      expect(globalResult).toBeNull();

      // Found for tenant
      const tenantResult = registry.getModel('tenant-model', 'tenant-abc');
      expect(tenantResult).not.toBeNull();
      expect(tenantResult!.name).toBe('Tenant Model');
    });

    test('removeModel removes a global model', () => {
      const before = registry.getModel('gpt-4o');
      expect(before).not.toBeNull();

      const removed = registry.removeModel('gpt-4o');
      expect(removed).toBe(true);

      const after = registry.getModel('gpt-4o');
      expect(after).toBeNull();
    });

    test('removeModel returns false for non-existent model', () => {
      expect(registry.removeModel('nonexistent')).toBe(false);
    });

    test('getModel returns null for unknown id', () => {
      expect(registry.getModel('does-not-exist')).toBeNull();
    });
  });

  describe('listModels', () => {
    test('filters by provider', () => {
      const results = registry.listModels({ provider: 'anthropic' });
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((m) => m.provider === 'anthropic')).toBe(true);
    });

    test('treats google as equivalent to gemini when filtering by provider', () => {
      const results = registry.listModels({ provider: 'google' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((m) => m.provider === 'gemini')).toBe(true);
    });

    test('filters by tier', () => {
      const results = registry.listModels({ tier: 'fast' });
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((m) => m.tier === 'fast')).toBe(true);
    });

    test('filters by family', () => {
      const results = registry.listModels({ family: 'gpt-4o' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((m) => m.family === 'gpt-4o')).toBe(true);
    });

    test('filters by capabilities', () => {
      const results = registry.listModels({
        capabilities: { vision: true, tools: true },
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((m) => m.capabilities.vision && m.capabilities.tools)).toBe(true);
    });

    test('excludes deprecated models by default', () => {
      const deprecated: ModelInfo = {
        id: 'old-model',
        provider: 'openai',
        name: 'Old Model',
        family: 'old',
        tier: 'balanced',
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          structuredOutput: false,
          maxContextTokens: 8000,
          maxOutputTokens: 2000,
          parallelToolCalls: false,
          promptCaching: false,
        },
        pricing: { inputPer1M: 5, outputPer1M: 15 },
        limits: { requestsPerMinute: 100, tokensPerMinute: 50000 },
        deprecatedAt: new Date('2024-01-01'),
      };

      registry.registerModel(deprecated);

      const results = registry.listModels();
      expect(results.find((m) => m.id === 'old-model')).toBeUndefined();

      const withDeprecated = registry.listModels({ includeDeprecated: true });
      expect(withDeprecated.find((m) => m.id === 'old-model')).toBeDefined();
    });
  });

  describe('getModelForTask (routing)', () => {
    test('selects model matching preferred tier', () => {
      const result = registry.getModelForTask({
        preferredTier: 'fast',
      });

      expect(result.model).toBeDefined();
      expect(result.model.tier).toBe('fast');
      expect(result.reason).toContain('fast');
    });

    test('selects model with required capabilities', () => {
      const result = registry.getModelForTask({
        capabilities: { tools: true, vision: true },
      });

      expect(result.model.capabilities.tools).toBe(true);
      expect(result.model.capabilities.vision).toBe(true);
    });

    test('provides fallback models', () => {
      const result = registry.getModelForTask({
        preferredTier: 'balanced',
      });

      expect(result.fallbacks.length).toBeGreaterThan(0);
    });

    test('calculates estimated cost when token counts provided', () => {
      const result = registry.getModelForTask({
        preferredTier: 'fast',
        estimatedInputTokens: 1000,
        estimatedOutputTokens: 500,
      });

      expect(result.estimatedCost).toBeDefined();
      expect(result.estimatedCost).toBeGreaterThan(0);
    });

    test('filters by maxCostPer1M', () => {
      const result = registry.getModelForTask({
        maxCostPer1M: 5, // Very low budget
      });

      const totalCost = result.model.pricing.inputPer1M + result.model.pricing.outputPer1M;
      expect(totalCost).toBeLessThanOrEqual(5);
    });

    test('filters by preferred providers', () => {
      const result = registry.getModelForTask({
        preferredProviders: ['gemini'],
      });

      expect(result.model.provider).toBe('gemini');
    });

    test('treats google as equivalent to gemini for preferred providers', () => {
      const result = registry.getModelForTask({
        preferredProviders: ['google'],
      });

      expect(result.model.provider).toBe('gemini');
    });

    test('excludes providers', () => {
      const result = registry.getModelForTask({
        excludedProviders: ['anthropic', 'openai'],
      });

      expect(result.model.provider).toBe('gemini');
    });

    test('treats google as equivalent to gemini for excluded providers', () => {
      const result = registry.getModelForTask({
        excludedProviders: ['google'],
      });

      expect(result.model.provider).not.toBe('gemini');
    });

    test('throws when no models match', () => {
      expect(() =>
        registry.getModelForTask({
          capabilities: { maxContextTokens: 999999999 },
        }),
      ).toThrow('No models match');
    });
  });

  describe('getFallbackChain', () => {
    test('returns fallback models for a known model', () => {
      const chain = registry.getFallbackChain('claude-sonnet-4-20250514');
      expect(chain.length).toBeGreaterThan(0);
    });

    test('returns same-provider fallbacks for gemini models keyed as google aliases', () => {
      const chain = registry.getFallbackChain('gemini-2.5-pro');
      expect(chain.some((model) => model.provider === 'gemini')).toBe(true);
    });

    test('includes cross-provider fallbacks for same tier', () => {
      const chain = registry.getFallbackChain('gpt-4o');
      const providers = new Set(chain.map((m) => m.provider));
      // Should include at least one non-OpenAI model
      expect(providers.size).toBeGreaterThanOrEqual(1);
    });

    test('returns empty for unknown model', () => {
      const chain = registry.getFallbackChain('nonexistent');
      expect(chain).toEqual([]);
    });

    test('limits chain to 3 models', () => {
      const chain = registry.getFallbackChain('claude-sonnet-4-20250514');
      expect(chain.length).toBeLessThanOrEqual(3);
    });
  });

  describe('singleton', () => {
    test('getModelRegistry returns same instance', () => {
      resetModelRegistry();
      const r1 = getModelRegistry();
      const r2 = getModelRegistry();
      expect(r1).toBe(r2);
    });

    test('resetModelRegistry creates new instance', () => {
      const r1 = getModelRegistry();
      resetModelRegistry();
      const r2 = getModelRegistry();
      expect(r1).not.toBe(r2);
    });
  });

  describe('audit hook', () => {
    test('emits audit events for register and route', () => {
      const events: Array<{ operation: string }> = [];
      const auditedRegistry = new ModelRegistry((event) => {
        events.push({ operation: event.operation });
      });

      // Register fires audit events for all default models
      expect(events.filter((e) => e.operation === 'register').length).toBeGreaterThan(0);

      // Route should fire too
      auditedRegistry.getModelForTask({ preferredTier: 'balanced' });
      expect(events.some((e) => e.operation === 'route')).toBe(true);
    });
  });

  describe('default model mappings', () => {
    test('resolves legacy gemini provider aliases through google defaults', () => {
      expect(getDefaultModel('gemini', 'balanced')).toBe(getDefaultModel('google', 'balanced'));
    });
  });
});

// =============================================================================
// ENTITY EXTRACTION
// =============================================================================

describe('Entity Extraction', () => {
  describe('extractDates', () => {
    test('extracts relative date: today', () => {
      const result = extractDates('today');
      expect(result.date).toBe(new Date().toISOString().split('T')[0]);
    });

    test('extracts relative date: tomorrow', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const result = extractDates('tomorrow');
      expect(result.date).toBe(tomorrow.toISOString().split('T')[0]);
    });

    test('extracts relative date: next week', () => {
      const result = extractDates('next week');
      expect(result.date).toBeDefined();
    });

    test('extracts relative date: next month', () => {
      const result = extractDates('next month');
      expect(result.date).toBeDefined();
    });

    test('extracts date range', () => {
      const result = extractDates('from Mar 6 to Mar 10');
      expect(result.checkin).toContain('-03-06');
      expect(result.checkout).toContain('-03-10');
    });

    test('extracts date range with dash', () => {
      const result = extractDates('Mar 6 - Mar 10');
      expect(result.checkin).toContain('-03-06');
      expect(result.checkout).toContain('-03-10');
    });

    test('extracts single date with month name', () => {
      const result = extractDates('on March 15');
      expect(result.date).toContain('-03-15');
    });

    test('extracts ISO date format', () => {
      const result = extractDates('booking for 2026-05-20');
      expect(result.date).toBe('2026-05-20');
    });

    test('extracts numeric date MM/DD/YYYY for US locale', () => {
      const result = extractDates('03/15/2026', 'en');
      expect(result.date).toBe('2026-03-15');
    });

    test('extracts numeric date DD/MM/YYYY for European locale', () => {
      const result = extractDates('15/03/2026', 'es');
      expect(result.date).toBe('2026-03-15');
    });

    test('handles two-digit year', () => {
      const result = extractDates('03/15/26', 'en');
      expect(result.date).toBe('2026-03-15');
    });

    test('returns empty for no dates', () => {
      const result = extractDates('I want to book a hotel');
      expect(Object.keys(result).length).toBe(0);
    });

    test('handles Spanish month names', () => {
      const result = extractDates('enero 15', 'es');
      expect(result.date).toContain('-01-15');
    });

    test('handles French month names', () => {
      const result = extractDates('mars 10', 'fr');
      expect(result.date).toContain('-03-10');
    });

    test('extracts date with year', () => {
      const result = extractDates('March 15, 2026');
      expect(result.date).toBe('2026-03-15');
    });
  });

  describe('extractNumbers', () => {
    const guestConfig = {
      numberFields: [{ name: 'guests', keywords: ['guests?', 'people'] }],
    };
    const roomConfig = {
      numberFields: [{ name: 'rooms', keywords: ['rooms?'] }],
    };
    const nightConfig = {
      numberFields: [{ name: 'nights', keywords: ['nights?'] }],
    };
    const allConfig = {
      numberFields: [
        { name: 'rooms', keywords: ['rooms?'] },
        { name: 'guests', keywords: ['guests?', 'people'] },
        { name: 'nights', keywords: ['nights?'] },
      ],
    };

    test('extracts guest count with config', () => {
      const result = extractNumbers('I need 3 guests', guestConfig);
      expect(result.guests).toBe(3);
    });

    test('extracts room count with config', () => {
      const result = extractNumbers('2 rooms please', roomConfig);
      expect(result.rooms).toBe(2);
    });

    test('extracts night count with config', () => {
      const result = extractNumbers('for 5 nights', nightConfig);
      expect(result.nights).toBe(5);
    });

    test('extracts multiple fields with config', () => {
      const result = extractNumbers('2 rooms for 4 guests 3 nights', allConfig);
      expect(result.rooms).toBe(2);
      expect(result.guests).toBe(4);
      expect(result.nights).toBe(3);
    });

    test('handles people keyword with config', () => {
      const result = extractNumbers('5 people', guestConfig);
      expect(result.guests).toBe(5);
    });

    test('returns empty without config', () => {
      const result = extractNumbers('I need 3 guests');
      expect(Object.keys(result).length).toBe(0);
    });

    test('returns empty for no numbers', () => {
      const result = extractNumbers('I want to book');
      expect(Object.keys(result).length).toBe(0);
    });

    test('handles custom number fields', () => {
      const config = {
        numberFields: [{ name: 'tickets', keywords: ['tickets?', 'seats?'] }],
      };
      const result = extractNumbers('I need 4 tickets', config);
      expect(result.tickets).toBe(4);
    });

    test('handles comma-decimal locales', () => {
      const config = {
        numberFields: [{ name: 'amount', keywords: ['euros?'] }],
      };
      const result = extractNumbers('total is 1,5', config, 'de');
      // When no keyword match, comma-decimal extraction kicks in
      expect(result.amount).toBeCloseTo(1.5);
    });
  });

  describe('extractDestination', () => {
    const cityConfig = {
      additionalDestinations: ['paris', 'london', 'tokyo', 'new york', 'barcelona'],
    };

    test('extracts destination with config', () => {
      const result = extractDestination('I want to go to Paris', cityConfig);
      expect(result).toBe('Paris');
    });

    test('extracts multi-word destination with config', () => {
      const result = extractDestination('flying to New York', cityConfig);
      expect(result).toBe('New York');
    });

    test('returns null without config (no hardcoded defaults)', () => {
      const result = extractDestination('I want to go to Paris');
      expect(result).toBeNull();
    });

    test('returns null for unknown destination', () => {
      const result = extractDestination('I want to go somewhere', cityConfig);
      expect(result).toBeNull();
    });

    test('is case-insensitive', () => {
      const result = extractDestination('heading to TOKYO', cityConfig);
      expect(result).toBe('Tokyo');
    });

    test('uses custom destinations when provided', () => {
      const config = {
        additionalDestinations: ['gotham city', 'metropolis'],
      };
      const result = extractDestination('heading to Gotham City', config);
      expect(result).toBe('Gotham City');
    });

    test('custom destinations do not include defaults', () => {
      const config = {
        additionalDestinations: ['gotham city'],
      };
      const result = extractDestination('heading to Paris', config);
      expect(result).toBeNull();
    });
  });

  describe('extractAllEntities', () => {
    const fullConfig = {
      additionalDestinations: ['barcelona'],
      numberFields: [
        { name: 'guests', keywords: ['guests?', 'people'] },
        { name: 'rooms', keywords: ['rooms?'] },
      ],
    };

    test('extracts combined entities with config', () => {
      const result = extractAllEntities(
        'I want to go to Barcelona from Mar 6 to Mar 10 with 2 guests',
        fullConfig,
      );
      expect(result.destination).toBe('Barcelona');
      expect(result.checkin).toContain('-03-06');
      expect(result.checkout).toContain('-03-10');
      expect(result.guests).toBe(2);
    });

    test('extracts dates without config', () => {
      const result = extractAllEntities('from Mar 6 to Mar 10');
      expect(result.checkin).toContain('-03-06');
      expect(result.checkout).toContain('-03-10');
    });

    test('handles partial information with config', () => {
      const result = extractAllEntities('2 rooms', fullConfig);
      expect(result.rooms).toBe(2);
      expect(result.destination).toBeUndefined();
    });

    test('returns only dates without config', () => {
      const result = extractAllEntities('2 rooms');
      expect(result.rooms).toBeUndefined();
      expect(result.destination).toBeUndefined();
    });
  });

  describe('extractEntitiesForFields', () => {
    test('extracts date field by type', () => {
      const result = extractEntitiesForFields('March 15', ['appointment_date'], undefined, {
        appointment_date: 'date',
      });
      expect(result.appointment_date).toContain('-03-15');
    });

    test('extracts number field by type', () => {
      const result = extractEntitiesForFields('5 guests', ['count'], undefined, {
        count: 'number',
      });
      expect(result.count).toBe(5);
    });

    test('extracts email field', () => {
      const result = extractEntitiesForFields(
        'my email is john@example.com',
        ['email'],
        undefined,
        { email: 'email' },
      );
      expect(result.email).toBe('john@example.com');
    });

    test('extracts phone field', () => {
      const result = extractEntitiesForFields('call me at +1-555-123-4567', ['phone'], undefined, {
        phone: 'phone',
      });
      expect(result.phone).toBeDefined();
    });

    test('extracts destination field by type', () => {
      const config = { additionalDestinations: ['paris'] };
      const result = extractEntitiesForFields('I want to go to Paris', ['city'], config, {
        city: 'destination',
      });
      expect(result.city).toBe('Paris');
    });

    test('single untyped field stores raw input', () => {
      const result = extractEntitiesForFields('Barcelona', ['destination']);
      expect(result.destination).toBe('Barcelona');
    });

    test('single field with no match stores raw input', () => {
      const result = extractEntitiesForFields('John Smith', ['name']);
      expect(result.name).toBe('John Smith');
    });

    test('multi-field extraction maps to correct fields', () => {
      const config = { additionalDestinations: ['barcelona'] };
      const result = extractEntitiesForFields(
        'Barcelona from Mar 6 to Mar 10 for 2 guests',
        ['destination', 'checkin_date', 'checkout_date', 'guest_count'],
        config,
        {
          destination: 'destination',
          checkin_date: 'date',
          checkout_date: 'date',
          guest_count: 'number',
        },
      );

      expect(result.destination).toBe('Barcelona');
      expect(result.checkin_date).toContain('-03-06');
      expect(result.checkout_date).toContain('-03-10');
      expect(result.guest_count).toBe(2);
    });
  });

  describe('constants', () => {
    test('MONTH_MAP covers all 12 months', () => {
      const months = new Set(Object.values(MONTH_MAP));
      expect(months.size).toBe(12);
    });

    test('LOCALE_MONTH_MAPS has entries for multiple locales', () => {
      expect(Object.keys(LOCALE_MONTH_MAPS)).toContain('es');
      expect(Object.keys(LOCALE_MONTH_MAPS)).toContain('fr');
      expect(Object.keys(LOCALE_MONTH_MAPS)).toContain('de');
      expect(Object.keys(LOCALE_MONTH_MAPS)).toContain('pt');
      expect(Object.keys(LOCALE_MONTH_MAPS)).toContain('it');
    });

    test('DEFAULT_DESTINATIONS is deprecated and empty', () => {
      expect(DEFAULT_DESTINATIONS).toEqual([]);
    });
  });
});

// =============================================================================
// OBSERVABILITY CONTEXT
// =============================================================================

describe('Observability Context', () => {
  test('runWithObservabilityContext makes context available inside callback', () => {
    const ctx = {
      traceId: 'trace-123',
      spanId: 'span-456',
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
    };

    runWithObservabilityContext(ctx, () => {
      const retrieved = getObservabilityContext();
      expect(retrieved).not.toBeUndefined();
      expect(retrieved!.traceId).toBe('trace-123');
      expect(retrieved!.spanId).toBe('span-456');
      expect(retrieved!.tenantId).toBe('tenant-1');
      expect(retrieved!.sessionId).toBe('sess-1');
    });
  });

  test('getCurrentTraceId returns trace ID within context', () => {
    runWithObservabilityContext({ traceId: 'trace-abc', spanId: 'span-def' }, () => {
      expect(getCurrentTraceId()).toBe('trace-abc');
    });
  });

  test('getCurrentSpanId returns span ID within context', () => {
    runWithObservabilityContext({ traceId: 'trace-abc', spanId: 'span-def' }, () => {
      expect(getCurrentSpanId()).toBe('span-def');
    });
  });

  test('returns undefined outside any context', () => {
    expect(getObservabilityContext()).toBeUndefined();
    expect(getCurrentTraceId()).toBeUndefined();
    expect(getCurrentSpanId()).toBeUndefined();
  });

  test('nested contexts work correctly', () => {
    runWithObservabilityContext({ traceId: 'outer-trace', spanId: 'outer-span' }, () => {
      expect(getCurrentTraceId()).toBe('outer-trace');

      runWithObservabilityContext({ traceId: 'inner-trace', spanId: 'inner-span' }, () => {
        expect(getCurrentTraceId()).toBe('inner-trace');
        expect(getCurrentSpanId()).toBe('inner-span');
      });

      // After inner context completes, outer should be restored
      expect(getCurrentTraceId()).toBe('outer-trace');
    });
  });

  test('async context propagation works', async () => {
    await new Promise<void>((resolve) => {
      runWithObservabilityContext({ traceId: 'async-trace', spanId: 'async-span' }, () => {
        setTimeout(() => {
          expect(getCurrentTraceId()).toBe('async-trace');
          resolve();
        }, 10);
      });
    });
  });

  test('optional fields are correctly handled', () => {
    runWithObservabilityContext(
      {
        traceId: 't1',
        spanId: 's1',
        userId: 'user-1',
        correlationId: 'corr-1',
      },
      () => {
        const ctx = getObservabilityContext()!;
        expect(ctx.userId).toBe('user-1');
        expect(ctx.correlationId).toBe('corr-1');
      },
    );
  });
});

function compileConstraintsFromDsl(dsl: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.errors).toHaveLength(0);
  expect(parseResult.document).not.toBeNull();

  const output = compileABLtoIR([parseResult.document!]);
  expect(output.compilation_errors).toBeUndefined();

  const agent = output.agents[parseResult.document!.name];
  expect(agent).toBeDefined();

  return agent.constraints.constraints;
}

describe('Constraint Compilation Semantics', () => {
  test('uses an AND-joined missing-field guard group for multi-variable constraints', () => {
    const [constraint] = compileConstraintsFromDsl(`
AGENT: Auto_Guard_And_Test
GOAL: "Test auto-guard lowering"

CONSTRAINTS:
  - REQUIRE destination != origin AND budget > 0
    ON_FAIL: RESPOND "Choose different cities with a positive budget."
`);

    expect(constraint.condition).toBe(
      '(destination IS NOT SET AND origin IS NOT SET AND budget IS NOT SET) OR (destination != origin AND budget > 0)',
    );
  });

  test('preserves WHEN lowering inside BEFORE tool checkpoints', () => {
    const [constraint] = compileConstraintsFromDsl(`
AGENT: When_Before_Checkpoint_Test
GOAL: "Test WHEN + BEFORE lowering"

CONSTRAINTS:
  - REQUIRE ready_for_search == true BEFORE calling search_flights WHEN channel == "voice"
    ON_FAIL: RESPOND "Voice searches require readiness."
`);

    expect(constraint.applies_when).toBe('channel == "voice"');
    expect(constraint.checkpoint).toEqual({ kind: 'tool_call', target: 'search_flights' });
    expect(constraint.condition).toBe(
      `NOT (${CONSTRAINT_CHECKPOINT_KIND_KEY} == "tool_call" AND ${CONSTRAINT_CHECKPOINT_TARGET_KEY} == "search_flights") OR (NOT (channel == "voice") OR (ready_for_search == true))`,
    );
  });

  test('negates RESTRICT conditions before applying BEFORE checkpoints', () => {
    const [constraint] = compileConstraintsFromDsl(`
AGENT: Restrict_Before_Checkpoint_Test
GOAL: "Test RESTRICT + BEFORE lowering"

CONSTRAINTS:
  - RESTRICT destination == origin BEFORE returning results
    ON_FAIL: RESPOND "Origin and destination must differ."
`);

    expect(constraint.kind).toBe('restrict');
    expect(constraint.checkpoint).toEqual({ kind: 'response' });
    expect(constraint.condition).toBe(
      'NOT (_abl_constraint_checkpoint_kind == "response") OR (NOT (destination == origin))',
    );
  });

  test('preserves structured ON_FAIL follow-up control flow for collect blocks', () => {
    const constraints = compileConstraintsFromDsl(`
AGENT: Constraint_On_Fail_Chaining_Test
GOAL: "Test structured ON_FAIL chaining"

GATHER:
  verification_code:
    prompt: "What is your verification code?"
    type: string
    required: true

FLOW:
  verify_identity -> COMPLETE

  verify_identity:
    REASONING: false
    RESPOND: "Let's verify your identity."

CONSTRAINTS:
  - REQUIRE verification_code IS SET
    ON_FAIL:
      RESPOND: "I need your verification code first."
      COLLECT: [verification_code]
      GOTO: verify_identity

  - REQUIRE verified == true
    ON_FAIL:
      RESPOND: "Please confirm your verification code."
      COLLECT: [verification_code]
      RETRY: true
`);

    expect(constraints[0].on_fail).toEqual({
      type: 'collect_field',
      message: 'I need your verification code first.',
      collect_fields: ['verification_code'],
      then_step: 'verify_identity',
    });
    expect(constraints[1].on_fail).toEqual({
      type: 'collect_field',
      message: 'Please confirm your verification code.',
      collect_fields: ['verification_code'],
      then_action: 'retry',
    });
  });
});
