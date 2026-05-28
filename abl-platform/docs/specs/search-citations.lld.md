# Search Citations — Low-Level Design

## Task T-1: Wire Source URLs in Query Pipeline

### Files to Modify

- `apps/search-ai-runtime/src/services/query/query-pipeline.ts` — populate `source.reference` from MongoDB `originalReference` lookup

### Prerequisites

**Verify SearchDocument model is bound in search-ai-runtime**: Check `apps/search-ai-runtime/src/db/index.ts` for `bindModelsForSearchAI()` call. SearchDocument is registered as `'SearchDocument'` in the `search_ai` database via `ModelRegistry`. If not already bound, add explicit binding. The query-pipeline currently only uses `SearchChunk` and `DomainVocabulary` — SearchDocument may need explicit registration.

### Function Signatures

- `enrichResultsWithSourceUrls(results: SearchResult[], tenantId: string): Promise<SearchResult[]>` — batch lookup `SearchDocument.originalReference` by documentId+tenantId, populate `source.reference`

### Implementation Details

**At query-pipeline.ts ~L985-1002** (result mapping):

1. After the `osResult.hits.map(...)` produces `results`, collect unique `documentId` values
2. Batch lookup from MongoDB (verify `SearchDocument` is accessible via `getLazyModel` in search-ai-runtime first):
   ```typescript
   const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
   const docIds = [...new Set(results.map((r) => r.documentId))];
   const docs = await SearchDocument.find(
     { _id: { $in: docIds }, tenantId: query.tenantId },
     { originalReference: 1, sourceType: 1 },
   ).lean();
   const docMap = new Map(docs.map((d) => [d._id.toString(), d]));
   ```
3. Populate `source.reference` (null-safe — `documentId` can be `undefined` from `metadata.sys?.documentId`):
   ```typescript
   for (const result of results) {
     if (!result.documentId) continue; // defensive: skip results without documentId
     const doc = docMap.get(result.documentId);
     if (doc?.originalReference) {
       const ref = doc.originalReference;
       // Connector/crawled: originalReference is a URL (https://...)
       // File upload: originalReference is just a filename
       if (ref.startsWith('http://') || ref.startsWith('https://')) {
         if (result.source) result.source.reference = ref;
       }
       // For file uploads, reference stays undefined — runtime handles via JWT
     }
   }
   ```
4. This replaces the `reference: undefined` TODO at L999

**NOTE on aggregation queries**: The query pipeline also supports aggregation-only queries (facet counts, etc.) that return no document results. The enrichment function MUST handle empty `results` array gracefully — skip the MongoDB lookup if `docIds` is empty.

### Subtasks (execution order)

1. ST-1.0: Verify `SearchDocument` model is registered in search-ai-runtime's `db/index.ts` via `bindModelsForSearchAI()`. If not already bound, add explicit registration. The model is needed for the MongoDB batch lookup.
2. ST-1.1: Add `SearchDocument` model import and batch lookup function after result mapping
3. ST-1.2: Populate `source.reference` from `originalReference` for URL-type values
4. ST-1.3: Add `sourceType` to `SourceAttribution` — set `'connector'` when `connectorId` present, `'upload'` otherwise (already done at L997), plus `'crawled'` when `originalReference` starts with `http` and no connectorId

### Acceptance Criteria

- AC-1.1: Given a SharePoint document in the index, When a search query returns it, Then `source.reference` = `https://contoso.sharepoint.com/...` (the `originalReference` from MongoDB)
- AC-1.2: Given a file upload in the index, When a search query returns it, Then `source.reference` = `undefined` (not a URL)
- AC-1.3: Given a crawled page in the index, When a search query returns it, Then `source.reference` = `https://docs.example.com/...`
- AC-1.4: The MongoDB batch lookup adds < 10ms latency for 10 results (single indexed query)

---

## Task T-2: Citation Config Schema + Discovery Manifest

### Files to Modify

- `packages/database/src/models/search-index.model.ts` — add `citationConfig` to `ISearchIndex` and schema
- `apps/search-ai-runtime/src/routes/discover.ts` — include `citationConfig` in discovery response
- `apps/search-ai/src/workers/canonical-mapper-worker.ts` — fix `buildDefaultCanonicalFields` to prefer `originalReference` for future docs

### Files to Create

- None — all changes to existing files

### Type Definitions

```typescript
// In search-index.model.ts
export interface ICitationConfig {
  /** Whether citations are enabled for this index. Default: true */
  enabled: boolean;
  /** How file upload links are generated */
  linkMode: 'direct' | 'time_limited' | 'click_limited' | 'disabled';
  /** TTL for time-limited/click-limited links in seconds. Default: 3600 */
  linkTtlSeconds: number;
  /** Max clicks for click-limited links. Default: 5 */
  maxClicks: number;
}
```

### Implementation Details

**search-index.model.ts** — add to `ISearchIndex` interface (~L200):

```typescript
citationConfig?: ICitationConfig | null;
```

Add to schema (~L350):

```typescript
citationConfig: {
  type: {
    enabled: { type: Boolean, default: true },
    linkMode: { type: String, enum: ['direct', 'time_limited', 'click_limited', 'disabled'], default: 'direct' },
    linkTtlSeconds: { type: Number, default: 3600, min: 60, max: 604800 },
    maxClicks: { type: Number, default: 5, min: 1, max: 100 },
  },
  default: null,
  _id: false,
},
```

**discover.ts** — add `citationConfig` to response object construction (~L468-490, NOT L221 which is the route definition):

```typescript
citationConfig: index.citationConfig ?? { enabled: true, linkMode: 'direct', linkTtlSeconds: 3600, maxClicks: 5 },
```

**canonical-mapper-worker.ts** — fix `buildDefaultCanonicalFields` (~L260):

```typescript
// Prefer originalReference when it's a navigable URL (for connectors/crawlers)
// Fall back to sourceUrl (S3 key) for file uploads
if (
  document.originalReference &&
  (document.originalReference.startsWith('http://') ||
    document.originalReference.startsWith('https://'))
) {
  canonical.source_url = document.originalReference;
} else if (document.sourceUrl) {
  canonical.source_url = document.sourceUrl;
} else if (document.originalReference) {
  canonical.source_url = document.originalReference;
}
```

### Subtasks (execution order)

1. ST-2.1: Add `ICitationConfig` interface and schema field to search-index.model.ts
2. ST-2.2: Export `ICitationConfig` from `packages/database` barrel
3. ST-2.3: Add `citationConfig` to discovery manifest response in discover.ts
4. ST-2.4: Fix `buildDefaultCanonicalFields` to prefer `originalReference` for URL values

### Acceptance Criteria

- AC-2.1: Given a new SearchIndex, When no citationConfig is set, Then default is `null` (backward compatible)
- AC-2.2: Given a SearchIndex with `citationConfig.enabled = false`, When runtime fetches discovery manifest, Then `citationConfig.enabled` is `false`
- AC-2.3: Given a new SharePoint document indexed after the fix, Then `canonical.source_url` = the SharePoint webUrl (not S3 URL)
- AC-2.4: Given a file upload indexed after the fix, Then `canonical.source_url` = S3 URL (unchanged — no URL in `originalReference`)

---

## Task T-3: Runtime Citation Generation

### Files to Modify

- `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts` — preserve source data in `formatResult()`; store citation map
- `apps/runtime/src/services/execution/reasoning-executor.ts` — add citation instructions to lean synthesis prompt; thread citations to response
- `apps/runtime/src/services/execution/types.ts` — add `citations?: Citation[]` to `ExecutionResult` interface (~L509-517)
- `apps/runtime/src/types/index.ts` — add `Citation` type and `citations` field to `response_end` ServerMessage
- `apps/runtime/src/websocket/events.ts` — add `citations` parameter to `responseEnd()`
- `apps/runtime/src/websocket/handler.ts` — thread citations from execution result to `responseEnd()`
- `apps/runtime/src/channels/adapters/slack-stream-buffer.ts` — update `PARTIAL_CITATION_RE` to handle `[N]` pattern
- `apps/runtime/src/channels/adapters/telegram-stream-buffer.ts` — same regex update

NOTE: Channel handlers (Slack, Telegram, WhatsApp) do NOT go through `ServerMessages.responseEnd()` — they send text directly via platform APIs. Channel citation rendering (formatted footnotes in Slack mrkdwn, Telegram markdown) is OUT OF SCOPE per HLD. The only channel change is the regex update to prevent `[N]` from being split across stream chunks.

### Type Definitions

```typescript
// In apps/runtime/src/types/index.ts (alongside ServerMessage)
export interface Citation {
  /** 1-based index matching [N] in the response text */
  index: number;
  /** Document title */
  title: string;
  /** User-navigable URL for connector/crawled sources; JWT download URL for uploads */
  url: string;
  /** Source type: connector (SharePoint, etc.), upload, or crawled */
  sourceType: 'connector' | 'upload' | 'crawled';
  /** Original document ID */
  documentId: string;
}
```

### Implementation Details

**searchai-kb-tool-executor.ts — `formatResult()`** (~L1226-1232):

Add a typed interface for formatted results:

```typescript
interface FormattedSearchResult {
  title?: string;
  content: string;
  /** Source URL for citation mapping — not sent to LLM */
  _sourceUrl?: string;
  /** Document ID for citation token generation */
  _documentId?: string;
  /** Source type for URL resolution strategy */
  _sourceType?: 'connector' | 'upload' | 'crawled';
}
```

Update the result mapping:

```typescript
return {
  title: canonical.title ?? meta?.title ?? meta?.source_name ?? undefined,
  content: r.content ?? '',
  _sourceUrl: r.source?.reference ?? undefined,
  _documentId: r.documentId ?? undefined,
  _sourceType: r.source?.sourceType ?? 'upload',
} satisfies FormattedSearchResult;
```

Add a new method to generate the citation map from formatted results:

```typescript
buildCitationMap(formattedResult: { results: FormattedSearchResult[] }, citationConfig: ICitationConfig | null): Citation[] | undefined
```

- If `citationConfig?.enabled === false`, return `undefined`
- Map each result with `_sourceUrl` to a `Citation` object
- For upload sources without a URL, generate a JWT download URL via `signCitationToken()`
- Return the array of citations

**reasoning-executor.ts — lean synthesis prompt** (~L2281-2285):

When citations are enabled (check `manifest.citationConfig?.enabled !== false`):

```typescript
leanParts.push(
  "Answer the user's question using ONLY the search results provided in the conversation. " +
    "Be concise and direct. If the results don't contain the answer, say so honestly. " +
    'Do not make up information beyond what the search results show. ' +
    'IMPORTANT: When using information from search results, cite the source by including ' +
    'the result number in square brackets, like [1], [2], etc. Always cite your sources.',
);
```

Also modify the tool result JSON to include numbered labels:

```typescript
results: topResults.map((r: any, i: number) => ({
  [`[${i + 1}]`]: r.title || `Result ${i + 1}`,
  content: r.content,
})),
```

**types/index.ts — ServerMessage** (~L278-287):

Add to `response_end` union member:

```typescript
citations?: Citation[];
```

**events.ts — `responseEnd()`** (~L248):

Add optional `citations` parameter (8th positional parameter — matches existing pattern):

```typescript
responseEnd(
  sessionId: string,
  messageId: string,
  fullText: string,
  voiceConfig?: import('@abl/compiler').VoiceConfigIR,
  richContent?: import('@abl/compiler').RichContentIR,
  actions?: import('@abl/compiler').ActionSetIR,
  executionId?: string,
  citations?: Citation[],
): ServerMessage {
  return {
    type: 'response_end',
    sessionId, messageId, fullText,
    voiceConfig, richContent, actions,
    ...(executionId && { executionId }),
    ...(citations?.length ? { citations } : {}),
  };
}
```

**handler.ts — responseEnd call site** (~L2443-2454):

Thread citations from execution result:

```typescript
send(
  ws,
  ServerMessages.responseEnd(
    sessionId,
    responseMessageId,
    fullResponse,
    result?.voiceConfig,
    result?.richContent,
    result?.actions,
    initExecutionId,
    result?.citations, // NEW
  ),
);
```

The `result` object from reasoning-executor needs to carry `citations`. Add to its return type.

### Subtasks (execution order)

1. ST-3.1: Add `Citation` type to `apps/runtime/src/types/index.ts`
2. ST-3.2: Add `citations?` to `response_end` in ServerMessage type
3. ST-3.3: Add `citations?: Citation[]` to `ExecutionResult` in `apps/runtime/src/services/execution/types.ts`
4. ST-3.4: Update `responseEnd()` factory in `events.ts` to accept `citations`
5. ST-3.5: Modify `formatResult()` to preserve `_sourceUrl`, `_documentId`, `_sourceType` using `FormattedSearchResult` interface
6. ST-3.6: Add `buildCitationMap()` method to `SearchAIKBToolExecutor`; read `CITATION_SIGNING_SECRET` from `process.env.CITATION_SIGNING_SECRET ?? process.env.JWT_SECRET`
7. ST-3.7: Modify lean synthesis prompt to include citation instructions when `manifest.citationConfig?.enabled !== false`
8. ST-3.8: Thread citations through reasoning-executor result → `ExecutionResult.citations` → handler → responseEnd
9. ST-3.9: Update handler.ts responseEnd call site at ~L2445 (main execution success path ONLY) to pass `result?.citations`. The other 9 call sites are error/scripted/diagnostic paths — they do NOT get citations.
10. ST-3.10: ~~Update channel message pipeline~~ REMOVED — channels don't use `ServerMessages.responseEnd()`. See NOTE above.
11. ST-3.11: Update `PARTIAL_CITATION_RE` in `slack-stream-buffer.ts` and `telegram-stream-buffer.ts` to handle `[N]` pattern. New regex: `/\[(?:\d+|d(?:o(?:c(?:-\d*)?)?)?)?$/`

### Acceptance Criteria

- AC-3.1: Given citations enabled, When LLM generates "Revenue was $4.2M [1]", Then `response_end.citations[0]` has the correct title, URL, and sourceType
- AC-3.2: Given citations disabled via `citationConfig.enabled = false`, When LLM generates an answer, Then `response_end.citations` is `undefined`
- AC-3.3: Given a file upload result, Then its citation URL is a JWT download URL (`/api/citations/:token`)
- AC-3.4: Given a SharePoint result, Then its citation URL is the direct SharePoint webUrl
- AC-3.5: `PARTIAL_CITATION_RE` in slack/telegram stream buffers handles `[N]` pattern without splitting across chunks
- AC-3.6: Given zero search results, When LLM generates an answer, Then `response_end.citations` is `undefined` (not empty array)

---

## Task T-4: Secure Download URL Endpoint

### Files to Create

- `apps/search-ai/src/routes/citation-download.ts` — public citation redirect endpoint
- `apps/search-ai/src/services/citation-token.service.ts` — JWT sign/verify + Redis click tracking

### Files to Modify

- `apps/search-ai/src/server.ts` — mount citation routes
- `packages/shared-auth/src/purpose-jwt.ts` — add citation token type (audience + payload + sign/verify)

### Function Signatures

**purpose-jwt.ts** (new token type following feedback token pattern):

```typescript
export const CITATION_TOKEN_AUDIENCE = 'citation-download' as const;
export const CITATION_TOKEN_PURPOSE = 'document_download' as const;

export interface CitationTokenPayload {
  tenantId: string;
  indexId: string;
  documentId: string;
  /** S3 key (NOT full s3:// URL). Extracted from SearchDocument.sourceUrl by stripping s3://bucket/ prefix */
  sourceKey: string;
  /** Link mode from citationConfig at sign time */
  linkMode: 'direct' | 'time_limited' | 'click_limited';
  /** Max clicks (only relevant for click_limited mode) */
  maxClicks?: number;
}

export function signCitationToken(
  payload: CitationTokenPayload,
  secret: string,
  options?: { expiresIn?: ExpiresIn },
): string;
// Internally: jwt.sign({ purpose: CITATION_TOKEN_PURPOSE, jti: crypto.randomUUID(), ...payload }, secret, buildSignOptions(CITATION_TOKEN_AUDIENCE, options.expiresIn))
// NOTE: jti is NOT auto-generated by jsonwebtoken — must be explicitly set via crypto.randomUUID() for click tracking

export function verifyCitationToken(token: string, secret: string): CitationTokenPayload;
// Internally: verifyPurposeJwt(token, secret, CITATION_TOKEN_AUDIENCE)
//   → checks payload.purpose === CITATION_TOKEN_PURPOSE
//   → extracts claims via requireStringClaim('tenantId'), requireStringClaim('indexId'),
//     requireStringClaim('documentId'), requireStringClaim('sourceKey')
//   → validates linkMode ∈ ['direct', 'time_limited', 'click_limited']
```

**citation-token.service.ts**:

```typescript
export class CitationTokenService {
  constructor(private redis: Redis, private s3: S3StorageService);

  /** Extract S3 key from sourceUrl. Strips s3://bucket/ prefix or /uploads/ prefix.
   *  e.g. "s3://my-bucket/documents/t1/idx/file.pdf" → "documents/t1/idx/file.pdf"
   *  e.g. "/uploads/documents/t1/idx/file.pdf" → "documents/t1/idx/file.pdf" */
  static extractS3Key(sourceUrl: string): string;

  /** Validate tenant owns the S3 path. File upload keys use documents/{tenantId}/... pattern.
   *  Checks key contains tenantId as a path segment (not just assertTenantOwnsPath which
   *  only checks tenants/{id}/ or {id}/ prefixes — file uploads use documents/{id}/). */
  private validateTenantOwnership(tenantId: string, s3Key: string): void;

  /** Generate a citation download JWT for a file upload document */
  signDownloadUrl(payload: CitationTokenPayload, config: ICitationConfig): string;

  /** Verify token + check click limits + generate presigned S3 URL */
  resolveDownloadUrl(token: string): Promise<{
    url: string;
    remainingClicks?: number;
    expiresAt?: string;
  }>;
}
```

**citation-download.ts** (Express route):

```typescript
// Public endpoint — no auth middleware. Token IS the auth.
// Rate limited by IP.
GET /api/citations/:token
  → validate token param with Zod: z.string().min(1)
  → verify JWT (audience: 'citation-download')
  → validateTenantOwnership(payload.tenantId, payload.sourceKey)
  → if click-limited: Redis atomic counter check (see below)
  → s3.getDownloadUrl(sourceKey, 900) // 15 min presigned
  // IMPORTANT: Uses bare getDownloadUrl(), NOT getDownloadUrlForTenant().
  // Reason: getDownloadUrlForTenant() calls assertTenantOwnsPath() which only
  // accepts tenants/{id}/ or {id}/ prefixes. File upload keys use documents/{id}/
  // which would fail. Tenant validation is done above by validateTenantOwnership().
  // Do NOT "fix" this to use getDownloadUrlForTenant — it will break all downloads.
  → 302 redirect to presigned S3 URL

Error responses use structured envelope:
  → 400: { success: false, error: { code: 'INVALID_TOKEN', message: 'Malformed citation token' } }
  → 410: { success: false, error: { code: 'CITATION_EXPIRED', message: 'Citation link has expired' } }
  → 410: { success: false, error: { code: 'CITATION_EXHAUSTED', message: 'Maximum clicks reached' } }
  → 429: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } }
  → 500: { success: false, error: { code: 'DOWNLOAD_ERROR', message: 'Failed to generate download URL' } }
```

### S3 Key Extraction

**CRITICAL**: `SearchDocument.sourceUrl` stores full S3 URLs like `s3://my-bucket/documents/t1/idx/file.pdf` but `S3StorageService.getDownloadUrl()` expects bare keys like `documents/t1/idx/file.pdf`. The `extractS3Key` utility handles this:

```typescript
static extractS3Key(sourceUrl: string): string {
  if (sourceUrl.startsWith('s3://')) {
    // s3://bucket-name/path/to/file → path/to/file
    const withoutProtocol = sourceUrl.slice(5); // remove "s3://"
    const slashIndex = withoutProtocol.indexOf('/');
    return slashIndex >= 0 ? withoutProtocol.slice(slashIndex + 1) : withoutProtocol;
  }
  if (sourceUrl.startsWith('/uploads/')) {
    return sourceUrl.slice('/uploads/'.length);
  }
  return sourceUrl; // already a bare key
}
```

### Tenant Ownership Validation

**CRITICAL**: `assertTenantOwnsPath()` in `s3-storage.ts` expects keys starting with `tenants/{tenantId}/` or `{tenantId}/`. But file upload keys use `documents/{tenantId}/{indexId}/...`. Instead of modifying the shared utility, `CitationTokenService.validateTenantOwnership()` checks that the S3 key contains `/{tenantId}/` as a path segment:

```typescript
private validateTenantOwnership(tenantId: string, s3Key: string): void {
  // File uploads: documents/{tenantId}/{indexId}/...
  // Crawled:      crawler/cleaned/{tenantId}/{indexId}/...
  if (!s3Key.includes(`/${tenantId}/`) && !s3Key.startsWith(`${tenantId}/`)) {
    throw new Error(`Tenant path violation: key does not belong to tenant ${tenantId}`);
  }
}
```

### Implementation Details

**Redis click tracking** — atomic pattern (no TOCTOU race):

```typescript
// Atomic: always SET NX first (only wins if key doesn't exist), then DECR
const redisKey = `citation:clicks:${jti}`;
// Derive TTL from JWT exp claim — single source of truth, avoids config drift
const redisTtl = payload.exp ? payload.exp - Math.floor(Date.now() / 1000) : 3600;
// Try to initialize — only succeeds if key doesn't exist (NX)
await this.redis.set(redisKey, String(maxClicks), 'EX', redisTtl, 'NX');
// Atomic decrement — works regardless of which request initialized
const remaining = await this.redis.decr(redisKey);
if (remaining < 0) {
  // Clean up exhausted key
  await this.redis.del(redisKey);
  throw new CitationError('CITATION_EXHAUSTED', 'Maximum clicks reached');
}
```

**Rate limiting** — using existing express-rate-limit pattern (add to `apps/search-ai/package.json`):

```typescript
import rateLimit from 'express-rate-limit';
const citationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
    });
  },
});
router.use(citationLimiter);
```

### Subtasks (execution order)

1. ST-4.1: Add `CitationTokenPayload`, `signCitationToken`, `verifyCitationToken` to `purpose-jwt.ts`
2. ST-4.2: Export new functions from `packages/shared-auth` barrel
3. ST-4.3: Add `express-rate-limit` to `apps/search-ai/package.json`; verify Dockerfile COPY lines
4. ST-4.4: Create `citation-token.service.ts` with S3 key extraction, tenant validation, JWT signing, atomic Redis click tracking
5. ST-4.5: Create `citation-download.ts` route with rate limiting, structured error responses, redirect logic
6. ST-4.6: Mount route in `apps/search-ai/src/server.ts` BEFORE `authMiddleware` application (like webhooksRouter pattern). `server.ts` applies `authMiddleware` to ALL `/api` routes at ~L218. Citation route MUST be mounted before this line, e.g.: `app.use('/api/citations', citationDownloadRouter);`
7. ST-4.7: Use `CITATION_SIGNING_SECRET` env var; fall back to `JWT_SECRET` if not set. Both runtime (signing in `buildCitationMap`) and search-ai (verification in citation-download route) MUST use the same secret. Document this in `.env.example`.

### Acceptance Criteria

- AC-4.1: Given a valid citation JWT, When GET `/api/citations/:token`, Then 302 redirect to presigned S3 URL
- AC-4.2: Given an expired JWT, When GET `/api/citations/:token`, Then 410 Gone
- AC-4.3: Given a click-limited token with maxClicks=3, When accessed 4 times, Then first 3 return 302, 4th returns 410
- AC-4.4: Given a token for tenant A's document, When the S3 key doesn't match tenant A's path, Then `assertTenantOwnsPath` throws
- AC-4.5: Given 31 requests from the same IP in 1 minute, Then 429 Too Many Requests

---

## Task T-5: Web SDK Citation Support

### Files to Modify

- `packages/web-sdk/src/transport/types.ts` — add `citations` to `TransportServerMessage` response_end
- `packages/web-sdk/src/transport/DefaultTransport.ts` — forward `citations` field
- `packages/web-sdk/src/core/types.ts` — add `citations` to `Message` interface
- `packages/web-sdk/src/chat/ChatClient.ts` — map `citations` from transport message to `Message` (NOTE: ChatClient is in `chat/`, NOT `core/`)
- `packages/web-sdk/src/react/components/MessageList.tsx` — render citations after message content

### Files to Create

- `packages/web-sdk/src/react/components/CitationList.tsx` — citation footnote UI component

### Type Definitions

```typescript
// In transport/types.ts — add to response_end
citations?: Array<{
  index: number;
  title: string;
  url: string;
  sourceType: 'connector' | 'upload' | 'crawled';
}>;

// In core/types.ts — add to Message interface
citations?: CitationRef[];

export interface CitationRef {
  index: number;
  title: string;
  url: string;
  sourceType: 'connector' | 'upload' | 'crawled';
}
```

### Implementation Details

**DefaultTransport.ts** (~L146-155):

```typescript
case 'response_end':
  return {
    type: 'response_end',
    messageId: (msg.messageId as string) ?? '',
    content: ((msg.fullText ?? msg.text) as string) ?? '',
    voiceConfig: (msg.voiceConfig as VoiceConfig) || undefined,
    richContent: (msg.richContent as RichContent) || undefined,
    actions: (msg.actions as ActionSet) || undefined,
    sourceChannel: (msg.sourceChannel as SourceChannel) || undefined,
    citations: Array.isArray(msg.citations) ? msg.citations : undefined,  // NEW
  };
```

**ChatClient.ts** — in the response_end handler, map `citations` to the Message:

```typescript
const message: Message = {
  id: transportMsg.messageId,
  role: 'assistant',
  content: transportMsg.content,
  timestamp: new Date(),
  citations: transportMsg.citations, // NEW — pass through
  // ... existing fields
};
```

**CitationList.tsx** — new component:

```typescript
interface CitationListProps {
  citations: CitationRef[];
  /** Localized labels — SDK components use useStrings() or accept labels as props */
  labels?: {
    sourcesHeader?: string; // default: "Sources"
    openLink?: string; // default: "Open source"
  };
}

export function CitationList({ citations, labels }: CitationListProps) {
  // IMPORTANT: Use React.createElement (not JSX) — all SDK components follow this pattern
  // Render as a compact footnote list below the message
  // Header: labels?.sourcesHeader ?? "Sources" (with aria-label for a11y)
  // Each citation: [N] Title → clickable link (target="_blank" rel="noopener noreferrer")
  // connector/crawled: opens in new tab directly
  // upload: opens JWT download URL → redirect to S3
  // aria-label on each link: `${labels?.openLink ?? 'Open source'}: ${title}`
  // Validate citation items: filter to typeof index === 'number' && typeof url === 'string'
}
```

Styling uses CSS custom properties (SDK pattern: `var(--sdk-*, fallback)`):

- `--sdk-citation-bg`: background for citation badges
- `--sdk-citation-text`: text color
- `--sdk-citation-hover`: hover state

**MessageList.tsx** (~L124-141) — add after RichContent:

```typescript
if (msg.citations?.length) {
  children.push(React.createElement(CitationList, { key: 'citations', citations: msg.citations }));
}
```

### Subtasks (execution order)

1. ST-5.1: Add `CitationRef` type and `citations?` field to `Message` in `core/types.ts`
2. ST-5.2: Add `citations?` to `TransportServerMessage` response_end in `transport/types.ts`
3. ST-5.3: Forward `citations` in `DefaultTransport.ts` translateMessage
4. ST-5.4: Map `citations` to `Message` in `chat/ChatClient.ts` response_end handler
5. ST-5.5: Create `CitationList.tsx` component with SDK theming
6. ST-5.6: Integrate `CitationList` into `MessageList.tsx`

### Acceptance Criteria

- AC-5.1: Given a `response_end` with `citations[]`, When SDK receives it, Then `Message.citations` is populated
- AC-5.2: Given a message with citations, When rendered, Then clickable citation footnotes appear below content
- AC-5.3: Given a connector citation, When clicked, Then opens SharePoint URL in new tab
- AC-5.4: Given an upload citation, When clicked, Then opens JWT URL → 302 redirect to S3 download
- AC-5.5: Given a `response_end` without citations, When rendered, Then no citation UI appears (backward compatible)
- AC-5.6: CSS custom properties follow existing SDK theming pattern (`var(--sdk-*, fallback)`)

---

## Task T-6: Studio Citation Settings UI

### Files to Modify

- `apps/studio/src/components/search-ai/settings/SettingsPanel.tsx` — add CitationSection
- `apps/studio/src/api/search-ai.ts` — add citation config API methods

### Files to Create

- `apps/studio/src/components/search-ai/settings/CitationSection.tsx` — citation settings form

### Implementation Details

**CitationSection.tsx** — follows existing `GeneralSection`/`IndexConfigSection` patterns:

```typescript
interface CitationSectionProps {
  indexId: string;
  citationConfig: ICitationConfig | null;
  onUpdate: (config: ICitationConfig) => void;
}

export function CitationSection({ indexId, citationConfig, onUpdate }: CitationSectionProps) {
  // Toggle: Enable/disable citations
  // Select: Link mode (direct / time_limited / click_limited / disabled)
  // Number input: TTL in seconds (shown as hours/minutes picker)
  // Number input: Max clicks (only visible when linkMode = 'click_limited')
}
```

Uses existing design-system components:

- `Switch` for enable/disable toggle
- `Select` for link mode dropdown
- `NumberInput` for TTL and max clicks
- `FormField` / `Label` wrappers
- i18n keys under `search_ai.settings.citations.*`

**search-ai.ts API** — add update method:

```typescript
export async function updateCitationConfig(
  indexId: string,
  config: ICitationConfig,
): Promise<void> {
  return apiFetch(`/api/indexes/${indexId}/citation-config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}
```

**Backend route** in `apps/search-ai/src/routes/` — add to existing index routes:

```typescript
// Zod validation schemas
const citationConfigParamsSchema = z.object({
  indexId: z.string().min(1),
});

const citationConfigBodySchema = z.object({
  enabled: z.boolean(),
  linkMode: z.enum(['direct', 'time_limited', 'click_limited', 'disabled']),
  linkTtlSeconds: z.number().int().min(60).max(604800),
  maxClicks: z.number().int().min(1).max(100),
}).strict();

PUT /api/indexes/:indexId/citation-config
  → params = citationConfigParamsSchema.safeParse(req.params)
  → body = citationConfigBodySchema.safeParse(req.body)
  → if (!params.success || !body.success): return 400 { success: false, error: { code: 'VALIDATION_ERROR', message } }
  → SearchIndex.findOneAndUpdate(
      { _id: params.data.indexId, tenantId: req.tenantContext!.tenantId },
      { $set: { citationConfig: body.data } }
    )
  → if (!result): return 404 (index not found — don't leak existence per platform principles)
  → return { success: true }
```

### Subtasks (execution order)

1. ST-6.1: Add `PUT /api/indexes/:indexId/citation-config` route in `apps/search-ai/src/routes/indexes.ts` (or create `citation-config.ts` if indexes.ts is too large; mount in server.ts). Include SWR `mutate()` call in Studio after API success to invalidate cached settings.
2. ST-6.2: Create `CitationSection.tsx` component
3. ST-6.3: Integrate into `SettingsPanel.tsx`
4. ST-6.4: Add i18n keys for citation settings labels
5. ST-6.5: Add `updateCitationConfig` to Studio API client

### Acceptance Criteria

- AC-6.1: Given the settings panel, When user opens it, Then citation section is visible with current config
- AC-6.2: Given citations enabled, When user toggles off, Then `citationConfig.enabled = false` is saved
- AC-6.3: Given link mode = 'click_limited', When rendered, Then max clicks input is visible
- AC-6.4: Given link mode = 'time_limited', When rendered, Then TTL input is visible
- AC-6.5: All strings are i18n'd under `search_ai.settings.citations.*`
