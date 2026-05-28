/**
 * Runtime Server Entry Point
 */

// Load environment variables from .env file
import 'dotenv/config';

// Initialize OpenTelemetry BEFORE any other imports
import './observability/otel-setup.js';

import { createLogger } from '@abl/compiler/platform';

const debugLog = createLogger('http-debug');
const log = createLogger('runtime');

// ── HTTP Debug Interceptor (enabled via HTTP_DEBUG=true) ──────────────────────
if (process.env.HTTP_DEBUG === 'true') {
  const _origFetch = globalThis.fetch;
  globalThis.fetch = async function debugFetch(input: string | URL | Request, init?: RequestInit) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method = init?.method ?? 'GET';
    const headers = init?.headers ?? {};
    debugLog.debug('Outgoing HTTP request', { method, url, headers: JSON.stringify(headers) });
    if (init?.body) {
      try {
        const bodyStr = typeof init.body === 'string' ? init.body : init.body.toString();
        const parsed = JSON.parse(bodyStr);
        // Log model + messages count, not full body (too large)
        debugLog.debug('Request body summary', {
          model: parsed.model ?? 'N/A',
          messagesCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
          toolsCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
        });
      } catch {
        debugLog.debug('Request body non-JSON or too large');
      }
    }
    const start = Date.now();
    const res = await _origFetch(input, init);
    debugLog.debug('HTTP response received', {
      method,
      url,
      status: res.status,
      durationMs: Date.now() - start,
    });
    return res;
  } as typeof fetch;
  debugLog.debug('Fetch interceptor enabled — all outgoing HTTP calls will be logged');
}

import { loadConfig, getConfigMeta } from './config/index.js';

async function main(): Promise<void> {
  try {
    const config = await loadConfig({
      vaultType: 'env',
      throwOnError: true,
      logSummary: true,
    });

    const meta = getConfigMeta();
    if (meta && meta.validationWarnings.length > 0) {
      log.warn('Config validation warnings', { warnings: meta.validationWarnings });
    }

    const anthropicKey = config.llm.anthropicApiKey;
    log.info('API key status', { anthropicApiKeyConfigured: Boolean(anthropicKey) });

    const { startServer } = await import('./server.js');
    await startServer();
  } catch (error) {
    log.error('Failed to start runtime server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();

// Note: Graceful shutdown (server.close, WS close, DB disconnect) is
// handled by signal handlers registered in server.ts. Do NOT register
// competing handlers here that call process.exit() — they race against
// the server shutdown and prevent the port from being released cleanly.
