/**
 * Hawk Authentication (HTTP MAC scheme)
 *
 * Implements the Hawk HTTP authentication scheme using HMAC-based
 * signatures. No external dependencies — uses Node.js built-in `crypto`.
 *
 * @see https://github.com/mozilla/hawk
 */

import { createHmac, randomBytes } from 'node:crypto';

export interface HawkAuthConfig {
  algorithm: 'sha256' | 'sha1';
}

export interface HawkAuthSecrets {
  id: string;
  key: string;
}

export interface HawkAuthOptions {
  /** Timestamp (Unix seconds). Defaults to current time. */
  timestamp?: number;
  /** Nonce. If omitted, a random one is generated. */
  nonce?: string;
  /** Application-specific extension data. */
  ext?: string;
  /** Content type of the request body (for payload validation). */
  contentType?: string;
  /** Request body hash (for payload validation). */
  payload?: string;
}

function computePayloadHash(
  algorithm: 'sha256' | 'sha1',
  payload: string,
  contentType: string,
): string {
  const normalized = `hawk.1.payload\n${contentType}\n${payload}\n`;
  return createHmac(algorithm, '').update(normalized).digest('base64');
}

/**
 * Computes a Hawk Authorization header value.
 *
 * @returns An object with the `Authorization` header set.
 */
export function applyHawkAuth(
  config: HawkAuthConfig,
  secrets: HawkAuthSecrets,
  requestUrl: string,
  method: string,
  options: HawkAuthOptions = {},
): { headers: Record<string, string> } {
  const ts = options.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = options.nonce ?? randomBytes(6).toString('hex');

  let host: string;
  let port: string;
  let resource: string;

  try {
    const parsed = new URL(requestUrl);
    host = parsed.hostname;
    port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    resource = parsed.pathname + parsed.search;
  } catch {
    // Fallback for relative URLs
    host = 'localhost';
    port = '80';
    resource = requestUrl;
  }

  // Optional payload hash
  let hash = '';
  if (options.payload !== undefined && options.contentType) {
    hash = computePayloadHash(config.algorithm, options.payload, options.contentType);
  }

  // Normalized request string (hawk.1.header)
  const artifacts =
    [
      'hawk.1.header',
      String(ts),
      nonce,
      method.toUpperCase(),
      resource,
      host,
      port,
      hash,
      options.ext ?? '',
    ].join('\n') + '\n';

  const mac = createHmac(config.algorithm, secrets.key).update(artifacts).digest('base64');

  let authHeader = `Hawk id="${secrets.id}", ts="${ts}", nonce="${nonce}", mac="${mac}"`;

  if (hash) {
    authHeader += `, hash="${hash}"`;
  }
  if (options.ext) {
    authHeader += `, ext="${options.ext}"`;
  }

  return { headers: { Authorization: authHeader } };
}
