/**
 * Folder Path Matcher
 *
 * Matches SharePoint folder paths against glob-like patterns.
 * Used for folder-level filtering during sync traversal.
 *
 * Supports:
 * - Exact match: "/Archive" matches only "/Archive"
 * - Wildcard segments: "/Archive/*" matches direct children of /Archive
 * - Recursive wildcard: "/Archive/**" matches all descendants of /Archive
 * - Glob patterns: "/2024/Q*" matches /2024/Q1, /2024/Q2, etc.
 *
 * All matching is case-insensitive (SharePoint folder names are case-insensitive).
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface FolderPathConfig {
  /** Folder paths to include (glob patterns). Empty = include all. */
  include: string[];
  /** Folder paths to exclude (glob patterns). Evaluated after include. */
  exclude: string[];
}

export interface FolderPathMatchResult {
  allowed: boolean;
  reason?: string;
  /** Which rule matched */
  matchedPattern?: string;
}

// ─── Matcher ────────────────────────────────────────────────────────────

export class FolderPathMatcher {
  private readonly includePatterns: CompiledPattern[];
  private readonly excludePatterns: CompiledPattern[];

  constructor(config: FolderPathConfig) {
    this.includePatterns = config.include.map((p) => compilePattern(p));
    this.excludePatterns = config.exclude.map((p) => compilePattern(p));
  }

  /**
   * Check if a folder path should be traversed during sync.
   *
   * Logic:
   * 1. If exclude patterns exist and path matches any → EXCLUDE
   * 2. If include patterns exist and path matches none → EXCLUDE
   * 3. Otherwise → INCLUDE
   *
   * Exclude always wins over include (safety-first design).
   */
  shouldTraverse(folderPath: string): FolderPathMatchResult {
    const normalizedPath = normalizePath(folderPath);

    // Check exclude patterns first (exclude wins)
    for (const pattern of this.excludePatterns) {
      if (matchPath(normalizedPath, pattern)) {
        return {
          allowed: false,
          reason: `Folder excluded by pattern: ${pattern.original}`,
          matchedPattern: pattern.original,
        };
      }
    }

    // Check include patterns (if configured)
    if (this.includePatterns.length > 0) {
      for (const pattern of this.includePatterns) {
        if (matchPath(normalizedPath, pattern)) {
          return { allowed: true, matchedPattern: pattern.original };
        }
      }
      // Include patterns exist but none matched
      return {
        allowed: false,
        reason: 'Folder not in any include pattern',
      };
    }

    // No include patterns → allow everything not excluded
    return { allowed: true };
  }

  /**
   * Check if a document path is allowed.
   * Uses the parent folder path for evaluation.
   */
  isDocumentAllowed(documentPath: string): FolderPathMatchResult {
    const parentPath = getParentPath(documentPath);
    if (!parentPath) {
      return { allowed: true };
    }
    return this.shouldTraverse(parentPath);
  }

  /**
   * Whether any folder path filters are configured.
   */
  hasFilters(): boolean {
    return this.includePatterns.length > 0 || this.excludePatterns.length > 0;
  }
}

// ─── Internal Pattern Compilation ───────────────────────────────────────

interface CompiledPattern {
  regex: RegExp;
  original: string;
  isRecursive: boolean;
}

/**
 * Compile a glob-like pattern to a RegExp.
 *
 * Supported syntax:
 * - `*` matches any characters within a single path segment (no slashes)
 * - `**` matches zero or more path segments (recursive)
 * - `?` matches exactly one character (not a slash)
 * - Literal characters are escaped for regex safety
 */
function compilePattern(pattern: string): CompiledPattern {
  const normalized = normalizePath(pattern);
  const isRecursive = normalized.includes('**');

  // Build regex from glob pattern
  let regexStr = '^';
  let i = 0;

  while (i < normalized.length) {
    const char = normalized[i];

    if (char === '*') {
      if (normalized[i + 1] === '*') {
        // ** — match zero or more path segments
        if (normalized[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        // * — match within single segment (no slashes)
        regexStr += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if ('.+^${}()|[]\\'.includes(char)) {
      // Escape regex special characters
      regexStr += '\\' + char;
      i += 1;
    } else {
      regexStr += char;
      i += 1;
    }
  }

  regexStr += '$';

  return {
    regex: new RegExp(regexStr, 'i'), // Case-insensitive
    original: pattern,
    isRecursive,
  };
}

/**
 * Match a normalized path against a compiled pattern.
 *
 * For recursive patterns (containing **), also checks if the path
 * is a parent of the pattern target (to allow traversal into matching subtrees).
 */
function matchPath(path: string, pattern: CompiledPattern): boolean {
  // Direct match
  if (pattern.regex.test(path)) {
    return true;
  }

  // For recursive patterns, check if path is an ancestor of a potential match
  // e.g., pattern "/Archive/**" should match path "/Archive" (the folder itself)
  if (pattern.isRecursive) {
    const patternBase = pattern.original.replace(/\/\*\*.*$/, '');
    const normalizedBase = normalizePath(patternBase);
    if (path.toLowerCase() === normalizedBase.toLowerCase()) {
      return true;
    }
    // Check if path starts with the base
    if (path.toLowerCase().startsWith(normalizedBase.toLowerCase() + '/')) {
      return true;
    }
  }

  return false;
}

/**
 * Normalize a folder path for consistent matching.
 * - Converts backslashes to forward slashes
 * - Ensures leading slash
 * - Removes trailing slash (except for root)
 * - Lowercases for case-insensitive matching
 */
function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, '/').toLowerCase().trim();

  // Ensure leading slash
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }

  // Remove trailing slash (except root)
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Get parent path from a document or folder path.
 */
function getParentPath(path: string): string | null {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) {
    return null;
  }
  return normalized.slice(0, lastSlash);
}
