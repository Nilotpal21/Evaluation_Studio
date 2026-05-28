/**
 * Reindexing Types
 *
 * Shared type definitions for the 4-checkpoint reindexing system.
 *
 * Checkpoints:
 *   1. Routing    — re-derive flow assignment per document
 *   2. Pre-chunk  — re-extract from source (destroys chunks)
 *   3. Post-chunk — re-enrich existing chunks (LLM stages)
 *   4. Embedding  — re-embed all chunks (vectors only)
 *
 * Reference: docs/searchai/pipelines/REINDEXING-OPTIMIZATION-STRATEGY.md
 */

import type { SearchPipelineStageType } from '@agent-platform/database';

// ─── Change Detection ────────────────────────────────────────────────────

export interface ChangeSet {
  embeddingChanged: boolean;
  routingChanged: boolean;
  preChunkChanges: FlowStageChange[];
  postChunkChanges: FlowStageChange[];
}

export interface FlowStageChange {
  flowId: string;
  flowName: string;
  stageType: SearchPipelineStageType;
  changeType: 'added' | 'removed' | 'provider-changed' | 'config-changed';
}

export interface PersistedChangeSet extends ChangeSet {
  changeSetId: string;
  tenantId: string;
  knowledgeBaseId: string;
  pipelineId: string;
  previousPipelineVersion: number;
  newPipelineVersion: number;
  status: 'pending' | 'confirmed' | 'executing' | 'completed' | 'cancelled';
  createdAt: Date;
  plan?: ReindexPlan;
}

// ─── Reindex Plan ────────────────────────────────────────────────────────

export interface ReindexAction {
  documentId?: string;
  chunkId?: string;
  flowId: string;
  checkpoint: 1 | 2 | 3 | 4;
  stages: SearchPipelineStageType[];
}

export interface ReindexEstimate {
  totalItems: number;
  estimatedDurationMin: number;
  estimatedCostUsd: number;
}

export interface ReindexPlan {
  actions: ReindexAction[];
  summary: ReindexSummary;
}

export interface ReindexSummary {
  checkpoint1Count: number;
  checkpoint2Count: number;
  checkpoint3Count: number;
  checkpoint4Count: number;
  totalDocuments: number;
  totalChunks: number;
  estimatedCostUsd: number;
  estimatedDurationMin: number;
}

export interface ReindexParams {
  tenantId: string;
  knowledgeBaseId: string;
  pipelineId: string;
  indexId: string;
  batchId: string;
}

export interface ReindexResult {
  batchId: string;
  totalItems: number;
  summary: ReindexSummary;
}

// ─── Pluggable Interfaces ────────────────────────────────────────────────

/**
 * Where change sets are stored.
 * Default: MongoDB (via JobExecution). Future: S3, DynamoDB, etc.
 */
export interface ChangeStore {
  save(tenantId: string, changeSet: PersistedChangeSet): Promise<string>;
  get(tenantId: string, changeSetId: string): Promise<PersistedChangeSet | null>;
  listPending(tenantId: string, knowledgeBaseId: string): Promise<PersistedChangeSet[]>;
  markProcessed(tenantId: string, changeSetId: string): Promise<void>;
}

/**
 * How each checkpoint processes its items.
 * Default: BullMQ queue dispatch. Future: external ML pipeline, etc.
 */
export interface CheckpointHandler {
  readonly checkpoint: 1 | 2 | 3 | 4;
  estimate(actions: ReindexAction[]): ReindexEstimate;
  execute(actions: ReindexAction[], params: ReindexParams): Promise<void>;
}

/**
 * How the orchestrator is triggered.
 * Default: publish endpoint. Future: scheduled, conditional on store query, etc.
 */
export interface ReindexTrigger {
  readonly name: string;
  shouldTrigger(context: TriggerContext): Promise<boolean>;
  buildChangeSet(context: TriggerContext): Promise<ChangeSet>;
}

export interface TriggerContext {
  tenantId: string;
  knowledgeBaseId: string;
  pipelineId: string;
  previousPipelineVersion?: number;
  newPipelineVersion?: number;
}
