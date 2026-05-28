import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CriticalFieldDetectionService,
  JIRA_CRITICAL_FIELDS_EXAMPLES,
  SALESFORCE_CRITICAL_FIELDS_EXAMPLES,
  type CriticalField,
} from '../critical-field-detection.service.js';
import type { WorkerLLMClient } from '@agent-platform/llm';
import type { Redis } from 'ioredis';

// ─── Helper Functions ────────────────────────────────────────────────────────

const createMockLLMClient = () => {
  return {
    chat: vi.fn(),
    getModelForTier: vi.fn(),
  } as unknown as WorkerLLMClient;
};

const createMockRedis = () => {
  return {
    get: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
  } as unknown as Redis;
};

const createLLMResponse = (fields: Partial<CriticalField>[]) => {
  return JSON.stringify(
    fields.map((f) => ({
      fieldName: f.fieldName,
      category: f.category || 'identifier',
      reasoning: f.reasoning || 'Test reasoning',
      confidence: f.confidence || 0.95,
      usedFor: f.usedFor || ['display', 'filter'],
    })),
  );
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CriticalFieldDetectionService', () => {
  const tenantId = 'tenant-1';
  const projectKbId = 'kb-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('initializes with LLM client and supported connectors', () => {
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      expect(service).toBeDefined();
    });

    it('initializes with optional Redis client for caching', () => {
      const mockClient = createMockLLMClient();
      const mockRedis = createMockRedis();
      const service = new CriticalFieldDetectionService(mockClient, mockRedis);

      expect(service).toBeDefined();
    });

    it('initializes with null LLM client (no LLM available)', () => {
      const service = new CriticalFieldDetectionService(null);

      expect(service).toBeDefined();
    });
  });

  describe('detectCriticalFields', () => {
    it('returns empty result when no schema is discovered', async () => {
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      // Mock empty schema
      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([]);

      const result = await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      expect(result.totalFields).toBe(0);
      expect(result.criticalFields).toHaveLength(0);
      expect(mockClient.chat).not.toHaveBeenCalled();
    });

    it('detects critical fields using LLM for JIRA connector', async () => {
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      // Mock discovered schema
      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([
        { path: 'summary', type: 'string', label: 'Summary' },
        { path: 'status', type: 'string', enumValues: ['Open', 'In Progress', 'Closed'] },
        { path: 'priority', type: 'string', enumValues: ['High', 'Medium', 'Low'] },
        { path: 'assignee', type: 'string' },
        { path: 'created', type: 'datetime' },
      ]);

      // Mock LLM response
      (mockClient.chat as any).mockResolvedValue(
        createLLMResponse([
          {
            fieldName: 'summary',
            category: 'identifier',
            reasoning: 'Primary identifier for issues',
            confidence: 0.98,
            usedFor: ['display'],
          },
          {
            fieldName: 'status',
            category: 'workflow',
            reasoning: 'Workflow state tracking',
            confidence: 0.95,
            usedFor: ['filter', 'aggregate'],
          },
          {
            fieldName: 'priority',
            category: 'classification',
            reasoning: 'Urgency indicator',
            confidence: 0.93,
            usedFor: ['filter', 'aggregate'],
          },
        ]),
      );

      const result = await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      expect(result.totalFields).toBe(5);
      expect(result.criticalFields).toHaveLength(3);
      expect(result.criticalFields[0].fieldName).toBe('summary');
      expect(result.criticalFields[0].category).toBe('identifier');
      expect(result.criticalFields[1].fieldName).toBe('status');
      expect(result.criticalFields[1].category).toBe('workflow');
      expect(mockClient.chat).toHaveBeenCalledTimes(1);
    });

    it('detects critical fields for Salesforce connector', async () => {
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([
        { path: 'Name', type: 'string', label: 'Account Name' },
        { path: 'Status', type: 'string', enumValues: ['Open', 'Closed'] },
        { path: 'Owner', type: 'reference' },
        { path: 'Amount', type: 'currency' },
        { path: 'CloseDate', type: 'date' },
      ]);

      (mockClient.chat as any).mockResolvedValue(
        createLLMResponse([
          {
            fieldName: 'Name',
            category: 'identifier',
            reasoning: 'Primary identifier',
            confidence: 0.98,
          },
          {
            fieldName: 'Status',
            category: 'workflow',
            reasoning: 'Deal stage tracking',
            confidence: 0.95,
          },
        ]),
      );

      const result = await service.detectCriticalFields(projectKbId, tenantId, 'salesforce');

      expect(result.totalFields).toBe(5);
      expect(result.criticalFields).toHaveLength(2);
      expect(result.criticalFields[0].fieldName).toBe('Name');
      expect(mockClient.chat).toHaveBeenCalledTimes(1);
    });

    it('includes reasoning for each critical field', async () => {
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([
        { path: 'summary', type: 'string' },
        { path: 'status', type: 'string' },
      ]);

      (mockClient.chat as any).mockResolvedValue(
        createLLMResponse([
          {
            fieldName: 'summary',
            category: 'identifier',
            reasoning: 'Primary identifier for issues - used in all result displays',
            confidence: 0.98,
          },
        ]),
      );

      const result = await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      expect(result.reasoning).toHaveLength(1);
      expect(result.reasoning[0].field).toBe('summary');
      expect(result.reasoning[0].reasoning).toBe(
        'Primary identifier for issues - used in all result displays',
      );
    });

    it('handles markdown code fences in LLM response', async () => {
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([
        { path: 'summary', type: 'string' },
      ]);

      // Mock response with markdown code fence
      (mockClient.chat as any).mockResolvedValue(
        '```json\n' +
          JSON.stringify([
            {
              fieldName: 'summary',
              category: 'identifier',
              reasoning: 'Test',
              confidence: 0.95,
              usedFor: ['display'],
            },
          ]) +
          '\n```',
      );

      const result = await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      expect(result.criticalFields).toHaveLength(1);
      expect(result.criticalFields[0].fieldName).toBe('summary');
    });

    it('retries on malformed LLM response', async () => {
      vi.useFakeTimers();
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([
        { path: 'summary', type: 'string' },
      ]);

      // First call returns invalid JSON, second call succeeds
      (mockClient.chat as any)
        .mockResolvedValueOnce('This is not valid JSON')
        .mockResolvedValueOnce(
          createLLMResponse([
            {
              fieldName: 'summary',
              category: 'identifier',
              reasoning: 'Test',
            },
          ]),
        );

      const resultPromise = service.detectCriticalFields(projectKbId, tenantId, 'jira');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.criticalFields).toHaveLength(1);
      expect(mockClient.chat).toHaveBeenCalledTimes(2);
    });

    it('returns empty critical fields after max retries exceeded', async () => {
      vi.useFakeTimers();
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([
        { path: 'summary', type: 'string' },
      ]);

      // All calls return invalid JSON
      (mockClient.chat as any).mockResolvedValue('Invalid JSON');

      const resultPromise = service.detectCriticalFields(projectKbId, tenantId, 'jira');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      // Schema was loaded (totalFields=1) but LLM failed — no critical fields detected
      expect(result.totalFields).toBe(1);
      expect(result.criticalFields).toHaveLength(0);
      expect(result.reasoning).toHaveLength(0);
      expect(mockClient.chat).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('returns empty result for unsupported connector type', async () => {
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      const result = await service.detectCriticalFields(
        projectKbId,
        tenantId,
        'unsupported-connector',
      );

      expect(result.totalFields).toBe(0);
      expect(result.criticalFields).toHaveLength(0);
    });

    it('returns empty result when no LLM client is provided (null)', async () => {
      const service = new CriticalFieldDetectionService(null);

      const result = await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      expect(result.totalFields).toBe(0);
      expect(result.criticalFields).toHaveLength(0);
      expect(result.reasoning).toHaveLength(0);
    });
  });

  describe('caching', () => {
    it('returns cached result when available', async () => {
      const mockClient = createMockLLMClient();
      const mockRedis = createMockRedis();
      const service = new CriticalFieldDetectionService(mockClient, mockRedis);

      const cachedResult = {
        totalFields: 5,
        criticalFields: [
          {
            fieldName: 'summary',
            category: 'identifier',
            reasoning: 'Cached result',
            confidence: 0.98,
            usedFor: ['display'],
          },
        ],
        reasoning: [{ field: 'summary', reasoning: 'Cached result' }],
      };

      (mockRedis.get as any).mockResolvedValue(JSON.stringify(cachedResult));

      const result = await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      expect(result).toEqual(cachedResult);
      expect(mockClient.chat).not.toHaveBeenCalled();
      expect(mockRedis.get).toHaveBeenCalledWith(
        `critical-field-detection:${tenantId}:${projectKbId}`,
      );
    });

    it('caches result after LLM call', async () => {
      const mockClient = createMockLLMClient();
      const mockRedis = createMockRedis();
      const service = new CriticalFieldDetectionService(mockClient, mockRedis);

      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([
        { path: 'summary', type: 'string' },
      ]);

      (mockRedis.get as any).mockResolvedValue(null);
      (mockClient.chat as any).mockResolvedValue(
        createLLMResponse([
          {
            fieldName: 'summary',
            category: 'identifier',
            reasoning: 'Test',
          },
        ]),
      );

      await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      expect(mockRedis.setex).toHaveBeenCalledWith(
        `critical-field-detection:${tenantId}:${projectKbId}`,
        60 * 60 * 6, // 6 hours
        expect.any(String),
      );
    });

    it('handles cache errors gracefully', async () => {
      const mockClient = createMockLLMClient();
      const mockRedis = createMockRedis();
      const service = new CriticalFieldDetectionService(mockClient, mockRedis);

      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([
        { path: 'summary', type: 'string' },
      ]);

      // Redis get fails
      (mockRedis.get as any).mockRejectedValue(new Error('Redis connection error'));

      (mockClient.chat as any).mockResolvedValue(
        createLLMResponse([
          {
            fieldName: 'summary',
            category: 'identifier',
            reasoning: 'Test',
          },
        ]),
      );

      // Should not throw, should proceed with LLM call
      const result = await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      expect(result.criticalFields).toHaveLength(1);
      expect(mockClient.chat).toHaveBeenCalled();
    });

    it('can clear cache for specific project', async () => {
      const mockClient = createMockLLMClient();
      const mockRedis = createMockRedis();
      const service = new CriticalFieldDetectionService(mockClient, mockRedis);

      await service.clearCache(projectKbId, tenantId);

      expect(mockRedis.del).toHaveBeenCalledWith(
        `critical-field-detection:${tenantId}:${projectKbId}`,
      );
    });
  });

  describe('prompt building', () => {
    it('includes developer-provided examples in prompt', async () => {
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([
        { path: 'summary', type: 'string' },
      ]);

      (mockClient.chat as any).mockResolvedValue(createLLMResponse([{ fieldName: 'summary' }]));

      await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      const systemPrompt = (mockClient.chat as any).mock.calls[0][0];

      // Verify examples are included
      expect(systemPrompt).toContain('Project Management / Issue Tracking');
      expect(systemPrompt).toContain('summary');
      expect(systemPrompt).toContain('status');
      expect(systemPrompt).toContain('priority');
      expect(systemPrompt).toContain('identifier');
      expect(systemPrompt).toContain('workflow');
      expect(systemPrompt).toContain('classification');
    });

    it('includes critical field patterns in prompt', async () => {
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([
        { path: 'summary', type: 'string' },
      ]);

      (mockClient.chat as any).mockResolvedValue(createLLMResponse([{ fieldName: 'summary' }]));

      await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      const systemPrompt = (mockClient.chat as any).mock.calls[0][0];

      // Verify patterns are included
      expect(systemPrompt).toContain('title, name, summary, subject, id, key');
      expect(systemPrompt).toContain('status, state, stage, phase');
      expect(systemPrompt).toContain('type, category, priority, severity, tag, label');
    });

    it('includes discovered schema in prompt', async () => {
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue([
        { path: 'summary', type: 'string', label: 'Issue Summary' },
        {
          path: 'status',
          type: 'string',
          enumValues: ['Open', 'In Progress', 'Closed'],
        },
      ]);

      (mockClient.chat as any).mockResolvedValue(createLLMResponse([{ fieldName: 'summary' }]));

      await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      const systemPrompt = (mockClient.chat as any).mock.calls[0][0];

      // Verify schema is included
      expect(systemPrompt).toContain('summary: string ("Issue Summary")');
      expect(systemPrompt).toContain('status: string enum [Open, In Progress, Closed]');
    });
  });

  describe('PII scrubbing', () => {
    it('removes sample values as safety measure', async () => {
      const mockClient = createMockLLMClient();
      const service = new CriticalFieldDetectionService(mockClient);

      const schemaWithSamples = [
        { path: 'email', type: 'string', sampleValues: ['user@example.com'] },
        { path: 'name', type: 'string', sampleValues: ['John Doe'] },
      ];

      vi.spyOn(service as any, 'loadDiscoveredSchema').mockResolvedValue(schemaWithSamples);

      (mockClient.chat as any).mockResolvedValue(createLLMResponse([{ fieldName: 'email' }]));

      await service.detectCriticalFields(projectKbId, tenantId, 'jira');

      // Verify system prompt doesn't contain sample values
      const systemPrompt = (mockClient.chat as any).mock.calls[0][0];
      expect(systemPrompt).not.toContain('user@example.com');
      expect(systemPrompt).not.toContain('John Doe');
    });
  });

  describe('connector examples', () => {
    it('provides examples for JIRA connector', () => {
      expect(JIRA_CRITICAL_FIELDS_EXAMPLES.connectorType).toBe('jira');
      expect(JIRA_CRITICAL_FIELDS_EXAMPLES.domain).toBe('Project Management / Issue Tracking');
      expect(JIRA_CRITICAL_FIELDS_EXAMPLES.exampleCriticalFields.length).toBeGreaterThan(0);
      expect(JIRA_CRITICAL_FIELDS_EXAMPLES.criticalFieldPatterns.length).toBeGreaterThan(0);
    });

    it('provides examples for Salesforce connector', () => {
      expect(SALESFORCE_CRITICAL_FIELDS_EXAMPLES.connectorType).toBe('salesforce');
      expect(SALESFORCE_CRITICAL_FIELDS_EXAMPLES.domain).toBe('CRM / Sales & Marketing');
      expect(SALESFORCE_CRITICAL_FIELDS_EXAMPLES.exampleCriticalFields.length).toBeGreaterThan(0);
      expect(SALESFORCE_CRITICAL_FIELDS_EXAMPLES.criticalFieldPatterns.length).toBeGreaterThan(0);
    });
  });
});
