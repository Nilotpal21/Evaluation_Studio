/**
 * Query helper utilities for safe MongoDB queries
 */

/** Escape special regex characters to prevent ReDoS */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Allowed sort fields for KB list queries */
export const ALLOWED_KB_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'status'] as const;
export type KBSortField = (typeof ALLOWED_KB_SORT_FIELDS)[number];
