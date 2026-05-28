/**
 * HTTP Connector
 *
 * Native connector for making HTTP requests. Props mirror the existing
 * HttpToolFormData from packages/shared. Auth, proxy, secrets, and
 * resilience are handled by the caller (ConnectorToolExecutor resolves
 * credentials; the workflow engine's HTTP executor handles retries).
 *
 * This connector provides a thin wrapper that validates inputs and
 * executes HTTP requests with SSRF protection.
 */

import type { Connector, ActionContext } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('http-connector');
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB

export const httpConnector: Connector = {
  name: 'http',
  displayName: 'HTTP Request',
  version: '1.0.0',
  description: 'Make HTTP requests to any URL with configurable auth, headers, and retry.',
  auth: { type: 'none' },
  triggers: [],
  actions: [
    {
      name: 'request',
      displayName: 'HTTP Request',
      description: 'Send an HTTP request and return the response.',
      props: [
        { name: 'url', displayName: 'URL', type: 'string', required: true },
        {
          name: 'method',
          displayName: 'Method',
          type: 'dropdown',
          required: true,
          defaultValue: 'GET',
          options: HTTP_METHODS.map((m) => ({ label: m, value: m })),
        },
        {
          name: 'headers',
          displayName: 'Headers',
          type: 'json',
          required: false,
          description: 'JSON object of headers',
        },
        {
          name: 'body',
          displayName: 'Body',
          type: 'json',
          required: false,
          description: 'Request body (JSON)',
        },
        {
          name: 'query_params',
          displayName: 'Query Parameters',
          type: 'json',
          required: false,
          description: 'JSON object of query params',
        },
        {
          name: 'timeout_ms',
          displayName: 'Timeout (ms)',
          type: 'number',
          required: false,
          defaultValue: DEFAULT_TIMEOUT_MS,
        },
        {
          name: 'auth_type',
          displayName: 'Auth Type',
          type: 'dropdown',
          required: false,
          defaultValue: 'none',
          options: [
            { label: 'None', value: 'none' },
            { label: 'Bearer Token', value: 'bearer' },
            { label: 'API Key', value: 'api_key' },
            { label: 'OAuth2 (Client Credentials)', value: 'oauth2_client' },
            { label: 'Custom Headers', value: 'custom' },
          ],
        },
        {
          name: 'auth_config',
          displayName: 'Auth Config',
          type: 'json',
          required: false,
          description: 'Auth-specific configuration',
        },
        {
          name: 'retry_count',
          displayName: 'Retry Count',
          type: 'number',
          required: false,
          defaultValue: 0,
        },
        {
          name: 'retry_delay_ms',
          displayName: 'Retry Delay (ms)',
          type: 'number',
          required: false,
          defaultValue: 1000,
        },
      ],
      async run(ctx: ActionContext): Promise<unknown> {
        const params = ctx.params as Record<string, unknown>;
        const url = params.url as string;
        if (!url) throw new Error('HTTP connector: url is required');

        const method = ((params.method as string) ?? 'GET').toUpperCase();
        if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) {
          throw new Error(`HTTP connector: unsupported method '${method}'`);
        }

        // Build URL with query params
        const targetUrl = new URL(url);
        const queryParams = params.query_params as Record<string, string> | undefined;
        if (queryParams && typeof queryParams === 'object') {
          for (const [key, value] of Object.entries(queryParams)) {
            targetUrl.searchParams.set(key, String(value));
          }
        }

        // SSRF protection: block private/internal IPs
        assertNotPrivateUrl(targetUrl);

        // Build headers
        const headers: Record<string, string> = { 'User-Agent': 'ABL-HTTP-Connector/1.0' };
        const customHeaders = params.headers as Record<string, string> | undefined;
        if (customHeaders && typeof customHeaders === 'object') {
          for (const [key, value] of Object.entries(customHeaders)) {
            headers[key] = String(value);
          }
        }

        // Apply auth from connection credentials (resolved by ConnectorToolExecutor)
        applyAuth(
          headers,
          ctx.auth,
          params.auth_type as string | undefined,
          params.auth_config as Record<string, string> | undefined,
        );

        // Build request body
        let body: string | undefined;
        if (params.body !== undefined && method !== 'GET' && method !== 'DELETE') {
          body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
          if (!headers['content-type'] && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
          }
        }

        const timeoutMs = (params.timeout_ms as number) ?? DEFAULT_TIMEOUT_MS;
        const retryCount = (params.retry_count as number) ?? 0;
        const retryDelayMs = (params.retry_delay_ms as number) ?? 1000;

        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= retryCount; attempt++) {
          try {
            const response = await fetch(targetUrl.toString(), {
              method,
              headers,
              body,
              signal: AbortSignal.timeout(timeoutMs),
              redirect: 'follow',
            });

            // Read response with size limit
            const contentLength = response.headers.get('content-length');
            if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
              throw new Error(
                `Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_SIZE})`,
              );
            }

            const responseText = await response.text();
            const contentType = response.headers.get('content-type') ?? '';

            let responseBody: unknown;
            if (contentType.includes('application/json')) {
              try {
                responseBody = JSON.parse(responseText);
              } catch {
                responseBody = responseText;
              }
            } else {
              responseBody = responseText;
            }

            return {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: responseBody,
              ok: response.ok,
            };
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt < retryCount) {
              await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
            }
          }
        }

        throw lastError ?? new Error('HTTP request failed');
      },
    },
  ],
};

/** Apply auth credentials to request headers. */
function applyAuth(
  headers: Record<string, string>,
  connectionAuth: Record<string, unknown> | undefined,
  authType: string | undefined,
  authConfig: Record<string, string> | undefined,
): void {
  // Prefer connection-resolved auth (from ConnectorToolExecutor)
  if (connectionAuth) {
    const accessToken = connectionAuth.accessToken as string | undefined;
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
      return;
    }
    const apiKey = connectionAuth.apiKey as string | undefined;
    if (apiKey) {
      const headerName = (connectionAuth.headerName as string) ?? 'X-API-Key';
      headers[headerName] = apiKey;
      return;
    }
  }

  // Fall back to inline auth config from step params
  if (!authType || authType === 'none' || !authConfig) return;

  switch (authType) {
    case 'bearer':
      if (authConfig.token) headers['Authorization'] = `Bearer ${authConfig.token}`;
      break;
    case 'api_key':
      if (authConfig.key) {
        const headerName = authConfig.headerName ?? 'X-API-Key';
        headers[headerName] = authConfig.key;
      }
      break;
    case 'custom':
      if (authConfig.customHeaders) {
        try {
          const parsed =
            typeof authConfig.customHeaders === 'string'
              ? JSON.parse(authConfig.customHeaders)
              : authConfig.customHeaders;
          Object.assign(headers, parsed);
        } catch (err) {
          log.warn('Failed to parse custom auth headers', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      break;
  }
}

/** SSRF protection: reject requests to private/internal IP ranges. */
function assertNotPrivateUrl(url: URL): void {
  const hostname = url.hostname.toLowerCase();

  // Block localhost and common internal hostnames
  if (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error(`HTTP connector: requests to ${hostname} are blocked (SSRF protection)`);
  }

  // Block cloud metadata endpoints
  if (hostname === 'metadata.google.internal') {
    throw new Error(`HTTP connector: requests to cloud metadata are blocked (SSRF protection)`);
  }

  // Block private/reserved IPv4 ranges (RFC 1918 + link-local + loopback + metadata)
  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (
      a === 0 || // 0.0.0.0/8 — current network
      a === 10 || // 10.0.0.0/8 — RFC 1918
      a === 127 || // 127.0.0.0/8 — loopback
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 — RFC 1918
      (a === 192 && b === 168) || // 192.168.0.0/16 — RFC 1918
      (a === 169 && b === 254) // 169.254.0.0/16 — link-local + cloud metadata
    ) {
      throw new Error(
        `HTTP connector: requests to private IP ${hostname} are blocked (SSRF protection)`,
      );
    }
  }

  // Block IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1, ::ffff:10.0.0.1)
  const v6MappedMatch = hostname.match(/^\[?::ffff:(\d+\.\d+\.\d+\.\d+)\]?$/i);
  if (v6MappedMatch) {
    throw new Error(
      `HTTP connector: requests to IPv4-mapped IPv6 ${hostname} are blocked (SSRF protection)`,
    );
  }
}
