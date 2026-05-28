/**
 * Global Setup — runs before ALL Playwright projects.
 *
 * Validates that --project flag was specified (D10), creates
 * required directories, and cleans up stale temp files.
 *
 * Registered in e2e-env.config.ts as globalSetup.
 *
 * @e2e-real — No mocks, no stubs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const E2E_DIR = path.resolve(__dirname, '..');
const SCREENSHOTS_DIR = path.resolve(E2E_DIR, 'screenshots/searchai');
const REPORTS_DIR = path.resolve(__dirname, '../../../../docs/testing/reports');
const BUGS_WIP_PATH = path.resolve(E2E_DIR, '.bugs-wip.json');

export default async function globalSetup(): Promise<void> {
  // ── Validate --project flag (D10) ──
  const hasProjectFlag = process.argv.some(
    (arg) => arg === '--project' || arg.startsWith('--project='),
  );

  if (!hasProjectFlag) {
    console.error(`
[E2E] ERROR: You must specify a --project flag to select which flow to run.

Both flows write to the same state file — running without --project is ambiguous.

Usage examples:
  # Full create flow (creates KB, uploads docs, tests, cleans up)
  npx playwright test --config e2e-env.config.ts --project=cleanup

  # Test against existing data
  npx playwright test --config e2e-env.config.ts --project=search-existing --project=browse-existing

  # Single spec with auto-prerequisites
  npx playwright test --config e2e-env.config.ts --project=browse-create

  # Edge cases only (independent)
  npx playwright test --config e2e-env.config.ts --project=edge-cases
`);
    throw new Error('No --project flag specified. See usage examples above.');
  }

  // ── Create required directories ──
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  console.info('[E2E] Directories ensured: screenshots/searchai/, docs/testing/reports/');

  // ── Clean up stale temp files ──
  if (fs.existsSync(BUGS_WIP_PATH)) {
    fs.unlinkSync(BUGS_WIP_PATH);
    console.info('[E2E] Cleaned up stale .bugs-wip.json');
  }
}
