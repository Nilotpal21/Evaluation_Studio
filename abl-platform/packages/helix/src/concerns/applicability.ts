/**
 * Glob-based scope resolution for concerns.
 *
 * A concern applies to a file when the file matches at least one include
 * glob and no exclude glob. Pure deterministic string matching — no I/O.
 */

import type { Concern, ConcernScope } from './types.js';

/**
 * Convert a shell-style glob to a RegExp. Supports:
 *   *      — any run of non-slash characters
 *   **     — any run of characters including slashes
 *   ?      — single non-slash character
 *   [...]  — character class (passed through)
 *
 * Anchored at both ends. Forward slashes are the path separator.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  let i = 0;

  while (i < glob.length) {
    const ch = glob[i];

    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // ** — match across directory boundaries
        pattern += '.*';
        i += 2;
        if (glob[i] === '/') {
          i += 1;
        }
      } else {
        // * — match within a single path segment
        pattern += '[^/]*';
        i += 1;
      }
      continue;
    }

    if (ch === '?') {
      pattern += '[^/]';
      i += 1;
      continue;
    }

    if (ch === '[') {
      const close = glob.indexOf(']', i);
      if (close === -1) {
        pattern += '\\[';
        i += 1;
      } else {
        pattern += glob.slice(i, close + 1);
        i = close + 1;
      }
      continue;
    }

    if ('.+^$(){}|\\/'.includes(ch)) {
      pattern += '\\' + ch;
      i += 1;
      continue;
    }

    pattern += ch;
    i += 1;
  }

  return new RegExp('^' + pattern + '$');
}

/**
 * Normalize a file path to forward-slash form, relative to the repo root
 * if absolute. Both input forms are accepted; the matcher requires forward
 * slashes.
 */
export function normalizePath(filePath: string, repoRoot?: string): string {
  let normalized = filePath.replace(/\\/g, '/');
  if (repoRoot && normalized.startsWith(repoRoot)) {
    normalized = normalized.slice(repoRoot.length);
  }
  return normalized.replace(/^\/+/, '');
}

export function scopeMatches(scope: ConcernScope, filePath: string): boolean {
  const normalized = normalizePath(filePath);

  const excluded =
    scope.exclude?.some((pattern) => globToRegExp(pattern).test(normalized)) ?? false;
  if (excluded) {
    return false;
  }

  return scope.globs.some((pattern) => globToRegExp(pattern).test(normalized));
}

/**
 * Given a set of changed files, return the concerns that apply to any of them.
 * Order is preserved from the registry input.
 */
export function concernsApplyingTo(
  concerns: readonly Concern[],
  filePaths: readonly string[],
): Concern[] {
  const normalized = filePaths.map((p) => normalizePath(p));
  return concerns.filter((concern) =>
    normalized.some((filePath) => scopeMatches(concern.scope, filePath)),
  );
}

/**
 * For a given file, return the concerns that apply. Useful for per-file
 * finding generation.
 */
export function concernsForFile(concerns: readonly Concern[], filePath: string): Concern[] {
  return concerns.filter((concern) => scopeMatches(concern.scope, filePath));
}
