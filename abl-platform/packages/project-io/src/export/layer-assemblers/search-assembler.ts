import type { LayerAssembler, LayerQueryContext } from './types.js';
import type { LayerAssemblyResult } from '../../types.js';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  SearchIndex,
  SearchSource,
  KnowledgeBase,
  CrawlPattern,
} from '@agent-platform/database/models';
import { sanitizeName, stripInternalFields } from './assembler-utils.js';
import { assignCollisionSafePath } from '../folder-builder.js';

const log = createLogger('search-assembler');

export class SearchAssembler implements LayerAssembler {
  readonly layer = 'search' as const;

  async assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult> {
    const { projectId, tenantId } = ctx;
    const files = new Map<string, string>();
    const warnings: string[] = [];
    let entityCount = 0;

    // Query indexes and knowledge bases by project; sources by index; crawl patterns by tenant
    const [indexes, knowledgeBases] = await Promise.all([
      SearchIndex.find({ projectId, tenantId })
        .lean()
        .select(
          'slug name description embeddingModel embeddingDimensions tokenChunkStrategy vectorStore searchDefaults llmConfig status',
        ),
      KnowledgeBase.find({ projectId, tenantId })
        .lean()
        .select('name description searchIndexId connectorCount status isPublic'),
    ]);

    // Gather index IDs for source lookup
    const indexIds = indexes.map((idx: Record<string, unknown>) => String(idx._id));

    // Sources are project-owned through indexes. Crawl patterns are tenant-level
    // reusable profiling cache, so export them with tenant scope.
    const [sources, crawlPatterns] = await Promise.all([
      indexIds.length > 0
        ? SearchSource.find({ tenantId, indexId: { $in: indexIds } })
            .lean()
            .select('indexId name sourceType extractionConfig enrichmentConfig syncSchedule status')
        : Promise.resolve([]),
      CrawlPattern.find({ tenantId })
        .lean()
        .select(
          'domain siteType framework jsRequired linkDensity estimatedSize avgResponseTime rateLimitDetected maxConcurrency confidence metadata',
        ),
    ]);

    // Search indexes — config only, no document/chunk counts
    for (const index of indexes) {
      const slug = sanitizeName(index.slug || index.name);
      const originalId = String((index as Record<string, unknown>)._id);
      const clean = stripInternalFields(index as unknown as Record<string, unknown>);
      // Strip runtime stats — config only
      delete clean.documentCount;
      delete clean.chunkCount;
      delete clean.sourceCount;
      delete clean.lastIndexedAt;
      delete clean.indexError;
      // Preserve original _id as _exportedId so the import disassembler can
      // resolve stale indexId/searchIndexId foreign keys on sources/KBs.
      clean._exportedId = originalId;
      const path = assignCollisionSafePath(`search/indexes/${slug}.index.json`, files);
      files.set(path, JSON.stringify(clean, null, 2));
      entityCount++;
    }

    // Search sources — config only, strip sourceConfig (may contain credentials)
    for (const source of sources) {
      const sourceName = sanitizeName(source.name);
      const originalId = String((source as Record<string, unknown>)._id);
      const clean = stripInternalFields(source as unknown as Record<string, unknown>);
      delete clean.sourceConfig;
      delete clean.documentCount;
      delete clean.lastSyncAt;
      delete clean.syncError;
      clean._exportedId = originalId;
      const path = assignCollisionSafePath(`search/sources/${sourceName}.source.json`, files);
      files.set(path, JSON.stringify(clean, null, 2));
      entityCount++;
    }

    // Knowledge bases — config only
    for (const kb of knowledgeBases) {
      const kbName = sanitizeName(kb.name);
      const originalId = String((kb as Record<string, unknown>)._id);
      const clean = stripInternalFields(kb as unknown as Record<string, unknown>);
      delete clean.documentCount;
      delete clean.lastIndexedAt;
      delete clean.indexError;
      // Preserve original _id as _exportedId so cross-layer vocabulary/schema
      // references can be remapped during imports into another project/tenant.
      clean._exportedId = originalId;
      const path = assignCollisionSafePath(`search/knowledge-bases/${kbName}.kb.json`, files);
      files.set(path, JSON.stringify(clean, null, 2));
      entityCount++;
    }

    // Crawl patterns — export for domain configuration reuse
    if (crawlPatterns.length > 0) {
      const cleanPatterns = crawlPatterns.map((cp) => {
        const clean = stripInternalFields(cp as unknown as Record<string, unknown>);
        // Strip runtime stats
        delete clean.lastCrawlAt;
        delete clean.totalCrawlsCompleted;
        delete clean.avgCrawlDurationMs;
        delete clean.lastCrawlSuccess;
        delete clean.lastCrawlError;
        delete clean.profiledAt;
        delete clean.lastAccessedAt;
        return clean;
      });
      files.set('search/crawl-patterns.json', JSON.stringify(cleanPatterns, null, 2));
      entityCount += crawlPatterns.length;
    }

    log.info('Search layer assembled', {
      projectId,
      indexes: indexes.length,
      sources: sources.length,
      knowledgeBases: knowledgeBases.length,
      crawlPatterns: crawlPatterns.length,
    });

    return { layer: 'search', files, entityCount, warnings };
  }

  async countEntities(ctx: LayerQueryContext): Promise<number> {
    const { projectId, tenantId } = ctx;
    const [indexCount, kbCount, crawlCount] = await Promise.all([
      SearchIndex.countDocuments({ projectId, tenantId }),
      KnowledgeBase.countDocuments({ projectId, tenantId }),
      CrawlPattern.countDocuments({ tenantId }),
    ]);
    return indexCount + kbCount + crawlCount;
  }
}
