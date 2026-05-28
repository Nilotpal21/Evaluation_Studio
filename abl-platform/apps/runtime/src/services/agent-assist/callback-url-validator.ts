/**
 * Callback URL validation for the Agent Assist V1 async-push flow.
 *
 * Defense-in-depth: validates at enqueue time (route) AND at delivery time (worker).
 * Rejects loopback, RFC1918, link-local, non-HTTPS, and configurable internal DNS deny-list.
 *
 * Dev mode: when `allowHttpLocalhost` is true, http://localhost is permitted
 * (needed for ngrok testing). Controlled via env AGENT_ASSIST_ALLOW_HTTP_CALLBACKS.
 */

export interface CallbackUrlValidationOptions {
  /**
   * Allow http://localhost for dev/ngrok mode.
   * Default: false (production).
   */
  allowHttpLocalhost?: boolean;
  /**
   * Comma-separated list of internal DNS hostnames to deny.
   * Loaded from env AGENT_ASSIST_INTERNAL_DNS_DENYLIST.
   */
  internalDnsDenyList?: string[];
}

export type CallbackUrlValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Validate a callback URL for safety (SSRF prevention).
 *
 * Rejects:
 * - non-https scheme (unless dev mode allows http://localhost)
 * - loopback addresses (127.0.0.1, ::1, 0.0.0.0) — except localhost when dev mode
 * - RFC1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - link-local (169.254.0.0/16)
 * - internal DNS deny-list entries
 */
export function validateCallbackUrl(
  url: string,
  options?: CallbackUrlValidationOptions,
): CallbackUrlValidationResult {
  const allowHttpLocalhost = options?.allowHttpLocalhost ?? false;
  const denyList = options?.internalDnsDenyList ?? [];

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Malformed URL' };
  }

  // Reject non-HTTP schemes
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: 'Only https:// URLs are allowed' };
  }

  const hostname = parsed.hostname;
  const isLocalhost = hostname === 'localhost';

  // Allow http only for localhost in dev mode
  if (parsed.protocol === 'http:') {
    if (isLocalhost && allowHttpLocalhost) {
      // Permitted — dev/ngrok mode
    } else if (isLocalhost) {
      return {
        valid: false,
        reason: 'http://localhost requires AGENT_ASSIST_ALLOW_HTTP_CALLBACKS=true',
      };
    } else {
      return { valid: false, reason: 'http:// is only allowed for localhost' };
    }
  }

  // Reject loopback (URL.hostname strips brackets from IPv6, e.g. [::1] -> ::1)
  if (
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0'
  ) {
    return { valid: false, reason: 'Loopback addresses are not allowed' };
  }

  // Reject RFC1918 private ranges
  if (hostname.startsWith('10.') || hostname.startsWith('192.168.')) {
    return { valid: false, reason: 'Private IP addresses are not allowed' };
  }
  // 172.16.0.0 - 172.31.255.255
  if (hostname.startsWith('172.')) {
    const parts = hostname.split('.');
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) {
      return { valid: false, reason: 'Private IP addresses are not allowed' };
    }
  }

  // Reject link-local
  if (hostname.startsWith('169.254.')) {
    return { valid: false, reason: 'Link-local addresses are not allowed' };
  }

  // Reject internal DNS deny-list
  if (denyList.length > 0) {
    const lowerHostname = hostname.toLowerCase();
    for (const entry of denyList) {
      const trimmed = entry.trim().toLowerCase();
      if (trimmed && lowerHostname === trimmed) {
        return { valid: false, reason: 'Internal hostname is not allowed' };
      }
    }
  }

  return { valid: true };
}

/**
 * Resolve validation options from environment variables.
 */
export function resolveValidationOptions(
  env: NodeJS.ProcessEnv = process.env,
): CallbackUrlValidationOptions {
  const allowHttpLocalhost = env.AGENT_ASSIST_ALLOW_HTTP_CALLBACKS === 'true';
  const denyListRaw = env.AGENT_ASSIST_INTERNAL_DNS_DENYLIST ?? '';
  const internalDnsDenyList = denyListRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { allowHttpLocalhost, internalDnsDenyList };
}
