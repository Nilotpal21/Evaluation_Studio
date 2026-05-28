/**
 * Layer Disassembler types — contracts for converting exported file maps
 * back into StagedRecord[] suitable for StagedImporter.execute().
 *
 * Mirror of the LayerAssembler interface in export/layer-assemblers/.
 */

import type { ImportConflictStrategyV2, LayerName, ManifestAgent } from '../../types.js';
import type { StagedRecord, SupersededRecord } from '../staged-importer.js';

/** Context provided to every disassembler */
export interface DisassembleContext {
  /** Files belonging to this layer (from FolderReadResultV2.layerFiles[layer]) */
  files: Map<string, string>;
  projectId: string;
  tenantId: string;
  userId: string;
  /** Conflict strategy: replace full layers, skip existing matches, or merge/upsert matching records */
  conflictStrategy: ImportConflictStrategyV2;
  /**
   * IDs of existing active records in the target project, keyed by collection name.
   * Used to build SupersededRecord entries for records that will be replaced.
   * Populated by the orchestrator via ImportDbAdapter.findActiveRecordIds().
   *
   * All queries MUST project only { _id: 1, [matchField]: 1 } for efficiency.
   */
  existingRecordIds?: Map<string, Array<{ _id: string; [key: string]: unknown }>>;
  /**
   * Auth profile name-to-ID mapping for the target tenant/project.
   * Populated by the orchestrator from AuthProfileCandidate lookups.
   * Used by ConnectionsDisassembler to resolve authProfileName -> authProfileId.
   */
  authProfileMapping?: Record<string, string>;
  /**
   * Manifest v2 metadata — some disassemblers need required_auth_profiles
   * or entity_counts for validation.
   */
  manifestMetadata?: {
    required_auth_profiles?: Array<{
      name: string;
      authType: string;
      scope: 'tenant' | 'project';
      referencedBy: string[];
    }>;
    entity_counts?: Record<string, number>;
  };
  /** Agent companion metadata from project.json keyed by manifest agent name. */
  manifestAgents?: Record<string, ManifestAgent>;
}

/** Result returned by every disassembler */
export interface DisassembleResult {
  records: StagedRecord[];
  superseded: SupersededRecord[];
  warnings: string[];
}

/** Contract for all layer disassemblers */
export interface LayerDisassembler {
  readonly layer: LayerName;
  disassemble(ctx: DisassembleContext): Promise<DisassembleResult>;
}
