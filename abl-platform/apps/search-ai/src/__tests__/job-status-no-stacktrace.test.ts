import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for ABLP-577 (audit finding I2).
 *
 * The BullMQ job-status endpoints in `kg-enrichment.ts` and `kg-taxonomy.ts`
 * used to copy `job.stacktrace[0]` onto the API response, leaking internal
 * file paths and module names to any authenticated caller. This test fails
 * if the pattern is re-introduced.
 *
 * Static assertion (not a route-level test) because asserting an integration
 * behaviour here would require spinning up Redis and BullMQ for a single
 * negative-space property; the source-level guard is cheaper and equally
 * effective at catching accidental regressions.
 */

const ROUTES_DIR = path.resolve(import.meta.dirname, '..', 'routes');

const FILES_TO_GUARD = ['kg-enrichment.ts', 'kg-taxonomy.ts'];

describe('job-status responses do not leak stack traces', () => {
  it.each(FILES_TO_GUARD)('%s does not assign job.stacktrace into the response', async (file) => {
    const source = await readFile(path.join(ROUTES_DIR, file), 'utf8');
    expect(source).not.toMatch(/response\.stacktrace\s*=/);
    expect(source).not.toMatch(/\.stacktrace\s*=\s*job\.stacktrace/);
  });
});
