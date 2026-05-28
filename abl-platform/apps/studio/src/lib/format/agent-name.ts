/**
 * Agent Name Formatting
 *
 * Single source of truth for rendering an agent's user-facing label.
 * Studio surfaces had drifted into three different conventions for the
 * same agent slug — raw `device_support`, ALL_LOWER `device support`
 * via simple underscore replace, and ad-hoc Title Case in a few
 * places — so the same agent looked like three different agents
 * depending on the page.
 *
 * Rules:
 *   - If a non-empty `displayName` is provided, use it verbatim.
 *     (Agent records may grow a `displayName` field later; this util
 *     is forward-compat.)
 *   - Otherwise transform the slug: split on underscores, Title-Case
 *     each word, join with a space. `device_support` → "Device
 *     Support", `audit_static_agent` → "Audit Static Agent".
 *
 * Use this for any user-facing rendering of an agent's name. Do NOT
 * use it for URLs, API calls, log keys, or React `key` props — those
 * still need the raw slug.
 *
 * Audit reference: Theme 17 (Studio UI/UX audit, 2026-04-25).
 */

export function formatAgentName(slug: string, displayName?: string | null): string {
  const trimmedDisplay = displayName?.trim();
  if (trimmedDisplay) {
    return trimmedDisplay;
  }
  // Handle PascalCase / camelCase (e.g. "LoanApplicationAgent" → "Loan Application Agent")
  // by inserting a space before each uppercase letter that follows a lowercase letter or digit.
  const spaced = slug.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
