/**
 * Minimal SSRF guard for the Azure DI piece.
 *
 * The platform's `@agent-platform/shared-kernel` exports a richer DNS-pinning
 * `safeFetch`, but the piece is a CommonJS workspace package and can't `require`
 * the ESM shared-kernel directly. Inlining a small SSRF assertion + native
 * `fetch` keeps the piece self-contained while still covering the threat model
 * for tenant-supplied document URLs:
 *
 *   - Reject non-HTTP(S) protocols.
 *   - Reject IPv4 / IPv6 literals in private / loopback / link-local ranges.
 *   - Reject reserved hostnames (`localhost`, `metadata.google.internal`, etc.).
 *   - Resolve the hostname and re-check each resolved address.
 *
 * Tenant admins can opt-in additional hosts via `AZURE_DI_SSRF_ALLOWED_HOSTS`
 * (comma-separated) — primarily for staging/CI fixtures.
 *
 * Bounded collections: the reserved-hostnames list is a static MAX_-sized
 * array of constants; the allowed-hosts list is freshly derived per call from
 * an env var. No long-lived caches live in this module.
 */

import * as dns from 'node:dns';
import type { LookupAddress } from 'node:dns';

const PRIVATE_IPV4_PREFIXES: readonly RegExp[] = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^0\./,
  // RFC 6598 CGNAT — 100.64.0.0/10. Phase 3 Round 4 SSRF audit add.
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
];

// MAX_RESERVED_HOSTNAMES is the bounded set of well-known cloud-metadata
// / loopback names. Static, never mutated.
const RESERVED_HOSTNAMES: readonly string[] = [
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'instance-data.ec2.internal',
];

export class SSRFError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSRFError';
  }
}

function getAllowedHosts(): readonly string[] {
  const raw = process.env.AZURE_DI_SSRF_ALLOWED_HOSTS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function isPrivateOrReservedIPv4(addr: string): boolean {
  return PRIVATE_IPV4_PREFIXES.some((re) => re.test(addr));
}

/**
 * Convert a hex IPv6-mapped IPv4 tail like `7f00:1` into the dotted-quad
 * form `127.0.0.1` so the IPv4 private-range check can be applied. Returns
 * null when the tail isn't a valid 32-bit IPv6-mapped IPv4 form.
 */
function hexMappedTailToDotted(tail: string): string | null {
  if (tail.includes('.')) {
    // Already dotted-quad form (e.g., `::ffff:127.0.0.1`).
    return tail;
  }
  const parts = tail.split(':');
  if (parts.length !== 2) return null;
  const [hiHex, loHex] = parts as [string, string];
  if (!/^[0-9a-f]{1,4}$/.test(hiHex) || !/^[0-9a-f]{1,4}$/.test(loHex)) return null;
  const hi = Number.parseInt(hiHex, 16);
  const lo = Number.parseInt(loHex, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateOrReservedIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice('::ffff:'.length);
    // Round 4 SSRF audit: hex form `::ffff:7f00:1` previously bypassed the
    // IPv4 check because `isPrivateOrReservedIPv4('7f00:1')` matched none of
    // the prefixes. Normalize to dotted-quad before re-checking.
    const dotted = hexMappedTailToDotted(tail);
    return dotted !== null ? isPrivateOrReservedIPv4(dotted) : false;
  }
  return false;
}

export async function assertUrlSafeForSSRF(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SSRFError('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFError(`Only http/https protocols are allowed (got ${parsed.protocol})`);
  }
  const allowed = getAllowedHosts();
  const hostname = parsed.hostname.toLowerCase();

  if (allowed.includes(hostname)) return;

  if (RESERVED_HOSTNAMES.includes(hostname)) {
    throw new SSRFError(`Hostname ${hostname} is reserved`);
  }
  if (hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    throw new SSRFError(`Hostname suffix ${hostname} is reserved`);
  }

  // IP literal short-circuit
  if (/^[\d.]+$/.test(hostname)) {
    if (isPrivateOrReservedIPv4(hostname)) {
      throw new SSRFError(`Address ${hostname} is in a private/reserved range`);
    }
    return;
  }
  if (hostname.includes(':') || hostname.startsWith('[')) {
    const cleaned = hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (isPrivateOrReservedIPv6(cleaned)) {
      throw new SSRFError(`Address ${hostname} is in a private/reserved range`);
    }
    return;
  }

  // Resolve and check
  let addresses: LookupAddress[] = [];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SSRFError(`DNS lookup for ${hostname} failed: ${message}`);
  }
  for (const addr of addresses) {
    if (addr.family === 4 && isPrivateOrReservedIPv4(addr.address)) {
      throw new SSRFError(`Resolved address ${addr.address} for ${hostname} is private/reserved`);
    }
    if (addr.family === 6 && isPrivateOrReservedIPv6(addr.address)) {
      throw new SSRFError(`Resolved address ${addr.address} for ${hostname} is private/reserved`);
    }
  }
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * SSRF-guarded thin wrapper around the global `fetch`. Asserts the URL is safe
 * (no private addresses) BEFORE issuing the request. Note: this does not
 * implement DNS pinning — TOCTOU rebinding is mitigated only by Node's DNS
 * caching during the request. The polling Operation-Location URL produced by
 * Azure is treated as trusted (the host-match assertion in extract-document
 * provides defense-in-depth).
 */
export async function safeFetch(url: string, init: SafeFetchOptions = {}): Promise<Response> {
  await assertUrlSafeForSSRF(url);
  return fetch(url, {
    method: init.method ?? 'GET',
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}
