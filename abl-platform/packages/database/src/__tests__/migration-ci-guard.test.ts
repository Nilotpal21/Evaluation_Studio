import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { mongoMigrationRegistry } from '../migrations/registry.js';

const PIPELINE_PATH = fileURLToPath(
  new URL('../../../../.harness/pipelines/ci-build.yaml', import.meta.url),
);

describe('migration registry invariants', () => {
  test('all registered migrations have unique version strings', () => {
    const versions = mongoMigrationRegistry.map((s) => s.migration.version);
    const unique = new Set(versions);
    const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i);
    expect(duplicates, `duplicate migration versions: ${duplicates.join(', ')}`).toHaveLength(0);
    expect(unique.size).toBe(versions.length);
  });
});

describe('schema build selection guard', () => {
  test('fails closed when changed files cannot be resolved', async () => {
    const pipeline = await readFile(PIPELINE_PATH, 'utf8');
    const guardStart = pipeline.indexOf('name: Schema Build Selection Guard');
    const guardEnd = pipeline.indexOf('name: Install and Build', guardStart);

    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(guardEnd).toBeGreaterThan(guardStart);

    const guard = pipeline.slice(guardStart, guardEnd);
    expect(guard).toContain(
      'if ! CHANGED_FILES=$(git diff --name-only "origin/${BASE_BRANCH}...HEAD"); then',
    );
    expect(guard).toContain('Could not determine changed files');
    expect(guard).not.toContain(
      'CHANGED_FILES=$(git diff --name-only "origin/${BASE_BRANCH}...HEAD" || true)',
    );
  });
});
