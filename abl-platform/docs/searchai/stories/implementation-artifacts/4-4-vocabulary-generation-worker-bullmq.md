# Story 4.4: Vocabulary Generation Worker (BullMQ)

## Status: ready-for-dev

## Story

As a SearchAI Administrator,
I want vocabulary generation to run asynchronously by orchestrating query log analysis, document sampling, and LLM enrichment,
So that the UI remains responsive and generation processes large datasets end-to-end.

## Context

**This is a REWRITE of an existing worker.** The current `vocabulary-generation-worker.ts` uses the old `CriticalFieldDetectionService` approach that generates vocabulary per-field via LLM. Story 4.4 replaces that with the Epic 4 three-step orchestration:

1. **Step 1 — Query Log Analysis (Story 4.1):** `QueryLogAnalysisService` reads ClickHouse search logs, extracts high-frequency terms, and stores `ITermCandidate[]` in `VocabularyCandidates`.
2. **Step 2 — Document Content Sampling (Story 4.2):** `DocumentContentSampler` queries OpenSearch with terms aggregations to discover enum-like field values, returning `EnumCandidate[]`.
3. **Step 3 — LLM Enrichment (Story 4.3):** `VocabularyEnrichmentService` sends term + enum candidates to an LLM in batches, validates responses, and upserts to `DomainVocabulary`.

Each step runs sequentially within a single BullMQ job. Steps 1 and 2 can fail independently without stopping the pipeline (graceful degradation). Step 3 receives whatever candidates were produced.

**Key Design Decisions:**

- Sequential orchestration within a single job (not BullMQ Flow sub-jobs) — simpler, all services already have internal retry/circuit-breaker
- ClickHouse client created per job and closed in `finally` block
- DocumentContentSampler uses singleton pattern (already exists)
- LLM client resolved via `resolveIndexLLMConfig()` for tenant-specific credentials
- Progress reported at each step boundary (10%, 30%, 60%, 90%, 100%)
- TraceEvent emitted on completion with term/entry counts

## Acceptance Criteria

- [ ] `processVocabularyGenerationJob()` orchestrates 3 steps: query log analysis → document sampling → LLM enrichment
- [ ] Step 1: Creates ClickHouse client, runs `QueryLogAnalysisService.analyze()`, closes client in finally
- [ ] Step 2: Runs `DocumentContentSampler.sampleEnumValues()` with knowledgeBaseId
- [ ] Step 3: Creates `WorkerLLMClient`, runs `VocabularyEnrichmentService.enrichTerms()` with candidates from steps 1+2
- [ ] Each step wrapped in try/catch — failure in step 1 or 2 passes empty candidates to step 3
- [ ] Job progress reported: 10% (start), 30% (after query log), 60% (after sampling), 90% (after enrichment), 100% (done)
- [ ] `VocabularyGenerationJobData` interface updated with `knowledgeBaseId` field
- [ ] Worker factory unchanged: `createVocabularyGenerationWorker()` with concurrency=2
- [ ] Existing tests updated to match new orchestration flow
- [ ] Tenant isolation: `withTenantContext` wraps all DB access
- [ ] All errors logged with `createLogger('vocabulary-generation-worker')`, never `console.log`

## Verified Service Signatures

### QueryLogAnalysisService (apps/search-ai/src/services/query-log-analysis/)

```typescript
export class QueryLogAnalysisService {
  constructor(clickhouse: ClickHouseClient);
  async analyze(options: QueryLogAnalysisOptions): Promise<QueryLogAnalysisResult>;
}
export interface QueryLogAnalysisOptions {
  tenantId: string;
  indexId: string;
  knowledgeBaseId: string;
  minQueryCount?: number;
  minTermFrequency?: number;
  lookbackDays?: number;
}
export interface QueryLogAnalysisResult {
  candidates: ITermCandidate[];
  totalQueries: number;
  uniqueTerms: number;
}
```

### DocumentContentSampler (apps/search-ai/src/services/vocabulary/)

```typescript
export class DocumentContentSampler {
  async sampleEnumValues(
    knowledgeBaseId: string,
    tenantId: string,
    options?: SamplingOptions,
  ): Promise<SamplingResult>;
}
export function getDocumentContentSampler(): DocumentContentSampler;
export interface SamplingResult {
  candidates: EnumCandidate[];
  sampledDocCount: number;
  indexName: string;
}
```

### VocabularyEnrichmentService (apps/search-ai/src/services/vocabulary/)

```typescript
export class VocabularyEnrichmentService {
  async enrichTerms(options: EnrichmentOptions): Promise<EnrichmentResult>;
}
export interface EnrichmentOptions {
  tenantId: string;
  knowledgeBaseId: string;
  connectorType: string;
  termCandidates: ITermCandidate[];
  enumCandidates: EnumCandidate[];
  llmClient: WorkerLLMClient;
}
```

### resolveIndexLLMConfig (apps/search-ai/src/services/llm-config/resolver.ts)

```typescript
export async function resolveIndexLLMConfig(
  tenantId: string,
  indexId: string,
): Promise<ResolvedIndexLLMConfig>;
// Returns { provider, apiKey, useCases: { vocabularyGeneration: { model } } }
```

## File List

| File                                                                        | Action | Description                                         |
| --------------------------------------------------------------------------- | ------ | --------------------------------------------------- |
| `apps/search-ai/src/workers/vocabulary-generation-worker.ts`                | MODIFY | Rewrite orchestration to use 3-step Epic 4 pipeline |
| `apps/search-ai/src/workers/__tests__/vocabulary-generation-worker.test.ts` | MODIFY | Rewrite tests for new orchestration flow            |

## Tasks

1. **Rewrite `processVocabularyGenerationJob()`**: Replace CriticalFieldDetection + per-field LLM logic with sequential 3-step orchestration
2. **Update `VocabularyGenerationJobData`**: Add `knowledgeBaseId` field (already has `projectKbId` — use both)
3. **Update imports**: Add QueryLogAnalysisService, DocumentContentSampler, VocabularyEnrichmentService
4. **Remove old imports**: Remove CriticalFieldDetectionService, remove inline LLM prompt functions
5. **Rewrite tests**: Mock all 3 services, test orchestration flow, test graceful degradation
6. **Verify build + test**: `pnpm build --filter=@agent-platform/search-ai && pnpm test`
