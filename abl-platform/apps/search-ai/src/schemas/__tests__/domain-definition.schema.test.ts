import { describe, it, expect } from 'vitest';
import {
  DomainDefinitionSchema,
  validateDomainDefinition,
  safeValidateDomainDefinition,
  validateDomainConsistency,
} from '../domain-definition.schema.js';
import { ZodError } from 'zod';

describe('DomainDefinitionSchema', () => {
  /**
   * Create minimal fixture with only required fields.
   * Schema will apply defaults automatically (organizationSpecificNames, applicableTo, notApplicableTo).
   * This makes tests maintainable - when defaults change, tests adapt automatically.
   */
  const validDomainRaw = {
    name: 'b2b-saas-hr-compliance',
    version: '1.0.0',
    industry: 'B2B SaaS',
    categories: [
      {
        id: 'compliance-management',
        name: 'Compliance Management',
        department: 'Legal & Compliance',
      },
      {
        id: 'employee-training',
        name: 'Employee Training',
        department: 'Human Resources',
      },
    ],
    products: [
      {
        id: 'policy-management',
        name: 'Policy Management',
        categoryId: 'compliance-management',
        department: 'Legal & Compliance',
        subDepartment: 'Policy Administration',
        disambiguationKeywords: ['policies', 'regulations', 'governance'],
        organizationSpecificNames: ['Internal Policies', 'Company Guidelines'],
        subProducts: [
          {
            id: 'policy-authoring',
            name: 'Policy Authoring',
            disambiguationKeywords: ['create policy', 'draft policy', 'policy writing'],
          },
        ],
      },
      {
        id: 'training-modules',
        name: 'Training Modules',
        categoryId: 'employee-training',
        department: 'Human Resources',
        subDepartment: 'Learning & Development',
        disambiguationKeywords: ['courses', 'learning', 'education'],
        // organizationSpecificNames will default to []
      },
    ],
    attributes: [
      {
        id: 'policy-effective-date',
        name: 'Policy Effective Date',
        dataType: 'date' as const,
        applicableTo: ['policy-management'],
        extraction: {
          method: 'regex' as const,
          patterns: [
            '\\beffective date:\\s*(\\d{1,2}/\\d{1,2}/\\d{4})',
            '\\beffective:\\s*(\\d{1,2}/\\d{1,2}/\\d{4})',
          ],
        },
      },
      {
        id: 'training-completion-rate',
        name: 'Training Completion Rate',
        dataType: 'percentage' as const,
        applicableTo: ['training-modules'],
        extraction: {
          method: 'llm' as const,
          keywords: ['completion', 'finished', 'completed percentage'],
        },
        organizationContext: {
          typicalRange: '80-95%',
          aliases: ['Completion %', 'Finish Rate'],
        },
      },
      {
        id: 'compliance-score',
        name: 'Compliance Score',
        dataType: 'number' as const,
        // applicableTo will default to []
        // notApplicableTo will default to []
        extraction: {
          method: 'hybrid' as const,
          patterns: ['\\bcompliance score:\\s*(\\d+(?:\\.\\d+)?)'],
          keywords: ['compliance rating', 'compliance level'],
        },
      },
    ],
    departmentBoundaries: [
      {
        product1: 'policy-management',
        product2: 'training-modules',
        reasoning: 'Policies often include training requirements, causing users to confuse the two',
      },
    ],
  };

  /**
   * Parse through schema to apply defaults.
   * Tests now validate actual schema behavior, not hand-written expectations.
   */
  const validDomain = DomainDefinitionSchema.parse(validDomainRaw);

  describe('Valid domains', () => {
    it('validates a complete valid domain', () => {
      const result = validateDomainDefinition(validDomain);
      expect(result).toEqual(validDomain);
    });

    it('validates a minimal domain', () => {
      const minimal = {
        name: 'test-domain',
        version: '1.0.0',
        industry: 'Test',
        categories: [{ id: 'cat-1', name: 'Category 1', department: 'Dept 1' }],
        products: [
          {
            id: 'prod-1',
            name: 'Product 1',
            categoryId: 'cat-1',
            department: 'Dept 1',
            subDepartment: 'Sub-Dept 1',
          },
        ],
        attributes: [
          {
            id: 'attr-1',
            name: 'Attribute 1',
            dataType: 'string',
            extraction: { method: 'llm', keywords: ['test'] },
          },
        ],
      };
      const result = validateDomainDefinition(minimal);
      expect(result.name).toBe('test-domain');
      expect(result.departmentBoundaries).toEqual([]); // default
    });

    it('accepts kebab-case IDs', () => {
      const domain = {
        ...validDomain,
        categories: [{ id: 'test-category-123', name: 'Test', department: 'Dept' }],
        products: [
          {
            id: 'test-product-456',
            name: 'Product',
            categoryId: 'test-category-123',
            department: 'Dept',
            subDepartment: 'Sub',
          },
        ],
        attributes: [
          {
            id: 'test-attribute-789',
            name: 'Attribute',
            dataType: 'string',
            extraction: { method: 'llm', keywords: ['test'] },
          },
        ],
      };
      expect(() => validateDomainDefinition(domain)).not.toThrow();
    });

    it('accepts all data types', () => {
      const dataTypes = [
        'percentage',
        'currency',
        'date',
        'duration',
        'identifier',
        'string',
        'number',
      ];
      for (const dataType of dataTypes) {
        const domain = {
          ...validDomain,
          attributes: [
            {
              id: 'test-attr',
              name: 'Test Attr',
              dataType,
              applicableTo: [],
              notApplicableTo: [],
              extraction: { method: 'llm', keywords: ['test'] },
            },
          ],
        };
        expect(() => validateDomainDefinition(domain)).not.toThrow();
      }
    });

    it('accepts all extraction methods', () => {
      const methods: Array<'regex' | 'llm' | 'hybrid'> = ['regex', 'llm', 'hybrid'];
      for (const method of methods) {
        const extraction =
          method === 'regex'
            ? { method, patterns: ['\\d+'] }
            : method === 'llm'
              ? { method, keywords: ['test'] }
              : { method, patterns: ['\\d+'], keywords: ['test'] };

        const domain = {
          ...validDomain,
          attributes: [
            {
              id: 'test-attr',
              name: 'Test Attr',
              dataType: 'string',
              applicableTo: [],
              notApplicableTo: [],
              extraction,
            },
          ],
        };
        expect(() => validateDomainDefinition(domain)).not.toThrow();
      }
    });

    it('accepts up to limits', () => {
      const domain = {
        ...validDomain,
        categories: Array.from({ length: 20 }, (_, i) => ({
          id: `cat-${i}`,
          name: `Category ${i}`,
          department: 'Dept',
        })),
        products: Array.from({ length: 100 }, (_, i) => ({
          id: `prod-${i}`,
          name: `Product ${i}`,
          categoryId: 'cat-0',
          department: 'Dept',
          subDepartment: 'Sub',
          disambiguationKeywords: [],
          organizationSpecificNames: [],
        })),
        attributes: Array.from({ length: 200 }, (_, i) => ({
          id: `attr-${i}`,
          name: `Attribute ${i}`,
          dataType: 'string',
          applicableTo: [],
          notApplicableTo: [],
          extraction: { method: 'llm', keywords: ['test'] },
        })),
        departmentBoundaries: Array.from({ length: 50 }, (_, i) => ({
          product1: `prod-${i}`,
          product2: `prod-${i + 1}`,
          reasoning: 'These products are often confused by users',
        })),
      };
      expect(() => validateDomainDefinition(domain)).not.toThrow();
    });
  });

  describe('Invalid domains', () => {
    it('rejects invalid version format', () => {
      const invalid = { ...validDomain, version: '1.0' };
      expect(() => validateDomainDefinition(invalid)).toThrow(ZodError);
      expect(() => validateDomainDefinition(invalid)).toThrow('semver');
    });

    it('rejects non-kebab-case IDs', () => {
      const invalid = {
        ...validDomain,
        categories: [{ id: 'Test_Category', name: 'Test', department: 'Dept' }],
      };
      expect(() => validateDomainDefinition(invalid)).toThrow(ZodError);
      expect(() => validateDomainDefinition(invalid)).toThrow('kebab-case');
    });

    it('rejects empty categories array', () => {
      const invalid = { ...validDomain, categories: [] };
      expect(() => validateDomainDefinition(invalid)).toThrow(ZodError);
      expect(() => validateDomainDefinition(invalid)).toThrow('At least one category');
    });

    it('rejects empty products array', () => {
      const invalid = { ...validDomain, products: [] };
      expect(() => validateDomainDefinition(invalid)).toThrow(ZodError);
      expect(() => validateDomainDefinition(invalid)).toThrow('At least one product');
    });

    it('rejects empty attributes array', () => {
      const invalid = { ...validDomain, attributes: [] };
      expect(() => validateDomainDefinition(invalid)).toThrow(ZodError);
      expect(() => validateDomainDefinition(invalid)).toThrow('At least one attribute');
    });

    it('rejects too many categories (>20)', () => {
      const invalid = {
        ...validDomain,
        categories: Array.from({ length: 21 }, (_, i) => ({
          id: `cat-${i}`,
          name: `Category ${i}`,
          department: 'Dept',
        })),
      };
      expect(() => validateDomainDefinition(invalid)).toThrow(ZodError);
      expect(() => validateDomainDefinition(invalid)).toThrow('Too many categories');
    });

    it('rejects too many products (>100)', () => {
      const invalid = {
        ...validDomain,
        products: Array.from({ length: 101 }, (_, i) => ({
          id: `prod-${i}`,
          name: `Product ${i}`,
          categoryId: validDomain.categories[0].id,
          department: 'Dept',
          subDepartment: 'Sub',
          disambiguationKeywords: [],
          organizationSpecificNames: [],
        })),
      };
      expect(() => validateDomainDefinition(invalid)).toThrow(ZodError);
      expect(() => validateDomainDefinition(invalid)).toThrow('Too many products');
    });

    it('rejects too many attributes (>200)', () => {
      const invalid = {
        ...validDomain,
        attributes: Array.from({ length: 201 }, (_, i) => ({
          id: `attr-${i}`,
          name: `Attribute ${i}`,
          dataType: 'string',
          applicableTo: [],
          notApplicableTo: [],
          extraction: { method: 'llm', keywords: ['test'] },
        })),
      };
      expect(() => validateDomainDefinition(invalid)).toThrow(ZodError);
      expect(() => validateDomainDefinition(invalid)).toThrow('Too many attributes');
    });

    it('rejects invalid data type', () => {
      const invalid = {
        ...validDomain,
        attributes: [
          {
            id: 'test-attr',
            name: 'Test',
            dataType: 'invalid',
            applicableTo: [],
            notApplicableTo: [],
            extraction: { method: 'llm', keywords: ['test'] },
          },
        ],
      };
      expect(() => validateDomainDefinition(invalid)).toThrow(ZodError);
    });

    it('rejects invalid extraction method', () => {
      const invalid = {
        ...validDomain,
        attributes: [
          {
            id: 'test-attr',
            name: 'Test',
            dataType: 'string',
            applicableTo: [],
            notApplicableTo: [],
            extraction: { method: 'invalid', keywords: ['test'] },
          },
        ],
      };
      expect(() => validateDomainDefinition(invalid)).toThrow(ZodError);
    });
  });

  describe('validateDomainConsistency', () => {
    it('validates a consistent domain', () => {
      const result = validateDomainConsistency(validDomain);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('detects duplicate category IDs', () => {
      const invalid = {
        ...validDomain,
        categories: [
          { id: 'cat-1', name: 'Category 1', department: 'Dept' },
          { id: 'cat-1', name: 'Category 2', department: 'Dept' },
        ],
      };
      const result = validateDomainConsistency(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate category IDs found');
    });

    it('detects duplicate product IDs', () => {
      const invalid = {
        ...validDomain,
        products: [
          ...validDomain.products,
          { ...validDomain.products[0], name: 'Duplicate Product' },
        ],
      };
      const result = validateDomainConsistency(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Duplicate product ID'))).toBe(true);
    });

    it('detects invalid categoryId reference in product', () => {
      const invalid = {
        ...validDomain,
        products: [
          {
            id: 'test-product',
            name: 'Test Product',
            categoryId: 'non-existent-category',
            department: 'Dept',
            subDepartment: 'Sub',
            disambiguationKeywords: [],
            organizationSpecificNames: [],
          },
        ],
      };
      const result = validateDomainConsistency(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-existent category'))).toBe(true);
    });

    it('detects invalid product reference in attribute applicableTo', () => {
      const invalid = {
        ...validDomain,
        attributes: [
          {
            id: 'test-attr',
            name: 'Test',
            dataType: 'string' as const,
            applicableTo: ['non-existent-product'],
            notApplicableTo: [],
            extraction: { method: 'llm' as const, keywords: ['test'] },
          },
        ],
      };
      const result = validateDomainConsistency(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-existent product in applicableTo'))).toBe(
        true,
      );
    });

    it('detects invalid product reference in attribute notApplicableTo', () => {
      const invalid = {
        ...validDomain,
        attributes: [
          {
            id: 'test-attr',
            name: 'Test',
            dataType: 'string' as const,
            applicableTo: [],
            notApplicableTo: ['non-existent-product'],
            extraction: { method: 'llm' as const, keywords: ['test'] },
          },
        ],
      };
      const result = validateDomainConsistency(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-existent product in notApplicableTo'))).toBe(
        true,
      );
    });

    it('detects regex method without patterns', () => {
      const invalid = {
        ...validDomain,
        attributes: [
          {
            id: 'test-attr',
            name: 'Test',
            dataType: 'string' as const,
            applicableTo: [],
            notApplicableTo: [],
            extraction: { method: 'regex' as const, patterns: [] },
          },
        ],
      };
      const result = validateDomainConsistency(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('uses regex/hybrid but has no patterns'))).toBe(
        true,
      );
    });

    it('detects llm method without keywords', () => {
      const invalid = {
        ...validDomain,
        attributes: [
          {
            id: 'test-attr',
            name: 'Test',
            dataType: 'string' as const,
            applicableTo: [],
            notApplicableTo: [],
            extraction: { method: 'llm' as const, keywords: [] },
          },
        ],
      };
      const result = validateDomainConsistency(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('uses llm/hybrid but has no keywords'))).toBe(
        true,
      );
    });

    it('detects invalid product reference in department boundary', () => {
      const invalid = {
        ...validDomain,
        departmentBoundaries: [
          {
            product1: 'non-existent-1',
            product2: 'non-existent-2',
            reasoning: 'These products are often confused',
          },
        ],
      };
      const result = validateDomainConsistency(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-existent product1'))).toBe(true);
      expect(result.errors.some((e) => e.includes('non-existent product2'))).toBe(true);
    });

    it('validates sub-product IDs do not conflict with parent products', () => {
      const invalid = {
        ...validDomain,
        products: [
          ...validDomain.products,
          {
            id: 'parent-product',
            name: 'Parent Product',
            categoryId: validDomain.categories[0].id,
            department: 'Dept',
            subDepartment: 'Sub',
            disambiguationKeywords: [],
            organizationSpecificNames: [],
            subProducts: [
              {
                id: validDomain.products[0].id, // Duplicate with existing product
                name: 'Sub Product',
                disambiguationKeywords: ['sub'],
              },
            ],
          },
        ],
      };
      const result = validateDomainConsistency(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Duplicate'))).toBe(true);
    });
  });

  describe('safeValidateDomainDefinition', () => {
    it('returns success for valid domain', () => {
      const result = safeValidateDomainDefinition(validDomain);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validDomain);
      }
    });

    it('returns failure with errors for invalid domain', () => {
      const invalid = { ...validDomain, version: '1.0' };
      const result = safeValidateDomainDefinition(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThan(0);
        expect(result.error.issues[0].message).toContain('semver');
      }
    });
  });
});
