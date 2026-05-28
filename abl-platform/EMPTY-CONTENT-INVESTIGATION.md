# Empty Content Investigation & Fix

## Problem

Search results return empty `content` fields (`content: ""`) even though metadata is populated correctly.

## Root Cause Analysis

### What We Found

1. **`_source` filter was fixed** ✅ - Now explicitly includes `['content', 'metadata']` in 3 locations in `hybrid-search-builder.ts`
2. **OpenSearch has empty content** ❌ - The chunks in OpenSearch genuinely have `content: ""`
3. **This is an indexing/ingestion bug**, not a retrieval bug

### Evidence

- Query results show `content: ""` but metadata is fully populated (title, mime_type, content_summary, etc.)
- These are content chunks (not questions - `questionId: null`)
- The `_source` config is correct after our fix

### Data Flow Trace

```
Docling → page.text → DocumentPage.text → fullText → textChunk.content →
chunk.content (MongoDB) → buildEmbeddingText() → texts[] →
vectorStore.upsert(content: texts[i]) → OpenSearch content field
```

**Key Files:**

1. `docling-extraction-worker.ts:320` - `text: page.text` (from Docling response)
2. `page-processing-worker.ts:230` - `fullText = pages.map(p => p.text).join('\n\n')`
3. `page-processing-worker.ts:253` - `content: textChunk.content`
4. `embedding-worker.ts:341` - `let text = chunk.content || ''`
5. `embedding-worker.ts:770` - `content: texts[batchIdx]`

## Likely Causes

### 1. Docling Service Issue

**Most likely** - Docling is returning pages with empty `text` fields:

```typescript
// docling-extraction-worker.ts:320
text: page.text; // If this is "", everything downstream is empty
```

**Check:**

- Is Docling service running? (`docker ps | grep docling`)
- Are Docling logs showing errors? (`docker logs abl-docling`)
- Recent Docling version changes?

### 2. Recent Code Changes

Check commits from last 7 days that touched ingestion:

```bash
git log --oneline --since="7 days ago" --grep="ingest\|chunk\|content" | head -20
```

Found recent changes:

- `2992e47f0` - Clean up old data before document reprocess
- `f98de8ba0` - Truncate large website content before LLM
- `5448b3fa2` - Wire kg-enrichment into JSON chunking
- `14ab1b6eb` - Fix JSON document reprocess routing

### 3. Extraction Worker Regression

Something may have broken in the extraction pipeline.

## Immediate Fixes

### 1. Code Changes Applied ✅

**Files Modified:**

- `apps/search-ai-runtime/src/services/hybrid-search/hybrid-search-builder.ts` (3 locations)
- `apps/search-ai-runtime/src/services/query/query-pipeline.ts` (debug logging added)

**Change:**

```typescript
// OLD (could cause issues)
_source: displayFields.length > 0 ? displayFields : undefined;

// NEW (explicit content inclusion)
_source: displayFields.length > 0
  ? displayFields
  : {
      includes: ['content', 'metadata'],
      excludes: ['embedding', 'metadata.raw', 'metadata.debug'],
    };
```

### 2. Service Restart Required

```bash
# Kill stale tsx watch processes
pkill -9 -f "search-ai-runtime"

# Start fresh
cd apps/search-ai-runtime
pnpm dev
```

### 3. Reindex the Knowledge Base

**The chunks currently in OpenSearch have empty content - you need to reindex:**

1. Go to Studio → Knowledge Base → Settings
2. Click "Reprocess" or "Reindex"
3. Wait for ingestion to complete
4. Test search again

## Diagnostic Steps

### 1. Check Docling Service

```bash
# Check if Docling is running
docker ps | grep docling

# Check Docling logs for errors
docker logs --tail=100 abl-docling

# Test Docling API
curl -X POST http://localhost:8080/extract \
  -F "file=@test.pdf" | jq '.pages[].text' | head -5
```

### 2. Check MongoDB for Empty Content

```bash
# Access MongoDB
docker exec -it abl-mongo mongosh search_ai

# Count chunks with empty content
db.searchchunks.countDocuments({
  $or: [{content: ""}, {content: {$exists: false}}]
})

# Sample a chunk
db.searchchunks.findOne({}, {_id: 1, content: 1, tokenCount: 1})
```

### 3. Check DocumentPages

```bash
# Check if pages have text
db.documentpages.findOne({}, {_id: 1, text: 1, pageNumber: 1})
```

### 4. Use Debug Endpoint (created above)

```bash
curl http://localhost:3004/debug/YOUR_INDEX_ID/content-check
```

## Next Steps

1. **Verify Docling is working** - Test with a sample PDF
2. **Check recent commits** - Look for breaking changes in ingestion
3. **Reindex one document** - Test if new chunks have content
4. **If Docling is broken** - Roll back or fix Docling service
5. **If ingestion code is broken** - Bisect recent commits to find the regression

## Files Changed

- ✅ `apps/search-ai-runtime/src/services/hybrid-search/hybrid-search-builder.ts`
- ✅ `apps/search-ai-runtime/src/services/query/query-pipeline.ts`
- ✅ `apps/search-ai-runtime/src/routes/debug-content.ts` (new diagnostic route)

## Status

- **Code fix applied** ✅
- **Service restarted** ✅
- **Root cause identified**: Empty content in OpenSearch (ingestion issue)
- **Action required**: Reindex knowledge base after fixing Docling/ingestion

---

**Created**: 2026-04-17 19:55
**Last Updated**: 2026-04-17 19:55
