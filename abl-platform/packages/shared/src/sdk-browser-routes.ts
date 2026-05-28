/**
 * Browser-hosted SDK routes
 *
 * These paths are intentionally callable from third-party websites that embed
 * the Agent Platform widget. They authenticate via SDK public keys,
 * bootstrap/session tokens, and route-specific allowlists rather than Studio's
 * same-origin cookie CSRF model.
 */

const SDK_BROWSER_ROUTE_PATTERNS = [
  /^\/api\/v1\/sdk(?:\/|$)/,
  /^\/api\/projects\/[^/]+\/sessions\/[^/]+\/attachments(?:\/|$)/,
  /^\/api\/projects\/[^/]+\/sessions\/[^/]+\/messages(?:\/|$)/,
];

export function isBrowserSdkRoute(path: string): boolean {
  return SDK_BROWSER_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}
