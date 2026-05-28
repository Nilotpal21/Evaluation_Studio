/**
 * Validate and sanitize path parameters to prevent path traversal.
 * Rejects values containing /, .., or URL-encoded variants.
 */
export function validatePathParam(value: string, name: string): string {
  if (!value || /[\/\\]|\.\./.test(value) || /%2[fF]|%5[cC]|%2[eE]/.test(value)) {
    throw new Error(`Invalid ${name}: must not contain path separators or traversal sequences`);
  }
  return encodeURIComponent(value);
}
