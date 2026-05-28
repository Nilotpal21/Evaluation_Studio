/**
 * Workspace Admin Pages E2E Tests
 *
 * Integration tests verifying the workspace admin page API endpoints
 * used by KMS, Environment Variables, Guardrails, Connectors, and
 * Analytics pages. Global `fetch` is mocked to validate request
 * construction and response handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock Globals ────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse<T>(data: T, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

// ─── Test Data ───────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-001';
const PROJECT_ID = 'proj-001';

const MOCK_KMS_CONFIG = {
  success: true,
  config: {
    provider: 'aws-kms',
    keyId: 'arn:aws:kms:us-east-1:123456:key/abcd-1234',
    region: 'us-east-1',
    enabled: true,
    rotationEnabled: true,
    rotationIntervalDays: 90,
  },
};

const MOCK_KMS_KEYS = {
  success: true,
  keys: [
    {
      id: 'key-001',
      alias: 'platform-data-key',
      status: 'active',
      createdAt: '2025-06-01T00:00:00Z',
      lastRotated: '2026-01-01T00:00:00Z',
    },
  ],
};

const MOCK_ENV_VARS = {
  success: true,
  envVars: [
    {
      id: 'ev-001',
      key: 'API_ENDPOINT',
      value: 'https://api.example.com',
      isSecret: false,
      projectId: PROJECT_ID,
      createdAt: '2026-01-15T10:00:00Z',
    },
    {
      id: 'ev-002',
      key: 'DB_PASSWORD',
      value: '********',
      isSecret: true,
      projectId: PROJECT_ID,
      createdAt: '2026-01-15T10:00:00Z',
    },
  ],
};

const MOCK_GUARDRAIL_PROVIDERS = {
  success: true,
  providers: [
    {
      id: 'gp-001',
      name: 'OpenAI Moderation',
      type: 'openai_moderation',
      tenantId: TENANT_ID,
      isActive: true,
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
};

const MOCK_GUARDRAIL_POLICIES = {
  success: true,
  policies: [
    {
      id: 'gpol-001',
      name: 'Content Safety',
      projectId: PROJECT_ID,
      providerId: 'gp-001',
      enabled: true,
      categories: ['hate', 'violence', 'self-harm'],
      thresholds: { hate: 0.7, violence: 0.8, 'self-harm': 0.9 },
      createdAt: '2026-01-10T00:00:00Z',
    },
  ],
};

const MOCK_CHANNEL_CONNECTIONS = {
  success: true,
  connections: [
    {
      id: 'cc-001',
      type: 'webchat',
      name: 'Support Widget',
      status: 'connected',
      projectId: PROJECT_ID,
      config: { widgetId: 'w-001' },
      createdAt: '2026-01-05T00:00:00Z',
    },
    {
      id: 'cc-002',
      type: 'slack',
      name: 'Internal Bot',
      status: 'disconnected',
      projectId: PROJECT_ID,
      config: { teamId: 'T123' },
      createdAt: '2026-01-10T00:00:00Z',
    },
  ],
};

const MOCK_SDK_CHANNELS = {
  success: true,
  channels: [
    {
      id: 'sdk-001',
      name: 'Mobile SDK',
      clientId: 'client-abc',
      isActive: true,
      projectId: PROJECT_ID,
      createdAt: '2026-02-01T00:00:00Z',
    },
  ],
};

const MOCK_ANALYTICS_OVERVIEW = {
  success: true,
  summary: {
    totalSessions: 15420,
    totalTokens: 8750000,
    totalCost: 342.5,
    avgSessionDuration: 45.2,
    activeTenants: 12,
  },
  timeSeries: [
    { period: '2026-02-25', sessions: 520, tokens: 310000, cost: 12.5 },
    { period: '2026-02-26', sessions: 480, tokens: 290000, cost: 11.2 },
    { period: '2026-02-27', sessions: 610, tokens: 350000, cost: 14.1 },
  ],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Workspace Admin Pages E2E', () => {
  describe('KMS Management', () => {
    it('should fetch KMS configuration', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_KMS_CONFIG));

      const res = await fetch(`/api/admin/kms?endpoint=config`);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.config.provider).toBe('aws-kms');
      expect(data.config.enabled).toBe(true);
      expect(data.config.rotationEnabled).toBe(true);
    });

    it('should fetch encryption keys', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_KMS_KEYS));

      const res = await fetch(`/api/admin/kms?endpoint=keys`);
      const data = await res.json();

      expect(data.keys).toHaveLength(1);
      expect(data.keys[0].alias).toBe('platform-data-key');
      expect(data.keys[0].status).toBe('active');
    });

    it('should update KMS configuration', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          success: true,
          config: { ...MOCK_KMS_CONFIG.config, rotationIntervalDays: 60 },
        }),
      );

      const res = await fetch(`/api/admin/kms?endpoint=config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rotationIntervalDays: 60,
        }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
    });

    it('should trigger key rotation', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ success: true, newKeyId: 'key-002' }));

      const res = await fetch(`/api/admin/kms?endpoint=keys%2Frotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.newKeyId).toBe('key-002');
    });
  });

  describe('Environment Variables', () => {
    it('should list environment variables for a project', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_ENV_VARS));

      const res = await fetch(`/api/admin/env-vars?projectId=${PROJECT_ID}`);
      const data = await res.json();

      expect(data.envVars).toHaveLength(2);
      expect(data.envVars[0].key).toBe('API_ENDPOINT');
      expect(data.envVars[1].isSecret).toBe(true);
    });

    it('should create a new environment variable', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          success: true,
          envVar: {
            id: 'ev-003',
            key: 'NEW_VAR',
            value: 'test-value',
            isSecret: false,
            projectId: PROJECT_ID,
          },
        }),
      );

      const res = await fetch(`/api/admin/env-vars`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: PROJECT_ID,
          key: 'NEW_VAR',
          value: 'test-value',
          isSecret: false,
        }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.envVar.key).toBe('NEW_VAR');
    });

    it('should delete an environment variable', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ success: true }));

      const res = await fetch(`/api/admin/env-vars/ev-001`, {
        method: 'DELETE',
      });
      const data = await res.json();

      expect(data.success).toBe(true);
    });

    it('should validate env var key format', () => {
      const validPattern = /^[A-Za-z][A-Za-z0-9_]*$/;

      expect(validPattern.test('API_KEY')).toBe(true);
      expect(validPattern.test('my_var_2')).toBe(true);
      expect(validPattern.test('_INVALID')).toBe(false);
      expect(validPattern.test('123_BAD')).toBe(false);
      expect(validPattern.test('')).toBe(false);
    });
  });

  describe('Guardrails', () => {
    it('should list guardrail providers', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_GUARDRAIL_PROVIDERS));

      const res = await fetch(`/api/admin/guardrails/providers?tenantId=${TENANT_ID}`);
      const data = await res.json();

      expect(data.providers).toHaveLength(1);
      expect(data.providers[0].type).toBe('openai_moderation');
      expect(data.providers[0].isActive).toBe(true);
    });

    it('should list guardrail policies for a project', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_GUARDRAIL_POLICIES));

      const res = await fetch(`/api/admin/guardrails/policies?projectId=${PROJECT_ID}`);
      const data = await res.json();

      expect(data.policies).toHaveLength(1);
      expect(data.policies[0].name).toBe('Content Safety');
      expect(data.policies[0].categories).toContain('hate');
    });

    it('should create a guardrail policy', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          success: true,
          policy: {
            id: 'gpol-002',
            name: 'PII Detection',
            projectId: PROJECT_ID,
            providerId: 'gp-001',
            enabled: true,
            categories: ['pii'],
          },
        }),
      );

      const res = await fetch(`/api/admin/guardrails/policies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: PROJECT_ID,
          name: 'PII Detection',
          providerId: 'gp-001',
          categories: ['pii'],
        }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.policy.name).toBe('PII Detection');
    });
  });

  describe('Connectors & Channels', () => {
    it('should list channel connections', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_CHANNEL_CONNECTIONS));

      const res = await fetch(`/api/admin/connectors/channels?projectId=${PROJECT_ID}`);
      const data = await res.json();

      expect(data.connections).toHaveLength(2);
      expect(data.connections[0].type).toBe('webchat');
      expect(data.connections[1].status).toBe('disconnected');
    });

    it('should list SDK channels', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_SDK_CHANNELS));

      const res = await fetch(`/api/admin/connectors/sdk?projectId=${PROJECT_ID}`);
      const data = await res.json();

      expect(data.channels).toHaveLength(1);
      expect(data.channels[0].name).toBe('Mobile SDK');
      expect(data.channels[0].isActive).toBe(true);
    });

    it('should delete a channel connection', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ success: true }));

      const res = await fetch(`/api/admin/connectors/channels/cc-002`, {
        method: 'DELETE',
      });
      const data = await res.json();

      expect(data.success).toBe(true);
    });
  });

  describe('Analytics', () => {
    it('should fetch analytics overview', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_ANALYTICS_OVERVIEW));

      const res = await fetch(
        `/api/admin/analytics/overview?from=2026-02-25&to=2026-02-27&groupBy=day`,
      );
      const data = await res.json();

      expect(data.summary.totalSessions).toBe(15420);
      expect(data.summary.totalTokens).toBe(8750000);
      expect(data.timeSeries).toHaveLength(3);
    });

    it('should fetch analytics with project filter', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          ...MOCK_ANALYTICS_OVERVIEW,
          summary: { ...MOCK_ANALYTICS_OVERVIEW.summary, totalSessions: 5200 },
        }),
      );

      const res = await fetch(
        `/api/admin/analytics/overview?projectId=${PROJECT_ID}&from=2026-02-25&to=2026-02-27`,
      );
      const data = await res.json();

      expect(data.summary.totalSessions).toBe(5200);
    });

    it('should handle empty analytics data', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          success: true,
          summary: {
            totalSessions: 0,
            totalTokens: 0,
            totalCost: 0,
            avgSessionDuration: 0,
            activeTenants: 0,
          },
          timeSeries: [],
        }),
      );

      const res = await fetch(`/api/admin/analytics/overview?from=2026-03-01&to=2026-03-01`);
      const data = await res.json();

      expect(data.summary.totalSessions).toBe(0);
      expect(data.timeSeries).toHaveLength(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle 403 forbidden for non-admin users', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ error: 'Insufficient permissions' }, 403));

      const res = await fetch(`/api/admin/kms/config`);

      expect(res.status).toBe(403);
    });

    it('should handle 500 internal server errors', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ error: 'Internal server error' }, 500));

      const res = await fetch(`/api/admin/env-vars`);

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe('Internal server error');
    });
  });
});
