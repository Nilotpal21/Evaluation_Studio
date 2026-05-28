import { describe, expect, it } from 'vitest';
import {
  getCatalogVersion,
  getCelGrammar,
  getConstructSpec,
  getCrossConstructMandatories,
  listAllConstructs,
  listCelFunctions,
  listFeasibilityChecks,
  listValidCombinations,
  lookupValidationCode,
} from '../spine.js';

describe('Knowledge Spine query API', () => {
  it('returns compiler catalog metadata and core constructs', () => {
    expect(getCatalogVersion()).toBe('1.0.0');
    expect(listAllConstructs().map((construct) => construct.name)).toEqual(
      expect.arrayContaining(['AGENT', 'HANDOFF', 'DELEGATE', 'FLOW', 'MEMORY']),
    );
  });

  it('returns construct specs case-insensitively', () => {
    const handoff = getConstructSpec('handoff');

    expect(handoff?.name).toBe('HANDOFF');
    expect(handoff?.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(['TO', 'WHEN', 'CONTEXT', 'RETURN']),
    );
    expect(getConstructSpec('ROUTING')).toBeNull();
  });

  it('lists combination and mandatory rules by construct', () => {
    expect(listValidCombinations('HANDOFF').length).toBeGreaterThan(0);
    expect(
      listValidCombinations('HANDOFF').every(
        (rule) => rule.constructA === 'HANDOFF' || rule.constructB === 'HANDOFF',
      ),
    ).toBe(true);
    expect(getCrossConstructMandatories('AGENT').length).toBeGreaterThan(0);
  });

  it('returns CEL grammar and CEL functions from compiler sources', () => {
    expect(getCelGrammar('handoff_when')).toEqual(expect.arrayContaining(['input', 'intent']));
    expect(listCelFunctions().map((fn) => fn.name)).toEqual(
      expect.arrayContaining(['LOWER', 'COALESCE']),
    );
  });

  it('looks up validation code metadata', () => {
    const metadata = lookupValidationCode('HANDOFF_ON_RETURN_WITHOUT_RETURN');

    expect(metadata).toMatchObject({
      severity: 'error',
      category: 'handoff',
    });
  });

  it('lists the v1 feasibility checks', () => {
    expect(listFeasibilityChecks().map((check) => check.name)).toEqual([
      'empty-response',
      'tool-binding',
      'voice-model-feasibility',
      'provider-allowlist',
      'memory-scope-identity',
    ]);
  });
});
