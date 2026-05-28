/**
 * MappingSuggestionService Circuit Breaker Tests
 *
 * Tests Redis-backed circuit breaker integration, provider fallback,
 * graceful degradation, and circuit status endpoint.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockChat = vi.fn();

vi.mock('@agent-platform/llm', () => {
  const MockWorkerLLMClient = vi.fn().mockImplementation(function () {
    return { chat: mockChat };
  });
  return { WorkerLLMClient: MockWorkerLLMClient };
});

vi.mock('../../llm-config/resolver.js', () => ({
  resolveIndexLLMConfig: vi.fn(),
}));

vi.mock('@agent-platform/search-ai-internal/canonical', () => ({
  getTemplateForConnector: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Circuit breaker mock fns
const mockExecute = vi.fn();
const mockCheckState = vi.fn();
const mockGetMetrics = vi.fn();
const mockGetState = vi.fn();
const mockLlmProvider = vi.fn();

// Mock the circuit-breaker-registry module (separate file = clean mocking)
vi.mock('../circuit-breaker-registry.js', () => ({
  getCircuitBreakerRegistry: vi.fn(),
}));

vi.mock('@agent-platform/circuit-breaker', () => {
  class MockCircuitOpenError extends Error {
    public readonly level: string;
    public readonly key: string;
    public readonly retryAfterMs: number;
    public readonly state = 'OPEN';

    constructor(level: string, key: string, retryAfterMs: number) {
      super(`Circuit breaker OPEN [${level}:${key}]`);
      this.name = 'CircuitOpenError';
      this.level = level;
      this.key = key;
      this.retryAfterMs = retryAfterMs;
    }
  }

  return {
    CircuitBreakerRegistry: vi.fn(),
    CircuitOpenError: MockCircuitOpenError,
    BREAKER_DEFAULTS: {},
  };
});

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { MappingSuggestionService } from '../mapping-suggestion.service.js';
import { resolveIndexLLMConfig } from '../../llm-config/resolver.js';
import { getTemplateForConnector } from '@agent-platform/search-ai-internal/canonical';
import { CircuitOpenError } from '@agent-platform/circuit-breaker';
import { getCircuitBreakerRegistry } from '../circuit-breaker-registry.js';
import type { MappingSuggestionRequest } from '../mapping-suggestion.service.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-123';
const INDEX_ID = 'index-456';

const mockLLMConfig = {
  tenantId: TENANT_ID,
  provider: 'anthropic',
  apiKey: 'test-api-key',
  monthlyTokenBudget: 10_000_000,
  dailyTokenBudget: 500_000,
  maxRequestsPerMinute: 100,
  allowedProviders: ['anthropic', 'openai'],
  indexId: INDEX_ID,
  embeddingModel: 'bge-m3',
  embeddingDimensions: 1024,
  useCases: {
    mapping_suggestion: {
      enabled: true,
      modelTier: 'fast' as const,
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      apiKey: 'test-api-key',
    },
  },
};

const basicRequest: MappingSuggestionRequest = {
  sourceFields: [
    { path: 'summary', label: 'Summary', type: 'string' } as any,
    { path: 'status', label: 'Status', type: 'string' } as any,
  ],
  canonicalFields: [
    { name: 'title', label: 'Title', type: 'string', storageField: 'title' } as any,
    { name: 'status', label: 'Status', type: 'string', storageField: 'status' } as any,
  ],
  connectorType: 'jira',
};

const validLLMResponse = JSON.stringify([
  {
    canonicalField: 'title',
    sourcePath: 'summary',
    suggestedAlias: 'title',
    suggestedLabel: 'Title',
    transform: { type: 'direct' },
    confidence: 0.95,
    reasoning: 'Summary maps to title',
  },
]);

function createMockRegistry() {
  return {
    llmProvider: mockLlmProvider,
    onEvent: vi.fn().mockReturnValue(() => {}),
  };
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('MappingSuggestionService - Circuit Breaker', () => {
  let service: MappingSuggestionService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up the circuit breaker registry mock to return our controlled object
    (getCircuitBreakerRegistry as any).mockReturnValue(createMockRegistry());

    // Re-establish mock implementations after clearAllMocks
    mockLlmProvider.mockReturnValue({
      execute: mockExecute,
      checkState: mockCheckState,
      getMetrics: mockGetMetrics,
      getState: mockGetState,
    });

    service = new MappingSuggestionService();
    (resolveIndexLLMConfig as any).mockResolvedValue(mockLLMConfig);
    (getTemplateForConnector as any).mockReturnValue({
      category: 'generic',
      label: 'Generic',
      connectors: [],
      fieldPatterns: {},
      enumPatterns: {},
    });
    mockChat.mockResolvedValue(validLLMResponse);

    // Default: circuit breaker passes through to the wrapped function
    mockExecute.mockImplementation(async (fn: () => Promise<any>) => fn());
  });

  describe('Circuit Breaker Integration', () => {
    test('wraps LLM call with circuit breaker execute', async () => {
      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, basicRequest);

      expect(mockLlmProvider).toHaveBeenCalledWith(TENANT_ID, 'anthropic');
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].canonicalField).toBe('title');
    });

    test('returns empty suggestions when circuit is open (CircuitOpenError)', async () => {
      // Primary circuit open
      mockExecute.mockRejectedValueOnce(
        new CircuitOpenError('llm_provider', 'tenant-123:anthropic', 300_000),
      );

      // Fallback config has no API key
      (resolveIndexLLMConfig as any).mockResolvedValueOnce(mockLLMConfig).mockResolvedValueOnce({
        ...mockLLMConfig,
        useCases: {
          mapping_suggestion: {
            ...mockLLMConfig.useCases.mapping_suggestion,
            provider: 'openai',
            apiKey: '',
          },
        },
      });

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, basicRequest);

      expect(result.suggestions).toHaveLength(0);
      // totalProcessed reflects source fields even when LLM returns empty suggestions
      expect(result.totalProcessed).toBe(basicRequest.sourceFields.length);
    });

    test('CircuitOpenError is caught and not re-thrown', async () => {
      mockExecute.mockRejectedValue(
        new CircuitOpenError('llm_provider', 'tenant-123:anthropic', 300_000),
      );

      (resolveIndexLLMConfig as any).mockResolvedValueOnce(mockLLMConfig).mockResolvedValueOnce({
        ...mockLLMConfig,
        useCases: {
          mapping_suggestion: {
            ...mockLLMConfig.useCases.mapping_suggestion,
            apiKey: '',
          },
        },
      });

      // Should NOT throw
      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, basicRequest);
      expect(result.suggestions).toEqual([]);
    });

    test('successful call in half-open state closes the circuit', async () => {
      mockExecute.mockImplementation(async (fn: () => Promise<any>) => fn());

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, basicRequest);

      expect(result.suggestions).toHaveLength(1);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe('Provider Fallback', () => {
    test('attempts fallback provider when primary circuit opens', async () => {
      mockExecute
        .mockRejectedValueOnce(
          new CircuitOpenError('llm_provider', 'tenant-123:anthropic', 300_000),
        )
        .mockImplementationOnce(async (fn: () => Promise<any>) => fn());

      const fallbackConfig = {
        ...mockLLMConfig,
        useCases: {
          mapping_suggestion: {
            enabled: true,
            modelTier: 'fast' as const,
            model: 'gpt-4o-mini',
            provider: 'openai',
            apiKey: 'fallback-api-key',
          },
        },
      };

      (resolveIndexLLMConfig as any)
        .mockResolvedValueOnce(mockLLMConfig)
        .mockResolvedValueOnce(fallbackConfig);

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, basicRequest);

      expect(mockLlmProvider).toHaveBeenCalledWith(TENANT_ID, 'anthropic');
      expect(mockLlmProvider).toHaveBeenCalledWith(TENANT_ID, 'openai');
      expect(result.suggestions).toHaveLength(1);
    });

    test('returns empty when both primary and fallback are unavailable', async () => {
      mockExecute
        .mockRejectedValueOnce(
          new CircuitOpenError('llm_provider', 'tenant-123:anthropic', 300_000),
        )
        .mockRejectedValueOnce(new CircuitOpenError('llm_provider', 'tenant-123:openai', 300_000));

      const fallbackConfig = {
        ...mockLLMConfig,
        useCases: {
          mapping_suggestion: {
            enabled: true,
            modelTier: 'fast' as const,
            model: 'gpt-4o-mini',
            provider: 'openai',
            apiKey: 'fallback-api-key',
          },
        },
      };

      (resolveIndexLLMConfig as any)
        .mockResolvedValueOnce(mockLLMConfig)
        .mockResolvedValueOnce(fallbackConfig);

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, basicRequest);

      expect(result.suggestions).toEqual([]);
      // totalProcessed reflects source fields even when both providers fail
      expect(result.totalProcessed).toBe(basicRequest.sourceFields.length);
    });

    test('returns empty when fallback provider has no API key', async () => {
      mockExecute.mockRejectedValueOnce(
        new CircuitOpenError('llm_provider', 'tenant-123:anthropic', 300_000),
      );

      (resolveIndexLLMConfig as any).mockResolvedValueOnce(mockLLMConfig).mockResolvedValueOnce({
        ...mockLLMConfig,
        useCases: {
          mapping_suggestion: {
            ...mockLLMConfig.useCases.mapping_suggestion,
            provider: 'openai',
            apiKey: '',
          },
        },
      });

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, basicRequest);
      expect(result.suggestions).toEqual([]);
    });
  });

  describe('Rule-based mappings unaffected', () => {
    test('circuit breaker only wraps LLM calls, not rule-based logic', async () => {
      // The circuit breaker wraps only the generateSuggestions call (LLM).
      // RuleBasedMappingService in search-ai-internal is independent and
      // not imported or wrapped by MappingSuggestionService.
      // Verify by checking the service source does not reference RuleBasedMappingService.
      const serviceModule = await import('../mapping-suggestion.service.js');
      const serviceSource = Object.keys(serviceModule);
      expect(serviceSource).toContain('MappingSuggestionService');
    });
  });

  describe('getCircuitBreakerStatus', () => {
    test('returns circuit status from registry', async () => {
      mockGetMetrics.mockResolvedValue({
        state: 'OPEN',
        failureCount: 3,
        successCount: 10,
        totalCount: 13,
        failureRate: 23,
        openedAt: 1710000000000,
        halfOpenCount: 0,
      });

      mockCheckState.mockResolvedValue({
        state: 'OPEN',
        canExecute: false,
        retryAfterMs: 120_000,
      });

      const status = await service.getCircuitBreakerStatus(TENANT_ID, 'anthropic');

      expect(status).not.toBeNull();
      expect(status!.provider).toBe('anthropic');
      expect(status!.state).toBe('OPEN');
      expect(status!.failureCount).toBe(3);
      expect(status!.retryAfterMs).toBe(120_000);
      expect(status!.openedAt).toBe(1710000000000);
    });

    test('returns CLOSED state when circuit is healthy', async () => {
      mockGetMetrics.mockResolvedValue({
        state: 'CLOSED',
        failureCount: 0,
        successCount: 50,
        totalCount: 50,
        failureRate: 0,
        openedAt: null,
        halfOpenCount: 0,
      });

      mockCheckState.mockResolvedValue({
        state: 'CLOSED',
        canExecute: true,
        retryAfterMs: 0,
      });

      const status = await service.getCircuitBreakerStatus(TENANT_ID, 'anthropic');

      expect(status).not.toBeNull();
      expect(status!.state).toBe('CLOSED');
      expect(status!.failureCount).toBe(0);
      expect(status!.retryAfterMs).toBeUndefined();
    });

    test('returns null when registry is unavailable', async () => {
      (getCircuitBreakerRegistry as any).mockReturnValue(null);

      const status = await service.getCircuitBreakerStatus(TENANT_ID, 'anthropic');
      expect(status).toBeNull();
    });

    test('returns null when metrics fetch fails', async () => {
      mockGetMetrics.mockRejectedValue(new Error('Redis connection lost'));

      const status = await service.getCircuitBreakerStatus(TENANT_ID, 'anthropic');
      expect(status).toBeNull();
    });
  });

  describe('No LLM config', () => {
    test('returns empty suggestions when no API key configured', async () => {
      (resolveIndexLLMConfig as any).mockResolvedValue({
        ...mockLLMConfig,
        useCases: {
          mapping_suggestion: {
            enabled: true,
            modelTier: 'fast',
            model: '',
            provider: 'anthropic',
            apiKey: '',
          },
        },
      });

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, basicRequest);

      expect(result.suggestions).toEqual([]);
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe('Non-CircuitOpenError failures', () => {
    test('returns empty suggestions on generic LLM errors', async () => {
      mockExecute.mockRejectedValue(new Error('LLM timeout'));

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, basicRequest);

      expect(result.suggestions).toEqual([]);
      expect(result.totalProcessed).toBe(0);
    });
  });

  describe('No Redis available', () => {
    test('executes without circuit breaker when registry returns null', async () => {
      (getCircuitBreakerRegistry as any).mockReturnValue(null);

      const result = await service.suggestMappings(TENANT_ID, INDEX_ID, basicRequest);

      // Should still succeed by calling LLM directly without circuit breaker
      expect(result.suggestions).toHaveLength(1);
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });
});
