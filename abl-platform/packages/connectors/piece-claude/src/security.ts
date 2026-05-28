const BLOCKED_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.)/;

export function assertSafeUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS URLs are allowed (got ${parsed.protocol})`);
  }
  const h = parsed.hostname;
  if (h === 'localhost' || h === '0.0.0.0' || BLOCKED_IP_RE.test(h)) {
    throw new Error('URL points to a private/reserved address and is not allowed');
  }
}

export function contentTypeFromUrl(url: string): 'document' | 'image' {
  return url.split('?')[0].toLowerCase().endsWith('.pdf') ? 'document' : 'image';
}

function resolveAnthropicMediaType(
  contentType: string | null,
  blockType: 'document' | 'image',
): string {
  if (blockType === 'document') return 'application/pdf';
  if (!contentType) return 'image/jpeg';
  const base = contentType.split(';')[0].trim().toLowerCase();
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  return allowed.includes(base) ? base : 'image/jpeg';
}

/**
 * Build an Anthropic content block for an image or PDF URL.
 *
 * URLs without query parameters use source.type:'url' (URL-native, zero download).
 * URLs that carry query parameters (presigned S3, Azure SAS, CDN signed tokens) are
 * fetched locally first so the credential-bearing query string is never forwarded to
 * Anthropic; the file is then sent as base64.
 */
export async function buildAnthropicMediaBlock(imageUrl: string): Promise<Record<string, unknown>> {
  const blockType = contentTypeFromUrl(imageUrl);
  if (!new URL(imageUrl).search) {
    return { type: blockType, source: { type: 'url', url: imageUrl } };
  }
  const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`Failed to fetch ${blockType} from URL: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const mediaType = resolveAnthropicMediaType(resp.headers.get('content-type'), blockType);
  return {
    type: blockType,
    source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
  };
}
