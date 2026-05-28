/**
 * URL Safety Validation
 *
 * Validates URLs against SSRF attacks by blocking cloud metadata endpoints
 * and localhost in production environments.
 */

const FORBIDDEN_HOSTS_PRODUCTION = [
  '169.254.169.254', // AWS metadata
  '100.100.100.200', // Alibaba metadata
  'metadata.google.internal', // GCP metadata
  '0.0.0.0',
  '::',
];

const LOCALHOST_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/**
 * Validate that an OUTBOUND request URL is safe from SSRF attacks.
 * This validates URLs that the application will make HTTP requests TO,
 * NOT server binding/listen addresses.
 *
 * Blocks cloud metadata endpoints (e.g., 169.254.169.254) in all environments.
 * Blocks localhost in production (unless allowLocalhost is set).
 * Blocks `0.0.0.0` because it should never be a target for outbound HTTP requests
 * (it is a valid listen address but not a meaningful outbound destination).
 */
export function validateUrlSafety(
  url: string,
  options: { allowLocalhost?: boolean } = {},
): { valid: boolean; reason?: string } {
  try {
    const parsed = new URL(url);

    // Only allow http: and https: protocols
    const ALLOWED_PROTOCOLS = ['http:', 'https:'];
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      return {
        valid: false,
        reason: `URL protocol "${parsed.protocol}" is not allowed (only http: and https: are permitted)`,
      };
    }

    // Check for IPv4-mapped IPv6 addresses (e.g., ::ffff:169.254.169.254)
    const ipv4MappedMatch = parsed.hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    const hostnameToCheck = ipv4MappedMatch ? ipv4MappedMatch[1] : parsed.hostname;

    for (const host of FORBIDDEN_HOSTS_PRODUCTION) {
      if (hostnameToCheck === host) {
        return {
          valid: false,
          reason: `URL hostname "${parsed.hostname}" is a cloud metadata endpoint (SSRF risk)`,
        };
      }
    }

    if (!options.allowLocalhost) {
      for (const host of LOCALHOST_HOSTS) {
        if (hostnameToCheck === host) {
          return {
            valid: false,
            reason: `URL hostname "${parsed.hostname}" is localhost (not allowed in production)`,
          };
        }
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
}

/**
 * Redact credentials from a URL while keeping host/port visible for debugging.
 */
export function redactUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '***';
  }
}
