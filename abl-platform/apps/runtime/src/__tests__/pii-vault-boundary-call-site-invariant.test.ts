/**
 * Cross-Call-Site Invariant: every production caller of
 * `restorePIITokensForToolExecution` (or its `*Text` convenience wrapper)
 * MUST pass an `auditContext` so the choke-point audit emission can fire.
 *
 * This test is a regression guard for the F-1 architectural fix. The fix
 * moved `pii_plaintext_dispensed` audit emission INTO the function itself
 * so the 6 call sites no longer have to remember to emit. If a future
 * caller forgets `auditContext`, plaintext PII would be dispensed without
 * an audit trail — violating FR-5 ("every plaintext dispense is audit-logged").
 *
 * Approach: read each known production caller via fs, find every call to the
 * function, and assert `auditContext` appears within ~500 chars after the
 * call (i.e., inside the options object literal). This is a lexical guard,
 * not an AST-aware one — if a caller assigns options to a variable and
 * passes that variable, add an `// pii-audit-context-ok` comment on the
 * call line to whitelist it. The test will accept the comment as proof of
 * intent.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_RUNTIME_ROOT = resolve(__dirname, '..');

/**
 * Every production file allowed to call `restorePIITokensForToolExecution`.
 * If you add a new caller, add the file path here AND ensure it passes
 * `auditContext` at every call site.
 */
const KNOWN_CALLERS: readonly string[] = [
  'routes/internal-tools.ts',
  'services/execution/reasoning-executor.ts',
  'services/execution/routing-executor.ts',
  'services/execution/hook-executor.ts',
  // pii-tool-execution.ts itself is the definition site (Text wrapper calls
  // the main fn) and is allowed to omit auditContext from its internal wrapper.
];

const FN_NAMES = ['restorePIITokensForToolExecution', 'restorePIITokensForToolExecutionText'];
const LOOKAHEAD = 500;
const ALLOWLIST_COMMENT = 'pii-audit-context-ok';

/** Find every call site of the named functions in `source`, return an array
 *  of `{ fnName, callIndex }` for the opening `(` of each call. */
function findCallSites(source: string): Array<{ fnName: string; callIndex: number }> {
  const sites: Array<{ fnName: string; callIndex: number }> = [];
  for (const fnName of FN_NAMES) {
    let from = 0;
    while (true) {
      // Match the function name followed by `(` (allowing whitespace) and not
      // preceded by an identifier char (so we don't match `restorePIITokensForToolExecutionText`
      // when scanning for `restorePIITokensForToolExecution`).
      const idx = source.indexOf(`${fnName}(`, from);
      if (idx === -1) break;
      const prevChar = idx > 0 ? source[idx - 1] : '';
      const isIdentifierBoundary = !/[A-Za-z0-9_$]/.test(prevChar);
      // Also reject if the next chars extend the identifier — e.g. when
      // scanning for the shorter name and we hit the `Text` variant.
      const after = source.slice(idx + fnName.length);
      const isCallOpen = after.startsWith('(');
      if (isIdentifierBoundary && isCallOpen) {
        sites.push({ fnName, callIndex: idx });
      }
      from = idx + fnName.length;
    }
  }
  return sites;
}

/** Lexically check whether the call at `callIndex` passes `auditContext`
 *  (or is whitelisted via an inline allowlist comment). */
function callPassesAuditContext(
  source: string,
  callIndex: number,
  fnName: string,
): { ok: true } | { ok: false; reason: string } {
  // Examine the LOOKAHEAD window starting at the call.
  const windowText = source.slice(callIndex, callIndex + LOOKAHEAD);
  if (windowText.includes(ALLOWLIST_COMMENT)) {
    return { ok: true };
  }
  if (windowText.includes('auditContext')) {
    return { ok: true };
  }
  // Build a short snippet for the error message.
  const lineStart = source.lastIndexOf('\n', callIndex) + 1;
  const lineEnd = source.indexOf('\n', callIndex);
  const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
  return {
    ok: false,
    reason: `\`${fnName}\` call without \`auditContext\` (or \`${ALLOWLIST_COMMENT}\` comment): ${line}`,
  };
}

describe('cross-call-site invariant: restorePIITokensForToolExecution must receive auditContext', () => {
  for (const relativePath of KNOWN_CALLERS) {
    it(`every call in ${relativePath} passes auditContext`, () => {
      const fullPath = resolve(REPO_RUNTIME_ROOT, relativePath);
      const source = readFileSync(fullPath, 'utf8');
      const sites = findCallSites(source);
      if (sites.length === 0) {
        throw new Error(
          `${relativePath} is registered as a known caller but contains no call sites — ` +
            `remove it from KNOWN_CALLERS or restore the call.`,
        );
      }
      const failures: string[] = [];
      for (const site of sites) {
        const verdict = callPassesAuditContext(source, site.callIndex, site.fnName);
        if (!verdict.ok) failures.push(verdict.reason);
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }

  // DFA-M1 regression: Tool Test must wire onTraceEvent so trace events
  // (pii_plaintext_dispensed, pii_pattern_override_suppressed_original) fire
  // for Tool Test invocations, not just the PIIAuditLogger path.
  it('Tool Test call site (internal-tools.ts) includes onTraceEvent in auditContext', () => {
    const fullPath = resolve(REPO_RUNTIME_ROOT, 'routes/internal-tools.ts');
    const source = readFileSync(fullPath, 'utf8');
    const sites = findCallSites(source);
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      const window = source.slice(site.callIndex, site.callIndex + LOOKAHEAD);
      expect(window, 'DFA-M1: onTraceEvent must be present in Tool Test auditContext').toContain(
        'onTraceEvent',
      );
    }
  });

  it('unknown production callers are detected (no orphan call sites)', () => {
    // Sanity: ensure no production file under runtime/src calls the function
    // outside the KNOWN_CALLERS allowlist. This catches future engineers
    // adding a caller without updating this test.
    //
    // Implemented as a directory walk to avoid heavy globbing deps.
    const orphans = scanForOrphanCallers(REPO_RUNTIME_ROOT, KNOWN_CALLERS);
    expect(orphans, `Unknown callers detected: ${orphans.join(', ')}`).toEqual([]);
  });
});

function scanForOrphanCallers(root: string, allowed: readonly string[]): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const allowedSet = new Set(allowed.map((p) => resolve(root, p)));
  const orphans: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      // Skip tests, node_modules, dist, and the definition file itself.
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      if (entry.name === 'pii-tool-execution.ts') {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
        continue;
      }
      const source = fs.readFileSync(full, 'utf8');
      const hits = findCallSites(source);
      if (hits.length > 0 && !allowedSet.has(full)) {
        orphans.push(full.replace(root + '/', ''));
      }
    }
  }

  walk(root);
  return orphans;
}
