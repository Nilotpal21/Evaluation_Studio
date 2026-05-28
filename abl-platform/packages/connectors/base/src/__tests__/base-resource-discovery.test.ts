/**
 * BaseResourceDiscovery Tests
 *
 * Tests shared discovery helpers: sensitivity detection, update frequency
 * calculation, and resource tree building.
 */

import { describe, it, expect } from 'vitest';
import { BaseResourceDiscovery } from '../discovery/base-resource-discovery.js';
import type {
  DiscoveredResource,
  ContentProfile,
  DiscoveryProgressCallback,
} from '../interfaces/resource-discovery.interface.js';

// Concrete implementation for testing
class TestResourceDiscovery extends BaseResourceDiscovery {
  readonly connectorType = 'test';

  async discoverResources(
    _progressCallback?: DiscoveryProgressCallback,
  ): Promise<DiscoveredResource[]> {
    return [];
  }

  async profileContent(_resourceId: string, _sampleSize?: number): Promise<ContentProfile> {
    return {
      resourceId: _resourceId,
      totalDocuments: 0,
      totalSizeBytes: 0,
      fileTypeDistribution: {},
      dateRange: { earliest: null, latest: null },
      averageDocumentSizeBytes: 0,
      updateFrequency: 'rarely',
      sensitivityIndicators: [],
      sampleDocumentCount: 0,
    };
  }

  // Expose protected methods for testing
  public testDetectSensitivity(fileNames: string[], metadata?: Record<string, unknown>): string[] {
    return this.detectSensitivity(fileNames, metadata);
  }

  public testCalculateUpdateFrequency(dates: Date[]): string {
    return this.calculateUpdateFrequency(dates);
  }

  public testBuildResourceTree(resources: DiscoveredResource[]): DiscoveredResource[] {
    return this.buildResourceTree(resources);
  }
}

describe('BaseResourceDiscovery', () => {
  const discovery = new TestResourceDiscovery();

  describe('detectSensitivity', () => {
    it('should detect PII patterns in file names', () => {
      const result = discovery.testDetectSensitivity(['ssn-records.xlsx', 'report.pdf']);
      expect(result).toContain('pii');
    });

    it('should detect financial patterns', () => {
      const result = discovery.testDetectSensitivity(['payroll-2024.xlsx', 'budget.docx']);
      expect(result).toContain('financial');
    });

    it('should detect health patterns', () => {
      const result = discovery.testDetectSensitivity(['patient-records.pdf', 'hipaa-policy.docx']);
      expect(result).toContain('health');
    });

    it('should detect multiple sensitivity categories', () => {
      const result = discovery.testDetectSensitivity([
        'ssn-data.xlsx',
        'payroll.xlsx',
        'patient-info.pdf',
      ]);
      expect(result).toContain('pii');
      expect(result).toContain('financial');
      expect(result).toContain('health');
    });

    it('should return empty array for clean file names', () => {
      const result = discovery.testDetectSensitivity([
        'readme.md',
        'architecture.pdf',
        'notes.txt',
      ]);
      expect(result).toEqual([]);
    });

    it('should detect sensitivity in metadata', () => {
      const result = discovery.testDetectSensitivity([], {
        description: 'Contains social security numbers',
      });
      expect(result).toContain('pii');
    });

    it('should be case insensitive', () => {
      const result = discovery.testDetectSensitivity(['SSN-Records.xlsx']);
      expect(result).toContain('pii');
    });
  });

  describe('calculateUpdateFrequency', () => {
    it('should return "daily" for frequently updated content', () => {
      const now = Date.now();
      const dates = Array.from(
        { length: 10 },
        (_, i) => new Date(now - i * 2 * 24 * 60 * 60 * 1000),
      );
      const result = discovery.testCalculateUpdateFrequency(dates);
      expect(result).toBe('daily');
    });

    it('should return "weekly" for moderately updated content', () => {
      const now = Date.now();
      const dates = [new Date(now - 5 * 24 * 60 * 60 * 1000)]; // 5 days ago, only 1 date
      const result = discovery.testCalculateUpdateFrequency(dates);
      expect(result).toBe('weekly');
    });

    it('should return "monthly" for infrequent updates', () => {
      const dates = [new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)]; // 60 days ago
      const result = discovery.testCalculateUpdateFrequency(dates);
      expect(result).toBe('monthly');
    });

    it('should return "rarely" for very old content', () => {
      const dates = [new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)]; // 180 days ago
      const result = discovery.testCalculateUpdateFrequency(dates);
      expect(result).toBe('rarely');
    });

    it('should return "rarely" for empty date array', () => {
      const result = discovery.testCalculateUpdateFrequency([]);
      expect(result).toBe('rarely');
    });
  });

  describe('buildResourceTree', () => {
    it('should build a tree from flat resources', () => {
      const resources: DiscoveredResource[] = [
        {
          id: 'site-1',
          name: 'Site 1',
          displayName: 'Site 1',
          url: 'https://example.com/site1',
          resourceType: 'site',
          parentId: null,
          metadata: {},
        },
        {
          id: 'drive-1',
          name: 'Documents',
          displayName: 'Documents',
          url: 'https://example.com/drive1',
          resourceType: 'drive',
          parentId: 'site-1',
          metadata: {},
        },
        {
          id: 'drive-2',
          name: 'Images',
          displayName: 'Images',
          url: 'https://example.com/drive2',
          resourceType: 'drive',
          parentId: 'site-1',
          metadata: {},
        },
      ];

      const tree = discovery.testBuildResourceTree(resources);
      expect(tree).toHaveLength(1); // One root (site)
      expect(tree[0].children).toHaveLength(2); // Two drives
      expect(tree[0].children![0].name).toBe('Documents');
      expect(tree[0].children![1].name).toBe('Images');
    });

    it('should handle resources with no parent', () => {
      const resources: DiscoveredResource[] = [
        {
          id: 'site-1',
          name: 'Site 1',
          displayName: 'Site 1',
          url: 'https://example.com',
          resourceType: 'site',
          parentId: null,
          metadata: {},
        },
        {
          id: 'site-2',
          name: 'Site 2',
          displayName: 'Site 2',
          url: 'https://example.com',
          resourceType: 'site',
          parentId: null,
          metadata: {},
        },
      ];

      const tree = discovery.testBuildResourceTree(resources);
      expect(tree).toHaveLength(2);
    });

    it('should handle empty resource list', () => {
      const tree = discovery.testBuildResourceTree([]);
      expect(tree).toHaveLength(0);
    });

    it('should handle orphaned children (parent not in list)', () => {
      const resources: DiscoveredResource[] = [
        {
          id: 'drive-1',
          name: 'Documents',
          displayName: 'Documents',
          url: 'https://example.com/drive1',
          resourceType: 'drive',
          parentId: 'missing-site',
          metadata: {},
        },
      ];

      const tree = discovery.testBuildResourceTree(resources);
      expect(tree).toHaveLength(1); // Orphan becomes root
    });
  });
});
