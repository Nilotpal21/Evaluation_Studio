/**
 * Unified SSRF Validator
 *
 * Single canonical implementation for SSRF protection across the entire platform.
 * Consolidates logic from:
 *   - packages/shared/src/security/ip-validator.ts (basic IPv4/IPv6)
 *   - packages/compiler/.../http-tool-executor.ts (octal/decimal decode, userinfo bypass)
 *   - packages/a2a/src/infrastructure/ssrf-interceptor.ts (regex patterns)
 *
 * All outbound HTTP — tool calls, MCP connections, A2A, webhooks, OAuth endpoints —
 * should validate URLs through this module.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SSRFValidationOptions {
  /** Allow localhost/127.x connections (dev mode only) */
  allowLocalhost?: boolean;
  /** Allow private RFC 1918 ranges (internal service-to-service) */
  allowPrivateRanges?: boolean;
  /** Additional hostnames to block beyond defaults */
  additionalBlockedHosts?: string[];
  /** Hostnames to explicitly allow (overrides blocking) */
  additionalAllowedHosts?: string[];
}

export interface SSRFValidationResult {
  /** Whether the URL is safe to request */
  safe: boolean;
  /** Human-readable reason if blocked */
  reason?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * Private/reserved IP ranges that must never be targeted.
 * Covers RFC 1918, loopback, link-local, CGN, and cloud metadata.
 */
const BLOCKED_IP_PATTERNS: RegExp[] = [
  /^127\./, // Loopback
  /^10\./, // RFC 1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918 Class B
  /^192\.168\./, // RFC 1918 Class C
  /^169\.254\./, // Link-local / cloud metadata
  /^0\./, // "This" network
  /^0\.0\.0\.0$/, // Explicit all-zeros
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // Carrier-grade NAT (RFC 6598)
  /^::1$/, // IPv6 loopback
  /^::$/, // IPv6 unspecified
  /^::ffff:/i, // IPv6-mapped IPv4
  /^fc00:/i, // IPv6 unique local
  /^fe80:/i, // IPv6 link-local
];

/** Hostnames that must never be targeted (metadata endpoints, localhost aliases). */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'metadata.azure.com',
  '169.254.169.254',
  '169.254.169.253',
]);

/** Only these URL schemes are permitted for outbound requests. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// ─── IP Encoding Decoders ──────────────────────────────────────────────────

/**
 * Convert a decimal IP (e.g. 2130706433) to dotted-quad notation (127.0.0.1).
 * Returns null if the number is out of valid IPv4 range.
 */
export function decimalToIp(decimal: number): string | null {
  if (!Number.isFinite(decimal) || decimal < 0 || decimal > 0xffffffff) return null;
  return [
    (decimal >>> 24) & 0xff,
    (decimal >>> 16) & 0xff,
    (decimal >>> 8) & 0xff,
    decimal & 0xff,
  ].join('.');
}

/**
 * Detect and decode octal IP notation (e.g. 0177.0.0.01 → 127.0.0.1).
 * Returns the decoded dotted-quad if octal encoding is detected, null otherwise.
 */
export function decodeOctalIp(hostname: string): string | null {
  const octets = hostname.split('.');
  if (octets.length !== 4) return null;

  let hasOctal = false;
  const decoded: number[] = [];
  for (const octet of octets) {
    if (!/^\d+$/.test(octet)) return null;
    if (octet.length > 1 && octet.startsWith('0')) {
      hasOctal = true;
      decoded.push(parseInt(octet, 8));
    } else {
      decoded.push(parseInt(octet, 10));
    }
  }

  if (!hasOctal) return null;
  if (decoded.some((v) => isNaN(v) || v < 0 || v > 255)) return null;
  return decoded.join('.');
}

// ─── Core Validators ───────────────────────────────────────────────────────

/**
 * Check if an IP address is in a private/reserved range.
 * Handles IPv4, IPv6, and IPv6-mapped IPv4 addresses.
 */
export function isPrivateIP(ip: string): boolean {
  // IPv6 localhost (before port splitting which breaks IPv6)
  if (ip === '::1' || ip.startsWith('::ffff:127.') || ip === '::ffff:127.0.0.1') {
    return true;
  }

  // Remove port if present (IPv4 only — don't split on : for IPv6)
  const ipOnly =
    ip.includes(':') && !ip.startsWith('[') && !ip.includes('::') ? ip.split(':')[0] : ip;

  // Remove brackets for IPv6 addresses in URLs [::1]
  const cleaned = ipOnly.replace(/^\[|\]$/g, '');

  if (cleaned === '::1' || cleaned.startsWith('::ffff:127.')) {
    return true;
  }

  // Check all blocked patterns
  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(cleaned)) return true;
  }

  // IPv4 octet range validation
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = cleaned.match(ipv4Regex);
  if (match) {
    const octets = match.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return false;
  }

  return false;
}

/**
 * Check if a hostname resolves to a cloud metadata endpoint.
 */
export function isMetadataEndpoint(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return [...BLOCKED_HOSTNAMES].some((host) => lower === host || lower.endsWith(`.${host}`));
}

/**
 * Check if a hostname is a localhost variant.
 */
export function isLocalhost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower.startsWith('127.') ||
    lower.startsWith('localhost.')
  );
}

// ─── Main Validation ───────────────────────────────────────────────────────

/**
 * Validate a URL for SSRF safety.
 *
 * Returns `{ safe: true }` if the URL is safe, or `{ safe: false, reason }` if blocked.
 * Detects: private IPs, metadata endpoints, octal/decimal IP encoding,
 * userinfo bypass, non-HTTP schemes, and IPv6 edge cases.
 *
 * @example
 * ```typescript
 * const result = validateUrlForSSRF('http://0177.0.0.01/');
 * // { safe: false, reason: 'Blocked private/reserved IP address: 127.0.0.1 (decoded from octal)' }
 * ```
 */
export function validateUrlForSSRF(
  url: string,
  options: SSRFValidationOptions = {},
): SSRFValidationResult {
  const {
    allowLocalhost = false,
    allowPrivateRanges = false,
    additionalBlockedHosts,
    additionalAllowedHosts,
  } = options;

  const safe: SSRFValidationResult = { safe: true };

  // 1. Block userinfo bypass: http://evil.com@169.254.169.254/
  const authorityMatch = url.replace(/^https?:\/\//, '').split('/')[0];
  if (/@/.test(authorityMatch)) {
    return { safe: false, reason: 'Blocked URL with userinfo (@) — potential SSRF bypass' };
  }

  // 2. Parse URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }

  // 3. Protocol validation
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      safe: false,
      reason: `Blocked URL scheme: ${parsed.protocol} — only http/https allowed`,
    };
  }

  // 4. Extract and normalize hostname
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  // 5. Check allowed-list first (overrides blocking)
  if (additionalAllowedHosts?.some((h) => hostname === h.toLowerCase())) {
    return safe;
  }

  // 6. Decode obfuscated IPs
  let decodedFrom: string | undefined;

  // Decimal IP: http://2130706433/ → 127.0.0.1
  // Note: Node's URL parser already decodes these; this is defense-in-depth.
  /* v8 ignore start -- Node URL parser pre-decodes decimal/octal IPs */
  if (/^\d+$/.test(hostname)) {
    const decimal = Number(hostname);
    const converted = decimalToIp(decimal);
    if (converted) {
      decodedFrom = `decimal ${hostname}`;
      hostname = converted;
    }
  }

  // Octal IP: 0177.0.0.01 → 127.0.0.1
  const octalDecoded = decodeOctalIp(hostname);
  if (octalDecoded) {
    decodedFrom = `octal ${hostname}`;
    hostname = octalDecoded;
  }
  /* v8 ignore stop */

  // 7. Check additional blocked hosts
  if (additionalBlockedHosts?.some((h) => hostname === h.toLowerCase())) {
    return { safe: false, reason: `Blocked hostname: ${hostname}` };
  }

  // 8. Localhost check
  if (isLocalhost(hostname)) {
    if (allowLocalhost) return safe;
    const suffix = decodedFrom ? ` (decoded from ${decodedFrom})` : '';
    return { safe: false, reason: `Blocked localhost connection: ${hostname}${suffix}` };
  }

  // 9. Metadata endpoint check
  if (isMetadataEndpoint(hostname)) {
    const suffix = decodedFrom ? ` (decoded from ${decodedFrom})` : '';
    return { safe: false, reason: `Blocked cloud metadata endpoint: ${hostname}${suffix}` };
  }

  // 10. Private/reserved IP check
  if (!allowPrivateRanges) {
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        if (allowLocalhost && /^127\./.test(hostname)) continue;
        const suffix = decodedFrom ? ` (decoded from ${decodedFrom})` : '';
        return { safe: false, reason: `Blocked private/reserved IP address: ${hostname}${suffix}` };
      }
    }
  }

  return safe;
}

/**
 * Dev-mode SSRF options: skip localhost/private-range blocking in non-production.
 * Single source of truth — all callers use this instead of inline NODE_ENV checks.
 */
export function getDevSSRFOptions(): SSRFValidationOptions {
  if (process.env.NODE_ENV === 'production') return {};
  return { allowLocalhost: true, allowPrivateRanges: true };
}

/**
 * Throwing variant for backward compatibility with http-tool-executor.
 * Throws an Error if the URL is blocked; returns void if safe.
 */
export function assertUrlSafeForSSRF(url: string, options: SSRFValidationOptions = {}): void {
  const result = validateUrlForSSRF(url, options);
  if (!result.safe) {
    throw new Error(result.reason);
  }
}
