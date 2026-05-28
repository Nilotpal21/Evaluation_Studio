/**
 * Resilience layer - filesystem WAL and recovery for zero data loss.
 *
 * Components:
 * - FileSystemWAL: Append-only JSONL log with rotation
 * - EventRecoveryService: Replay WAL on startup + periodic recovery
 *
 * Used by ResilientEventEmitter for 3-level failover.
 */

export { FileSystemWAL, type WALConfig } from './filesystem-wal.js';
export { EventRecoveryService, type RecoveryResult } from './event-recovery-service.js';
