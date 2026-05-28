# Story 4.3: LLM-Based Vocabulary Enrichment Service

## Status: ready-for-dev

## Story

As a SearchAI Administrator,
I want the system to use an LLM to enrich vocabulary term candidates with aliases, descriptions, and capability metadata,
So that the domain vocabulary accurately reflects user language and maps cleanly to canonical fields.

## Context

**This is a NEW service.** It consumes the outputs of two upstream Wave 1 stories:

1. **Story 4.1 (Query Log Analysis):** Produces `ITermCandidate[]` stored in `VocabularyCandidates` MongoDB collection. Each candidate has `term`, `frequency`, `queryCount`, `fieldAffinity`, `coOccurrences`, and `sampleQueries`.
2. **Story 4.2 (Document Content Sampling):** Produces `EnumCandidate[]` from OpenSearch aggregations. Each candidate has `storageField`, `alias`, `label`, `values`, `cardinality`, and `confidence`.

The enrichment service:

- Takes term candidates + enum candidates as input
- Batches terms (50 per LLM call) for cost efficiency
- Builds a structured prompt with term context, field type, and sample values
- Uses `WorkerLLMClient` from `@agent-platform/llm` for provider-neutral LLM calls
- Wraps LLM calls with a circuit breaker for resilience
- Retries with exponential backoff (3 attempts)
- Tracks token usage for cost monitoring
- Validates LLM responses (rejects empty aliases, malformed JSON)
- Stores results as `IVocabularyEntry[]` in the `DomainVocabulary` collection via upsert

**Key Design Decisions:**

- Circuit breaker is a simple in-process implementation (not Redis-backed) since this service runs as a one-shot batch, not a persistent worker
- Batch size of 50 terms per LLM call balances throughput vs. context window limits
- Enum candidates are merged into term context to give the LLM richer signal about field values
- Partial results are returned on LLM failure (graceful degradation)

## Acceptance Criteria

- [ ] `VocabularyEnrichmentService` class created in `apps/search-ai/src/services/vocabulary/vocabulary-enrichment.service.ts`
- [ ] `enrichTerms()` method accepts term candidates, enum candidates, and LLM client
- [ ] Terms are batched at 50 per LLM call
- [ ] Prompt includes term, frequency, sample queries, field affinity, and enum values when available
- [ ] LLM response is parsed from JSON (handles markdown code fences)
- [ ] Validation rejects entries with empty `term` or empty `aliases` array
- [ ] Circuit breaker opens after 3 consecutive LLM failures, resets after 60s
- [ ] Retry with exponential backoff: 3 attempts, base delay 1s, max delay 10s
- [ ] Token usage is tracked and returned in enrichment summary
- [ ] Results are stored in `DomainVocabulary` via upsert (create or update existing)
- [ ] Tenant isolation: every DB query includes `tenantId`
- [ ] All errors logged with `createLogger('vocabulary-enrichment')`, never `console.log`
- [ ] Graceful degradation: LLM unavailable returns partial/empty results, does not throw

## Verified Service Signatures & Existing Code

### WorkerLLMClient (packages/llm/src/worker-llm-client.ts)

```typescript
export class WorkerLLMClient {
  constructor(provider: string, apiKey: string, modelId: string, options?: WorkerLLMClientOptions);

  async chat(
    systemPrompt: string,
    messages: Array<{ role: string; content: string | ContentBlock[] }>,
    options?: { model?: string; maxTokens?: number; timeoutMs?: number },
  ): Promise<string>;
}
```

### IVocabularyEntry (packages/database/src/models/domain-vocabulary.model.ts)

```typescript
export interface IVocabularyEntry {
  id: string;
  term: string;
  aliases: string[];
  description?: string;
  fieldRef: string;
  capabilities: {
    canFilter: boolean;
    canDisplay: boolean;
    canAggregate: boolean;
    canSort: boolean;
  };
  relatedFields: {
    displayWith: string[];
    aggregateWith: string[];
  };
  enabled: boolean;
  confidence?: number;
  generatedBy: 'auto' | 'manual';
  usageCount?: number;
  lastUsed?: Date;
}
```

### ITermCandidate (packages/database/src/models/vocabulary-candidates.model.ts)

```typescript
export interface ITermCandidate {
  term: string;
  frequency: number;
  queryCount: number;
  fieldAffinity: string | null;
  coOccurrences: Array<{ term: string; count: number }>;
  sampleQueries: string[];
}
```

### EnumCandidate (apps/search-ai/src/services/vocabulary/types.ts)

```typescript
export interface EnumCandidate {
  storageField: string;
  alias: string | null;
  label: string | null;
  values: EnumValueEntry[];
  cardinality: number;
  confidence: number;
}
```

### getLazyModel (apps/search-ai/src/db/index.ts)

```typescript
import { getLazyModel } from '../db/index.js';
const DomainVocabulary = getLazyModel<IDomainVocabulary>('DomainVocabulary');
```

### uuidv7 (packages/database/src/mongo/base-document.ts)

```typescript
import { uuidv7 } from '@agent-platform/database/mongo';
```

## File List

| File                                                                                            | Action | Purpose                                    |
| ----------------------------------------------------------------------------------------------- | ------ | ------------------------------------------ |
| `apps/search-ai/src/services/vocabulary/vocabulary-enrichment.service.ts`                       | CREATE | VocabularyEnrichmentService implementation |
| `apps/search-ai/src/services/vocabulary/index.ts`                                               | MODIFY | Add barrel export                          |
| `apps/search-ai/src/services/vocabulary/__tests__/vocabulary-enrichment.test.ts`                | CREATE | Unit tests                                 |
| `docs/searchai/stories/implementation-artifacts/4-3-llm-based-vocabulary-enrichment-service.md` | CREATE | This story file                            |

## Tasks

### Task 1: Create VocabularyEnrichmentService

Create `apps/search-ai/src/services/vocabulary/vocabulary-enrichment.service.ts` with:

- `enrichTerms(options: EnrichmentOptions): Promise<EnrichmentResult>` main method
- Batching logic (50 terms per LLM call)
- Prompt builder with term context + enum values
- JSON response parser with markdown code fence handling
- Validation (reject empty aliases, missing term)
- In-process circuit breaker (opens after 3 failures)
- Exponential backoff retry (3 attempts)
- Token usage tracking
- DomainVocabulary upsert

### Task 2: Update barrel export

Add `VocabularyEnrichmentService` export to `apps/search-ai/src/services/vocabulary/index.ts`.

### Task 3: Unit tests

Test:

1. Batching: 120 terms splits into 3 batches (50+50+20)
2. LLM response parsing (valid JSON, markdown fenced JSON)
3. Validation rejects empty aliases
4. Circuit breaker opens after 3 failures
5. Graceful degradation returns partial results
6. Token usage tracking
7. Tenant isolation in DB queries

## Previous Story Intelligence

- **Pattern:** Use `getLazyModel` for all model access, never import models directly
- **Pattern:** `createLogger('module-name')` for logging, `log.error('message', { context })` format
- **Pattern:** `err instanceof Error ? err.message : String(err)` for error extraction
- **Pattern:** `vi.hoisted()` + `vi.mock()` pattern for test setup (see document-content-sampler.test.ts)
- **Anti-pattern:** Never `console.log` in server code
- **Anti-pattern:** Never `.catch(() => {})` -- log or propagate every error

## Build & Test Commands

```bash
pnpm build --filter=@agent-platform/search-ai
pnpm vitest run apps/search-ai/src/services/vocabulary/__tests__/vocabulary-enrichment.test.ts
npx prettier --write apps/search-ai/src/services/vocabulary/vocabulary-enrichment.service.ts apps/search-ai/src/services/vocabulary/index.ts apps/search-ai/src/services/vocabulary/__tests__/vocabulary-enrichment.test.ts
```
