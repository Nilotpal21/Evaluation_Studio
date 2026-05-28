# Browse SDK Sprint 1: KG Enrichment Worker Bug Fixes — Low-Level Design

## Task T-1: Fix summary field read + query filter

### Files to Modify

- `apps/search-ai/src/workers/kg-enrichment-worker.ts` — lines 168-172 (query filter), line 175-186 (kgState filter), lines 306-311 (classification input)

### Subtasks (execution order)

1. **ST-1.1:** Restructure the query filter at lines 168-186. Replace:

   ```typescript
   // BEFORE (line 171):
   summary: { $ne: null },
   // + later at line 182:
   docQuery.$or = [ kgState conditions ]
   ```

   With `$and` combining both `$or` clauses:

   ```typescript
   const docQuery: any = { tenantId, indexId };

   // Summary filter: prefer progressive summary, fall back to legacy
   const summaryFilter = {
     $or: [{ 'metadata.documentSummary': { $ne: null } }, { summary: { $ne: null } }],
   };

   // KG state filter (unless forceReclassify)
   if (!options?.forceReclassify) {
     const statusFilter: string[] = ['NOT_ENRICHED'];
     if (options?.retrySkipped) statusFilter.push('SKIPPED');

     docQuery.$and = [
       summaryFilter,
       {
         $or: [
           { 'metadata.kgState.status': { $in: statusFilter } },
           { 'metadata.kgState': { $exists: false } },
         ],
       },
     ];
   } else {
     // forceReclassify: process ALL documents with summaries
     docQuery.$and = [summaryFilter];
   }
   ```

2. **ST-1.2:** Fix classification input at line 307-308. Replace:
   ```typescript
   summary: document.summary,
   ```
   With:
   ```typescript
   summary: document.metadata?.documentSummary || document.summary || '',
   ```

### Acceptance Criteria

- AC-1: Given a Docling-processed document with `metadata.documentSummary` set and `summary` null, when KG enrichment runs, then the document IS included in processing and classified using the progressive summary.
- AC-2: Given a legacy document with only top-level `summary` set, when KG enrichment runs, then the document IS included and classified using the legacy summary.
- AC-3: Given a document with BOTH fields set, the progressive summary (`metadata.documentSummary`) is preferred.
- AC-4: Given a document with neither field set, it is excluded from processing.
- AC-5: The `$and`/`$or` query structure correctly combines summary and kgState filters.

---

## Task T-2: Fix chunk entity extraction input

### Files to Modify

- `apps/search-ai/src/workers/kg-enrichment-worker.ts` — line 369-370 (entity extraction call)

### Subtasks (execution order)

1. **ST-2.1:** Replace chunk content input at line 369-370. Replace:
   ```typescript
   const entities = await entityExtractor.extractEntities(
     chunk.content,
   ```
   With:
   ```typescript
   const extractionInput = (chunk.metadata?.progressiveSummary as string) || chunk.content;
   const entities = await entityExtractor.extractEntities(
     extractionInput,
   ```

### Acceptance Criteria

- AC-1: Given a chunk with `metadata.progressiveSummary` set, entity extraction uses the progressive summary.
- AC-2: Given a chunk without a progressive summary, entity extraction falls back to `chunk.content`.
- AC-3: Given a chunk with empty-string progressive summary, entity extraction falls back to `chunk.content`.

---

## Task T-3: Fix OpenSearch vector DB write

### Files to Modify

- `apps/search-ai/src/workers/kg-enrichment-worker.ts` — lines 404-427 (vector DB upsert)

### Subtasks (execution order)

1. **ST-3.1:** Replace the entire vector DB upsert metadata block at lines 404-426. Replace the flat field writes with a deep-merge pattern that writes classification data under `metadata.canonical.custom.kg`:

   ```typescript
   if (existingVector && existingVector.length > 0) {
     const existingMeta = (existingRecords[0]?.metadata || {}) as Record<string, any>;
     const existingCanonical = existingMeta.canonical || {};
     const existingCustom = existingCanonical.custom || {};

     await vectorStore.upsert(vectorIndexName, [
       {
         id: chunk._id.toString(),
         vector: existingVector,
         metadata: {
           ...existingMeta,
           canonical: {
             ...existingCanonical,
             custom: {
               ...existingCustom,
               kg: {
                 primaryProduct: classificationResult.classification.productScope.primaryProduct,
                 secondaryProducts:
                   classificationResult.classification.productScope.secondaryProducts,
                 confidence: classificationResult.classification.productScope.confidence,
                 department: classificationResult.classification.department,
                 category: classificationResult.classification.category,
                 kgEnriched: true,
                 kgEnrichedAt: new Date().toISOString(),
               },
             },
           },
         },
       },
     ]);
     stats.vectorDbUpdates++;
   }
   ```

   Key changes:
   - Removes flat `tenantId`, `indexId`, `documentId` (already in `metadata.sys.*`)
   - Moves KG fields from flat metadata to `metadata.canonical.custom.kg`
   - Deep-merges at each level to preserve existing `sys`, `doc`, `canonical` structure
   - Uses null-safe defaults (`|| {}`) at each nesting level

### Acceptance Criteria

- AC-1: Vector DB upsert does NOT throw `strict_dynamic_mapping_exception`.
- AC-2: Existing `metadata.sys.*` and `metadata.doc.*` fields are preserved after upsert.
- AC-3: Classification data is accessible at `_source.metadata.canonical.custom.kg.*` in OpenSearch.
- AC-4: No flat `tenantId`, `indexId`, `documentId` fields appear in metadata root.
- AC-5: Re-enrichment overwrites `canonical.custom.kg` idempotently without corrupting other metadata.
