/** Shared formatting utilities for interaction timeline components. */

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * H3: Truncate string to max length with ellipsis.
 * Consolidated from duplicate definitions in InteractionStep.tsx and ToolCallContent.tsx.
 */
export function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max)}...` : str;
}
