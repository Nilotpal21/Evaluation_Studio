/**
 * Digest Authentication (RFC 2617 / RFC 7616)
 *
 * Computes the Digest auth response header using MD5 or SHA-256.
 * No external dependencies — uses Node.js built-in `crypto`.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface DigestAuthConfig {
  realm: string;
}

export interface DigestAuthSecrets {
  username: string;
  password: string;
}

export interface DigestAuthOptions {
  /** Server-provided nonce. If omitted, a client nonce is generated. */
  nonce?: string;
  /** Hash algorithm: 'md5' (default) or 'sha-256'. */
  algorithm?: 'md5' | 'sha-256';
  /** Quality of protection. Defaults to 'auth'. */
  qop?: 'auth' | 'auth-int';
  /** Nonce count. Defaults to '00000001'. */
  nc?: string;
  /** Opaque value returned by server. */
  opaque?: string;
}

function hash(algorithm: 'md5' | 'sha-256', data: string): string {
  const alg = algorithm === 'sha-256' ? 'sha256' : 'md5';
  return createHash(alg).update(data).digest('hex');
}

/**
 * Computes a Digest Authorization header value.
 *
 * @returns An object with the `Authorization` header set.
 */
export function applyDigestAuth(
  config: DigestAuthConfig,
  secrets: DigestAuthSecrets,
  requestUrl: string,
  method: string,
  options: DigestAuthOptions = {},
): { headers: Record<string, string> } {
  const algorithm = options.algorithm ?? 'md5';
  const qop = options.qop ?? 'auth';
  const nc = options.nc ?? '00000001';
  const nonce = options.nonce ?? randomBytes(16).toString('hex');
  const cnonce = randomBytes(16).toString('hex');

  // Parse URI path from full URL
  let uri: string;
  try {
    const parsed = new URL(requestUrl);
    uri = parsed.pathname + parsed.search;
  } catch {
    // If not a valid URL, use as-is (could be a relative path)
    uri = requestUrl;
  }

  // HA1 = H(username:realm:password)
  const ha1 = hash(algorithm, `${secrets.username}:${config.realm}:${secrets.password}`);

  // HA2 = H(method:uri)
  const ha2 = hash(algorithm, `${method.toUpperCase()}:${uri}`);

  // response = H(HA1:nonce:nc:cnonce:qop:HA2)
  const response = hash(algorithm, `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  const algLabel = algorithm === 'sha-256' ? 'SHA-256' : 'MD5';

  let authHeader =
    `Digest username="${secrets.username}", realm="${config.realm}", ` +
    `nonce="${nonce}", uri="${uri}", algorithm=${algLabel}, ` +
    `qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;

  if (options.opaque) {
    authHeader += `, opaque="${options.opaque}"`;
  }

  return { headers: { Authorization: authHeader } };
}
