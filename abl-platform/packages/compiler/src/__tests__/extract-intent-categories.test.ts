/**
 * Tests for extractIntentCategories() rewrite (Task 3)
 *
 * Validates inferred mode (WHEN extraction with matchAll) and explicit mode
 * (doc.intents from INTENTS: parser block).
 */

import { describe, test, expect } from 'vitest';
import type {
  AgentBasedDocument,
  HandoffConfig,
  IntentDefinition,
  IntentSectionConfig,
} from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import type { IntentCategory } from '../platform/ir/schema.js';

// =============================================================================
// HELPERS
// =============================================================================

/** Minimal AgentBasedDocument with overrides for handoff and intents */
function makeDoc(
  overrides: {
    handoff?: Partial<HandoffConfig>[];
    intents?: IntentDefinition[];
    intentConfig?: IntentSectionConfig;
  } = {},
): AgentBasedDocument {
  const handoffs: HandoffConfig[] = (overrides.handoff ?? []).map((h, i) => ({
    to: h.to ?? `Agent_${i}`,
    when: h.when ?? 'always',
    context: h.context ?? { pass: [], summary: 'test' },
    return: h.return ?? false,
    ...h,
  })) as HandoffConfig[];

  return {
    meta: {
      id: 'test-id',
      kind: 'supervisor',
      version: '1.0.0',
      name: 'Test_Supervisor',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    name: 'Test_Supervisor',
    goal: { description: 'Test supervisor' },
    persona: { description: 'Test persona' },
    limitations: [],
    tools: [],
    gather: [],
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: [],
    delegate: [],
    handoff: handoffs,
    complete: [],
    onError: [],
    ...(overrides.intents ? { intents: overrides.intents } : {}),
    ...(overrides.intentConfig ? { intentConfig: overrides.intentConfig } : {}),
  };
}

/** Compile a doc and return the intent categories array */
function getCategories(doc: AgentBasedDocument): IntentCategory[] {
  const result = compileABLtoIR([doc]);
  return result.agents['Test_Supervisor']?.routing?.intent_classification?.categories ?? [];
}

/** Compile a doc and return the intent classification source */
function getSource(doc: AgentBasedDocument): string | undefined {
  const result = compileABLtoIR([doc]);
  return result.agents['Test_Supervisor']?.routing?.intent_classification?.source;
}

function getLexicalFallback(doc: AgentBasedDocument): string | undefined {
  const result = compileABLtoIR([doc]);
  return result.agents['Test_Supervisor']?.routing?.intent_classification?.lexical_fallback;
}

// =============================================================================
// TESTS — INFERRED MODE
// =============================================================================

describe('extractIntentCategories — inferred mode', () => {
  test('TC-EIC-01: extracts single category from handoff WHEN', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Billing_Agent',
          when: 'intent.category == "billing"',
        },
      ],
    });
    const categories = getCategories(doc);
    const names = categories.map((c) => c.name);
    expect(names).toContain('billing');
    expect(getSource(doc)).toBe('inferred');
  });

  test('TC-EIC-02: extracts ALL categories from OR conditions (matchAll)', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Tech_Agent',
          when: 'intent.category == "device_issue" || intent.category == "troubleshooting" || intent.category == "setup"',
        },
      ],
    });
    const categories = getCategories(doc);
    const names = categories.map((c) => c.name);
    expect(names).toContain('device_issue');
    expect(names).toContain('troubleshooting');
    expect(names).toContain('setup');
  });

  test('TC-EIC-03: extracts from multiple handoff rules', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Billing_Agent',
          when: 'intent.category == "billing"',
        },
        {
          to: 'Tech_Agent',
          when: 'intent.category == "technical"',
        },
      ],
    });
    const categories = getCategories(doc);
    const names = categories.map((c) => c.name);
    expect(names).toContain('billing');
    expect(names).toContain('technical');
  });

  test('TC-EIC-04: deduplicates categories across rules', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Billing_Agent',
          when: 'intent.category == "billing"',
        },
        {
          to: 'Alt_Billing_Agent',
          when: 'intent.category == "billing" || intent.category == "refund"',
        },
      ],
    });
    const categories = getCategories(doc);
    const names = categories.map((c) => c.name);
    // "billing" should appear only once
    const billingCount = names.filter((n) => n === 'billing').length;
    expect(billingCount).toBe(1);
    expect(names).toContain('refund');
  });

  test('TC-EIC-05: includes DEFAULT_INTENT_CATEGORIES (greeting, farewell, escalation) in inferred mode', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Billing_Agent',
          when: 'intent.category == "billing"',
        },
      ],
    });
    const categories = getCategories(doc);
    const names = categories.map((c) => c.name);
    expect(names).toContain('greeting');
    expect(names).toContain('farewell');
    expect(names).toContain('escalation');
  });

  test('TC-EIC-06: inferred categories have no descriptions (undefined)', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Billing_Agent',
          when: 'intent.category == "billing"',
        },
      ],
    });
    const categories = getCategories(doc);
    for (const cat of categories) {
      expect(cat.description).toBeUndefined();
    }
  });

  test('TC-EIC-06b: extracts categories from != conditions in inferred mode', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Billing_Agent',
          when: 'intent.category == "billing"',
        },
        {
          to: 'Fallback_Agent',
          when: 'intent.category != "billing" && intent.category != "setup"',
        },
      ],
    });
    const categories = getCategories(doc);
    const names = categories.map((c) => c.name);
    expect(names).toContain('billing');
    expect(names).toContain('setup');
  });

  test('TC-EIC-07: handles handoff with no WHEN condition — still has defaults, no crash', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Fallback_Agent',
          when: '', // empty when
        },
      ],
    });
    const categories = getCategories(doc);
    const names = categories.map((c) => c.name);
    // Should still have the defaults
    expect(names).toContain('greeting');
    expect(names).toContain('farewell');
    expect(names).toContain('escalation');
    expect(names.length).toBe(3); // only defaults
  });
});

// =============================================================================
// TESTS — EXPLICIT MODE
// =============================================================================

describe('extractIntentCategories — explicit mode', () => {
  test('TC-EIC-10: uses explicit intents when doc.intents exists', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Billing_Agent',
          when: 'intent.category == "billing"',
        },
      ],
      intents: [
        { name: 'billing', description: 'Customer billing inquiries' },
        { name: 'technical', description: 'Technical support requests' },
        { name: 'sales', description: 'Sales and upsell opportunities' },
      ],
    });
    const categories = getCategories(doc);
    const names = categories.map((c) => c.name);
    expect(names).toEqual(['billing', 'technical', 'sales']);
    expect(getSource(doc)).toBe('explicit');
  });

  test('TC-EIC-11: explicit intents do NOT include defaults (greeting, farewell)', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Billing_Agent',
          when: 'intent.category == "billing"',
        },
      ],
      intents: [
        { name: 'billing', description: 'Billing inquiries' },
        { name: 'technical', description: 'Technical support' },
      ],
    });
    const categories = getCategories(doc);
    const names = categories.map((c) => c.name);
    expect(names).not.toContain('greeting');
    expect(names).not.toContain('farewell');
    expect(names).not.toContain('escalation');
    expect(names).toEqual(['billing', 'technical']);
  });

  test('TC-EIC-12: explicit intents without descriptions have undefined description', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'General_Agent',
          when: 'intent.category == "general"',
        },
      ],
      intents: [{ name: 'general' }, { name: 'specific', description: 'Has a description' }],
    });
    const categories = getCategories(doc);
    const generalCat = categories.find((c) => c.name === 'general');
    const specificCat = categories.find((c) => c.name === 'specific');
    expect(generalCat).toBeDefined();
    expect(generalCat!.description).toBeUndefined();
    expect(specificCat).toBeDefined();
    expect(specificCat!.description).toBe('Has a description');
  });

  test('TC-EIC-13: explicit lexical fallback config is preserved in routing intent classification', () => {
    const doc = makeDoc({
      handoff: [
        {
          to: 'Billing_Agent',
          when: 'intent.category == "billing"',
        },
      ],
      intents: [{ name: 'billing', description: 'Billing inquiries' }],
      intentConfig: { lexicalFallback: 'never' },
    });

    expect(getLexicalFallback(doc)).toBe('never');
  });
});
