import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import mongoose from 'mongoose';
import { getChangeManifestEntry } from '../change-management/manifest.js';
import { shadowWriteChangeHistory } from '../change-management/history.js';
import {
  acquireChangeLease,
  releaseChangeLease,
  resolveChangeLockHeartbeatMs,
  resolveChangeLockTtlMs,
  startChangeLeaseHeartbeat,
} from '../change-management/lease.js';
import type { ChangeEnvironment, ChangeReleaseEvidenceRefs } from '../change-management/types.js';
import { resolveSeedTaskManifestId } from './catalog.js';

type Db = mongoose.mongo.Db;

const HISTORY_COLLECTION = '_seed_history';

export type SeedValidationStatus = 'passed' | 'failed' | 'not_configured' | 'never_run';

export interface SeedValidationResult {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export interface SeedTask<TContext> {
  id: string;
  description: string;
  idempotent: boolean;
  compensation?: string;
  targetKey(context: TContext): string;
  targetLabel?(context: TContext): string;
  run(context: TContext): Promise<void>;
  validate?(context: TContext): Promise<SeedValidationResult>;
}

export interface SeedHistoryEntry {
  taskId: string;
  description: string;
  targetKey: string;
  targetLabel: string;
  status: 'applied' | 'failed' | 'verified';
  checksum?: string;
  validationStatus?: SeedValidationStatus;
  validationSummary?: string;
  validationDetails?: Record<string, unknown>;
  lastRunAt?: Date;
  durationMs?: number;
  lastValidatedAt?: Date;
  lastError?: string | null;
  idempotent: boolean;
  compensation?: string;
  runCount?: number;
}

export interface SeedTaskStatus {
  taskId: string;
  description: string;
  targetKey: string;
  targetLabel: string;
  status: 'applied' | 'pending' | 'failed' | 'verified';
  tracked: boolean;
  checksumStatus?: 'match' | 'mismatch' | 'missing';
  validationStatus?: SeedValidationStatus;
  validationSummary?: string;
  lastRunAt?: Date;
  durationMs?: number;
  lastValidatedAt?: Date;
  lastError?: string | null;
  idempotent: boolean;
  compensation?: string;
  runCount?: number;
}

export interface SeedRunResult {
  applied: string[];
  validated: string[];
  failed: string | null;
  durationMs: number;
}

export interface SeedValidationRunResult {
  taskId: string;
  description: string;
  targetKey: string;
  status: 'passed' | 'failed' | 'pending' | 'verified' | 'not_configured';
  tracked: boolean;
  summary?: string;
  details?: Record<string, unknown>;
  lastError?: string;
}

interface SeedHistoryUpdate {
  checksum?: string;
  validationStatus?: SeedValidationStatus;
  validationSummary?: string;
  validationDetails?: Record<string, unknown>;
  lastValidatedAt?: Date;
  lastError?: string | null;
}

interface SeedLeaseContext {
  lockId: string;
  holderId: string;
  fence: number;
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

function getTaskChecksum<TContext>(task: SeedTask<TContext>): string {
  const parts = [
    task.id,
    task.description,
    task.run.toString(),
    task.validate?.toString() ?? '',
    task.idempotent ? 'idempotent' : 'non-idempotent',
    task.compensation ?? '',
  ];
  return createHash('sha256').update(parts.join('\n---\n')).digest('hex');
}

function buildHistoryKey(taskId: string, targetKey: string): string {
  return `${taskId}::${targetKey}`;
}

function resolveTarget<TContext>(
  task: SeedTask<TContext>,
  context: TContext,
): {
  targetKey: string;
  targetLabel: string;
} {
  const targetKey = task.targetKey(context);
  return {
    targetKey,
    targetLabel: task.targetLabel?.(context) ?? targetKey,
  };
}

function buildSeedLockHolderId(): string {
  return `${hostname()}_${process.pid}`;
}

function buildSeedLockId(taskId: string, targetKey: string): string {
  return `seed_runner:${taskId}:${targetKey}`;
}

export class SeedRunner<TContext> {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async run(tasks: SeedTask<TContext>[], context: TContext): Promise<SeedRunResult> {
    const startTime = Date.now();
    const result: SeedRunResult = {
      applied: [],
      validated: [],
      failed: null,
      durationMs: 0,
    };

    for (const task of tasks) {
      const target = resolveTarget(task, context);
      const checksum = getTaskChecksum(task);
      const taskStart = Date.now();
      const leaseContext = await this.acquireTaskLease(task, target);

      if (!leaseContext) {
        result.failed = `${task.id}: Could not acquire seed lock for ${target.targetKey}`;
        break;
      }

      let leaseLost = false;
      const heartbeat = startChangeLeaseHeartbeat(this.db, {
        lockId: leaseContext.lockId,
        holderId: leaseContext.holderId,
        fence: leaseContext.fence,
        ttlMs: resolveChangeLockTtlMs(),
        intervalMs: resolveChangeLockHeartbeatMs(),
        onLeaseLost: () => {
          leaseLost = true;
        },
      });

      try {
        await task.run(context);
        if (leaseLost) {
          throw new Error(`Seed lease lost while running ${task.id}`);
        }

        const validation = await this.runTaskValidation(task, context);
        if (leaseLost) {
          throw new Error(`Seed lease lost while validating ${task.id}`);
        }

        if (validation.validationStatus === 'failed') {
          throw new Error(validation.validationSummary ?? 'Seed validation failed');
        }

        await this.recordRun(
          task,
          target,
          Date.now() - taskStart,
          'applied',
          {
            checksum,
            ...validation,
            lastError: null,
          },
          leaseContext,
        );
        result.applied.push(task.id);
        if (validation.validationStatus === 'passed') {
          result.validated.push(task.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!leaseLost) {
          try {
            await this.recordRun(
              task,
              target,
              Date.now() - taskStart,
              'failed',
              {
                checksum,
                lastError: message,
              },
              leaseContext,
            );
          } catch (historyError) {
            console.error(
              `[Seed] Failed to persist failure history for ${task.id}: ${
                historyError instanceof Error ? historyError.message : String(historyError)
              }`,
            );
          }
        }
        result.failed = `${task.id}: ${message}`;
        break;
      } finally {
        await heartbeat.stop();
        await releaseChangeLease(this.db, {
          lockId: leaseContext.lockId,
          holderId: leaseContext.holderId,
          fence: leaseContext.fence,
        });
      }
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  async status(tasks: SeedTask<TContext>[], context: TContext): Promise<SeedTaskStatus[]> {
    const histories = await this.getHistoryForTasks(tasks, context);

    const statuses: SeedTaskStatus[] = [];
    for (const task of tasks) {
      const target = resolveTarget(task, context);
      const history = histories.get(buildHistoryKey(task.id, target.targetKey));
      const checksum = getTaskChecksum(task);

      if (history) {
        statuses.push({
          taskId: task.id,
          description: task.description,
          targetKey: target.targetKey,
          targetLabel: target.targetLabel,
          status: history.status,
          tracked: true,
          checksumStatus: history.checksum
            ? history.checksum === checksum
              ? 'match'
              : 'mismatch'
            : 'missing',
          validationStatus:
            history.validationStatus ?? (task.validate ? 'never_run' : 'not_configured'),
          validationSummary: history.validationSummary,
          lastRunAt: history.lastRunAt,
          durationMs: history.durationMs,
          lastValidatedAt: history.lastValidatedAt,
          lastError: history.lastError ?? null,
          idempotent: history.idempotent,
          compensation: history.compensation,
          runCount: history.runCount,
        });
        continue;
      }

      if (!task.validate) {
        statuses.push({
          taskId: task.id,
          description: task.description,
          targetKey: target.targetKey,
          targetLabel: target.targetLabel,
          status: 'pending',
          tracked: false,
          validationStatus: 'not_configured',
          validationSummary: 'No validate() hook defined for this seed task',
          lastError: null,
          idempotent: task.idempotent,
          compensation: task.compensation,
        });
        continue;
      }

      try {
        const validation = await task.validate(context);
        statuses.push({
          taskId: task.id,
          description: task.description,
          targetKey: target.targetKey,
          targetLabel: target.targetLabel,
          status: validation.ok ? 'verified' : 'pending',
          tracked: false,
          validationStatus: validation.ok ? 'passed' : 'failed',
          validationSummary: validation.summary,
          lastError: validation.ok ? null : validation.summary,
          idempotent: task.idempotent,
          compensation: task.compensation,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        statuses.push({
          taskId: task.id,
          description: task.description,
          targetKey: target.targetKey,
          targetLabel: target.targetLabel,
          status: 'pending',
          tracked: false,
          validationStatus: 'failed',
          validationSummary: message,
          lastError: message,
          idempotent: task.idempotent,
          compensation: task.compensation,
        });
      }
    }

    return statuses;
  }

  async validate(
    tasks: SeedTask<TContext>[],
    context: TContext,
  ): Promise<SeedValidationRunResult[]> {
    const histories = await this.getHistoryForTasks(tasks, context);
    const results: SeedValidationRunResult[] = [];

    for (const task of tasks) {
      const target = resolveTarget(task, context);
      const history = histories.get(buildHistoryKey(task.id, target.targetKey));
      const checksum = getTaskChecksum(task);

      if (!task.validate) {
        if (history) {
          await this.recordValidation(task, target, history.status, {
            checksum,
            validationStatus: 'not_configured',
            validationSummary: 'No validate() hook defined for this seed task',
            validationDetails: {
              guidance: 'Add a task.validate() implementation to verify the seeded state.',
            },
            lastValidatedAt: new Date(),
            lastError: null,
          });
        }
        results.push({
          taskId: task.id,
          description: task.description,
          targetKey: target.targetKey,
          status: history ? 'not_configured' : 'pending',
          tracked: Boolean(history),
          summary: 'No validate() hook defined for this seed task',
        });
        continue;
      }

      try {
        const validation = await task.validate(context);
        if (history) {
          await this.recordValidation(task, target, history.status, {
            checksum,
            validationStatus: validation.ok ? 'passed' : 'failed',
            validationSummary: validation.summary,
            validationDetails: validation.details,
            lastValidatedAt: new Date(),
            lastError: validation.ok ? null : validation.summary,
          });
        } else if (validation.ok) {
          await this.recordValidation(task, target, 'verified', {
            checksum,
            validationStatus: 'passed',
            validationSummary: validation.summary,
            validationDetails: validation.details,
            lastValidatedAt: new Date(),
            lastError: null,
          });
        }

        results.push({
          taskId: task.id,
          description: task.description,
          targetKey: target.targetKey,
          status: history
            ? validation.ok
              ? 'passed'
              : 'failed'
            : validation.ok
              ? 'verified'
              : 'pending',
          tracked: Boolean(history || validation.ok),
          summary: validation.summary,
          details: validation.details,
          lastError: validation.ok ? undefined : validation.summary,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (history) {
          await this.recordValidation(task, target, history.status, {
            checksum,
            validationStatus: 'failed',
            validationSummary: message,
            validationDetails: { threw: true },
            lastValidatedAt: new Date(),
            lastError: message,
          });
        }
        results.push({
          taskId: task.id,
          description: task.description,
          targetKey: target.targetKey,
          status: history ? 'failed' : 'pending',
          tracked: Boolean(history),
          summary: message,
          lastError: message,
        });
      }
    }

    return results;
  }

  private async getHistoryForTasks(
    tasks: SeedTask<TContext>[],
    context: TContext,
  ): Promise<Map<string, SeedHistoryEntry>> {
    const targetPairs = tasks.map((task) => ({
      taskId: task.id,
      target: resolveTarget(task, context),
    }));
    const taskIds = [...new Set(targetPairs.map((pair) => pair.taskId))];
    const targetKeys = [...new Set(targetPairs.map((pair) => pair.target.targetKey))];

    const entries = await this.db
      .collection<SeedHistoryEntry>(HISTORY_COLLECTION)
      .find({
        taskId: { $in: taskIds },
        targetKey: { $in: targetKeys },
      })
      .toArray();

    return new Map(entries.map((entry) => [buildHistoryKey(entry.taskId, entry.targetKey), entry]));
  }

  private async runTaskValidation(
    task: SeedTask<TContext>,
    context: TContext,
  ): Promise<SeedHistoryUpdate> {
    if (!task.validate) {
      return {
        validationStatus: 'not_configured',
        validationSummary: 'No validate() hook defined for this seed task',
        lastValidatedAt: new Date(),
        lastError: null,
      };
    }

    try {
      const validation = await task.validate(context);
      return {
        validationStatus: validation.ok ? 'passed' : 'failed',
        validationSummary: validation.summary,
        validationDetails: validation.details,
        lastValidatedAt: new Date(),
        lastError: validation.ok ? null : validation.summary,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        validationStatus: 'failed',
        validationSummary: message,
        validationDetails: { threw: true },
        lastValidatedAt: new Date(),
        lastError: message,
      };
    }
  }

  private async recordRun(
    task: SeedTask<TContext>,
    target: { targetKey: string; targetLabel: string },
    durationMs: number,
    status: SeedHistoryEntry['status'],
    update: SeedHistoryUpdate,
    sharedContext?: SeedLeaseContext,
  ): Promise<void> {
    const lastRunAt = new Date();
    await this.db.collection<SeedHistoryEntry>(HISTORY_COLLECTION).updateOne(
      { taskId: task.id, targetKey: target.targetKey },
      {
        $set: {
          taskId: task.id,
          description: task.description,
          targetKey: target.targetKey,
          targetLabel: target.targetLabel,
          status,
          checksum: update.checksum,
          validationStatus: update.validationStatus,
          validationSummary: update.validationSummary,
          validationDetails: update.validationDetails,
          lastRunAt,
          durationMs,
          lastValidatedAt: update.lastValidatedAt,
          lastError: update.lastError ?? null,
          idempotent: task.idempotent,
          compensation: task.compensation,
        },
        $inc: { runCount: 1 },
      },
      { upsert: true },
    );

    await this.recordSharedHistory(
      task,
      target,
      status,
      durationMs,
      update,
      1,
      sharedContext,
      lastRunAt,
    );
  }

  private async recordValidation(
    task: SeedTask<TContext>,
    target: { targetKey: string; targetLabel: string },
    status: SeedHistoryEntry['status'],
    update: Required<
      Pick<
        SeedHistoryUpdate,
        'checksum' | 'validationStatus' | 'validationSummary' | 'lastValidatedAt' | 'lastError'
      >
    > &
      Pick<SeedHistoryUpdate, 'validationDetails'>,
  ): Promise<void> {
    await this.db.collection<SeedHistoryEntry>(HISTORY_COLLECTION).updateOne(
      { taskId: task.id, targetKey: target.targetKey },
      {
        $set: {
          taskId: task.id,
          description: task.description,
          targetKey: target.targetKey,
          targetLabel: target.targetLabel,
          status,
          checksum: update.checksum,
          validationStatus: update.validationStatus,
          validationSummary: update.validationSummary,
          validationDetails: update.validationDetails,
          lastValidatedAt: update.lastValidatedAt,
          lastError: update.lastError,
          idempotent: task.idempotent,
          compensation: task.compensation,
        },
        $setOnInsert: {
          runCount: 0,
        },
      },
      { upsert: true },
    );

    await this.recordSharedHistory(task, target, status, undefined, update, 0);
  }

  private async acquireTaskLease(
    task: SeedTask<TContext>,
    target: { targetKey: string; targetLabel: string },
  ): Promise<SeedLeaseContext | null> {
    const holderId = buildSeedLockHolderId();
    const lockId = buildSeedLockId(task.id, target.targetKey);
    const lease = await acquireChangeLease(this.db, {
      lockId,
      holderId,
      ttlMs: resolveChangeLockTtlMs(),
    });

    if (!lease) {
      return null;
    }

    return {
      lockId,
      holderId,
      fence: lease.fence,
    };
  }

  private async recordSharedHistory(
    task: SeedTask<TContext>,
    target: { targetKey: string; targetLabel: string },
    status: SeedHistoryEntry['status'],
    durationMs: number | undefined,
    update: SeedHistoryUpdate,
    runCountDelta: number,
    sharedContext?: SeedLeaseContext,
    appliedAt?: Date,
  ): Promise<void> {
    const changeId = resolveSeedTaskManifestId(task.id);
    const manifestEntry = getChangeManifestEntry(changeId);

    await shadowWriteChangeHistory(
      this.db,
      {
        changeId,
        legacyId: task.id,
        description: task.description,
        environment: resolveChangeEnvironment(),
        engine: 'mongodb',
        kind: manifestEntry?.kind ?? 'seed_platform',
        phase: manifestEntry?.phase ?? 'continuous',
        scope:
          manifestEntry?.scope ?? (target.targetKey.startsWith('tenant:') ? 'tenant' : 'global'),
        status,
        targetKey: target.targetKey,
        checksum: update.checksum,
        validationStatus: update.validationStatus,
        validationSummary: update.validationSummary,
        validationDetails: update.validationDetails,
        durationMs,
        lastError: update.lastError ?? null,
        lastValidatedAt: update.lastValidatedAt,
        appliedAt,
        releaseId: process.env.CHANGE_RELEASE_ID ?? null,
        appliedBy: sharedContext?.holderId ?? buildSeedLockHolderId(),
        buildInfo: resolveBuildInfo(),
        releaseEvidence: resolveReleaseEvidence(),
      },
      {
        lockId: sharedContext?.lockId,
        holderId: sharedContext?.holderId,
        fence: sharedContext?.fence,
        runCountDelta,
        shadowSource: HISTORY_COLLECTION,
        shadowKey: buildHistoryKey(task.id, target.targetKey),
      },
    );
  }
}
