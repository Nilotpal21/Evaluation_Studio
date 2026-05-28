import { ipMatchesAnyCidr } from './cidr.js';
import { isInternalTrustedIP, isLocalhost } from './ssrf-validator.js';

export interface InternalNetworkRequestMetadata {
  forwardedFor?: string | null;
  realIp?: string | null;
  remoteAddress?: string | null;
  host?: string | null;
}

export interface InternalNetworkRequestOptions {
  allowLocalhostHostFallback?: boolean;
  /**
   * Extra CIDR ranges (or plain IPs) to treat as internal in addition to
   * loopback and RFC 1918. Intended for VPC customers whose ingress IPs
   * fall outside private ranges (e.g. publicly-routable blocks leased for
   * private VPC use). Defaults to parsing the `INTERNAL_NETWORK_EXTRA_CIDRS`
   * env var (comma-separated). Pass an explicit array to override.
   */
  extraInternalCidrs?: readonly string[];
}

const ENV_EXTRA_CIDRS_VAR = 'INTERNAL_NETWORK_EXTRA_CIDRS';

let _envExtraCidrsCache: { raw: string | undefined; parsed: readonly string[] } | null = null;

function getEnvExtraInternalCidrs(): readonly string[] {
  const raw = process.env[ENV_EXTRA_CIDRS_VAR];
  if (_envExtraCidrsCache && _envExtraCidrsCache.raw === raw) {
    return _envExtraCidrsCache.parsed;
  }
  const parsed = raw
    ? raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  _envExtraCidrsCache = { raw, parsed };
  return parsed;
}

function normalizeValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function extractTrustedClientIp(forwardedFor: string | null | undefined): string | null {
  const forwarded = normalizeValue(forwardedFor);
  if (!forwarded) {
    return null;
  }

  const parts = forwarded
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  return parts[0] ?? null;
}

export function normalizeHostHeader(host: string | null | undefined): string | null {
  const normalized = normalizeValue(host)?.toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('[')) {
    const closingBracketIndex = normalized.indexOf(']');
    return closingBracketIndex >= 0 ? normalized.slice(1, closingBracketIndex) : normalized;
  }

  const firstColon = normalized.indexOf(':');
  const lastColon = normalized.lastIndexOf(':');
  if (firstColon >= 0 && firstColon === lastColon) {
    return normalized.slice(0, firstColon);
  }

  return normalized;
}

export function isInternalNetworkAddress(
  value: string | null | undefined,
  extraInternalCidrs: readonly string[] = [],
): boolean {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return false;
  }

  if (isLocalhost(normalized) || isInternalTrustedIP(normalized)) {
    return true;
  }

  return ipMatchesAnyCidr(normalized, extraInternalCidrs);
}

function extractForwardedChain(forwardedFor: string | null | undefined): string[] {
  const forwarded = normalizeValue(forwardedFor);
  if (!forwarded) {
    return [];
  }

  return forwarded
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isInternalNetworkRequest(
  metadata: InternalNetworkRequestMetadata,
  options: InternalNetworkRequestOptions = {},
): boolean {
  const extraCidrs = options.extraInternalCidrs ?? getEnvExtraInternalCidrs();
  const remoteAddress = normalizeValue(metadata.remoteAddress);
  const realIp = normalizeValue(metadata.realIp);
  const forwardedChain = extractForwardedChain(metadata.forwardedFor);

  // Fail closed: forwarded headers are only meaningful when the direct peer is already internal.
  if (remoteAddress) {
    if (!isInternalNetworkAddress(remoteAddress, extraCidrs)) {
      return false;
    }

    if (realIp && !isInternalNetworkAddress(realIp, extraCidrs)) {
      return false;
    }

    if (forwardedChain.length > 0) {
      return forwardedChain.every((hop) => isInternalNetworkAddress(hop, extraCidrs));
    }

    return true;
  }

  if (realIp || forwardedChain.length > 0) {
    return false;
  }

  if (!options.allowLocalhostHostFallback) {
    return false;
  }

  const normalizedHost = normalizeHostHeader(metadata.host);
  return normalizedHost ? isLocalhost(normalizedHost) : false;
}
