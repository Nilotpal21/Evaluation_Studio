/**
 * Staged Importer — implements 3-phase import with rollback support
 *
 * Phase 2 (Stage): Write new/updated records with import lifecycle metadata
 * Phase 3 (Activate): Per-layer atomic swap (staged→visible, old→hidden/superseded)
 * Phase 4 (Cleanup): Async deletion of superseded records
 *
 * On Phase 3 failure: rollback completed layers (staged→deleted, superseded→visible)
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { LayerName, ImportPhase } from '../types.js';

const log = createLogger('staged-importer');

// ─── Constants ──────────────────────────────────────────────────────────

/** Activation order — dependencies before dependents */
export const ACTIVATION_ORDER: LayerName[] = [
  'connections',
  'prompts',
  'core', // tools + agents
  'search',
  'workflows',
  'guardrails',
  'evals',
  'channels',
  'vocabulary',
];

/**
 * Staging order for collections that need parent IDs materialized before insert.
 *
 * Activation still follows layer order, but raw staging writes must also respect
 * intra-layer dependencies so unique indexes do not see missing parent IDs as
 * repeated null values.
 */
const STAGING_COLLECTION_ORDER = [
  'prompt_library_items',
  'prompt_library_versions',
  'workflows',
  'workflow_versions',
  'trigger_registrations',
  'search_indexes',
  'knowledge_bases',
  'search_sources',
  'connector_configs',
  'crawl_patterns',
  'domain_vocabularies',
  'canonical_schemas',
  'facts',
] as const;

const STAGING_COLLECTION_RANK = new Map<string, number>(
  STAGING_COLLECTION_ORDER.map((collection, index) => [collection, index]),
);

/** Default TTL for import operations (1 hour) */
const IMPORT_OPERATION_TTL_MS = 60 * 60 * 1000;

/**
 * Dedicated import lifecycle metadata field.
 *
 * Do not overload business `status`: target collections use incompatible status
 * enums, and some collections do not have a status field at all. The database
 * adapter should persist this field via raw collection writes when Mongoose
 * schemas are strict.
 */
export const IMPORT_LIFECYCLE_FIELD = '__ablImport';

export type ImportLifecycleState = 'staged' | 'superseded' | 'deleted';

export interface ImportLifecycleMetadata {
  operationId: string;
  state: ImportLifecycleState;
  layer: LayerName;
  stagedAt: string;
}

function buildImportLifecycleMetadata(
  operationId: string,
  layer: LayerName,
): ImportLifecycleMetadata {
  return {
    operationId,
    state: 'staged',
    layer,
    stagedAt: new Date().toISOString(),
  };
}

function stageCollectionRank(collection: string): number {
  return STAGING_COLLECTION_RANK.get(collection) ?? Number.MAX_SAFE_INTEGER;
}

function importRecordCollectionKeys(
  stagedRecordIds: Record<string, string[]>,
  supersededRecordIds: Record<string, string[]>,
): string[] {
  return Array.from(
    new Set([...Object.keys(stagedRecordIds), ...Object.keys(supersededRecordIds)]),
  );
}

function buildSafeStagingFailureMessage(collection: string | null, layer: string): string {
  if (!collection) {
    return 'Could not stage imported records. Check the archive for duplicate names or missing parent references.';
  }

  const layerSuffix = layer === 'unknown' ? '' : ` in layer "${layer}"`;
  return `Could not stage records for collection "${collection}"${layerSuffix}. Check for duplicate names or missing parent references.`;
}

// ─── Types ──────────────────────────────────────────────────────────────

/** A record to be staged during import */
export interface StagedRecord {
  /** The layer this record belongs to */
  layer: LayerName;
  /** The MongoDB collection name */
  collection: string;
  /** The document data to insert. Business fields, including status, are preserved. */
  data: Record<string, unknown>;
}

/** Represents a record that will be superseded by a staged record */
export interface SupersededRecord {
  layer: LayerName;
  collection: string;
  recordId: string;
}

/** Result of the staging phase */
export interface StageResult {
  success: boolean;
  stagedRecordIds: Record<string, string[]>;
  error?: { phase: string; layer: string; message: string };
}

/** Result of the activation phase */
export interface ActivateResult {
  success: boolean;
  activatedLayers: string[];
  supersededRecordIds: Record<string, string[]>;
  error?: { phase: string; layer: string; message: string };
}

/** Result of a full staged import */
export interface StagedImportResult {
  success: boolean;
  operationId: string;
  phase: ImportPhase;
  stagedRecordIds: Record<string, string[]>;
  supersededRecordIds: Record<string, string[]>;
  error?: { phase: string; layer: string; message: string };
}

/** Database adapter interface — decouples from Mongoose for testability */
export interface ImportDbAdapter {
  /** Create an import operation record */
  createImportOperation(params: {
    projectId: string;
    tenantId: string;
    layers: Record<string, { status: string }>;
    expiresAt: Date;
  }): Promise<{ _id: string }>;

  /** Update an import operation record */
  updateImportOperation(
    operationId: string,
    projectId: string,
    tenantId: string,
    update: Record<string, unknown>,
  ): Promise<void>;

  /** Insert records with import lifecycle metadata. Must not overwrite business status. */
  insertStagedRecords(
    collection: string,
    records: Array<Record<string, unknown>>,
  ): Promise<string[]>;

  /** Delete records by IDs (for staging rollback) */
  deleteRecordsByIds(collection: string, ids: string[]): Promise<void>;

  /**
   * Atomic bulk write: make staged records visible and hide/supersede old records.
   * Implementations must not overwrite domain-specific `status` fields.
   */
  activateLayer(collection: string, stagedIds: string[], supersededIds: string[]): Promise<void>;

  /** Rollback: hide staged records and restore previously superseded records. */
  rollbackLayer(collection: string, stagedIds: string[], supersededIds: string[]): Promise<void>;

  /** Find existing active records that match the import data (for superseding) */
  findActiveRecordIds(
    collection: string,
    projectId: string,
    tenantId: string,
    matchField: string,
    matchValues: string[],
  ): Promise<Array<{ _id: string; [key: string]: unknown }>>;
}

// ─── Staged Importer ────────────────────────────────────────────────────

export class StagedImporter {
  /** Tracks which collections belong to each layer during staging */
  private layerCollectionMap = new Map<string, Set<string>>();

  constructor(private readonly db: ImportDbAdapter) {}

  private layerForCollection(collection: string | null): string {
    if (!collection) {
      return 'unknown';
    }

    const layers: string[] = [];
    for (const [layer, collections] of this.layerCollectionMap.entries()) {
      if (collections.has(collection)) {
        layers.push(layer);
      }
    }

    return layers.join(',') || 'unknown';
  }

  /**
   * Execute a full staged import: stage → activate → cleanup.
   *
   * @param projectId - Target project
   * @param tenantId - Tenant scope
   * @param records - Records to import, grouped by layer
   * @param supersededRecords - Existing records to supersede
   * @param requestedLayers - Layers being imported
   */
  async execute(
    projectId: string,
    tenantId: string,
    records: StagedRecord[],
    supersededRecords: SupersededRecord[],
    requestedLayers: LayerName[],
  ): Promise<StagedImportResult> {
    // Initialize import operation
    const layerStatuses: Record<string, { status: string }> = {};
    for (const layer of requestedLayers) {
      layerStatuses[layer] = { status: 'pending' };
    }

    const operation = await this.db.createImportOperation({
      projectId,
      tenantId,
      layers: layerStatuses,
      expiresAt: new Date(Date.now() + IMPORT_OPERATION_TTL_MS),
    });

    const operationId = operation._id;
    log.info('Import operation created', { operationId, projectId, layers: requestedLayers });

    // Phase 2: Stage
    const stageResult = await this.stage(
      operationId,
      projectId,
      tenantId,
      records,
      requestedLayers,
    );

    if (!stageResult.success) {
      await this.db.updateImportOperation(operationId, projectId, tenantId, {
        status: 'failed',
        error: stageResult.error,
      });
      return {
        success: false,
        operationId,
        phase: 'failed',
        stagedRecordIds: stageResult.stagedRecordIds,
        supersededRecordIds: {},
        error: stageResult.error,
      };
    }

    // Phase 3: Activate
    await this.db.updateImportOperation(operationId, projectId, tenantId, {
      status: 'activating',
      stagedRecordIds: stageResult.stagedRecordIds,
    });

    const activateResult = await this.activate(
      operationId,
      projectId,
      tenantId,
      stageResult.stagedRecordIds,
      supersededRecords,
      requestedLayers,
    );

    if (!activateResult.success) {
      // Rollback completed layers
      await this.db.updateImportOperation(operationId, projectId, tenantId, {
        status: 'rolling_back',
      });

      await this.rollback(
        operationId,
        projectId,
        tenantId,
        stageResult.stagedRecordIds,
        activateResult.supersededRecordIds,
        activateResult.activatedLayers,
      );

      await this.db.updateImportOperation(operationId, projectId, tenantId, {
        status: 'failed',
        error: activateResult.error,
      });

      return {
        success: false,
        operationId,
        phase: 'failed',
        stagedRecordIds: stageResult.stagedRecordIds,
        supersededRecordIds: activateResult.supersededRecordIds,
        error: activateResult.error,
      };
    }

    // Phase 4: Cleanup (async, non-blocking)
    await this.db.updateImportOperation(operationId, projectId, tenantId, {
      status: 'completed',
      supersededRecordIds: activateResult.supersededRecordIds,
    });

    // Fire and forget cleanup — idempotent, safe to retry
    this.cleanup(activateResult.supersededRecordIds, supersededRecords).catch((err) => {
      log.warn('Cleanup of superseded records failed (will retry via TTL)', {
        operationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info('Import operation completed', { operationId, projectId });

    return {
      success: true,
      operationId,
      phase: 'completed',
      stagedRecordIds: stageResult.stagedRecordIds,
      supersededRecordIds: activateResult.supersededRecordIds,
    };
  }

  /**
   * Phase 2: Stage — write all records with import lifecycle metadata.
   * On failure, clean up all staged records.
   */
  async stage(
    operationId: string,
    projectId: string,
    tenantId: string,
    records: StagedRecord[],
    requestedLayers: LayerName[],
  ): Promise<StageResult> {
    const stagedRecordIds: Record<string, string[]> = {};

    await this.db.updateImportOperation(operationId, projectId, tenantId, {
      status: 'staging',
    });

    // Build layer → collection mapping from the original records
    this.layerCollectionMap = new Map<string, Set<string>>();
    for (const record of records) {
      const existing = this.layerCollectionMap.get(record.layer) ?? new Set<string>();
      existing.add(record.collection);
      this.layerCollectionMap.set(record.layer, existing);
    }

    // Group records by collection for batch insert
    const byCollection = new Map<string, Array<Record<string, unknown>>>();
    for (const record of records) {
      const existing = byCollection.get(record.collection) ?? [];
      existing.push({
        ...record.data,
        [IMPORT_LIFECYCLE_FIELD]: buildImportLifecycleMetadata(operationId, record.layer),
      });
      byCollection.set(record.collection, existing);
    }

    let currentCollection: string | null = null;

    try {
      const orderedCollections = [...byCollection.entries()]
        .map(([collection, docs], index) => ({ collection, docs, index }))
        .sort((a, b) => {
          const rankDelta = stageCollectionRank(a.collection) - stageCollectionRank(b.collection);
          return rankDelta === 0 ? a.index - b.index : rankDelta;
        });

      for (const { collection, docs } of orderedCollections) {
        currentCollection = collection;
        const ids = await this.db.insertStagedRecords(collection, docs);
        stagedRecordIds[collection] = [...(stagedRecordIds[collection] ?? []), ...ids];
      }

      // Update import operation layer statuses to 'staged'
      const layerUpdates: Record<string, { status: string }> = {};
      for (const layer of requestedLayers) {
        layerUpdates[layer] = { status: 'staged' };
      }
      await this.db.updateImportOperation(operationId, projectId, tenantId, {
        layers: layerUpdates,
        stagedRecordIds,
      });

      log.info('Staging complete', { operationId, collections: Object.keys(stagedRecordIds) });
      return { success: true, stagedRecordIds };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failedLayer = this.layerForCollection(currentCollection);
      log.error('Staging failed, cleaning up staged records', {
        operationId,
        collection: currentCollection,
        layer: failedLayer,
        error: message,
      });

      // Clean up any staged records we managed to create
      for (const [collection, ids] of Object.entries(stagedRecordIds)) {
        try {
          await this.db.deleteRecordsByIds(collection, ids);
        } catch (cleanupErr) {
          log.warn('Failed to clean up staged records', {
            collection,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }

      return {
        success: false,
        stagedRecordIds: {},
        error: {
          phase: 'staging',
          layer: failedLayer,
          message: buildSafeStagingFailureMessage(currentCollection, failedLayer),
        },
      };
    }
  }

  /**
   * Phase 3: Activate — per-layer in dependency order.
   * Each layer: single bulkWrite that hides old records and makes staged records visible.
   */
  async activate(
    operationId: string,
    projectId: string,
    tenantId: string,
    stagedRecordIds: Record<string, string[]>,
    supersededRecords: SupersededRecord[],
    requestedLayers: LayerName[],
  ): Promise<ActivateResult> {
    const activatedLayers: string[] = [];
    const supersededRecordIds: Record<string, string[]> = {};

    // Build superseded lookup by collection
    const supersededByCollection = new Map<string, string[]>();
    for (const rec of supersededRecords) {
      const existing = supersededByCollection.get(rec.collection) ?? [];
      existing.push(rec.recordId);
      supersededByCollection.set(rec.collection, existing);
    }

    // Activate in dependency order, only for requested layers
    const orderedLayers = ACTIVATION_ORDER.filter((l) => requestedLayers.includes(l));

    for (const layer of orderedLayers) {
      try {
        // Find collections that have staged records for this layer.
        // Use the layerCollectionMap (built during staging) as the primary source,
        // supplemented by superseded records for backward compatibility.
        const layerCollections = new Set<string>();

        // Include collections tracked during staging (covers new-only imports)
        const stagedLayerCollections = this.layerCollectionMap.get(layer);
        if (stagedLayerCollections) {
          for (const coll of stagedLayerCollections) {
            layerCollections.add(coll);
          }
        }

        // Also include collections from superseded records for this layer
        for (const rec of supersededRecords) {
          if (rec.layer === layer) {
            layerCollections.add(rec.collection);
          }
        }

        for (const collection of layerCollections) {
          const staged = stagedRecordIds[collection] ?? [];
          const superseded = supersededByCollection.get(collection) ?? [];

          if (staged.length > 0 || superseded.length > 0) {
            await this.db.activateLayer(collection, staged, superseded);
            supersededRecordIds[collection] = [
              ...(supersededRecordIds[collection] ?? []),
              ...superseded,
            ];
          }
        }

        activatedLayers.push(layer);

        // Update layer status
        await this.db.updateImportOperation(operationId, projectId, tenantId, {
          [`layers.${layer}`]: { status: 'activated' },
        });

        log.info('Layer activated', { operationId, layer });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Activation failed', { operationId, layer, error: message });

        return {
          success: false,
          activatedLayers,
          supersededRecordIds,
          error: { phase: 'activating', layer, message },
        };
      }
    }

    return { success: true, activatedLayers, supersededRecordIds };
  }

  /**
   * Rollback completed layers: hide staged records and restore previously visible records.
   * Each collection is rolled back only once to avoid duplicate operations.
   */
  async rollback(
    operationId: string,
    projectId: string,
    tenantId: string,
    stagedRecordIds: Record<string, string[]>,
    supersededRecordIds: Record<string, string[]>,
    activatedLayers: string[],
  ): Promise<void> {
    log.info('Rolling back', { operationId, layers: activatedLayers });

    // Deduplicate: rollback each collection only once regardless of layer count.
    // The stagedRecordIds/supersededRecordIds are keyed by collection (not layer),
    // so iterating all collections per layer would cause redundant rollback calls.
    const rolledBackCollections = new Set<string>();

    // Rollback activated layers in reverse order
    for (const layer of [...activatedLayers].reverse()) {
      for (const collection of importRecordCollectionKeys(stagedRecordIds, supersededRecordIds)) {
        if (rolledBackCollections.has(collection)) continue;

        try {
          const staged = stagedRecordIds[collection] ?? [];
          const superseded = supersededRecordIds[collection] ?? [];

          if (staged.length > 0 || superseded.length > 0) {
            await this.db.rollbackLayer(collection, staged, superseded);
            rolledBackCollections.add(collection);
          }
        } catch (err) {
          log.error('Rollback failed for collection', {
            operationId,
            layer,
            collection,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await this.db.updateImportOperation(operationId, projectId, tenantId, {
        [`layers.${layer}`]: { status: 'rolled_back' },
      });
    }

    // Clean up any staged records in collections not covered by activated layers
    // (e.g., when activation fails on the first layer, activatedLayers is [])
    for (const collection of Object.keys(stagedRecordIds)) {
      if (rolledBackCollections.has(collection)) continue;

      try {
        const staged = stagedRecordIds[collection] ?? [];
        if (staged.length > 0) {
          await this.db.rollbackLayer(collection, staged, []);
          rolledBackCollections.add(collection);
        }
      } catch (err) {
        log.error('Cleanup of un-activated staged records failed', {
          operationId,
          collection,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('Rollback complete', { operationId });
  }

  /**
   * Build StagedRecord entries from workflow version files.
   * Parses each version JSON and creates records with status reset to 'draft'.
   *
   * @param workflowVersionFiles - Map of filePath → JSON content from folder reader
   * @param projectId - Target project
   * @param tenantId - Tenant scope
   * @param userId - User performing the import (fallback for createdBy)
   * @returns Array of StagedRecord for workflow versions and any warnings
   */
  buildWorkflowVersionRecords(
    workflowVersionFiles: Map<string, string>,
    projectId: string,
    tenantId: string,
    userId?: string,
  ): { records: StagedRecord[]; warnings: string[] } {
    const records: StagedRecord[] = [];
    const warnings: string[] = [];

    for (const [filePath, content] of workflowVersionFiles) {
      try {
        const parsed = JSON.parse(content);
        // Extract workflow name from path: workflows/versions/{name}/{version}.version.json
        const pathParts = filePath.split('/');
        const workflowName = pathParts[2]; // workflows/versions/{name}/...

        if (!workflowName) {
          warnings.push(
            `Skipping version file ${filePath}: could not extract workflow name from path`,
          );
          continue;
        }

        if (!parsed.version || !parsed.definition) {
          warnings.push(
            `Skipping version file ${filePath}: missing required fields (version, definition)`,
          );
          continue;
        }

        records.push({
          layer: 'workflows',
          collection: 'workflowversions',
          data: {
            workflowName, // Caller must resolve to workflowId before inserting
            version: parsed.version,
            tenantId,
            projectId,
            definition: parsed.definition,
            sourceHash: parsed.source_hash ?? null,
            status: 'draft', // ALWAYS reset to draft on import
            changelog: parsed.changelog ?? null,
            createdBy: parsed.created_by ?? userId ?? 'import',
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Failed to parse version file ${filePath}: ${msg}`);
      }
    }

    return { records, warnings };
  }

  /**
   * Phase 4: Cleanup — delete superseded records.
   * Idempotent — safe to retry.
   */
  private async cleanup(
    supersededRecordIds: Record<string, string[]>,
    supersededRecords: SupersededRecord[],
  ): Promise<void> {
    for (const [collection, ids] of Object.entries(supersededRecordIds)) {
      if (ids.length > 0) {
        await this.db.deleteRecordsByIds(collection, ids);
      }
    }
    log.info('Cleanup of superseded records complete');
  }
}
