/**
 * Sync Coordinator Interface
 *
 * Defines the contract for sync coordinators that orchestrate document synchronization.
 * Concrete connectors implement these methods with provider-specific logic.
 */

import type { ISyncCheckpoint } from '@agent-platform/database';
import type { SyncResult } from './connector.interface.js';

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Source document from external system (pre-normalization).
 * Connector-specific structure before mapping to SearchDocument.
 */
export interface SourceDocument {
  /** Unique identifier in source system */
  id: string;
  /** Document name/title */
  name: string;
  /** Direct URL to document */
  url: string;
  /** MIME type */
  contentType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Last modified timestamp */
  modifiedAt: Date;
  /** Created timestamp */
  createdAt: Date;
  /** Raw content (if inline) or null (if needs separate fetch) */
  content: Buffer | null;
  /** Connector-specific metadata */
  metadata: Record<string, any>;
}

/**
 * Sync progress callback.
 * Called periodically during sync to report progress.
 */
export interface SyncProgressCallback {
  (progress: {
    processedCount: number;
    totalCount?: number;
    currentResource: string;
    documentsPerSecond: number;
  }): void;
}

// ─── Interface ───────────────────────────────────────────────────────────

export interface ISyncCoordinator {
  /**
   * Perform synchronization (full or delta).
   *
   * @param syncType - 'full' or 'delta'
   * @param checkpoint - Optional checkpoint to resume from
   * @param progressCallback - Optional callback for progress updates
   */
  performSync(
    syncType: 'full' | 'delta',
    checkpoint?: ISyncCheckpoint,
    progressCallback?: SyncProgressCallback,
  ): Promise<SyncResult>;

  /**
   * Fetch documents from source system.
   * Connector-specific implementation.
   *
   * @param checkpoint - Current checkpoint state
   */
  fetchDocuments(checkpoint: ISyncCheckpoint | null): Promise<SourceDocument[]>;

  /**
   * Get delta token for incremental sync.
   * Returns null if no delta token is available (first sync).
   */
  getDeltaToken(): Promise<string | null>;

  /**
   * Save checkpoint for pause/resume.
   *
   * @param checkpoint - Checkpoint to save
   */
  saveCheckpoint(checkpoint: ISyncCheckpoint): Promise<void>;

  /**
   * Load latest checkpoint for resumption.
   *
   * @param connectorId - Connector ID
   */
  loadCheckpoint(connectorId: string): Promise<ISyncCheckpoint | null>;
}
