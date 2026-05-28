/**
 * Typecheck error scope classifier.
 *
 * When the implementation gate's typecheck runs against a whole package
 * (because the package uses tsconfig project references / composite mode
 * and we can't safely scope tsc to a file subset), the output may contain
 * errors in files completely unrelated to the current audit scope or
 * slice's file contracts. Those errors are pre-existing — fixing them is
 * out of scope for this audit and looping the implementation stage trying
 * to "fix" them is wasteful (Codex doesn't have the context, and even if
 * it did, the change would be off-scope).
 *
 * This module parses tsc / pnpm-build output for `error TS\d+` lines and
 * classifies each by whether the file path falls inside the in-scope set
 * (workItem.scope ∪ current slice's fileContracts). Callers in
 * quality-gate.ts use the classification to decide whether a typecheck
 * failure should fail the gate (in-scope errors exist) or pass with a
 * note (only out-of-scope pre-existing errors).
 *
 * Pure parser + classifier — no I/O, no side effects.
 */

export interface TypecheckError {
  /** Repo-relative file path the error references. */
  file: string;
  /** 1-indexed line number when the parser captures it; undefined for errors without coords. */
  line?: number;
  /** 1-indexed column number when the parser captures it. */
  column?: number;
  /** TS diagnostic code (e.g. 2304 for "Cannot find name"). */
  code?: string;
  /** Diagnostic message excerpt. */
  message?: string;
  /** Original raw line as it appeared in tsc output. */
  raw: string;
}

export interface TypecheckClassification {
  inScopeErrors: TypecheckError[];
  outOfScopeErrors: TypecheckError[];
}

/**
 * Parse tsc / pnpm-build output for diagnostic lines. Recognizes the
 * common `<file>(<line>,<col>): error TS\d+: <message>` format that
 * `tsc --noEmit` emits, plus the bare `error TS\d+` form that pnpm or
 * vitest sometimes wrap.
 *
 * Returns ordered, deduplicated entries (two identical lines from a
 * retry shouldn't produce two findings).
 */
export function parseTypecheckErrors(output: string): TypecheckError[] {
  const errors: TypecheckError[] = [];
  const seen = new Set<string>();
  if (!output) return errors;

  const lines = output.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.replace(/\[[0-9;]*m/g, '').trimEnd();
    if (!line) continue;

    const detailed = line.match(
      /^(?<file>[^\s()]+\.(?:ts|tsx|js|jsx|cts|mts|cjs|mjs))\((?<line>\d+),(?<col>\d+)\):\s+error\s+TS(?<code>\d+):\s*(?<msg>.*)$/,
    );
    if (detailed?.groups) {
      const key = `${detailed.groups.file}:${detailed.groups.line}:${detailed.groups.col}:TS${detailed.groups.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push({
        file: detailed.groups.file,
        line: Number.parseInt(detailed.groups.line, 10),
        column: Number.parseInt(detailed.groups.col, 10),
        code: detailed.groups.code,
        message: detailed.groups.msg,
        raw: line,
      });
      continue;
    }

    const colon = line.match(
      /^(?<file>[^\s:()]+\.(?:ts|tsx|js|jsx|cts|mts|cjs|mjs)):(?<line>\d+):(?<col>\d+)\s+-\s+error\s+TS(?<code>\d+):\s*(?<msg>.*)$/,
    );
    if (colon?.groups) {
      const key = `${colon.groups.file}:${colon.groups.line}:${colon.groups.col}:TS${colon.groups.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push({
        file: colon.groups.file,
        line: Number.parseInt(colon.groups.line, 10),
        column: Number.parseInt(colon.groups.col, 10),
        code: colon.groups.code,
        message: colon.groups.msg,
        raw: line,
      });
    }
  }

  return errors;
}

/**
 * Split parsed errors by whether their file is "in scope" for the current
 * audit / slice. The caller assembles `inScopeFiles` from
 * workItem.scope plus the slice's fileContracts (when applicable).
 *
 * Matching rules:
 *   - Repo-relative file paths are normalized (leading `./` stripped).
 *   - An error matches a scope entry when the error's file path is
 *     identical to a scope entry, OR is a descendant of a directory-shape
 *     scope entry (entry without a file extension OR ending in `/`).
 *   - When `inScopeFiles` is empty, ALL errors are treated as in-scope
 *     (fail-safe: don't accidentally suppress every error when scope
 *     resolution fails).
 */
export function classifyTypecheckErrors(
  errors: TypecheckError[],
  inScopeFiles: ReadonlyArray<string>,
): TypecheckClassification {
  if (errors.length === 0) {
    return { inScopeErrors: [], outOfScopeErrors: [] };
  }

  const normalized = inScopeFiles
    .map((entry) => normalizeScopeEntry(entry))
    .filter((entry): entry is string => Boolean(entry));

  if (normalized.length === 0) {
    return { inScopeErrors: errors.slice(), outOfScopeErrors: [] };
  }

  const inScopeErrors: TypecheckError[] = [];
  const outOfScopeErrors: TypecheckError[] = [];

  for (const error of errors) {
    const file = normalizeScopeEntry(error.file);
    if (file && isInScope(file, normalized)) {
      inScopeErrors.push(error);
    } else {
      outOfScopeErrors.push(error);
    }
  }

  return { inScopeErrors, outOfScopeErrors };
}

/**
 * Build a human-readable summary of an out-of-scope-only typecheck
 * outcome. Used by the gate to emit a passing "warning"-shaped message
 * that surfaces what was suppressed.
 */
export function formatTypecheckScopeNote(classification: TypecheckClassification): string {
  const lines: string[] = [
    `typecheck: ${classification.outOfScopeErrors.length} pre-existing error(s) outside audit scope — treated as advisory.`,
  ];
  for (const error of classification.outOfScopeErrors.slice(0, 8)) {
    lines.push(`  ${error.raw.trim()}`);
  }
  if (classification.outOfScopeErrors.length > 8) {
    lines.push(`  …and ${classification.outOfScopeErrors.length - 8} more`);
  }
  return lines.join('\n');
}

function normalizeScopeEntry(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^\.\//, '').replace(/\/+$/, '');
}

function isInScope(filePath: string, scopeEntries: ReadonlyArray<string>): boolean {
  for (const entry of scopeEntries) {
    if (filePath === entry) return true;
    if (entryIsDirectoryShape(entry) && filePath.startsWith(`${entry}/`)) return true;
    // Allow file-path scope entries to match nested paths only when the
    // entry is clearly a directory (no extension). A file entry like
    // `apps/x/foo.ts` should NOT match `apps/x/foo.ts/sub/file.ts`
    // (impossible) or unrelated `apps/x/foo.ts.bak`.
  }
  return false;
}

function entryIsDirectoryShape(entry: string): boolean {
  const lastSegment = entry.includes('/') ? entry.slice(entry.lastIndexOf('/') + 1) : entry;
  return !/\.[A-Za-z0-9]+$/.test(lastSegment);
}
