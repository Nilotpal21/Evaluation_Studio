import { describe, it, expect } from 'vitest';
import {
  validateOrgProfile,
  safeValidateOrgProfile,
  OrgProfileSchema,
} from '../org-profile.schema.js';
import { ZodError } from 'zod';

describe('OrgProfileSchema', () => {
  const validProfile = {
    organizationName: 'Acme Financial Services',
    industry: 'Financial Services',
    keyTerms: ['credit score', 'underwriting', 'loan origination', 'risk assessment', 'compliance'],
    acronyms: {
      APR: 'Annual Percentage Rate',
      DTI: 'Debt-to-Income Ratio',
      FICO: 'Fair Isaac Corporation Score',
      LTV: 'Loan-to-Value Ratio',
    },
    departmentBoundaries: [
      {
        product1: 'credit-cards',
        product2: 'personal-loans',
        reasoning: 'Both are unsecured lending products; users often compare interest rates',
      },
    ],
    productSpecificNames: {
      'credit-cards': ['Charge Cards', 'Plastics', 'Payment Cards'],
      'savings-accounts': ['High-Yield Accounts', 'Interest Accounts'],
    },
  };

  describe('Valid profiles', () => {
    it('validates a complete valid profile', () => {
      const result = validateOrgProfile(validProfile);
      expect(result).toEqual(validProfile);
    });

    it('validates a minimal profile', () => {
      const minimal = {
        organizationName: 'Test Org',
        industry: 'Technology',
        keyTerms: ['API'],
        acronyms: {},
      };
      const result = validateOrgProfile(minimal);
      expect(result.organizationName).toBe('Test Org');
      expect(result.departmentBoundaries).toEqual([]); // default
      expect(result.productSpecificNames).toEqual({}); // default
    });

    it('accepts up to 20 key terms', () => {
      const profile = {
        ...validProfile,
        keyTerms: Array.from({ length: 20 }, (_, i) => `term-${i}`),
      };
      expect(() => validateOrgProfile(profile)).not.toThrow();
    });

    it('accepts up to 50 acronyms', () => {
      const profile = {
        ...validProfile,
        acronyms: Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [`AC${i}`, `Acronym ${i}`]),
        ),
      };
      expect(() => validateOrgProfile(profile)).not.toThrow();
    });

    it('accepts up to 50 department boundaries', () => {
      const profile = {
        ...validProfile,
        departmentBoundaries: Array.from({ length: 50 }, (_, i) => ({
          product1: `product-${i}`,
          product2: `product-${i + 1}`,
          reasoning: 'These products are often confused by users',
        })),
      };
      expect(() => validateOrgProfile(profile)).not.toThrow();
    });
  });

  describe('Invalid profiles', () => {
    it('rejects missing organizationName', () => {
      const invalid = { ...validProfile, organizationName: '' };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
    });

    it('rejects missing industry', () => {
      const invalid = { ...validProfile, industry: '' };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
    });

    it('rejects empty keyTerms array', () => {
      const invalid = { ...validProfile, keyTerms: [] };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
      expect(() => validateOrgProfile(invalid)).toThrow('At least one key term is required');
    });

    it('rejects too many key terms (>20)', () => {
      const invalid = {
        ...validProfile,
        keyTerms: Array.from({ length: 21 }, (_, i) => `term-${i}`),
      };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
      expect(() => validateOrgProfile(invalid)).toThrow('Too many key terms');
    });

    it('rejects key terms that are too long (>50 chars)', () => {
      const invalid = { ...validProfile, keyTerms: ['a'.repeat(51)] };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
      expect(() => validateOrgProfile(invalid)).toThrow('Key term too long');
    });

    it('rejects organizationName that is too long (>200 chars)', () => {
      const invalid = { ...validProfile, organizationName: 'a'.repeat(201) };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
      expect(() => validateOrgProfile(invalid)).toThrow('too long');
    });

    it('rejects acronyms that are too long (>10 chars)', () => {
      const invalid = { ...validProfile, acronyms: { TOOLONGACRO: 'Too Long Acronym' } };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
      expect(() => validateOrgProfile(invalid)).toThrow('too long');
    });

    it('rejects too many acronyms (>50)', () => {
      const invalid = {
        ...validProfile,
        acronyms: Object.fromEntries(
          Array.from({ length: 51 }, (_, i) => [`AC${i}`, `Acronym ${i}`]),
        ),
      };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
      expect(() => validateOrgProfile(invalid)).toThrow('Too many acronyms');
    });

    it('rejects too many department boundaries (>50)', () => {
      const invalid = {
        ...validProfile,
        departmentBoundaries: Array.from({ length: 51 }, (_, i) => ({
          product1: `product-${i}`,
          product2: `product-${i + 1}`,
          reasoning: 'These products are often confused',
        })),
      };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
      expect(() => validateOrgProfile(invalid)).toThrow('Too many department boundaries');
    });

    it('rejects department boundary with short reasoning (<10 chars)', () => {
      const invalid = {
        ...validProfile,
        departmentBoundaries: [
          {
            product1: 'credit-cards',
            product2: 'personal-loans',
            reasoning: 'short',
          },
        ],
      };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
      expect(() => validateOrgProfile(invalid)).toThrow('Reasoning must be descriptive');
    });

    it('rejects department boundary with long reasoning (>500 chars)', () => {
      const invalid = {
        ...validProfile,
        departmentBoundaries: [
          {
            product1: 'credit-cards',
            product2: 'personal-loans',
            reasoning: 'a'.repeat(501),
          },
        ],
      };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
      expect(() => validateOrgProfile(invalid)).toThrow('Reasoning too long');
    });

    it('rejects too many product-specific names per product (>10)', () => {
      const invalid = {
        ...validProfile,
        productSpecificNames: {
          'credit-cards': Array.from({ length: 11 }, (_, i) => `name-${i}`),
        },
      };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
      expect(() => validateOrgProfile(invalid)).toThrow('Too many names per product');
    });

    it('rejects too many products in productSpecificNames (>100)', () => {
      const invalid = {
        ...validProfile,
        productSpecificNames: Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`product-${i}`, ['name']]),
        ),
      };
      expect(() => validateOrgProfile(invalid)).toThrow(ZodError);
      expect(() => validateOrgProfile(invalid)).toThrow('Too many products');
    });
  });

  describe('safeValidateOrgProfile', () => {
    it('returns success for valid profile', () => {
      const result = safeValidateOrgProfile(validProfile);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validProfile);
      }
    });

    it('returns failure with errors for invalid profile', () => {
      const invalid = { ...validProfile, keyTerms: [] };
      const result = safeValidateOrgProfile(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThan(0);
        expect(result.error.issues[0].message).toContain('At least one key term is required');
      }
    });

    it('returns error path for nested validation failures', () => {
      const invalid = {
        ...validProfile,
        departmentBoundaries: [
          {
            product1: 'credit-cards',
            product2: 'personal-loans',
            reasoning: 'short', // Too short
          },
        ],
      };
      const result = safeValidateOrgProfile(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        const error = result.error.issues[0];
        expect(error.path).toContain('departmentBoundaries');
        expect(error.path).toContain('reasoning');
      }
    });
  });

  describe('Edge cases', () => {
    it('handles empty acronyms object', () => {
      const profile = { ...validProfile, acronyms: {} };
      expect(() => validateOrgProfile(profile)).not.toThrow();
    });

    it('handles missing optional fields', () => {
      const profile = {
        organizationName: 'Test',
        industry: 'Tech',
        keyTerms: ['API'],
        acronyms: {},
      };
      const result = validateOrgProfile(profile);
      expect(result.departmentBoundaries).toEqual([]);
      expect(result.productSpecificNames).toEqual({});
    });

    it('trims and validates string lengths correctly', () => {
      const profile = {
        ...validProfile,
        organizationName: 'a'.repeat(200), // Exactly at limit
      };
      expect(() => validateOrgProfile(profile)).not.toThrow();
    });

    it('validates special characters in strings', () => {
      const profile = {
        ...validProfile,
        organizationName: 'Acme & Co. (Financial)',
        keyTerms: ['credit-score', 'loan/debt', 'risk@assessment'],
      };
      expect(() => validateOrgProfile(profile)).not.toThrow();
    });
  });
});
