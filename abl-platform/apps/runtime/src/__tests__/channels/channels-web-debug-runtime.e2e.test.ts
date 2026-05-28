import type { IncomingMessage } from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  devLogin,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import {
  WEB_DEBUG_WS_AUTH_PROTOCOL,
  buildWebDebugWSProtocols,
} from '@agent-platform/shared/websocket-auth';

describe('Internal web debug WebSocket E2E', () => {
  let harness!: RuntimeApiHarness;
  let harnessStarted = false;
  let lastUpgradeUrl: string | null = null;
  let lastProtocolHeader: string | null = null;

  const observeUpgrade = (request: IncomingMessage) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname !== '/ws') {
      return;
    }

    lastUpgradeUrl = request.url || null;
    lastProtocolHeader = Array.isArray(request.headers['sec-websocket-protocol'])
      ? request.headers['sec-websocket-protocol'].join(',')
      : (request.headers['sec-websocket-protocol'] ?? null);
  };

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
    harnessStarted = true;
    harness.server.on('upgrade', observeUpgrade);
  }, 120_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    lastUpgradeUrl = null;
    lastProtocolHeader = null;
  });

  afterAll(async () => {
    if (!harnessStarted) {
      return;
    }

    harness.server.off('upgrade', observeUpgrade);
    await harness.close();
  }, 60_000);

  test('authenticates internal /ws via subprotocol without placing the token in the URL', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('web-debug-admin'),
      uniqueSlug('tenant-web-debug'),
      uniqueSlug('project-web-debug'),
    );

    const ws = new NodeWebSocket(
      `${harness.baseUrl.replace(/^http/, 'ws')}/ws`,
      buildWebDebugWSProtocols(admin.token),
    );

    const firstMessage = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      ws.once('error', reject);
    });

    expect(firstMessage.type).toBe('info');
    expect(lastUpgradeUrl).toBe('/ws');
    expect(lastProtocolHeader).toContain(WEB_DEBUG_WS_AUTH_PROTOCOL);

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  });

  test('rejects query-string token transport on /ws without the internal auth subprotocol', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('web-debug-query-reject'),
      uniqueSlug('tenant-web-debug-query'),
      uniqueSlug('project-web-debug-query'),
    );

    // The server upgrades the connection (101) then immediately closes the WS
    // with code 4001 because the web-debug-auth subprotocol header is missing.
    const result = await new Promise<{ closeCode?: number; statusCode?: number }>(
      (resolve, reject) => {
        const ws = new NodeWebSocket(
          `${harness.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(admin.token)}`,
        );

        let settled = false;

        ws.once('unexpected-response', (_request, response) => {
          settled = true;
          resolve({ statusCode: response.statusCode });
          response.resume();
        });
        ws.once('close', (code) => {
          if (!settled) {
            settled = true;
            resolve({ closeCode: code });
          }
        });
        ws.once('error', () => {
          // The ws client may emit error after close; the rejection is asserted above.
        });
      },
    );

    const code = result.closeCode ?? result.statusCode;
    expect(code).toBe(4001);
    expect(lastUpgradeUrl).toBe(`/ws?token=${encodeURIComponent(admin.token)}`);
    expect(lastProtocolHeader).toBeNull();
  });

  test('rejects invalid internal auth tokens before the socket becomes a live session', async () => {
    // The server upgrades the connection (101) then immediately closes the WS
    // with code 4001 because the token is invalid.
    const result = await new Promise<{ closeCode?: number; statusCode?: number }>(
      (resolve, reject) => {
        const ws = new NodeWebSocket(
          `${harness.baseUrl.replace(/^http/, 'ws')}/ws`,
          buildWebDebugWSProtocols('invalid-access-token'),
        );

        let settled = false;

        ws.once('unexpected-response', (_request, response) => {
          settled = true;
          resolve({ statusCode: response.statusCode });
          response.resume();
        });
        ws.once('close', (code) => {
          if (!settled) {
            settled = true;
            resolve({ closeCode: code });
          }
        });
        ws.once('error', () => {
          // The ws client may emit error after close; the rejection is asserted above.
        });
      },
    );

    const code = result.closeCode ?? result.statusCode;
    expect(code).toBe(4001);
    expect(lastUpgradeUrl).toBe('/ws');
    expect(lastProtocolHeader).toContain(WEB_DEBUG_WS_AUTH_PROTOCOL);
  });

  test('closes authenticated /ws clients that exceed the pre-auth message buffer before tenant resolution completes', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('web-debug-preauth-buffer'),
      uniqueSlug('tenant-web-debug-buffer'),
      uniqueSlug('project-web-debug-buffer'),
    );

    const result = await new Promise<{
      opened: boolean;
      closeCode?: number;
      closeReason?: string;
    }>((resolve, reject) => {
      const ws = new NodeWebSocket(
        `${harness.baseUrl.replace(/^http/, 'ws')}/ws`,
        buildWebDebugWSProtocols(admin.token),
      );

      let opened = false;
      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error('Expected pre-auth buffer enforcement to close the socket'));
      }, 5_000);

      ws.once('open', () => {
        opened = true;
        for (let index = 0; index < 17; index += 1) {
          ws.send(JSON.stringify({ type: 'ping', index }));
        }
      });
      ws.once('close', (closeCode, reason) => {
        clearTimeout(timeout);
        resolve({
          opened,
          closeCode,
          closeReason: reason.toString(),
        });
      });
      ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    expect(result.opened).toBe(true);
    expect(result.closeCode).toBe(1008);
    expect(result.closeReason).toContain('Too many queued messages before authentication');
    expect(lastUpgradeUrl).toBe('/ws');
    expect(lastProtocolHeader).toContain(WEB_DEBUG_WS_AUTH_PROTOCOL);
  });

  test('closes internal /ws when the authenticated user has no tenant membership', async () => {
    const login = await devLogin(harness, uniqueEmail('web-debug-no-membership'));

    const result = await new Promise<{
      opened: boolean;
      infoMessages: number;
      closeCode?: number;
      closeReason?: string;
    }>((resolve, reject) => {
      const ws = new NodeWebSocket(
        `${harness.baseUrl.replace(/^http/, 'ws')}/ws`,
        buildWebDebugWSProtocols(login.accessToken),
      );

      let opened = false;
      let infoMessages = 0;

      ws.once('open', () => {
        opened = true;
      });
      ws.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        if (payload.type === 'info') {
          infoMessages += 1;
        }
      });
      ws.once('close', (closeCode, reason) => {
        resolve({
          opened,
          infoMessages,
          closeCode,
          closeReason: reason.toString(),
        });
      });
      ws.once('error', (error) => {
        reject(error);
      });
    });

    expect(result.opened).toBe(true);
    expect(result.infoMessages).toBe(0);
    expect(result.closeCode).toBe(4003);
    expect(result.closeReason).toContain('Tenant membership required');
    expect(lastUpgradeUrl).toBe('/ws');
    expect(lastProtocolHeader).toContain(WEB_DEBUG_WS_AUTH_PROTOCOL);
  });
});
