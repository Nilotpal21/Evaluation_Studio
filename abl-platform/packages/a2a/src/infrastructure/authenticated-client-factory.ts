/**
 * Authenticated A2A Client Factory
 *
 * Creates an A2AClient with custom auth headers injected into all
 * outbound requests. Works around the SDK limitation that the A2AClient
 * constructor doesn't accept auth parameters.
 *
 * Strategy: Provide the SDK with a scoped fetch implementation that injects
 * auth headers into matching outbound requests. The global fetch is never
 * patched, so concurrent A2A clients cannot observe each other's credentials.
 */

import { A2AClient } from '@a2a-js/sdk/client';
import type { AgentCard } from '@a2a-js/sdk';

// ---------------------------------------------------------------------------
// Observability context for trace propagation (lazy import to avoid hard dependency)
// ---------------------------------------------------------------------------
let _getObservabilityContext:
  | (() => { traceId: string; spanId: string } | undefined)
  | null
  | undefined;
function getObservabilityContextSafe(): { traceId: string; spanId: string } | undefined {
  if (_getObservabilityContext === null) return undefined;
  if (_getObservabilityContext) return _getObservabilityContext();
  return undefined;
}
// Use a variable so TypeScript does not try to resolve the module at compile time.
// At runtime, @abl/compiler is available when loaded inside the Runtime app.
const _obsModulePath = '@abl/compiler/platform/observability';
import(_obsModulePath)
  .then((mod: { getObservabilityContext?: typeof _getObservabilityContext }) => {
    _getObservabilityContext = mod.getObservabilityContext as typeof _getObservabilityContext;
  })
  .catch(() => {
    _getObservabilityContext = null; // @abl/compiler not available
  });

/**
 * Format a W3C traceparent header from trace/span IDs.
 * Version 00, trace-flags 01 (sampled).
 */
function formatTraceparentHeader(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

/** Auth configuration for outbound A2A calls. */
export interface OutboundAuthConfig {
  type: 'bearer' | 'api_key';
  /** The credential value (token or API key) */
  value: string;
  /** Header name. Defaults to 'Authorization' for bearer, 'X-API-Key' for api_key */
  header?: string;
}

/**
 * A fetch wrapper that injects auth headers for requests matching the target host.
 * This is a pure function — no global state mutation.
 */
function createAuthFetch(
  targetHost: string,
  headerName: string,
  headerValue: string,
  baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    let urlHost: string;
    try {
      urlHost = new URL(url).host;
    } catch {
      return baseFetch(input, init);
    }

    if (urlHost === targetHost) {
      const headers = new Headers(init?.headers);
      if (!headers.has(headerName)) {
        headers.set(headerName, headerValue);
      }
      // Inject W3C traceparent and X-Trace-Id for cross-service trace propagation
      const obsCtx = getObservabilityContextSafe();
      if (obsCtx?.traceId) {
        headers.set('traceparent', formatTraceparentHeader(obsCtx.traceId, obsCtx.spanId));
        headers.set('X-Trace-Id', obsCtx.traceId);
      }
      return baseFetch(input, { ...init, headers });
    }

    return baseFetch(input, init);
  };
}

/**
 * Creates an A2AClient that injects auth headers into all HTTP requests.
 *
 * Approach: The A2A SDK accepts a fetchImpl option for explicit agent-card
 * fetches and subsequent JSON-RPC transport requests. Seed the deprecated
 * client with a minimal card to avoid constructor-time background fetches.
 */
export function createAuthenticatedA2AClient(baseUrl: string, auth: OutboundAuthConfig): A2AClient {
  const headerName = auth.header ?? (auth.type === 'bearer' ? 'Authorization' : 'X-API-Key');
  const headerValue = auth.type === 'bearer' ? `Bearer ${auth.value}` : auth.value;

  const targetHost = new URL(baseUrl).host;
  const baseFetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch;
  const authFetch = createAuthFetch(targetHost, headerName, headerValue, baseFetch);
  const bootstrapCard: AgentCard = {
    protocolVersion: '0.3.0',
    name: 'Authenticated Remote Agent',
    description: 'Authenticated remote A2A endpoint',
    url: baseUrl,
    version: '1.0.0',
    capabilities: {},
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  };

  return new A2AClient(bootstrapCard, { fetchImpl: authFetch });
}
