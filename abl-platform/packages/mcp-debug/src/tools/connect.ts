/**
 * platform_connect Tool
 *
 * Connect to the runtime server and start receiving traces.
 * Uses single serverUrl with automatic auth cascade.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { deriveUrls, isRemoteUrl } from '../utils/url.js';

export const connectSchema = z.object({
  serverUrl: z
    .string()
    .optional()
    .describe(
      'Runtime server URL (e.g. https://agents.kore.ai). Falls back to AGENTS_URL env var if not provided.',
    ),
  authToken: z
    .string()
    .optional()
    .describe(
      'JWT auth token. If not provided, authentication is automatic (stored credentials → device auth with browser launch).',
    ),
  deviceCode: z
    .string()
    .optional()
    .describe(
      'Deprecated. Device auth now auto-polls in a single call. Only needed if resuming a previously interrupted flow.',
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      'Force reconnection even if already connected. Use when the auth token has expired or you need to re-authenticate.',
    ),
  // Deprecated — kept for backward compatibility
  wsUrl: z
    .string()
    .optional()
    .describe('Deprecated: use serverUrl instead. Runtime WebSocket URL.'),
  httpUrl: z
    .string()
    .optional()
    .describe('Deprecated: use serverUrl instead. Runtime HTTP API URL.'),
});

export type ConnectArgs = z.infer<typeof connectSchema>;

const DO_NOT_RETRY_HINT = 'Do NOT try alternative approaches. Report this error to the user.';

function connectSuccess(data: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...data });
}

function connectError(error: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ success: false, error, hint: DO_NOT_RETRY_HINT, ...extra });
}

export async function connect(args: ConnectArgs, ctx: DebugContext): Promise<string> {
  const { serverUrl, wsUrl, httpUrl, authToken, deviceCode, force } = args;

  // Resolve URLs: serverUrl takes precedence, then individual (deprecated), then env defaults
  if (serverUrl) {
    const derived = deriveUrls(serverUrl);
    ctx.wsClient.setUrl(derived.wsUrl);
    ctx.httpClient.setBaseUrl(derived.httpUrl);
  } else {
    if (wsUrl) ctx.wsClient.setUrl(wsUrl);
    if (httpUrl) ctx.httpClient.setBaseUrl(httpUrl);
  }

  // If already connected: allow token refresh without full reconnect, or force full reconnect
  if (ctx.wsClient.isConnected()) {
    if (authToken && !force) {
      // New token provided — update both clients without dropping WebSocket
      ctx.httpClient.setAuthToken(authToken);
      ctx.wsClient.setAuthToken(authToken);
      return connectSuccess({
        status: 'token_refreshed',
        serverUrl: ctx.httpClient.getBaseUrl(),
        wsUrl: ctx.wsClient.getUrl(),
        message: 'Auth token updated on existing connection.',
      });
    }
    if (!force) {
      return connectSuccess({
        status: 'already_connected',
        serverUrl: ctx.httpClient.getBaseUrl(),
        wsUrl: ctx.wsClient.getUrl(),
      });
    }
    // force=true — disconnect and fall through to full reconnect
    ctx.wsClient.disconnect();
  }

  const resolvedUrl = ctx.httpClient.getBaseUrl();

  // No URL configured — tell the user how to provide one
  if (!resolvedUrl) {
    return connectError(
      'No server URL configured. Provide serverUrl parameter or set the AGENTS_URL environment variable. ' +
        'Examples: https://agents.kore.ai (prod), https://agents-dev.kore.ai (dev), http://localhost:3112 (local)',
    );
  }

  const remote = isRemoteUrl(resolvedUrl);

  // For localhost: run health check first — fast feedback if server isn't running
  // For remote: skip health check — /health may not be routed through ingress,
  // and the WebSocket connection timeout (10s) handles unreachable servers
  if (!remote) {
    const health = await ctx.httpClient.runtimeHealthCheck();
    if (!health.reachable) {
      const reason = health.error ? ` (${health.error})` : '';
      return connectError(
        `Runtime not reachable at ${resolvedUrl}${reason}. Start the runtime server with: cd apps/runtime && pnpm dev`,
        { serverUrl: resolvedUrl, errorCode: health.errorCode },
      );
    }
  }

  // Authenticate using cascade (device auth now auto-opens browser and polls in one call)
  try {
    const authResult = await ctx.authenticate({ authToken, deviceCode });

    // Connect to WebSocket
    try {
      await ctx.wsClient.connect();

      return connectSuccess({
        status: 'connected',
        serverUrl: resolvedUrl,
        wsUrl: ctx.wsClient.getUrl(),
        authMethod: authResult.method,
        message: authResult.message || 'Connected to server. Ready to receive traces.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const errorCode = (error as { code?: string }).code;
      return connectError(`WebSocket connection failed: ${message}`, {
        serverUrl: resolvedUrl,
        wsUrl: ctx.wsClient.getUrl(),
        errorCode,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const errorCode = (error as { code?: string }).code;
    return connectError(`Authentication failed: ${message}`, { serverUrl: resolvedUrl, errorCode });
  }
}
