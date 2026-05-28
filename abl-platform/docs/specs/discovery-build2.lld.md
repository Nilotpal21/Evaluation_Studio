# Discovery Build 2 (UI End-to-End) — Low-Level Design

> **Ticket**: ABLP-71
> **HLD**: `docs/specs/unified-discovery-redesign.hld.md`
> **Build 1 LLD**: `docs/specs/discovery-build1.lld.md`
> **Implementation Plan**: `docs/searchai/design/DISCOVERY-IMPLEMENTATION.md`
> **Date**: 2026-05-10

---

## Context

Build 1 (Engine + Wiring) is complete — 7 commits on develop. It created:

- BFS discovery engine (`bfs-discovery.ts`)
- SiteDiscovery + TenantDiscovery models
- 7 API routes in `apps/search-ai/src/routes/discovery.ts`
- BFS REST endpoints in `apps/crawler-mcp-server/src/server.ts`

Build 2 wires the Studio frontend to the new Build 1 APIs. The old backend
endpoints (`crawl-discover.ts`, `crawl-browser-discover.ts`) were deleted in
Build 1 Wave 0. Old frontend components that called them are now broken.

### HLD Deviation — Build 1 Supersedes Frontend-Only Scope

The original HLD (`docs/specs/unified-discovery-redesign.hld.md`) states:

- D2: "frontend-only — zero backend changes"
- D6: "No new backend endpoints"

**These decisions are superseded by Build 1**, which replaced the entire backend:

- Deleted `crawl-discover.ts` and `crawl-browser-discover.ts` (old discovery routes)
- Created `apps/search-ai/src/routes/discovery.ts` with 7 new API routes
- Created BFS engine in `apps/crawler-mcp-server/src/explore/bfs-discovery.ts`
- Added `SiteDiscovery` and `TenantDiscovery` Mongoose models

Build 2 therefore operates against a **different backend than the HLD assumed**.
The HLD's architectural approach (data flow, integration points) remains valid —
only the "no backend changes" scope constraint is superseded.

### Plan Deviation from DISCOVERY-IMPLEMENTATION.md

The implementation plan lists 4 new components for Build 2: `ModeSelection.tsx`,
`SeedSelection.tsx`, `LiveDiscoveryTree.tsx`, `DiscoverySelection.tsx`. This LLD
consolidates them into a single `UnifiedDiscoveryPanel` rewrite because:

1. **ModeSelection** (Sitemap/Discovery/Direct URLs) — already handled by `StrategySelector`
   in State2Analysis. No new component needed.
2. **SeedSelection** (nav checkboxes + target URL inputs) — the BFS engine uses the seeds
   from `POST /discovery/start` (primaryUrl + sampleUrls). The existing `SampleUrlInput`
   component + URL entry already provides this. Nav section selection is deferred to Build 3
   (requires nav extraction API from the BFS engine, not yet exposed to frontend).
3. **LiveDiscoveryTree** — this IS what the rewritten `UnifiedDiscoveryPanel` renders during
   discovery. The updated `UnifiedTree` component fills this role.
4. **DiscoverySelection** — post-discovery selection is handled by `UnifiedTree` in `select`
   mode with checkboxes.

**Action:** Update `docs/searchai/design/DISCOVERY-IMPLEMENTATION.md` Build 2 table to
reflect this consolidation during implementation.

### Build-vs-Update Analysis

| Component                     | Lines | Decision           | Reasoning                                                                                         |
| ----------------------------- | ----- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `ExplorePanel.tsx`            | 1,222 | **DELETE**         | Calls deleted old HTTP discover API. Zero reusable code.                                          |
| `DiscoveryPanel.tsx`          | 1,018 | **DELETE**         | Manages OLD `DiscoveryTreeNode` tree via refs. Dead.                                              |
| `BrowserDiscoveryInline.tsx`  | 587   | **DELETE**         | Calls deleted `startBrowserExplore` API. SSE patterns extracted into `useDiscovery` hook.         |
| `DiscoveryTree.tsx`           | 812   | **DELETE**         | OLD model. Already replaced by UnifiedTree.                                                       |
| `DiscoveryConsole.tsx`        | —     | **DELETE**         | Only consumer is DiscoveryPanel (being deleted).                                                  |
| `DecisionCards.tsx`           | —     | **DELETE**         | Only consumer is DiscoveryPanel (being deleted).                                                  |
| `discovery/console-utils.ts`  | —     | **DELETE**         | Only consumer is DiscoveryConsole (being deleted).                                                |
| `discovery/decision-utils.ts` | —     | **DELETE**         | Only consumer is DecisionCards (being deleted).                                                   |
| `DiscoveryTimeline.tsx`       | —     | **DELETE**         | Zero importers — orphaned component.                                                              |
| `UnifiedDiscoveryPanel.tsx`   | 456   | **REWRITE**        | Right concept but calls old APIs via old sub-components. Rewrite to use new `useDiscovery` hook.  |
| `UnifiedTree.tsx`             | 356   | **UPDATE**         | Good foundation. Add: checkbox selection, bulk select, shift-click.                               |
| `UnifiedTreeNodeRow.tsx`      | 312   | **UPDATE**         | Good visual. Add: checkbox binding, status badges for BFS events.                                 |
| `UnifiedTreeHeader.tsx`       | 182   | **UPDATE**         | Just needs checkbox-aware stats.                                                                  |
| `unified-tree-types.ts`       | 128   | **UPDATE**         | Add BFS-specific fields: `renderMethod`, `visited`, `foundOn`.                                    |
| `tree-merge.ts`               | 376   | **UPDATE**         | Add: `mergeBfsTreeUpdate()`, `mergeBfsPageVisit()`, bulk toggle.                                  |
| `tree-to-sections.ts`         | 95    | **UPDATE**         | Add `strategy` based on `renderMethod`.                                                           |
| `tree-utils.ts`               | 552   | **DELETE**         | OLD model. No consumers after old component deletion.                                             |
| `State2Analysis.tsx`          | 1,907 | **UPDATE**         | Remove old panel mounts, wire UnifiedDiscoveryPanel with new hook.                                |
| `CrawlFlowV5.tsx`             | 1,095 | **MINIMAL UPDATE** | Discovery integration is via State2Analysis.                                                      |
| `useNodeExplore.ts`           | 135   | **DELETE**         | Calls deleted `startNodeExplore` / `connectNodeExploreProgress` APIs. Replaced by `useDiscovery`. |

---

## Task T-0: Delete Dead Code (Wave 4 — LAST)

> **IMPORTANT**: This task runs LAST (Wave 4), not first. The ADD → REPLACE → DELETE
> order ensures the build passes at every wave. Files listed here have live consumers
> in `UnifiedDiscoveryPanel.tsx` — those consumers are removed in T-4 (Wave 3).

### Group A — Safe to delete immediately (zero live consumers outside deletion set)

These files have NO live importers outside the deletion set. They can be deleted
as soon as T-4 and T-6 have rewritten the components that imported them.

| File                                                                             | Lines | Why Dead                                                                          |
| -------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/crawl-flow/ExplorePanel.tsx`               | 1,222 | Calls deleted `startDiscoverCrawl`, `connectDiscoverProgress` APIs                |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoveryPanel.tsx`             | 1,018 | Manages OLD `DiscoveryTreeNode` tree. Only consumer was `BrowserDiscoveryInline`. |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoveryTree.tsx`              | 812   | OLD model tree renderer. Replaced by `UnifiedTree`.                               |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoveryConsole.tsx`           | —     | Only consumer is `DiscoveryPanel.tsx` (being deleted)                             |
| `apps/studio/src/components/search-ai/crawl-flow/DecisionCards.tsx`              | —     | Only consumer is `DiscoveryPanel.tsx` (being deleted)                             |
| `apps/studio/src/components/search-ai/crawl-flow/DiscoveryTimeline.tsx`          | —     | Zero importers anywhere — orphaned component                                      |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/console-utils.ts`     | —     | Only consumer is `DiscoveryConsole.tsx` (being deleted)                           |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/decision-utils.ts`    | —     | Only consumer is `DecisionCards.tsx` (being deleted)                              |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/reason-utils.ts`      | —     | Only consumer is `console-utils.ts` (being deleted). Transitively dead.           |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/scope-utils.ts`       | —     | Only consumer is `DiscoveryPanel.tsx` (being deleted). Transitively dead.         |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/crawl-queue-utils.ts` | —     | Only consumer is `DiscoveryPanel.tsx` (being deleted). Transitively dead.         |

### Group B — Delete ONLY after T-4 rewrites UnifiedDiscoveryPanel

These files have a live consumer (`UnifiedDiscoveryPanel.tsx`) that is rewritten
in T-4. They MUST NOT be deleted until T-4 is complete.

| File                                                                         | Lines | Why Dead (after T-4)                                                       | Live Consumer (blocks deletion)                |
| ---------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| `apps/studio/src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx` | 587   | Calls deleted `startBrowserExplore` APIs. Replaced by `useDiscovery` hook. | `UnifiedDiscoveryPanel.tsx` line 22 imports it |
| `apps/studio/src/hooks/useNodeExplore.ts`                                    | 135   | Calls deleted `startNodeExplore` APIs. Replaced by `useDiscovery` hook.    | `UnifiedDiscoveryPanel.tsx` line 24 imports it |

### NOT deleted — has live consumers outside Build 2

| File                                                                          | Why KEPT                                                                            |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/tree-utils.ts`     | `coverage-utils.ts` imports `flattenTree` → `BatchPreviewPanel` → `State3Configure` |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/coverage-utils.ts` | `pickPreviewUrls` used by `BatchPreviewPanel.tsx` → `State3Configure.tsx` (LIVE)    |
| `apps/studio/src/components/search-ai/crawl-flow/discovery/url-set.ts`        | Used by `coverage-utils` and `BrowserDiscoveryInline` (coverage-utils is live)      |

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/discovery/index.ts` — Remove exports of deleted utilities.
  Keep exports of: `tree-utils` (live via coverage-utils), `coverage-utils` (live via BatchPreviewPanel),
  `url-set` (live via coverage-utils). Remove: `console-utils`, `decision-utils`, `reason-utils`,
  `scope-utils`, `crawl-queue-utils`.

### Verification Before Delete

```bash
# Confirm no imports outside the deletion set for Group A files
grep -r "ExplorePanel\|DiscoveryPanel\b\|DiscoveryTree\b\|DiscoveryConsole\|DecisionCards\|DiscoveryTimeline\|console-utils\|decision-utils\|reason-utils\|scope-utils\|crawl-queue-utils" \
  apps/studio/src/ --include="*.ts" --include="*.tsx" \
  | grep -v "__tests__\|.test.\|ExplorePanel.tsx\|DiscoveryPanel.tsx\|DiscoveryTree.tsx\|DiscoveryConsole.tsx\|DecisionCards.tsx\|DiscoveryTimeline.tsx\|console-utils.ts\|decision-utils.ts\|reason-utils.ts\|scope-utils.ts\|crawl-queue-utils.ts"

# Confirm Group B files (BrowserDiscoveryInline, useNodeExplore) are only imported
# by UnifiedDiscoveryPanel.tsx (which was rewritten in T-4)
grep -r "BrowserDiscoveryInline\|useNodeExplore" \
  apps/studio/src/ --include="*.ts" --include="*.tsx" \
  | grep -v "__tests__\|.test.\|BrowserDiscoveryInline.tsx\|useNodeExplore.ts"
```

Expected: Group B grep should return ZERO results after T-4 rewrites UnifiedDiscoveryPanel.

### Subtasks

1. ST-0.1: Verify no external consumers via grep (both Group A and Group B)
2. ST-0.2: Delete all Group A files (11 files)
3. ST-0.3: Delete all Group B files (2 files) — only after verifying T-4 removed their imports
4. ST-0.4: Update `discovery/index.ts` barrel — remove exports of deleted utilities
5. ST-0.5: Delete corresponding test files in `discovery/__tests__/` that test deleted utilities
6. ST-0.6: `pnpm build --filter=studio` — verify zero type errors

### Acceptance Criteria

- AC-1: All 13 dead files deleted (11 Group A + 2 Group B). No dangling imports.
- AC-2: `tree-utils.ts`, `coverage-utils.ts`, `url-set.ts` are KEPT (live consumers)
- AC-3: `pnpm build --filter=studio` succeeds
- AC-4: Barrel `index.ts` only exports live utilities

---

## Task T-1: API Client + Types

### Files to Create

- `apps/studio/src/api/discovery.ts` — API client for the 7 Build 1 endpoints

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/discovery/unified-tree-types.ts` — Add BFS fields

### API Client Design

```typescript
// apps/studio/src/api/discovery.ts

import { apiFetch, authHeaders, handleResponse } from '../lib/api-client';

// ─── Types ──────────────────────────────────────────────────────────

export interface DiscoverySeed {
  type: 'nav-section' | 'target-url';
  url: string;
  label?: string;
}

export interface StartDiscoveryRequest {
  primaryUrl: string;
  sampleUrls?: string[];
  /** At least 1 seed required — backend validates min(1), max(20).
   * Callers must ensure non-empty before sending. */
  seeds: DiscoverySeed[];
  maxDepth?: number;
  sourceId?: string;
}

export interface StartDiscoveryResponse {
  discoveryId: string;
  tenantDiscoveryId: string;
  domain: string;
  streamUrl: string;
}

export interface DiscoverMoreRequest {
  type: 'explore-branch' | 'explore-all';
  url: string;
}

export interface SelectUrlsRequest {
  selectedUrls: string[];
  selectionPatterns?: string[];
}

/** BFS SSE event types — mirrors BfsProgressEvent union from bfs-discovery.ts exactly.
 * IMPORTANT: These narrow unions MUST match the backend types. If the backend adds
 * a new phase/status/level/stoppedBy value, update here too. */
export type BfsSSEEvent =
  | { type: 'phase'; phase: 0 | '1a' | '1b' | 2 | 3; label: string; timestamp: number }
  | {
      type: 'page-visit';
      url: string;
      status: 'visiting' | 'visited' | 'error';
      linksFound: number;
      newLinksFound: number;
      pageRole?: 'hub' | 'leaf' | 'mixed';
      renderMethod?: 'http' | 'browser' | 'unknown';
      errorMessage?: string;
      timestamp: number;
    }
  | { type: 'url-discovered'; url: string; foundOn: string; timestamp: number }
  | {
      type: 'tree-update';
      totalUrls: number;
      totalVisited: number;
      newNodes: Array<{ url: string; label: string; parentUrl: string | null; depth: number }>;
      timestamp: number;
    }
  | { type: 'activity'; message: string; level: 'info' | 'warn' | 'detail'; timestamp: number }
  | {
      type: 'complete';
      totalUrls: number;
      totalVisited: number;
      totalPhasesRun: number;
      durationMs: number;
      stoppedBy: 'exhausted' | 'user-stop' | 'yield-limit' | 'url-cap';
      timestamp: number;
    }
  | { type: 'error'; message: string; phase?: string; timestamp: number };

/** Discovered page from BFS engine — stored in SiteDiscovery.discoveredUrls */
export interface BfsDiscoveredPage {
  url: string;
  foundOn: string[];
  renderMethod: 'http' | 'browser' | 'unknown';
  visited: boolean;
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  childUrls: string[];
  title?: string;
  pageRole?: 'hub' | 'leaf' | 'mixed';
  errorMessage?: string;
}

/** Tree node from BFS engine — stored in SiteDiscovery.treeHierarchy */
export interface BfsTreeNode {
  url: string;
  label: string;
  children: BfsTreeNode[];
  depth: number;
}

export interface DiscoveryTreeResponse {
  site: {
    domain: string;
    navStructure: Array<{ label: string; href?: string; children: unknown[]; source: string }>;
    discoveredUrls: BfsDiscoveredPage[];
    treeHierarchy: BfsTreeNode[];
    siteProfile: Record<string, unknown>;
  } | null;
  tenant: {
    discoveryId: string;
    tenantId: string;
    domain: string;
    seedsUsed: DiscoverySeed[];
    selectedUrls: string[];
    selectionPatterns: string[];
    status: string;
  };
}

// ─── URL Helper ─────────────────────────────────────────────────────

function discoveryUrl(path: string): string {
  return `/api/search-ai/crawl/discovery${path}`;
}

/**
 * Build an SSE URL for the discovery stream.
 * EventSource cannot set custom headers, so pass token via query param.
 *
 * NOTE: This intentionally differs from crawl.ts's `sseUrl()` which only passes
 * `tenantId`. The Build 1 backend uses `verifyPlatformAccessToken(token, secret)`
 * for real JWT validation (not dev-bypass). This is a deliberate upgrade.
 * Follow-up: unify SSE auth into a shared `sseAuthUrl()` in api-client.ts.
 */
function sseStreamUrl(discoveryId: string): string {
  const directUrl = process.env.NEXT_PUBLIC_SEARCH_AI_URL;
  const headers = authHeaders();
  // For SSE we need to pass auth via query params
  const params = new URLSearchParams();
  const tenantId = (headers as Record<string, string>)['X-Tenant-Id'];
  if (tenantId) params.set('tenantId', tenantId);
  // Token-based auth for SSE (matches discovery.ts ?token= pattern)
  const token = (headers as Record<string, string>)['Authorization']?.replace('Bearer ', '');
  if (token) params.set('token', token);
  const qs = params.toString();
  if (directUrl) {
    return `${directUrl}/api/crawl/discovery/${discoveryId}/stream${qs ? `?${qs}` : ''}`;
  }
  return `/api/search-ai/crawl/discovery/${discoveryId}/stream${qs ? `?${qs}` : ''}`;
}

// ─── API Functions ──────────────────────────────────────────────────

/** POST /discovery/start — start BFS discovery */
export async function startDiscovery(req: StartDiscoveryRequest): Promise<StartDiscoveryResponse> {
  const response = await apiFetch(discoveryUrl('/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const result = await handleResponse<{
    success: boolean;
    data: StartDiscoveryResponse;
  }>(response);
  return result.data;
}

/** Connect to SSE stream for discovery progress */
export function connectDiscoveryStream(discoveryId: string): EventSource {
  return new EventSource(sseStreamUrl(discoveryId));
}

/** POST /discovery/:id/discover-more — explore a branch */
export async function discoverMore(
  discoveryId: string,
  req: DiscoverMoreRequest,
): Promise<{ discoveryId: string; url: string }> {
  const response = await apiFetch(discoveryUrl(`/${discoveryId}/discover-more`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const result = await handleResponse<{
    success: boolean;
    data: { discoveryId: string; url: string };
  }>(response);
  return result.data;
}

/** POST /discovery/:id/stop — stop running discovery */
export async function stopDiscovery(discoveryId: string): Promise<void> {
  await apiFetch(discoveryUrl(`/${discoveryId}/stop`), { method: 'POST' });
}

/** GET /discovery/:id/tree — get current tree state */
export async function getDiscoveryTree(discoveryId: string): Promise<DiscoveryTreeResponse> {
  const response = await apiFetch(discoveryUrl(`/${discoveryId}/tree`));
  const result = await handleResponse<{
    success: boolean;
    data: DiscoveryTreeResponse;
  }>(response);
  return result.data;
}

/** POST /discovery/:id/select — save URL selections.
 * Build 3 prep: no consumer in Build 2. Selections are converted locally
 * to CrawlSections via treeToSections(). This API persists them server-side
 * for cross-tab/resume scenarios. */
export async function selectDiscoveryUrls(
  discoveryId: string,
  req: SelectUrlsRequest,
): Promise<{ discoveryId: string; selectedCount: number }> {
  const response = await apiFetch(discoveryUrl(`/${discoveryId}/select`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const result = await handleResponse<{
    success: boolean;
    data: { discoveryId: string; selectedCount: number };
  }>(response);
  return result.data;
}

/** GET /discovery/domain/:domain — lookup cached discovery data */
export async function getDiscoveryByDomain(domain: string): Promise<DiscoveryTreeResponse['site']> {
  const response = await apiFetch(discoveryUrl(`/domain/${encodeURIComponent(domain)}`));
  const result = await handleResponse<{
    success: boolean;
    data: DiscoveryTreeResponse['site'];
  }>(response);
  return result.data;
}
```

### Type Updates (unified-tree-types.ts)

Add BFS-specific fields to `UnifiedTreeNode`:

```typescript
// Add to UnifiedTreeNode interface:
/** Rendering method detected by BFS engine */
renderMethod?: 'http' | 'browser' | 'unknown';
/** Whether BFS engine visited this URL */
visited?: boolean;
/** URLs where this node was discovered from */
foundOn?: string[];
```

Add to `UnifiedNodeSource`:

```typescript
export type UnifiedNodeSource =
  | 'nav-header'
  | 'nav-footer'
  | 'nav-mega-menu'
  | 'nav-breadcrumb'
  | 'sitemap'
  | 'http-explored'
  | 'bfs-discovered'; // NEW — found by BFS engine
```

### Subtasks

1. ST-1.1: Create `apps/studio/src/api/discovery.ts` with all 7 API functions
2. ST-1.2: Update `unified-tree-types.ts` — add `renderMethod`, `visited`, `foundOn` fields + `bfs-discovered` source
3. ST-1.3: `pnpm build --filter=studio` — verify types compile

### Acceptance Criteria

- AC-1: All 7 API functions match the backend Zod schemas exactly
- AC-2: `sseStreamUrl()` includes `?token=` for SSE auth (matching backend `verifyPlatformAccessToken`)
- AC-3: `pnpm build --filter=studio` succeeds

---

## Task T-2: useDiscovery Hook

### Files to Create

- `apps/studio/src/hooks/useDiscovery.ts` — SSE-based hook for BFS discovery lifecycle

### Design

```typescript
// apps/studio/src/hooks/useDiscovery.ts

import { useRef, useCallback, useState, useEffect } from 'react';
import {
  startDiscovery,
  connectDiscoveryStream,
  discoverMore,
  stopDiscovery,
  type StartDiscoveryRequest,
  type BfsSSEEvent,
} from '@/api/discovery';

export type DiscoveryStatus = 'idle' | 'starting' | 'running' | 'complete' | 'error';

export interface DiscoveryProgress {
  totalUrls: number;
  totalVisited: number;
  currentPhase: string;
  currentPhaseLabel: string;
  durationMs: number;
  stoppedBy?: string;
}

export interface UseDiscoveryOptions {
  /** Called on every BFS event */
  onEvent?: (event: BfsSSEEvent) => void;
  /** Called on tree-update events with new nodes */
  onTreeUpdate?: (event: Extract<BfsSSEEvent, { type: 'tree-update' }>) => void;
  /** Called on page-visit events */
  onPageVisit?: (event: Extract<BfsSSEEvent, { type: 'page-visit' }>) => void;
  /** Called on phase change */
  onPhaseChange?: (event: Extract<BfsSSEEvent, { type: 'phase' }>) => void;
  /** Called on activity log entries */
  onActivity?: (event: Extract<BfsSSEEvent, { type: 'activity' }>) => void;
  /** Called when discovery completes */
  onComplete?: (event: Extract<BfsSSEEvent, { type: 'complete' }>) => void;
  /** Called on error */
  onError?: (event: Extract<BfsSSEEvent, { type: 'error' }>) => void;
  /** Max SSE reconnect attempts (default 3).
   * Lower than useCrawlProgress's 5 because SSE reconnects faster
   * with exponential backoff (1s→2s→4s) vs WebSocket linear (5s→10s→15s).
   * 3 retries = 7s total wait, sufficient for transient network blips. */
  maxRetries?: number;
}

export function useDiscovery(options: UseDiscoveryOptions = {}) {
  const [status, setStatus] = useState<DiscoveryStatus>('idle');
  const [discoveryId, setDiscoveryId] = useState<string | null>(null);
  const [progress, setProgress] = useState<DiscoveryProgress>({
    totalUrls: 0,
    totalVisited: 0,
    currentPhase: '',
    currentPhaseLabel: '',
    durationMs: 0,
  });
  const [error, setError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const terminalRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref-based callbacks to avoid stale closures in SSE handlers
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // maxRetries as ref to avoid recreating connectSSE on prop change
  const maxRetriesRef = useRef(options.maxRetries ?? 3);
  maxRetriesRef.current = options.maxRetries ?? 3;

  /** Connect SSE stream for a discovery */
  const connectSSE = useCallback((id: string) => {
    if (terminalRef.current) return;

    const es = connectDiscoveryStream(id);
    eventSourceRef.current = es;

    const handleEvent = (eventName: string) => (event: Event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as BfsSSEEvent;
        optionsRef.current.onEvent?.(data);

        switch (data.type) {
          case 'tree-update':
            setProgress((prev) => ({
              ...prev,
              totalUrls: data.totalUrls,
              totalVisited: data.totalVisited,
            }));
            optionsRef.current.onTreeUpdate?.(
              data as Extract<BfsSSEEvent, { type: 'tree-update' }>,
            );
            break;
          case 'page-visit':
            optionsRef.current.onPageVisit?.(data as Extract<BfsSSEEvent, { type: 'page-visit' }>);
            break;
          case 'phase':
            setProgress((prev) => ({
              ...prev,
              currentPhase: String(data.phase),
              currentPhaseLabel: data.label,
            }));
            optionsRef.current.onPhaseChange?.(data as Extract<BfsSSEEvent, { type: 'phase' }>);
            break;
          case 'activity':
            optionsRef.current.onActivity?.(data as Extract<BfsSSEEvent, { type: 'activity' }>);
            break;
          case 'complete':
            terminalRef.current = true;
            setStatus('complete');
            setProgress((prev) => ({
              ...prev,
              totalUrls: data.totalUrls,
              totalVisited: data.totalVisited,
              durationMs: data.durationMs,
              stoppedBy: data.stoppedBy,
            }));
            optionsRef.current.onComplete?.(data as Extract<BfsSSEEvent, { type: 'complete' }>);
            es.close();
            break;
          case 'error':
            terminalRef.current = true;
            setStatus('error');
            setError(data.message);
            optionsRef.current.onError?.(data as Extract<BfsSSEEvent, { type: 'error' }>);
            es.close();
            break;
        }
      } catch (err) {
        // Non-JSON SSE data — log and skip (e.g., heartbeat/keepalive pings)
        console.warn(
          '[useDiscovery] Failed to parse SSE event:',
          err instanceof Error ? err.message : String(err),
        );
      }
    };

    // BFS engine emits named SSE events (7 types — matches BfsProgressEvent union)
    for (const name of [
      'phase',
      'page-visit',
      'url-discovered',
      'tree-update',
      'activity',
      'complete',
      'error',
    ]) {
      es.addEventListener(name, handleEvent(name));
    }

    es.onerror = () => {
      if (terminalRef.current) return;
      es.close();
      eventSourceRef.current = null;

      if (retryCountRef.current < maxRetriesRef.current) {
        retryCountRef.current++;
        const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 8000);
        retryTimeoutRef.current = setTimeout(() => connectSSE(id), delay);
      } else {
        setStatus('error');
        setError('Connection lost after max retries');
      }
    };
  }, []); // No deps — all mutable state via refs

  /** Start a new BFS discovery */
  const start = useCallback(
    async (req: StartDiscoveryRequest) => {
      // Guard: prevent double-start (double-click, React StrictMode)
      if (status === 'starting' || status === 'running') return;

      // Close any existing SSE connection before starting new one
      eventSourceRef.current?.close();
      eventSourceRef.current = null;

      // Reset state
      terminalRef.current = false;
      retryCountRef.current = 0;
      setError(null);
      setStatus('starting');
      setProgress({
        totalUrls: 0,
        totalVisited: 0,
        currentPhase: '',
        currentPhaseLabel: '',
        durationMs: 0,
      });

      try {
        const { discoveryId: id } = await startDiscovery(req);
        setDiscoveryId(id);
        setStatus('running');
        connectSSE(id);
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [connectSSE, status],
  );

  /** Send discover-more command — callers should catch errors */
  const exploreBranch = useCallback(
    async (url: string) => {
      if (!discoveryId) throw new Error('No active discovery');
      return discoverMore(discoveryId, { type: 'explore-branch', url });
    },
    [discoveryId],
  );

  /** Send explore-all command — callers should catch errors */
  const exploreAll = useCallback(
    async (url: string) => {
      if (!discoveryId) throw new Error('No active discovery');
      return discoverMore(discoveryId, { type: 'explore-all', url });
    },
    [discoveryId],
  );

  /** Stop the running discovery */
  const stop = useCallback(async () => {
    if (!discoveryId) return;
    terminalRef.current = true;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    try {
      await stopDiscovery(discoveryId);
    } catch (err) {
      // Best effort — local cleanup already done, backend stop is advisory
      console.warn(
        '[useDiscovery] Stop request failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
    setStatus('complete');
  }, [discoveryId]);

  // Cleanup on unmount — close SSE + cancel pending retry timeout
  useEffect(() => {
    return () => {
      terminalRef.current = true; // Prevent reconnect attempts
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);

  return {
    status,
    discoveryId,
    progress,
    error,
    start,
    stop,
    exploreBranch,
    exploreAll,
  };
}
```

### Key Patterns (extracted from deleted components)

1. **Ref-based callbacks** — `optionsRef.current` prevents stale closures in SSE handlers
   (from `BrowserDiscoveryInline.tsx` lines 83-89)
2. **Terminal flag** — `terminalRef` prevents reconnect after `complete`/`error`
   (from `BrowserDiscoveryInline.tsx` line 204)
3. **Exponential backoff** — `Math.min(1000 * 2^retry, 8000)`, max 3 retries
   (from `BrowserDiscoveryInline.tsx` lines 366-384)
4. **Named event listeners** — BFS engine emits named SSE events (`event: phase\ndata: ...`)
   not generic `message` events. Must use `addEventListener(name, ...)` not `onmessage`.

### Subtasks

1. ST-2.1: Create `useDiscovery.ts` with SSE lifecycle, reconnect, typed events
2. ST-2.2: `pnpm build --filter=studio` — verify types

### Acceptance Criteria

- AC-1: Hook starts discovery, receives SSE events, handles reconnect
- AC-2: `onComplete` fires exactly once on `complete` event, SSE closes
- AC-3: Unmount closes EventSource (no orphaned connections)
- AC-4: `pnpm build --filter=studio` succeeds

---

## Task T-3: Update Tree Merge for BFS Events

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/discovery/tree-merge.ts`

### BFS Status → UnifiedNodeStatus Mapping

The BFS engine uses `DiscoveredPage.status` (`discovered` | `visiting` | `visited` | `error`)
which maps to `UnifiedNodeStatus` as follows:

| BFS `status` | `UnifiedNodeStatus` | Notes                                                     |
| ------------ | ------------------- | --------------------------------------------------------- |
| `discovered` | `unexplored`        | URL found but not yet visited                             |
| `visiting`   | `exploring`         | BFS is currently visiting this URL                        |
| `visited`    | `explored`          | BFS finished visiting, `visited=true`, `renderMethod` set |
| `error`      | `error`             | Visit failed, `errorMessage` set                          |

This mapping is used by `mergeBfsPageVisit()` and `bfsTreeToUnifiedTree()`.

### New Functions

```typescript
/**
 * Merge BFS tree-update event into the unified tree.
 * Creates new nodes for URLs not already in the tree.
 * Uses URL-path hierarchy to find or create parent nodes.
 */
export function mergeBfsTreeUpdate(
  tree: UnifiedTreeNode[],
  newNodes: Array<{ url: string; label: string; parentUrl: string | null; depth: number }>,
  baseUrl: string,
): UnifiedTreeNode[];

/**
 * Update a node's status from a BFS page-visit event.
 * Sets visited=true, renderMethod, pageRole, page count.
 */
export function mergeBfsPageVisit(
  tree: UnifiedTreeNode[],
  url: string,
  data: {
    status: 'visiting' | 'visited' | 'error';
    renderMethod?: string;
    linksFound: number;
    pageRole?: string;
    errorMessage?: string;
  },
): UnifiedTreeNode[];

/**
 * Bulk toggle included flag for multiple nodes.
 * Used by "Select All" / "Deselect All".
 */
export function bulkToggleIncluded(
  tree: UnifiedTreeNode[],
  nodeIds: string[],
  included: boolean,
): UnifiedTreeNode[];

/**
 * Convert BFS treeHierarchy (from /tree endpoint) into UnifiedTreeNode[].
 * Build 3 prep: no consumer in Build 2. Will be used for reconnecting to a
 * completed or still-running discovery via `getDiscoveryTree()`.
 */
export function bfsTreeToUnifiedTree(
  treeHierarchy: Array<{ url: string; label: string; children: unknown[]; depth: number }>,
  discoveredUrls: Array<{
    url: string;
    renderMethod?: string;
    visited?: boolean;
    pageRole?: string;
    foundOn?: string[];
  }>,
): UnifiedTreeNode[];
```

### Subtasks

1. ST-3.1: Add `mergeBfsTreeUpdate()` — URL-path-based parent matching, immutable
2. ST-3.2: Add `mergeBfsPageVisit()` — find node by URL, update status fields
3. ST-3.3: Add `bulkToggleIncluded()` — iterate nodeIds, set `included`
4. ST-3.4: Add `bfsTreeToUnifiedTree()` — convert backend tree format to frontend model
5. ST-3.5: Update `tree-to-sections.ts` line 72 — replace hardcoded `strategy: 'http'` with:
   ```typescript
   strategy: node.renderMethod === 'browser' ? 'browser' : 'http';
   // 'unknown' and undefined both default to 'http' (safest crawl mode)
   ```

### Acceptance Criteria

- AC-1: All functions are pure and immutable (return new tree, never mutate input)
- AC-2: `pnpm build --filter=studio` succeeds
- AC-3: Functions handle empty tree, empty newNodes, missing URLs gracefully

### Performance Note

`mergeBfsTreeUpdate` does immutable O(n) tree cloning on every `tree-update` SSE event.
For sites with 10K+ URLs this may cause UI jank. Build 2 accepts this tradeoff — the BFS
engine's `DEFAULT_MAX_ALL_LINKS = 50_000` and `PROGRESS_THROTTLE_MS = 300` provide natural
back-pressure. Build 3 should add tree virtualization (react-window) and batched updates if
large-site performance is insufficient.

---

## Task T-4: Rewrite UnifiedDiscoveryPanel

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/UnifiedDiscoveryPanel.tsx` — Full rewrite

### Design

The panel orchestrates the complete discovery UX:

1. User clicks "Start Discovery" → calls `useDiscovery().start()`
2. BFS events stream in via SSE → tree grows live via `mergeBfsTreeUpdate()`
3. Activity log shows real-time updates
4. Phase indicators show progress (Phase 0→1a→1b→2→3)
5. On complete → show summary + tree with checkboxes
6. User selects URLs → "Configure Crawl" button converts tree to sections

### Props Migration (old → new)

| Old Prop                | New Prop          | Notes                                                     |
| ----------------------- | ----------------- | --------------------------------------------------------- |
| `baseUrl`               | `primaryUrl`      | Renamed for clarity                                       |
| `sampleUrls`            | `sampleUrls`      | Kept                                                      |
| `depthProbing`          | _removed_         | BFS engine replaces depth probing                         |
| `onSectionsDiscovered`  | _removed_         | Sections come from `onSectionsReady` after tree selection |
| `onLayerComplete`       | _removed_         | BFS has single continuous run, not layers                 |
| `onApiPatternsFound`    | _removed_         | Internal to BFS engine                                    |
| `onLiveStats`           | _removed_         | Progress available via `useDiscovery().progress`          |
| `onSaveDiscoveryState`  | _removed_         | Draft save handled internally via `discoveryId`           |
| `initialDiscoveryState` | _removed_         | Resume via `getDiscoveryTree(discoveryId)`                |
| `onSectionsAutoAdded`   | _removed_         | Auto-add replaced by BFS tree selection                   |
| `onFileTypesUpdated`    | _removed_         | File types discovered during crawl, not discovery         |
| `onClose`               | _removed_         | Panel lifecycle managed by State2Analysis                 |
| `onComplete`            | `onSectionsReady` | Called with CrawlSection[] after user selection           |
| `domain`                | _derived_         | Extracted from `primaryUrl`                               |
| `sitemapSectionCount`   | _removed_         | Not needed — BFS is independent of sitemap                |
| `sitemapPageCount`      | _removed_         | Same                                                      |
| _(new)_                 | `seeds`           | Structured seeds from seed selection step                 |
| _(new)_                 | `onTreeChange`    | Lift tree state to State2Analysis for draft persistence   |
| _(new)_                 | `tree`            | Current tree state (lifted)                               |
| _(new)_                 | `maxDepth`        | BFS max depth (optional, default 8)                       |
| _(new)_                 | `sourceId`        | For tenant discovery association                          |

```typescript
interface UnifiedDiscoveryPanelProps {
  /** Primary URL for discovery */
  primaryUrl: string;
  /** Sample URLs from user input */
  sampleUrls: string[];
  /** Seeds (nav sections + target URLs) */
  seeds: Array<{ type: 'nav-section' | 'target-url'; url: string; label?: string }>;
  /** Called when discovery produces sections for crawl */
  onSectionsReady: (sections: CrawlSection[]) => void;
  /** Callback to update lifted tree state */
  onTreeChange: (tree: UnifiedTreeNode[]) => void;
  /** Current tree state (lifted to State2Analysis) */
  tree: UnifiedTreeNode[];
  /** Max depth for BFS */
  maxDepth?: number;
  /** Source ID for tenant discovery association */
  sourceId?: string;
}
```

### Internal State Machine

```
idle → starting → running → complete
                     ↕
                   error (with retry)
```

### Visual Layout

```
┌─ Discovery ────────────────────────────────────────┐
│                                                    │
│  Phase: "Visiting seed pages" (1a)  [■■■□□] 40%   │  ← Phase indicator
│  Found 127 URLs, visited 23 pages                  │  ← Live stats
│                                                    │
│  ┌─ Activity Log ───────────────────────────────┐  │
│  │  ✓ Nav extraction complete — 12 sections     │  │  ← Scrollable, max 5 visible
│  │  → Visiting /Support/Printers (3 links)      │  │
│  │  → Visiting /Support/Scanners (7 links)      │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌─ Live Tree ──────────────────────────────────┐  │
│  │  (UnifiedTree component — grows in real-time)│  │  ← Tree updates on each event
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  [Stop]                               [Configure]  │  ← Action buttons
└────────────────────────────────────────────────────┘
```

### SSE Event → Tree Update Mapping

| SSE Event              | Tree Action                                                                |
| ---------------------- | -------------------------------------------------------------------------- |
| `tree-update`          | `mergeBfsTreeUpdate(tree, newNodes, primaryUrl)`                           |
| `page-visit` (visited) | `mergeBfsPageVisit(tree, url, data)` — mark node visited, set renderMethod |
| `page-visit` (error)   | `mergeBfsPageVisit(tree, url, { status: 'error', errorMessage })`          |
| `phase`                | Update phase indicator label + progress                                    |
| `activity`             | Append to activity log (`MAX_ACTIVITY_LOG_ENTRIES = 200`, FIFO eviction)   |
| `url-discovered`       | Silently captured by `onEvent` — no dedicated handler (Build 2 minimal)    |
| `complete`             | Set status=complete, show summary, enable "Configure Crawl"                |
| `error`                | Set status=error, show error message with retry button                     |

### Subtasks

1. ST-4.1: Rewrite component shell — props, useDiscovery hook wiring, state machine
2. ST-4.2: Implement phase indicator — current phase label, progress bar, live stats
3. ST-4.3: Implement activity log — scrollable list, max 200 entries, auto-scroll
4. ST-4.4: Wire tree updates — SSE events → `mergeBfsTreeUpdate` / `mergeBfsPageVisit` → `onTreeChange`
5. ST-4.5: Implement complete state — summary (total URLs, visited, duration), "Configure Crawl" button
6. ST-4.6: Implement error state — error message, retry button (calls `start()` again)
7. ST-4.7: Implement stop — "Stop" button calls `useDiscovery().stop()`

### i18n

Namespace: `search_ai.crawl_flow` (same as existing). Use `const t = useTranslations('search_ai.crawl_flow')`.

New keys needed (add to `packages/i18n/locales/en/studio.json`):

| Key                             | Value                                                     | Usage                                          |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| `discovery_starting`            | `"Starting discovery..."`                                 | Starting state                                 |
| `discovery_phase_nav`           | `"Scanning site navigation"`                              | Phase 0 label                                  |
| `discovery_phase_seeds`         | `"Visiting seed pages"`                                   | Phase 1a label                                 |
| `discovery_phase_children`      | `"Exploring linked pages"`                                | Phase 1b label                                 |
| `discovery_phase_climb`         | `"Climbing breadcrumb ancestors"`                         | Phase 2 label                                  |
| `discovery_phase_expand`        | `"Expanding discovered branches"`                         | Phase 3 label                                  |
| `discovery_phase_discover_more` | `"Exploring additional branch"`                           | Phase 4 label (triggered by discover-more API) |
| `discovery_found_urls`          | `"Found {total} URLs, visited {visited} pages"`           | Live stats                                     |
| `discovery_complete_summary`    | `"Discovery complete — {total} URLs found in {duration}"` | Completion                                     |
| `discovery_error`               | `"Discovery failed: {message}"`                           | Error state                                    |
| `discovery_stop`                | `"Stop"`                                                  | Stop button                                    |
| `discovery_configure`           | `"Configure Crawl"`                                       | Configure button                               |
| `discovery_retry`               | `"Retry"`                                                 | Retry button                                   |

**Hardcoded strings in existing UnifiedTree components** (UnifiedTree.tsx, UnifiedTreeNodeRow.tsx,
UnifiedTreeHeader.tsx) will be converted to i18n keys in T-5 as part of the update.

### Acceptance Criteria

- AC-1: Discovery starts on user action, tree grows live with SSE events
- AC-2: "Configure Crawl" calls `treeToSections()` and passes to `onSectionsReady`
- AC-3: "Stop" gracefully stops discovery and preserves partial tree
- AC-4: Activity log persists across phase transitions
- AC-5: All user-visible strings use `t()` with i18n keys
- AC-6: `pnpm build --filter=studio` succeeds

---

## Task T-5: Update UnifiedTree Components

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/discovery/UnifiedTree.tsx`
- `apps/studio/src/components/search-ai/crawl-flow/discovery/UnifiedTreeNodeRow.tsx`
- `apps/studio/src/components/search-ai/crawl-flow/discovery/UnifiedTreeHeader.tsx`

### Changes to UnifiedTree.tsx

1. **Add checkbox selection** — each node row has a checkbox when `status !== 'unexplored'`
2. **Add shift-click range selection** (pattern from old DiscoveryTree.tsx lines 613-643)
3. **Wire bulk actions** — Select All/Deselect All use `bulkToggleIncluded()`
4. **Update footer** — Show "Configure Crawl with N sections (M pages)" button
5. **Add `mode` prop** — `'live'` (during discovery, read-only tree) vs `'select'` (after completion, checkboxes enabled)

### Changes to UnifiedTreeNodeRow.tsx

1. **Add checkbox** — controlled by `node.included`, fires `onToggleInclude(nodeId, !included)`
2. **Add BFS status badges** — `visited` (green dot), `renderMethod` badge (http/browser)
3. **Add "Discover More" action** — hover button that calls `onExplore(nodeId, url)` for expand
4. **Show page count** — when `node.pageCount > 0`, show count badge

### Changes to UnifiedTreeHeader.tsx

1. **Update stats** — show `visited` / `totalUrls` / `included` counts
2. **Add "Select All Visited" action** — selects all nodes with `status === 'explored'` or `visited === true`

### i18n Conversion (hardcoded English → translation keys)

These existing hardcoded strings in UnifiedTree components will be converted:

| Component              | String                                     | New i18n Key                                                |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| UnifiedTree.tsx        | "No nodes match your search"               | `discovery_tree_no_match`                                   |
| UnifiedTree.tsx        | "sections selected"                        | `discovery_tree_selected`                                   |
| UnifiedTree.tsx        | "Continue with N sections"                 | `discovery_tree_continue`                                   |
| UnifiedTreeHeader.tsx  | "Discovery Tree"                           | `discovery_tree_title`                                      |
| UnifiedTreeHeader.tsx  | "Expand All" / "Collapse All"              | `discovery_tree_expand_all` / `discovery_tree_collapse_all` |
| UnifiedTreeHeader.tsx  | "Select All" / "Deselect All"              | `discovery_tree_select_all` / `discovery_tree_deselect_all` |
| UnifiedTreeHeader.tsx  | "explored" / "auto-matched" / "unexplored" | `discovery_tree_explored` etc.                              |
| UnifiedTreeNodeRow.tsx | "Auto" / "Footer" / "Menu"                 | `discovery_node_auto` etc.                                  |
| UnifiedTreeNodeRow.tsx | "Pages found" / "Failed" / "Retry"         | `discovery_node_pages` etc.                                 |

### Subtasks

1. ST-5.1: Add `mode` prop to UnifiedTree, conditional checkbox rendering
2. ST-5.2: Wire checkbox to `toggleNodeIncluded` via `onTreeChange`
3. ST-5.3: Add shift-click range selection
4. ST-5.4: Update UnifiedTreeNodeRow — checkbox, BFS badges, page count
5. ST-5.5: Update UnifiedTreeHeader — BFS-aware stats
6. ST-5.6: Update footer — "Configure Crawl" button with section/page counts
7. ST-5.7: Convert all hardcoded English strings to i18n keys

### Acceptance Criteria

- AC-1: Checkboxes visible only in `select` mode
- AC-2: Select All / Deselect All work correctly
- AC-3: Shift-click selects range between last click and current click
- AC-4: All user-visible strings use `t()` with i18n keys
- AC-5: `pnpm build --filter=studio` succeeds

---

## Task T-6: Wire into State2Analysis + CrawlFlowV5

### Files to Modify

- `apps/studio/src/components/search-ai/crawl-flow/State2Analysis.tsx`
- `apps/studio/src/components/search-ai/crawl-flow/types.ts` (minimal)

### Changes to State2Analysis.tsx

1. **Remove old discovery imports** — `BrowserDiscoveryInline`, `ExplorePanel`, `DiscoveryPanel` (done in T-0)
2. **Remove dead state** — `exploreOpen`, `browserDiscoveryOpen`, `showBrowserCompleteChoice`, `browserDiscoveredUrls`, `apiPatterns`
3. **Remove dead handlers** — `handleExploreLayerComplete`, `handleBrowserSectionsDiscovered`, `handleBrowserLayerComplete`
4. **Wire UnifiedDiscoveryPanel** — pass `seeds` from discovery flow, handle `onSectionsReady`
5. **Update discovery trigger** — "Start Discovery" button passes seeds to UnifiedDiscoveryPanel
6. **Keep existing features** — manual URL paste, section checklist, test extraction, minimize toggle

### Seed Construction

State2Analysis needs to convert the user's URL + sample URLs into the `seeds` format:

```typescript
const seeds: DiscoverySeed[] = [
  // Primary URL as nav-section seed
  { type: 'nav-section' as const, url: url, label: 'Primary URL' },
  // Sample URLs as target-url seeds
  ...sampleUrls
    .filter((u) => u.trim())
    .map((u) => ({
      type: 'target-url' as const,
      url: u.trim(),
    })),
];
```

### Discovery-to-Configure Handoff

When `UnifiedDiscoveryPanel.onSectionsReady` fires:

```typescript
const handleSectionsReady = useCallback(
  (treeSections: CrawlSection[]) => {
    onSectionsChange(treeSections);
    onContinue(); // Transition to State 3
  },
  [onSectionsChange, onContinue],
);
```

### PipelinePhase (types.ts)

No modification needed — `PipelinePhase` already includes `'running'` (types.ts line 111):

```typescript
export type PipelinePhase = 'idle' | 'browser-running' | 'http-running' | 'running' | 'complete';
```

State2Analysis will use `'idle' | 'running' | 'complete'` subset. Old values `'browser-running'`
and `'http-running'` remain for backward compatibility with any other consumers.

### Subtasks

1. ST-6.1: Remove dead state, handlers, and imports from State2Analysis
2. ST-6.2: Add `seeds` construction from URL + sampleUrls
3. ST-6.3: Wire `UnifiedDiscoveryPanel` with new props
4. ST-6.4: Implement `handleSectionsReady` for Configure handoff
5. ST-6.5: Update PipelinePhase type (additive, not breaking)
6. ST-6.6: Preserve manual URL paste, test extraction, minimize
7. ST-6.7: `pnpm build --filter=studio` — verify types

### Acceptance Criteria

- AC-1: Discovery flow: URL entry → start discovery → live tree → select URLs → configure crawl
- AC-2: Sitemap flow unchanged (sitemap path doesn't use discovery)
- AC-3: Manual URL paste still works
- AC-4: Minimize toggle hides/shows discovery panel
- AC-5: `pnpm build --filter=studio` succeeds

---

## Task T-7: Clean Up Dead API Functions

### Files to Modify

- `apps/studio/src/api/crawl.ts` — Remove functions that call deleted backend endpoints

### Functions to Remove

| Function                          | Line  | Why Dead                                                   |
| --------------------------------- | ----- | ---------------------------------------------------------- |
| `startDiscoverCrawl()`            | ~760  | Backend `crawl-discover.ts` deleted                        |
| `connectDiscoverProgress()`       | ~841  | Backend `crawl-discover.ts` deleted                        |
| `stopDiscoverCrawl()`             | ~854  | Backend `crawl-discover.ts` deleted                        |
| `getDiscoverResult()`             | ~861  | Backend `crawl-discover.ts` deleted                        |
| `startDeepenCrawl()`              | ~889  | Backend `crawl-discover.ts` deleted                        |
| `startBrowserExplore()`           | ~1020 | Backend `crawl-browser-discover.ts` deleted                |
| `connectBrowserExploreProgress()` | ~1110 | Backend `crawl-browser-discover.ts` deleted                |
| `stopBrowserExplore()`            | ~1120 | Backend `crawl-browser-discover.ts` deleted                |
| `getBrowserExploreResult()`       | ~1130 | Backend `crawl-browser-discover.ts` deleted                |
| `sendBrowserIntervention()`       | ~1140 | Backend `crawl-browser-discover.ts` deleted                |
| `startNodeExplore()`              | ~916  | Backend route deleted, replaced by Build 1 `discover-more` |
| `connectNodeExploreProgress()`    | ~929  | Same                                                       |
| `getNodeExploreResult()`          | ~940  | Same                                                       |

Also remove associated types: `DiscoverCrawlRequest`, `DiscoverCrawlResponse`, `DiscoverResult`, `DiscoverProgress`, `DeepenCrawlRequest`, `BrowserExploreProgress`, `DepthProbingConfig`, `NodeExploreRequest`, `NodeExploreResponse`.

### Keep

- `clusterUrls()` — used by sitemap path
- `sampleGroups()` — used by sitemap path
- `profileSite()` — used by State 1
- All crawl job functions (submit, status, progress) — used by State 3/4

### Subtasks

1. ST-7.1: Grep for consumers of each function — verify none outside deletion set
2. ST-7.2: Remove dead functions and types
3. ST-7.3: Remove `sseUrl()` helper if no remaining consumers (check if crawl progress uses it)
4. ST-7.4: `pnpm build --filter=studio` — verify no missing imports

### Acceptance Criteria

- AC-1: Zero dead API functions remain
- AC-2: `pnpm build --filter=studio` succeeds
- AC-3: Sitemap and crawl flows still work (no shared functions removed)

---

## Task T-8: Delete Old Test Files

### Files to Delete

Test files for deleted utilities and old model:

- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/tree-utils.test.ts` — tests for deleted `tree-utils.ts`
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/url-set.test.ts` — tests `DiscoveredUrlSet` from old model
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/console-utils.test.ts` — tests old console utils
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/coverage-utils.test.ts` — tests old coverage utils
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/decision-utils.test.ts` — tests old decision utils
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/reason-utils.test.ts` — tests old reason utils
- `apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/scope-utils.test.ts` — tests old scope utils

### Verification

```bash
# Check if any test imports utilities that still exist
grep -l "tree-utils\|url-set\|console-utils\|coverage-utils\|decision-utils\|reason-utils\|scope-utils" \
  apps/studio/src/components/search-ai/crawl-flow/discovery/__tests__/*.test.ts
```

### Subtasks

1. ST-8.1: Verify each test file only tests deleted code
2. ST-8.2: Delete test files
3. ST-8.3: Verify `pnpm test --filter=studio` passes (remaining tests)

### Acceptance Criteria

- AC-1: No test files for deleted code remain
- AC-2: `pnpm test --filter=studio` passes

---

## Deferred to Build 3

### Resume-from-Draft Flow

The existing `CrawlDraftDiscoveryState` type (types.ts ~line 829) uses old model fields:
`tree: DiscoveryTreeNode[]`, `discoveredUrls`, `objectives`, `navStructure`, `iterations`.

For Build 2, the auto-save in State2Analysis (line 469-484) already saves `unifiedTree` cast
as `DiscoveryTreeNode[]`. This works because the draft is opaque storage — the cast is unsafe
but functional since we only read back what we wrote.

**Build 2 approach** (minimal):

- Keep the existing auto-save mechanism — State2Analysis saves `unifiedTree` to draft every 5s
- On resume, restore `unifiedTree` from `draft.discoveryState.tree`
- Discovery itself is NOT resumable — if the page is refreshed during BFS, the partial tree
  is preserved but the BFS stream is lost. User would need to re-run discovery.

**Build 3** (proper):

- Update `CrawlDraftDiscoveryState` to include `discoveryId`, `bfsStatus`, `unifiedTree`
- Support reconnecting to a still-running BFS discovery via `discoveryId`
- Add `_treeVersion: 3` discriminator for new format

### Background Discovery / Activity Bar

The `discovery-store.ts` (Zustand) and `DiscoveryActivityBar.tsx` support minimized discovery.
Three components consume the store: DiscoveryActivityBar, State4Crawl, KBDetailLayout.

**Build 2 approach** (minimal):

- The minimize toggle in State2Analysis already works — it hides the panel via `isMinimized`
  state and shows the activity bar. The SSE connection stays alive (EventSource is in the hook,
  not the component).
- State2Analysis does not currently call `useDiscoveryStore.addItem()`. Background discovery
  with BFS progress in the activity bar requires new wiring in Build 3.
- No new wiring needed for basic minimize/restore of the panel UI itself.

**Build 3** (proper):

- Update `BackgroundedDiscovery` type to include `discoveryId` for reconnect
- Show BFS progress (totalUrls, totalVisited) in the activity bar
- Support cross-tab discovery tracking via the Zustand store

---

## Wave Plan (ADD → REPLACE → DELETE)

> **Corrected from original**: Original had Wave 0 = DELETE first, which breaks the build
> because `UnifiedDiscoveryPanel.tsx` imports `BrowserDiscoveryInline` and `useNodeExplore`.
> Correct order: ADD new code → REPLACE old wiring → DELETE dead code last.

### Wave 1 — ADD (parallel — all new files, no overlap)

- **T-1**: API client + types (NEW `api/discovery.ts` + type additions to `unified-tree-types.ts`)
- **T-7**: Clean up dead API functions (independent file: `crawl.ts`)

### Wave 2 — ADD continued (depends on T-1 types)

- **T-2**: `useDiscovery` hook (NEW `hooks/useDiscovery.ts`, depends on T-1 API client + `BfsSSEEvent` types)
- **T-3**: Tree merge updates (depends on T-1's `renderMethod`, `visited`, `foundOn` fields + `bfs-discovered` source in `unified-tree-types.ts`)

> **Note:** T-2 and T-3 can run in parallel (zero file overlap).

### Wave 3 — REPLACE (sequential — rewrites existing components)

- **T-5**: UnifiedTree component updates (depends on T-3 tree merge functions)
- **T-4**: Rewrite UnifiedDiscoveryPanel (depends on T-2 hook + T-5 tree components)
- **T-6**: Wire into State2Analysis (depends on T-4 panel)

> **Note:** T-5 → T-4 → T-6 are sequential within Wave 3.

### Wave 4 — DELETE (only after Wave 3 removes all imports)

- **T-0**: Delete dead code (13 files — safe only because T-4 removed all imports)
- **T-8**: Delete old test files

### File Overlap Check

| Task | Wave | Files Modified                                                 | Overlap?                                       |
| ---- | ---- | -------------------------------------------------------------- | ---------------------------------------------- |
| T-1  | 1    | NEW discovery.ts, unified-tree-types.ts                        | None in Wave 1                                 |
| T-7  | 1    | crawl.ts                                                       | None                                           |
| T-2  | 2    | NEW useDiscovery.ts                                            | None in Wave 2                                 |
| T-3  | 2    | tree-merge.ts, tree-to-sections.ts                             | None (parallel with T-2)                       |
| T-5  | 3    | UnifiedTree.tsx, UnifiedTreeNodeRow.tsx, UnifiedTreeHeader.tsx | Sequential before T-4                          |
| T-4  | 3    | UnifiedDiscoveryPanel.tsx                                      | Sequential after T-5                           |
| T-6  | 3    | State2Analysis.tsx, types.ts                                   | Sequential after T-4                           |
| T-0  | 4    | discovery/index.ts, 13 file deletions                          | All imports removed by Wave 3 — safe to delete |
| T-8  | 4    | Test file deletions                                            | None                                           |

**Zero file overlap within parallel task groups.** Sequential tasks within a wave are clearly ordered.

### Commit Plan

1. `[ABLP-71] feat(studio): add discovery API client and BFS type extensions` — T-1 (Wave 1)
2. `[ABLP-71] refactor(studio): remove dead crawl API functions` — T-7 (Wave 1)
3. `[ABLP-71] feat(studio): add useDiscovery SSE hook for BFS lifecycle` — T-2 (Wave 2)
4. `[ABLP-71] feat(studio): add BFS tree merge functions and bulk selection` — T-3 (Wave 2)
5. `[ABLP-71] feat(studio): update UnifiedTree components for BFS selection` — T-5 (Wave 3)
6. `[ABLP-71] feat(studio): rewrite UnifiedDiscoveryPanel with BFS engine` — T-4 (Wave 3)
7. `[ABLP-71] feat(studio): wire BFS discovery into State2Analysis flow` — T-6 (Wave 3)
8. `[ABLP-71] refactor(studio): delete dead discovery components and old model` — T-0 (Wave 4)
9. `[ABLP-71] test(studio): remove tests for deleted discovery utilities` — T-8 (Wave 4)
