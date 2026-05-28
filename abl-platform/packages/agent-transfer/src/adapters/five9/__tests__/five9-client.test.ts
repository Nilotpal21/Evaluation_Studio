import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Five9Client } from '../five9-client.js';
import { Five9ProviderConfigSchema } from '../../../config/schema.js';
import type { Five9Credentials } from '../types.js';

// Mock the SSRF guard to allow test URLs
vi.mock('../../../security/ssrf-guard.js', () => ({
  assertAllowedUrl: vi.fn().mockResolvedValue(undefined),
}));

// Import mock after vi.mock so we can control it per-test
import { assertAllowedUrl } from '../../../security/ssrf-guard.js';

function createMockFetch(response: {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}): typeof fetch {
  // Client uses safeReadBody() which calls text() then JSON.parse().
  // If json is provided but text is not, derive text from json.
  const textFn =
    response.text ??
    (response.json ? async () => JSON.stringify(await response.json!()) : async () => '');
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: response.json ?? (async () => ({})),
    text: textFn,
  }) as unknown as typeof fetch;
}

function anonymousCredentials(): Five9Credentials {
  return {
    tenantName: 'test-tenant',
    campaignName: 'test-campaign',
    host: 'app.five9.com',
    authMode: 'anonymous',
  };
}

function supervisorCredentials(): Five9Credentials {
  return {
    tenantName: 'test-tenant',
    campaignName: 'test-campaign',
    host: 'app.five9.com',
    authMode: 'supervisor',
    username: 'admin@test.com',
    password: 's3cret',
  };
}

describe('Five9Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('authenticate', () => {
    it('authenticates in anonymous mode', async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        json: async () => ({
          tokenId: 'tok-123',
          orgId: 'org-456',
          context: { farmId: 'farm-789' },
        }),
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);
      const result = await client.authenticate();

      expect(result.tokenId).toBe('tok-123');
      expect(result.orgId).toBe('org-456');
      expect(result.farmId).toBe('farm-789');
      expect(result.targetHost).toBe('app.five9.com');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://app.five9.com/appsvcs/rs/svc/auth/anon?cookieless=true',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ tenantName: 'test-tenant' }),
        }),
      );
    });

    it('authenticates in supervisor mode', async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        json: async () => ({
          tokenId: 'tok-sup',
          orgId: 'org-sup',
          context: { farmId: 'farm-sup' },
        }),
      });

      const client = new Five9Client(supervisorCredentials(), mockFetch);
      const result = await client.authenticate();

      expect(result.tokenId).toBe('tok-sup');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://app.five9.com/appsvcs/rs/svc/auth/login',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            tenantName: 'test-tenant',
            username: 'admin@test.com',
            password: 's3cret',
          }),
        }),
      );
    });

    it('throws structured error on supervisor mode without credentials', async () => {
      const creds: Five9Credentials = {
        tenantName: 'test-tenant',
        campaignName: 'test-campaign',
        host: 'app.five9.com',
        authMode: 'supervisor',
        // No username/password
      };

      const client = new Five9Client(creds, createMockFetch({ ok: true, status: 200 }));

      await expect(client.authenticate()).rejects.toThrow(
        'Username and password required for supervisor auth mode',
      );
    });

    it('throws structured error on HTTP failure', async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);

      await expect(client.authenticate()).rejects.toThrow(
        'Authentication failed with status 401: Unauthorized',
      );
    });
  });

  describe('discoverMetadata', () => {
    it('resolves targetHost from data center API URLs', async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        json: async () => ({
          orgId: 'org-123',
          context: { farmId: 'farm-456' },
          metadata: {
            dataCenters: [
              {
                name: 'US-East',
                active: true,
                apiUrls: [{ host: 'api-east.five9.com', port: '443' }],
                uiUrls: [],
                loginUrls: [],
              },
            ],
          },
        }),
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);
      const result = await client.discoverMetadata('app.five9.com', 'tok-123');

      expect(result.orgId).toBe('org-123');
      expect(result.farmId).toBe('farm-456');
      expect(result.targetHost).toBe('api-east.five9.com');
      expect(result.tokenId).toBe('tok-123');
    });

    it('falls back to original host when no data centers', async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        json: async () => ({
          orgId: 'org-123',
          context: { farmId: 'farm-456' },
          metadata: { dataCenters: [] },
        }),
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);
      const result = await client.discoverMetadata('app.five9.com', 'tok-123');

      expect(result.targetHost).toBe('app.five9.com');
    });

    it('throws structured error on HTTP failure', async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);

      await expect(client.discoverMetadata('app.five9.com', 'tok-123')).rejects.toThrow(
        'Metadata discovery failed with status 500: Internal Server Error',
      );
    });
  });

  describe('SSRF protection', () => {
    it('calls assertAllowedUrl before every fetch', async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        json: async () => ({
          tokenId: 'tok',
          orgId: 'org',
          context: { farmId: 'farm' },
        }),
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);
      await client.authenticate();

      expect(assertAllowedUrl).toHaveBeenCalledWith(
        'https://app.five9.com/appsvcs/rs/svc/auth/anon?cookieless=true',
      );
    });

    it('rejects requests when SSRF guard throws', async () => {
      vi.mocked(assertAllowedUrl).mockRejectedValueOnce(
        new Error('SSRF blocked: localhost is not allowed'),
      );

      const creds: Five9Credentials = {
        ...anonymousCredentials(),
        host: 'localhost',
      };

      const client = new Five9Client(creds, createMockFetch({ ok: true, status: 200 }));

      await expect(client.authenticate()).rejects.toThrow('SSRF blocked: localhost is not allowed');
    });
  });

  describe('createConversation', () => {
    it('creates a conversation and returns conversationId', async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        json: async () => ({ conversationId: 'conv-abc' }),
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);
      const result = await client.createConversation('api.five9.com', 'tok-123', {
        campaignName: 'test-campaign',
        tenantId: 'org-123',
        tenantName: 'test-tenant',
      });

      expect(result.conversationId).toBe('conv-abc');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.five9.com/appsvcs/rs/svc/conversations',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws structured error on HTTP failure', async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);

      await expect(
        client.createConversation('api.five9.com', 'tok-123', {
          campaignName: 'test-campaign',
          tenantId: 'org-123',
          tenantName: 'test-tenant',
        }),
      ).rejects.toThrow('Conversation creation failed with status 503: Service Unavailable');
    });
  });

  describe('sendMessage', () => {
    it('sends a message to a conversation', async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);
      await client.sendMessage('api.five9.com', 'conv-abc', 'tok-123', 'Hello agent', 'farm-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.five9.com/appsvcs/rs/svc/conversations/conv-abc/messages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ messageType: 'TEXT', message: 'Hello agent' }),
        }),
      );
    });

    it('throws structured error on send failure', async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);

      await expect(
        client.sendMessage('api.five9.com', 'conv-abc', 'tok-123', 'Hello', 'farm-1'),
      ).rejects.toThrow('Send message failed with status 429: Rate limited');
    });
  });

  describe('sendTyping', () => {
    it('sends a typing indicator via PUT', async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);
      await client.sendTyping('api.five9.com', 'conv-abc', 'tok-123', 'farm-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.five9.com/appsvcs/rs/svc/conversations/conv-abc/messages/typing',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            Authorization: 'Bearer tok-123',
            farmId: 'farm-1',
          }),
        }),
      );
    });

    it('throws structured error on typing failure', async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);

      await expect(
        client.sendTyping('api.five9.com', 'conv-abc', 'tok-123', 'farm-1'),
      ).rejects.toThrow('Send typing failed with status 500: Internal Server Error');
    });
  });

  describe('endConversation', () => {
    it('ends a conversation via DELETE', async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);
      await client.endConversation('api.five9.com', 'conv-abc', 'tok-123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.five9.com/appsvcs/rs/svc/conversations/conv-abc',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('throws structured error on end failure', async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const client = new Five9Client(anonymousCredentials(), mockFetch);

      await expect(client.endConversation('api.five9.com', 'conv-abc', 'tok-123')).rejects.toThrow(
        'End conversation failed with status 404: Not Found',
      );
    });
  });
});

describe('Five9ProviderConfigSchema', () => {
  it('validates a valid anonymous config', () => {
    const result = Five9ProviderConfigSchema.safeParse({
      tenantName: 'my-tenant',
      campaignName: 'inbound',
      authMode: 'anonymous',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host).toBe('app.five9.com'); // default
    }
  });

  it('validates a valid supervisor config', () => {
    const result = Five9ProviderConfigSchema.safeParse({
      tenantName: 'my-tenant',
      campaignName: 'inbound',
      host: 'app-eu.five9.com',
      authMode: 'supervisor',
      username: 'admin@test.com',
      password: 'secret123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects supervisor without password', () => {
    const result = Five9ProviderConfigSchema.safeParse({
      tenantName: 'my-tenant',
      campaignName: 'inbound',
      authMode: 'supervisor',
      username: 'admin@test.com',
      // missing password
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid authMode', () => {
    const result = Five9ProviderConfigSchema.safeParse({
      tenantName: 'my-tenant',
      campaignName: 'inbound',
      authMode: 'oauth',
    });
    expect(result.success).toBe(false);
  });

  it('normalizes host with protocol', () => {
    const result = Five9ProviderConfigSchema.safeParse({
      tenantName: 'my-tenant',
      campaignName: 'inbound',
      host: 'https://app.five9.com',
      authMode: 'anonymous',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host).toBe('app.five9.com');
    }
  });

  it('normalizes host with path', () => {
    const result = Five9ProviderConfigSchema.safeParse({
      tenantName: 'my-tenant',
      campaignName: 'inbound',
      host: 'app.five9.com/api',
      authMode: 'anonymous',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host).toBe('app.five9.com');
    }
  });

  it('validates with optional callbackUrl', () => {
    const result = Five9ProviderConfigSchema.safeParse({
      tenantName: 'my-tenant',
      campaignName: 'inbound',
      authMode: 'anonymous',
      callbackUrl: 'https://my-app.example.com/webhooks/five9',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid callbackUrl', () => {
    const result = Five9ProviderConfigSchema.safeParse({
      tenantName: 'my-tenant',
      campaignName: 'inbound',
      authMode: 'anonymous',
      callbackUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });
});
