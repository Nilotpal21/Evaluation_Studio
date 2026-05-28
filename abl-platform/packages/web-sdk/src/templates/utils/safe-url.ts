/**
 * URL Safety Validation
 *
 * Validates that URLs use safe protocols (http, https, mailto, tel).
 * Optionally allows data: URIs for images (base64-encoded).
 * Extracted from rich-renderer.ts for shared use across template renderers.
 */

/**
 * Check whether a URL uses an allowed protocol.
 *
 * Allowed protocols: `http:`, `https:`, `mailto:`, `tel:`.
 * When `allowDataImages` is true, `data:image/*;base64,...` URIs are also accepted.
 *
 * @param url - The URL string to validate
 * @param options - Optional configuration
 * @returns `true` if the URL is considered safe
 */
export function isSafeUrl(url: string, options?: { allowDataImages?: boolean }): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;

  try {
    const parsed = new URL(trimmed, 'https://agentplatform.local');
    const allowedProtocols = new Set(['http:', 'https:', 'mailto:', 'tel:']);

    if (options?.allowDataImages && parsed.protocol === 'data:') {
      return /^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed);
    }

    return allowedProtocols.has(parsed.protocol);
  } catch {
    return false;
  }
}
