# Search Citations — High-Level Design

## What

Enable inline citations in search-powered agent answers so end users can trace every claim back to its source document. For **connector sources** (SharePoint, Google Drive, etc.), the citation links to the original platform URL (user authenticates via their own SSO). For **file uploads**, the platform generates time-limited and/or click-limited secure download URLs. An **admin settings panel** lets tenant admins configure citation behavior per knowledge base: enable/disable citations, set link expiry TTL, set max click count, or turn off secure links entirely.

## Current State & Gap Analysis

### URL Storage Reality (verified against actual code)

`canonical.source_url` in OpenSearch **always contains the internal S3/local storage URL**, not the user-navigable URL. The `buildDefaultCanonicalFields()` function (canonical-mapper-worker.ts L260) always prefers `document.sourceUrl` (the S3 key) over `document.originalReference` (the user-navigable URL). The `fixedMappings` in `connector-type-templates.ts` (e.g., `sharepoint.itemWebUrl → source_url`) are **hint-only for the mapping UI** — they do NOT execute at runtime unless a user manually creates `FieldMapping` records.

| Source Type      | `SearchDocument.sourceUrl`                           | `SearchDocument.originalReference`            | `canonical.source_url` | User-Navigable? |
| ---------------- | ---------------------------------------------------- | --------------------------------------------- | ---------------------- | --------------- |
| **SharePoint**   | `s3://bucket/tenant/source/doc/file.pdf`             | `https://contoso.sharepoint.com/.../file.pdf` | S3 URL                 | **NO**          |
| **File Upload**  | `s3://bucket/documents/tenant/index/ts.pdf`          | `report.pdf` (filename only)                  | S3 URL                 | **NO**          |
| **Crawled Page** | `s3://bucket/crawler/cleaned/tenant/index/hash.html` | `https://docs.example.com/page`               | S3 URL                 | **NO**          |

**Key insight**: The user-navigable URL is in `SearchDocument.originalReference` (MongoDB) but NOT in OpenSearch. For connectors and crawlers, `originalReference` holds the source URL. For file uploads, it holds just the filename.

### Gaps at query time and answer generation

1. `query-pipeline.ts:999` has `reference: undefined` (explicit TODO) — and `canonical.source_url` from OpenSearch is an S3 URL anyway
2. `formatResult()` strips all metadata — only `title` + `content` survive to the LLM
3. The lean synthesis prompt has no citation instructions
4. `response_end` WebSocket message has no citations field
5. Web SDK `Message` type has no citations field
6. No admin settings for citation configuration exist
7. **No user-navigable URL available at query time** — requires MongoDB lookup of `originalReference`

## Architecture Approach

### Packages That Change

| Package                  | Change                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/search-ai-runtime` | Enrich search results with user-navigable URLs via MongoDB `originalReference` lookup; populate `SourceAttribution.reference`                |
| `apps/search-ai`         | New citation settings on SearchIndex model; secure download URL endpoint for file uploads; fix `buildDefaultCanonicalFields` for future docs |
| `apps/runtime`           | Preserve citations in `formatResult()`; add citation instructions to synthesis prompt; extract citation map; attach to `response_end`        |
| `packages/web-sdk`       | Add `citations` field to `TransportServerMessage.response_end` and `Message`; render citation UI                                             |
| `apps/studio`            | Citation settings UI in SearchAI settings panel                                                                                              |
| `packages/database`      | Citation config schema on SearchIndex model                                                                                                  |
| `packages/search-ai-sdk` | Populate `SourceAttribution.reference` (type already exists)                                                                                 |

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         INDEXING (current state)                           │
│                                                                            │
│  Connector/Upload → SourceDocument.url → SearchDocument.sourceUrl (S3)    │
│                   → SearchDocument.originalReference (user-navigable URL)  │
│       → canonical-mapper → OpenSearch metadata.canonical.source_url (S3!) │
│                                                                            │
│  FIX: buildDefaultCanonicalFields() will prefer originalReference when    │
│  it starts with http(s):// — fixes future docs. Existing docs use the    │
│  MongoDB lookup path below.                                               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        QUERY TIME (new wiring)                             │
│                                                                            │
│  User Query                                                                │
│    → search-ai-runtime query-pipeline                                      │
│       → OpenSearch returns hits with metadata.sys.documentId               │
│       → MongoDB batch lookup: SearchDocument.find({                        │
│           _id: { $in: documentIds }, tenantId                              │
│         }).select('originalReference sourceType')  ◄── NEW                │
│       → populate SourceAttribution.reference from originalReference        │
│    → runtime formatResult()                                                │
│       → include { title, content, sourceUrl, documentId } ◄── NEW         │
│    → lean synthesis prompt                                                 │
│       → "Cite sources as [1], [2]..." instruction ◄── NEW                 │
│    → LLM generates answer with inline [1], [2] markers                    │
│    → runtime extracts citation map from formatted results                  │
│    → response_end { fullText, citations: [...] } ◄── NEW                  │
│    → Web SDK renders answer + clickable citation footnotes ◄── NEW        │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                     FILE UPLOAD URL RESOLUTION (self-signed)               │
│                                                                            │
│  AT RESPONSE TIME (runtime generates citation URLs):                       │
│    Connector source → direct URL: "https://sharepoint.com/file"            │
│      (validated: must start with https://)                                 │
│    File upload → signed URL: /api/citations/:jwt                           │
│      JWT = purposeJwt.sign({                                              │
│        aud: 'citation-download', sub: docId, tenantId,                    │
│        sourceKey: 's3://...', jti: uuid, exp: TTL from settings           │
│      })                                                                    │
│                                                                            │
│  ON CLICK (no platform auth needed — JWT IS the auth):                    │
│    GET /api/citations/:jwt  (IP rate-limited)                             │
│      → verify JWT signature + audience + expiry                            │
│      → if click-limited: Redis DECRBY citation:{jti} 1                    │
│      → getDownloadUrlForTenant(tenantId, sourceKey, 900)                  │
│        ↳ assertTenantOwnsPath() — tenant isolation on S3 key              │
│      → 302 redirect to presigned S3 URL (15 min TTL)                      │
│                                                                            │
│  Works from ALL channels (web, Slack, Telegram, email, REST)              │
│  No platform auth required — signed token IS the authorization            │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                     ADMIN SETTINGS                                         │
│                                                                            │
│  Studio Settings Panel → SearchIndex.citationConfig                        │
│    → enabled: boolean (default: true)                                      │
│    → linkMode: 'direct' | 'time_limited' | 'click_limited' | 'disabled'   │
│    → linkTtlSeconds: number (default: 3600, 1 hour)                       │
│    → maxClicks: number (default: 5)                                        │
│  Settings propagated to runtime via discovery manifest                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Integration Points

1. **query-pipeline → MongoDB enrichment**: After OpenSearch returns hits, batch-lookup `SearchDocument.originalReference` by documentId+tenantId. Populate `SourceAttribution.reference` with the user-navigable URL. For file uploads (where `originalReference` is just a filename), set a placeholder marker like `upload://{documentId}` that the runtime resolves via the download endpoint.
2. **query-pipeline → formatResult()**: `SourceAttribution.reference` now carries the URL; `formatResult()` passes it through as `sourceUrl` per result.
3. **formatResult() → synthesis prompt**: LLM receives source URLs and is instructed to cite them as `[1]`, `[2]`, etc. (URLs not passed to LLM — only titles and position numbers to save tokens).
4. **LLM response → response_end**: Runtime extracts the citation index-to-URL map from `formatResult()` output, attaches as `citations[]` on `response_end`.
5. **response_end → Web SDK**: SDK `DefaultTransport` maps `citations` to `Message.citations`; `MessageList` renders clickable citation footnotes.
6. **Citation click → search-ai**: For file uploads, a new endpoint generates secure time/click-limited URLs. For connectors, the original URL is used directly (no platform intermediary needed — user authenticates via their own SSO).
7. **Discovery manifest → runtime**: Citation settings from `SearchIndex.citationConfig` are included in the discovery manifest so the runtime knows whether to enable citation generation.

## Decisions & Tradeoffs

### D-1: Inline `[N]` markers vs structured citation blocks

**Chose**: Inline `[N]` markers in LLM text + structured `citations[]` array on `response_end`
**Over**: Pure structured blocks (no inline markers) or markdown footnotes
**Because**: Inline markers are natural for LLMs to generate, already supported by Slack/Telegram stream buffers (`PARTIAL_CITATION_RE`), and allow precise claim-to-source mapping. The structured array provides the URL/title data needed for rendering.

### D-2: Purpose-scoped JWT citation tokens for file uploads

**Chose**: Purpose-scoped JWT tokens (via existing `purpose-jwt.ts` pattern) generated at response time; exchanged for presigned S3 URLs on-click via a public (no-auth) endpoint with IP-based rate limiting
**Over**: (a) Raw HMAC tokens (JWT gives expiry/audience/issuer for free), (b) Authenticated download endpoint (end-users in Slack/Telegram/web widget don't have platform auth), (c) Pre-generating S3 presigned URLs at response time (they expire before user might click)
**Because**: Purpose-scoped JWT reuses proven `purpose-jwt.ts` infrastructure (same pattern as feedback tokens). Works from ALL channels without platform auth. Token encodes `tenantId` + `documentId` + `sourceKey` + `exp` + `jti` (for click tracking). `getDownloadUrlForTenant()` enforces tenant path isolation on S3 presigned URL generation. Connector URLs go directly to original source — no token needed.

**Security properties**:

- Token is self-authenticating (JWT signature = proof of platform origin)
- Tenant isolation via `assertTenantOwnsPath()` on S3 key
- Click limits enforced via Redis `DECRBY` keyed by `jti`
- Short presigned URL TTL (15 min) — generated on-click, not at response time
- IP-based rate limiting on public endpoint (falls back from `tenantRateLimit`)
- Connector URLs validated to start with `https://` before inclusion

### D-3: Click-limited URLs via Redis counter vs database

**Chose**: Redis `DECRBY` with TTL for click tracking
**Over**: MongoDB document for each click-limited link
**Because**: Click counters are ephemeral (expire with the link), high-frequency (every click), and need atomic decrement. Redis is the natural fit. Falls back gracefully if Redis is unavailable (link still works, just not click-limited).

### D-4: Citation settings on SearchIndex vs KnowledgeBase

**Chose**: `SearchIndex.citationConfig` (index-level)
**Over**: Per-KB or per-tenant settings
**Because**: The search index is the operational unit for query-time behavior. The discovery manifest already propagates index-level config to runtime. Per-KB would require merging configs at query time across multi-KB searches.

### D-5: LLM citation extraction approach

**Chose**: Positional mapping — results are numbered 1..N in the tool result, LLM uses `[1]`..`[N]`, runtime maps index to source
**Over**: Asking LLM to embed full URLs inline
**Because**: URLs waste tokens, LLMs sometimes hallucinate URLs, and positional mapping is deterministic. The `[doc-N]` pattern is already handled by channel stream buffers.

### D-6: User-navigable URL resolution strategy

**Chose**: MongoDB batch lookup of `SearchDocument.originalReference` at query time + fix `buildDefaultCanonicalFields()` for future documents
**Over**: (a) Only reading `canonical.source_url` from OpenSearch (it's an S3 URL — not navigable), (b) Adding a new OpenSearch field (requires mapping change + reindex), (c) Only fixing the canonical mapper (doesn't help existing documents)
**Because**: `originalReference` already contains the correct user-navigable URL for connectors (`https://contoso.sharepoint.com/...`) and crawled pages (`https://docs.example.com/...`). A single `find({ _id: { $in: docIds }, tenantId })` with `.select('originalReference sourceType')` adds <5ms for 10 results. Fixing the canonical mapper ensures future documents get the right URL without the lookup.

### D-7: SharePoint URL handling

**Chose**: Direct passthrough of `item.webUrl` — no platform proxy
**Over**: Downloading and re-serving SharePoint content through platform
**Because**: User said "SharePoint URL requires the user to be logged in to SharePoint, so we don't have to download these files but just keep the valid URL." This avoids storage costs, permission complexity, and keeps the user's SharePoint auth boundary intact.

## Task Decomposition

| Task | Package(s)                                         | Independent?        | Est. Files | Description                                                                                                                     |
| ---- | -------------------------------------------------- | ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| T-1  | `apps/search-ai-runtime`, `packages/search-ai-sdk` | Yes                 | 2-3        | Enrich query results with user-navigable URLs via MongoDB `originalReference` lookup; populate `SourceAttribution.reference`    |
| T-2  | `packages/database`, `apps/search-ai`              | Yes                 | 3-4        | Add `citationConfig` schema to SearchIndex; propagate via discovery manifest; fix `buildDefaultCanonicalFields` for future docs |
| T-3  | `apps/runtime`                                     | Depends on T-1      | 3-4        | Preserve citations in `formatResult()`; add citation prompt instructions; extract citation map; attach to `response_end`        |
| T-4  | `apps/search-ai`                                   | Depends on T-2      | 2-3        | Self-signed citation URL generation (purpose-scoped JWT tokens) + public redirect endpoint with TTL/click-limit enforcement     |
| T-5  | `packages/web-sdk`                                 | Depends on T-3      | 3-4        | Add `citations` to transport types + `Message`; render citation footnotes in `MessageList`                                      |
| T-6  | `apps/studio`                                      | Depends on T-2, T-5 | 2-3        | Citation settings UI in SearchAI settings panel                                                                                 |

## Out of Scope

- **Perplexity-style web search citations** — separate feature using model-native citation support (already has `return_citations` hyper-parameter)
- **Citation analytics/tracking dashboard** — can be added later on top of the click-tracking Redis data
- **Per-chunk citations** — citations are per-document, not per-chunk (a document may have multiple chunks that contribute to the answer)
- **Citation in non-search answers** — only search-powered KB answers get citations; direct LLM responses without search do not
- **Retroactive citation for existing answers** — only new answers after deployment get citations
- **Citation rendering in email/SMS channels** — email/SMS get plain text citations ("Source: Title") without clickable links; web/Slack/Telegram get clickable links
- **Channel-specific citation formatting** — Slack and Telegram adapters already handle `[doc-N]` patterns via `PARTIAL_CITATION_RE`; formatting citations as Slack mrkdwn or Telegram markdown is a follow-on enhancement
