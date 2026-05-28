export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const BLOCKED_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.)/;
const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0']);

export function assertSafeFileUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid file URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS URLs are allowed for file uploads (got ${parsed.protocol})`);
  }
  if (BLOCKED_HOSTNAMES.has(parsed.hostname) || BLOCKED_IP_RE.test(parsed.hostname)) {
    throw new Error('File URL points to a private/reserved address and is not allowed');
  }
}
