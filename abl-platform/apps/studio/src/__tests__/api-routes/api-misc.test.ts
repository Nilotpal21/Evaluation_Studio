/**
 * Tests for remaining API clients:
 * - Deployments (apps/studio/src/api/deployments.ts)
 * - Channels (apps/studio/src/api/channels.ts)
 * - Versions (apps/studio/src/api/versions.ts)
 * - Runtime Agents (apps/studio/src/api/runtime-agents.ts)
 * - Usage (apps/studio/src/api/usage.ts)
 * - SearchAI (apps/studio/src/api/search-ai.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockClearAuth = vi.fn();
const mockSetTokens = vi.fn();

vi.mock('../../store/auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: 'test-access-token',
      tenantId: 'test-tenant-id',
      clearAuth: mockClearAuth,
      setTokens: mockSetTokens,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

const savedWindow = globalThis.window;

beforeEach(() => {
  mockFetch.mockReset();
  mockClearAuth.mockReset();
  mockSetTokens.mockReset();
  global.fetch = mockFetch;
  // Provide window.location.origin for buildUrl in auth-profiles API (node env has no window)
  globalThis.window = { location: { origin: 'http://localhost:3000' } } as any;
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.window = savedWindow;
});

/**
 * Helper: mock a successful fetch response
 */
function mockOk(data: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

/**
 * Helper: mock a failed fetch response
 */
function mockError(status: number, error = 'Error') {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error }),
  });
}

// ===========================================================================
// Deployments API
// ===========================================================================

describe('Deployments API', () => {
  // The deployments module uses apiFetch which adds auth headers and handles 401 retry.
  // apiFetch calls global.fetch internally.

  let deployments: typeof import('../api/deployments');

  beforeEach(async () => {
    deployments = await import('../../api/deployments');
  });

  describe('fetchDeployments', () => {
    it('should call the correct URL for a project', async () => {
      mockOk({ success: true, deployments: [] });

      await deployments.fetchDeployments('proj-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/projects/proj-1/deployments');
    });

    it('should append query params for environment and status', async () => {
      mockOk({ success: true, deployments: [] });

      await deployments.fetchDeployments('proj-1', {
        environment: 'production',
        status: 'active',
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('environment=production');
      expect(url).toContain('status=active');
    });

    it('should omit query string when no params', async () => {
      mockOk({ success: true, deployments: [] });

      await deployments.fetchDeployments('proj-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain('?');
    });

    it('should return the response data', async () => {
      const data = {
        success: true,
        deployments: [{ id: 'dep-1', status: 'active' }],
      };
      mockOk(data);

      const result = await deployments.fetchDeployments('proj-1');

      expect(result.deployments).toHaveLength(1);
      expect(result.deployments[0].id).toBe('dep-1');
    });

    it('should throw on error', async () => {
      mockError(500, 'Server error');

      await expect(deployments.fetchDeployments('proj-1')).rejects.toThrow();
    });
  });

  describe('createDeployment', () => {
    it('should POST to the correct URL', async () => {
      mockOk({ success: true, deployment: { id: 'dep-1' } });

      await deployments.createDeployment('proj-1', {
        environment: 'dev',
        agentVersionManifest: { agent1: 'v1' },
        entryAgentName: 'agent1',
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/projects/proj-1/deployments');
      expect(opts.method).toBe('POST');
    });

    it('should include the deployment data in the body', async () => {
      mockOk({ success: true, deployment: { id: 'dep-1' } });

      const input = {
        environment: 'production',
        agentVersionManifest: { booking: '1.0.0' },
        entryAgentName: 'booking',
        label: 'Release 1',
      };

      await deployments.createDeployment('proj-1', input);

      const [, opts] = mockFetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual(input);
    });
  });

  describe('getDeployment', () => {
    it('should fetch a specific deployment by ID', async () => {
      mockOk({ success: true, deployment: { id: 'dep-1' } });

      await deployments.getDeployment('proj-1', 'dep-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/projects/proj-1/deployments/dep-1');
    });
  });

  describe('retireDeployment', () => {
    it('should POST to the retire endpoint', async () => {
      mockOk({ success: true, deployment: { id: 'dep-1', status: 'retired' } });

      await deployments.retireDeployment('proj-1', 'dep-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/deployments/dep-1/retire');
      expect(opts.method).toBe('POST');
    });
  });

  describe('rollbackDeployment', () => {
    it('should POST to the rollback endpoint', async () => {
      mockOk({ success: true, deployment: { id: 'dep-2' } });

      await deployments.rollbackDeployment('proj-1', 'dep-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/deployments/dep-1/rollback');
      expect(opts.method).toBe('POST');
    });
  });
});

// ===========================================================================
// Channels API
// ===========================================================================

describe('Channels API', () => {
  let channels: typeof import('../api/channels');

  beforeEach(async () => {
    channels = await import('../../api/channels');
  });

  describe('fetchChannels', () => {
    it('should call the correct URL', async () => {
      mockOk({ success: true, channels: [] });

      await channels.fetchChannels('proj-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/runtime/sdk-channels?projectId=proj-1');
    });

    it('should return channels array', async () => {
      const data = {
        success: true,
        channels: [{ id: 'ch-1', name: 'Web', channelType: 'web' }],
      };
      mockOk(data);

      const result = await channels.fetchChannels('proj-1');

      expect(result.channels).toHaveLength(1);
    });
  });

  describe('createChannel', () => {
    it('should POST with channel data', async () => {
      mockOk({ success: true, channel: { id: 'ch-1' } });

      await channels.createChannel('proj-1', {
        name: 'Web Widget',
        channelType: 'web',
        publicApiKeyId: 'key-1',
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/runtime/sdk-channels?projectId=proj-1');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.name).toBe('Web Widget');
      expect(body.channelType).toBe('web');
    });
  });

  describe('updateChannel', () => {
    it('should PATCH the channel proxy URL', async () => {
      mockOk({ success: true, channel: { id: 'ch-1' } });

      await channels.updateChannel('proj-1', 'ch-1', {
        name: 'Updated',
        isActive: false,
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/runtime/sdk-channels/ch-1');
      expect(opts.method).toBe('PATCH');
    });
  });

  describe('deleteChannel', () => {
    it('should DELETE the channel', async () => {
      mockOk({ success: true });

      await channels.deleteChannel('proj-1', 'ch-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/runtime/sdk-channels/ch-1');
      expect(opts.method).toBe('DELETE');
    });
  });
});

// ===========================================================================
// Versions API
// ===========================================================================

describe('Versions API', () => {
  let versions: typeof import('../api/versions');

  beforeEach(async () => {
    versions = await import('../../api/versions');
  });

  describe('fetchVersions', () => {
    it('should call the correct URL with agent name', async () => {
      mockOk({
        success: true,
        versions: [],
        total: 0,
        limit: 20,
        offset: 0,
        hasMore: false,
      });

      await versions.fetchVersions('proj-1', 'booking_agent');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/projects/proj-1/agents/booking_agent/versions');
    });

    it('should append pagination params', async () => {
      mockOk({
        success: true,
        versions: [],
        total: 0,
        limit: 10,
        offset: 5,
        hasMore: false,
      });

      await versions.fetchVersions('proj-1', 'agent', {
        limit: 10,
        offset: 5,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('limit=10');
      expect(url).toContain('offset=5');
    });

    it('should not append query string with default opts', async () => {
      mockOk({
        success: true,
        versions: [],
        total: 0,
        limit: 20,
        offset: 0,
        hasMore: false,
      });

      await versions.fetchVersions('proj-1', 'agent');

      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain('?');
    });
  });

  describe('fetchVersion', () => {
    it('should fetch a specific version', async () => {
      mockOk({ success: true, version: { id: 'v-1', version: '1.0.0' } });

      await versions.fetchVersion('proj-1', 'agent', '1.0.0');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/versions/1.0.0');
    });
  });

  describe('createVersion', () => {
    it('should POST with changelog', async () => {
      mockOk({
        success: true,
        versionId: 'v-1',
        version: '1.0.0',
        sourceHash: 'abc123',
      });

      await versions.createVersion('proj-1', 'agent', 'Initial release');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/agents/agent/versions');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ changelog: 'Initial release' });
    });

    it('should POST without changelog', async () => {
      mockOk({
        success: true,
        versionId: 'v-1',
        version: '1.0.0',
        sourceHash: 'abc',
      });

      await versions.createVersion('proj-1', 'agent');

      const [, opts] = mockFetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({ changelog: undefined });
    });
  });

  describe('promoteVersion', () => {
    it('should POST with target status', async () => {
      mockOk({
        success: true,
        version: { id: 'v-1', status: 'active' },
        previousStatus: 'testing',
      });

      await versions.promoteVersion('proj-1', 'agent', '1.0.0', 'active');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/versions/1.0.0/promote');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ targetStatus: 'active' });
    });
  });

  describe('fetchVersionDiff', () => {
    it('should fetch diff between two versions', async () => {
      mockOk({ success: true, diff: [] });

      await versions.fetchVersionDiff('proj-1', 'agent', '1.0.0', '2.0.0');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/versions/1.0.0/diff/2.0.0');
    });
  });
});

// ===========================================================================
// Runtime Agents API
// ===========================================================================

describe('Runtime Agents API', () => {
  let runtimeAgents: typeof import('../api/runtime-agents');

  beforeEach(async () => {
    runtimeAgents = await import('../../api/runtime-agents');
  });

  describe('parseActiveVersions', () => {
    it('should parse a JSON string', () => {
      const result = runtimeAgents.parseActiveVersions('{"dev":"1.0.0","production":"2.0.0"}');
      expect(result).toEqual({ dev: '1.0.0', production: '2.0.0' });
    });

    it('should return object as-is', () => {
      const obj = { dev: '1.0.0' };
      const result = runtimeAgents.parseActiveVersions(obj);
      expect(result).toEqual(obj);
    });

    it('should return empty object for null', () => {
      expect(runtimeAgents.parseActiveVersions(null)).toEqual({});
    });

    it('should return empty object for undefined', () => {
      expect(runtimeAgents.parseActiveVersions(undefined)).toEqual({});
    });

    it('should return empty object for invalid JSON string', () => {
      expect(runtimeAgents.parseActiveVersions('not-json')).toEqual({});
    });
  });

  describe('fetchRuntimeAgents', () => {
    it('should call the correct URL', async () => {
      mockOk({ agents: [] });

      await runtimeAgents.fetchRuntimeAgents('proj-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/agents');
    });

    it('should return the agents list', async () => {
      const data = { agents: [{ id: 'a1', name: 'agent1' }] };
      mockOk(data);

      const result = await runtimeAgents.fetchRuntimeAgents('proj-1');

      expect(result.agents).toHaveLength(1);
    });
  });

  describe('fetchRuntimeAgent', () => {
    it('should call the correct URL with encoded agent name', async () => {
      mockOk({ agent: { id: 'a1', name: 'my agent' } });

      await runtimeAgents.fetchRuntimeAgent('proj-1', 'my agent');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/agents/my%20agent');
    });
  });

  describe('saveDslWorkingCopy', () => {
    it('should PUT to the DSL endpoint', async () => {
      mockOk({ success: true, updatedAt: '2024-01-01' });

      await runtimeAgents.saveDslWorkingCopy('proj-1', 'booking', 'agent booking {}');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/agents/booking/dsl');
      expect(opts.method).toBe('PUT');
      expect(JSON.parse(opts.body)).toEqual({
        dslContent: 'agent booking {}',
      });
    });

    it('should return success and updatedAt', async () => {
      mockOk({ success: true, updatedAt: '2024-06-01T00:00:00Z' });

      const result = await runtimeAgents.saveDslWorkingCopy('proj-1', 'booking', 'content');

      expect(result.success).toBe(true);
      expect(result.updatedAt).toBe('2024-06-01T00:00:00Z');
    });

    it('should throw on error', async () => {
      mockError(400, 'Invalid DSL');

      await expect(runtimeAgents.saveDslWorkingCopy('proj-1', 'booking', 'bad')).rejects.toThrow();
    });
  });
});

// ===========================================================================
// Usage API
// ===========================================================================

describe('Usage API', () => {
  let usage: typeof import('../api/usage');

  beforeEach(async () => {
    usage = await import('../../api/usage');
  });

  describe('computeUsageMetrics', () => {
    it('should compute correct totals from sessions', () => {
      const sessions = [
        {
          messageCount: 10,
          traceEventCount: 5,
          tokenCount: 1000,
          estimatedCost: 0.01,
          createdAt: '2024-01-01',
        },
        {
          messageCount: 20,
          traceEventCount: 15,
          tokenCount: 2000,
          estimatedCost: 0.02,
          createdAt: '2024-01-02',
        },
      ];

      const result = usage.computeUsageMetrics(sessions);

      expect(result.totalSessions).toBe(2);
      expect(result.totalMessages).toBe(30);
      expect(result.totalTokens).toBe(3000);
      expect(result.totalLLMCalls).toBe(20);
      expect(result.estimatedCost).toBe(0.03);
    });

    it('should handle empty session list', () => {
      const result = usage.computeUsageMetrics([]);

      expect(result.totalSessions).toBe(0);
      expect(result.totalMessages).toBe(0);
      expect(result.totalTokens).toBe(0);
    });

    it('should estimate tokens when tokenCount is 0 but messages exist', () => {
      const sessions = [{ messageCount: 10, traceEventCount: 5, createdAt: '2024-01-01' }];

      const result = usage.computeUsageMetrics(sessions);

      // Fallback: tokens = messages * 500
      expect(result.totalTokens).toBe(5000);
      // Fallback cost: tokens * 0.000005
      expect(result.estimatedCost).toBe(0.025);
    });

    it('should handle sessions with missing fields', () => {
      const sessions = [{}, { messageCount: 5 }];

      const result = usage.computeUsageMetrics(sessions);

      expect(result.totalSessions).toBe(2);
      expect(result.totalMessages).toBe(5);
    });

    it('should use last session createdAt as period start', () => {
      const sessions = [{ createdAt: '2024-06-01' }, { createdAt: '2024-01-01' }];

      const result = usage.computeUsageMetrics(sessions);

      expect(result.period.from).toBe('2024-01-01');
    });
  });

  describe('fetchSessionAnalysis', () => {
    it('should call the correct URL with projectId', async () => {
      mockOk({
        success: true,
        session: {
          traceEvents: [{}],
          messages: [{}, {}],
          state: {},
        },
      });

      await usage.fetchSessionAnalysis('proj-1', 'session-123');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/runtime/sessions/session-123?projectId=proj-1');
    });

    it('should return analysis with message and trace counts', async () => {
      mockOk({
        success: true,
        session: {
          traceEvents: [{}, {}],
          messages: [{}, {}, {}],
        },
      });

      const result = await usage.fetchSessionAnalysis('proj-1', 's-1');

      expect(result.success).toBe(true);
      expect(result.analysis.summary).toContain('3 messages');
      expect(result.analysis.summary).toContain('2 trace events');
    });

    it('should handle missing session data', async () => {
      mockOk({ success: true });

      const result = await usage.fetchSessionAnalysis('proj-1', 's-1');

      expect(result.success).toBe(true);
      expect(result.analysis.summary).toBe('No session data available');
    });

    it('should handle session with no events or messages', async () => {
      mockOk({ success: true, session: {} });

      const result = await usage.fetchSessionAnalysis('proj-1', 's-1');

      expect(result.analysis.summary).toContain('0 messages');
      expect(result.analysis.summary).toContain('0 trace events');
    });
  });
});

// ===========================================================================
// SearchAI API
// ===========================================================================

describe('SearchAI API', () => {
  let searchAi: typeof import('../api/search-ai');

  beforeEach(async () => {
    searchAi = await import('../../api/search-ai');
  });

  // ── Index API ─────────────────────────────────────────────────────────

  describe('fetchIndexes', () => {
    it('should call the correct URL with projectId query', async () => {
      mockOk({ indexes: [], total: 0 });

      await searchAi.fetchIndexes('proj-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/indexes?projectId=proj-1');
    });
  });

  describe('createIndex', () => {
    it('should POST to the indexes endpoint', async () => {
      mockOk({ index: { _id: 'idx-1', name: 'Test Index' } });

      await searchAi.createIndex({
        tenantId: 't-1',
        projectId: 'p-1',
        name: 'Test',
        slug: 'test',
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/indexes');
      expect(opts.method).toBe('POST');
    });
  });

  describe('getIndex', () => {
    it('should fetch a specific index', async () => {
      mockOk({ index: { _id: 'idx-1' } });

      await searchAi.getIndex('idx-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/indexes/idx-1');
    });
  });

  describe('deleteIndex', () => {
    it('should DELETE the index', async () => {
      mockOk({ deleted: true });

      await searchAi.deleteIndex('idx-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/indexes/idx-1');
      expect(opts.method).toBe('DELETE');
    });
  });

  describe('rebuildIndex', () => {
    it('should POST to the rebuild endpoint', async () => {
      mockOk({ message: 'Rebuilding', status: 'building' });

      await searchAi.rebuildIndex('idx-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/indexes/idx-1/rebuild');
      expect(opts.method).toBe('POST');
    });
  });

  // ── Knowledge Base API ────────────────────────────────────────────────

  describe('fetchKnowledgeBases', () => {
    it('should call the correct URL', async () => {
      mockOk({ knowledgeBases: [], total: 0 });

      await searchAi.fetchKnowledgeBases('proj-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/knowledge-bases?projectId=proj-1');
    });
  });

  describe('createKnowledgeBase', () => {
    it('should POST with data', async () => {
      mockOk({ knowledgeBase: { _id: 'kb-1', name: 'KB' } });

      await searchAi.createKnowledgeBase({
        tenantId: 't-1',
        projectId: 'p-1',
        name: 'KB',
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/knowledge-bases');
      expect(opts.method).toBe('POST');
    });
  });

  describe('getKnowledgeBase', () => {
    it('should fetch by ID', async () => {
      mockOk({ knowledgeBase: { _id: 'kb-1' } });

      await searchAi.getKnowledgeBase('kb-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/knowledge-bases/kb-1');
    });
  });

  describe('updateKnowledgeBase', () => {
    it('should PATCH with data', async () => {
      mockOk({ knowledgeBase: { _id: 'kb-1', name: 'Updated' } });

      await searchAi.updateKnowledgeBase('kb-1', { name: 'Updated' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/knowledge-bases/kb-1');
      expect(opts.method).toBe('PATCH');
    });
  });

  describe('deleteKnowledgeBase', () => {
    it('should DELETE', async () => {
      mockOk({ deleted: true });

      await searchAi.deleteKnowledgeBase('kb-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/knowledge-bases/kb-1');
      expect(opts.method).toBe('DELETE');
    });
  });

  describe('rebuildKnowledgeBase', () => {
    it('should POST to the rebuild endpoint', async () => {
      mockOk({ message: 'Rebuilding', status: 'building' });

      await searchAi.rebuildKnowledgeBase('kb-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/knowledge-bases/kb-1/rebuild');
      expect(opts.method).toBe('POST');
    });
  });

  // ── Source API ────────────────────────────────────────────────────────

  describe('fetchSources', () => {
    it('should fetch sources for an index', async () => {
      mockOk({ sources: [], total: 0 });

      await searchAi.fetchSources('idx-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/indexes/idx-1/sources');
    });
  });

  describe('addSource', () => {
    it('should POST to the sources endpoint', async () => {
      mockOk({ source: { _id: 'src-1' } });

      await searchAi.addSource('idx-1', {
        name: 'My Source',
        sourceType: 'file',
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/indexes/idx-1/sources');
      expect(opts.method).toBe('POST');
    });
  });

  describe('deleteSource', () => {
    it('should DELETE the source', async () => {
      mockOk({ deleted: true });

      await searchAi.deleteSource('idx-1', 'src-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/indexes/idx-1/sources/src-1');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── Schema API ────────────────────────────────────────────────────────

  describe('getCanonicalSchema', () => {
    it('should fetch schema by knowledge base ID', async () => {
      mockOk({ schema: { _id: 's-1', fields: [] } });

      await searchAi.getCanonicalSchema('kb-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/schemas/kb-1');
    });
  });

  describe('updateCanonicalSchema', () => {
    it('should PATCH schema with fields', async () => {
      mockOk({ schema: { _id: 's-1', fields: [] } });

      await searchAi.updateCanonicalSchema('kb-1', {
        fields: [
          {
            name: 'title',
            label: 'Title',
            type: 'string',
            storageField: 'title',
            indexed: true,
            filterable: false,
            aggregatable: false,
            sortable: false,
          },
        ],
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/schemas/kb-1');
      expect(opts.method).toBe('PATCH');
    });
  });

  // ── Mapping API ───────────────────────────────────────────────────────

  describe('fetchMappings', () => {
    it('should fetch mappings by schema ID', async () => {
      mockOk({ mappings: [], total: 0 });

      await searchAi.fetchMappings('schema-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/mappings?schemaId=schema-1');
    });
  });

  describe('confirmMapping', () => {
    it('should POST to confirm endpoint', async () => {
      mockOk({ mapping: { _id: 'm-1', status: 'confirmed' } });

      await searchAi.confirmMapping('m-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/mappings/m-1/confirm');
      expect(opts.method).toBe('POST');
    });
  });

  describe('rejectMapping', () => {
    it('should POST to reject endpoint', async () => {
      mockOk({ mapping: { _id: 'm-1', status: 'rejected' } });

      await searchAi.rejectMapping('m-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/mappings/m-1/reject');
      expect(opts.method).toBe('POST');
    });
  });

  // ── Vocabulary API ────────────────────────────────────────────────────

  describe('createVocabularyEntry', () => {
    it('should POST with vocabulary data', async () => {
      mockOk({ entryId: 'entry-1', message: 'Created' });

      await searchAi.createVocabularyEntry('idx-1', {
        term: 'SUV',
        aliases: ['sport utility vehicle'],
        fieldRef: 'vehicle_type',
        capabilities: {
          canFilter: true,
          canDisplay: true,
          canAggregate: false,
          canSort: false,
        },
        relatedFields: {
          displayWith: [],
          aggregateWith: [],
        },
        generatedBy: 'manual',
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/indexes/idx-1/vocabulary');
      expect(opts.method).toBe('POST');
    });
  });

  describe('deleteVocabularyEntry', () => {
    it('should DELETE the entry', async () => {
      mockOk({ deleted: true, message: 'Deleted' });

      await searchAi.deleteVocabularyEntry('idx-1', 'entry-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai/indexes/idx-1/vocabulary/entry-1');
      expect(opts.method).toBe('DELETE');
    });
  });

  // ── Query API ─────────────────────────────────────────────────────────

  describe('executeQuery', () => {
    it('should POST to the vector query endpoint by default', async () => {
      mockOk({
        queryId: 'q-1',
        results: [],
        latency: {
          vocabularyResolveMs: 0,
          vectorSearchMs: 10,
          structuredFilterMs: 0,
          rerankMs: 0,
          totalMs: 10,
        },
      });

      await searchAi.executeQuery('idx-1', { query: 'hello' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai-runtime/search/idx-1/query');
      expect(opts.method).toBe('POST');
    });

    it('should still POST to the query endpoint for structured queries', async () => {
      mockOk({
        queryId: 'q-2',
        results: [],
        latency: {
          vocabularyResolveMs: 0,
          vectorSearchMs: 0,
          structuredFilterMs: 5,
          rerankMs: 0,
          totalMs: 5,
        },
      });

      await searchAi.executeQuery('idx-1', {
        query: 'type:document',
        queryType: 'structured',
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai-runtime/search/idx-1/query');
    });

    it('should use query endpoint for hybrid queries', async () => {
      mockOk({
        queryId: 'q-3',
        results: [],
        latency: {
          vocabularyResolveMs: 0,
          vectorSearchMs: 0,
          structuredFilterMs: 0,
          rerankMs: 0,
          totalMs: 0,
        },
      });

      await searchAi.executeQuery('idx-1', {
        query: 'test',
        queryType: 'hybrid',
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai-runtime/search/idx-1/query');
    });
  });

  describe('resolveVocabulary', () => {
    it('should POST to the resolve endpoint', async () => {
      mockOk({
        resolvedTerms: [],
        unresolvedSegments: ['hello'],
        structuredFilters: [],
      });

      await searchAi.resolveVocabulary('idx-1', 'hello', 'fuzzy');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/search-ai-runtime/search/idx-1/resolve');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.query).toBe('hello');
    });
  });
});

// ===========================================================================
// apiFetch 401 retry behavior (integration with api-client)
// ===========================================================================

describe('apiFetch 401 retry behavior', () => {
  let apiClient: typeof import('../lib/api-client');

  beforeEach(async () => {
    apiClient = await import('../../lib/api-client');
  });

  it('should include Authorization header from auth store', () => {
    const headers = apiClient.authHeaders();
    expect(headers).toHaveProperty('Authorization', 'Bearer test-access-token');
  });

  it('should include X-Tenant-Id header from auth store', () => {
    const headers = apiClient.authHeaders();
    expect(headers).toHaveProperty('X-Tenant-Id', 'test-tenant-id');
  });

  it('should retry on 401 after refreshing token', async () => {
    // First call returns 401
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    });

    // Refresh call succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'refreshed-token', expiresIn: 900 }),
    });

    // Retry call succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: 'success' }),
    });

    const response = await apiClient.apiFetch('/api/test');

    expect(response.ok).toBe(true);
    // Three fetches: original, refresh, retry
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should not retry on non-401 errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Server error' }),
    });

    const response = await apiClient.apiFetch('/api/test');

    expect(response.ok).toBe(false);
    expect(response.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Workspace Auth Profiles API
// ===========================================================================

describe('Workspace Auth Profiles API', () => {
  let authProfiles: typeof import('../api/auth-profiles');

  beforeEach(async () => {
    authProfiles = await import('../../api/auth-profiles');
  });

  it('should list workspace auth profiles through the admin endpoint', async () => {
    mockOk({ success: true, data: [], pagination: { nextCursor: null, total: 0 } });

    await authProfiles.fetchWorkspaceAuthProfiles({ search: 'oauth' });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/admin/auth-profiles');
    expect(url).toContain('search=oauth');
  });

  it('should create workspace auth profiles through the admin endpoint', async () => {
    mockOk({ success: true, data: { id: 'profile-1' } });

    await authProfiles.createWorkspaceAuthProfile({
      name: 'Workspace OAuth',
      authType: 'oauth2_app',
      config: { authorizationUrl: 'https://example.com/oauth/authorize' },
      secrets: { clientSecret: 'secret' },
      visibility: 'shared',
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/admin/auth-profiles');
    expect(opts.method).toBe('POST');
  });

  it('should validate workspace auth profiles through the admin endpoint', async () => {
    mockOk({ success: true, data: { valid: true } });

    await authProfiles.validateWorkspaceAuthProfile('profile-1');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/admin/auth-profiles/profile-1/validate');
    expect(opts.method).toBe('POST');
  });

  it('should bulk-manage workspace auth profiles through the admin endpoint', async () => {
    mockOk({ success: true, data: { results: [] } });

    await authProfiles.bulkWorkspaceAuthProfiles({
      action: 'revoke',
      profileIds: ['profile-1'],
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/admin/auth-profiles/bulk');
    expect(opts.method).toBe('POST');
  });
});

// ===========================================================================
// handleResponse
// ===========================================================================

describe('handleResponse', () => {
  let apiClient: typeof import('../lib/api-client');

  beforeEach(async () => {
    apiClient = await import('../../lib/api-client');
  });

  it('should parse JSON from ok response', async () => {
    const data = { projects: [] };
    const response = new Response(JSON.stringify(data), { status: 200 });

    const result = await apiClient.handleResponse(response);

    expect(result).toEqual(data);
  });

  it('should throw on non-ok response', async () => {
    const response = new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });

    await expect(apiClient.handleResponse(response)).rejects.toThrow();
  });

  it('should preserve runtime string-array errors', async () => {
    const response = new Response(
      JSON.stringify({
        success: false,
        errors: ["Step 'Examples' must declare REASONING: true or REASONING: false."],
      }),
      { status: 422 },
    );

    await expect(apiClient.handleResponse(response)).rejects.toThrow(
      "Step 'Examples' must declare",
    );
  });

  it('should throw with fallback message when body is not JSON', async () => {
    const response = new Response('not json', { status: 500 });

    expect.assertions(2);
    try {
      await apiClient.handleResponse(response);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('Request failed');
    }
  });
});
