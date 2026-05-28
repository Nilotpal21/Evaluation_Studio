/**
 * parseTokenResponse
 *
 * OAuth providers are supposed to return JSON but several (GitHub, Bitbucket,
 * Shopify, older SaaS) return application/x-www-form-urlencoded instead.
 * This helper reads the raw response text and normalises it to a plain object
 * regardless of Content-Type.
 *
 * Always pass `Accept: application/json` in the request — providers that
 * support JSON will use it; this fallback handles the ones that ignore it.
 */

export async function parseTokenResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error('OAuth provider returned malformed JSON in token response');
    }
  }

  // Detect HTML error pages (Cloudflare, gateway errors) before falling through
  // to URLSearchParams — parsing HTML produces garbage keys, not a useful object.
  if (text.trimStart().startsWith('<')) {
    throw new Error(
      `OAuth provider returned an unexpected HTML response (status ${res.status}) — check the token endpoint URL and provider status`,
    );
  }

  // Form-encoded fallback: access_token=...&token_type=bearer&scope=...
  return Object.fromEntries(new URLSearchParams(text).entries());
}
