/**
 * getDiagnostics — Return parse errors and warnings with line/column positions.
 *
 * Three tiers of diagnostics:
 *   Tier 1 (syntax): YAML/legacy parse errors caught by the parser
 *   Tier 2 (structural): Parser warnings (e.g., unknown mode, unknown tool type)
 *   Tier 3 (compile): Optional compile-level validation via injected compileFn
 */

import { detectFormat } from './detect-format.js';
import { parseYamlABL, parseAgentBasedABL } from '@abl/core';
import type { Diagnostic, CompileFn } from './types.js';

interface DiagnosticsOptions {
  compileFn?: CompileFn;
}

export function getDiagnostics(source: string, options?: DiagnosticsOptions): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (typeof source !== 'string') {
    diagnostics.push({
      severity: 'error',
      message: `Cannot diagnose non-string ABL source (received ${source === null ? 'null' : typeof source}).`,
      line: 1,
      column: 1,
      source: 'syntax',
    });
    return diagnostics;
  }
  const format = detectFormat(source);

  try {
    if (format === 'yaml') {
      const result = parseYamlABL(source);

      // Tier 1: parse errors
      for (const err of result.errors) {
        diagnostics.push({
          severity: 'error',
          message: err.message,
          line: err.line,
          column: err.column,
          source: 'syntax',
        });
      }

      // Tier 2: parse warnings
      for (const warn of result.warnings) {
        diagnostics.push({
          severity: 'warning',
          message: warn.message,
          line: warn.line,
          column: 1,
          source: 'syntax',
        });
      }
    } else {
      const result = parseAgentBasedABL(source);

      // Tier 1: parse errors
      for (const err of result.errors) {
        diagnostics.push({
          severity: 'error',
          message: err.message,
          line: err.line,
          column: err.column,
          source: 'syntax',
        });
      }

      // Tier 2: parse warnings
      for (const warn of result.warnings) {
        diagnostics.push({
          severity: 'warning',
          message: warn.message,
          line: warn.line,
          column: 1,
          source: 'syntax',
        });
      }
    }
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      message: err instanceof Error ? err.message : String(err),
      line: 1,
      column: 1,
      source: 'syntax',
    });
  }

  // Tier 3: compile diagnostics (optional)
  if (options?.compileFn) {
    try {
      diagnostics.push(...options.compileFn(source));
    } catch {
      // Compile errors should not crash diagnostics
    }
  }

  return diagnostics;
}
