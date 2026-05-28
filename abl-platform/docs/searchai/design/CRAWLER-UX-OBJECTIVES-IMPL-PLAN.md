# Crawler UX Objectives — Implementation Plan

> **8 user objectives, phased into 4 implementation batches.**
> Every change references exact file paths, component names, prop shapes, and state flows.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [O1: Live Discovery Transparency](#o1-live-discovery-transparency)
3. [O2: Auto-Section Creation from Tree](#o2-auto-section-creation-from-tree)
4. [O3: Recursive Page Counts](#o3-recursive-page-counts)
5. [O4: Mid-Discovery Interventions](#o4-mid-discovery-interventions)
6. [O5: Extraction Preview](#o5-extraction-preview)
7. [O6: Step 4 Crawl Progress](#o6-step-4-crawl-progress)
8. [O7: Document/File Type Discovery](#o7-documentfile-type-discovery)
9. [O8: robots.txt and Rate Limiting](#o8-robotstxt-and-rate-limiting)
10. [Multi-User Access Model](#multi-user-access-model)
11. [Phased Implementation Plan](#phased-implementation-plan)
12. [Dependency Graph](#dependency-graph)
13. [Edge Cases](#edge-cases)

---

## Architecture Overview

### Current Component Hierarchy

```
CrawlFlowV5 (state machine: url-entry → analyzing → configure → crawling → done)
├── FlowStepper (breadcrumb nav)
├── State1UrlEntry (URL input + draft resume)
├── State2Analysis (left: pipeline + sections, right: profile card)
│   ├── StrategySelector (crawl-sitemap vs guided-discovery)
│   ├── DiscoveryTimeline (pipeline step status)
│   ├── BrowserDiscoveryInline (Playwright exploration)
│   │   └── DiscoveryPanel (orchestrator)
│   │       ├── DiscoveryConsole (log feed)
│   │       ├── DiscoveryTree (URL tree + checkboxes + bulk actions)
│   │       └── CoverageSummary (post-discovery coverage report)
│   ├── ExplorePanel (HTTP recursive discovery)
│   └── Section checklist (inline in State2Analysis)
├── State3Configure (scope + settings)
│   └── PreviewPanel (single-page extraction preview)
└── State4Crawl (crawl progress — currently functional)
```

### Data Flow

```
SSE Events (browser-discover / crawl-discover backend)
  → BrowserDiscoveryInline / ExplorePanel (event listeners)
    → DiscoveryPanel (converts events → tree + console + coverage)
      → State2Analysis (sections state: CrawlSection[])
        → CrawlFlowV5 (master sections state, persisted to draft)
```

### Key State Locations

| State            | Owner          | Shape                            | File                   |
| ---------------- | -------------- | -------------------------------- | ---------------------- |
| `sections`       | CrawlFlowV5    | `CrawlSection[]`                 | CrawlFlowV5.tsx:176    |
| `analysisSteps`  | CrawlFlowV5    | `AnalysisStep[]`                 | CrawlFlowV5.tsx:178    |
| `treeNodes`      | DiscoveryPanel | `DiscoveryTreeNode[]`            | DiscoveryPanel.tsx:141 |
| `consoleEntries` | DiscoveryPanel | `ConsoleEntry[]`                 | DiscoveryPanel.tsx:142 |
| `coverage`       | DiscoveryPanel | `CoverageAnalysis`               | DiscoveryPanel.tsx:143 |
| `progress`       | BrowserDisc.   | `BrowserExploreProgress`         | BrowserDiscovery...:65 |
| `crawlConfig`    | CrawlFlowV5    | `CrawlConfig`                    | CrawlFlowV5.tsx:180    |
| `pipelinePhase`  | State2Analysis | `'idle'\|'browser-running'\|...` | State2Analysis.tsx:110 |

---

## O1: Live Discovery Transparency

**Goal:** Each pipeline step shows live sub-status, yield indicators, and at-a-glance health — not just a spinner.

### Before (ASCII Wireframe)

```
┌─────────────────────────────────────────────┐
│  ● Discovering pages...         [spinner]   │
│  ○ Finding sections             [pending]   │
│  ○ Analysis complete            [pending]   │
└─────────────────────────────────────────────┘
```

### After (ASCII Wireframe)

```
┌─────────────────────────────────────────────────────────────┐
│  ✓ Site profiled                docs.example.com            │
│    WordPress · sitemap: 2,341 URLs · avg 180ms              │
│                                                             │
│  ● Scanning navigation         Visiting /printers/ — 8 new │
│    ░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓  12/20 pages  Finding 6 new/visit  │
│    Hub pages: 4  ·  Leaf pages: 8  ·  Skipped: 1           │
│                                                             │
│  ○ HTTP deep discovery          waiting for browser scan    │
│  ○ Sections ready               —                           │
└─────────────────────────────────────────────────────────────┘
```

### Component Changes

#### 1. Enhance `DiscoveryTimeline.tsx`

**Current:** Each entry has `id`, `icon`, `label`, `status`, `detail` (one-line string).

**Change:** Add `liveStats` and `subStatus` to `TimelineEntry`:

```typescript
interface TimelineEntry {
  id: string;
  icon: React.ReactNode;
  label: string;
  status: TimelineStatus;
  detail?: string;
  // NEW fields
  subStatus?: string; // "Visiting /printers/ — found 8 series"
  progress?: { current: number; total: number }; // mini progress bar
  discoveryRate?: number; // new pages found per visit
  healthIndicators?: Array<{
    label: string;
    value: number;
    variant: 'success' | 'warning' | 'muted';
  }>;
}
```

**Where:** `DiscoveryTimeline.tsx:64-75` — extend `TimelineEntry` interface.

**Rendering:** Below the label + detail line, render:

- A thin progress bar when `progress` is set (reuse `ProgressBar` pattern from State4Crawl)
- Health indicator chips: `Hub: 4 · Leaf: 8 · Skipped: 1`
- Discovery rate badge: `Finding 6 new per visit` (green when productive, amber when declining)

#### 2. Feed live data from `DiscoveryPanel` → `DiscoveryTimeline`

**Current:** `DiscoveryTimeline` receives `analysisSteps`, `pipelinePhase`, `discoveryStats`. These are aggregate/completion data, not live data.

**Change:** Pass new prop `liveProgress` from `State2Analysis`:

```typescript
interface DiscoveryTimelineProps {
  // ...existing
  liveProgress?: {
    currentUrl?: string;
    pagesVisited: number;
    pageBudget: number;
    discoveryRate: number;
    discoveryTrend: 'productive' | 'declining' | 'stalled';
    hubCount: number;
    leafCount: number;
    skippedCount: number;
  };
}
```

**Data source:** `BrowserExploreProgress` already has `currentUrl`, `pagesVisited`, `pageBudget`, `yieldPerPage`, `yieldTrend`. The hub/leaf/skipped counts need to be derived from the tree.

**Where to derive:** In `DiscoveryPanel.tsx`, compute a `treeStats` memo from `treeNodes`:

```typescript
const treeStats = useMemo(() => {
  let hubs = 0,
    leaves = 0,
    skipped = 0;
  walkTree(treeNodes, (node) => {
    if (node.state === 'skipped') skipped++;
    else if (node.role === 'hub') hubs++;
    else leaves++;
  });
  return { hubs, leaves, skipped };
}, [treeNodes]);
```

Then surface this via a new callback prop `onLiveStats` that `State2Analysis` can pass to `DiscoveryTimeline`.

#### 3. New component: `LiveSubStatus.tsx`

Small inline component rendered within each `DiscoveryTimeline` row when status is `'active'`:

```
LiveSubStatus
├── Compact path: "Visiting /support/printers/inkjet/" (truncated)
├── Mini progress: "12/20 pages"
├── Discovery rate: "Finding 6 new per visit" (green) or "Finding <1 new per visit" (amber)
└── Health chips: "Hubs: 4 · Leaves: 8"
```

### State/Data Flow

```
BrowserExploreProgress (SSE)
  → BrowserDiscoveryInline.progress state
    → DiscoveryPanel.progress prop
      → DiscoveryPanel derives treeStats + yieldRate
        → new callback: onLiveStats({ currentUrl, pagesVisited, ... })
          → State2Analysis.liveProgress state
            → DiscoveryTimeline.liveProgress prop
              → LiveSubStatus component per active row
```

### SSE/API Changes

**None.** All data already exists in `BrowserExploreProgress`. The `currentUrl`, `pagesVisited`, `pageBudget`, `yieldPerPage`, `yieldTrend`, `currentRole`, `discoveredOnPage` fields are already emitted by the backend.

### New Files

- `apps/studio/src/components/search-ai/crawl-flow/LiveSubStatus.tsx`

### Modified Files

- `DiscoveryTimeline.tsx` — extend `TimelineEntry`, render `LiveSubStatus`
- `DiscoveryPanel.tsx` — add `treeStats` memo, add `onLiveStats` callback prop
- `BrowserDiscoveryInline.tsx` — forward `onLiveStats` prop to `DiscoveryPanel`
- `State2Analysis.tsx` — store `liveProgress`, pass to `DiscoveryTimeline`
- `types.ts` — add `LiveProgressStats` interface

---

## O2: Auto-Section Creation from Tree

**Goal:** Tree categories automatically become selectable sections. Currently, tree shows 305 nodes but sections shows only 1 "Global" section.

### Before

```
┌─ Discovery Tree (305 nodes) ────────────────┐
│  ☐ Support                                   │
│    ☐ Printers (linkCount: 42)                │
│      ☐ Inkjet                                │
│      ☐ Laser                                 │
│    ☐ Scanners (linkCount: 18)                │
│  ☐ Products                                  │
│    ☐ Home (linkCount: 67)                    │
└──────────────────────────────────────────────┘

┌─ Sections discovered so far ────────────────┐
│  ☑ Global  |  305 pages  |  ~2h 30m         │  ← only 1 section
└──────────────────────────────────────────────┘
```

### After

```
┌─ Discovery Tree (305 nodes) ────────────────┐
│  ☐ Support                            [+]   │  ← tooltip: "Add as section"
│    ☐ Printers (142 pages · ~45m)      [+]   │  ← recursive count
│      ☐ Inkjet (68 pages)                    │
│      ☐ Laser (74 pages)                     │
│    ☐ Scanners (52 pages · ~17m)       [+]   │
│  ☐ Products                           [+]   │
│    ☐ Home (67 pages · ~22m)           [+]   │
└──────────────────────────────────────────────┘

┌─ Sections (4 selected / 6 available) ───────┐
│  ☑ Printers      142 pages  ~45m  [explored]│
│  ☑ Scanners       52 pages  ~17m  [explored]│
│  ☑ Home           67 pages  ~22m  [explored]│
│  ☐ Support/Docs   44 pages  ~15m  [auto]    │
│                                              │
│  Grand total: 261 pages · ~1h 22m            │
│  ──────────────────────────────────          │
│  [Continue to Configure →]                   │
└──────────────────────────────────────────────┘
```

### Component Changes

#### 1. Modify auto-add logic in `DiscoveryPanel.tsx`

**Current (line 315-364):** The auto-add logic tracks prefix groups in `prefixGroupsRef` and logs console entries when thresholds are met, but it **never creates actual `CrawlSection` objects**.

**Fix:** When `autoAddedPrefixesRef` fires, create a `CrawlSection` and call `onSectionsDiscovered`:

```typescript
// In the auto-add block (DiscoveryPanel.tsx ~line 348-364):
if (
  group.total >= AUTO_ADD_MIN_URLS &&
  group.verified >= AUTO_ADD_MIN_VERIFIED &&
  !autoAddedPrefixesRef.current.has(prefix)
) {
  autoAddedPrefixesRef.current.add(prefix);

  // NEW: Create an actual section from this prefix group
  const newSection: CrawlSection = {
    sectionId: `auto-${prefix}-${Date.now()}`,
    pattern: `/${prefix}/`,
    name: displayName,
    pageCount: group.total,
    examples: [], // filled by tree URLs matching this prefix
    included: true, // auto-included by default
    estimatedTime: estimateTimeRange(group.total, crawlConfig),
    warnings: [],
    depth: 1,
    source: 'explored',
    pages: [], // populated from discoveredUrlSet
  };

  // Emit to parent for merge into sections[]
  onSectionsAutoAdded?.([newSection]);
}
```

#### 2. New prop on `DiscoveryPanel`: `onSectionsAutoAdded`

```typescript
interface DiscoveryPanelProps {
  // ...existing
  onSectionsAutoAdded?: (sections: CrawlSection[]) => void;
}
```

Wire through: `BrowserDiscoveryInline` → `DiscoveryPanel` → `State2Analysis.handleSectionsDiscovered`.

#### 3. Add `[+sec]` button to `DiscoveryTree.tsx` tree nodes

For hub nodes (nodes with children and > 5 URLs in subtree), show a small "Add as section" button:

```typescript
// In TreeNodeRow (DiscoveryTree.tsx ~line 229):
{
  node.role === "hub" && node.children.length > 0 && subtreeCount > 5 && (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onAddAsSection?.(node);
      }}
      className="opacity-0 group-hover:opacity-100 text-[10px] text-accent hover:text-accent/80 transition-default"
      title={t("tree_add_as_section")} /* renders as tooltip "Add as section" */
    >
      <Plus className="w-3 h-3" />
    </button>  {/* Tooltip: "Add as section" */}
  );
}
```

New prop on `DiscoveryTree`: `onAddAsSection: (node: DiscoveryTreeNode) => void`

#### 4. Section card enhancements in `State2Analysis.tsx`

**Current:** Section cards show `pattern`, `name`, `pageCount`, `estimatedTime`, `warnings`, checkbox.

**Add:**

- Source badge: `[sitemap]` / `[explored]` / `[auto]`
- "Selected X / Available Y" counter at section list header
- Grand total row at bottom

#### 5. Section deduplication (with pattern normalization)

When auto-adding sections, normalize patterns before comparison to prevent false duplicates (`/support/` vs `/support` vs `support/printers/`):

```typescript
/** Normalize a URL pattern for deduplication: lowercase, strip leading/trailing slashes */
function normalizePattern(p: string): string {
  return p.toLowerCase().replace(/^\/+|\/+$/g, '');
}

/** Check if child pattern is a subset of parent pattern */
function isSubsetOf(child: string, parent: string): boolean {
  const nc = normalizePattern(child);
  const np = normalizePattern(parent);
  return nc.startsWith(np + '/') || nc === np;
}

function mergeSections(existing: CrawlSection[], incoming: CrawlSection[]): CrawlSection[] {
  const normalized = new Set(existing.map((s) => normalizePattern(s.pattern)));
  const deduped = incoming.filter((s) => {
    const np = normalizePattern(s.pattern);
    // Exact match → skip
    if (normalized.has(np)) return false;
    // Subset sections ARE allowed — user might want /support/printers but not all /support
    return true;
  });
  return [...existing, ...deduped];
}
```

### State/Data Flow

```
DiscoveryPanel detects prefix threshold
  → creates CrawlSection objects
  → calls onSectionsAutoAdded([...sections])
    → BrowserDiscoveryInline forwards via onSectionsDiscovered
      → State2Analysis.handleSectionsDiscovered merges into sections[]
        → CrawlFlowV5.handleSectionsChange persists to draft
```

### SSE/API Changes

**None.** The backend already emits `discoveredOnPage` with URLs. Section creation is a frontend operation.

### Modified Files

- `DiscoveryPanel.tsx` — add `onSectionsAutoAdded` prop, create sections in auto-add logic
- `DiscoveryTree.tsx` — add `onAddAsSection` prop, `[+sec]` button on hub nodes
- `BrowserDiscoveryInline.tsx` — forward new prop
- `State2Analysis.tsx` — section card redesign, source badges, grand total
- `types.ts` — add `'auto'` to `DiscoverySource` union

---

## O3: Recursive Page Counts

**Goal:** Each tree node shows recursive subtree page count, not just per-page `linkCount`.

### Before

```
☐ Printers (42)      ← linkCount: links ON this page, not IN this subtree
  ☐ Inkjet            ← no count shown
  ☐ Laser             ← no count shown
```

### After

```
☐ Printers  142 pages · ~45m     ← recursive count of all descendant URLs
  ☐ Inkjet   68 pages · ~22m
  ☐ Laser    74 pages · ~24m
```

### Component Changes

#### 1. New utility: `computeSubtreeCounts` in `discovery/tree-utils.ts`

```typescript
/**
 * Compute recursive URL counts for each node.
 * A node's count = its own verified URLs + sum of children's counts.
 * Returns a Map<nodeUrl, count> for O(1) lookup during render.
 */
export function computeSubtreeCounts(roots: DiscoveryTreeNode[]): Map<string, number> {
  const counts = new Map<string, number>();

  function postOrderCount(node: DiscoveryTreeNode): number {
    let count = node.state !== 'skipped' ? 1 : 0;
    for (const child of node.children) {
      count += postOrderCount(child);
    }
    counts.set(node.url, count);
    return count;
  }

  for (const root of roots) {
    postOrderCount(root);
  }
  return counts;
}
```

#### 2. Use in `DiscoveryTree.tsx`

```typescript
// In DiscoveryTree main component:
const subtreeCounts = useMemo(() => computeSubtreeCounts(nodes), [nodes]);

// Pass to TreeNodeRow:
const subtreeCount = subtreeCounts.get(node.url) ?? 0;
```

#### 3. Display in `TreeNodeRow`

Replace the current `linkCount` display:

```typescript
// Replace DiscoveryTree.tsx ~line 303-305:
// OLD: {node.linkCount != null && node.linkCount > 0 && (
//        <span>({node.linkCount})</span>
//      )}

// NEW:
{
  subtreeCount > 1 && (
    <span className="text-[10px] text-muted shrink-0">
      {subtreeCount} pages · ~{estimateTime(subtreeCount)}
    </span>
  );
}
```

#### 4. Section cards in State2Analysis show same counts

Section `pageCount` should reflect the recursive count from the tree, not just the cluster-reported count. When sections are created from auto-add or manual add-as-section, use the subtree count.

### State/Data Flow

Pure computation — `computeSubtreeCounts` is a `useMemo` derived from `nodes`. No new state, no API calls.

### Performance

- `postOrderCount` is O(n) where n = tree nodes.
- Memoized on `nodes` reference — only recomputes when tree changes.
- For 10K nodes: < 5ms (acceptable).

### Modified Files

- `discovery/tree-utils.ts` — add `computeSubtreeCounts`
- `DiscoveryTree.tsx` — use subtree counts, pass to `TreeNodeRow`
- `State2Analysis.tsx` — use recursive counts in section cards

---

## O4: Mid-Discovery Interventions

**Goal:** Explore branch, skip branch, explore all at level, add sample URL, collapse discovery inline, background discovery across KB pages — scales to multiple concurrent discoveries.

### Current State

The intervention infrastructure is **already built**:

- `DiscoveryTree.tsx` has bulk action bar with Explore, Skip, Explore All, Add to Scope, Undo Skip
- `DiscoveryPanel.tsx` has `handleExplore`, `handleSkip`, `handleExploreAll`, `handleAddToScope`, `handleAddSample`
- `BrowserDiscoveryInline.tsx` sends interventions via `sendBrowserIntervention`
- Backend route `crawl-browser-discover.ts` has intervention endpoint
- Server supports up to 50 concurrent discoveries (`crawl-discover.ts:59`)
- CrawlDraft already persists `discoveryState` for resume

### Architecture Context

CrawlFlowV5 lives inside a **non-blocking `SlidePanel`** (`CrawlFlowPanel` in `AddSourceButton.tsx`). The panel slides in from the right over the KB page — the main page content (Data tab, Sources table, etc.) remains visible and interactive behind it.

**Layout hierarchy:**

```
KBDetailLayout
  ├── KBHeader (fixed — back arrow, KB name, metrics, settings)
  ├── KBSectionNav (fixed — tabs: Home | Data | Intelligence | Search)
  ├── Content area (scrollable — switches between Home/Data/Intelligence/Search)
  ├── SettingsPanel (SlidePanel overlay)
  └── CrawlFlowPanel (SlidePanel overlay, nonBlocking, right side)
        └── CrawlFlowV5 (state machine: url-entry → analyzing → configure → crawling)
```

### What's Missing

The design provides two complementary backgrounding modes that work together:

- **Option A (Inline Collapse):** Collapse the discovery tree to a compact status bar _within_ the open CrawlFlowPanel. SSE stays connected (component mounted, just CSS-hidden). User can review/edit sections while discovery runs.
- **Option B (KB-Level Activity Bar):** Close the CrawlFlowPanel entirely. A persistent activity bar appears in `KBDetailLayout` between the section nav and content area. User can navigate across KB tabs while discovery continues server-side.

Both scale to N concurrent discoveries — each is tracked by its CrawlDraft `draftId`.

### Option A: Inline Collapse (within CrawlFlowPanel)

**STATE 1: Discovery running, panel open (current behavior + new actions)**

```
┌─── CrawlFlowPanel ─────────────────────────────────────────┐
│ Web Crawler                                      [_] [×]   │
│ ───────────────────────────────────────────────────────────│
│ ① URL  ──✓── ② Review ── ③ Configure ── ④ Crawl           │
│                                                             │
│ ┌─ Discovery ──────────────────────────────────────────┐   │
│ │                                                       │   │
│ │  🟢 Browser exploring epson.com                       │   │
│ │  142 URLs found · 23 pages visited · 8.2 URLs/page   │   │
│ │                                                       │   │
│ │  ▼ epson.com                                          │   │
│ │    ▼ /support                                         │   │
│ │      ▶ /support/printers (87 pages)                   │   │
│ │      ▶ /support/scanners (42 pages)                   │   │
│ │    ▶ /products (13 pages)                             │   │
│ │                                                       │   │
│ │  [Explore Selected] [Skip Selected] [Add URL]         │   │
│ │                                                       │   │
│ │              [▲ Collapse]  [■ Stop Discovery]         │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                             │
│ ┌─ Sections (live-updating) ───────────────────────────┐   │
│ │  ☑ /support/printers      87 pages   ~12 min         │   │
│ │  ☑ /support/scanners      42 pages   ~6 min          │   │
│ │  ☐ /blog                  13 pages   ~2 min          │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                             │
│                                     [Continue to Configure →]│
└─────────────────────────────────────────────────────────────┘
```

User has two new actions: **[▲ Collapse]** and **[×] (close panel)**

**STATE 2a: Collapsed within panel (user clicked [▲ Collapse])**

Discovery panel shrinks to a single status bar. Sections remain visible and editable. SSE stays connected (component still mounted, just CSS-hidden).

```
┌─── CrawlFlowPanel ─────────────────────────────────────────┐
│ Web Crawler                                      [_] [×]   │
│ ───────────────────────────────────────────────────────────│
│ ① URL  ──✓── ② Review ── ③ Configure ── ④ Crawl           │
│                                                             │
│ ┌─ Discovery ──────────────────────────────────────────┐   │
│ │ 🟢 Exploring — 142 URLs · 8.2/pg · productive       │   │
│ │                                  [▼ Expand] [■ Stop] │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                             │
│ ┌─ Sections (3) ───────────────────────────────────────┐   │
│ │  Filter: [____________]                               │   │
│ │                                                       │   │
│ │  ☑ /support/printers         87 pages     ~12 min    │   │
│ │    epson.com/support/printers/xp-4200                 │   │
│ │    epson.com/support/printers/et-2800                  │   │
│ │    +85 more                                           │   │
│ │                                                       │   │
│ │  ☑ /support/scanners         42 pages     ~6 min     │   │
│ │    epson.com/support/scanners/ds-530                   │   │
│ │    +41 more                                           │   │
│ │                                                       │   │
│ │  ☐ /blog                     13 pages     ~2 min     │   │
│ │    epson.com/blog/2024/print-tips                      │   │
│ │    +12 more                                           │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                             │
│  Total: 129 pages selected · ~18 min estimated              │
│                                                             │
│                                     [Continue to Configure →]│
└─────────────────────────────────────────────────────────────┘
```

**Key behaviors:**

- Sections update live as discovery finds more URLs
- User can check/uncheck sections, expand them, review pages
- User can click **[Continue to Configure →]** to move to Step 3 while discovery runs
- **[▼ Expand]** restores the full tree view (State 1)
- **[■ Stop]** sends stop signal, sections finalize

**STATE 3: Navigated to Configure while discovery still runs**

User clicked **[Continue to Configure →]** from State 2a. A mini-bar at the top of Step 3 shows discovery is still running.

```
┌─── CrawlFlowPanel ─────────────────────────────────────────┐
│ Web Crawler                                      [_] [×]   │
│ ───────────────────────────────────────────────────────────│
│ ① URL  ──✓── ② Review ──✓── ③ Configure ── ④ Crawl        │
│                                                             │
│ ┌─ 🟢 Discovery still running ────────────────────────┐   │
│ │  187 URLs found · productive · 3 sections growing    │   │
│ │                              [Back to Review] [Stop] │   │
│ └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Scope                                                      │
│  ○ Limited (selected sections only)                         │
│  ○ Full site                                                │
│                                                             │
│  Rendering                                                  │
│  ○ Hybrid (auto HTTP/browser per page)                      │
│  ○ Browser only                                             │
│  ○ HTTP only                                                │
│                                                             │
│  Settings                                                   │
│  Max pages: [1000]   Depth: [5]   Delay: [200ms]           │
│  ☑ Respect robots.txt   ☑ Deduplicate   ☑ Cookie consent   │
│                                                             │
│              [← Back]              [Start Crawl →]          │
│                                                             │
│  ⚠ Discovery is still finding pages. Starting now will     │
│    crawl the 187 URLs found so far. You can wait for       │
│    discovery to finish or start with current results.       │
└─────────────────────────────────────────────────────────────┘
```

**Implementation:**

Add `isMinimized` boolean to `State2Analysis`:

```typescript
const [isMinimized, setIsMinimized] = useState(false);
```

When minimized, keep `BrowserDiscoveryInline`/`ExplorePanel` mounted but CSS-hidden (`className="hidden"`). SSE connection stays open. Show compact status bar instead.

### Option B: KB-Level Activity Bar (panel closed)

**Close confirmation dialog:** When user clicks [×] on CrawlFlowPanel while discovery is running:

```
┌─── CrawlFlowPanel ─────────────────────────────────────────┐
│ Web Crawler                                      [_] [×]   │
│                                                             │
│  ⚠ Discovery is still running for epson.com.               │
│                                                             │
│  ○ Minimize to activity bar (discovery continues)          │← default
│  ○ Stop discovery & save progress                           │
│  ○ Discard discovery                                        │
│                                                             │
│                          [Cancel]   [Confirm]               │
└─────────────────────────────────────────────────────────────┘
```

**Activity bar placement:** Conditional row between `KBSectionNav` and content area in `KBDetailLayout`. Zero height when no active discoveries.

```tsx
// KBDetailLayout render (the ONLY layout change):
<div className="h-full flex flex-col bg-background">
  <KBHeader />
  <KBSectionNav />
  {activeDiscoveries.length > 0 && <DiscoveryActivityBar discoveries={activeDiscoveries} />}
  <div className="flex-1 overflow-y-auto px-6 py-6">{renderContent()}</div>
</div>
```

**Single discovery — compact single-line bar:**

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Epson Support       3 sources · 1,247 docs · Active    [⚙] │
├─────────────────────────────────────────────────────────────────┤
│  🏠 Home  │  📁 Data  │  🧠 Intelligence  │  🔍 Search        │
├─────────────────────────────────────────────────────────────────┤
│ 🟢 epson.com — 142 URLs found · 3 sections    [Resume] [Stop] │ ← activity bar
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  (scrollable content area — Home/Data/Intelligence/Search)      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Multiple discoveries — expandable list:**

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Enterprise Support  5 sources · 3,412 docs · Active    [⚙] │
├─────────────────────────────────────────────────────────────────┤
│  🏠 Home  │  📁 Data  │  🧠 Intelligence  │  🔍 Search        │
├─────────────────────────────────────────────────────────────────┤
│ Active Discoveries (3)                              [Collapse ▲]│
│                                                                 │
│  🟢 epson.com    142 URLs · 3 sections · productive             │
│                                             [Resume] [Stop]     │
│  🟢 hp.com        67 URLs · 2 sections · exploring              │
│                                             [Resume] [Stop]     │
│  ✓  canon.com    Done — 312 URLs · 5 sections                  │
│                                       [Review Results] [Dismiss]│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  (content area)                                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Multiple discoveries collapsed:**

```
│ 🟢 3 discoveries active                            [Expand ▼]  │
```

**Discovery completes while panel is closed — banner transitions:**

```
│ ✓ epson.com — Discovery complete · 247 URLs · 3 sections  [Review Results] │
```

**User on Data tab with panel open for hp.com + epson.com in background:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ← Enterprise Support  5 sources · 3,412 docs · Active              [⚙]   │
├─────────────────────────────────────────────────────────────────────────────┤
│  🏠 Home  │  📁 Data  │  🧠 Intelligence  │  🔍 Search                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 🟢 epson.com — 142 URLs · 3 sections              [Resume] [Stop]        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  [+ Add Source]   [Sources ▾]  [Documents ▾]                              │
│                                                                            │
│  ┌─────────────────────────────────┐   ┌─── CrawlFlowPanel (hp.com) ────┐│
│  │ Source      │ Type │ Status     │   │ Web Crawler            [_] [×]  ││
│  ├─────────────┼──────┼────────────│   │ ─────────────────────────────── ││
│  │ epson.com   │ web  │ ● Active   │   │ ①✓ ② Review ── ③ ── ④          ││
│  │ support-doc │ file │ ● Active   │   │                                 ││
│  │             │      │            │   │  🟢 Browser exploring hp.com    ││
│  │             │      │            │   │  67 URLs · 8 pages visited      ││
│  │             │      │            │   │                                 ││
│  │             │      │            │   │  ▼ hp.com                       ││
│  │             │      │            │   │    ▶ /support (42)              ││
│  │             │      │            │   │    ▶ /products (25)             ││
│  │             │      │            │   │                                 ││
│  │             │      │            │   │  [▲ Collapse] [■ Stop]          ││
│  └─────────────────────────────────┘   └─────────────────────────────────┘│
│                                                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

Activity bar shows epson.com (backgrounded). CrawlFlowPanel shows hp.com (actively being configured). No conflicts.

### Transition Map

```
State 1 (full discovery view, panel open)
  │
  ├── [▲ Collapse] ──→ State 2a (collapsed bar + sections, SSE stays)
  │                        │
  │                        ├── [▼ Expand] ──→ back to State 1
  │                        ├── [Continue →] ──→ State 3 (configure, mini-bar persists)
  │                        └── [×] close panel ──→ Confirmation dialog
  │
  ├── [×] close panel ──→ Confirmation dialog
  │                        │
  │                        ├── "Minimize to activity bar" ──→ State 2b
  │                        │     Panel closes, draft.discoveryStatus = 'running'
  │                        │     Activity bar appears in KBDetailLayout
  │                        │     Server keeps running (SSE disconnects, crawl continues)
  │                        │
  │                        ├── "Stop & save" ──→ sends stop, saves draft, panel closes
  │                        │     draft.discoveryStatus = 'stopped'
  │                        │
  │                        └── "Discard" ──→ sends stop, deletes draft, panel closes
  │
  └── [■ Stop] ──→ discovery ends, sections finalize, normal flow

State 2b (KB activity bar, panel closed)
  │
  ├── [Resume] ──→ opens CrawlFlowPanel with draftId → State 1 or 2a
  │     Reconnects SSE, restores tree/sections from draft
  │
  ├── [Stop] ──→ stops server-side discovery, draft saved
  │     Bar transitions to "✓ Done — [Review Results]"
  │
  └── (discovery finishes naturally) ──→ bar transitions to "✓ Done"
```

### Technical Requirements

**State management:** Zustand store (`useDiscoveryStore`) tracks backgrounded discovery/crawl draftIds — survives component mounts/unmounts within the session. On mount, `DiscoveryActivityBar` queries the CrawlDraft API for drafts with `discoveryStatus: 'running'` or `'complete'` to restore state after page refresh.

**Activity bar polling (C1 fix):** When the panel is closed and SSE is disconnected, the activity bar polls the draft API every 10 seconds for updated counts (`GET /drafts/:id/status` — returns `discoveredCount`, `sectionCount`, `discoveryStatus`). This is lightweight (single field read, no full draft load). Polling stops when the user opens the panel (SSE takes over) or when discovery completes.

**Resume state restoration (C2 fix):** When the user clicks [Resume] on a backgrounded discovery:

1. Panel opens with draftId → CrawlFlowV5 loads draft (sections, config, profile — already works)
2. Discovery SSE reconnects via `GET /discover/:id` — server replays current progress state
3. **Tree state is NOT restored** — the tree is rebuilt from incoming SSE events going forward. Sections (which are what the user actually needs) ARE restored from the draft. The tree is a navigation aid; sections are the data that matters.
4. If discovery already completed while backgrounded, user sees final sections with "Discovery complete" status — no SSE needed.

**Panel switching (H1 fix):** When user clicks [Resume] on a backgrounded discovery while another source's panel is already open, show a prompt: "You have hp.com open. Save progress and switch to epson.com?" with [Switch] and [Cancel]. The Zustand store tracks `activePanelDraftId` to prevent double-mounting.

**Server-side:** HTTP discovery (`crawl-discover.ts`) runs in-process and is NOT tied to SSE connection lifetime — it continues after SSE disconnect. Browser discovery (`crawl-browser-discover.ts`) proxies to MCP server — the MCP session continues independently of the SSE stream (the SSE is read-only progress, not a control channel).

**Draft model:** Add `discoveryStatus: 'idle' | 'running' | 'complete' | 'stopped'` to CrawlDraft schema. Set on discovery start/stop/complete. Activity bar queries by this field.

**No existing layout changes beyond:**

- `KBDetailLayout.tsx` — one conditional render line for `<DiscoveryActivityBar />`
- `CrawlFlowPanel` (inside `AddSourceButton.tsx`) — close handler intercept when discovery running

### What's Missing (intervention enhancements)

#### 1. "Add sample URL mid-discovery"

**Already implemented** in `DiscoveryTree.tsx` (the `AddSampleUrlInput` component at line 393-436). The `onAddSample` prop is wired through `DiscoveryPanel.handleAddSample` → `BrowserDiscoveryInline.handleDiscoveryAction` → `sendBrowserIntervention`.

**Enhancement needed:** Show a suggestion when yield drops: "Discovery is slowing down. Try adding a URL from a different section of the site."

This hooks into the existing `suggestMoreDiscovery` state in `DiscoveryPanel.tsx:148`.

#### 2. Per-node action buttons (inline, not just bulk)

**Current:** Actions require selecting nodes first, then using the bulk action bar.

**Enhancement:** On hover, show inline action buttons per node:

```typescript
// In TreeNodeRow, after the existing badges:
<div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 ml-auto">
  {isRunning && node.state === 'discovered' && (
    <button onClick={() => onExplore(node.url)} title="Explore">
      <Compass className="w-3 h-3 text-accent" />
    </button>
  )}
  {node.state !== 'skipped' && (
    <button onClick={() => onSkip(node.url)} title="Skip">
      <X className="w-3 h-3 text-error/60" />
    </button>
  )}
</div>
```

### New Files

- `apps/studio/src/components/search-ai/crawl-flow/DiscoveryActivityBar.tsx` — KB-level activity bar
- `apps/studio/src/store/discovery-store.ts` — Zustand store for backgrounded discovery tracking

### Modified Files

- `KBDetailLayout.tsx` — add conditional `<DiscoveryActivityBar />` render (1 line)
- `AddSourceButton.tsx` (CrawlFlowPanel) — close handler with confirmation dialog
- `State2Analysis.tsx` — add `isMinimized` state, collapse/expand toggle
- `DiscoveryTree.tsx` — inline action buttons per node on hover
- `DiscoveryPanel.tsx` — yield-based suggestion enhancement

---

## O5: Extraction Preview

**Goal:** Preview button shows 2-3 sample pages with extracted content, quality score, and informational rendering advisory.

### Before

```
Step 3: Configure
  [scope settings]
  [rendering settings]
  [Start Crawl →]
  ← No way to see what content will look like
```

### After

```
Step 3: Configure
  ┌─ Extraction Preview ──────────────────────────────────┐
  │  Preview 3 sample pages from your selected sections   │
  │  [Run Preview]                                        │
  │                                                       │
  │  ✓ /support/printers/xp-4200                          │
  │    Title: "Epson XP-4200 Support"                     │
  │    Words: 1,247 · Quality: ████░ Good                 │
  │    Content: "The Epson Expression Home XP-4200..."    │
  │                                                       │
  │  ⚠ /support/printers/et-2800                          │
  │    Title: "Epson ET-2800"                              │
  │    Words: 89 · Quality: █░░░░ Thin                    │
  │    ℹ JS content detected — crawler will auto-use      │
  │      browser mode for pages like this                  │
  │                                                       │
  │  ✓ /products/scanners/ds-530                          │
  │    Title: "Epson DS-530 II"                            │
  │    Words: 2,104 · Quality: █████ Rich                 │
  └───────────────────────────────────────────────────────┘
```

### Current State

`PreviewPanel.tsx` already exists and is used in `State3Configure.tsx`. It calls `previewExtraction(url, baseUrl)` which returns:

```typescript
{
  url, title, excerpt, cleanedHtml, wordCount, imageCount,
  metadata: { contentLength, textContentLength, sizeReduction, originalSize, cleanedSize },
  jsRenderingAdvised
}
```

### Component Changes

#### 1. New component: `BatchPreviewPanel.tsx`

Calls `previewExtraction` for 2-3 sample URLs from included sections (picking one example from each section, max 3).

```typescript
interface BatchPreviewPanelProps {
  sections: CrawlSection[];
  baseUrl: string;
  renderingMode: RenderingMode; // display-only — shows current mode for context
}
```

**Auto-sample selection (prefer leaf pages over hub/index pages):**

```typescript
/** Pick representative preview URLs — prefer deepest paths (leaf content, not hub/index pages) */
function pickPreviewUrls(sections: CrawlSection[], max: number = 3): string[] {
  const included = sections.filter((s) => s.included);
  const urls: string[] = [];
  for (const section of included) {
    if (urls.length >= max) break;
    // Sort pages by path depth (descending) — deepest = most likely to be leaf content
    const sorted = [...(section.pages ?? [])].sort(
      (a, b) => b.url.split('/').length - a.url.split('/').length,
    );
    const leaf = sorted[0]?.url ?? section.examples?.[section.examples.length - 1];
    if (leaf && !urls.includes(leaf)) {
      urls.push(leaf);
    }
  }
  return urls;
}
```

**Manual override:** Users can also manually pick preview URLs from a dropdown of section pages (each section's examples are expandable in the preview panel).

#### 2. Quality score visualization

```typescript
function QualityBar({ score }: { score: number }) {
  // score: 0-1, maps to 5 bars
  const filled = Math.round(score * 5);
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          className={clsx(
            "w-2 h-3 rounded-sm",
            i < filled ? "bg-success" : "bg-background-muted",
          )}
        />
      ))}
    </div>
  );
}
```

#### 3. JS rendering advisory (informational, not actionable)

The crawl worker (`intelligence-crawl-worker.ts:498-533`) already auto-decides per-page: HTTP-first with Playwright fallback via `FailureScorer`. The preview advisory is informational only — no manual switch button needed.

When `jsRenderingAdvised === true`, show an info note:

```
ℹ Some pages require JS rendering — the crawler will automatically
  use browser mode for those pages (hybrid mode).
```

This reassures the user without adding a redundant manual control. The `renderingMode` config already defaults to `'hybrid'` which handles this automatically.

#### 4. Loading state

Each preview card renders sequentially as results arrive. While loading, show skeleton:

```
│  ░░░░ Extracting /support/printers/xp-4200...              │
│    ░░░░░░░░░░░░░░░░░░░░░░░░░░                              │
```

Cards fill in one at a time so users see progress rather than all-at-once blank→populated.

#### 5. Integration in State3Configure

Add a collapsible "Preview extraction quality" section above the Start Crawl button:

```typescript
// State3Configure.tsx, before the action bar:
<BatchPreviewPanel
  sections={sections}
  baseUrl={baseUrl ?? ""}
  renderingMode={config.rendering}
/>
```

### SSE/API Changes

**None.** Uses existing `previewExtraction` API endpoint (`POST /api/search-ai/crawl/preview`).

### New Files

- `apps/studio/src/components/search-ai/crawl-flow/BatchPreviewPanel.tsx`

### Modified Files

- `State3Configure.tsx` — integrate `BatchPreviewPanel`

---

## O6: Step 4 Crawl Progress

**Goal:** After clicking "Start Crawl," the panel stays open showing live progress, per-section bars, failure transparency, completion summary.

### Current State

**Step 4 already works.** `State4Crawl.tsx` is functional with:

- Overall progress bar
- Phase cards (crawled, processed, failed)
- Quality breakdown (good/thin/empty)
- Section fill rates
- Failure groups
- Cancel/back with confirmations

**What's missing:**

1. **Minimize to banner** — user can shrink the panel to a floating indicator
2. **Per-section progress bars** — currently only shows fill rates if `multiPage.groupProgress` has data, which requires backend group tracking
3. **Completion summary** — a final card with actionable stats

### Component Changes

#### 1. Background crawl via KB activity bar (unified with discovery)

Crawl backgrounding uses the **same KB-level activity bar** as discovery (O4) — no separate floating banner. This keeps the backgrounding pattern consistent across the entire flow.

When the user closes the CrawlFlowPanel during an active crawl, the close confirmation dialog offers the same three options as during discovery. The activity bar shows crawl progress:

```
│ 🔵 epson.com — Crawling: 142/305 pages (47%) · 12 failed  [Resume] [Cancel] │
```

CrawlJob already has `userId` for ownership. The Zustand `useDiscoveryStore` is extended to track both backgrounded discoveries AND crawls.

No new component needed — `DiscoveryActivityBar` handles both item types.

#### 2. Completion summary card

After crawl completes, show:

```
┌─ Crawl Complete ─────────────────────────────────────────┐
│  ✓ 289 pages crawled successfully                        │
│  ⚠ 16 pages had thin content (consider browser mode)     │
│  ✗ 12 pages failed (3 timeout, 9 blocked)                │
│                                                          │
│  Quality: ████████░░ 82% good                            │
│  Time: 1h 22m                                            │
│                                                          │
│  [View 16 thin pages]  [View Results →]                  │
└──────────────────────────────────────────────────────────┘
```

#### 3. Per-section progress bars with backend group tracking

**Backend change needed:** The batch crawl submission should tag URLs with their section ID so the progress WebSocket can report per-group progress.

**Current submit flow:** `submitBatchCrawl` sends flat `urls[]` array. The backend `crawl.ts` creates a BullMQ job.

**Enhancement:** Include section mapping in the request:

```typescript
// In CrawlFlowV5.handleStartCrawl, change:
const result = await submitBatchCrawl({
  urls: allUrls,
  indexId,
  sourceId: source._id,
  strategy: strategyMap[crawlConfig.rendering] ?? "smart",
  limits: { maxPages: crawlConfig.maxPages, maxDepth: ... },
  filters: {},
  // NEW: section mapping for per-group progress
  sectionMapping: includedSections.map((s) => ({
    sectionId: s.sectionId ?? "",
    pattern: s.pattern,
    name: s.name,
    urls: (s.pages ?? []).map((p) => p.url),
  })),
});
```

**Backend route change:** Accept `sectionMapping` in the batch crawl body, store in the job metadata, emit per-section progress events via WebSocket.

### SSE/API Changes

- **`POST /api/search-ai/crawl/batch`** — accept optional `sectionMapping` field
- **WebSocket progress events** — emit `group_progress` events with section-level counts

### New Files

- `apps/studio/src/components/search-ai/crawl-flow/CrawlCompletionSummary.tsx`

### Modified Files

- `State4Crawl.tsx` — add minimize button, completion summary card
- `CrawlFlowV5.tsx` — add `isCrawlMinimized` state, floating banner for crawl
- `apps/search-ai/src/routes/crawl.ts` — accept `sectionMapping` in batch endpoint

---

## O7: Document/File Type Discovery

**Goal:** PDFs, DOCs, and other file types discovered during crawling are shown with type counts, checkboxes per type, and Docling routing.

**Scope clarification:** Discovered file URLs are included in the same web source (not a separate source type). They appear as documents alongside HTML pages in the Sources/Documents table. File processing uses the Docling service (port 8080) for PDF/DOC extraction — if Docling is not running, file types are still discoverable but show a warning: "Document processing service not available — file content will not be extracted."

### Before

```
SKIP_EXTENSIONS in discover-crawler.ts:
  ['.pdf', '.doc', '.docx', '.xls', '.ppt', ...]
  → All non-HTML links silently dropped
```

### After

```
┌─ Discovered Content Types ──────────────────────────────┐
│  ☑ Web pages    247 pages   ~1h 22m                     │
│  ☑ PDF files     34 files   ~11m    [Docling]           │
│  ☐ DOC files      8 files   ~3m     [Docling]           │
│  ☐ XLS files      2 files   ~1m     [Table extract]     │
│                                                         │
│  Sections with mixed content:                           │
│    Printers: 142 pages + 12 PDFs (manuals)              │
│    Support:   52 pages +  8 PDFs (guides)               │
└─────────────────────────────────────────────────────────┘
```

### Component Changes

#### 1. New type: `FileTypeCount` in `types.ts`

```typescript
interface FileTypeCount {
  extension: string; // '.pdf', '.docx', etc.
  label: string; // 'PDF files'
  count: number;
  totalSizeBytes?: number;
  processingMethod: 'docling' | 'table-extract' | 'skip';
  included: boolean;
}
```

#### 2. Track file types in `DiscoveryPanel.tsx`

**Current:** `discoveredUrlSetRef` tracks all URLs. File extensions are not categorized.

**Change:** Add a `fileTypeCounts` ref and update it as URLs are discovered:

```typescript
const fileTypeCountsRef = useRef<Map<string, FileTypeCount>>(new Map());

// In the progress processing effect, when discoveredOnPage has URLs:
for (const link of progress.discoveredOnPage) {
  const ext = getExtension(link.href); // '.pdf', '.html', ''
  if (ext && DOCUMENT_EXTENSIONS.has(ext)) {
    const existing = fileTypeCountsRef.current.get(ext);
    if (existing) {
      existing.count++;
    } else {
      fileTypeCountsRef.current.set(ext, {
        extension: ext,
        label: FILE_TYPE_LABELS[ext] ?? ext,
        count: 1,
        processingMethod: DOCLING_EXTENSIONS.has(ext) ? 'docling' : 'skip',
        included: ext === '.pdf', // PDFs default on (most common/valuable); others opt-in
      });
    }
  }
}
```

#### 3. New component: `FileTypeSelector.tsx`

Renders below the section checklist in `State2Analysis`:

```typescript
interface FileTypeSelectorProps {
  fileTypes: FileTypeCount[];
  onToggle: (extension: string, included: boolean) => void;
}
```

#### 4. Section composition badges

On each section card, show content composition:

```
☑ Printers  142 pages + 12 PDFs  ~45m  [explored]
```

This requires tracking which file types belong to which sections. The `CrawlSection` type needs a new field:

```typescript
interface CrawlSection {
  // ...existing
  fileTypeCounts?: Record<string, number>; // { '.pdf': 12, '.docx': 3 }
}
```

### Backend Changes

#### 1. Stop skipping file URLs in discovery

**File:** `apps/search-ai/src/services/crawler/discover-crawler.ts`

**Current:** `SKIP_EXTENSIONS` array filters out all non-HTML links.

**Change:** Keep file URLs but tag them with their extension. Don't follow them for link discovery (they're leaf nodes), but include them in the discovered URL set with a `type: 'document'` flag.

#### 2. File URLs in SSE progress events

Add `fileType` field to `discoveredOnPage` entries:

```typescript
discoveredOnPage: [
  {
    href: '/manuals/printer-xp4200.pdf',
    text: 'XP-4200 Manual',
    confidence: 'verified',
    fileType: 'pdf', // NEW
  },
];
```

### SSE/API Changes

- **SSE `progress` event:** Add `fileType` field to `discoveredOnPage` entries
- **`POST /api/search-ai/crawl/batch`:** Accept `documentUrls` array alongside `urls`, with processing method per URL

### New Files

- `apps/studio/src/components/search-ai/crawl-flow/FileTypeSelector.tsx`

### Modified Files

- `DiscoveryPanel.tsx` — track file types during discovery
- `State2Analysis.tsx` — render `FileTypeSelector`, section composition badges
- `types.ts` — add `FileTypeCount`, extend `CrawlSection`
- `BrowserDiscoveryInline.tsx` — forward file type data
- Backend: `discover-crawler.ts` — stop dropping file URLs
- Backend: `crawl-browser-discover.ts` — include `fileType` in SSE events

---

## O8: robots.txt and Rate Limiting

**Goal:** Transparent robots.txt handling, crawl speed slider, per-domain limits, Crawl-delay honored.

### Before

```
Step 3: Configure
  Request delay: 200ms (hardcoded input)
  ☑ Respect robots.txt (checkbox exists but does nothing)
```

### After

```
┌─ Crawl Politeness ──────────────────────────────────────┐
│                                                          │
│  robots.txt                                              │
│  ✓ Found and parsed                                      │
│    Crawl-delay: 2s (we'll honor this)                    │
│    Disallowed: /admin/*, /api/*, /search?*                │
│    Your sections affected: 0 (all clear)                  │
│                                                          │
│  Crawl Speed                                             │
│  ──────────────●──────────── 500ms                       │
│  Fast (200ms) ◄────────────► Polite (5s)                 │
│  Recommended: 500ms (Crawl-delay: 2s will override)      │
│                                                          │
│  Rate Limiting                                           │
│  ☑ Honor Crawl-delay headers                             │
│  ☑ Back off on 429 responses (auto-retry with delay)     │
│  Max concurrent: 3 requests                              │
└──────────────────────────────────────────────────────────┘
```

### Component Changes

#### 1. New component: `RobotsTxtCard.tsx`

Shows the fetched robots.txt analysis:

```typescript
interface RobotsTxtCardProps {
  robotsData: RobotsTxtAnalysis | null;
  isLoading: boolean;
  sections: CrawlSection[];
}

interface RobotsTxtAnalysis {
  found: boolean;
  crawlDelay?: number; // seconds
  disallowedPaths: string[];
  allowedPaths: string[];
  sitemapUrls: string[];
  affectedSections: string[]; // section names that overlap with disallowed paths
}
```

#### 2. Crawl speed slider enhancement in `State3Configure.tsx`

**Current (line ~96):** Simple `requestDelay` number input.

**Change:** Replace with a visual slider:

```typescript
<div className="space-y-2">
  <label className="text-xs font-medium text-foreground">
    {t('crawl_speed')}
  </label>
  <input
    type="range"
    min={effectiveMinDelay} // 200ms default, or robots.txt Crawl-delay if higher
    max={5000}
    step={100}
    value={config.requestDelay}
    onChange={(e) => updateConfig('requestDelay', Number(e.target.value))}
    className="w-full accent-accent"
  />
  <div className="flex justify-between text-[10px] text-muted">
    <span>{t('speed_polite')} ({effectiveMinDelay >= 1000 ? `${effectiveMinDelay/1000}s` : `${effectiveMinDelay}ms`})</span>
    <span>{config.requestDelay}ms</span>
    <span>{t('speed_fast')} (5s)</span>
  </div>
  {/* Slider: left = low delay = fast, right = high delay = polite.
      Labels match: left says "Fast", right says "Polite". */}
  {config.requestDelay < 500 && (
    <p className="text-xs text-warning">
      {t('speed_aggressive_warning')} {/* "Fast speeds may trigger rate limiting on some sites" */}
    </p>
  )}
  {robotsData?.crawlDelay && config.requestDelay < robotsData.crawlDelay * 1000 && (
    <p className="text-xs text-warning">
      {t('crawl_delay_override', { delay: robotsData.crawlDelay })}
    </p>
  )}
</div>
```

**Note:** Minimum delay is 200ms (not 100ms — too aggressive for production use). If robots.txt specifies a Crawl-delay, the slider minimum is raised to that value — the user cannot go below the site's stated preference. `effectiveMinDelay = Math.max(200, (robotsData?.crawlDelay ?? 0) * 1000)`.

#### 3. Fetch robots.txt during profiling

**Current:** `profileSite` in `crawl.ts` returns site characteristics but doesn't analyze robots.txt.

**Backend change:** Add robots.txt analysis to the profile response:

```typescript
// In ProfileResponse:
robotsTxt?: {
  found: boolean;
  crawlDelay?: number;
  disallowedPaths: string[];
  sitemapUrls: string[];
}
```

**Or** create a separate endpoint: `POST /api/search-ai/crawl/robots` that takes a URL and returns the analysis. This keeps profiling fast.

### Backend Changes

#### 1. robots.txt fetching and parsing

**New service:** `apps/search-ai/src/services/crawler/robots-parser.ts`

```typescript
export async function analyzeRobotsTxt(url: string): Promise<RobotsTxtAnalysis> {
  const robotsUrl = new URL('/robots.txt', url).href;
  // Fetch with timeout, parse rules, extract Crawl-delay
}
```

#### 2. Expose via profile or separate endpoint

Option A: Include in `profileSite` response (adds ~200ms to profiling).
Option B: Separate `POST /crawl/robots` endpoint (parallel fetch in UI).

**Recommendation:** Option B (parallel) — keeps profiling fast, robots.txt is fetched while the user reviews sections.

### SSE/API Changes

- **New endpoint:** `POST /api/search-ai/crawl/robots` — accepts `{ url }`, returns `RobotsTxtAnalysis`
- **`POST /api/search-ai/crawl/batch`:** Add `respectRobotsTxt`, `crawlDelay`, `maxConcurrent` to the request body

### New Files

- `apps/studio/src/components/search-ai/crawl-flow/RobotsTxtCard.tsx`
- `apps/search-ai/src/services/crawler/robots-parser.ts`

### Modified Files

- `State3Configure.tsx` — add `RobotsTxtCard`, crawl speed slider
- `apps/search-ai/src/routes/crawl.ts` — new `/robots` endpoint, honor settings in batch
- `apps/studio/src/api/crawl.ts` — add `analyzeRobotsTxt` client function
- `types.ts` — add `RobotsTxtAnalysis` interface

---

## Multi-User Access Model

Discovery and crawl are shared resources that affect the whole KB. The access model is simple: **owner controls, others observe.**

### Why not full collaboration?

Conflicting commands (User A explores a branch, User B skips it) would create chaos. Building claim/release/presence tracking is 2-3 days of work for a scenario that rarely occurs — most KBs are configured by 1 person, and discovery takes minutes, not hours. The simple model below costs ~0.5 days.

### Access Rules

| Phase                     | Owner (`createdBy` / `job.userId`)        | Other team members                                                                                                                         |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Draft** (pre-discovery) | Full control: edit, resume, delete        | **Not visible** — drafts are WIP scratch pads                                                                                              |
| **Discovery running**     | Full control: interventions, stop, resume | **View-only in activity bar**: see domain, URL count, section count. No action buttons. Shows owner name: "Alice is discovering epson.com" |
| **Crawl running**         | Full control: cancel, resume              | **View-only in activity bar**: see progress, no cancel. Shows: "Alice's crawl — 45/142 pages"                                              |
| **Crawl complete**        | Full access to results                    | **Full access** — results are in the shared KB                                                                                             |

### Duplicate Discovery Prevention

When a user enters a URL in State1, check for active drafts on the same domain in the same KB:

| Scenario                                             | UX                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Same domain already being discovered by another user | Warning: "Alice is already discovering epson.com (142 URLs). [View progress] or [Start anyway]"            |
| Same domain discovered recently (within 1 hour)      | Info: "Alice discovered epson.com 10 min ago (247 URLs, 3 sections). [Use those results] or [Start fresh]" |
| Different domain                                     | No conflict — proceed normally                                                                             |

**"Use those results":** Copies sections/URLs from the completed draft into a new draft for the current user. The original draft is untouched.

**Implementation:** Single query on URL submit: `CrawlDraft.findOne({ tenantId, indexId, url: { $regex: domain }, discoveryStatus: { $in: ['running', 'complete'] }, updatedAt: { $gt: oneHourAgo } })`.

### Discovery Completion → Source Creation

When discovery completes, the system auto-creates a **Source** in `pending` status so the team can see it:

```
Discovery completes
  → auto-call addSource({ name: "Crawl: epson.com", sourceType: "web_crawl", status: "pending", sourceConfig: { url, draftId, sections, discoveredCount } })
  → Source appears in SourcesTable for ALL team members
  → draft.sourceId = source._id (links draft to source)
```

**What the team sees in the Sources table:**

```
┌────────────────┬──────┬───────┬──────────────┬──────────────────────┐
│ Source          │ Type │ Docs  │ Status       │ Action               │
├────────────────┼──────┼───────┼──────────────┼──────────────────────┤
│ epson.com       │ web  │   0   │ ◌ Discovered │ [Configure & Crawl]  │  ← owner only
│ support-docs    │ file │  89   │ ● Active     │                      │
└────────────────┴──────┴───────┴──────────────┴──────────────────────┘
```

- **"Discovered" status** = discovery complete, not yet crawled. Shows discovered URL count and section count.
- **Owner** sees [Configure & Crawl] → opens CrawlFlowPanel at Step 3 (Configure) with sections pre-loaded.
- **Other team members** see the source exists and its discovery stats — they know the work is done and crawl is pending. No action buttons (owner controls the crawl).
- **After crawl starts**, status changes to `active` (existing behavior).

This makes discovery results immediately visible to the team without waiting for the owner to configure and start the crawl.

**Why auto-create Source on discovery complete (not on crawl start):**

1. Team visibility — others see work was done, not just a private draft
2. Prevents duplicate work — User B sees "epson.com — Discovered" and won't start another discovery
3. Source already has a `pending`/`draft` status that the SourcesTable handles (line 312)
4. If the owner never comes back to crawl, the Source is still visible as "Discovered, 0 docs" — another team member can eventually reconfigure it

### Activity Bar Visibility

The `DiscoveryActivityBar` queries all active drafts for the current KB (not just the current user's). The response includes `createdBy` display name. Owner's rows show action buttons; others' rows show view-only status.

**New endpoint:** `GET /drafts/active?indexId=X` — returns all drafts with `discoveryStatus` in `['running', 'complete']`, enriched with `createdByName`.

### Browser Tab Close / Session Recovery

- User closes browser tab → SSE disconnects. Server-side discovery continues.
- User returns (new tab, same KB) → Activity bar queries draft API on mount. If draft has `discoveryStatus: 'running'`, bar shows it. User clicks [Resume] to reconnect.
- Server-side discovery timeout: `CRAWL_TTL_MS = 30 min` already exists in `crawl-discover.ts:60`. After 30 min of no SSE listeners, completed crawls are evicted.
- Draft cleanup: `expiresAt` with TTL index already exists in the schema — MongoDB auto-deletes expired drafts.

### Time Estimate Formula

Section time estimates use a range rather than a point estimate to avoid false precision:

```typescript
function estimateTimeRange(pageCount: number, config: CrawlConfig): string {
  const delayMs = config.requestDelay;
  const concurrency = config.rendering === 'browser' ? 1 : 3; // browser is sequential
  const baseMs = (pageCount * delayMs) / concurrency;
  const lowMs = baseMs * 0.8; // best case
  const highMs = baseMs * 1.5; // network variability, retries
  return `${formatDuration(lowMs)}–${formatDuration(highMs)}`;
}
```

Shown only for sections with >10 pages (below that, the estimate is meaningless). Displayed as a range: "30–50 min" not "~42 min".

### Accessibility

- Tree nodes: navigable with arrow keys (up/down to traverse, left/right to collapse/expand)
- Inline action buttons: accessible via Tab + Enter/Space
- Activity bar items: focusable, actions via Enter/Space
- Collapse/expand toggles: keyboard accessible, ARIA `aria-expanded` state
- SlidePanel: already has Radix Dialog focus trap and Escape key handling

---

## Phased Implementation Plan

### Phase 1: Foundation (O3 + O1) — ~3 days

**Why first:** Recursive counts and live transparency are pure frontend changes with zero backend dependencies. They immediately improve the experience for all users.

| Task                                         | Files                                  | Effort |
| -------------------------------------------- | -------------------------------------- | ------ |
| `computeSubtreeCounts` utility               | tree-utils.ts                          | 0.5d   |
| Wire subtree counts into DiscoveryTree       | DiscoveryTree.tsx                      | 0.5d   |
| `LiveSubStatus` component                    | NEW LiveSubStatus.tsx                  | 0.5d   |
| Enhance DiscoveryTimeline with live data     | DiscoveryTimeline.tsx                  | 0.5d   |
| Wire live stats: Panel → Analysis → Timeline | DiscoveryPanel.tsx, State2Analysis.tsx | 0.5d   |
| Update section cards with recursive counts   | State2Analysis.tsx                     | 0.5d   |

**Exit criteria:** Tree nodes show "142 pages ~45m" instead of "(42)". Timeline shows live visiting URL, yield rate, and health indicators.

### Phase 2: Sections + Interventions (O2 + O4) — ~5 days

**Why second:** Auto-section creation and intervention polish are the core discovery experience improvements. They depend on Phase 1's recursive counts.

| Task                                               | Files                                     | Effort |
| -------------------------------------------------- | ----------------------------------------- | ------ |
| Auto-section creation from prefix groups           | DiscoveryPanel.tsx                        | 1d     |
| `[+sec]` manual section button on tree             | DiscoveryTree.tsx                         | 0.5d   |
| Section source badges + grand total                | State2Analysis.tsx                        | 0.5d   |
| Inline collapse/expand in State2Analysis           | State2Analysis.tsx                        | 0.5d   |
| `DiscoveryActivityBar` component                   | NEW DiscoveryActivityBar.tsx              | 1d     |
| `useDiscoveryStore` Zustand store                  | NEW discovery-store.ts                    | 0.5d   |
| Close confirmation dialog in CrawlFlowPanel        | AddSourceButton.tsx                       | 0.5d   |
| Activity bar mount in KBDetailLayout               | KBDetailLayout.tsx                        | 0.25d  |
| Multi-user: active drafts endpoint + owner display | crawl-drafts.ts, DiscoveryActivityBar.tsx | 0.5d   |
| Duplicate domain check on URL submit               | State1UrlEntry.tsx or CrawlFlowV5.tsx     | 0.25d  |
| Inline per-node action buttons                     | DiscoveryTree.tsx                         | 0.5d   |
| Discovery-rate suggestion (replaces "yield")       | DiscoveryPanel.tsx                        | 0.5d   |

**Exit criteria:** Discovery auto-creates sections from tree categories. Users can collapse discovery inline within the panel and review sections while it runs. Closing the panel shows a KB-level activity bar that tracks N concurrent discoveries with owner visibility. Other team members see view-only status. Duplicate domain warning prevents wasted work. Inline explore/skip per node without bulk selection.

### Phase 3: Preview + Crawl Progress (O5 + O6) — ~4 days

**Why third:** These enhance the tail of the flow (Step 3 configure + Step 4 crawl). They're independently valuable and have a small backend change (section mapping).

| Task                                      | Files                                        | Effort |
| ----------------------------------------- | -------------------------------------------- | ------ |
| `BatchPreviewPanel` component             | NEW BatchPreviewPanel.tsx                    | 1d     |
| Quality bar + JS rendering advisory       | BatchPreviewPanel.tsx                        | 0.5d   |
| Integrate in State3Configure              | State3Configure.tsx                          | 0.5d   |
| `CrawlCompletionSummary` component        | NEW CrawlCompletionSummary.tsx               | 0.5d   |
| Crawl items in KB activity bar (reuse O4) | DiscoveryActivityBar.tsx, discovery-store.ts | 0.5d   |
| Section mapping in batch submit           | CrawlFlowV5.tsx, crawl.ts (BE)               | 0.5d   |
| Per-section progress bars                 | State4Crawl.tsx                              | 0.5d   |

**Exit criteria:** Users can preview extraction quality before committing. Crawl progress shows per-section bars and a completion summary with actionable next steps.

### Phase 4: Documents + Politeness (O7 + O8) — ~5 days

**Why last:** These require backend changes (stop dropping file URLs, robots.txt parsing). They're important but the crawler is usable without them.

| Task                                        | Files                          | Effort |
| ------------------------------------------- | ------------------------------ | ------ |
| Stop dropping file URLs in discover crawler | discover-crawler.ts (BE)       | 0.5d   |
| Add fileType to SSE progress events         | crawl-browser-discover.ts (BE) | 0.5d   |
| Track file types in DiscoveryPanel          | DiscoveryPanel.tsx             | 0.5d   |
| `FileTypeSelector` component                | NEW FileTypeSelector.tsx       | 0.5d   |
| Section composition badges                  | State2Analysis.tsx             | 0.5d   |
| robots.txt parser service                   | NEW robots-parser.ts (BE)      | 1d     |
| `/robots` endpoint                          | crawl.ts (BE)                  | 0.5d   |
| `RobotsTxtCard` component                   | NEW RobotsTxtCard.tsx          | 0.5d   |
| Crawl speed slider + rate limiting UI       | State3Configure.tsx            | 0.5d   |

**Exit criteria:** PDFs and documents are discovered and shown with type counts. robots.txt is fetched, displayed, and honored. Crawl speed has a visual slider with Crawl-delay awareness.

---

## Dependency Graph

```
Phase 1 (Foundation)
  O3: Recursive counts ──────┐
  O1: Live transparency ─────┼── Both pure frontend
                              │
Phase 2 (Core UX)            │
  O2: Auto sections ─────────┤ depends on O3 (recursive counts)
  O4: Interventions ──────────┤ inline collapse + KB activity bar + close confirm
                              │   Zustand store + KBDetailLayout (1 line)
                              │
Phase 3 (Tail of flow)       │
  O5: Extraction preview ────┤ independent (uses existing API, no browser switch button)
  O6: Crawl progress ────────┤ small backend change (section mapping)
                              │
Phase 4 (Backend-dependent)  │
  O7: File types ─────────────┤ backend change (stop dropping files)
  O8: robots.txt ─────────────┘ new backend service + endpoint
```

**Within-phase parallelism:**

- Phase 1: O1 and O3 can be developed in parallel
- Phase 2: O2 and O4 can be developed in parallel
- Phase 3: O5 and O6 can be developed in parallel
- Phase 4: O7 and O8 can be developed in parallel

---

## Edge Cases

### Slow Sites (avg response > 2s)

- **O1:** Discovery rate will be low. Show "Slow site — finding fewer pages per visit" in amber in the timeline health indicators.
- **O8:** Crawl-delay should auto-increase. The slider should show the detected response time as context: "This site responds in ~2.5s. Recommended delay: 3s." Slider minimum is raised to match.

### Sites with 10K+ Pages

- **O3:** `computeSubtreeCounts` is O(n) — at 10K nodes, ~10ms. Acceptable, but memoize aggressively.
- **O2:** Auto-section creation should cap at ~20 sections. Beyond that, show "X more categories available" with an expand toggle.
- **O6:** Per-section progress bars should virtualize if > 20 sections — show top 10, collapsible.

### Discovery Failures

- **O1:** If SSE disconnects mid-discovery, the LiveSubStatus should show "Reconnecting..." (already handled by SSE retry logic in `BrowserDiscoveryInline.tsx:356-376`).
- **O2:** If clustering fails (timeout at line 286), sections fall back to a single "All discovered URLs" section.

### Browser Mode vs HTTP Mode Differences

- **O1:** Browser discovery emits richer events (currentUrl, discoveredOnPage, role). HTTP discovery emits simpler progress (found, matched, visited). LiveSubStatus should adapt:
  - Browser: "Visiting /printers/ — found 8 links"
  - HTTP: "142 matched / 305 found"
- **O7:** Browser mode can discover file links in JS-rendered content. HTTP mode only finds file links in HTML. The FileTypeSelector should note: "Browser mode may find additional files."

### Concurrent Discovery and Crawl

- **O4/O6:** Multiple concurrent discoveries are tracked in the KB-level activity bar (see O4). Each discovery is a separate row. If "crawl-as-you-discover" is active, the activity bar shows both:
  ```
  🟢 epson.com — Discovering: 142 URLs · 3 sections    [Resume] [Stop]
  🔵 epson.com — Crawling: 45/142 pages (32%)          [Resume] [Stop]
  🟢 hp.com — Discovering: 67 URLs · 2 sections        [Resume] [Stop]
  ```
- The activity bar scales to N items. When >3 items, it auto-collapses to a summary line with [Expand].

### Empty States

- **O2:** Zero auto-sections created (site has no clear hierarchy): Show "No clear categories found. You can manually add sections from the tree or proceed with all discovered URLs."
- **O5:** All preview pages return thin/empty: Show "Some pages have thin content — the crawler will automatically use browser mode for better extraction (hybrid mode is enabled)."
- **O7:** No file types found: Hide the FileTypeSelector entirely.

### robots.txt Edge Cases

- **O8:** robots.txt not found (404): Show "No robots.txt found — proceeding without restrictions."
- **O8:** robots.txt blocks everything: Show error state: "This site's robots.txt blocks all crawling. Contact the site administrator or use authenticated access."
- **O8:** Crawl-delay is very high (> 10s): Show warning: "Crawl-delay is 15s — crawling 300 pages will take ~1h 15m. Consider reducing scope."

---

## Summary: New Files

| File                         | Purpose                                            | Phase |
| ---------------------------- | -------------------------------------------------- | ----- |
| `LiveSubStatus.tsx`          | Inline live status per timeline step               | 1     |
| `DiscoveryActivityBar.tsx`   | KB-level activity bar for backgrounded discoveries | 2     |
| `discovery-store.ts`         | Zustand store for backgrounded discovery tracking  | 2     |
| `BatchPreviewPanel.tsx`      | Multi-page extraction preview (informational)      | 3     |
| `CrawlCompletionSummary.tsx` | Post-crawl actionable summary                      | 3     |
| `FileTypeSelector.tsx`       | Document type checkboxes                           | 4     |
| `RobotsTxtCard.tsx`          | robots.txt analysis display                        | 4     |
| `robots-parser.ts` (backend) | robots.txt fetching + parsing service              | 4     |

## Summary: Modified Files

| File                                 | Objectives  | Phase(s) | Change scope               |
| ------------------------------------ | ----------- | -------- | -------------------------- |
| `types.ts`                           | O1-O8       | 1-4      | Types/interfaces           |
| `DiscoveryPanel.tsx`                 | O1,O2,O7    | 1,2,4    | Event handling             |
| `DiscoveryTree.tsx`                  | O2,O3,O4    | 1,2      | Inline action buttons      |
| `DiscoveryTimeline.tsx`              | O1          | 1        | Live sub-status            |
| `State2Analysis.tsx`                 | O1,O2,O4,O7 | 1,2,4    | Collapse/expand toggle     |
| `BrowserDiscoveryInline.tsx`         | O1,O2       | 1,2      | Event forwarding           |
| `KBDetailLayout.tsx`                 | O4          | 2        | 1 line: activity bar mount |
| `AddSourceButton.tsx`                | O4          | 2        | Close confirmation dialog  |
| `State3Configure.tsx`                | O5,O8       | 3,4      | Preview + robots card      |
| `State4Crawl.tsx`                    | O6          | 3        | Progress bars              |
| `CrawlFlowV5.tsx`                    | O6          | 3        | Section mapping            |
| `State1UrlEntry.tsx`                 | Multi-user  | 2        | Duplicate domain check     |
| `discovery/tree-utils.ts`            | O3          | 1        | Subtree count util         |
| `api/crawl.ts`                       | O8          | 4        | Robots endpoint            |
| Backend: `crawl.ts`                  | O6,O8       | 3,4      | Section mapping, robots    |
| Backend: `crawl-browser-discover.ts` | O7          | 4        | File type events           |
| Backend: `discover-crawler.ts`       | O7          | 4        | Stop dropping files        |
| Backend: `crawl-drafts.ts`           | O4          | 2        | discoveryStatus field      |
