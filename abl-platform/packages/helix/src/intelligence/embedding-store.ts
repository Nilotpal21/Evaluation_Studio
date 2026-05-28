/**
 * EmbeddingStore — per-session JSONL shard store with cosine similarity
 * retrieval and mandatory project/tenant scoping.
 *
 * Design decisions (from LLD + slice findings):
 *
 * D-L1: Per-session JSONL shards at `.helix/cache/embeddings/bge-m3-1024/
 *        {findings,decisions}/<sessionId>.jsonl`.
 * D-L7: Stage-complete hook lives here via `notifyStageComplete`.
 * D-L8: `contentHash` computed lazily on `notifyStageComplete`, not at
 *        `addFinding`/`addDecision` time.
 *
 * ISOLATION INVARIANT (finding: cross-session retrieval lacks project/tenant
 * scoping filter):
 * - `query()` accepts a mandatory `scope` argument `{ projectId, sessionId? }`.
 * - Records from other projects are NEVER returned.
 * - A `projectId` field is included on every `EmbeddingRecord.metadata`
 *   so the consolidated index can also be scoped at read time.
 */

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  Decision,
  EmbeddingRecord,
  EmbeddingRecordKind,
  EmbeddingShardPaths,
  Finding,
  HelixEmbeddingProviderConfig,
  Session,
  StageDefinition,
} from '../types.js';
import type { BgeM3Client, EmbedResponse } from './bge-m3-client.js';
import {
  buildEmbeddingShardPaths,
  HELIX_EMBEDDING_DIMENSIONS,
  HELIX_EMBEDDING_MODEL_KEY,
} from './embedding-config.js';
import { appendEmbeddingRecord, readEmbeddingShardFile } from './shard-writer.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmbeddingQueryScope {
  /** Required: only return records whose `metadata.projectId` matches. */
  projectId: string;
  /** Optional: restrict to a specific session. */
  sessionId?: string;
}

export interface EmbeddingQueryOptions {
  topN?: number;
  /** Minimum cosine similarity to include a result (0–1). Defaults to 0.5. */
  minScore?: number;
  kind?: EmbeddingRecordKind;
}

export interface EmbeddingQueryResult {
  record: EmbeddingRecord;
  score: number;
}

// ── EmbeddingStore ────────────────────────────────────────────────────────────

export class EmbeddingStore {
  private readonly provider: HelixEmbeddingProviderConfig;
  private readonly client: BgeM3Client;

  constructor(provider: HelixEmbeddingProviderConfig, client: BgeM3Client) {
    this.provider = provider;
    this.client = client;
  }

  /**
   * Stage-complete hook (D-L7).
   *
   * Computes `contentHash` lazily (D-L8) and embeds all findings/decisions
   * produced in the completed stage. Gracefully skips when the embedding
   * endpoint is unreachable.
   */
  async notifyStageComplete(session: Session, stage: StageDefinition): Promise<void> {
    if (!this.provider.enabled) return;

    const shardPaths = buildEmbeddingShardPaths({
      basePath: this.provider.shardBasePath,
      sessionId: session.id,
      modelKey: this.provider.modelKey,
    });

    // Collect items from the most recently completed stage
    const stageName = stage.name;
    const stageFindings = session.findings.filter(
      (f) => !('embeddedInStage' in f) && matchesStage(f, stageName),
    );
    const stageDecisions = session.decisions.filter(
      (d) => !('embeddedInStage' in d) && matchesStage(d, stageName),
    );

    if (stageFindings.length === 0 && stageDecisions.length === 0) return;

    const projectId = resolveProjectId(session);

    await this.embedAndAppend(stageFindings, 'finding', session, shardPaths, projectId);
    await this.embedAndAppend(stageDecisions, 'decision', session, shardPaths, projectId);
  }

  /**
   * Query for relevant prior context.
   *
   * ISOLATION: `scope.projectId` is mandatory. Records from other projects
   * are never returned regardless of cosine score.
   */
  async query(
    queryText: string,
    scope: EmbeddingQueryScope,
    options: EmbeddingQueryOptions = {},
  ): Promise<EmbeddingQueryResult[]> {
    if (!this.provider.enabled) return [];
    if (!queryText.trim()) return [];

    const { topN = 10, minScore = 0.5, kind } = options;

    // Load candidate shards before calling BGE-M3. This keeps prompt-context
    // refresh cheap in fresh workspaces and avoids external calls when there is
    // no index content to rank.
    const candidates = await this.loadScopedRecords(scope, kind);
    if (candidates.length === 0) return [];

    let embedResponse: EmbedResponse | null;
    try {
      embedResponse = await this.client.embedBatch([queryText]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[helix:embeddings] query embedding failed: ${message}\n`);
      return [];
    }
    if (!embedResponse || embedResponse.embeddings.length === 0) return [];
    const queryVector = embedResponse.embeddings[0];

    // Score all candidates and filter
    const scored: EmbeddingQueryResult[] = [];
    for (const record of candidates) {
      const score = cosineSimilarity(queryVector, record.vector);
      if (score >= minScore) {
        scored.push({ record, score });
      }
    }

    // Sort descending by score, take topN
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async embedAndAppend(
    items: Finding[] | Decision[],
    kind: EmbeddingRecordKind,
    session: Session,
    shardPaths: EmbeddingShardPaths,
    projectId: string,
  ): Promise<void> {
    if (items.length === 0) return;

    // Build text representations and content hashes
    const texts: string[] = items.map((item) => buildItemText(item));
    const hashes: string[] = texts.map(computeContentHash);

    // Embed
    let embedResponse: EmbedResponse | null;
    try {
      embedResponse = await this.client.embedBatch(texts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[helix:embeddings] stage embedding failed: ${message}\n`);
      return;
    }
    if (!embedResponse) return; // endpoint unreachable — skip gracefully

    // Write records
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const vector = embedResponse.embeddings[i];
      if (!vector || vector.length === 0) continue;

      const record: EmbeddingRecord = {
        id: item.id,
        kind,
        contentHash: hashes[i],
        model: embedResponse.model,
        dimensions: vector.length,
        vector,
        metadata: {
          severity: kind === 'finding' ? (item as Finding).severity : undefined,
          category: kind === 'finding' ? (item as Finding).category : undefined,
          classification: kind === 'decision' ? (item as Decision).classification : undefined,
          files: kind === 'finding' ? (item as Finding).files.map((f) => f.path) : [],
          package: undefined,
          featureSlug: slugify(session.workItem.title),
          sessionId: session.id,
          // projectId stored in metadata for isolation enforcement at query time
          ...(projectId ? { projectId } : {}),
          createdAt: new Date().toISOString(),
          stage: undefined,
        },
      };

      await appendEmbeddingRecord(record, shardPaths);
    }
  }

  private async loadScopedRecords(
    scope: EmbeddingQueryScope,
    kind?: EmbeddingRecordKind,
  ): Promise<EmbeddingRecord[]> {
    const basePath = this.provider.shardBasePath;
    const modelKey = this.provider.modelKey ?? HELIX_EMBEDDING_MODEL_KEY;
    const allRecords: EmbeddingRecord[] = [];

    // Determine which shard directories to scan
    const shardDirs =
      kind === 'finding'
        ? ['findings']
        : kind === 'decision'
          ? ['decisions']
          : ['findings', 'decisions'];

    for (const dirName of shardDirs) {
      const shardDir = join(basePath, dirName);

      let files: string[];
      try {
        files = await readdir(shardDir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        throw err;
      }

      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

      // If session-scoped, only read the matching shard file
      const filesToRead = scope.sessionId
        ? jsonlFiles.filter((f) => f === `${scope.sessionId}.jsonl`)
        : jsonlFiles;

      for (const file of filesToRead) {
        const filePath = join(shardDir, file);
        const records = await readEmbeddingShardFile(filePath);

        // ISOLATION: filter strictly by projectId
        const scopedRecords = records.filter((r) => getMetadataProjectId(r) === scope.projectId);

        allRecords.push(...scopedRecords);
      }
    }

    return allRecords;
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

function computeContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 32);
}

function buildItemText(item: Finding | Decision): string {
  if ('description' in item && 'severity' in item) {
    // Finding
    const f = item as Finding;
    return `${f.title}\n${f.description}\nFiles: ${f.files.map((r) => r.path).join(', ')}`;
  }
  // Decision — uses question + context (no title/rationale fields on Decision)
  const d = item as Decision;
  return `${d.question}\n${d.context}${d.answer ? `\nAnswer: ${d.answer}` : ''}`;
}

function matchesStage(item: Finding | Decision, stageName: string): boolean {
  // All items produced in the session are eligible; we can't filter by stage
  // because the Finding/Decision types don't carry a `stage` field on the
  // runtime objects. We rely on the caller to call this after each stage push.
  void item;
  void stageName;
  return true;
}

function resolveProjectId(session: Session): string {
  // Use the Jira key as project discriminator when available; fall back to
  // a slug of the work-item title (stable across reruns with the same title).
  return (
    session.bootstrapMeta?.jiraKey ?? session.workItem.jiraKey ?? slugify(session.workItem.title)
  );
}

function getMetadataProjectId(record: EmbeddingRecord): string | undefined {
  // `projectId` is now a declared optional field on `EmbeddingRecordMetadata`.
  return record.metadata.projectId;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// ── Re-export dimension constant so callers don't need to import embedding-config ──
export { HELIX_EMBEDDING_DIMENSIONS, HELIX_EMBEDDING_MODEL_KEY };
