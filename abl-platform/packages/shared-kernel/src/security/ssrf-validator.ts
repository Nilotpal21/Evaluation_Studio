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

import { ipMatchesCidrEntry, ipv4ToNumber } from './cidr.js';

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
 * Private/reserved IPv4 ranges that must never be targeted.
 * Covers RFC1918, loopback, link-local, CGN, metadata, protocol/test
 * networks, benchmarking, multicast, and reserved future-use space.
 */
const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const;

/** Hostnames that must never be targeted (metadata endpoints, localhost aliases). */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.internal.',
  'metadata',
  'metadata.azure.com',
  '169.254.169.254',
  '169.254.169.253',
  '100.100.100.200',
  'fd00:ec2::254',
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

function parseEncodedIpv4Part(part: string): { value: number; encoded: boolean } | null {
  if (/^0x[0-9a-f]+$/i.test(part)) {
    return { value: parseInt(part.slice(2), 16), encoded: true };
  }

  if (/^0[0-7]+$/.test(part) && part.length > 1) {
    return { value: parseInt(part, 8), encoded: true };
  }

  if (/^\d+$/.test(part)) {
    return { value: parseInt(part, 10), encoded: false };
  }

  return null;
}

/**
 * Detect and decode IPv4 literals using decimal, octal, hex, short, or mixed
 * inet_aton-style notation (for example 0x7f000001, 0177.0.0.1, 127.1).
 */
export function decodeIpv4AddressLiteral(hostname: string): string | null {
  const parts = hostname.toLowerCase().split('.');
  if (parts.length < 1 || parts.length > 4) return null;

  const parsed = parts.map(parseEncodedIpv4Part);
  if (parsed.some((part) => part === null)) return null;

  const values = parsed.map((part) => part!.value);
  const hasEncodedSyntax = parsed.some((part) => part!.encoded) || parts.length !== 4;

  let numeric: number;
  if (values.length === 1) {
    numeric = values[0];
  } else if (values.length === 2) {
    if (values[0] > 0xff || values[1] > 0xffffff) return null;
    numeric = ((values[0] << 24) | values[1]) >>> 0;
  } else if (values.length === 3) {
    if (values[0] > 0xff || values[1] > 0xff || values[2] > 0xffff) return null;
    numeric = ((values[0] << 24) | (values[1] << 16) | values[2]) >>> 0;
  } else {
    if (values.some((value) => value > 0xff)) return null;
    if (!hasEncodedSyntax) return null;
    numeric = ((values[0] << 24) | (values[1] << 16) | (values[2] << 8) | values[3]) >>> 0;
  }

  if (numeric < 0 || numeric > 0xffffffff) return null;
  return decimalToIp(numeric);
}

/** Detect and decode hex IP notation (for example 0x7f000001 -> 127.0.0.1). */
export function decodeHexIp(hostname: string): string | null {
  if (!/^0x[0-9a-f]+$/i.test(hostname)) return null;
  return decodeIpv4AddressLiteral(hostname);
}

// ─── Core Validators ───────────────────────────────────────────────────────

/**
 * Check if an IP address is in a private/reserved range.
 * Handles IPv4, IPv6, and IPv6-mapped IPv4 addresses.
 */
export function isPrivateIP(ip: string): boolean {
  const withoutBrackets = ip.replace(/^\[|\]$/g, '');
  const withoutZone = withoutBrackets.split('%')[0];
  const cleaned = withoutZone.toLowerCase();

  const ipv4Mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(cleaned);
  if (ipv4Mapped) {
    return isPrivateIP(ipv4Mapped[1]);
  }

  const ipv4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(cleaned);
  if (ipv4MappedHex) {
    const high = parseInt(ipv4MappedHex[1], 16);
    const low = parseInt(ipv4MappedHex[2], 16);
    return isPrivateIP(
      [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff].join('.'),
    );
  }

  // IPv6 localhost / unspecified
  if (cleaned === '::1' || cleaned === '::') {
    return true;
  }

  // IPv6 ULA (fc00::/7), link-local (fe80::/10), and AWS IMDS IPv6.
  if (/^f[c-d][0-9a-f]{0,2}:/i.test(cleaned) || /^fe[89ab][0-9a-f]{0,1}:/i.test(cleaned)) {
    return true;
  }

  if (cleaned === 'fd00:ec2::254') {
    return true;
  }

  // Remove port if present (IPv4 only — do not split IPv6).
  const ipv4Candidate =
    cleaned.includes(':') && !cleaned.includes('::') ? cleaned.split(':')[0] : cleaned;
  if (ipv4ToNumber(ipv4Candidate) !== null) {
    return BLOCKED_IPV4_CIDRS.some((cidr) => ipMatchesCidrEntry(ipv4Candidate, cidr));
  }

  return false;
}

/**
 * RFC 1918 private network ranges plus loopback. This is a strict subset
 * of `BLOCKED_IPV4_CIDRS` (which also covers reserved ranges like
 * 198.51.100.0/24 and 203.0.113.0/24 that should be SSRF-blocked outbound
 * but are NOT "internal" for proxy-chain trust decisions).
 */
const INTERNAL_TRUSTED_IPV4_CIDRS = [
  '10.0.0.0/8',
  '127.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
] as const;

/**
 * Check if an IPv4 / IPv6 address belongs to RFC 1918 private space or
 * loopback. Use this — NOT `isPrivateIP` — when deciding whether a hop in
 * an `X-Forwarded-For` chain is trustworthy as an internal proxy.
 *
 * `isPrivateIP` checks the broader `BLOCKED_IPV4_CIDRS` list (which is the
 * SSRF outbound deny-list and includes reserved/test-net ranges).
 * Treating those as "internal" lets a public IP forge an internal hop.
 */
export function isInternalTrustedIP(ip: string): boolean {
  const withoutBrackets = ip.replace(/^\[|\]$/g, '');
  const withoutZone = withoutBrackets.split('%')[0];
  const cleaned = withoutZone.toLowerCase();

  const ipv4Mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(cleaned);
  if (ipv4Mapped) {
    return isInternalTrustedIP(ipv4Mapped[1]);
  }

  if (cleaned === '::1') {
    return true;
  }

  // IPv6 ULA (fc00::/7) and link-local (fe80::/10) — match the IPv4 RFC 1918 intent.
  if (/^f[c-d][0-9a-f]{0,2}:/i.test(cleaned) || /^fe[89ab][0-9a-f]{0,1}:/i.test(cleaned)) {
    return true;
  }

  const ipv4Candidate =
    cleaned.includes(':') && !cleaned.includes('::') ? cleaned.split(':')[0] : cleaned;
  if (ipv4ToNumber(ipv4Candidate) !== null) {
    return INTERNAL_TRUSTED_IPV4_CIDRS.some((cidr) => ipMatchesCidrEntry(ipv4Candidate, cidr));
  }

  return false;
}

/**
 * Check if a hostname resolves to a cloud metadata endpoint.
 */
export function isMetadataEndpoint(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const normalized = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  return [...BLOCKED_HOSTNAMES].some((host) => {
    const blocked = host.endsWith('.') ? host.slice(0, -1) : host;
    return normalized === blocked || normalized.endsWith(`.${blocked}`);
  });
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

// ─── Hostname Validation (internal, exported for testing) ─────────────────

/**
 * Validate an already-extracted hostname for SSRF safety.
 * This is the core logic shared by validateUrlForSSRF. It is exported so that
 * the decimal/octal IP decode paths — which are unreachable through Node's URL
 * parser (it pre-decodes them) — can be tested directly as defense-in-depth.
 *
 * @internal Prefer validateUrlForSSRF for full URL validation.
 */
export function validateHostnameForSSRF(
  rawHostname: string,
  options: SSRFValidationOptions = {},
): SSRFValidationResult {
  const {
    allowLocalhost = false,
    allowPrivateRanges = false,
    additionalBlockedHosts,
    additionalAllowedHosts,
  } = options;

  const safe: SSRFValidationResult = { safe: true };

  let hostname = rawHostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  // Check allowed-list first (overrides blocking)
  if (additionalAllowedHosts?.some((h) => hostname === h.toLowerCase())) {
    return safe;
  }

  // Decode obfuscated IPs
  //   Defense-in-depth: Node's URL parser already decodes decimal/octal/hex IPs
  //   (e.g. new URL('http://2130706433/').hostname === '127.0.0.1'), so these
  //   branches are unreachable via validateUrlForSSRF. They guard against
  //   non-standard parsers or direct hostname validation.
  let decodedFrom: string | undefined;

  // Decimal IP: 2130706433 → 127.0.0.1
  if (/^\d+$/.test(hostname)) {
    const decimal = Number(hostname);
    const converted = decimalToIp(decimal);
    if (converted) {
      decodedFrom = `decimal ${hostname}`;
      hostname = converted;
    }
  }

  // Hex, octal, short, and mixed IPv4 literals: 0x7f000001 → 127.0.0.1
  const literalDecoded = decodeIpv4AddressLiteral(hostname);
  if (literalDecoded) {
    const notation = /^0x/i.test(hostname)
      ? 'hex'
      : hostname.split('.').some((part) => part.startsWith('0') && part.length > 1)
        ? 'octal'
        : 'encoded';
    decodedFrom = `${notation} ${hostname}`;
    hostname = literalDecoded;
  }

  // Check additional blocked hosts
  if (additionalBlockedHosts?.some((h) => hostname === h.toLowerCase())) {
    return { safe: false, reason: `Blocked hostname: ${hostname}` };
  }

  // Localhost check
  if (isLocalhost(hostname)) {
    if (allowLocalhost) return safe;
    const suffix = decodedFrom ? ` (decoded from ${decodedFrom})` : '';
    return { safe: false, reason: `Blocked localhost connection: ${hostname}${suffix}` };
  }

  // Metadata endpoint check
  if (isMetadataEndpoint(hostname)) {
    const suffix = decodedFrom ? ` (decoded from ${decodedFrom})` : '';
    return { safe: false, reason: `Blocked cloud metadata endpoint: ${hostname}${suffix}` };
  }

  // Private/reserved IP check
  // Note: 127.x with allowLocalhost is already handled by the isLocalhost check above,
  // so no special-case needed here.
  if (!allowPrivateRanges && isPrivateIP(hostname)) {
    const suffix = decodedFrom ? ` (decoded from ${decodedFrom})` : '';
    return { safe: false, reason: `Blocked private/reserved IP address: ${hostname}${suffix}` };
  }

  return safe;
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

  // 4. Delegate hostname validation
  return validateHostnameForSSRF(parsed.hostname, options);
}

/**
 * Dev-mode SSRF options: skip localhost/private-range blocking in development/test.
 * Single source of truth — all callers use this instead of inline NODE_ENV checks.
 *
 * Private ranges are allowed only when:
 * 1. Explicit opt-in via ALLOW_SSRF_PRIVATE_RANGES=true (any environment), OR
 * 2. NODE_ENV is 'development' or 'test' (not staging, not production)
 */
export function getDevSSRFOptions(): SSRFValidationOptions {
  if (process.env.ALLOW_SSRF_PRIVATE_RANGES === 'true') {
    return { allowLocalhost: true, allowPrivateRanges: true };
  }
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    return { allowLocalhost: true, allowPrivateRanges: true };
  }
  return {};
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
