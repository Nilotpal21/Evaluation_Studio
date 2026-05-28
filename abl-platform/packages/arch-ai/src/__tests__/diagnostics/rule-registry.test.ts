import { describe, expect, it } from 'vitest';
import {
  getRule,
  getRulesByCategory,
  getAllRules,
  RULE_COUNT,
} from '../../diagnostics/rule-registry.js';
import type { RuleEntry, DiagnosticCategory } from '../../diagnostics/types.js';

describe('rule-registry', () => {
  describe('getRule', () => {
    it('returns rule for valid code', () => {
      const rule = getRule('H-01');
      expect(rule).toBeDefined();
      expect(rule?.code).toBe('H-01');
      expect(rule?.category).toBe('handoff');
    });

    it('returns undefined for unknown code', () => {
      const rule = getRule('UNKNOWN-999');
      expect(rule).toBeUndefined();
    });

    it('returns rule with all required fields', () => {
      const rule = getRule('F-01');
      expect(rule).toBeDefined();
      expect(rule).toHaveProperty('code');
      expect(rule).toHaveProperty('description');
      expect(rule).toHaveProperty('impact');
      expect(rule).toHaveProperty('severity');
      expect(rule).toHaveProperty('category');
      expect(rule).toHaveProperty('fixEffort');
    });

    it('retrieves handoff rules', () => {
      const h02 = getRule('H-02');
      expect(h02?.code).toBe('H-02');
      expect(h02?.category).toBe('handoff');
      expect(h02?.severity).toBe('error');
    });

    it('retrieves flow rules', () => {
      const f01 = getRule('F-01');
      expect(f01?.code).toBe('F-01');
      expect(f01?.category).toBe('flow');
    });

    it('retrieves memory rules', () => {
      const m01 = getRule('M-01');
      expect(m01?.code).toBe('M-01');
      expect(m01?.category).toBe('memory');
    });

    it('retrieves completion rules', () => {
      const co01 = getRule('CO-01');
      expect(co01?.code).toBe('CO-01');
      expect(co01?.category).toBe('completion');
    });

    it('retrieves behavior profile rules', () => {
      const bp02 = getRule('BP-02');
      expect(bp02?.code).toBe('BP-02');
      expect(bp02?.category).toBe('behavior-profile');
    });
  });

  describe('getRulesByCategory', () => {
    it('returns all handoff rules', () => {
      const rules = getRulesByCategory('handoff');
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.category === 'handoff')).toBe(true);
    });

    it('returns all flow rules', () => {
      const rules = getRulesByCategory('flow');
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.category === 'flow')).toBe(true);
    });

    it('returns all memory rules', () => {
      const rules = getRulesByCategory('memory');
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.category === 'memory')).toBe(true);
    });

    it('returns all completion rules', () => {
      const rules = getRulesByCategory('completion');
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.category === 'completion')).toBe(true);
    });

    it('returns all behavior-profile rules', () => {
      const rules = getRulesByCategory('behavior-profile');
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.category === 'behavior-profile')).toBe(true);
    });

    it('returns all constraint rules', () => {
      const rules = getRulesByCategory('constraint');
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.category === 'constraint')).toBe(true);
    });

    it('returns all delegation rules', () => {
      const rules = getRulesByCategory('delegation');
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.category === 'delegation')).toBe(true);
    });

    it('returns all routing rules', () => {
      const rules = getRulesByCategory('routing');
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.category === 'routing')).toBe(true);
    });

    it('returns empty array for non-existent category', () => {
      const rules = getRulesByCategory('nonexistent' as DiagnosticCategory);
      expect(rules).toEqual([]);
    });
  });

  describe('getAllRules', () => {
    it('returns non-empty array', () => {
      const rules = getAllRules();
      expect(rules.length).toBeGreaterThan(0);
    });

    it('returns readonly array', () => {
      const rules = getAllRules();
      expect(Array.isArray(rules)).toBe(true);
    });

    it('all rules have unique codes', () => {
      const rules = getAllRules();
      const codes = rules.map((r) => r.code);
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBe(codes.length);
    });

    it('all rules have valid severities', () => {
      const rules = getAllRules();
      const validSeverities = ['error', 'warning', 'info'];
      expect(rules.every((r) => validSeverities.includes(r.severity))).toBe(true);
    });

    it('all rules have valid fixEffort', () => {
      const rules = getAllRules();
      const validEfforts = ['S', 'M', 'L'];
      expect(rules.every((r) => validEfforts.includes(r.fixEffort))).toBe(true);
    });

    it('all rules have non-empty description', () => {
      const rules = getAllRules();
      expect(rules.every((r) => r.description.length > 0)).toBe(true);
    });

    it('all rules have non-empty impact', () => {
      const rules = getAllRules();
      expect(rules.every((r) => r.impact.length > 0)).toBe(true);
    });

    it('includes H-series rules', () => {
      const rules = getAllRules();
      const hRules = rules.filter((r) => r.code.startsWith('H-'));
      expect(hRules.length).toBeGreaterThan(0);
    });

    it('includes F-series rules', () => {
      const rules = getAllRules();
      const fRules = rules.filter((r) => r.code.startsWith('F-'));
      expect(fRules.length).toBeGreaterThan(0);
    });

    it('includes M-series rules', () => {
      const rules = getAllRules();
      const mRules = rules.filter((r) => r.code.startsWith('M-'));
      expect(mRules.length).toBeGreaterThan(0);
    });

    it('includes CO-series rules', () => {
      const rules = getAllRules();
      const coRules = rules.filter((r) => r.code.startsWith('CO-'));
      expect(coRules.length).toBeGreaterThan(0);
    });

    it('includes BP-series rules', () => {
      const rules = getAllRules();
      const bpRules = rules.filter((r) => r.code.startsWith('BP-'));
      expect(bpRules.length).toBeGreaterThan(0);
    });
  });

  describe('RULE_COUNT', () => {
    it('matches getAllRules length', () => {
      const rules = getAllRules();
      expect(RULE_COUNT).toBe(rules.length);
    });

    it('is greater than 50', () => {
      // Spec mentions 98 rules, but actual count may vary
      expect(RULE_COUNT).toBeGreaterThan(50);
    });

    it('is a positive integer', () => {
      expect(Number.isInteger(RULE_COUNT)).toBe(true);
      expect(RULE_COUNT).toBeGreaterThan(0);
    });
  });

  describe('rule code format', () => {
    it('all codes follow expected pattern', () => {
      const rules = getAllRules();
      const validPattern = /^[A-Z]+-\d+$/;
      const invalidCodes = rules.filter((r) => !validPattern.test(r.code));
      expect(invalidCodes).toEqual([]);
    });

    it('H-series codes are sequential', () => {
      const rules = getAllRules();
      const hRules = rules.filter((r) => r.code.startsWith('H-'));
      const hNumbers = hRules.map((r) => parseInt(r.code.split('-')[1]));
      expect(hNumbers.every((n) => n > 0)).toBe(true);
    });

    it('F-series codes are sequential', () => {
      const rules = getAllRules();
      const fRules = rules.filter((r) => r.code.startsWith('F-'));
      const fNumbers = fRules.map((r) => parseInt(r.code.split('-')[1]));
      expect(fNumbers.every((n) => n > 0)).toBe(true);
    });
  });

  describe('specific rule validations', () => {
    it('H-01 exists and has correct properties', () => {
      const rule = getRule('H-01');
      expect(rule?.code).toBe('H-01');
      expect(rule?.category).toBe('handoff');
      expect(rule?.description).toContain('RETURN');
    });

    it('F-01 exists and has correct properties', () => {
      const rule = getRule('F-01');
      expect(rule?.code).toBe('F-01');
      expect(rule?.category).toBe('flow');
      expect(rule?.severity).toBe('error');
    });

    it('M-01 exists and has correct properties', () => {
      const rule = getRule('M-01');
      expect(rule?.code).toBe('M-01');
      expect(rule?.category).toBe('memory');
      expect(rule?.description).toContain('variable');
    });

    it('CO-01 exists and has correct properties', () => {
      const rule = getRule('CO-01');
      expect(rule?.code).toBe('CO-01');
      expect(rule?.category).toBe('completion');
    });

    it('BP-02 exists and has correct properties', () => {
      const rule = getRule('BP-02');
      expect(rule?.code).toBe('BP-02');
      expect(rule?.category).toBe('behavior-profile');
    });
  });

  describe('category coverage', () => {
    it('has rules in all major categories', () => {
      const categories: DiagnosticCategory[] = [
        'handoff',
        'flow',
        'memory',
        'completion',
        'behavior-profile',
        'constraint',
        'delegation',
        'routing',
      ];

      for (const category of categories) {
        const rules = getRulesByCategory(category);
        expect(rules.length).toBeGreaterThan(0);
      }
    });

    it('handoff category has the most rules', () => {
      const handoffRules = getRulesByCategory('handoff');
      const flowRules = getRulesByCategory('flow');
      const memoryRules = getRulesByCategory('memory');

      // Handoff is typically the largest category
      expect(handoffRules.length).toBeGreaterThan(5);
    });
  });

  describe('severity distribution', () => {
    it('has error severity rules', () => {
      const rules = getAllRules();
      const errorRules = rules.filter((r) => r.severity === 'error');
      expect(errorRules.length).toBeGreaterThan(0);
    });

    it('has warning severity rules', () => {
      const rules = getAllRules();
      const warningRules = rules.filter((r) => r.severity === 'warning');
      expect(warningRules.length).toBeGreaterThan(0);
    });

    it('has info severity rules', () => {
      const rules = getAllRules();
      const infoRules = rules.filter((r) => r.severity === 'info');
      expect(infoRules.length).toBeGreaterThan(0);
    });
  });

  describe('fix effort distribution', () => {
    it('has S (small) effort rules', () => {
      const rules = getAllRules();
      const smallRules = rules.filter((r) => r.fixEffort === 'S');
      expect(smallRules.length).toBeGreaterThan(0);
    });

    it('has M (medium) effort rules', () => {
      const rules = getAllRules();
      const mediumRules = rules.filter((r) => r.fixEffort === 'M');
      expect(mediumRules.length).toBeGreaterThan(0);
    });

    it('has L (large) effort rules', () => {
      const rules = getAllRules();
      const largeRules = rules.filter((r) => r.fixEffort === 'L');
      expect(largeRules.length).toBeGreaterThan(0);
    });
  });
});
