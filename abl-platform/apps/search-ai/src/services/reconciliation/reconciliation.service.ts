/**
 * Reconciliation Service
 *
 * Orchestrates the full reconciliation pipeline for novel attributes:
 * 1. Match novels against existing canonical attributes (cosine similarity)
 * 2. Cluster remaining unmatched novels (agglomerative clustering)
 * 3. Evaluate promotion / discard for remaining novels
 */

import type { EmbeddingProvider } from '@agent-platform/search-ai-internal/embedding';
import type { IAttributeRegistry } from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform';
import { ClusteringService } from './clustering.service.js';
import { evaluatePromotion } from './auto-promoter.js';
import { generateFewShotExamples } from './few-shot-generator.js';
import { DEFAULT_RECONCILIATION_CONFIG } from './types.js';
import type { ReconciliationConfig, ReconciliationResult } from './types.js';

const log = createLogger('reconciliation-service');

export class ReconciliationService {
  private embeddingProvider: EmbeddingProvider;
  private config: ReconciliationConfig;
  private clusteringService: ClusteringService;

  constructor(embeddingProvider: EmbeddingProvider, config?: Partial<ReconciliationConfig>) {
    this.embeddingProvider = embeddingProvider;
    this.config = { ...DEFAULT_RECONCILIATION_CONFIG, ...config };
    this.clusteringService = new ClusteringService();
  }

  /**
   * Run reconciliation across all product scopes for an index.
   */
  async reconcileIndex(tenantId: string, indexId: string): Promise<ReconciliationResult[]> {
    // Lazy import to avoid circular deps with database package
    const { AttributeRegistry } = await import('@agent-platform/database/models');

    // Find all distinct product scopes with novel candidates
    const scopes = await AttributeRegistry.distinct('productScope', {
      tenantId,
      indexId,
      tier: 'novel',
    });

    const results: ReconciliationResult[] = [];
    for (const scope of scopes) {
      try {
        const result = await this.reconcile(tenantId, indexId, scope);
        results.push(result);
      } catch (error) {
        log.error('Reconciliation failed for scope', {
          tenantId,
          indexId,
          productScope: scope,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  /**
   * Run full reconciliation for a single (tenant, index, productScope).
   */
  async reconcile(
    tenantId: string,
    indexId: string,
    productScope: string,
  ): Promise<ReconciliationResult> {
    const start = Date.now();
    const result: ReconciliationResult = {
      tenantId,
      indexId,
      productScope,
      mergedIntoExisting: 0,
      clustered: 0,
      promoted: 0,
      discarded: 0,
      unchanged: 0,
      duration: 0,
    };

    const { AttributeRegistry, AttributeMergeEvent } =
      await import('@agent-platform/database/models');

    // 1. Load novel candidates
    // C2 fix: Only load novels not yet reconciled (no lastReconciledAt).
    // Cluster canonicals from prior runs have lastReconciledAt set — they skip
    // steps 3-5 (embed + cluster) to prevent re-clustering, duplicate merge
    // events, and documentCount inflation. They ARE re-evaluated for promotion
    // in step 6 (which reloads all tier='novel').
    const novels = (await AttributeRegistry.find({
      tenantId,
      indexId,
      productScope,
      tier: 'novel',
      lastReconciledAt: { $exists: false },
    }).lean()) as IAttributeRegistry[];

    if (novels.length === 0) {
      result.duration = Date.now() - start;
      return result;
    }

    // 2. Load existing canonical attributes
    const existing = (await AttributeRegistry.find({
      tenantId,
      indexId,
      productScope,
      tier: { $in: ['permanent', 'approved'] },
    }).lean()) as IAttributeRegistry[];

    // 3. Embed names + definitions via embedding provider
    const novelTexts = novels.map((n) => `${n.attributeId}: ${n.definition || n.displayName}`);
    const existingTexts = existing.map((e) => `${e.attributeId}: ${e.definition || e.displayName}`);

    let novelEmbeddings: number[][] = [];
    let existingEmbeddings: number[][] = [];

    try {
      if (novelTexts.length > 0) {
        const novelResult = await this.embeddingProvider.embedBatch(novelTexts);
        novelEmbeddings = novelResult.embeddings;
        // H7 fix: Assert embedding count matches input count — a mismatch
        // would silently corrupt cosine similarity comparisons (wrong pairs)
        if (novelEmbeddings.length !== novelTexts.length) {
          throw new Error(
            `Embedding count mismatch: expected ${novelTexts.length} novel embeddings, got ${novelEmbeddings.length}`,
          );
        }
      }
      if (existingTexts.length > 0) {
        const existingResult = await this.embeddingProvider.embedBatch(existingTexts);
        existingEmbeddings = existingResult.embeddings;
        if (existingEmbeddings.length !== existingTexts.length) {
          throw new Error(
            `Embedding count mismatch: expected ${existingTexts.length} existing embeddings, got ${existingEmbeddings.length}`,
          );
        }
      }
    } catch (error) {
      // Fail-open: if embeddings fail, skip reconciliation
      log.error('Embedding failed during reconciliation — skipping', {
        tenantId,
        indexId,
        productScope,
        error: error instanceof Error ? error.message : String(error),
      });
      result.duration = Date.now() - start;
      return result;
    }

    // 4. Match novels against existing (cosine > threshold → merge)
    const unmatched: number[] = []; // indices into novels[]

    for (let i = 0; i < novels.length; i++) {
      let bestMatch = -1;
      let bestSimilarity = 0;

      for (let j = 0; j < existing.length; j++) {
        const similarity = ClusteringService.cosineSimilarity(
          novelEmbeddings[i],
          existingEmbeddings[j],
        );
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestMatch = j;
        }
      }

      if (bestMatch >= 0 && bestSimilarity >= this.config.cosineMatchThreshold) {
        // Merge into existing: add as alias
        const target = existing[bestMatch];
        const source = novels[i];

        await AttributeRegistry.updateOne(
          { _id: target._id, tenantId },
          {
            $addToSet: { aliases: source.attributeId },
            $set: { lastSeenAt: new Date() },
          },
        );

        // Mark novel as discarded (merged into existing)
        await AttributeRegistry.updateOne(
          { _id: source._id, tenantId },
          { $set: { tier: 'discarded' } },
        );

        // Log merge event
        await AttributeMergeEvent.create({
          tenantId,
          indexId,
          productScope,
          timestamp: new Date(),
          sourceAttributeIds: [source.attributeId],
          targetAttributeId: target.attributeId,
          mergeScore: bestSimilarity,
          mergeMethod: 'auto_reconciliation',
          reversible: true,
          metadata: {
            reason: `cosine=${bestSimilarity.toFixed(3)} > ${this.config.cosineMatchThreshold}`,
          },
        });

        result.mergedIntoExisting++;
      } else {
        unmatched.push(i);
      }
    }

    // 5. Cluster remaining unmatched novels
    if (unmatched.length > 1) {
      const unmatchedEmbeddings = unmatched.map((i) => novelEmbeddings[i]);
      const clusterInputSize = unmatchedEmbeddings.length;
      const clusters = this.clusteringService.cluster(
        unmatchedEmbeddings,
        this.config.clusterDistanceThreshold,
      );

      // If clustering truncated (>MAX_CLUSTER_SIZE), mark overflow novels as
      // reconciled to prevent infinite re-processing on every run.
      if (clusterInputSize > ClusteringService.MAX_CLUSTER_SIZE) {
        const overflowIndices = unmatched.slice(ClusteringService.MAX_CLUSTER_SIZE);
        log.warn('Marking overflow novels as reconciled (exceeded cluster cap)', {
          tenantId,
          indexId,
          productScope,
          overflow: overflowIndices.length,
        });
        for (const idx of overflowIndices) {
          await AttributeRegistry.updateOne(
            { _id: novels[idx]._id, tenantId },
            { $set: { lastReconciledAt: new Date() } },
          );
        }
      }

      for (const cluster of clusters) {
        if (cluster.length <= 1) continue; // standalone, handle below

        result.clustered += cluster.length;

        // Map cluster indices back to novels[]
        const clusterNovels = cluster.map((ci) => novels[unmatched[ci]]);

        // Elect canonical: highest documentCount, deterministic tiebreaker on attributeId
        const canonical = clusterNovels.reduce((best, curr) => {
          const currCount = curr.documentCount ?? 0;
          const bestCount = best.documentCount ?? 0;
          if (currCount > bestCount) return curr;
          if (currCount === bestCount && curr.attributeId < best.attributeId) return curr;
          return best;
        });

        // Merge non-canonical into canonical
        const nonCanonical = clusterNovels.filter((n) => n._id !== canonical._id);
        const memberNames = clusterNovels.map((n) => ({
          name: n.attributeId,
          definition: n.definition || n.displayName,
        }));

        // Generate few-shot patterns
        const { aliases, extractionPatterns } = generateFewShotExamples(
          canonical.attributeId,
          memberNames,
        );

        // Update canonical with cluster info
        await AttributeRegistry.updateOne(
          { _id: canonical._id, tenantId },
          {
            $addToSet: { aliases: { $each: aliases } },
            $set: {
              extractionPatterns,
              lastSeenAt: new Date(),
              lastReconciledAt: new Date(), // C2 fix: mark as reconciled to prevent re-clustering
            },
            $inc: {
              documentCount: nonCanonical.reduce(
                (sum: number, n) => sum + (n.documentCount ?? 0),
                0,
              ),
            },
          },
        );

        // Mark non-canonical as discarded
        for (const nc of nonCanonical) {
          await AttributeRegistry.updateOne(
            { _id: nc._id, tenantId },
            { $set: { tier: 'discarded' } },
          );
        }

        // Log merge event
        await AttributeMergeEvent.create({
          tenantId,
          indexId,
          productScope,
          timestamp: new Date(),
          sourceAttributeIds: nonCanonical.map((n) => n.attributeId),
          targetAttributeId: canonical.attributeId,
          mergeScore: 0, // cluster merge, not direct cosine
          mergeMethod: 'auto_reconciliation',
          reversible: true,
          metadata: {
            clusterSize: cluster.length,
            reason: `agglomerative cluster (${cluster.length} members)`,
          },
        });
      }
    }

    // 6. Evaluate promotion for remaining novels (unmatched standalones + cluster canonicals)
    // Reload to get updated state — scoped to novels loaded in step 1 plus any cluster
    // canonicals created in step 5. Using tier='novel' + lastReconciledAt filter avoids
    // accidentally evaluating concurrent new novels that haven't been through matching.
    const remainingNovels = (await AttributeRegistry.find({
      tenantId,
      indexId,
      productScope,
      tier: 'novel',
      // Include: (a) novels loaded in step 1 (lastReconciledAt unset) that weren't merged/discarded,
      // (b) cluster canonicals from step 5 (lastReconciledAt just set)
      _id: { $in: novels.map((n) => n._id) },
    }).lean()) as IAttributeRegistry[];

    for (const novel of remainingNovels) {
      const decision = evaluatePromotion(novel, this.config);

      if (decision.action === 'promote') {
        // Generate few-shot for standalone promoted attr
        const { aliases, extractionPatterns } = generateFewShotExamples(novel.attributeId, [
          {
            name: novel.attributeId,
            definition: novel.definition || novel.displayName,
          },
        ]);

        await AttributeRegistry.updateOne(
          { _id: novel._id, tenantId },
          {
            $set: {
              tier: 'approved',
              extractionPatterns,
              lastSeenAt: new Date(),
            },
            $addToSet: { aliases: { $each: aliases } },
          },
        );
        result.promoted++;
      } else if (decision.action === 'discard') {
        await AttributeRegistry.updateOne(
          { _id: novel._id, tenantId },
          { $set: { tier: 'discarded' } },
        );
        result.discarded++;
      } else {
        // Mark as reconciled so it skips embedding/clustering next run
        // but still gets re-evaluated for promotion (step 6 loads all tier='novel')
        await AttributeRegistry.updateOne(
          { _id: novel._id, tenantId },
          { $set: { lastReconciledAt: new Date() } },
        );
        result.unchanged++;
      }
    }

    result.duration = Date.now() - start;

    log.info('Reconciliation complete', {
      tenantId,
      indexId,
      productScope,
      mergedIntoExisting: result.mergedIntoExisting,
      clustered: result.clustered,
      promoted: result.promoted,
      discarded: result.discarded,
      unchanged: result.unchanged,
      duration: result.duration,
    });

    return result;
  }
}
