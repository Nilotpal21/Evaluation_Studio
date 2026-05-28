import { describe, it, expect } from 'vitest';

/**
 * Tests for TaxonomyLoaderService domain definition parsing.
 *
 * We test the private parse methods via parseDomainDefinition by constructing
 * a minimal service instance. Since parseDomainDefinition is private, we access
 * it via loadDomainDefinitions indirectly — but it's simpler to test the class
 * by reaching into the private method via type assertion for unit tests.
 */

import { TaxonomyLoaderService, type DomainDefinition } from '../taxonomy-loader.service.js';

function createService(): TaxonomyLoaderService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new TaxonomyLoaderService({} as any);
}

// Access the private parseDomainDefinition for direct testing
function parseDomain(
  service: TaxonomyLoaderService,
  content: string,
  filePath: string,
): DomainDefinition {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (service as any).parseDomainDefinition(content, filePath);
}

// ─── Sample Data ──────────────────────────────────────────────────────────────

const SAMPLE_JSON = JSON.stringify({
  id: 'test-domain',
  name: 'Test Domain',
  version: '1.0.0',
  categories: [{ id: 'cat1', name: 'Category 1', department: 'Dept A' }],
  products: [
    {
      id: 'prod1',
      name: 'Product 1',
      categoryId: 'cat1',
      department: 'Dept A',
      subDepartment: 'Sub A',
      disambiguationKeywords: ['keyword1'],
    },
  ],
  attributes: [
    {
      id: 'attr1',
      name: 'Attribute 1',
      dataType: 'string',
      applicableTo: ['prod1'],
      extraction: { method: 'llm', keywords: ['attr keyword'] },
    },
  ],
  departmentBoundaries: [],
});

const SAMPLE_YAML = `
id: test-domain
name: Test Domain
version: "1.0.0"
categories:
  - id: cat1
    name: Category 1
    department: Dept A
products:
  - id: prod1
    name: Product 1
    categoryId: cat1
    department: Dept A
    subDepartment: Sub A
    disambiguationKeywords:
      - keyword1
attributes:
  - id: attr1
    name: Attribute 1
    dataType: string
    applicableTo:
      - prod1
    extraction:
      method: llm
      keywords:
        - attr keyword
departmentBoundaries: []
`;

const SAMPLE_MARKDOWN = `# Domain: test-domain
- name: Test Domain
- version: 1.0.0

## Categories
- id: cat1, name: Category 1, department: Dept A

## Products
### prod1
- name: Product 1
- categoryId: cat1
- department: Dept A
- subDepartment: Sub A
- disambiguationKeywords: keyword1, keyword2

## Attributes
### attr1
- name: Attribute 1
- dataType: percentage
- applicableTo: prod1
- method: regex
- patterns: \\d+%
- keywords: rate, APR

## Department Boundaries
- product1: prod1, product2: prod1, reasoning: Same product self-reference for testing
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TaxonomyLoaderService.parseDomainDefinition', () => {
  describe('JSON parsing', () => {
    it('should parse valid JSON', () => {
      const service = createService();
      const result = parseDomain(service, SAMPLE_JSON, 'domain.json');

      expect(result.id).toBe('test-domain');
      expect(result.name).toBe('Test Domain');
      expect(result.version).toBe('1.0.0');
      expect(result.categories).toHaveLength(1);
      expect(result.products).toHaveLength(1);
      expect(result.attributes).toHaveLength(1);
    });

    it('should throw on invalid JSON', () => {
      const service = createService();
      expect(() => parseDomain(service, '{invalid', 'bad.json')).toThrow();
    });
  });

  describe('YAML parsing', () => {
    it('should parse valid YAML', () => {
      const service = createService();
      const result = parseDomain(service, SAMPLE_YAML, 'domain.yaml');

      expect(result.id).toBe('test-domain');
      expect(result.name).toBe('Test Domain');
      expect(result.version).toBe('1.0.0');
      expect(result.categories).toHaveLength(1);
      expect(result.categories[0].id).toBe('cat1');
      expect(result.products).toHaveLength(1);
      expect(result.products[0].disambiguationKeywords).toEqual(['keyword1']);
      expect(result.attributes).toHaveLength(1);
      expect(result.attributes[0].extraction.method).toBe('llm');
    });

    it('should parse .yml extension', () => {
      const service = createService();
      const result = parseDomain(service, SAMPLE_YAML, 'domain.yml');
      expect(result.id).toBe('test-domain');
    });

    it('should throw on invalid YAML', () => {
      const service = createService();
      // Tabs in YAML cause parse errors
      expect(() => parseDomain(service, ':\n\t- bad:\n\t\t- yaml', 'bad.yaml')).toThrow(/YAML/i);
    });

    it('should throw when required fields are missing', () => {
      const service = createService();
      const yamlMissingFields = `
id: test
name: Test
version: "1.0"
`;
      expect(() => parseDomain(service, yamlMissingFields, 'missing.yaml')).toThrow(
        /Missing required fields/,
      );
    });
  });

  describe('Markdown parsing', () => {
    it('should parse valid Markdown', () => {
      const service = createService();
      const result = parseDomain(service, SAMPLE_MARKDOWN, 'domain.md');

      expect(result.id).toBe('test-domain');
      expect(result.name).toBe('Test Domain');
      expect(result.version).toBe('1.0.0');
      expect(result.categories).toHaveLength(1);
      expect(result.categories[0]).toEqual({
        id: 'cat1',
        name: 'Category 1',
        department: 'Dept A',
      });
    });

    it('should parse products with disambiguationKeywords', () => {
      const service = createService();
      const result = parseDomain(service, SAMPLE_MARKDOWN, 'domain.md');

      expect(result.products).toHaveLength(1);
      expect(result.products[0].id).toBe('prod1');
      expect(result.products[0].name).toBe('Product 1');
      expect(result.products[0].categoryId).toBe('cat1');
      expect(result.products[0].disambiguationKeywords).toEqual(['keyword1', 'keyword2']);
    });

    it('should parse attributes with extraction config', () => {
      const service = createService();
      const result = parseDomain(service, SAMPLE_MARKDOWN, 'domain.md');

      expect(result.attributes).toHaveLength(1);
      const attr = result.attributes[0];
      expect(attr.id).toBe('attr1');
      expect(attr.dataType).toBe('percentage');
      expect(attr.applicableTo).toEqual(['prod1']);
      expect(attr.extraction.method).toBe('regex');
      expect(attr.extraction.patterns).toEqual(['\\d+%']);
      expect(attr.extraction.keywords).toEqual(['rate', 'APR']);
    });

    it('should parse department boundaries', () => {
      const service = createService();
      const result = parseDomain(service, SAMPLE_MARKDOWN, 'domain.md');

      expect(result.departmentBoundaries).toHaveLength(1);
      expect(result.departmentBoundaries![0].product1).toBe('prod1');
      expect(result.departmentBoundaries![0].reasoning).toContain('self-reference');
    });

    it('should parse .markdown extension', () => {
      const service = createService();
      const result = parseDomain(service, SAMPLE_MARKDOWN, 'domain.markdown');
      expect(result.id).toBe('test-domain');
    });

    it('should throw when missing Domain header', () => {
      const service = createService();
      const noHeader = `
- name: Test
- version: 1.0.0

## Categories
- id: cat1, name: Cat, department: Dept

## Products
### prod1
- name: Prod
- categoryId: cat1
- department: Dept
- subDepartment: Sub

## Attributes
### attr1
- name: Attr
- dataType: string
- applicableTo: prod1
- method: llm
- keywords: kw
`;
      expect(() => parseDomain(service, noHeader, 'no-header.md')).toThrow(
        /Missing required fields/,
      );
    });

    it('should throw when categories section is empty', () => {
      const service = createService();
      const noCats = `# Domain: test
- name: Test
- version: 1.0.0

## Categories

## Products
### prod1
- name: Prod
- categoryId: cat1
- department: D
- subDepartment: S

## Attributes
### attr1
- name: A
- dataType: string
- applicableTo: prod1
- method: llm
- keywords: k
`;
      expect(() => parseDomain(service, noCats, 'no-cats.md')).toThrow(/Missing required fields/);
    });
  });

  describe('Unsupported format', () => {
    it('should throw on unsupported extension', () => {
      const service = createService();
      expect(() => parseDomain(service, 'content', 'domain.txt')).toThrow(
        /Unsupported file format/,
      );
    });

    it('should throw on .xml extension', () => {
      const service = createService();
      expect(() => parseDomain(service, '<xml/>', 'domain.xml')).toThrow(/Unsupported file format/);
    });
  });
});
