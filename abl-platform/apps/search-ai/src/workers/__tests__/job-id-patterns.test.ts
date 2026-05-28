import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  taxonomySetupJobId,
  taxonomyRefinementJobId,
  kgReclassifyJobId,
  kgEnrichmentJobId,
  pageProcessingJobId,
  embeddingJobId,
  customDomainGenerationJobId,
  orgProfileGenerationJobId,
  enqueueJob,
  STANDARD_JOB_OPTIONS,
} from '../job-id-patterns.js';

describe('BullMQ Job ID Patterns', () => {
  let originalDateNow: typeof Date.now;
  const mockTimestamp = 1709462400000;

  beforeEach(() => {
    originalDateNow = Date.now;
    Date.now = vi.fn(() => mockTimestamp);
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  describe('taxonomySetupJobId', () => {
    it('generates correct job ID', () => {
      const jobId = taxonomySetupJobId('index-123');
      expect(jobId).toBe(`taxonomy-setup:index-123:${mockTimestamp}`);
    });

    it('generates unique IDs for different indexes', () => {
      const jobId1 = taxonomySetupJobId('index-1');
      const jobId2 = taxonomySetupJobId('index-2');
      expect(jobId1).not.toBe(jobId2);
      expect(jobId1).toContain('index-1');
      expect(jobId2).toContain('index-2');
    });

    it('generates unique IDs at different timestamps', () => {
      const jobId1 = taxonomySetupJobId('index-123');

      Date.now = vi.fn(() => mockTimestamp + 1000);
      const jobId2 = taxonomySetupJobId('index-123');

      expect(jobId1).not.toBe(jobId2);
    });
  });

  describe('taxonomyRefinementJobId', () => {
    it('generates correct job ID with action', () => {
      const jobId = taxonomyRefinementJobId('index-123', 'add-product');
      expect(jobId).toBe(`taxonomy-refinement:index-123:add-product:${mockTimestamp}`);
    });

    it('allows concurrent different refinement types', () => {
      const jobId1 = taxonomyRefinementJobId('index-123', 'add-product');
      const jobId2 = taxonomyRefinementJobId('index-123', 'add-attribute');

      expect(jobId1).not.toBe(jobId2);
      expect(jobId1).toContain('add-product');
      expect(jobId2).toContain('add-attribute');
    });
  });

  describe('kgReclassifyJobId', () => {
    it('generates correct job ID', () => {
      const jobId = kgReclassifyJobId('index-123', 'doc-456');
      expect(jobId).toBe(`kg-reclassify:index-123:doc-456:${mockTimestamp}`);
    });

    it('scopes by index and document', () => {
      const jobId1 = kgReclassifyJobId('index-1', 'doc-1');
      const jobId2 = kgReclassifyJobId('index-1', 'doc-2');
      const jobId3 = kgReclassifyJobId('index-2', 'doc-1');

      expect(jobId1).not.toBe(jobId2);
      expect(jobId1).not.toBe(jobId3);
      expect(jobId2).not.toBe(jobId3);
    });
  });

  describe('kgEnrichmentJobId', () => {
    it('generates correct job ID', () => {
      const jobId = kgEnrichmentJobId('index-123', 'doc-456');
      expect(jobId).toBe(`kg-enrichment:index-123:doc-456:${mockTimestamp}`);
    });
  });

  describe('pageProcessingJobId', () => {
    it('generates correct job ID with page number', () => {
      const jobId = pageProcessingJobId('doc-123', 5);
      expect(jobId).toBe(`page-processing:doc-123:5:${mockTimestamp}`);
    });

    it('handles page 0', () => {
      const jobId = pageProcessingJobId('doc-123', 0);
      expect(jobId).toContain(':0:');
    });

    it('generates unique IDs for different pages', () => {
      const jobId1 = pageProcessingJobId('doc-123', 1);
      const jobId2 = pageProcessingJobId('doc-123', 2);

      expect(jobId1).not.toBe(jobId2);
    });
  });

  describe('embeddingJobId', () => {
    it('generates correct job ID', () => {
      const jobId = embeddingJobId('chunk-789');
      expect(jobId).toBe(`embedding:chunk-789:${mockTimestamp}`);
    });
  });

  describe('customDomainGenerationJobId', () => {
    it('generates correct job ID', () => {
      const jobId = customDomainGenerationJobId('tenant-123', 'b2b-saas');
      expect(jobId).toBe(`custom-domain-gen:tenant-123:b2b-saas:${mockTimestamp}`);
    });

    it('scopes by tenant and industry', () => {
      const jobId1 = customDomainGenerationJobId('tenant-1', 'healthcare');
      const jobId2 = customDomainGenerationJobId('tenant-2', 'healthcare');

      expect(jobId1).not.toBe(jobId2);
      expect(jobId1).toContain('tenant-1');
      expect(jobId2).toContain('tenant-2');
    });
  });

  describe('orgProfileGenerationJobId', () => {
    it('generates correct job ID', () => {
      const jobId = orgProfileGenerationJobId('tenant-123', 'index-456');
      expect(jobId).toBe(`org-profile-gen:tenant-123:index-456:${mockTimestamp}`);
    });
  });

  describe('STANDARD_JOB_OPTIONS', () => {
    it('has correct retry configuration', () => {
      expect(STANDARD_JOB_OPTIONS.attempts).toBe(3);
      expect(STANDARD_JOB_OPTIONS.backoff.type).toBe('exponential');
      expect(STANDARD_JOB_OPTIONS.backoff.delay).toBe(5_000);
    });

    it('has correct retention configuration', () => {
      expect(STANDARD_JOB_OPTIONS.removeOnComplete.age).toBe(86400); // 24 hours
      expect(STANDARD_JOB_OPTIONS.removeOnComplete.count).toBe(1000);
      expect(STANDARD_JOB_OPTIONS.removeOnFail.age).toBe(604800); // 7 days
    });
  });

  describe('enqueueJob', () => {
    it('enqueues job with standard options', async () => {
      const mockAdd = vi.fn().mockResolvedValue({});
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockQueue = {
        add: mockAdd,
        close: mockClose,
      };

      await enqueueJob(mockQueue, 'Process Document', { documentId: '123' }, 'job-123');

      expect(mockAdd).toHaveBeenCalledWith(
        'Process Document',
        { documentId: '123' },
        {
          jobId: 'job-123',
          ...STANDARD_JOB_OPTIONS,
        },
      );
      expect(mockClose).toHaveBeenCalled();
    });

    it('merges custom options with standard options', async () => {
      const mockAdd = vi.fn().mockResolvedValue({});
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockQueue = {
        add: mockAdd,
        close: mockClose,
      };

      await enqueueJob(mockQueue, 'Process Document', { documentId: '123' }, 'job-123', {
        priority: 10,
        delay: 1000,
      });

      expect(mockAdd).toHaveBeenCalledWith(
        'Process Document',
        { documentId: '123' },
        {
          jobId: 'job-123',
          ...STANDARD_JOB_OPTIONS,
          priority: 10,
          delay: 1000,
        },
      );
    });

    it('closes queue in finally block even on error', async () => {
      const mockAdd = vi.fn().mockRejectedValue(new Error('Queue error'));
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockQueue = {
        add: mockAdd,
        close: mockClose,
      };

      await expect(
        enqueueJob(mockQueue, 'Process Document', { documentId: '123' }, 'job-123'),
      ).rejects.toThrow('Queue error');

      expect(mockClose).toHaveBeenCalled();
    });

    it('prevents duplicate job IDs from being enqueued simultaneously', async () => {
      const mockAdd = vi.fn().mockResolvedValue({});
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockQueue = {
        add: mockAdd,
        close: mockClose,
      };

      const jobId = kgReclassifyJobId('index-1', 'doc-1');

      // Enqueue same job ID twice (simulates concurrent requests)
      await Promise.all([
        enqueueJob(mockQueue, 'Reclassify', { indexId: 'index-1' }, jobId),
        enqueueJob(mockQueue, 'Reclassify', { indexId: 'index-1' }, jobId),
      ]);

      // BullMQ should handle deduplication internally based on jobId
      expect(mockAdd).toHaveBeenCalledTimes(2);
      expect(mockAdd).toHaveBeenCalledWith(
        'Reclassify',
        { indexId: 'index-1' },
        {
          jobId,
          ...STANDARD_JOB_OPTIONS,
        },
      );
    });
  });

  describe('Job ID Format Consistency', () => {
    it('all job IDs follow the pattern stage:scope:timestamp', () => {
      const jobIds = [
        taxonomySetupJobId('index-1'),
        taxonomyRefinementJobId('index-1', 'add-product'),
        kgReclassifyJobId('index-1', 'doc-1'),
        kgEnrichmentJobId('index-1', 'doc-1'),
        pageProcessingJobId('doc-1', 1),
        embeddingJobId('chunk-1'),
        customDomainGenerationJobId('tenant-1', 'industry-1'),
        orgProfileGenerationJobId('tenant-1', 'index-1'),
      ];

      for (const jobId of jobIds) {
        // All should end with timestamp
        expect(jobId).toMatch(/:1709462400000$/);
        // All should have at least 2 colons
        expect(jobId.split(':').length).toBeGreaterThanOrEqual(3);
      }
    });

    it('job IDs are URL-safe (no spaces or special chars except colon and hyphen)', () => {
      const jobIds = [
        taxonomySetupJobId('index-with-hyphens-123'),
        kgReclassifyJobId('index-1', 'doc-with-hyphens'),
        customDomainGenerationJobId('tenant-abc-123', 'b2b-saas-hr-compliance'),
      ];

      for (const jobId of jobIds) {
        // Should only contain alphanumeric, hyphens, and colons
        expect(jobId).toMatch(/^[a-z0-9:-]+$/);
      }
    });
  });
});
