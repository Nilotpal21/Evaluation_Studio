/**
 * Tests for connect tool handler
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { connect } from '../tools/connect.js';
import type { DebugContext } from '../tools/index.js';

function createMockContext(overrides?: Partial<DebugContext>): DebugContext {
  return {
    wsClient: {
      isConnected: vi.fn().mockReturnValue(false),
      setUrl: vi.fn(),
      getUrl: vi.fn().mockReturnValue('ws://localhost:3112/ws'),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      setAuthToken: vi.fn(),
    } as any,
    httpClient: {
      setBaseUrl: vi.fn(),
      getBaseUrl: vi.fn().mockReturnValue('http://localhost:3112'),
      setAuthToken: vi.fn(),
      runtimeHealthCheck: vi.fn().mockResolvedValue({ reachable: true, status: 200 }),
    } as any,
    sessionStore: {} as any,
    traceStore: {} as any,
    authenticate: vi.fn().mockResolvedValue({ token: 'test-jwt', method: 'device_auth' }),
    ...overrides,
  };
}

describe('connect tool', () => {
  describe('URL resolution', () => {
    test('derives URLs from serverUrl', async () => {
      const ctx = createMockContext();
      await connect({ serverUrl: 'http://myhost:8080' }, ctx);

      expect(ctx.wsClient.setUrl).toHaveBeenCalledWith('ws://myhost:8080/ws');
      expect(ctx.httpClient.setBaseUrl).toHaveBeenCalledWith('http://myhost:8080');
    });

    test('uses legacy wsUrl/httpUrl when serverUrl not provided', async () => {
      const ctx = createMockContext();
      await connect({ wsUrl: 'ws://custom:9999/ws', httpUrl: 'http://custom:9999' }, ctx);

      expect(ctx.wsClient.setUrl).toHaveBeenCalledWith('ws://custom:9999/ws');
      expect(ctx.httpClient.setBaseUrl).toHaveBeenCalledWith('http://custom:9999');
    });

    test('serverUrl takes precedence over legacy params', async () => {
      const ctx = createMockContext();
      await connect(
        {
          serverUrl: 'http://primary:3112',
          wsUrl: 'ws://ignored:9999/ws',
          httpUrl: 'http://ignored:9999',
        },
        ctx,
      );

      expect(ctx.wsClient.setUrl).toHaveBeenCalledWith('ws://primary:3112/ws');
      expect(ctx.httpClient.setBaseUrl).toHaveBeenCalledWith('http://primary:3112');
    });

    test('uses defaults when no URLs provided', async () => {
      const ctx = createMockContext();
      await connect({}, ctx);

      // No setUrl/setBaseUrl calls — keeps defaults
      expect(ctx.wsClient.setUrl).not.toHaveBeenCalled();
      expect(ctx.httpClient.setBaseUrl).not.toHaveBeenCalled();
    });
  });

  describe('already connected', () => {
    test('returns already_connected when WS is open', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.wsClient.isConnected).mockReturnValue(true);

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('already_connected');
      // Should NOT try health check or auth
      expect(ctx.httpClient.runtimeHealthCheck).not.toHaveBeenCalled();
      expect(ctx.authenticate).not.toHaveBeenCalled();
    });

    test('refreshes token on both clients without reconnecting when new authToken provided', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.wsClient.isConnected).mockReturnValue(true);

      const raw = await connect({ authToken: 'new-jwt-token' }, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('token_refreshed');
      expect(ctx.httpClient.setAuthToken).toHaveBeenCalledWith('new-jwt-token');
      expect(ctx.wsClient.setAuthToken).toHaveBeenCalledWith('new-jwt-token');
      // Should NOT disconnect or re-authenticate
      expect(ctx.wsClient.disconnect).not.toHaveBeenCalled();
      expect(ctx.authenticate).not.toHaveBeenCalled();
    });

    test('force=true disconnects and fully reconnects', async () => {
      const ctx = createMockContext();
      // First call: connected. After disconnect: not connected.
      vi.mocked(ctx.wsClient.isConnected).mockReturnValueOnce(true).mockReturnValue(false);

      const raw = await connect({ force: true }, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('connected');
      expect(ctx.wsClient.disconnect).toHaveBeenCalled();
      expect(ctx.authenticate).toHaveBeenCalled();
      expect(ctx.wsClient.connect).toHaveBeenCalled();
    });

    test('force=true with authToken disconnects and re-authenticates with new token', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.wsClient.isConnected).mockReturnValueOnce(true).mockReturnValue(false);

      const raw = await connect({ authToken: 'fresh-jwt', force: true }, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('connected');
      expect(ctx.wsClient.disconnect).toHaveBeenCalled();
      expect(ctx.authenticate).toHaveBeenCalledWith({ authToken: 'fresh-jwt' });
    });
  });

  describe('health check (localhost only)', () => {
    test('returns actionable error when localhost runtime not reachable', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.httpClient.runtimeHealthCheck).mockResolvedValue({ reachable: false });

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Runtime not reachable');
      expect(result.error).toContain('cd apps/runtime && pnpm dev');
      expect(result.hint).toContain('Do NOT try alternative approaches');
      // Should NOT try auth
      expect(ctx.authenticate).not.toHaveBeenCalled();
    });

    test('includes error reason when health check has error details', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.httpClient.runtimeHealthCheck).mockResolvedValue({
        reachable: false,
        error: 'Connection refused: http://localhost:3112/health',
        errorCode: 'CONNECTION_REFUSED',
      });

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
      expect(result.errorCode).toBe('CONNECTION_REFUSED');
    });
  });

  describe('remote URL — skips health check', () => {
    test('skips health check for remote URL and goes straight to auth + WS', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.httpClient.getBaseUrl).mockReturnValue('https://agents-dev.kore.ai');
      vi.mocked(ctx.wsClient.getUrl).mockReturnValue('wss://agents-dev.kore.ai/ws');

      const raw = await connect({ serverUrl: 'https://agents-dev.kore.ai' }, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('connected');
      // Health check should NOT be called for remote URLs
      expect(ctx.httpClient.runtimeHealthCheck).not.toHaveBeenCalled();
      // Auth and WS connect should still be called
      expect(ctx.authenticate).toHaveBeenCalled();
      expect(ctx.wsClient.connect).toHaveBeenCalled();
    });

    test('returns WS error with details when remote WS connection fails', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.httpClient.getBaseUrl).mockReturnValue('https://agents-dev.kore.ai');
      vi.mocked(ctx.wsClient.getUrl).mockReturnValue('wss://agents-dev.kore.ai/ws');
      const wsError = new Error(
        'WebSocket connection timed out after 10s connecting to wss://agents-dev.kore.ai/ws',
      );
      (wsError as any).name = 'ConnectionTimeoutError';
      vi.mocked(ctx.wsClient.connect).mockRejectedValue(wsError);

      const raw = await connect({ serverUrl: 'https://agents-dev.kore.ai' }, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain('WebSocket connection failed');
      expect(result.error).toContain('timed out after 10s');
      expect(ctx.httpClient.runtimeHealthCheck).not.toHaveBeenCalled();
    });
  });

  describe('auth cascade integration', () => {
    test('passes authToken to authenticate', async () => {
      const ctx = createMockContext();

      await connect({ authToken: 'my-jwt' }, ctx);

      expect(ctx.authenticate).toHaveBeenCalledWith({ authToken: 'my-jwt' });
    });

    test('returns auth method on success', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.authenticate).mockResolvedValue({ token: 'jwt', method: 'stored_credentials' });

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.authMethod).toBe('stored_credentials');
    });

    test('returns error with hint when auth fails', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.authenticate).mockRejectedValue(new Error('All auth methods failed'));

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Authentication failed');
      expect(result.hint).toContain('Do NOT try alternative approaches');
    });
  });

  describe('WS connection', () => {
    test('connects WS after auth succeeds', async () => {
      const ctx = createMockContext();

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(true);
      expect(result.status).toBe('connected');
      expect(ctx.wsClient.connect).toHaveBeenCalled();
    });

    test('returns error with hint when WS connect fails', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.wsClient.connect).mockRejectedValue(new Error('ECONNREFUSED'));

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.success).toBe(false);
      expect(result.error).toContain('WebSocket connection failed');
      expect(result.hint).toContain('Do NOT try alternative approaches');
    });
  });

  describe('response includes device auth message', () => {
    test('forwards auth message from device auth flow', async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.authenticate).mockResolvedValue({
        token: 'device-jwt',
        method: 'device_auth',
        message: 'Please visit http://example.com to approve',
      });

      const raw = await connect({}, ctx);
      const result = JSON.parse(raw);

      expect(result.message).toContain('Please visit');
    });
  });
});
