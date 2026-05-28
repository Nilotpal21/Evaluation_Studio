/**
 * AI4W SSRF-Validated File Download
 *
 * Downloads files from AI4W signed URLs with SSRF protection:
 * - Blocks private/internal IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, ::1, link-local)
 * - Allows IPs in AI4W_TRUSTED_CALLBACK_CIDRS env var (comma-separated CIDRs)
 * - DNS rebinding mitigation: resolve DNS first, validate resolved IP, then connect
 */

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import net from 'node:net';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('ai4w-ssrf');

/** Maximum file size to download (50 MB) */
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** Download timeout (30 seconds) */
const DOWNLOAD_TIMEOUT_MS = 30_000;

// =============================================================================
// CIDR PARSING
// =============================================================================

interface CIDRRange {
  address: number[];
  prefixLength: number;
  isIPv6: boolean;
}

function parseIPv4ToOctets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => parseInt(p, 10));
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
  return octets;
}

function parseIPv6ToGroups(ip: string): number[] | null {
  // Expand :: shorthand
  let expanded = ip;
  if (expanded.includes('::')) {
    const parts = expanded.split('::');
    if (parts.length > 2) return null;
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    const middle = Array(missing).fill('0');
    expanded = [...left, ...middle, ...right].join(':');
  }

  const groups = expanded.split(':');
  if (groups.length !== 8) return null;
  const parsed = groups.map((g) => parseInt(g || '0', 16));
  if (parsed.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return parsed;
}

function parseCIDR(cidr: string): CIDRRange | null {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx === -1) return null;

  const addr = cidr.slice(0, slashIdx);
  const prefix = parseInt(cidr.slice(slashIdx + 1), 10);

  if (Number.isNaN(prefix) || prefix < 0) return null;

  if (net.isIPv4(addr)) {
    if (prefix > 32) return null;
    const octets = parseIPv4ToOctets(addr);
    if (!octets) return null;
    return { address: octets, prefixLength: prefix, isIPv6: false };
  }

  if (net.isIPv6(addr)) {
    if (prefix > 128) return null;
    const groups = parseIPv6ToGroups(addr);
    if (!groups) return null;
    return { address: groups, prefixLength: prefix, isIPv6: true };
  }

  return null;
}

function ipMatchesCIDR(ip: string, cidr: CIDRRange): boolean {
  if (cidr.isIPv6) {
    const groups = parseIPv6ToGroups(ip);
    if (!groups) return false;
    return matchBits(groups, cidr.address, cidr.prefixLength, 16);
  }

  const octets = parseIPv4ToOctets(ip);
  if (!octets) return false;
  return matchBits(octets, cidr.address, cidr.prefixLength, 8);
}

function matchBits(
  ipParts: number[],
  cidrParts: number[],
  prefixLen: number,
  bitsPerPart: number,
): boolean {
  let remaining = prefixLen;
  for (let i = 0; i < ipParts.length && remaining > 0; i++) {
    const bitsToCheck = Math.min(remaining, bitsPerPart);
    const mask = ((1 << bitsToCheck) - 1) << (bitsPerPart - bitsToCheck);
    if ((ipParts[i] & mask) !== (cidrParts[i] & mask)) return false;
    remaining -= bitsToCheck;
  }
  return true;
}

// =============================================================================
// PRIVATE IP DETECTION
// =============================================================================

/**
 * Check if an IP address is in a private/internal range.
 * Blocks: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8,
 * 169.254.0.0/16, 0.0.0.0/8, ::1, fe80::/10, fc00::/7
 */
function isPrivateIP(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const octets = parseIPv4ToOctets(ip);
    if (!octets) return true; // fail closed

    const [a, b] = octets;

    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;

    return false;
  }

  if (net.isIPv6(ip)) {
    const groups = parseIPv6ToGroups(ip);
    if (!groups) return true; // fail closed

    // ::1 (loopback)
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
    // :: (unspecified)
    if (groups.every((g) => g === 0)) return true;
    // fe80::/10 (link-local)
    if ((groups[0] & 0xffc0) === 0xfe80) return true;
    // fc00::/7 (unique local)
    if ((groups[0] & 0xfe00) === 0xfc00) return true;
    // ::ffff:0:0/96 (IPv4-mapped) — check the embedded IPv4
    if (
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0xffff
    ) {
      const ipv4 = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
      return isPrivateIP(ipv4);
    }

    return false;
  }

  return true; // fail closed for unknown format
}

// =============================================================================
// TRUSTED CIDRS
// =============================================================================
//
// Rejecting overly-broad prefixes at startup enforces the HLD invariant that
// AI4W_TRUSTED_CALLBACK_CIDRS cannot be used to silently disable SSRF
// protection. Anything broader than the limits below either covers a public
// subnet too large to be a legitimate same-VPC trust boundary or outright
// disables the private-IP block (/0). Operators use multiple smaller CIDRs
// instead of widening the prefix.
const MIN_IPV4_PREFIX = 8; // reject /0 through /7
const MIN_IPV6_PREFIX = 32; // reject /0 through /31

let _trustedCIDRs: CIDRRange[] | null = null;

function parseAndValidateTrustedCIDRs(raw: string | undefined): CIDRRange[] {
  if (!raw || raw.trim() === '') return [];

  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const parsed: CIDRRange[] = [];
  for (const entry of entries) {
    const cidr = parseCIDR(entry);
    if (!cidr) {
      throw new Error(`AI4W_TRUSTED_CALLBACK_CIDRS contains an invalid CIDR entry: "${entry}"`);
    }
    const minPrefix = cidr.isIPv6 ? MIN_IPV6_PREFIX : MIN_IPV4_PREFIX;
    if (cidr.prefixLength < minPrefix) {
      throw new Error(
        `AI4W_TRUSTED_CALLBACK_CIDRS entry "${entry}" is too broad ` +
          `(prefix /${cidr.prefixLength} < /${minPrefix}). ` +
          `Broad prefixes would effectively disable SSRF protection; ` +
          `use multiple smaller CIDRs instead.`,
      );
    }
    parsed.push(cidr);
  }
  return parsed;
}

function getTrustedCIDRs(): CIDRRange[] {
  if (_trustedCIDRs !== null) return _trustedCIDRs;
  _trustedCIDRs = parseAndValidateTrustedCIDRs(process.env.AI4W_TRUSTED_CALLBACK_CIDRS);
  log.info('Loaded AI4W trusted CIDRs', { count: _trustedCIDRs.length });
  return _trustedCIDRs;
}

/**
 * Startup validation for AI4W_TRUSTED_CALLBACK_CIDRS. Call from server.ts so
 * misconfigured allowlists (unparseable entries, prefixes that effectively
 * disable SSRF) cause the pod to fail fast instead of accepting dangerous
 * config and silently trusting broad IP ranges at request time.
 *
 * Throws on invalid or overly-broad entries. Idempotent: subsequent calls
 * reuse the cached parse.
 */
export function validateAI4WTrustedCallbackCIDRs(): void {
  _trustedCIDRs = parseAndValidateTrustedCIDRs(process.env.AI4W_TRUSTED_CALLBACK_CIDRS);
  log.info('AI4W trusted CIDRs validated at startup', { count: _trustedCIDRs.length });
}

function isIPTrusted(ip: string): boolean {
  const cidrs = getTrustedCIDRs();
  return cidrs.some((cidr) => ipMatchesCIDR(ip, cidr));
}

// =============================================================================
// IP VALIDATION (exported for testing)
// =============================================================================

/**
 * Validate that a resolved IP address is safe to connect to.
 * Returns true if the IP is allowed (public or in trusted CIDRs).
 */
export function validateResolvedIP(ip: string): boolean {
  if (isIPTrusted(ip)) return true;
  return !isPrivateIP(ip);
}

// =============================================================================
// DNS RESOLUTION WITH SSRF PROTECTION
// =============================================================================

/**
 * Resolve a hostname to IP addresses and validate against SSRF policy.
 * Returns the first valid IP address.
 * Throws if all resolved IPs are private/blocked.
 */
async function resolveAndValidateHost(hostname: string): Promise<string> {
  // If hostname is already an IP, validate directly
  if (net.isIP(hostname)) {
    if (!validateResolvedIP(hostname)) {
      throw new SSRFError(`Blocked: IP ${hostname} is in a private/internal range`);
    }
    return hostname;
  }

  const results = await dns.resolve4(hostname).catch(() => [] as string[]);
  const results6 = await dns.resolve6(hostname).catch(() => [] as string[]);
  const allIPs = [...results, ...results6];

  if (allIPs.length === 0) {
    throw new SSRFError(`DNS resolution failed for hostname: ${hostname}`);
  }

  // Find the first IP that passes SSRF validation
  for (const ip of allIPs) {
    if (validateResolvedIP(ip)) {
      return ip;
    }
  }

  throw new SSRFError(`All resolved IPs for ${hostname} are in private/internal ranges`);
}

// =============================================================================
// ERROR CLASS
// =============================================================================

export class SSRFError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSRFError';
  }
}

// =============================================================================
// FILE DOWNLOAD RESULT
// =============================================================================

export interface DownloadedFile {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

// =============================================================================
// MAIN EXPORT: VALIDATE AND FETCH SIGNED URL
// =============================================================================

/**
 * Download a file from a signed URL with SSRF protection.
 *
 * 1. Parse the URL and validate the scheme (http/https only)
 * 2. Resolve DNS and validate all resolved IPs against SSRF policy
 * 3. Connect to the validated IP (DNS rebinding mitigation)
 * 4. Download the file with size and timeout limits
 *
 * @param url - The signed URL to download from
 * @param filenameHint - Optional filename hint (used if Content-Disposition is absent)
 * @returns Downloaded file buffer, content type, and filename
 * @throws SSRFError if the URL targets a private/internal IP
 */
export async function validateAndFetchSignedUrl(
  url: string,
  filenameHint?: string,
  maxSizeBytes?: number,
): Promise<DownloadedFile> {
  const effectiveMaxSize = maxSizeBytes ?? MAX_FILE_SIZE_BYTES;

  // 1. Parse and validate URL scheme
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SSRFError(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFError(`Blocked: unsupported protocol ${parsed.protocol}`);
  }

  // 2. Resolve DNS and validate IP (DNS rebinding mitigation)
  const validatedIP = await resolveAndValidateHost(parsed.hostname);

  // 3. Download file using the validated IP
  const transport = parsed.protocol === 'https:' ? https : http;
  const port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;

  return new Promise<DownloadedFile>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: validatedIP,
        port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          Host: parsed.hostname, // Preserve original Host header
          'User-Agent': 'ABL-Platform/1.0',
        },
        timeout: DOWNLOAD_TIMEOUT_MS,
        // For HTTPS, use the original hostname for SNI/certificate validation
        ...(parsed.protocol === 'https:'
          ? { servername: parsed.hostname, rejectUnauthorized: true }
          : {}),
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          res.destroy();
          reject(new SSRFError(`File download failed with status ${statusCode}`));
          return;
        }

        const contentType = res.headers['content-type'] || 'application/octet-stream';

        // Extract filename from Content-Disposition or use hint
        let filename = filenameHint ?? 'attachment';
        const disposition = res.headers['content-disposition'];
        if (disposition) {
          const match = disposition.match(/filename[*]?=(?:UTF-8''|"?)([^";]+)/i);
          if (match?.[1]) {
            filename = decodeURIComponent(match[1].replace(/"/g, ''));
          }
        }

        const chunks: Buffer[] = [];
        let totalSize = 0;

        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > effectiveMaxSize) {
            res.destroy();
            reject(new SSRFError(`File exceeds maximum size of ${effectiveMaxSize} bytes`));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType,
            filename,
          });
        });

        res.on('error', (err: Error) => {
          reject(new SSRFError(`File download stream error: ${err.message}`));
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new SSRFError('File download timed out'));
    });

    req.on('error', (err: Error) => {
      reject(new SSRFError(`File download request error: ${err.message}`));
    });

    req.end();
  });
}
