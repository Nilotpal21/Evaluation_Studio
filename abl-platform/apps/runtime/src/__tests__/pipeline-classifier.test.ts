/**
 * Tests for pipeline classifier — pure function tests (no LLM mocking).
 */

import { describe, it, expect } from 'vitest';
import {
  checkKeywordVeto,
  shouldShortCircuit,
  buildKnownCategorySet,
  parseClassifierResponse,
} from '../services/pipeline/classifier.js';
import type { ClassifierResult, PipelineConfig } from '../services/pipeline/types.js';
import { DEFAULT_PIPELINE_CONFIG } from '../services/pipeline/types.js';

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return { ...DEFAULT_PIPELINE_CONFIG, ...overrides };
}

describe('checkKeywordVeto', () => {
  it('returns empty array when no keywords match', () => {
    const result = checkKeywordVeto('hello how are you', ['check_balance', 'get_details'], []);
    expect(result).toEqual([]);
  });

  it('matches tool name parts in user message', () => {
    const result = checkKeywordVeto(
      'I want a refund please',
      ['process_refund', 'check_balance'],
      [],
    );
    expect(result).toContain('refund');
  });

  it('matches config keywords', () => {
    const result = checkKeywordVeto(
      'please cancel my subscription',
      ['check_balance'],
      ['cancel', 'refund'],
    );
    expect(result).toContain('cancel');
    expect(result).not.toContain('refund');
  });

  it('is case-insensitive', () => {
    const result = checkKeywordVeto('CANCEL my order', ['process_order'], ['cancel']);
    expect(result).toContain('cancel');
  });

  it('uses word boundaries (no partial matches)', () => {
    const result = checkKeywordVeto('I need to reformat my data', ['format_data'], []);
    // "format" should match (it's a word boundary), but "reformat" contains "format" as substring
    // The regex uses word boundaries, so "format" appears in "reformat" — let's verify
    // Actually \bformat\b will NOT match "reformat" because there's no word boundary before "format" in "reformat"
    expect(result).not.toContain('format');
  });

  it('skips short tool name parts (< 3 chars)', () => {
    const result = checkKeywordVeto('I need to do something', ['do_it'], []);
    // "do" and "it" are < 3 chars, should be skipped
    expect(result).toEqual([]);
  });
});

describe('shouldShortCircuit', () => {
  const config = makeConfig({ enabled: true });

  it('returns true for single high-confidence intent with category', () => {
    const result: ClassifierResult = {
      intents: [{ category: 'billing', confidence: 0.95, summary: 'billing question' }],
    };
    const { shortCircuit } = shouldShortCircuit(result, 'what is my balance', [], config);
    expect(shortCircuit).toBe(true);
  });

  it('returns false for low confidence', () => {
    const result: ClassifierResult = {
      intents: [{ category: 'billing', confidence: 0.5, summary: 'maybe billing' }],
    };
    const { shortCircuit } = shouldShortCircuit(result, 'help me', [], config);
    expect(shortCircuit).toBe(false);
  });

  it('returns false when category is null', () => {
    const result: ClassifierResult = {
      intents: [{ category: null, confidence: 0.95, summary: 'general help' }],
    };
    const { shortCircuit } = shouldShortCircuit(result, 'help', [], config);
    expect(shortCircuit).toBe(false);
  });

  it('returns false for multi-intent (2+ intents)', () => {
    const result: ClassifierResult = {
      intents: [
        { category: 'billing', confidence: 0.95, summary: 'billing' },
        { category: 'tech_support', confidence: 0.9, summary: 'tech' },
      ],
    };
    const { shortCircuit } = shouldShortCircuit(result, 'billing and tech help', [], config);
    expect(shortCircuit).toBe(false);
  });

  it('returns false when short-circuit is disabled in config', () => {
    const result: ClassifierResult = {
      intents: [{ category: 'billing', confidence: 0.99, summary: 'billing' }],
    };
    const disabledConfig = makeConfig({
      enabled: true,
      shortCircuit: { enabled: false, confidenceThreshold: 0.85 },
    });
    const { shortCircuit } = shouldShortCircuit(result, 'balance', [], disabledConfig);
    expect(shortCircuit).toBe(false);
  });

  it('keyword veto prevents short-circuit', () => {
    const result: ClassifierResult = {
      intents: [{ category: 'billing', confidence: 0.95, summary: 'refund request' }],
    };
    const { shortCircuit, vetoKeywords } = shouldShortCircuit(
      result,
      'I want a refund',
      ['process_refund'],
      config,
    );
    expect(shortCircuit).toBe(false);
    expect(vetoKeywords).toContain('refund');
  });

  it('keyword veto disabled allows short-circuit', () => {
    const result: ClassifierResult = {
      intents: [{ category: 'billing', confidence: 0.95, summary: 'refund request' }],
    };
    const noVetoConfig = makeConfig({
      enabled: true,
      keywordVeto: { enabled: false, keywords: [] },
    });
    const { shortCircuit } = shouldShortCircuit(
      result,
      'I want a refund',
      ['process_refund'],
      noVetoConfig,
    );
    expect(shortCircuit).toBe(true);
  });

  it('uses configurable confidence threshold', () => {
    const result: ClassifierResult = {
      intents: [{ category: 'billing', confidence: 0.8, summary: 'billing' }],
    };
    const lowThresholdConfig = makeConfig({
      enabled: true,
      shortCircuit: { enabled: true, confidenceThreshold: 0.7 },
    });
    const { shortCircuit } = shouldShortCircuit(result, 'balance', [], lowThresholdConfig);
    expect(shortCircuit).toBe(true);
  });
});

describe('parseClassifierResponse', () => {
  const knownCategories = buildKnownCategorySet([
    { name: 'device_issue' },
    { name: 'billing' },
    { name: 'account' },
  ]);

  it('drops intents with hallucinated categories not in known set', () => {
    const raw = JSON.stringify({
      intents: [
        { category: 'greeting', confidence: 0.9, summary: 'User greets the agent' },
        {
          category: 'device_issue',
          confidence: 0.95,
          summary: 'User reports a problem with their MacBook Pro',
        },
      ],
    });
    const result = parseClassifierResponse(raw, knownCategories);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].category).toBe('device_issue');
    expect(result.intents[0].confidence).toBe(0.95);
  });

  it('keeps intents where classifier explicitly returned null category', () => {
    const raw = JSON.stringify({
      intents: [
        { category: null, confidence: 0.85, summary: 'What can you help with?' },
        { category: 'billing', confidence: 0.7, summary: 'Check my bill' },
      ],
    });
    const result = parseClassifierResponse(raw, knownCategories);
    expect(result.intents).toHaveLength(2);
    expect(result.intents[0].category).toBeNull();
    expect(result.intents[1].category).toBe('billing');
  });

  it('returns fallback when all intents are hallucinated', () => {
    const raw = JSON.stringify({
      intents: [
        { category: 'greeting', confidence: 0.9, summary: 'Hello' },
        { category: 'chitchat', confidence: 0.8, summary: 'Small talk' },
      ],
    });
    const result = parseClassifierResponse(raw, knownCategories);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].category).toBeNull();
    expect(result.intents[0].summary).toBe('unknown');
  });

  it('preserves out_of_scope flag on valid intents', () => {
    const raw = JSON.stringify({
      intents: [
        {
          category: 'device_issue',
          confidence: 0.95,
          summary: 'MacBook issue',
          out_of_scope: false,
        },
      ],
    });
    const result = parseClassifierResponse(raw, knownCategories);
    expect(result.intents[0].out_of_scope).toBe(false);
  });

  it('parses top-level relationship for multi-intent classifier responses', () => {
    const raw = JSON.stringify({
      relationship: 'dependent',
      intents: [
        { category: 'device_issue', confidence: 0.91, summary: 'Find the device issue' },
        { category: 'billing', confidence: 0.89, summary: 'Explain its billing impact' },
      ],
    });

    const result = parseClassifierResponse(raw, knownCategories);

    expect(result.relationship).toEqual({
      type: 'dependent',
      reasoning: 'classifier relationship field',
    });
  });

  it('parses object relationship reasoning when the classifier provides it', () => {
    const raw = JSON.stringify({
      relationship: {
        type: 'independent',
        reasoning: 'Both requests can be answered separately',
      },
      intents: [
        { category: 'device_issue', confidence: 0.91, summary: 'Troubleshoot laptop' },
        { category: 'billing', confidence: 0.89, summary: 'Check invoice' },
      ],
    });

    const result = parseClassifierResponse(raw, knownCategories);

    expect(result.relationship).toEqual({
      type: 'independent',
      reasoning: 'Both requests can be answered separately',
    });
  });

  it('clamps confidence to 0-1 range', () => {
    const raw = JSON.stringify({
      intents: [{ category: 'billing', confidence: 1.5, summary: 'overconfident' }],
    });
    const result = parseClassifierResponse(raw, knownCategories);
    expect(result.intents[0].confidence).toBe(1);
  });
});
