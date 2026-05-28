import { describe, expect, test } from 'vitest';
import {
  CHANGE_MANIFEST,
  KNOWN_CHANGE_SURFACES,
  getChangeManifestForEnvironment,
  validateChangeManifest,
} from '../../change-management/manifest.js';
import type { ChangeManifestEntry, KnownChangeSurface } from '../../change-management/types.js';

function createMinimalEntry(
  overrides: Partial<ChangeManifestEntry> & Pick<ChangeManifestEntry, 'id'>,
): ChangeManifestEntry {
  return {
    id: overrides.id,
    description: overrides.description ?? overrides.id,
    sourcePaths: overrides.sourcePaths ?? [`tmp/${overrides.id}.ts`],
    engine: overrides.engine ?? 'mongodb',
    kind: overrides.kind ?? 'schema',
    phase: overrides.phase ?? 'pre_deploy',
    trigger: overrides.trigger ?? 'deploy',
    blocking: overrides.blocking ?? 'deploy_required',
    scope: overrides.scope ?? 'global',
    environments: overrides.environments ?? ['dev', 'staging', 'prod'],
    lifecycle: overrides.lifecycle ?? 'active',
    reversibility: overrides.reversibility ?? 'down',
    destructive: overrides.destructive ?? false,
    requires: overrides.requires ?? [],
    legacyLedger: overrides.legacyLedger ?? null,
    evidenceFields: overrides.evidenceFields ?? [
      'configSnapshotRef',
      'configDiffRef',
      'lowerEnvironmentValidationRef',
      'observabilityRef',
      'traceId',
    ],
    observabilityDimensions: overrides.observabilityDimensions ?? [
      'environment',
      'releaseId',
      'changeId',
      'service',
    ],
    requiredByServices: overrides.requiredByServices,
    notes: overrides.notes,
    legacyId: overrides.legacyId,
  };
}

describe('change-management manifest', () => {
  test('validates the built manifest successfully', () => {
    const result = validateChangeManifest();
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('rejects duplicate change ids', () => {
    const duplicate = createMinimalEntry({ id: 'dup.change' });
    const result = validateChangeManifest([duplicate, duplicate], []);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'duplicate_change_id',
          changeId: 'dup.change',
        }),
      ]),
    );
  });

  test('rejects missing dependencies', () => {
    const result = validateChangeManifest(
      [createMinimalEntry({ id: 'change.a', requires: ['missing.change'] })],
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_dependency',
          changeId: 'change.a',
          dependencyId: 'missing.change',
        }),
      ]),
    );
  });

  test('rejects deploy dependencies on later phases', () => {
    const result = validateChangeManifest(
      [
        createMinimalEntry({
          id: 'change.pre',
          phase: 'pre_deploy',
          requires: ['change.post'],
        }),
        createMinimalEntry({
          id: 'change.post',
          phase: 'post_deploy',
        }),
      ],
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'illegal_combination',
          changeId: 'change.pre',
          dependencyId: 'change.post',
        }),
      ]),
    );
  });

  test('rejects same-phase MongoDB dependencies that run later by legacy version', () => {
    const result = validateChangeManifest(
      [
        createMinimalEntry({
          id: 'mongodb.20260511_001.dependent',
          legacyId: '20260511_001',
          requires: ['mongodb.20260511_002.dependency'],
        }),
        createMinimalEntry({
          id: 'mongodb.20260511_002.dependency',
          legacyId: '20260511_002',
        }),
      ],
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'illegal_combination',
          changeId: 'mongodb.20260511_001.dependent',
          dependencyId: 'mongodb.20260511_002.dependency',
        }),
      ]),
    );
  });

  test('rejects cyclic dependencies', () => {
    const result = validateChangeManifest(
      [
        createMinimalEntry({ id: 'change.a', requires: ['change.b'] }),
        createMinimalEntry({ id: 'change.b', requires: ['change.a'] }),
      ],
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'cyclic_dependency',
        }),
      ]),
    );
  });

  test('rejects illegal phase and kind combinations', () => {
    const result = validateChangeManifest(
      [
        createMinimalEntry({
          id: 'seed.dev.invalid',
          kind: 'seed_dev',
          environments: ['dev', 'prod'],
          trigger: 'manual',
          blocking: 'warn_only',
          scope: 'tenant',
          phase: 'continuous',
          reversibility: 'compensating',
        }),
      ],
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'illegal_combination',
          changeId: 'seed.dev.invalid',
        }),
      ]),
    );
  });

  test('rejects destructive deploy-triggered pre-deploy migrations', () => {
    const result = validateChangeManifest(
      [
        createMinimalEntry({
          id: 'schema.drop-before-rollout',
          phase: 'pre_deploy',
          trigger: 'deploy',
          destructive: true,
        }),
      ],
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'illegal_combination',
          changeId: 'schema.drop-before-rollout',
        }),
      ]),
    );
  });

  test('requires rollout service metadata for deploy-blocking post-deploy migrations', () => {
    const result = validateChangeManifest(
      [
        createMinimalEntry({
          id: 'schema.verify-after-rollout',
          phase: 'post_deploy',
          trigger: 'deploy',
          blocking: 'deploy_required',
          requiredByServices: [],
        }),
      ],
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'illegal_combination',
          changeId: 'schema.verify-after-rollout',
        }),
      ]),
    );
  });

  test('flags missing known registered surfaces', () => {
    const entry = createMinimalEntry({
      id: 'known.change',
      sourcePaths: ['src/known.ts'],
    });
    const surfaces: KnownChangeSurface[] = [
      {
        surfaceKey: 'known.surface',
        path: 'src/known.ts',
        disposition: 'registered',
        expectedManifestId: 'known.change',
      },
      {
        surfaceKey: 'missing.surface',
        path: 'src/missing.ts',
        disposition: 'registered',
        expectedManifestId: 'missing.change',
      },
    ];

    const result = validateChangeManifest([entry], surfaces);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_registered_surface',
          surfaceKey: 'missing.surface',
        }),
      ]),
    );
  });

  test('filters dev-only entries from prod manifest views', () => {
    const prodEntries = getChangeManifestForEnvironment('prod');
    expect(prodEntries.some((entry) => entry.kind === 'seed_dev')).toBe(false);
    expect(prodEntries.every((entry) => entry.environments.includes('prod'))).toBe(true);
  });

  test('tracks newly discovered script and bridge surfaces in the inventory', () => {
    const changeIds = new Set(CHANGE_MANIFEST.map((entry) => entry.id));
    expect(changeIds.has('search-ai.backfill-connector-id')).toBe(true);
    expect(changeIds.has('eventstore.analytics-bridge')).toBe(true);

    const surfaceKeys = new Set(KNOWN_CHANGE_SURFACES.map((surface) => surface.surfaceKey));
    expect(surfaceKeys.has('search-ai.backfill-connector-id')).toBe(true);
    expect(surfaceKeys.has('eventstore.analytics-bridge')).toBe(true);
  });

  test('backfills ModelConfig tenant ids before tenant-scoped runtime reads deploy', () => {
    const entry = CHANGE_MANIFEST.find(
      (change) => change.id === 'mongodb.20260505_027.backfill-model-config-tenant-ids',
    );

    expect(entry).toMatchObject({
      phase: 'pre_deploy',
      blocking: 'deploy_required',
    });
  });
});
