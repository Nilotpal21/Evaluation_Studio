# Web Crawler: Architecture Review, Implementation Gaps & User Journey Analysis

**Document Type**: Architectural review and gap analysis  
**Date**: 2026-03-05  
**Scope**: Website crawling connector — design, implementation, end-user flows, industry problems  
**References**: CRAWLER_ARCHITECTURE_EXPLAINED.md, CRAWLER_UI_GAP_ANALYSIS.md, CRAWLER_UI_FLOWS.md, USER_JOURNEY_AND_ARCHITECTURE.md, SEARCHAI_CRAWLER_PROBLEMS.md, RFC-009 Issues #6/#7, IMPLEMENTATION_STATUS.md

---

## Executive Summary

The platform has a **well-designed** crawler architecture (profiling, strategy resolution, sitemap expansion, hybrid Go/Node pipeline) and **strong documentation** of industry problems (130+ in 21 categories). Several **implementation gaps** and **user-journey gaps** remain: Node↔Go job contract mismatch prevents link-following from being used; UI exposes ~35% of backend capabilities; and some documented flows (e.g. agent-driven, WebSocket transparency) are only partially implemented. This document summarizes industry context, user journeys, what is solved, and concrete gaps with recommendations.

---

## 1. Industry Problems in Website Crawling (Context)

The codebase already captures this in **SEARCHAI_CRAWLER_PROBLEMS.md**. Summary relevant to “are we solving it?”:

| Category                | Representative problems                               | Current platform approach                                                                                                               |
| ----------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Discovery**           | Sitemap detection/parsing, pagination, hidden content | ✅ Sitemap expansion in Node (FastProfiler.extractSitemapUrls); ⚠️ Go link-following exists but not wired (see gap below)               |
| **Content rendering**   | JS/SPA, lazy load, SSR vs CSR                         | ✅ Profiler detects site type; ✅ StrategyResolver maps to browser/bulk/hybrid; ⚠️ Only bulk (Go Colly) path is fully used in main flow |
| **Anti-bot**            | Rate limits, fingerprinting, CAPTCHA                  | ✅ robots.txt, rate limiting in Colly; ⚠️ No proxy rotation / stealth browser in main Studio flow                                       |
| **Access control**      | Login, OAuth, cookies                                 | Documented in problem taxonomy; ❌ No first-class “authenticated website” connector flow in UI                                          |
| **Extraction**          | Content vs boilerplate                                | ✅ Readability + quality metrics in crawler-ingestion                                                                                   |
| **Scale & performance** | Memory, concurrency, politeness                       | ✅ Go worker, BullMQ, limits (maxPages, maxDepth in API)                                                                                |
| **Reliability**         | Retries, timeouts, duplicates                         | ✅ Retry in queues; ✅ content hash dedup in ingestion                                                                                  |

So: the **design** is aligned with industry problems (strategy-based UX, sitemap + link-following, hybrid workers, learning/preferences). The **implementation** partially delivers (sitemap expansion and ingestion pipeline are strong; link-following and UI/agent flows have gaps).

---

## 2. End-User Flows: Documented vs Implemented

### 2.1 Flow: “I want to index one site” (primary Studio flow)

**Documented (CRAWLER_UI_FLOWS.md, CRAWLER_ARCHITECTURE_EXPLAINED.md):**

1. User enters URL → blur triggers profile.
2. Profile returns site type, hasSitemap, estimated size, confidence.
3. Optional: saved preference (e.g. autoDecide) → countdown and auto-submit.
4. Submit → validate → expand from sitemap when applicable → resolve strategy → enqueue job.
5. Go worker crawls URLs; Node ingestion worker cleans, uploads, creates documents, enqueues Docling.
6. User sees progress and history.

**Implemented:**

- ✅ URL input, profile on blur (`CrawlJobForm`, runtime `POST /api/crawler/profile`).
- ✅ Preferences (UserCrawlPreference), autoDecide, countdown.
- ✅ Submit to `POST /api/search-ai/crawl/batch` with strategy/limits.
- ✅ Sitemap expansion in Node (single URL + hasSitemap + useSitemap → `profiler.extractSitemapUrls`; respects maxPages).
- ✅ Strategy resolution (StrategyResolver), decision engine, prompt evaluation, CrawlJob record, BullMQ `static-crawl`.
- ✅ Go worker consumes job, crawls URLs (CrawlBatch or CrawlRecursive if strategy present).
- ✅ Ingestion worker: Readability, S3, SearchDocument, docling-extraction.
- ✅ Progress and history UI (CrawlJobProgress, CrawlJobHistory).

**Gaps:**

- **Link-following not used in practice**: Node sends job with `options: { followLinks, maxPages, maxDepth }`. Go worker expects `strategy: { followLinks, maxPages, maxDepth }` (see `pkg/types/job.go`). So `job.Strategy` is nil and the worker always uses `CrawlBatch`; `CrawlRecursive` is never used. **Gap**: align job payload (Node sends `strategy` in Go’s shape or Go accepts `options` and maps to `Strategy`).
- **UI**: No batch URLs, no explicit strategy selector, no limits (maxPages/maxDepth) in form, no URL expansion preview (see CRAWLER_UI_GAP_ANALYSIS.md).

So for “index one site” we **largely solve it** when the site has a sitemap; we **under-solve** when there is no sitemap (link-following not active due to contract mismatch).

---

### 2.2 Flow: “I want to index multiple sites / many URLs”

**Documented:** Backend accepts 1–1000 URLs per batch; batch operations are a stated capability.

**Implemented:**

- ✅ API accepts `urls: string[]` (validated length, format).
- ❌ UI: single URL input only (CrawlJobForm). No textarea, CSV, or bulk import.

**Gap:** Batch operations are a **critical UI gap** (see CRAWLER_UI_GAP_ANALYSIS Phase 1). Users cannot efficiently submit multiple sites or URL lists from the Studio.

---

### 2.3 Flow: “I want control over scope and cost”

**Documented:** Strategy + limits (maxPages, maxDepth, maxDurationMinutes); strategy-based UX (RFC-009 Issue #7).

**Implemented:**

- ✅ API: strategy (single-page, sitemap, smart, limited, full-site), limits, options (maxPages, maxDepth, etc.).
- ❌ UI: no strategy dropdown, no limit inputs, no cost/size guidance. Strategy and limits come from preferences or backend defaults only.

**Gap:** Power users and cost-conscious users cannot see or adjust scope/cost in the form (high priority in gap analysis).

---

### 2.4 Flow: “I want to see what will be crawled before I start”

**Documented:** URL expansion preview (CRAWLER_UI_FLOWS wireframes), API returns `urlExpansion: { expanded, source, originalCount, expandedCount }`.

**Implemented:**

- ✅ Backend returns urlExpansion in batch response.
- ❌ UI: no preview of expanded URL list, no “show me the URLs” step before submit.

**Gap:** Users can be surprised by scope (e.g. 1 URL → 500 from sitemap); transparency and trust issue.

---

### 2.5 Flow: “I want real-time visibility and learning”

**Documented:** USER_JOURNEY_AND_ARCHITECTURE.md describes WebSocket live events, decision feed, learning/adaptation, and “Active Monitoring User” with real-time dashboard.

**Implemented:**

- ✅ CrawlJob status, timeline, results in DB; progress/history UI.
- ⚠️ WebSocket for crawl progress: RFC review (RFC_CRAWLER_UI_ARCHITECTURAL_REVIEW.md) calls out auth/tenant validation and rate limiting; not confirmed as fully implemented.
- ⚠️ “Learning” is reflected in UserCrawlPreference and decision engine; no separate “learning dashboard” or event log UI.

**Gap:** Real-time visibility and “transparency feed” are only partially implemented relative to the documented vision.

---

### 2.6 Flow: “Agent-driven crawl” (MCP + ABL)

**Documented:** SEARCHAI_AGENT_DRIVEN_CRAWLER, USER_JOURNEY_AND_ARCHITECTURE: agent uses MCP tools for discovery and decisions; bulk work delegated to Go/Playwright workers.

**Implemented:**

- ✅ MCP server (crawler-mcp-server) with 11 tools; Go worker (Colly + CrawlRecursive); batch API.
- ⚠️ IMPLEMENTATION_STATUS.md still lists “Integrate with apps/search-ai API”, “Add /api/crawl endpoint”, “Agent + MCP integration” as remaining. Main Studio path uses direct submit to batch API + Go worker, not an ABL agent in the loop.

**Gap:** Agent-driven flow is built in pieces (MCP, Go, API) but the **orchestrated “agent decides then delegates”** path for the standard Studio user is not clearly the default; documentation may overstate current end-to-end agent involvement.

---

### 2.7 Flow: “Authenticated / behind-login site”

**Documented:** SEARCHAI_CRAWLER_PROBLEMS (access control, OAuth, cookies); connector base (e.g. SharePoint) has auth patterns.

**Implemented:**

- ❌ No website-specific “authenticated crawl” flow in crawler UI (no cookie/auth config, no “website connector” with credentials). Connector framework exists for other sources, not for “website with login”.

**Gap:** Authenticated website use case is not solved in the current website crawler connector.

---

## 3. Implementation Gaps (Concise)

### 3.1 Critical: Node ↔ Go job contract (link-following)

- **Where:** `apps/search-ai/src/routes/crawl.ts` (queue.add payload) vs `apps/crawler-go-worker/pkg/types/job.go` and `internal/processor/processor.go`.
- **What:** Node sends `options: { followLinks, maxPages, maxDepth, ... }`. Go expects `strategy: { followLinks, maxPages, maxDepth, sameDomainOnly }`. Unmarshal leaves `job.Strategy == nil`, so processor always uses `CrawlBatch`, never `CrawlRecursive`.
- **Fix:** Either (a) Node adds a `strategy` object matching `CrawlStrategy` (followLinks, maxPages, maxDepth, sameDomainOnly) to the job payload, or (b) Go accepts an `options`-shaped payload and builds `Strategy` from it before calling the processor. Prefer (a) for a single source of truth.

### 3.2 Critical: UI — batch URLs, limits, strategy, expansion preview

- **Where:** `apps/studio/src/components/search-ai/` (CrawlJobForm, etc.).
- **What:** Single URL only; no strategy selector; no maxPages/maxDepth/maxDuration; no URL expansion preview; no quality metrics in history (see CRAWLER_UI_GAP_ANALYSIS.md).
- **Fix:** Implement Phase 1 (batch URL input, limits, URL expansion preview) and Phase 2 (strategy selection, discovery toggles, quality display) per that document.

### 3.3 High: Sitemap expansion only for single URL

- **Where:** `apps/search-ai/src/routes/crawl.ts` (condition `urls.length === 1 && profile.metadata.hasSitemap && ...`).
- **What:** Multiple seed URLs do not get per-URL sitemap expansion. Acceptable for “one site” but limits “multi-site with sitemaps” without manual URL lists.
- **Fix:** Consider expanding when multiple URLs share the same origin or when strategy is “sitemap”/“smart” and profile supports it (with clear limits and UX).

### 3.4 Medium: WebSocket / profile security and rate limiting

- **Where:** Crawl WebSocket and profile endpoint (if present).
- **What:** RFC_CRAWLER_UI_ARCHITECTURAL_REVIEW.md requires WebSocket auth/tenant validation and profile rate limiting.
- **Fix:** Implement auth/tenant checks for crawl WebSocket; add rate limiting for profile (e.g. per user/tenant).

### 3.5 Medium: Agent-driven path vs “direct API + workers”

- **Where:** Documentation vs actual Studio flow.
- **What:** Docs describe agent-driven discovery and delegation; production flow is “form → batch API → Go worker” without an ABL agent in the loop for the standard user.
- **Fix:** Either (a) document the current “API-first” flow as primary and agent as advanced/optional, or (b) implement the agent-driven path as the default and wire Studio to it.

### 3.6 Lower: Authenticated website connector

- **Where:** Product/connector scope.
- **What:** No first-class “crawl with login/cookies” for generic websites.
- **Fix:** Roadmap: either a “website connector” with credential storage and cookie/auth injection, or explicit “not in scope” and point to SharePoint/other connectors for authenticated content.

---

## 4. User Journey Summary Table

| Journey                                   | Documented    | Backend                 | UI                          | Verdict                   |
| ----------------------------------------- | ------------- | ----------------------- | --------------------------- | ------------------------- |
| Index one site (with sitemap)             | Yes           | Yes (sitemap expansion) | Partial (no preview/limits) | **Largely solved**        |
| Index one site (no sitemap, follow links) | Yes           | Go has CrawlRecursive   | —                           | **Broken** (job contract) |
| Index many URLs/sites                     | Yes           | Yes                     | No (single URL only)        | **Gap**                   |
| Control scope/cost                        | Yes           | Yes                     | No                          | **Gap**                   |
| See URLs before crawl                     | Yes           | Yes (urlExpansion)      | No                          | **Gap**                   |
| Real-time / learning UX                   | Yes           | Partial                 | Partial                     | **Partial**               |
| Agent-driven crawl                        | Yes           | Pieces exist            | Not default                 | **Partial**               |
| Authenticated website                     | Problem known | No                      | No                          | **Not solved**            |

---

## 5. Recommendations (Prioritized)

1. **Fix Node→Go job contract** so `strategy` (or equivalent) is passed and Go uses CrawlRecursive when followLinks is true. Unblocks “one site without sitemap” and matches documented behavior.
2. **Implement UI Phase 1** (batch URLs, limits, URL expansion preview) from CRAWLER_UI_GAP_ANALYSIS.md to match backend and reduce “surprise scope” and support multi-site.
3. **Implement UI Phase 2** (strategy selector, discovery options, quality in history) for control and transparency.
4. **Harden WebSocket and profile** (auth, tenant, rate limit) per RFC review.
5. **Clarify docs** so “agent-driven” vs “API + workers” flow is accurate; either implement agent as default or document API-first as primary.
6. **Roadmap**: authenticated website connector or explicit out-of-scope statement.

---

## 6. References

- **Architecture & flow:** CRAWLER_ARCHITECTURE_EXPLAINED.md, USER_JOURNEY_AND_ARCHITECTURE.md
- **Problems:** SEARCHAI_CRAWLER_PROBLEMS.md
- **UI design & gaps:** CRAWLER_UI_FLOWS.md, CRAWLER_UI_GAP_ANALYSIS.md, CRAWLER_UI_DESIGN_PROPOSAL.md
- **RFCs:** RFC-009 Issue #6 (sitemap/link-following), Issue #7 (strategy UX), RFC_CRAWLER_UI_ARCHITECTURAL_REVIEW.md
- **Implementation:** IMPLEMENTATION_STATUS.md, apps/search-ai/src/routes/crawl.ts, apps/crawler-go-worker (processor, types, queue)

---

_This review reflects the codebase and docs as of 2026-03-05. Implementation details (e.g. exact field names in queue payload) should be re-checked when applying fixes._
