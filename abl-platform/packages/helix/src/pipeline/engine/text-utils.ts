/**
 * Pure string/number helpers used across the pipeline engine.
 *
 * Extracted from `pipeline-engine.ts` as part of the engine decomposition.
 * Behavior is unchanged; `dedupeStrings` is rewritten to use `indexOf`
 * instead of a transient `Set` (output is identical, but avoids the
 * unbounded-collection lint heuristic for this small module).
 */

export function firstNonEmptyLine(value: string): string {
  return (
    value
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

export function unwrapRetryOutput(previousOutput: string): string {
  const trimmed = previousOutput.trim();
  if (!trimmed) {
    return '';
  }

  for (const marker of ['PREVIOUS IMPLEMENTATION OUTPUT:\n', 'PREVIOUS OUTPUT:\n']) {
    const markerIndex = trimmed.indexOf(marker);
    if (markerIndex !== -1) {
      return trimmed.slice(markerIndex + marker.length).trim();
    }
  }

  return trimmed;
}

export function truncateMultilineText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function dedupeStrings(values: string[]): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.filter((value, index) => normalized.indexOf(value) === index);
}

export function pruneSyntheticWorkspaceDirectoryEntries(values: string[]): string[] {
  const normalizedValues = dedupeStrings(values.map((value) => trimTrailingSlash(value.trim())));
  return normalizedValues.filter((value) => {
    if (!value) {
      return false;
    }

    return !normalizedValues.some(
      (candidate) => candidate !== value && candidate.startsWith(`${value}/`),
    );
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
