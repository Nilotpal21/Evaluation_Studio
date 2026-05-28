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

/**
 * Build an OpenAI image_url content object for a vision message.
 *
 * URLs without query parameters use URL-native (no download).
 * URLs with query parameters are fetched locally first so credential-bearing
 * query strings (presigned S3, Azure SAS) are never forwarded to OpenAI.
 */
export async function buildOpenAIImageContent(
  imageUrl: string,
  detail?: string,
): Promise<Record<string, unknown>> {
  const detailValue = detail ?? 'auto';
  if (!new URL(imageUrl).search) {
    return { type: 'image_url', image_url: { url: imageUrl, detail: detailValue } };
  }
  const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`Failed to fetch image from URL: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const mimeType = (resp.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  return { type: 'image_url', image_url: { url: dataUrl, detail: detailValue } };
}
