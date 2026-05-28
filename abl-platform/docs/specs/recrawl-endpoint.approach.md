# Recrawl Endpoint — Implementation Approach

## Problem

The frontend recrawl (`handleQuickRecrawl`) reconstructs the entire crawl payload from scattered client-side state, causing:

1. **Strategy mismatch bug** — reads `displayJob.strategy` which stores internal strategy (`'bulk'`), sends it to `/batch` which expects user-facing strategy (`'smart'`). Result: 400 on every recrawl.
2. **Lost configuration** — `sectionMapping`, `filters`, `groupStrategies`, `crawlDelay` are all dropped. Recrawl doesn't reproduce the original crawl.
3. **Redundant profiling** — `/batch` re-profiles the site on every call. For recrawl, the profile is already stored on `source.crawlConfig.profile`.
4. **Fragile coupling** — any backend schema change requires frontend changes in 4+ callsites that manually assemble payloads.

## What the Backend Already Stores

| Data                 | Location                                   | Contains                                                                                |
| -------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| URLs crawled         | `CrawlJob.urls.original`                   | Exact URL list from last crawl                                                          |
| User-facing strategy | `CrawlJob.configuration.strategy`          | `'smart'`, `'sitemap'`, etc.                                                            |
| All resolved params  | `CrawlJob.configuration`                   | limits, discovery flags, filters, sectionMapping                                        |
| Site profile         | `SearchSource.crawlConfig.profile`         | domain, hasSitemap, jsRequired, platform                                                |
| Crawl settings       | `SearchSource.crawlConfig.settings`        | maxPages, maxDepth, rendering, cleanup, respectRobotsTxt, deduplicate, **requestDelay** |
| Section mapping      | `SearchSource.crawlConfig.sections`        | Per-section strategy, patterns, URLs                                                    |
| Group strategies     | `SearchSource.crawlConfig.groupStrategies` | Per-pattern rendering method (http/playwright)                                          |
| Auth config          | `SearchSource.crawlConfig.auth`            | Method, credentials, headers                                                            |

**Everything needed for recrawl exists server-side.** The frontend should not reconstruct it.

## Approach

### New Endpoint: `POST /api/crawl/recrawl`

**Request (Zod-validated):**

```typescript
const recrawlSchema = z
  .object({
    sourceId: z.string().min(1),
    indexId: z.string().min(1),
    forceReprocess: z.boolean().optional().default(false),
  })
  .strict();
```

**Route placement**: Registered immediately after `POST /batch` (after line 959 in crawl.ts). Static route, no shadowing risk.

**Backend logic:**

1. **Validate request** with Zod `.safeParse(req.body)` — return 400 on failure
2. **Auth guard**: Check `req.tenantContext` (same as `/batch`)
3. **Load source** (tenant-scoped): `SearchSource.findOne({ _id: sourceId, indexId, tenantId })`
4. **Load latest CrawlJob** for this source: `CrawlJob.findOne({ sourceId, tenantId }).sort({ 'timeline.submittedAt': -1 })`
5. **Guard: no previous job** → return 400 `NO_PREVIOUS_CRAWL`
6. **Guard: source status** → reject if `pending`/`syncing` with 409 `CRAWL_IN_PROGRESS` (same logic as `/batch` lines 791-836)
7. **Build crawl payload from stored state:**
   - `urls` ← `previousJob.urls.original`
   - `strategy` ← `previousJob.configuration.strategy` (user-facing: `'smart'`, `'sitemap'`, etc.)
   - `limits` ← `previousJob.configuration.limits`
   - `crawlSettings`:
     - `crawlDelay` ← `source.crawlConfig.settings.requestDelay ?? 1000` (**field mapping: `requestDelay` → `crawlDelay`**)
     - `respectRobotsTxt` ← `source.crawlConfig.settings.respectRobotsTxt ?? true`
     - `cleanupLevel` ← `source.crawlConfig.settings.cleanup ?? 'standard'`
     - `deduplicate` ← `source.crawlConfig.settings.deduplicate ?? true`
     - `cookieConsent` ← `source.crawlConfig.settings.cookieConsent ?? true`
     - `reuseHandlers` ← `source.crawlConfig.settings.reuseHandlers ?? true`
   - `sectionMapping` ← `source.crawlConfig.sections` (latest saved, mapped to `BulkCrawlSectionMapping[]`)
   - `filters` ← `previousJob.configuration.filters ?? {}`
   - `forceReprocess` ← from request body
8. **SSRF re-validation**: Run `isURLAllowed()` on all URLs. For sets >1000, validate all (URLs were stored from a prior validated crawl, but blocklist may have changed). Remove any newly-blocked URLs; if all blocked, return 400.
9. **Build SiteProfile from stored profile** via adapter function:
   ```typescript
   function buildSiteProfileFromStored(profile: ICrawlConfigProfile): SiteProfile {
     return {
       domain: profile.domain,
       profiledAt: new Date(),
       siteType: (profile.siteType as SiteProfile['siteType']) || 'unknown',
       jsRequired: profile.jsRequired ?? false,
       linkDensity: 0, // Not stored; safe default
       estimatedSize: profile.estimatedSize ?? 0,
       avgResponseTime: profile.avgResponseTime ?? 500,
       rateLimitDetected: false, // Conservative default — won't throttle unnecessarily
       maxConcurrency: 10, // Safe default — StrategyResolver may lower based on strategy
       confidence: 80, // Lower than fresh profile (100) since it's cached
       metadata: {
         hasSitemap: profile.hasSitemap ?? false,
         hasRobotsTxt: undefined, // Not stored
         sitemapPageCount: profile.sitemapPageCount ?? undefined,
       },
     };
   }
   ```
10. **Resolve strategy**: `StrategyResolver.resolve({ strategy, limits }, siteProfile)` — same as `/batch` but with stored inputs
11. **Skip decision engine + prompt evaluator**: For recrawl, construct a minimal `CrawlDecision` from resolved params:
    ```typescript
    const decision: CrawlDecision = {
      strategy: resolvedParams.internalStrategy,
      confidence: 100,
      source: 'recrawl', // Indicates this came from stored config, not fresh analysis
      reasoning: `Recrawl of source ${sourceId} using stored configuration`,
      recommendations: [],
    };
    ```
    This avoids the need for `decisionEngine.decide()` which requires a full profiling context. The BullMQ job uses `decision.strategy` (line 859) for the worker's `options.strategy` field — our synthetic decision provides the same value.
12. **Create CrawlJob** with `comparison.previousJobId` set to `previousJob._id`
13. **Update source**: Set `crawlConfig.crawlJobId = newJobId` (for direct lookup on next recrawl)
14. **Transition source status** (same logic as `/batch`)
15. **Enqueue BullMQ job** with same payload structure as `/batch` (lines 840-904)
16. **Return** `{ success: true, jobId, needsUserInput: false }`

### Scope of Shared Function Extraction

**Decision: Extract CrawlJob creation + source transition + BullMQ enqueue only. Do NOT refactor `/batch/respond`.**

Rationale: `/batch/respond` has a structurally different BullMQ payload (no `crawlSettings`, no `sectionMapping`, no `forceReprocess`). Normalizing it would risk breaking pending decisions created before deployment. The shared function serves `/batch` and `/recrawl` only. `/batch/respond` refactor is a separate future task.

```typescript
interface CreateCrawlJobParams {
  tenantId: string;
  userId: string;
  indexId: string;
  sourceId: string;
  urls: string[];
  resolvedParams: ResolvedCrawlParams;
  crawlSettings: {
    crawlDelay: number;
    respectRobotsTxt: boolean;
    cleanupLevel: 'standard' | 'aggressive' | 'none';
    deduplicate: boolean;
    cookieConsent: boolean;
    reuseHandlers: boolean;
  };
  decision: CrawlDecision;
  sectionMapping?: Array<{
    sectionId: string;
    pattern: string;
    name: string;
    urls: string[];
    strategy: 'http' | 'browser';
  }>;
  filters?: Record<string, unknown>;
  forceReprocess: boolean;
  previousJobId?: string; // For recrawl diff tracking
  options?: Record<string, unknown>; // Legacy options passthrough
}

async function createCrawlJobAndEnqueue(params: CreateCrawlJobParams): Promise<{
  jobId: string;
  batchId: string;
}>;
```

Two callers (for now):

1. `POST /batch` — existing first-crawl path (profiles site, decides, resolves strategy, calls shared function)
2. `POST /recrawl` — new path (reads stored config, resolves strategy, builds synthetic decision, calls shared function)

### Frontend Changes

**New API function** in `apps/studio/src/api/crawl.ts`:

```typescript
export async function recrawlSource(data: {
  sourceId: string;
  indexId: string;
  forceReprocess?: boolean;
}): Promise<BatchSubmitResponse> {
  return apiFetch<BatchSubmitResponse>('/api/search-ai/crawl/recrawl', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
```

**Simplified `handleQuickRecrawl`** in UnifiedSourcePage.tsx:

```typescript
const handleQuickRecrawl = useCallback(
  async (options?: { force?: boolean }) => {
    if (!indexId || !sourceId) return;
    try {
      const result = await recrawlSource({
        sourceId,
        indexId,
        forceReprocess: options?.force ?? false,
      });
      if (result.success) {
        toast.success(options?.force ? t('force_recrawl_submitted') : t('recrawl_submitted'));
        mutateSources();
      } else {
        toast.error(t('recrawl_failed'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('recrawl_failed'));
    }
  },
  [indexId, sourceId, t, mutateSources],
);
```

Dependency on `displayJob` and `source` is completely removed — no more strategy mismatch, no more missing fields.

### Studio Proxy Route

Currently there's no Studio Next.js proxy for crawl — it uses `rewriteSearchAiPath` directly. The new endpoint follows the same pattern. No proxy route needed.

## Files Changed

| File                                                                     | Change                                                                                                | Est. Lines          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------- |
| `apps/search-ai/src/routes/crawl.ts`                                     | Extract `createCrawlJobAndEnqueue()`, add `POST /recrawl` handler, add `buildSiteProfileFromStored()` | +120, refactor ~100 |
| `apps/studio/src/api/crawl.ts`                                           | Add `recrawlSource()` function                                                                        | +12                 |
| `apps/studio/src/components/search-ai/source-page/UnifiedSourcePage.tsx` | Simplify `handleQuickRecrawl` to use `recrawlSource()`, remove unused imports                         | -25, +15            |

## What This Does NOT Change

- `POST /batch` — unchanged, still the path for first crawl, single-page retry, error retry
- `POST /batch/respond` — unchanged (future refactor candidate)
- CrawlFlowV5 wizard — unchanged
- CrawledPagesView single-page retry — unchanged (uses `/batch` with `strategy: 'single-page'`)
- ErrorGroupingPanel retry — unchanged (uses `/batch` with `strategy: 'single-page'`)

## Edge Cases

1. **No previous job**: Source was created but never crawled → return 400 `NO_PREVIOUS_CRAWL`
2. **Source has no crawlConfig**: Legacy source without config → fall back to defaults from previous job's `configuration`
3. **Source has no crawlConfig.profile**: Can't build SiteProfile → fall back to fresh profiling via `profiler.profile(urls[0])` (only this edge case hits the network)
4. **User edited settings between crawls**: Recrawl uses latest `crawlConfig.settings` (intended — user expects their edits to take effect)
5. **Previous job was cancelled mid-crawl**: `urls.original` is still the full list — recrawl retries all of them
6. **Concurrent recrawl clicks**: Source status guard (same as `/batch`) rejects with 409
7. **SSRF: stored URL now blocked**: Remove blocked URLs, proceed with remaining. If all blocked, return 400 `ALL_URLS_BLOCKED`
8. **`requestDelay` field mapping**: `ICrawlConfigSettings.requestDelay` maps to `crawlSettings.crawlDelay` in BullMQ payload. If `requestDelay` is null/undefined, defaults to 1000ms.

## Review Findings Addressed

| Finding                                                 | Severity | Resolution                                                                                                                                                                                        |
| ------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crawlDelay` vs `requestDelay` field name               | HIGH     | Explicit mapping in step 7: `settings.requestDelay → crawlSettings.crawlDelay`                                                                                                                    |
| `SiteProfile` shape mismatch from `ICrawlConfigProfile` | HIGH     | Adapter function `buildSiteProfileFromStored()` with documented defaults                                                                                                                          |
| `CrawlDecision` required but decision engine skipped    | HIGH     | Synthetic `CrawlDecision` from resolved params, `source: 'recrawl'`                                                                                                                               |
| `/batch/respond` BullMQ payload divergence              | HIGH     | Excluded from refactor scope — shared function serves `/batch` + `/recrawl` only                                                                                                                  |
| SSRF re-validation on stored URLs                       | HIGH     | Step 8: re-run `isURLAllowed()` on all URLs, remove blocked                                                                                                                                       |
| Zod validation on request body                          | MEDIUM   | Added `recrawlSchema` with `.strict()`                                                                                                                                                            |
| Route ordering                                          | MEDIUM   | Specified: after `POST /batch` (line 959)                                                                                                                                                         |
| `groupStrategies` / `documentUrls` forwarding           | MEDIUM   | Not forwarded — `groupStrategies` is intelligence-crawl only (not in `BulkCrawlJobData`); `documentUrls` are job-specific (PDF attachments passed during initial crawl), not relevant for recrawl |
| `crawlConfig.crawlJobId` update                         | MEDIUM   | Step 13: update after CrawlJob creation                                                                                                                                                           |
| `ParsedCrawlSettings` definition                        | MEDIUM   | Explicit interface in `CreateCrawlJobParams`                                                                                                                                                      |
| History SWR not mutated                                 | LOW      | Same as current behavior — polling picks it up. Documented gap.                                                                                                                                   |
| i18n keys                                               | LOW      | Existing keys reused — no new UI text needed                                                                                                                                                      |
