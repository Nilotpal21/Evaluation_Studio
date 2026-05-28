/**
 * Search Layer Disassembler — converts exported search files back into StagedRecord[].
 *
 * Handles search indexes, sources, knowledge bases, and crawl patterns.
 *
 * Cross-reference note: search sources and knowledge bases set `_indexSlug`
 * temp field for resolution in the cross-ref pass. The stale indexId/searchIndexId
 * fields are removed and will be rebuilt by the cross-ref resolver.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { LayerDisassembler, DisassembleContext, DisassembleResult } from './types.js';
import {
  safeParseJSON,
  safeParseJSONArray,
  injectOwnership,
  buildRecord,
  buildSuperseded,
  buildMatchingSuperseded,
} from './disassembler-utils.js';

const log = createLogger('search-disassembler');

// ─── Collections ──────────────────────────────────────────────────────────

const SEARCH_INDEXES = 'search_indexes';
const SEARCH_SOURCES = 'search_sources';
const KNOWLEDGE_BASES = 'knowledge_bases';
const CRAWL_PATTERNS = 'crawl_patterns';

// ─── Path Patterns ────────────────────────────────────────────────────────

const INDEX_PATTERN = /^search\/indexes\/([^/]+)\.index\.json$/;
const SOURCE_PATTERN = /^search\/sources\/([^/]+)\.source\.json$/;
const KB_PATTERN = /^search\/knowledge-bases\/([^/]+)\.kb\.json$/;
const CRAWL_PATTERNS_PATH = 'search/crawl-patterns.json';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Strip runtime stats from an index record (defensive — assembler already strips these).
 */
function stripIndexRuntimeStats(data: Record<string, unknown>): void {
  delete data.documentCount;
  delete data.chunkCount;
  delete data.sourceCount;
  delete data.lastIndexedAt;
  delete data.indexError;
}

/**
 * Strip runtime stats from a source record.
 */
function stripSourceRuntimeStats(data: Record<string, unknown>): void {
  delete data.documentCount;
  delete data.lastSyncAt;
  delete data.syncError;
}

/**
 * Strip runtime stats from a knowledge base record.
 */
function stripKBRuntimeStats(data: Record<string, unknown>): void {
  delete data.documentCount;
  delete data.lastIndexedAt;
  delete data.indexError;
}

/**
 * Strip runtime stats from a crawl pattern record.
 */
function stripCrawlPatternRuntimeStats(data: Record<string, unknown>): void {
  delete data.lastCrawlAt;
  delete data.totalCrawlsCompleted;
  delete data.avgCrawlDurationMs;
  delete data.lastCrawlSuccess;
  delete data.lastCrawlError;
  delete data.profiledAt;
  delete data.lastAccessedAt;
}

// ─── Disassembler ─────────────────────────────────────────────────────────

export class SearchDisassembler implements LayerDisassembler {
  readonly layer = 'search' as const;

  async disassemble(ctx: DisassembleContext): Promise<DisassembleResult> {
    const records: DisassembleResult['records'] = [];
    const superseded: DisassembleResult['superseded'] = [];
    const warnings: string[] = [];
    const ownership = {
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    };

    // Build index slug map for cross-ref resolution of sources/KBs
    const indexSlugMap = new Map<string, Record<string, unknown>>();
    // Reverse map: stale originalId -> slug (for resolving stale foreign keys)
    const originalIdToSlug = new Map<string, string>();

    // ── PHASE 1: Parse search indexes ───────────────────────────────────

    for (const [filePath, content] of ctx.files) {
      const match = filePath.match(INDEX_PATTERN);
      if (!match) continue;

      const parsed = safeParseJSON(filePath, content, warnings);
      if (!parsed) continue;

      const slug =
        typeof parsed.slug === 'string'
          ? parsed.slug
          : typeof parsed.name === 'string'
            ? parsed.name
            : match[1];
      // Ensure slug is on the record for cross-ref resolver (anchorMatchField: 'slug')
      parsed.slug = slug;
      const exportedIndexId = parsed.id ?? parsed._exportedId;
      if (typeof exportedIndexId === 'string' && exportedIndexId.length > 0) {
        parsed._exportedId = exportedIndexId;
      }

      stripIndexRuntimeStats(parsed);

      indexSlugMap.set(slug, parsed);

      // Track original _id if available (may have been exported)
      if (typeof parsed._exportedId === 'string') {
        originalIdToSlug.set(parsed._exportedId, slug);
      }

      const data = injectOwnership(parsed, ownership);
      records.push(buildRecord('search', SEARCH_INDEXES, data));
    }

    // ── PHASE 2: Parse search sources ───────────────────────────────────

    for (const [filePath, content] of ctx.files) {
      const match = filePath.match(SOURCE_PATTERN);
      if (!match) continue;

      const parsed = safeParseJSON(filePath, content, warnings);
      if (!parsed) continue;
      const exportedSourceId = parsed.id ?? parsed._exportedId;
      if (typeof exportedSourceId === 'string' && exportedSourceId.length > 0) {
        parsed._exportedId = exportedSourceId;
      }

      stripSourceRuntimeStats(parsed);

      // Defensive: strip sourceConfig to prevent importing stale/sensitive connector state
      delete parsed.sourceConfig;

      // Resolve stale indexId to slug for cross-ref
      const staleIndexId = parsed.indexId;
      const matchingSlug = this.findSlugByOriginalId(
        indexSlugMap,
        originalIdToSlug,
        staleIndexId,
        parsed,
        warnings,
      );
      parsed._indexSlug = matchingSlug;
      delete parsed.indexId; // Will be set in cross-ref pass

      const data = injectOwnership(parsed, ownership);
      records.push(buildRecord('search', SEARCH_SOURCES, data));
    }

    // ── PHASE 3: Parse knowledge bases ──────────────────────────────────

    for (const [filePath, content] of ctx.files) {
      const match = filePath.match(KB_PATTERN);
      if (!match) continue;

      const parsed = safeParseJSON(filePath, content, warnings);
      if (!parsed) continue;
      const exportedKnowledgeBaseId = parsed.id ?? parsed._exportedId;
      if (typeof exportedKnowledgeBaseId === 'string' && exportedKnowledgeBaseId.length > 0) {
        parsed._exportedId = exportedKnowledgeBaseId;
      }

      stripKBRuntimeStats(parsed);

      // Resolve stale searchIndexId to slug for cross-ref
      const staleSearchIndexId = parsed.searchIndexId;
      const matchingSlug = this.findSlugByOriginalId(
        indexSlugMap,
        originalIdToSlug,
        staleSearchIndexId,
        parsed,
        warnings,
      );
      parsed._indexSlug = matchingSlug;
      delete parsed.searchIndexId; // Will be set in cross-ref pass

      const data = injectOwnership(parsed, ownership);
      records.push(buildRecord('search', KNOWLEDGE_BASES, data));
    }

    // ── PHASE 4: Parse crawl patterns (array file) ─────────────────────

    const crawlPatternsContent = ctx.files.get(CRAWL_PATTERNS_PATH);
    if (crawlPatternsContent) {
      const patterns = safeParseJSONArray(CRAWL_PATTERNS_PATH, crawlPatternsContent, warnings);
      for (const pattern of patterns) {
        stripCrawlPatternRuntimeStats(pattern);
        const data = injectOwnership(pattern, ownership);
        records.push(buildRecord('search', CRAWL_PATTERNS, data));
      }
    }

    // ── Superseded records ──────────────────────────────────────────────

    if (ctx.conflictStrategy === 'replace' && ctx.existingRecordIds) {
      superseded.push(
        ...buildSuperseded('search', SEARCH_INDEXES, ctx.existingRecordIds.get(SEARCH_INDEXES)),
      );
      superseded.push(
        ...buildSuperseded('search', SEARCH_SOURCES, ctx.existingRecordIds.get(SEARCH_SOURCES)),
      );
      superseded.push(
        ...buildSuperseded('search', KNOWLEDGE_BASES, ctx.existingRecordIds.get(KNOWLEDGE_BASES)),
      );
      superseded.push(
        ...buildSuperseded('search', CRAWL_PATTERNS, ctx.existingRecordIds.get(CRAWL_PATTERNS)),
      );
    } else if (ctx.conflictStrategy === 'merge' && ctx.existingRecordIds) {
      superseded.push(
        ...buildMatchingSuperseded(
          'search',
          SEARCH_INDEXES,
          ctx.existingRecordIds.get(SEARCH_INDEXES),
          records.filter((record) => record.collection === SEARCH_INDEXES),
          'slug',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'search',
          SEARCH_SOURCES,
          ctx.existingRecordIds.get(SEARCH_SOURCES),
          records.filter((record) => record.collection === SEARCH_SOURCES),
          'name',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'search',
          KNOWLEDGE_BASES,
          ctx.existingRecordIds.get(KNOWLEDGE_BASES),
          records.filter((record) => record.collection === KNOWLEDGE_BASES),
          'name',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'search',
          CRAWL_PATTERNS,
          ctx.existingRecordIds.get(CRAWL_PATTERNS),
          records.filter((record) => record.collection === CRAWL_PATTERNS),
          'domain',
        ),
      );
    }

    log.info('Search layer disassembled', {
      projectId: ctx.projectId,
      indexes: indexSlugMap.size,
      sources: records.filter((r) => r.collection === SEARCH_SOURCES).length,
      knowledgeBases: records.filter((r) => r.collection === KNOWLEDGE_BASES).length,
      crawlPatterns: records.filter((r) => r.collection === CRAWL_PATTERNS).length,
    });

    return { records, superseded, warnings };
  }

  /**
   * Resolve a stale foreign key (indexId/searchIndexId) to the corresponding index slug.
   *
   * Resolution strategy:
   * 1. Direct lookup by original _id
   * 2. Fallback: if only one index exists, assume it's the target
   * 3. Fallback: match by naming convention (record name contains index slug)
   * 4. Last resort: emit warning, return null
   */
  private findSlugByOriginalId(
    indexSlugMap: Map<string, Record<string, unknown>>,
    originalIdToSlug: Map<string, string>,
    staleId: unknown,
    record: Record<string, unknown>,
    warnings: string[],
  ): string | null {
    // 1. Direct lookup
    if (typeof staleId === 'string' && originalIdToSlug.has(staleId)) {
      return originalIdToSlug.get(staleId)!;
    }

    // 2. Single-index fallback
    if (indexSlugMap.size === 1) {
      return indexSlugMap.keys().next().value ?? null;
    }

    // 3. Name-matching convention
    if (typeof record.name === 'string') {
      for (const slug of indexSlugMap.keys()) {
        if (record.name.includes(slug)) {
          return slug;
        }
      }
    }

    // 4. Unresolvable
    const recordName = typeof record.name === 'string' ? record.name : 'unknown';
    warnings.push(
      `Cannot resolve indexId "${String(staleId)}" to a slug for source/KB "${recordName}"`,
    );
    return null;
  }
}
