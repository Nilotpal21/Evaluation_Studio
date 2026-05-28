/**
 * Migration Runner
 *
 * Executes database migrations in order with:
 * - Distributed locking (only one runner at a time)
 * - Transaction support (when replica set is available)
 * - History tracking in _migration_history collection
 * - Forward migration (up) and rollback (down)
 */

import mongoose from 'mongoose';
import { getChangeManifestEntry } from '../change-management/manifest.js';
import { shadowWriteChangeHistory } from '../change-management/history.js';
import { getChangeLease, startChangeLeaseHeartbeat } from '../change-management/lease.js';
import type {
  ChangeEnvironment,
  ChangeManifestEntry,
  ChangePhase,
  ChangeReleaseEvidenceRefs,
} from '../change-management/types.js';
import {
  acquireLock,
  buildMigrationLockHolderId,
  getMigrationLockHeartbeatMs,
  getMigrationLockTtlMs,
  MIGRATION_LOCK_COLLECTION,
  MIGRATION_LOCK_ID,
  releaseLock,
} from './lock.js';
import { getMigrationChecksum } from './checksum.js';
import { resolveMongoMigrationManifestId } from './registry.js';
import type {
  Migration,
  MigrationHistoryEntry,
  MigrationPhaseOptions,
  MigrationResult,
  MigrationStatus,
  MigrationTransactionMode,
  MigrationValidationRunResult,
  MigrationValidationStatus,
} from './types.js';

type Db = mongoose.mongo.Db;
type ClientSession = mongoose.mongo.ClientSession;

const HISTORY_COLLECTION = '_migration_history';

interface MigrationHistoryUpdate {
  checksum?: string;
  validationStatus?: MigrationValidationStatus;
  validationSummary?: string;
  validationDetails?: Record<string, unknown>;
  lastValidatedAt?: Date;
  lastError?: string | null;
}

interface ChecksumDrift {
  version: string;
  reason: 'missing' | 'mismatch';
}

interface MigrationLeaseContext {
  holderId: string;
  fence: number;
}

interface MigrationManifestResolution {
  changeId: string;
  entry?: ChangeManifestEntry;
}

class MigrationValidationFailureError extends Error {
  constructor(
    message: string,
    readonly historyUpdate: MigrationHistoryUpdate,
  ) {
    super(message);
    this.name = 'MigrationValidationFailureError';
  }
}

function resolveChangeEnvironment(): ChangeEnvironment {
  const rawEnvironment = (
    process.env.APP_ENV ??
    process.env.ENVIRONMENT ??
    process.env.NODE_ENV ??
    'dev'
  ).toLowerCase();

  if (rawEnvironment === 'production' || rawEnvironment === 'prod') {
    return 'prod';
  }

  if (rawEnvironment === 'staging' || rawEnvironment === 'stage') {
    return 'staging';
  }

  return 'dev';
}

function resolveBuildInfo(): Record<string, unknown> | undefined {
  const buildInfo: Record<string, unknown> = {};

  if (process.env.CHANGE_IMAGE_TAG) {
    buildInfo['imageTag'] = process.env.CHANGE_IMAGE_TAG;
  }
  if (process.env.CHANGE_MANIFEST_DIGEST) {
    buildInfo['manifestDigest'] = process.env.CHANGE_MANIFEST_DIGEST;
  }
  if (process.env.GIT_COMMIT_SHA) {
    buildInfo['commitSha'] = process.env.GIT_COMMIT_SHA;
  }

  return Object.keys(buildInfo).length > 0 ? buildInfo : undefined;
}

function resolveReleaseEvidence(): ChangeReleaseEvidenceRefs | undefined {
  const refs: ChangeReleaseEvidenceRefs = {
    configSnapshotRef: process.env.CHANGE_CONFIG_SNAPSHOT_REF ?? null,
    configDiffRef: process.env.CHANGE_CONFIG_DIFF_REF ?? null,
    lowerEnvironmentValidationRef: process.env.CHANGE_LOWER_ENV_EVIDENCE_REF ?? null,
    observabilityRef: process.env.CHANGE_OBSERVABILITY_REF ?? null,
    traceId: process.env.CHANGE_TRACE_ID ?? null,
  };

  return Object.values(refs).some((value) => value) ? refs : undefined;
}

export class MigrationRunner {
  private db: Db;
  private migrations: Migration[];
  private migrationLeaseContext: MigrationLeaseContext | null;
  private migrationLeaseLostError: Error | null;

  constructor(migrations: Migration[]) {
    // Sort migrations by version (chronological)
    this.migrations = [...migrations].sort((a, b) => a.version.localeCompare(b.version));
    this.db = null as any; // Set during connect
    this.migrationLeaseContext = null;
    this.migrationLeaseLostError = null;
  }

  /**
   * Run all pending migrations.
   */
  async migrate(options: MigrationPhaseOptions = {}): Promise<MigrationResult> {
    this.db = mongoose.connection.db!;
    const startTime = Date.now();
    const result: MigrationResult = {
      applied: [],
      skipped: [],
      validated: [],
      failed: null,
      checksumMismatches: [],
      durationMs: 0,
    };

    await this.withMigrationLease(async () => {
      const checksumDrifts = await this.getChecksumDrifts();
      if (checksumDrifts.length > 0) {
        result.checksumMismatches = checksumDrifts.map(
          ({ version, reason }) => `${version}:${reason}`,
        );
        for (const drift of checksumDrifts) {
          const detail =
            drift.reason === 'missing'
              ? 'history entry is missing a checksum'
              : 'stored checksum differs from current migration source';
          console.warn(`[Migration] Checksum warning for ${drift.version}: ${detail}`);
        }
      }

      const applied = await this.getAppliedVersions();
      const runnableMigrations = this.filterMigrationsForPhase(this.migrations, options);
      const pending = runnableMigrations.filter((m) => !applied.has(m.version));

      if (pending.length === 0) {
        console.log('[Migration] No pending migrations.');
        result.durationMs = Date.now() - startTime;
        return result;
      }

      console.log(`[Migration] ${pending.length} pending migration(s) to apply.`);

      for (const migration of pending) {
        try {
          this.assertPhaseDependenciesApplied(migration, applied, result.applied, options.phase);
          const applyResult = await this.applyMigration(migration);
          result.applied.push(migration.version);
          if (applyResult.validationStatus === 'passed') {
            result.validated.push(migration.version);
          }
          console.log(`[Migration] Applied: ${migration.version} — ${migration.description}`);
        } catch (error) {
          result.failed = migration.version;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[Migration] FAILED: ${migration.version} — ${message}`);
          // Record failure in history
          try {
            const historyUpdate =
              error instanceof MigrationValidationFailureError
                ? error.historyUpdate
                : {
                    checksum: getMigrationChecksum(migration),
                    lastError: message,
                  };
            await this.recordHistory(migration, 0, 'failed', {
              ...historyUpdate,
              checksum: historyUpdate.checksum ?? getMigrationChecksum(migration),
              lastError: message,
            });
          } catch (historyError) {
            console.error(
              `[Migration] Failed to persist failure history for ${migration.version}: ${
                historyError instanceof Error ? historyError.message : String(historyError)
              }`,
            );
          }
          break; // Stop on first failure
        }
      }

      // Log skipped (migrations after a failure)
      if (result.failed) {
        const failedIdx = runnableMigrations.findIndex((m) => m.version === result.failed);
        result.skipped = pending
          .filter(
            (m) => runnableMigrations.indexOf(m) > failedIdx && !result.applied.includes(m.version),
          )
          .map((m) => m.version);
      }
    });

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * Rollback the last N migrations.
   */
  async rollback(steps = 1): Promise<void> {
    this.db = mongoose.connection.db!;

    await this.withMigrationLease(async () => {
      const history = await this.getHistory();
      const applied = history
        .filter((h) => h.status === 'applied')
        .sort((a, b) => b.version.localeCompare(a.version));

      const toRollback = applied.slice(0, steps);

      if (toRollback.length === 0) {
        console.log('[Migration] No migrations to rollback.');
        return;
      }

      for (const entry of toRollback) {
        const migration = this.migrations.find((m) => m.version === entry.version);
        if (!migration) {
          console.warn(
            `[Migration] Migration ${entry.version} not found in registry. Skipping rollback.`,
          );
          continue;
        }

        const start = Date.now();
        try {
          await this.runWithOptionalTransaction(
            (session) => migration.down(this.db, session),
            migration.transactionMode,
          );

          const duration = Date.now() - start;
          await this.recordHistory(migration, duration, 'rolled_back');
          console.log(`[Migration] Rolled back: ${migration.version} — ${migration.description}`);
        } catch (error) {
          console.error(
            `[Migration] Rollback FAILED: ${migration.version} — ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      }
    });
  }

  /**
   * Get the status of all known migrations.
   */
  async status(): Promise<MigrationStatus[]> {
    this.db = mongoose.connection.db!;
    const history = await this.getHistory();
    const historyMap = new Map(history.map((h) => [h.version, h]));

    return this.migrations.map((m) => {
      const entry = historyMap.get(m.version);
      const checksumStatus = entry
        ? entry.checksum
          ? entry.checksum === getMigrationChecksum(m)
            ? 'match'
            : 'mismatch'
          : 'missing'
        : undefined;
      const validationStatus = entry
        ? (entry.validationStatus ?? (m.validate ? 'never_run' : 'not_configured'))
        : undefined;
      return {
        version: m.version,
        description: m.description,
        status:
          entry?.status === 'applied'
            ? 'applied'
            : entry?.status === 'rolled_back'
              ? 'rolled_back'
              : entry?.status === 'failed'
                ? 'failed'
                : 'pending',
        appliedAt: entry?.appliedAt,
        durationMs: entry?.durationMs,
        checksumStatus,
        validationStatus,
        validationSummary: entry?.validationSummary,
        lastValidatedAt: entry?.lastValidatedAt,
        lastError: entry?.lastError ?? null,
        runCount: entry?.runCount,
      };
    });
  }

  /**
   * Re-run validation for all applied migrations without re-executing `up()`.
   */
  async validate(options: MigrationPhaseOptions = {}): Promise<MigrationValidationRunResult[]> {
    this.db = mongoose.connection.db!;
    const results: MigrationValidationRunResult[] = [];

    await this.withMigrationLease(async () => {
      const history = await this.getHistory();
      const historyMap = new Map(history.map((entry) => [entry.version, entry]));
      const migrationsToValidate = this.filterMigrationsForPhase(this.migrations, options);

      for (const migration of migrationsToValidate) {
        const entry = historyMap.get(migration.version);
        if (entry?.status !== 'applied') {
          results.push({
            version: migration.version,
            description: migration.description,
            status: 'pending',
            summary: 'Migration is not currently applied',
          });
          continue;
        }

        if (!migration.validate) {
          const lastValidatedAt = new Date();
          await this.recordValidation(migration, {
            checksum: getMigrationChecksum(migration),
            validationStatus: 'not_configured',
            validationSummary: 'No validate() hook defined for this migration',
            validationDetails: {
              guidance: 'Add a migration.validate() implementation to verify post-conditions.',
            },
            lastValidatedAt,
            lastError: null,
          });
          results.push({
            version: migration.version,
            description: migration.description,
            status: 'not_configured',
            summary: 'No validate() hook defined for this migration',
          });
          continue;
        }

        const lastValidatedAt = new Date();
        try {
          const validation = await migration.validate(this.db);
          const validationStatus: MigrationValidationStatus = validation.ok ? 'passed' : 'failed';
          const lastError = validation.ok ? null : validation.summary;
          await this.recordValidation(migration, {
            checksum: getMigrationChecksum(migration),
            validationStatus,
            validationSummary: validation.summary,
            validationDetails: validation.details,
            lastValidatedAt,
            lastError,
          });
          results.push({
            version: migration.version,
            description: migration.description,
            status: validationStatus,
            summary: validation.summary,
            details: validation.details,
            lastError: lastError ?? undefined,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.recordValidation(migration, {
            checksum: getMigrationChecksum(migration),
            validationStatus: 'failed',
            validationSummary: message,
            validationDetails: { threw: true },
            lastValidatedAt,
            lastError: message,
          });
          results.push({
            version: migration.version,
            description: migration.description,
            status: 'failed',
            summary: message,
            lastError: message,
          });
        }
      }
    });

    return results;
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private async withMigrationLease<T>(fn: () => Promise<T>): Promise<T> {
    const locked = await acquireLock(this.db);
    if (!locked) {
      throw new Error('Could not acquire migration lock. Another migration runner may be active.');
    }

    const leaseContext = await this.captureMigrationLeaseContext();
    this.migrationLeaseContext = leaseContext;
    this.migrationLeaseLostError = null;

    const heartbeat = startChangeLeaseHeartbeat(this.db, {
      lockId: MIGRATION_LOCK_ID,
      collectionName: MIGRATION_LOCK_COLLECTION,
      holderId: leaseContext.holderId,
      fence: leaseContext.fence,
      ttlMs: getMigrationLockTtlMs(),
      intervalMs: getMigrationLockHeartbeatMs(),
      onLeaseLost: () => {
        this.migrationLeaseLostError = new Error(
          'Migration lease was lost during execution. Results were not persisted.',
        );
      },
    });

    try {
      return await fn();
    } finally {
      await heartbeat.stop();
      this.migrationLeaseContext = null;
      this.migrationLeaseLostError = null;
      await releaseLock(this.db);
    }
  }

  private async captureMigrationLeaseContext(): Promise<MigrationLeaseContext> {
    const holderId = buildMigrationLockHolderId();
    const lease = await getChangeLease(this.db, {
      lockId: MIGRATION_LOCK_ID,
      collectionName: MIGRATION_LOCK_COLLECTION,
    });

    if (!lease || lease.lockedBy !== holderId) {
      throw new Error('Migration lock acquired but active lease context could not be resolved.');
    }

    return {
      holderId,
      fence: lease.fence,
    };
  }

  private assertMigrationLeaseActive(): void {
    if (this.migrationLeaseContext && this.migrationLeaseLostError) {
      throw this.migrationLeaseLostError;
    }
  }

  private async applyMigration(migration: Migration): Promise<{
    validationStatus: MigrationValidationStatus;
  }> {
    const start = Date.now();
    let historyUpdate: MigrationHistoryUpdate = {
      checksum: getMigrationChecksum(migration),
      validationStatus: migration.validate ? 'never_run' : 'not_configured',
      validationSummary: migration.validate
        ? undefined
        : 'No validate() hook defined for this migration',
      lastError: null,
    };

    await this.runWithOptionalTransaction(async (session) => {
      await migration.up(this.db, session);
      historyUpdate = await this.runMigrationValidation(migration, session);
      if (historyUpdate.validationStatus === 'failed') {
        throw new MigrationValidationFailureError(
          historyUpdate.validationSummary ?? 'Migration validation failed',
          historyUpdate,
        );
      }
    }, migration.transactionMode);

    const duration = Date.now() - start;
    await this.recordHistory(migration, duration, 'applied', historyUpdate);
    return {
      validationStatus: historyUpdate.validationStatus ?? 'never_run',
    };
  }

  private async runWithOptionalTransaction(
    fn: (session?: ClientSession) => Promise<void>,
    transactionMode: MigrationTransactionMode = 'auto',
  ): Promise<void> {
    if (transactionMode === 'none') {
      await fn();
      return;
    }

    // Use the standard hello command to detect replica set support
    let useTx = false;
    try {
      const admin = this.db.admin();
      const info = await admin.command({ hello: 1 });
      useTx = !!(info['setName'] || info['msg'] === 'isdbgrid');
    } catch {
      useTx = false;
    }

    if (useTx) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(() => fn(session));
      } finally {
        await session.endSession();
      }
    } else {
      await fn();
    }
  }

  private async getAppliedVersions(): Promise<Set<string>> {
    const collection = this.db.collection<MigrationHistoryEntry>(HISTORY_COLLECTION);
    const entries = await collection.find({ status: 'applied' }).project({ version: 1 }).toArray();
    return new Set(entries.map((e: any) => e.version));
  }

  private async getHistory(): Promise<MigrationHistoryEntry[]> {
    const collection = this.db.collection<MigrationHistoryEntry>(HISTORY_COLLECTION);
    return collection.find().sort({ version: 1 }).toArray();
  }

  private async getChecksumDrifts(): Promise<ChecksumDrift[]> {
    const history = await this.getHistory();
    const drifts: ChecksumDrift[] = [];

    for (const entry of history) {
      const migration = this.migrations.find((item) => item.version === entry.version);
      if (!migration) {
        continue;
      }

      if (!entry.checksum) {
        drifts.push({ version: entry.version, reason: 'missing' });
        continue;
      }

      if (entry.checksum !== getMigrationChecksum(migration)) {
        drifts.push({ version: entry.version, reason: 'mismatch' });
      }
    }

    return drifts;
  }

  private resolveMigrationManifest(
    migration: Migration,
    options: MigrationPhaseOptions,
  ): MigrationManifestResolution {
    const changeId = resolveMongoMigrationManifestId(migration);
    const entry = getChangeManifestEntry(changeId);

    if (options.requireManifestMetadata && !entry) {
      throw new Error(
        `Migration ${migration.version} is missing change-management manifest metadata (${changeId}).`,
      );
    }

    if (options.requireManifestMetadata && entry && !entry.phase) {
      throw new Error(`Migration ${migration.version} manifest entry is missing a phase.`);
    }

    return { changeId, entry };
  }

  private filterMigrationsForPhase(
    migrations: Migration[],
    options: MigrationPhaseOptions,
  ): Migration[] {
    if (!options.phase) {
      if (options.requireManifestMetadata) {
        for (const migration of migrations) {
          this.resolveMigrationManifest(migration, options);
        }
      }
      return migrations;
    }

    return migrations.filter((migration) => {
      const { entry } = this.resolveMigrationManifest(migration, options);
      return entry?.phase === options.phase;
    });
  }

  private assertPhaseDependenciesApplied(
    migration: Migration,
    previouslyApplied: Set<string>,
    appliedThisRun: string[],
    phase?: ChangePhase,
  ): void {
    if (!phase) {
      return;
    }

    const { changeId, entry } = this.resolveMigrationManifest(migration, {
      phase,
      requireManifestMetadata: true,
    });
    if (!entry || entry.requires.length === 0) {
      return;
    }

    const applied = new Set([...previouslyApplied, ...appliedThisRun]);
    for (const dependencyId of entry.requires) {
      const dependency = this.migrations.find((candidate) => {
        const candidateChangeId = resolveMongoMigrationManifestId(candidate);
        return candidateChangeId === dependencyId;
      });
      if (!dependency) {
        const dependencyEntry = getChangeManifestEntry(dependencyId);
        if (dependencyEntry?.engine === 'mongodb' && dependencyEntry.lifecycle === 'active') {
          throw new Error(
            `Migration ${changeId} requires active MongoDB dependency ${dependencyId}, but it is not registered in the migration runner.`,
          );
        }
        continue;
      }
      if (!applied.has(dependency.version)) {
        throw new Error(
          `Migration ${changeId} cannot run in ${phase} before dependency ${dependencyId} is applied.`,
        );
      }
    }
  }

  private async runMigrationValidation(
    migration: Migration,
    session?: ClientSession,
  ): Promise<MigrationHistoryUpdate> {
    const checksum = getMigrationChecksum(migration);

    if (!migration.validate) {
      return {
        checksum,
        validationStatus: 'not_configured',
        validationSummary: 'No validate() hook defined for this migration',
        lastValidatedAt: new Date(),
        lastError: null,
      };
    }

    try {
      const validation = await migration.validate(this.db, session);
      return {
        checksum,
        validationStatus: validation.ok ? 'passed' : 'failed',
        validationSummary: validation.summary,
        validationDetails: validation.details,
        lastValidatedAt: new Date(),
        lastError: validation.ok ? null : validation.summary,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        checksum,
        validationStatus: 'failed',
        validationSummary: message,
        validationDetails: { threw: true },
        lastValidatedAt: new Date(),
        lastError: message,
      };
    }
  }

  private async recordHistory(
    migration: Migration,
    durationMs: number,
    status: MigrationHistoryEntry['status'],
    update: MigrationHistoryUpdate = {},
  ): Promise<void> {
    this.assertMigrationLeaseActive();
    const collection = this.db.collection<MigrationHistoryEntry>(HISTORY_COLLECTION);
    const appliedAt = new Date();

    await collection.updateOne(
      { version: migration.version },
      {
        $set: {
          version: migration.version,
          description: migration.description,
          appliedAt,
          durationMs,
          status,
          checksum: update.checksum,
          validationStatus: update.validationStatus,
          validationSummary: update.validationSummary,
          validationDetails: update.validationDetails,
          lastValidatedAt: update.lastValidatedAt,
          lastError: update.lastError ?? null,
        },
        $inc: { runCount: 1 },
      },
      { upsert: true },
    );

    await this.recordSharedHistory(migration, status, durationMs, update, 1, appliedAt);
  }

  private async recordValidation(
    migration: Migration,
    update: Required<
      Pick<
        MigrationHistoryUpdate,
        'checksum' | 'validationStatus' | 'validationSummary' | 'lastValidatedAt' | 'lastError'
      >
    > &
      Pick<MigrationHistoryUpdate, 'validationDetails'>,
  ): Promise<void> {
    this.assertMigrationLeaseActive();
    const collection = this.db.collection<MigrationHistoryEntry>(HISTORY_COLLECTION);

    await collection.updateOne(
      { version: migration.version },
      {
        $set: {
          version: migration.version,
          description: migration.description,
          checksum: update.checksum,
          validationStatus: update.validationStatus,
          validationSummary: update.validationSummary,
          validationDetails: update.validationDetails,
          lastValidatedAt: update.lastValidatedAt,
          lastError: update.lastError,
        },
      },
      { upsert: true },
    );

    await this.recordSharedHistory(migration, 'applied', undefined, update, 0);
  }

  private async recordSharedHistory(
    migration: Migration,
    status: MigrationHistoryEntry['status'],
    durationMs: number | undefined,
    update: MigrationHistoryUpdate,
    runCountDelta: number,
    appliedAt?: Date,
  ): Promise<void> {
    const { changeId, entry: manifestEntry } = this.resolveMigrationManifest(migration, {});

    await shadowWriteChangeHistory(
      this.db,
      {
        changeId,
        legacyId: migration.version,
        description: migration.description,
        environment: resolveChangeEnvironment(),
        engine: 'mongodb',
        kind: manifestEntry?.kind ?? 'schema',
        phase: manifestEntry?.phase ?? 'pre_deploy',
        scope: manifestEntry?.scope ?? 'global',
        status,
        checksum: update.checksum,
        validationStatus: update.validationStatus,
        validationSummary: update.validationSummary,
        validationDetails: update.validationDetails,
        durationMs,
        lastError: update.lastError ?? null,
        lastValidatedAt: update.lastValidatedAt,
        appliedAt,
        releaseId: process.env.CHANGE_RELEASE_ID ?? null,
        appliedBy: this.migrationLeaseContext?.holderId ?? buildMigrationLockHolderId(),
        buildInfo: resolveBuildInfo(),
        releaseEvidence: resolveReleaseEvidence(),
      },
      {
        lockId: this.migrationLeaseContext ? MIGRATION_LOCK_ID : undefined,
        lockCollectionName: this.migrationLeaseContext ? MIGRATION_LOCK_COLLECTION : undefined,
        holderId: this.migrationLeaseContext?.holderId,
        fence: this.migrationLeaseContext?.fence,
        runCountDelta,
        shadowSource: HISTORY_COLLECTION,
        shadowKey: migration.version,
      },
    );
  }
}

/**
 * Create a migration runner with the provided migrations.
 */
export function createMigrationRunner(migrations: Migration[]): MigrationRunner {
  return new MigrationRunner(migrations);
}
