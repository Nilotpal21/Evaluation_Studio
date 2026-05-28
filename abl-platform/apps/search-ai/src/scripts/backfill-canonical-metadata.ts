#!/usr/bin/env node
/**
 * Migration Script: Backfill Canonical Metadata on Chunks
 *
 * Problem: Some chunks have null canonicalMetadata because they were created
 * before the canonical-mapper-worker was enhanced to populate default fields
 * (mime_type, source_type, etc.) from document.contentType.
 *
 * Solution:
 *  1. Find all chunks with null canonicalMetadata
 *  2. Look up the parent document's contentType
 *  3. Build canonical fields (mime_type, source_type, title, dates, etc.)
 *  4. Update chunks in MongoDB
 *  5. Update vectors in OpenSearch (partial metadata update)
 *
 * Usage:
 *   npx tsx apps/search-ai/src/scripts/backfill-canonical-metadata.ts
 *   npx tsx apps/search-ai/src/scripts/backfill-canonical-metadata.ts --dry-run
 */

import { MongoClient } from 'mongodb';
import { Client as OpenSearchClient } from '@opensearch-project/opensearch';

// ─── Config ─────────────────────────────────────────────────────────────────
const SEARCH_AI_DB_URL =
  process.env.SEARCH_AI_DB_URL ||
  'mongodb://abl_admin:abl_dev_password@localhost:27018/search_ai?authSource=admin&directConnection=true';
const PLATFORM_DB_URL =
  process.env.PLATFORM_DB_URL ||
  'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true';
const OPENSEARCH_URL = process.env.VECTOR_STORE_URL || 'http://localhost:9200';
const OPENSEARCH_API_KEY = process.env.VECTOR_STORE_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

// ─── MIME → source_type mapping (same as canonical-mapper-worker) ───────────
const MIME_MAP: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/markdown': 'markdown',
  'text/plain': 'text',
  'text/html': 'html',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
};

function deriveSourceType(mimeType: string, filename: string | null): string {
  const mapped = MIME_MAP[mimeType];
  if (mapped) return mapped;
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext) return ext;
  }
  const parts = mimeType.split('/');
  return parts[parts.length - 1];
}

function buildCanonicalMetadata(doc: any): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  const srcMeta = (doc.sourceMetadata ?? {}) as Record<string, unknown>;
  const fileMeta = (srcMeta.file_upload ?? srcMeta) as Record<string, unknown>;

  // title
  const title = doc.name || (fileMeta.title as string | undefined) || doc.originalReference;
  if (title) canonical.title = title;

  // mime_type
  const mimeType = doc.contentType || (fileMeta.mimeType as string | undefined);
  if (mimeType) canonical.mime_type = mimeType;

  // source_type
  if (mimeType) {
    canonical.source_type = deriveSourceType(mimeType, doc.originalReference);
  }

  // source_url — use external URL for citations, never expose internal storage paths
  if (
    doc.originalReference &&
    (doc.originalReference.startsWith('http://') || doc.originalReference.startsWith('https://'))
  ) {
    canonical.source_url = doc.originalReference;
  } else if ((doc as any).downloadUrl) {
    canonical.source_url = (doc as any).downloadUrl;
  } else if (doc.originalReference) {
    canonical.source_url = doc.originalReference;
  }

  // dates
  if (doc.createdAt) canonical.created_date = new Date(doc.createdAt).toISOString();
  if (doc.updatedAt) canonical.modified_date = new Date(doc.updatedAt).toISOString();

  // language
  if (doc.language) canonical.language = doc.language;

  // status
  if (doc.status) canonical.status = doc.status;

  // author
  const author =
    (fileMeta.author as string | undefined) ||
    (srcMeta.author as string | undefined) ||
    (srcMeta.created_by as string | undefined);
  if (author) canonical.author = author;

  return canonical;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[backfill-canonical] Starting canonical metadata backfill...`);
  console.log(`[backfill-canonical] Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const searchClient = new MongoClient(SEARCH_AI_DB_URL);
  const platformClient = new MongoClient(PLATFORM_DB_URL);

  const osClient = new OpenSearchClient({
    node: OPENSEARCH_URL,
    auth: OPENSEARCH_API_KEY ? { username: 'admin', password: OPENSEARCH_API_KEY } : undefined,
    requestTimeout: 30_000,
  });

  try {
    await Promise.all([searchClient.connect(), platformClient.connect()]);
    console.log('[backfill-canonical] Connected to MongoDB');

    const searchDb = searchClient.db('search_ai');
    const platformDb = platformClient.db('abl_platform');
    const chunks = searchDb.collection('search_chunks');
    const documents = searchDb.collection('search_documents');
    const indexRegistries = platformDb.collection('index_registries');

    // 1. Find chunks with null canonicalMetadata
    const nullChunks = await chunks
      .find(
        { $or: [{ canonicalMetadata: null }, { canonicalMetadata: { $exists: false } }] },
        { projection: { _id: 1, documentId: 1, indexId: 1, tenantId: 1 } },
      )
      .toArray();

    console.log(
      `[backfill-canonical] Found ${nullChunks.length} chunks with null canonicalMetadata`,
    );

    if (nullChunks.length === 0) {
      console.log('[backfill-canonical] Nothing to do — all chunks have canonicalMetadata');
      return;
    }

    // 2. Group by documentId
    const chunksByDoc = new Map<
      string,
      { chunkIds: string[]; indexId: string; tenantId: string }
    >();
    for (const chunk of nullChunks) {
      const docId = String(chunk.documentId);
      if (!chunksByDoc.has(docId)) {
        chunksByDoc.set(docId, {
          chunkIds: [],
          indexId: String(chunk.indexId),
          tenantId: String(chunk.tenantId),
        });
      }
      chunksByDoc.get(docId)!.chunkIds.push(String(chunk._id));
    }

    console.log(`[backfill-canonical] Grouped into ${chunksByDoc.size} documents\n`);

    let mongoUpdated = 0;
    let osUpdated = 0;
    let errors = 0;

    // 3. Process each document
    for (const [docId, { chunkIds, indexId, tenantId }] of chunksByDoc) {
      const doc = await documents.findOne({ _id: docId as any });
      if (!doc) {
        console.log(`  ⚠ Document ${docId}: not found — skipping ${chunkIds.length} chunks`);
        errors++;
        continue;
      }

      const canonical = buildCanonicalMetadata(doc);
      const fieldList = Object.entries(canonical)
        .map(([k, v]) => `${k}=${JSON.stringify(v).substring(0, 40)}`)
        .join(', ');

      console.log(
        `  📄 ${docId} | ${doc.contentType || 'null'} | ${chunkIds.length} chunks | fields: ${fieldList}`,
      );

      if (DRY_RUN) continue;

      // 4. Update MongoDB
      const mongoResult = await chunks.updateMany(
        { _id: { $in: chunkIds as any[] } },
        { $set: { canonicalMetadata: canonical } },
      );
      mongoUpdated += mongoResult.modifiedCount;
      console.log(`    ✅ MongoDB: ${mongoResult.modifiedCount} chunks updated`);

      // 5. Update OpenSearch vectors
      try {
        // Find the OpenSearch index name from index registry
        const registry = await indexRegistries.findOne({
          appId: indexId,
          tenantId,
          status: 'active',
        });

        if (!registry) {
          console.log(
            `    ⚠ No index registry for indexId=${indexId} — skipping OpenSearch update`,
          );
          continue;
        }

        const osIndexName = registry.indexName as string;
        const updateResult = await osClient.updateByQuery({
          index: osIndexName,
          body: {
            query: {
              terms: { _id: chunkIds },
            },
            script: {
              source: 'ctx._source.metadata.canonical = params.canonical',
              lang: 'painless',
              params: { canonical },
            },
          },
          refresh: true,
        });

        const updated = (updateResult.body as any)?.updated ?? 0;
        osUpdated += updated;
        console.log(`    ✅ OpenSearch (${osIndexName}): ${updated} vectors updated`);
      } catch (osErr) {
        const msg = osErr instanceof Error ? osErr.message : String(osErr);
        console.log(`    ⚠ OpenSearch update failed: ${msg}`);
        errors++;
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[backfill-canonical] DONE`);
    console.log(`  Total chunks found:       ${nullChunks.length}`);
    console.log(`  Documents processed:      ${chunksByDoc.size}`);
    console.log(`  MongoDB chunks updated:   ${mongoUpdated}`);
    console.log(`  OpenSearch vectors updated: ${osUpdated}`);
    if (errors > 0) console.log(`  Errors:                   ${errors}`);
    if (DRY_RUN) console.log(`  (DRY RUN — no changes made)`);
  } finally {
    await searchClient.close();
    await platformClient.close();
  }
}

main().catch((err) => {
  console.error('[backfill-canonical] Fatal error:', err);
  process.exit(1);
});
