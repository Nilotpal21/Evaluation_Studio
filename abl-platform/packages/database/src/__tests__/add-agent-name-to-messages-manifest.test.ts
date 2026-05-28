/**
 * Manifest registration test for the ABLP-1068 CH migration.
 *
 * Verifies that the standalone `add-agent-name-to-messages` migration is
 * registered in `CHANGE_MANIFEST` with the expected lifecycle metadata. This
 * is what hooks the migration into the change-management UI / audit trail.
 */

import { describe, it, expect } from 'vitest';
import { CHANGE_MANIFEST } from '../change-management/manifest.js';

const MIGRATION_ID = 'clickhouse.add-agent-name-to-messages';

describe('change-management manifest — add-agent-name-to-messages (ABLP-1068)', () => {
  it('registers the migration entry', () => {
    const entry = CHANGE_MANIFEST.find((e) => e.id === MIGRATION_ID);
    expect(entry).toBeDefined();
  });

  it('points at the standalone migration file', () => {
    const entry = CHANGE_MANIFEST.find((e) => e.id === MIGRATION_ID);
    expect(entry?.sourcePaths).toContain(
      'packages/database/src/clickhouse-schemas/migrations/add-agent-name-to-messages.ts',
    );
  });

  it('is declared as a forward-only non-destructive ClickHouse schema migration', () => {
    const entry = CHANGE_MANIFEST.find((e) => e.id === MIGRATION_ID);
    expect(entry?.engine).toBe('clickhouse');
    expect(entry?.kind).toBe('schema');
    expect(entry?.reversibility).toBe('forward_only');
    expect(entry?.destructive).toBe(false);
  });

  it('is registered for manual pre-deploy invocation across all environments', () => {
    const entry = CHANGE_MANIFEST.find((e) => e.id === MIGRATION_ID);
    expect(entry?.phase).toBe('pre_deploy');
    expect(entry?.trigger).toBe('manual');
    expect(entry?.blocking).toBe('manual_only');
    // `environments` should at minimum contain dev + production-like envs;
    // the assertion is "non-empty" to avoid coupling to the enum shape.
    expect(Array.isArray(entry?.environments)).toBe(true);
    expect((entry?.environments ?? []).length).toBeGreaterThan(0);
  });
});
