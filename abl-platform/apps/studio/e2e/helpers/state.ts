/**
 * Shared test state — persisted to disk as JSON.
 *
 * Requires `workers: 1` in Playwright config (D8) — read-merge-write
 * is not concurrent-safe.
 *
 * @e2e-real — No mocks, no stubs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.resolve(__dirname, '../.test-state.json');

export interface TestState {
  // Auth
  token: string;
  projectId: string;

  // Flow metadata
  flow: 'create' | 'existing';
  timestamp: number;

  // Resources (populated by setup phase)
  kbId: string;
  kbName: string;
  indexId: string;
  sourceIds: string[]; // Array — KB may have multiple sources (manual + crawl)

  // Feature detection (populated by setup or detect phase)
  llmConfigured: boolean;
  enrichmentDone: boolean;
  documentCount: number;
  hasTaxonomy: boolean;
  hasVocabulary: boolean;
  hasFieldMappings: boolean;
  hasKnowledgeGraph: boolean;
}

/**
 * Persist a partial state update to disk.
 *
 * - Creates the file when it does not yet exist.
 * - Merges the partial into the existing state when the file is present.
 * - Throws if the incoming `flow` conflicts with the stored `flow`.
 */
export function saveState(partial: Partial<TestState>): void {
  let existing: Partial<TestState> = {};

  if (fs.existsSync(STATE_PATH)) {
    existing = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as Partial<TestState>;
  }

  // Flow conflict guard
  if (partial.flow !== undefined && existing.flow !== undefined && partial.flow !== existing.flow) {
    throw new Error('State conflict: run clearState() or use --project to select one flow');
  }

  const merged = { ...existing, ...partial };
  fs.writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2), 'utf-8');
}

/**
 * Load the full test state from disk.
 *
 * Throws when no state file exists — callers must run a setup phase first.
 */
export function loadState(): TestState {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      'No test state found. Run setup first: --project=setup-create or --project=setup-existing',
    );
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as TestState;
}

/**
 * Delete the state file (used by cleanup / globalTeardown).
 */
export function clearState(): void {
  if (fs.existsSync(STATE_PATH)) {
    fs.unlinkSync(STATE_PATH);
  }
}
