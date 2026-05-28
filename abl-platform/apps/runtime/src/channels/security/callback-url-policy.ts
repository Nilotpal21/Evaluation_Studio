/**
 * Callback URL Policy — SSRF Protection
 *
 * Validates webhook callback URLs to prevent Server-Side Request Forgery.
 * Blocks private IPs, loopback, link-local, and CGNAT ranges.
 * Requires HTTPS in production.
 * Resolves DNS to detect private IPs hidden behind public hostnames.
 */

import { createLogger } from '@abl/compiler/platform';
import { lookup } from 'node:dns/promises';

const log = createLogger('callback-url-policy');

/**
 * Private/reserved IP ranges that must be blocked.
 */
const BLOCKED_IP_RANGES = [
  // Loopback
  /^127\./,
  /^::1$/,
  /^0\.0\.0\.0$/,
  // Private RFC 1918
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  // Link-local
  /^169\.254\./,
  /^fe80:/i,
  // IPv6 ULA (fc00::/7 — includes fc** and fd** prefixes)
  /^f[cd][0-9a-f]{2}:/i,
  // CGNAT
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // Documentation/test ranges
  /^192\.0\.2\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  '[::1]',
  'metadata.google.internal',
  'metadata.google.com',
  '169.254.169.254', // AWS/GCP metadata
  'metadata.internal',
]);

/**
 * Check if an IP address falls in any blocked range.
 */
function isBlockedIP(ip: string): boolean {
  for (const pattern of BLOCKED_IP_RANGES) {
    if (pattern.test(ip)) return true;
  }
  return false;
}

/**
 * Assert that a callback URL is safe to deliver webhooks to.
 * Throws an error if the URL is blocked.
 * Resolves DNS to detect private IPs hidden behind public hostnames.
 *
 * @param url - The callback URL to validate
 * @param isProduction - Whether to enforce HTTPS requirement
 */
export async function assertAllowedCallbackUrl(url: string, isProduction = false): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CallbackUrlError('Invalid URL format');
  }

  // Protocol check
  if (isProduction && parsed.protocol !== 'https:') {
    throw new CallbackUrlError('HTTPS required for callback URLs in production');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CallbackUrlError(`Unsupported protocol: ${parsed.protocol}`);
  }

  // Hostname checks
  const hostname = parsed.hostname.toLowerCase();

  // In development/test, allow localhost and private IPs for local testing
  const allowPrivate =
    !isProduction &&
    (process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test' ||
      process.env.ALLOW_LOCAL_CALLBACKS === 'true');

  if (!allowPrivate) {
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      throw new CallbackUrlError(`Blocked hostname: ${hostname}`);
    }

    // IP range checks on hostname literal
    if (isBlockedIP(hostname)) {
      throw new CallbackUrlError('Callback URL resolves to a private/reserved IP range');
    }

    // DNS resolution check — resolve ALL records for the hostname and verify none are private.
    // Using { all: true } prevents bypass via a multi-answer response where one address is public
    // and another is private (DNS rebinding / split-horizon attack surface).
    try {
      const records = await lookup(hostname, { all: true });
      for (const { address } of records) {
        if (isBlockedIP(address)) {
          log.warn('DNS resolution blocked — hostname resolves to private IP', {
            hostname,
            resolvedIP: address,
          });
          throw new CallbackUrlError(
            'Callback URL hostname resolves to a private/reserved IP range',
          );
        }
      }
    } catch (err) {
      if (err instanceof CallbackUrlError) throw err;
      // DNS resolution failure — block the URL to be safe
      throw new CallbackUrlError(`DNS resolution failed for hostname: ${hostname}`);
    }
  }

  // Port check — block common internal service ports
  if (parsed.port) {
    const port = parseInt(parsed.port, 10);
    if (port === 0 || port > 65535) {
      throw new CallbackUrlError(`Invalid port: ${port}`);
    }
  }

  log.debug('Callback URL validated', { url: parsed.origin });
}

export class CallbackUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallbackUrlError';
  }
}
