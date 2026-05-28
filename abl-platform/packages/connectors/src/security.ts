/** Shared SSRF and file-fetch security utilities for the connectors package. */

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB hard cap

const BLOCKED_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.)/;
const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0']);

export function assertSafeFileUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS URLs are allowed for file props (got ${parsed.protocol})`);
  }
  if (BLOCKED_HOSTNAMES.has(parsed.hostname) || BLOCKED_IP_RE.test(parsed.hostname)) {
    throw new Error('URL points to a private/reserved address and is not allowed');
  }
}
