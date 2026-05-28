/**
 * Migration Types
 *
 * Defines the interface for database migrations and their metadata.
 */

import mongoose from 'mongoose';
import type { ChangePhase } from '../change-management/types.js';

type Db = mongoose.mongo.Db;
type ClientSession = mongoose.mongo.ClientSession;

export type MigrationValidationStatus = 'passed' | 'failed' | 'not_configured' | 'never_run';
export type MigrationTransactionMode = 'auto' | 'none';

export interface MigrationPhaseOptions {
  phase?: ChangePhase;
  requireManifestMetadata?: boolean;
}

export interface MigrationValidationResult {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

/** A single migration to be applied */
export interface Migration {
  /** Unique version string — "YYYYMMDD_NNN" (e.g., "20260211_000") */
  version: string;
  /** Human-readable description */
  description: string;
  /**
   * Transaction handling mode for this migration.
   * - `auto` (default): use a transaction when MongoDB supports it.
   * - `none`: always run outside a transaction (required for many index DDL operations).
   */
  transactionMode?: MigrationTransactionMode;
  /** Apply the migration */
  up(db: Db, session?: ClientSession): Promise<void>;
  /** Reverse the migration */
  down(db: Db, session?: ClientSession): Promise<void>;
  /**
   * Optional post-apply validation. This runs after `up()` and can also be
   * invoked later via the CLI to re-validate already-applied migrations.
   */
  validate?(db: Db, session?: ClientSession): Promise<MigrationValidationResult>;
}

/** Stored in _migration_history collection */
export interface MigrationHistoryEntry {
  version: string;
  description: string;
  appliedAt: Date;
  durationMs: number;
  status: 'applied' | 'rolled_back' | 'failed';
  checksum?: string;
  validationStatus?: MigrationValidationStatus;
  validationSummary?: string;
  validationDetails?: Record<string, unknown>;
  lastValidatedAt?: Date;
  lastError?: string | null;
  runCount?: number;
}

/** Migration lock document in _migration_lock collection */
export interface MigrationLock {
  _id: string;
  lockedBy: string;
  lockedAt: Date;
  expiresAt: Date;
  fence?: number;
}

/** Result of a migration run */
export interface MigrationResult {
  applied: string[];
  skipped: string[];
  validated: string[];
  failed: string | null;
  checksumMismatches: string[];
  durationMs: number;
}

/** Status of a single migration */
export interface MigrationStatus {
  version: string;
  description: string;
  status: 'applied' | 'pending' | 'rolled_back' | 'failed';
  appliedAt?: Date;
  durationMs?: number;
  checksumStatus?: 'match' | 'mismatch' | 'missing';
  validationStatus?: MigrationValidationStatus;
  validationSummary?: string;
  lastValidatedAt?: Date;
  lastError?: string | null;
  runCount?: number;
}

export interface MigrationValidationRunResult {
  version: string;
  description: string;
  status: MigrationValidationStatus | 'pending';
  summary?: string;
  details?: Record<string, unknown>;
  lastError?: string;
}
