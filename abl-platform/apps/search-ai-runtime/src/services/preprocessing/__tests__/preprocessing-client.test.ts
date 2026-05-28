/**
 * Tests for Preprocessing Client
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PreprocessingClient } from '../preprocessing-client.js';
import type { PreprocessingResponse } from '../types.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PreprocessingClient', () => {
  let client: PreprocessingClient;

  beforeEach(() => {
    client = new PreprocessingClient({
      baseUrl: 'http://localhost:8003',
      timeoutMs: 100,
      enabled: true,
    });
    vi.clearAllMocks();
  });

  describe('preprocess', () => {
    it('should preprocess a query successfully', async () => {
      const mockResponse: PreprocessingResponse = {
        processedQuery: 'show me documents about kubernetes',
        language: 'en',
        confidence: 0.99,
        stages: {
          spellCorrection: [
            {
              original: 'docuemnts',
              corrected: 'documents',
              confidence: 0.95,
              source: 'spellchecker',
            },
            {
              original: 'kuberntes',
              corrected: 'kubernetes',
              confidence: 0.93,
              source: 'spellchecker',
            },
          ],
          synonymExpansion: [],
          entities: [],
        },
        metadata: {
          originalQuery: 'show me docuemnts about kuberntes',
          processingTimeMs: 2.5,
          stagesExecuted: ['language_detection', 'spell_correction'],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.preprocess('show me docuemnts about kuberntes', 'tenant-123');

      expect(result.processedQuery).toBe('show me documents about kubernetes');
      expect(result.language).toBe('en');
      expect(result.stages.spellCorrection).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8003/v1/preprocess',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('should handle preprocessing service errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const result = await client.preprocess('test query', 'tenant-123');

      // Should return original query on error
      expect(result.processedQuery).toBe('test query');
      expect(result.metadata.error).toBeDefined();
      expect(result.stages.spellCorrection).toHaveLength(0);
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await client.preprocess('test query', 'tenant-123');

      // Should return original query on network error
      expect(result.processedQuery).toBe('test query');
      expect(result.metadata.error).toContain('Network error');
      expect(result.stages.spellCorrection).toHaveLength(0);
    });

    it('should return no-op response when disabled', async () => {
      const disabledClient = new PreprocessingClient({ enabled: false });

      const result = await disabledClient.preprocess('test query', 'tenant-123');

      expect(result.processedQuery).toBe('test query');
      expect(result.stages.spellCorrection).toHaveLength(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should use custom config when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          processedQuery: 'test',
          language: 'en',
          confidence: 0.99,
          stages: {
            spellCorrection: [],
            synonymExpansion: [],
            entities: [],
          },
          metadata: {
            originalQuery: 'test',
            processingTimeMs: 1,
            stagesExecuted: [],
          },
        }),
      });

      await client.preprocess('test query', 'tenant-123', {
        enableSpellCorrection: false,
        enableSynonymExpansion: true,
        maxSynonyms: 5,
      });

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);

      expect(body.config.enableSpellCorrection).toBe(false);
      expect(body.config.enableSynonymExpansion).toBe(true);
      expect(body.config.maxSynonyms).toBe(5);
    });

    it('should handle Spanish queries', async () => {
      const mockResponse: PreprocessingResponse = {
        processedQuery: 'mostrar documentos sobre despliegue de kubernetes',
        language: 'es',
        confidence: 0.99,
        stages: {
          spellCorrection: [
            {
              original: 'kuberntes',
              corrected: 'kubernetes',
              confidence: 0.93,
              source: 'spellchecker',
            },
          ],
          synonymExpansion: [],
          entities: [],
        },
        metadata: {
          originalQuery: 'mostrar documentos sobre despliegue de kuberntes',
          processingTimeMs: 3.1,
          stagesExecuted: ['language_detection', 'spell_correction'],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.preprocess(
        'mostrar documentos sobre despliegue de kuberntes',
        'tenant-123',
      );

      expect(result.language).toBe('es');
      expect(result.processedQuery).toContain('kubernetes');
    });

    it('should extract entities from queries', async () => {
      const mockResponse: PreprocessingResponse = {
        processedQuery: 'orders from 2024-01-15 with amount >= 1000',
        language: 'en',
        confidence: 0.99,
        stages: {
          spellCorrection: [],
          synonymExpansion: [],
          entities: [
            {
              text: '2024-01-15',
              type: 'date',
              value: '2024-01-15T00:00:00',
              start: 12,
              end: 22,
            },
            {
              text: '>= 1000',
              type: 'number',
              value: { operator: '>=', value: 1000 },
              start: 35,
              end: 42,
            },
          ],
        },
        metadata: {
          originalQuery: 'orders from 2024-01-15 with amount >= 1000',
          processingTimeMs: 1.8,
          stagesExecuted: ['language_detection', 'entity_extraction'],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.preprocess(
        'orders from 2024-01-15 with amount >= 1000',
        'tenant-123',
      );

      expect(result.stages.entities).toHaveLength(2);
      expect(result.stages.entities[0].type).toBe('date');
      expect(result.stages.entities[1].type).toBe('number');
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'healthy',
          service: 'preprocessing-service',
          version: '1.0.0',
        }),
      });

      const health = await client.healthCheck();

      expect(health.ok).toBe(true);
      expect(health.service).toBe('preprocessing-service');
      expect(health.version).toBe('1.0.0');
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy status on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const health = await client.healthCheck();

      expect(health.ok).toBe(false);
      expect(health.error).toContain('Network error');
    });

    it('should return ok when disabled', async () => {
      const disabledClient = new PreprocessingClient({ enabled: false });

      const health = await disabledClient.healthCheck();

      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('getSupportedLanguages', () => {
    it('should return supported languages', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          languages: {
            spellCorrection: ['en', 'es', 'de', 'fr'],
            synonymExpansion: ['en', 'es', 'de', 'fr', 'it', 'nl'],
            detection: ['en', 'es', 'de', 'fr', 'it', 'nl', 'pt', 'ru'],
          },
          total: {
            spellCorrection: 4,
            synonymExpansion: 6,
            detection: 8,
          },
        }),
      });

      const languages = await client.getSupportedLanguages();

      expect(languages).not.toBeNull();
      expect(languages?.total.spellCorrection).toBe(4);
      expect(languages?.total.synonymExpansion).toBe(6);
      expect(languages?.total.detection).toBe(8);
    });

    it('should return null on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const languages = await client.getSupportedLanguages();

      expect(languages).toBeNull();
    });

    it('should return null when disabled', async () => {
      const disabledClient = new PreprocessingClient({ enabled: false });

      const languages = await disabledClient.getSupportedLanguages();

      expect(languages).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
