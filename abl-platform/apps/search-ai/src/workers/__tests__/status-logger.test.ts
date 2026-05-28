/**
 * Status Logger Tests
 *
 * Unit tests for status transition logging utilities.
 * Tests verify that the correct logger methods are called with expected arguments.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { DocumentStatus } from '@agent-platform/search-ai-sdk';

// vi.hoisted ensures mockLogger is available when vi.mock is hoisted
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
  setCorrelationId: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

import {
  logStatusTransition,
  logJobPickup,
  logJobCompletion,
  logQueueEnqueue,
} from '../status-logger.js';

describe('Status Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('logStatusTransition', () => {
    test('should log status transition with all metadata', () => {
      const timestamp = new Date('2026-02-23T12:00:00Z');

      logStatusTransition({
        documentId: 'doc-123',
        indexId: 'index-456',
        tenantId: 'tenant-789',
        fromStatus: DocumentStatus.PENDING,
        toStatus: DocumentStatus.EXTRACTING,
        worker: 'docling-extraction',
        timestamp,
        durationMs: 1500,
        metadata: {
          pageCount: 5,
          hasOCR: true,
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[status-transition][docling-extraction] doc-123: pending → extracting',
        expect.objectContaining({
          documentId: 'doc-123',
          indexId: 'index-456',
          tenantId: 'tenant-789',
          fromStatus: 'pending',
          toStatus: 'extracting',
          worker: 'docling-extraction',
          timestamp: '2026-02-23T12:00:00.000Z',
          durationMs: 1500,
          pageCount: 5,
          hasOCR: true,
        }),
      );
    });

    test('should handle string status values', () => {
      const timestamp = new Date();

      logStatusTransition({
        documentId: 'doc-123',
        indexId: 'index-456',
        tenantId: 'tenant-789',
        fromStatus: 'none',
        toStatus: DocumentStatus.PENDING,
        worker: 'crawler-ingestion',
        timestamp,
        durationMs: 0,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[status-transition][crawler-ingestion] doc-123: none → pending',
        expect.objectContaining({
          documentId: 'doc-123',
          fromStatus: 'none',
          toStatus: 'pending',
        }),
      );
    });

    test('should handle missing optional metadata', () => {
      const timestamp = new Date();

      logStatusTransition({
        documentId: 'doc-123',
        indexId: 'index-456',
        tenantId: 'tenant-789',
        fromStatus: DocumentStatus.EXTRACTING,
        toStatus: DocumentStatus.EXTRACTED,
        worker: 'docling-extraction',
        timestamp,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('[status-transition]'),
        expect.objectContaining({
          documentId: 'doc-123',
        }),
      );
    });
  });

  describe('logJobPickup', () => {
    test('should log job pickup with all details', () => {
      const timestamp = new Date('2026-02-23T12:00:00Z');

      logJobPickup({
        worker: 'embedding',
        jobId: 'job-123',
        documentId: 'doc-456',
        queueName: 'search-embedding',
        timestamp,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[job-pickup][embedding] Job picked up from queue search-embedding',
        expect.objectContaining({
          worker: 'embedding',
          jobId: 'job-123',
          documentId: 'doc-456',
          queueName: 'search-embedding',
          timestamp: '2026-02-23T12:00:00.000Z',
        }),
      );
    });

    test('should handle missing optional documentId', () => {
      const timestamp = new Date();

      logJobPickup({
        worker: 'canonical-map',
        jobId: 'job-789',
        queueName: 'search-canonical-map',
        timestamp,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('[job-pickup]'),
        expect.objectContaining({
          worker: 'canonical-map',
          jobId: 'job-789',
        }),
      );
    });
  });

  describe('logJobCompletion', () => {
    test('should log successful job completion with info', () => {
      const timestamp = new Date('2026-02-23T12:00:00Z');

      logJobCompletion({
        worker: 'page-processing',
        jobId: 'job-123',
        documentId: 'doc-456',
        status: 'completed',
        durationMs: 2500,
        timestamp,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[job-completion][page-processing] Job completed: job-123',
        expect.objectContaining({
          status: 'completed',
          durationMs: 2500,
        }),
      );
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    test('should log failed job completion with error level', () => {
      const timestamp = new Date();

      logJobCompletion({
        worker: 'embedding',
        jobId: 'job-123',
        documentId: 'doc-456',
        status: 'failed',
        durationMs: 1000,
        timestamp,
        error: 'Network timeout',
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[job-completion][embedding] Job failed: job-123',
        expect.objectContaining({
          status: 'failed',
          error: 'Network timeout',
        }),
      );
    });
  });

  describe('logQueueEnqueue', () => {
    test('should log queue enqueue operation', () => {
      const timestamp = new Date('2026-02-23T12:00:00Z');

      logQueueEnqueue({
        worker: 'docling-extraction',
        targetQueue: 'search-page-processing',
        jobId: 'page-processing:doc-123',
        documentId: 'doc-123',
        timestamp,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[queue-enqueue][docling-extraction] Enqueued job to search-page-processing',
        expect.objectContaining({
          jobId: 'page-processing:doc-123',
          documentId: 'doc-123',
        }),
      );
    });

    test('should handle missing optional documentId', () => {
      const timestamp = new Date();

      logQueueEnqueue({
        worker: 'page-processing',
        targetQueue: 'search-canonical-map',
        jobId: 'canonical-map:batch-1',
        timestamp,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('[queue-enqueue]'),
        expect.objectContaining({
          worker: 'page-processing',
          targetQueue: 'search-canonical-map',
        }),
      );
    });
  });

  describe('timestamp formatting', () => {
    test('should format timestamps as ISO strings', () => {
      const timestamp = new Date('2026-02-23T12:34:56.789Z');

      logStatusTransition({
        documentId: 'doc-123',
        indexId: 'index-456',
        tenantId: 'tenant-789',
        fromStatus: DocumentStatus.PENDING,
        toStatus: DocumentStatus.EXTRACTING,
        worker: 'test',
        timestamp,
      });

      const callArgs = mockLogger.info.mock.calls[0][1];
      expect(callArgs.timestamp).toBe('2026-02-23T12:34:56.789Z');
    });
  });
});
