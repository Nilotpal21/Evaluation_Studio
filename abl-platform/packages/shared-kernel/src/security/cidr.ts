/**
 * IPv4 CIDR matching utilities.
 *
 * Used by the inbound internal-network guards to allowlist VPC ingress CIDRs
 * that fall outside RFC 1918 private ranges (e.g. publicly-routable ranges
 * leased for private VPC use). Pure functions, no side effects.
 */

export interface ParsedCidr {
  base: number;
  mask: number;
}

/**
 * Convert an IPv4 address string (or IPv6-mapped IPv4) to a 32-bit unsigned
 * number. Returns null on malformed input.
 */
export function ipv4ToNumber(ip: string): number | null {
  const normalised = ip.replace(/^::ffff:/i, '');
  const octets = normalised.split('.');
  if (octets.length !== 4) return null;
  let num = 0;
  for (const octet of octets) {
    if (!/^\d+$/.test(octet)) return null;
    const value = parseInt(octet, 10);
    if (Number.isNaN(value) || value < 0 || value > 255) return null;
    num = ((num << 8) | value) >>> 0;
  }
  return num;
}

/**
 * Parse a CIDR notation string into base IP (as 32-bit number) and mask.
 * Returns null if the input is not a valid IPv4 CIDR (e.g. `10.0.0.0/24`).
 */
export function parseIpv4Cidr(cidr: string): ParsedCidr | null {
  const parts = cidr.split('/');
  if (parts.length !== 2) return null;
  const ip = ipv4ToNumber(parts[0]);
  if (ip === null) return null;
  if (!/^\d+$/.test(parts[1])) return null;
  const prefix = parseInt(parts[1], 10);
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { base: (ip & mask) >>> 0, mask };
}

/**
 * Check whether `clientIp` matches a single allowlist entry. Entries can be
 * plain IPs (`10.0.0.1`) or IPv4 CIDR ranges (`160.83.0.0/16`). IPv6-mapped
 * IPv4 addresses are normalised before comparison. Returns false on any
 * malformed input.
 */
export function ipMatchesCidrEntry(clientIp: string, entry: string): boolean {
  const normalised = clientIp.replace(/^::ffff:/i, '');
  if (entry.includes('/')) {
    const cidr = parseIpv4Cidr(entry);
    if (!cidr) return false;
    const ip = ipv4ToNumber(normalised);
    if (ip === null) return false;
    return (ip & cidr.mask) >>> 0 === cidr.base;
  }
  return normalised === entry;
}

/**
 * Returns true if `clientIp` matches any entry in `entries`. An empty list
 * always returns false (no implicit allow).
 */
export function ipMatchesAnyCidr(clientIp: string, entries: readonly string[]): boolean {
  if (entries.length === 0) return false;
  return entries.some((entry) => ipMatchesCidrEntry(clientIp, entry));
}
