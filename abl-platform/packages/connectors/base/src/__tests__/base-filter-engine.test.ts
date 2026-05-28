/**
 * BaseFilterEngine Tests
 *
 * Tests common filter logic (date, size, file extension, advanced filters)
 * with the new structured FilterConfig schema.
 */

import { describe, it, expect } from 'vitest';
import { BaseFilterEngine } from '../filters/base-filter-engine.js';
import type { FilterConfig } from '../interfaces/filter-engine.interface.js';
import type { SourceDocument } from '../interfaces/sync-coordinator.interface.js';

// Concrete implementation for testing
class TestFilterEngine extends BaseFilterEngine {
  constructor(config: FilterConfig) {
    super(config, 'test');
  }
}

/** Build a FilterConfig with sensible defaults, overriding specific fields. */
function createConfig(
  overrides: {
    maxFileSizeBytes?: number | null;
    minFileSizeBytes?: number | null;
    modifiedAfter?: Date | null;
    modifiedBefore?: Date | null;
    createdAfter?: Date | null;
    createdBefore?: Date | null;
    fileExtensions?: { mode: 'allowlist' | 'denylist'; extensions: string[] } | null;
    contentCategories?: string[];
    advancedEnabled?: boolean;
  } = {},
): FilterConfig {
  return {
    standard: {
      contentCategories: overrides.contentCategories ?? [],
      fileExtensions: overrides.fileExtensions ?? null,
      maxFileSizeBytes: overrides.maxFileSizeBytes ?? null,
      minFileSizeBytes: overrides.minFileSizeBytes ?? null,
      modifiedAfter: overrides.modifiedAfter ?? null,
      modifiedBefore: overrides.modifiedBefore ?? null,
      createdAfter: overrides.createdAfter ?? null,
      createdBefore: overrides.createdBefore ?? null,
    },
    scope: {},
    advancedFilters: {
      enabled: overrides.advancedEnabled ?? false,
      rootOperator: 'AND',
      conditions: [],
      groups: [],
    },
    version: 1,
  };
}

describe('BaseFilterEngine', () => {
  const createDocument = (overrides: Partial<SourceDocument> = {}): SourceDocument => ({
    id: 'doc-123',
    name: 'test.pdf',
    url: 'https://example.com/test.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    modifiedAt: new Date('2024-01-15'),
    createdAt: new Date('2024-01-01'),
    content: null,
    metadata: {},
    ...overrides,
  });

  describe('File Extension Filtering', () => {
    it('should allow PDF files with default connector extensions', () => {
      const engine = new TestFilterEngine(createConfig());
      const doc = createDocument({ name: 'report.pdf' });
      // 'test' connector has no defaults, so all extensions are allowed
      expect(engine.evaluate(doc).include).toBe(true);
    });

    it('should block executables via platform denylist', () => {
      const engine = new TestFilterEngine(createConfig());
      const doc = createDocument({ name: 'malware.exe' });
      const result = engine.evaluate(doc);
      expect(result.include).toBe(false);
      expect(result.reason).toContain('platform security policy');
    });

    it('should filter by user allowlist', () => {
      const engine = new TestFilterEngine(
        createConfig({
          fileExtensions: { mode: 'allowlist', extensions: ['pdf', 'docx'] },
        }),
      );

      expect(engine.evaluate(createDocument({ name: 'report.pdf' })).include).toBe(true);
      expect(engine.evaluate(createDocument({ name: 'doc.docx' })).include).toBe(true);
      expect(engine.evaluate(createDocument({ name: 'image.png' })).include).toBe(false);
    });

    it('should filter by user denylist', () => {
      const engine = new TestFilterEngine(
        createConfig({
          fileExtensions: { mode: 'denylist', extensions: ['zip', 'rar'] },
        }),
      );

      expect(engine.evaluate(createDocument({ name: 'report.pdf' })).include).toBe(true);
      expect(engine.evaluate(createDocument({ name: 'archive.zip' })).include).toBe(false);
    });
  });

  describe('Size Filtering', () => {
    it('should filter by minimum size', () => {
      const engine = new TestFilterEngine(createConfig({ minFileSizeBytes: 1024 }));

      expect(engine.evaluate(createDocument({ sizeBytes: 2048 })).include).toBe(true);
      expect(engine.evaluate(createDocument({ sizeBytes: 1024 })).include).toBe(true);
      expect(engine.evaluate(createDocument({ sizeBytes: 512 })).include).toBe(false);
    });

    it('should filter by maximum size', () => {
      const engine = new TestFilterEngine(createConfig({ maxFileSizeBytes: 10240 }));

      expect(engine.evaluate(createDocument({ sizeBytes: 5120 })).include).toBe(true);
      expect(engine.evaluate(createDocument({ sizeBytes: 10240 })).include).toBe(true);
      expect(engine.evaluate(createDocument({ sizeBytes: 20480 })).include).toBe(false);
    });

    it('should filter by size range', () => {
      const engine = new TestFilterEngine(
        createConfig({ minFileSizeBytes: 1024, maxFileSizeBytes: 10240 }),
      );

      expect(engine.evaluate(createDocument({ sizeBytes: 512 })).include).toBe(false);
      expect(engine.evaluate(createDocument({ sizeBytes: 5120 })).include).toBe(true);
      expect(engine.evaluate(createDocument({ sizeBytes: 20480 })).include).toBe(false);
    });
  });

  describe('Date Filtering', () => {
    it('should filter by modifiedAfter date', () => {
      const engine = new TestFilterEngine(createConfig({ modifiedAfter: new Date('2024-01-10') }));

      expect(engine.evaluate(createDocument({ modifiedAt: new Date('2024-01-15') })).include).toBe(
        true,
      );
      expect(engine.evaluate(createDocument({ modifiedAt: new Date('2024-01-10') })).include).toBe(
        true,
      );
      expect(engine.evaluate(createDocument({ modifiedAt: new Date('2024-01-05') })).include).toBe(
        false,
      );
    });

    it('should filter by date range', () => {
      const engine = new TestFilterEngine(
        createConfig({
          modifiedAfter: new Date('2024-01-10'),
          modifiedBefore: new Date('2024-01-20'),
        }),
      );

      expect(engine.evaluate(createDocument({ modifiedAt: new Date('2024-01-05') })).include).toBe(
        false,
      );
      expect(engine.evaluate(createDocument({ modifiedAt: new Date('2024-01-15') })).include).toBe(
        true,
      );
      expect(engine.evaluate(createDocument({ modifiedAt: new Date('2024-01-25') })).include).toBe(
        false,
      );
    });
  });

  describe('Combined Filters', () => {
    it('should apply all filters (AND logic)', () => {
      const engine = new TestFilterEngine(
        createConfig({
          fileExtensions: { mode: 'allowlist', extensions: ['pdf'] },
          minFileSizeBytes: 1024,
          modifiedAfter: new Date('2024-01-10'),
        }),
      );

      // All filters pass
      const validDoc = createDocument({
        name: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        modifiedAt: new Date('2024-01-15'),
      });
      expect(engine.evaluate(validDoc).include).toBe(true);

      // Extension fails
      const invalidExtension = createDocument({
        name: 'image.png',
        contentType: 'image/png',
        sizeBytes: 2048,
        modifiedAt: new Date('2024-01-15'),
      });
      expect(engine.evaluate(invalidExtension).include).toBe(false);

      // Size fails
      const invalidSize = createDocument({
        name: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 512,
        modifiedAt: new Date('2024-01-15'),
      });
      expect(engine.evaluate(invalidSize).include).toBe(false);

      // Date fails
      const invalidDate = createDocument({
        name: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        modifiedAt: new Date('2024-01-05'),
      });
      expect(engine.evaluate(invalidDate).include).toBe(false);
    });
  });

  describe('No Filters', () => {
    it('should include all documents when no filters configured', () => {
      const engine = new TestFilterEngine(createConfig());

      expect(engine.evaluate(createDocument({ name: 'report.pdf' })).include).toBe(true);
      expect(engine.evaluate(createDocument({ name: 'doc.txt' })).include).toBe(true);
      expect(engine.evaluate(createDocument({ sizeBytes: 100 })).include).toBe(true);
      expect(engine.evaluate(createDocument({ sizeBytes: 1000000 })).include).toBe(true);
    });
  });

  describe('Validation', () => {
    it('should validate filter configuration', () => {
      // Invalid: minSize > maxSize
      const invalidSizeRange = new TestFilterEngine(
        createConfig({ minFileSizeBytes: 10240, maxFileSizeBytes: 1024 }),
      );
      const result1 = invalidSizeRange.validate();
      expect(result1.valid).toBe(false);
      expect(result1.errors.length).toBeGreaterThan(0);

      // Invalid: modifiedAfter > modifiedBefore
      const invalidDateRange = new TestFilterEngine(
        createConfig({
          modifiedAfter: new Date('2024-01-20'),
          modifiedBefore: new Date('2024-01-10'),
        }),
      );
      const result2 = invalidDateRange.validate();
      expect(result2.valid).toBe(false);
      expect(result2.errors.length).toBeGreaterThan(0);

      // Valid configuration
      const validEngine = new TestFilterEngine(
        createConfig({
          minFileSizeBytes: 1024,
          maxFileSizeBytes: 10240,
          modifiedAfter: new Date('2024-01-10'),
          modifiedBefore: new Date('2024-01-20'),
        }),
      );
      const result3 = validEngine.validate();
      expect(result3.valid).toBe(true);
      expect(result3.errors).toHaveLength(0);
    });
  });

  describe('Statistics', () => {
    it('should track filter statistics', () => {
      const engine = new TestFilterEngine(createConfig({ maxFileSizeBytes: 5000 }));

      engine.evaluate(createDocument({ sizeBytes: 1000 })); // included
      engine.evaluate(createDocument({ sizeBytes: 10000 })); // excluded
      engine.evaluate(createDocument({ sizeBytes: 2000 })); // included

      const stats = engine.getStatistics();
      expect(stats.totalEvaluations).toBe(3);
      expect(stats.included).toBe(2);
      expect(stats.excluded).toBe(1);
    });

    it('should reset statistics', () => {
      const engine = new TestFilterEngine(createConfig());
      engine.evaluate(createDocument());
      engine.resetStatistics();

      const stats = engine.getStatistics();
      expect(stats.totalEvaluations).toBe(0);
      expect(stats.included).toBe(0);
      expect(stats.excluded).toBe(0);
    });
  });
});
