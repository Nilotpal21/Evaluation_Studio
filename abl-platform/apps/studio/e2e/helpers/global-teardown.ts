/**
 * Global Teardown — runs after ALL Playwright projects complete.
 *
 * Writes the bug report markdown and cleans up the temp JSONL file.
 * Runs regardless of which flow was executed, even if tests crashed (D11).
 *
 * Registered in e2e-env.config.ts as globalTeardown.
 *
 * @e2e-real — No mocks, no stubs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBugReport } from './bug-report';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUGS_WIP_PATH = path.resolve(__dirname, '../.bugs-wip.json');

export default async function globalTeardown(): Promise<void> {
  // ── Write bug report ──
  writeBugReport();
  console.info('[E2E] Bug report written to docs/testing/reports/');

  // ── Clean up temp file ──
  if (fs.existsSync(BUGS_WIP_PATH)) {
    fs.unlinkSync(BUGS_WIP_PATH);
    console.info('[E2E] Cleaned up .bugs-wip.json');
  }
}
