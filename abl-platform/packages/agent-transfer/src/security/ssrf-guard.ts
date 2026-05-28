import { createLogger } from '@abl/compiler/platform';
import dns from 'node:dns/promises';

const log = createLogger('ssrf-guard');

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

const BLOCKED_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^0\./,
];
const BLOCKED_HOSTS = new Set(['localhost', '::1', '[::1]']);

/**
 * Check whether an IP address falls in a private/internal range.
 * Covers IPv4 private ranges and IPv6 loopback / unique-local.
 */
export function isPrivateIP(ip: string): boolean {
  // IPv6 checks
  if (ip === '::1' || ip === '[::1]') return true;
  if (ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) return true; // fc00::/7
  if (ip.toLowerCase().startsWith('fe80')) return true; // link-local

  // IPv4 checks
  for (const range of BLOCKED_RANGES) {
    if (range.test(ip)) return true;
  }
  return false;
}

/**
 * Synchronous URL validation — checks protocol, hostname, and IP ranges.
 * Use this when async DNS resolution is not possible (e.g., constructors).
 * For full protection including DNS rebinding, use assertAllowedUrl().
 */
export function assertAllowedUrlSync(urlString: string): void {
  const url = new URL(urlString);

  // 1. Protocol validation
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`SSRF blocked: protocol ${url.protocol} is not allowed (only https/http)`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  // 2. Blocked hostnames
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error(`SSRF blocked: ${hostname} is not allowed`);
  }

  // 3. Direct IP range check (for numeric hostnames)
  if (isPrivateIP(hostname)) {
    throw new Error(`SSRF blocked: ${hostname} falls in private range`);
  }

  // 4. Cloud metadata endpoint check
  if (hostname === '169.254.169.254') {
    throw new Error(`SSRF blocked: ${hostname} is a cloud metadata endpoint`);
  }

  log.debug('URL passed SSRF sync check', { url: urlString });
}

/**
 * Validate that a URL is safe to fetch (not targeting internal/private resources).
 *
 * Checks:
 * 1. Protocol (only https/http)
 * 2. Hostname against blocked lists
 * 3. IP range (private/internal)
 * 4. Cloud metadata endpoints
 * 5. DNS resolution (catches DNS rebinding attacks)
 */
export async function assertAllowedUrl(urlString: string): Promise<void> {
  // Run all synchronous checks first
  assertAllowedUrlSync(urlString);

  const url = new URL(urlString);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  // Skip DNS resolution for IP literals (already checked by sync validator)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    return;
  }

  // 5. DNS resolution check — catches DNS rebinding attacks
  try {
    const addresses = await dns.resolve4(hostname);
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${addr}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SSRF blocked')) {
      throw err;
    }
    throw new Error(`SSRF blocked: DNS resolution failed for ${hostname}`);
  }

  // Also check AAAA records
  try {
    const addresses = await dns.resolve6(hostname);
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        throw new Error(`SSRF blocked: ${hostname} resolves to private IPv6 ${addr}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SSRF blocked')) {
      throw err;
    }
    // AAAA records may not exist — that's fine
  }

  log.debug('URL passed SSRF check', { url: urlString });
}
