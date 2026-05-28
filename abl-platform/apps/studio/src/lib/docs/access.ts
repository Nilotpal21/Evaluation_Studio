/**
 * Domain-based access control for internal docs.
 * Pure functions — no side effects, no I/O.
 */

/**
 * Check if an email's domain is in the allowed list.
 * Case-insensitive exact match — no subdomain matching.
 */
export function checkDomainAllowed(email: string, allowedDomains: string[]): boolean {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return false;
  const domain = email.slice(atIndex + 1).toLowerCase();
  return allowedDomains.some((d) => d.toLowerCase() === domain);
}

/**
 * Parse allowed domains from env var.
 * Uses NEXT_PUBLIC_ prefix because UserMenu is a client component.
 * Domain names are not secrets.
 */
export function getAllowedDomains(): string[] {
  const envValue = process.env.NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS;
  if (!envValue || !envValue.trim()) {
    return ['kore.ai', 'kore.com'];
  }
  return envValue
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
}
