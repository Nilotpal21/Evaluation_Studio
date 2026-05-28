/**
 * Tests for AnalysisCacheService
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnalysisCacheService } from '../../services/structured-data/analysis-cache.js';
import type { AnalyzeResponse } from '../../services/structured-data/ingestion-types.js';

describe('AnalysisCacheService', () => {
  let cacheService: AnalysisCacheService;
  let mockRedis: any;

  const testAnalysisId = 'test-analysis-123';
  const testTenantId = 'tenant-123';
  const testIndexId = 'index-123';

  beforeEach(() => {
    // Mock Redis client
    mockRedis = {
      setex: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
      ttl: vi.fn().mockResolvedValue(-1),
      quit: vi.fn().mockResolvedValue(undefined),
    };

    cacheService = new AnalysisCacheService(mockRedis);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('set', () => {
    it('should store analysis with compressed buffer', async () => {
      const fileBuffer = Buffer.from('test file content', 'utf-8');
      const analysis: AnalyzeResponse = {
        analysisId: testAnalysisId,
        schema: {
          tableName: 'test_table',
          rowCount: 10,
          columns: [],
          primaryKey: null,
          foreignKeys: [],
        },
        estimates: {
          embeddingTokens: 100,
          embeddingCost: 0.001,
          storageBytes: 1000,
          chunkCount: 10,
          processingTimeSeconds: 1,
        },
        quality: {
          overallConfidence: 0.9,
          warnings: [],
          recommendations: [],
        },
        expiresAt: new Date(Date.now() + 3600000),
      };

      await cacheService.set(
        testAnalysisId,
        testTenantId,
        testIndexId,
        fileBuffer,
        'test.csv',
        'text/csv',
        fileBuffer.length,
        analysis,
      );

      expect(mockRedis.setex).toHaveBeenCalledWith(
        `structured-data:analysis:${testAnalysisId}`,
        3600,
        expect.any(String),
      );
    });

    it('should compress large buffers', async () => {
      const largeBuffer = Buffer.alloc(100000, 'x');
      const analysis: AnalyzeResponse = {
        analysisId: testAnalysisId,
        schema: {
          tableName: 'test_table',
          rowCount: 1000,
          columns: [],
          primaryKey: null,
          foreignKeys: [],
        },
        estimates: {
          embeddingTokens: 1000,
          embeddingCost: 0.01,
          storageBytes: 100000,
          chunkCount: 1000,
          processingTimeSeconds: 10,
        },
        quality: {
          overallConfidence: 0.9,
          warnings: [],
          recommendations: [],
        },
        expiresAt: new Date(Date.now() + 3600000),
      };

      await cacheService.set(
        testAnalysisId,
        testTenantId,
        testIndexId,
        largeBuffer,
        'large.csv',
        'text/csv',
        largeBuffer.length,
        analysis,
      );

      expect(mockRedis.setex).toHaveBeenCalled();

      // Get the serialized data that was passed to setex
      const serializedData = mockRedis.setex.mock.calls[0][2];
      const parsed = JSON.parse(serializedData);

      // Verify buffer was compressed (should be smaller than original)
      const storedBufferSize = Buffer.from(parsed.fileBuffer).length;
      expect(storedBufferSize).toBeLessThan(largeBuffer.length);
    });
  });

  describe('get', () => {
    it('should retrieve and decompress cached analysis', async () => {
      const originalBuffer = Buffer.from('test file content', 'utf-8');
      const { promisify } = await import('util');
      const { gzip } = await import('zlib');
      const gzipAsync = promisify(gzip);
      const compressedBuffer = await gzipAsync(originalBuffer);

      // Simulate how JSON.stringify serializes a Buffer: { type: "Buffer", data: [...] }
      const cached = {
        fileBuffer: compressedBuffer,
        originalFilename: 'test.csv',
        mimeType: 'text/csv',
        fileSize: originalBuffer.length,
        analysis: {
          analysisId: testAnalysisId,
          schema: {
            tableName: 'test',
            rowCount: 10,
            columns: [],
            primaryKey: null,
            foreignKeys: [],
          },
          estimates: {
            embeddingTokens: 100,
            embeddingCost: 0.001,
            storageBytes: 1000,
            chunkCount: 10,
            processingTimeSeconds: 1,
          },
          quality: { overallConfidence: 0.9, warnings: [], recommendations: [] },
          expiresAt: new Date().toISOString(),
        },
        tenantId: testTenantId,
        indexId: testIndexId,
        cachedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(cached));

      const result = await cacheService.get(testAnalysisId);

      expect(result).not.toBeNull();
      expect(result?.fileBuffer.toString('utf-8')).toBe('test file content');
      expect(result?.originalFilename).toBe('test.csv');
      expect(result?.tenantId).toBe(testTenantId);
    });

    it('should return null if cache miss', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await cacheService.get('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete cached analysis', async () => {
      await cacheService.delete(testAnalysisId);

      expect(mockRedis.del).toHaveBeenCalledWith(`structured-data:analysis:${testAnalysisId}`);
    });
  });

  describe('exists', () => {
    it('should return true if cache exists and not expired', async () => {
      mockRedis.ttl.mockResolvedValueOnce(1800); // 30 minutes remaining

      const exists = await cacheService.exists(testAnalysisId);

      expect(exists).toBe(true);
    });

    it('should return false if cache expired', async () => {
      mockRedis.ttl.mockResolvedValueOnce(-2); // Key does not exist

      const exists = await cacheService.exists(testAnalysisId);

      expect(exists).toBe(false);
    });

    it('should return false if cache key has no TTL', async () => {
      mockRedis.ttl.mockResolvedValueOnce(-1); // Key exists but no TTL

      const exists = await cacheService.exists(testAnalysisId);

      expect(exists).toBe(false);
    });
  });

  describe('close', () => {
    it('should not close an injected Redis connection', async () => {
      await cacheService.close();

      expect(mockRedis.quit).not.toHaveBeenCalled();
    });
  });

  describe('tenant isolation', () => {
    it('should store tenant and index IDs with analysis', async () => {
      const fileBuffer = Buffer.from('test', 'utf-8');
      const analysis: AnalyzeResponse = {
        analysisId: testAnalysisId,
        schema: { tableName: 'test', rowCount: 1, columns: [], primaryKey: null, foreignKeys: [] },
        estimates: {
          embeddingTokens: 10,
          embeddingCost: 0.0001,
          storageBytes: 100,
          chunkCount: 1,
          processingTimeSeconds: 1,
        },
        quality: { overallConfidence: 0.9, warnings: [], recommendations: [] },
        expiresAt: new Date(Date.now() + 3600000),
      };

      await cacheService.set(
        testAnalysisId,
        testTenantId,
        testIndexId,
        fileBuffer,
        'test.csv',
        'text/csv',
        fileBuffer.length,
        analysis,
      );

      const serializedData = mockRedis.setex.mock.calls[0][2];
      const parsed = JSON.parse(serializedData);

      expect(parsed.tenantId).toBe(testTenantId);
      expect(parsed.indexId).toBe(testIndexId);
    });
  });
});
