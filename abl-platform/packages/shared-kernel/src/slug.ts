/**
 * Shared slug generation utilities.
 *
 * Single source of truth for URL-safe slug generation across the platform.
 * Used by: project-service, workspace-service, organization-service, auth routes.
 */

/**
 * Convert a name to a URL-safe slug.
 *
 * - Lowercases the input
 * - Replaces non-alphanumeric runs with a single hyphen
 * - Strips leading/trailing hyphens (greedy — handles `---foo---`)
 * - Truncates to maxLength (default 50)
 */
export function slugify(name: string, maxLength: number = 50): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}

/**
 * Agent name validation pattern.
 *
 * Matches what the DSL parser accepts in DELEGATE/HANDOFF references (`\w+`),
 * but also requires the name to start with a letter (not a digit or underscore).
 */
export const AGENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
export const AGENT_NAME_MAX_LENGTH = 100;

/**
 * Validate an agent name against DSL parser requirements.
 * Returns an error message string, or null if valid.
 */
export function validateAgentName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return 'Agent name is required';
  }
  if (name.length > AGENT_NAME_MAX_LENGTH) {
    return `Agent name must be at most ${AGENT_NAME_MAX_LENGTH} characters`;
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    return 'Agent name must start with a letter and contain only letters, digits, and underscores';
  }
  return null;
}
