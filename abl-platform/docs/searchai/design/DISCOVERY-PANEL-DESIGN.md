# Discovery Panel Design — Transparency + Intervention

**Date**: 2026-04-23 (updated)
**Status**: DRAFT — Design Complete, Ready for LLD
**Drives**: Track A (adaptive budget), Track B (3-zone panel), Track C (interventions — complete design §6), Track D (crawl-as-you-discover), Track E (upfront strategy §22)
**Reference**: UNIFIED-EXPLORE-DISCOVERY-DESIGN.md §24b
**Decisions**: D1-D7 (auto-collapse, Discovery Console, Decision Cards, action verbs, auto-add, crawl-as-you-discover, upfront strategy selection)

---

## 1. Problem Summary

The current `BrowserDiscoveryInline.tsx` is a black box:

- User sees "clicking expandable elements..." → "553 links found" — no visibility into what was found WHERE
- No ability to steer discovery mid-run (only stop)
- Static budget (`maxPageVisits=20`, `sampleSize=2`) runs out climbing breadcrumbs
- Pipeline stalls when clustering hangs (just fixed)
- No tree visualization of discovered URL hierarchy

## 2. Design Approach

### Principle: "System drives, user reads the map"

The system makes smart decisions automatically but shows the user everything:

- What it's doing right now
- What it found so far (as a growing tree)
- What it plans to do next
- User can intervene at any point (explore more, skip, stop, add samples)

### Incremental Build — NOT a rewrite

We KEEP `BrowserDiscoveryInline.tsx` as the shell and ADD the three zones inside it.
The existing SSE connection, auto-start, cleanup, and stop logic stay.
New components are composed inside the running state.

---

## 3. Architecture Overview

```
State2Analysis.tsx
├── SampleUrlInput.tsx          ← Zone 1 (already extracted)
├── DiscoveryPanel.tsx          ← NEW: orchestrates zones 2+3+4
│   ├── DiscoveryConsole.tsx    ← Zone 2: scrollable log + action chips
│   ├── DiscoveryTree.tsx       ← Zone 3: interactive tree with auto-collapse
│   └── CoverageSummary.tsx     ← Zone 4: categories, gaps, confidence
├── Section list                ← existing
└── DiscoveryTimeline.tsx       ← existing (pipeline phases)
```

### Data Flow

```
Backend SSE Events
  │
  ▼
BrowserDiscoveryInline (SSE listener — unchanged)
  │
  ├── progress events → DiscoveryConsole (Zone 2)
  │                      └── timestamped log entries
  │                      └── system decision visibility
  │                      └── context-aware action chips
  │                      └── Decision Cards (replace free-text objectives)
  │
  ├── progress events → DiscoveryTree (Zone 3)
  │   (build tree from │   └── tree nodes with state-specific action verbs
  │    progress data)   │   └── auto-collapse at depth threshold
  │                     │   └── breadcrumb trail navigation
  │                     │   └── auto-added sections with NEW badge
  │
  ├── complete event → onLayerComplete + clusterUrls
  │                     └── sections appear in list
  │
  └── (optional) crawl-as-you-discover pipeline
       └── parallel crawl of matched/all URLs during discovery
```

### Key: Enriched Progress Events for Tree Building

**[C2 Resolution]** The current `DepthProbeProgress` emits counts (`pagesVisited`, `verifiedLinks`) and display strings (`currentAction: "Visiting hub: /Support/Printers/"`), but does NOT emit the URL lists needed to build a tree. We must enrich the progress event.

**Backend change required** in `depth-prober.ts` — add these fields to `DepthProbeProgress`:

```typescript
// NEW fields added to DepthProbeProgress
interface DepthProbeProgress {
  // ... existing fields stay unchanged ...

  /** [NEW] URLs discovered on the current page visit — emitted per hub visit */
  discoveredOnPage?: Array<{ href: string; text: string; confidence: UrlConfidence }>;
  /** [NEW] The structured URL being visited (not the display string) */
  currentUrl?: string;
  /** [NEW] Page role of the current URL */
  currentRole?: PageRole;
  /** [NEW] Sibling URLs at the current level — for tree rendering */
  siblings?: Array<{ href: string; text: string }>;
}
```

**SSE proxy change** in `crawl-browser-discover.ts` — forward these new fields transparently (already does `JSON.stringify(progress)` passthrough, so no proxy changes needed).

**Tree is built by accumulating enriched progress events**:

- `breadcrumbs[]` → tree backbone (already exists)
- `currentUrl` → which node is currently `visiting` (replaces parsing `currentAction` string)
- `discoveredOnPage[]` → child links for the currently visited node
- `siblings[]` → peer nodes at the current level
- `currentRole` → hub/leaf/mixed classification for the node

---

## 4. Component Designs

### 4.1 DiscoveryPanel.tsx (~200 LOC)

**Purpose**: Wraps Console + Tree + Coverage inside BrowserDiscoveryInline's running state.

```tsx
interface DiscoveryPanelProps {
  progress: BrowserExploreProgress | null;
  result: BrowserExploreResult | null;
  status: BrowserDiscoveryStatus;
  baseUrl: string;
  onStop: () => void;
  onRunInBackground: () => void;
  /** Crawl-as-you-discover config (if enabled) */
  crawlConfig?: CrawlAsYouDiscoverConfig;
}

// State:
// - treeNodes: DiscoveryTreeNode[]  — accumulated from progress events
// - backgroundMode: boolean
// - consoleEntries: ConsoleEntry[]  — scrollable log
// - decisionCards: DecisionCard[]   — context-aware action cards
```

**Layout**:

```
┌─────────────────────────────────────────────┐
│ Zone 2: Discovery Console                    │
│ ┌──────────────────────────────────────────┐│
│ │ 14:32:01 Visiting /Support/Printers/...  ││
│ │ 14:32:03 Found 32 child links            ││
│ │ 14:32:03 Decided: sample 3 of 32        ││
│ │          children (high yield: 8/page)    ││
│ │ 14:32:05 Visiting /Support/Printers/     ││
│ │          ET-Series... found 15 models     ││
│ │ 14:32:08 Auto-added "ET-Series" section  ││
│ │          (12 URLs matched) [NEW]          ││
│ │ 14:32:10 Next: /Support/Scanners         ││
│ └───────────────── scroll ─────────────────┘│
│                                              │
│ ┌──────────────────────────────────────────┐│
│ │ What would you like to do?               ││
│ │                                          ││
│ │ [Explore Scanners branch]                ││
│ │ [Skip Downloads — low content signal]    ││
│ │ [Find all FAQ pages across sections]     ││
│ │ [I'm looking for something else...]      ││
│ └──────────────────────────────────────────┘│
├─────────────────────────────────────────────┤
│ Zone 3: Discovery Tree                       │
│ 📍 epson.com > Support > Printers            │  ← breadcrumb trail
│ ▼ Support (hub — 45 links)             ✅   │
│   ▼ Printers (hub — 32 links)          ✅   │
│     ○ All-In-Ones (12)  [Visit & discover]  │
│     ○ Inkjet (projected) [Add to crawl scope]│
│     ✅ ET-Series (15 models) [NEW] auto-added│
│   ▶ Scanners (3 children)   [Visit & discover]│  ← collapsed
│   ▶ Projectors (5 children) [Visit & discover]│  ← collapsed
│                                              │
│ 553 links · 4 pages visited · 314s           │
│ [Use these results]  [Explore more...]       │
└─────────────────────────────────────────────┘
```

**Background mode**: When user clicks "Run in background":

```
┌─────────────────────────────────────────┐
│ Discovery running... 553 links found    │
│ [View details]  [Stop]                  │
└─────────────────────────────────────────┘
```

### 4.2 DiscoveryTree.tsx (~200 LOC)

**Purpose**: Interactive tree that grows in real-time from progress events.

```tsx
interface DiscoveryTreeNode {
  /** URL path segment used as display name */
  name: string;
  /** Full URL */
  url: string;
  /** Source of this node */
  source: 'breadcrumb' | 'visited-hub' | 'sibling' | 'projected' | 'seed';
  /** Current state */
  state: 'visited' | 'discovered' | 'visiting' | 'skipped' | 'failed';
  /** Links found at this node (only for visited) */
  linkCount?: number;
  /** Child nodes */
  children: DiscoveryTreeNode[];
  /** Depth in tree */
  depth: number;
  /** Confidence */
  confidence: 'verified' | 'projected';
  /** Page classification (hub/leaf/mixed) */
  role?: 'hub' | 'leaf' | 'mixed';
}

interface DiscoveryTreeProps {
  nodes: DiscoveryTreeNode[];
  isRunning: boolean;
  /** When user wants to explore an unvisited node */
  onExplore?: (url: string) => void;
  /** When user wants to skip a node */
  onSkip?: (url: string) => void;
  /** When user wants to explore all siblings at a level */
  onExploreAll?: (parentUrl: string) => void;
}
```

**Tree building algorithm** (runs on each enriched progress event):

**[C2 Resolution]** Uses the new `currentUrl`, `discoveredOnPage`, `siblings`, and `currentRole` fields instead of parsing display strings.

```typescript
function updateTree(
  tree: DiscoveryTreeNode[],
  progress: BrowserExploreProgress,
  prevVisitingUrl: string | null,
): { updatedTree: DiscoveryTreeNode[]; newVisitingUrl: string | null } {
  // Incremental mutation — NO structuredClone (see H2 resolution)
  // All mutations are at specific node paths, not whole-tree copies

  // 1. Breadcrumb backbone (any phase that emits breadcrumbs)
  if (progress.breadcrumbs?.length) {
    for (const bc of progress.breadcrumbs) {
      upsertNode(tree, bc.href, {
        displayName: bc.text,
        pathSegment: extractLastSegment(bc.href),
        source: 'breadcrumb',
        state: 'discovered',
        depth: bc.depth,
        confidence: 'verified', // breadcrumbs are real links
      });
    }
  }

  // 2. Mark current URL as 'visiting', previous as 'visited'
  if (progress.currentUrl && progress.currentUrl !== prevVisitingUrl) {
    if (prevVisitingUrl) {
      const prevNode = findNode(tree, prevVisitingUrl);
      if (prevNode) prevNode.state = 'visited';
    }
    upsertNode(tree, progress.currentUrl, {
      state: 'visiting',
      role: progress.currentRole,
    });
  }

  // 3. Add discovered child links from current page visit
  if (progress.discoveredOnPage) {
    for (const link of progress.discoveredOnPage) {
      upsertNode(tree, link.href, {
        displayName: link.text || formatDisplayName(extractLastSegment(link.href)),
        pathSegment: extractLastSegment(link.href),
        source: 'sibling',
        state: 'discovered',
        confidence: link.confidence === 'verified' ? 'verified' : 'projected',
      });
    }
  }

  // 4. Add sibling nodes at current level
  if (progress.siblings) {
    for (const sib of progress.siblings) {
      upsertNode(tree, sib.href, {
        displayName: sib.text || formatDisplayName(extractLastSegment(sib.href)),
        pathSegment: extractLastSegment(sib.href),
        source: 'sibling',
        state: 'discovered',
        confidence: 'verified',
      });
    }
  }

  // 5. On complete: finalize all 'visiting' → 'visited'
  if (progress.phase === 'complete') {
    walkTree(tree, (node) => {
      if (node.state === 'visiting') node.state = 'visited';
    });
  }

  return {
    updatedTree: tree, // mutated in-place
    newVisitingUrl: progress.currentUrl ?? prevVisitingUrl,
  };
}

// Helper: find-or-create node at the correct tree position by URL
function upsertNode(
  tree: DiscoveryTreeNode[],
  url: string,
  updates: Partial<DiscoveryTreeNode>,
): DiscoveryTreeNode {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  let currentLevel = tree;
  let node: DiscoveryTreeNode | undefined;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    node = currentLevel.find((n) => n.pathSegment === seg);
    if (!node) {
      node = {
        displayName: formatDisplayName(seg),
        pathSegment: seg,
        url: new URL('/' + segments.slice(0, i + 1).join('/'), url).href,
        source: updates.source ?? 'sibling',
        state: 'discovered',
        children: [],
        depth: i,
        confidence: 'projected',
      };
      currentLevel.push(node);
    }
    if (i < segments.length - 1) {
      currentLevel = node.children;
    }
  }

  // Apply updates to the target node (last segment)
  if (node) Object.assign(node, updates);
  return node!;
}
```

**Render**: Simple indented list (not SVG/D3 — keep it simple), with auto-collapse and action-specific verbs.

#### Auto-Collapse Rules

Tree auto-collapses to prevent overwhelm on large sites. **No hardcoded depth cap** — collapse is driven by visible node count, not a fixed depth limit. A 5-level Epson tree and a 2-level blog both render correctly:

```typescript
interface TreeRenderConfig {
  /** Total visible node threshold before auto-collapsing deeper levels */
  autoCollapseThreshold: 30;
  /** Which nodes are manually expanded by user (overrides auto) */
  manuallyExpanded: Set<string>;
  /** Which nodes are manually collapsed by user */
  manuallyCollapsed: Set<string>;
}

function computeVisibleNodes(
  tree: DiscoveryTreeNode[],
  config: TreeRenderConfig,
): { visibleNodes: DiscoveryTreeNode[]; collapsedCount: number } {
  // Step 1: Count total nodes at each depth level
  const countByDepth = new Map<number, number>();
  walkTree(tree, node => {
    countByDepth.set(node.depth, (countByDepth.get(node.depth) ?? 0) + 1);
  });

  // Step 2: Find the depth cutoff where total visible < threshold
  let totalVisible = 0;
  let autoCollapseDepth = Infinity;
  for (let depth = 0; depth <= Math.max(...countByDepth.keys()); depth++) {
    totalVisible += countByDepth.get(depth) ?? 0;
    if (totalVisible > config.autoCollapseThreshold) {
      autoCollapseDepth = depth;
      break;
    }
  }

  // Step 3: Apply auto-collapse, respecting manual overrides
  // - Nodes at depth <= autoCollapseDepth: expanded by default
  // - Nodes at depth > autoCollapseDepth: collapsed unless manually expanded
  // - "Visiting" nodes always expanded (active discovery path)
  // - User manual expand/collapse always wins

  return { visibleNodes: /* filtered */, collapsedCount: /* hidden */ };
}
```

**Breadcrumb trail** — when deep in the tree, show a clickable path at the top:

```tsx
// When user clicks into a collapsed branch or tree is deep:
// 📍 epson.com > Support > Printers > ET-Series
// Each segment is clickable — scrolls tree to that level and expands it
interface TreeBreadcrumb {
  label: string;
  url: string;
  depth: number;
}
```

**Power-user toggle** — for users who want manual control over tree depth:

```tsx
// Toolbar above the tree:
// [Expand all] [Collapse to 2 levels] [Auto (30 nodes)]
//
// "Expand all" — shows every node at every depth
// "Collapse to 2 levels" — forces all nodes at depth > 2 to collapse
// "Auto" (default) — uses the 30-node threshold algorithm above
type TreeViewMode = 'auto' | 'expand-all' | 'collapse-to-depth';
interface TreeViewConfig {
  mode: TreeViewMode;
  /** When mode='collapse-to-depth', the max visible depth */
  collapseDepth?: number; // default 2
}
```

**Shallow-site wireframe** — when auto-collapse never triggers:

```
Example — Simple blog (< 30 nodes):
  ▼ Blog (hub — 8 posts)                        ✅
    ○ how-to-get-started
    ○ advanced-tips
    ○ release-notes-v2
    ○ faq                                ← everything visible
    ○ about-us                              no collapse needed
```

#### Action-Specific Verbs Per Node State

Replace generic [Explore] [Skip] with verbs that tell the user exactly what will happen:

```tsx
function getNodeActions(node: DiscoveryTreeNode): NodeAction[] {
  switch (true) {
    // Discovered but not visited — we know it exists but haven't looked inside
    case node.state === 'discovered' && node.children.length === 0:
      return [
        { label: 'Visit & discover children', action: 'explore-branch', icon: 'Search' },
        { label: 'Add to crawl scope', action: 'add-to-scope', icon: 'Plus' },
        { label: 'Skip', action: 'skip-branch', icon: 'X' },
      ];

    // Visited hub — we went there and found child links
    case node.state === 'visited' && node.role === 'hub':
      return [
        { label: 'Go deeper', action: 'explore-branch', icon: 'ArrowDown' },
        { label: 'Add all children to crawl', action: 'add-children-to-scope', icon: 'PlusCircle' },
        { label: 'Skip branch', action: 'skip-branch', icon: 'X' },
      ];

    // Visited leaf — we went there, it has content but no further links
    case node.state === 'visited' && node.role === 'leaf':
      return [
        { label: 'Add to crawl scope', action: 'add-to-scope', icon: 'Plus' },
        { label: 'Skip', action: 'skip-branch', icon: 'X' },
      ];

    // Projected — URL was inferred from patterns, never actually seen
    case node.confidence === 'projected':
      return [
        { label: 'Verify this URL', action: 'explore-branch', icon: 'CheckCircle' },
        { label: 'Add to crawl scope', action: 'add-to-scope', icon: 'Plus' },
        { label: 'Skip', action: 'skip-branch', icon: 'X' },
      ];

    // Skipped — user previously skipped, can undo
    case node.state === 'skipped':
      return [{ label: 'Undo skip', action: 'undo-skip', icon: 'Undo' }];

    default:
      return [];
  }
}

interface NodeAction {
  label: string;
  action: InterventionType | 'add-to-scope' | 'add-children-to-scope';
  icon: string;
}
```

**Render**:

```tsx
<div className="space-y-0.5">
  {/* Breadcrumb trail when deep in tree */}
  {breadcrumbs.length > 0 && <TreeBreadcrumbBar crumbs={breadcrumbs} onNavigate={scrollToDepth} />}

  {/* Collapsed count indicator */}
  {collapsedCount > 0 && (
    <p className="text-xs text-muted">
      {collapsedCount} deeper nodes collapsed — click ▶ to expand
    </p>
  )}

  {visibleNodes.map((node) => (
    <TreeNode
      key={node.url}
      node={node}
      depth={node.depth}
      actions={getNodeActions(node)}
      isAutoCollapsed={node.depth > autoCollapseDepth}
    />
  ))}
</div>

// TreeNode renders recursively with left padding per depth
// Icons: ✅ CheckCircle2, ○ Circle, Loader2 (spinning), Ban, AlertTriangle
// Actions: state-specific verb buttons (see getNodeActions above)
// Auto-added nodes: show [NEW] badge with accent background
```

### 4.3 DiscoveryConsole.tsx (~250 LOC)

**Purpose**: Scrollable log showing timestamped discovery events, system decisions, and context-aware action chips. Replaces the simple `DiscoveryActivity` status component. Think of it as a terminal/console that shows the user everything the system is doing and thinking, with the ability to respond.

```tsx
interface DiscoveryConsoleProps {
  /** Accumulated log entries */
  entries: ConsoleEntry[];
  /** Current discovery phase (for action chip generation) */
  phase: DiscoveryLoopState;
  /** Current tree state (for generating contextual decision cards) */
  treeNodes: DiscoveryTreeNode[];
  /** Discovered URLs so far (for decision card context) */
  discoveredUrls: DiscoveredUrlSet;
  /** Nav structure (for generating suggestions) */
  navStructure: NavNode[] | null;
  /** Callbacks */
  onAction: (action: ConsoleAction) => void;
  onStop: () => void;
  onRunInBackground: () => void;
}
```

#### Console Entry Types

```typescript
type ConsoleEntryType =
  | 'action' // "Visiting /Support/Printers/..."
  | 'result' // "Found 32 child links"
  | 'decision' // "Decided: sample 3 of 32 children (high yield)"
  | 'auto-add' // "Auto-added 'ET-Series' section (12 URLs matched)"
  | 'yield' // "8 new links/page — productive"
  | 'warning' // "Yield declining — 2 links/page"
  | 'milestone' // "500 URLs discovered across 3 sections"
  | 'nav' // "Extracted 8 top-level navigation categories"
  | 'suggestion'; // "3 nav sections not yet explored — explore them?"

interface ConsoleEntry {
  id: string;
  timestamp: number;
  type: ConsoleEntryType;
  message: string;
  /** Optional structured data for rich rendering */
  data?: {
    url?: string;
    linkCount?: number;
    yieldRate?: number;
    sectionName?: string;
    urlCount?: number;
  };
}

// Convert progress events to console entries:
function progressToConsoleEntries(
  progress: BrowserExploreProgress,
  prevState: { lastUrl?: string; lastPhase?: string },
): ConsoleEntry[] {
  const entries: ConsoleEntry[] = [];
  const now = Date.now();

  // New page visit
  if (progress.currentUrl && progress.currentUrl !== prevState.lastUrl) {
    entries.push({
      id: crypto.randomUUID(),
      timestamp: now,
      type: 'action',
      message: `Visiting ${formatUrlForDisplay(progress.currentUrl)}...`,
      data: { url: progress.currentUrl },
    });
  }

  // Links discovered on page
  if (progress.discoveredOnPage?.length) {
    entries.push({
      id: crypto.randomUUID(),
      timestamp: now,
      type: 'result',
      message: `Found ${progress.discoveredOnPage.length} child links`,
      data: { linkCount: progress.discoveredOnPage.length, url: progress.currentUrl },
    });
  }

  // System decision visibility — show WHY the system chose what it chose
  if (progress.currentRole === 'hub' && progress.discoveredOnPage) {
    const childCount = progress.discoveredOnPage.length;
    const sampleCount = progress.siblings?.length ?? 0;
    if (childCount > 3 && sampleCount < childCount) {
      entries.push({
        id: crypto.randomUUID(),
        timestamp: now,
        type: 'decision',
        message: `Decided: sample ${sampleCount} of ${childCount} children (${getYieldReason(progress)})`,
      });
    }
  }

  // Phase transition
  if (progress.phase && progress.phase !== prevState.lastPhase) {
    const phaseMessages: Record<string, string> = {
      'visiting-sample': 'Extracting navigation from your sample page...',
      'climbing-breadcrumbs': 'Climbing breadcrumbs to find parent sections...',
      'seed-explore': 'Scanning for expandable content...',
      probing: 'Sampling content at depth...',
      projecting: 'Projecting URL patterns from visited pages...',
      complete: `Discovery complete — ${progress.verifiedLinks} links from ${progress.pagesVisited} pages`,
    };
    entries.push({
      id: crypto.randomUUID(),
      timestamp: now,
      type: 'milestone',
      message: phaseMessages[progress.phase] ?? `Phase: ${progress.phase}`,
    });
  }

  return entries;
}
```

#### Console Rendering

```tsx
// Scrollable log — auto-scroll to bottom, user can scroll up to see history
// [▼ Latest] button appears when user scrolls up, jumps back to current
// Collapsible to 1-line status bar (separate from background mode)
<div className="relative">
  {/* Header with collapse toggle */}
  <div className="flex items-center justify-between px-3 py-1.5 bg-background-elevated rounded-t-lg">
    <span className="text-xs font-medium">Discovery Console</span>
    <div className="flex items-center gap-2">
      {!isAtBottom && (
        <button onClick={scrollToBottom} className="text-xs text-accent">
          ▼ Latest
        </button>
      )}
      <button onClick={toggleCollapse} className="text-xs text-muted">
        {collapsed ? '▼ Expand' : '▲ Collapse'}
      </button>
    </div>
  </div>

  {/* Collapsed: 1-line status bar showing latest entry */}
  {collapsed ? (
    <div className="px-3 py-1 text-xs text-muted bg-background-muted rounded-b-lg">
      {latestEntry?.message ?? 'Waiting...'}
    </div>
  ) : (
    /* Expanded: full scrollable log */
    <div className="max-h-48 overflow-y-auto font-mono text-xs space-y-1 bg-background-muted rounded-b-lg p-3">
      {entries.map((entry) => (
        <ConsoleEntryRow key={entry.id} entry={entry} />
      ))}
      <div ref={bottomRef} /> {/* auto-scroll anchor */}
    </div>
  )}
</div>;

// Entry row styling by type:
// action:    text-foreground       "14:32:01 Visiting /Support/Printers/..."
// result:    text-success          "14:32:03 Found 32 child links"
// decision:  text-accent italic    "14:32:03 Decided: sample 3 of 32 children"
// auto-add:  text-accent bold      "14:32:08 Auto-added 'ET-Series' [NEW]"
// yield:     text-success/warning  "14:32:10 8 links/page — productive"
// warning:   text-warning          "14:32:15 Yield declining — 2 links/page"
// milestone: text-foreground bold  "14:32:20 500 URLs discovered"
// nav:       text-accent           "14:31:58 Extracted 8 navigation categories"
// suggestion:text-accent underline "14:32:25 3 sections unexplored — explore?"

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatUrlForDisplay(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
```

#### Rate Indicator (inline in console)

```tsx
function getYieldStatus(yieldPerPage: number[]): ConsoleEntry | null {
  if (yieldPerPage.length < 2) return null;
  const recent = yieldPerPage.slice(-3);
  const avg = recent.reduce((s, n) => s + n, 0) / recent.length;
  if (avg > 10)
    return {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'yield',
      message: `${Math.round(avg)} links/page — productive`,
      data: { yieldRate: avg },
    };
  if (avg > 2)
    return {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'yield',
      message: `${Math.round(avg)} links/page — moderate`,
      data: { yieldRate: avg },
    };
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type: 'warning',
    message: 'Yield declining — will stop when unproductive',
    data: { yieldRate: avg },
  };
}
```

#### Contextual Prompts — Event-Driven Console Questions

The console shows contextual prompts based on what just happened. These are NOT the same as Decision Cards (§9) — they are inline console entries with embedded action chips:

```typescript
// After visiting a high-value hub, inject a contextual prompt into the console:
function generateContextualPrompt(
  event: BrowserExploreProgress,
  tree: DiscoveryTreeNode[],
): ConsoleEntry | null {
  // After hub visit with many children:
  if (event.currentRole === 'hub' && event.discoveredOnPage && event.discoveredOnPage.length > 10) {
    const categories = categorizeChildrenRobust(
      event.discoveredOnPage.map((l) => ({ url: l.href, title: l.text, inferredCategory: '' })),
    );
    return {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'suggestion',
      message:
        `What do you want from "${formatUrlForDisplay(event.currentUrl!)}"? ` +
        `Found ${categories.length} categories: ${categories
          .slice(0, 4)
          .map((c) => c.label)
          .join(', ')}`,
      data: { url: event.currentUrl!, linkCount: event.discoveredOnPage.length },
    };
  }

  // After yield drops:
  if (event.phase === 'probing') {
    const unexplored = tree.filter((n) => n.state === 'discovered' && n.source === 'nav-extracted');
    if (unexplored.length > 0) {
      return {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        type: 'suggestion',
        message: `Yield declining — switch to unexplored section? ${unexplored
          .slice(0, 2)
          .map((n) => n.displayName)
          .join(', ')}`,
      };
    }
  }

  return null;
}
```

**Wireframe — hub-visit prompt in console**:

```
│ 10:42:12  Climbing breadcrumb: /support/              │
│           Hub page — 120 child links                   │
│           ⚡ High-value hub detected                   │
│           → Decided: sample 8 children (adaptive)      │
│                                                        │
│ 💬 What do you want from /support/?                    │
│    Found 8 categories: Printers, Scanners, FAQ, ...    │
│    [Explore all 8]  [Only Printers & Scanners]         │
│    [Skip — already have these]  [Set as crawl target]  │
```

---

## 5. Adaptive Budget (Track A4)

### Current Problem

```typescript
// depth-prober.ts — STATIC caps
const hasBudget = () => pagesVisited < config.maxPageVisits; // always 20
// picks only sampleSize=2 siblings per hub — always 2
```

### New Approach: Pure Signal-Based Stopping (Zero Static Caps)

**[Obj-3 Resolution]** No static caps anywhere — `MAX_BUDGET_EXTENSION`, `INITIAL_BUDGET`, `MIN_YIELD_THRESHOLD`, and `pickSampleCount` tiers are all removed. Stopping is driven entirely by measured signals.

```typescript
// NEW: Pure signal-based budget — NO hardcoded limits
// The ONLY numbers here are the yield window size (how many recent pages
// to evaluate) and the minimum pages before evaluation starts.
// Neither is a cap — they control evaluation, not stopping.

interface YieldTracker {
  yieldPerPage: number[]; // new links found per page visit
  peakYield: number; // highest single-page yield seen
  totalNewLinks: number; // running total of unique links
  consecutiveLowYield: number; // pages in a row below dynamic threshold
}

function shouldContinue(tracker: YieldTracker): {
  continue: boolean;
  reason: string;
  trend: 'productive' | 'declining' | 'exhausted';
} {
  const { yieldPerPage, peakYield, consecutiveLowYield } = tracker;

  // Phase 1: Warm-up — always continue while building baseline
  // (need enough data points to evaluate diminishing returns)
  if (yieldPerPage.length < 3) {
    return { continue: true, reason: 'Building baseline', trend: 'productive' };
  }

  // Phase 2: Evaluate diminishing returns using RELATIVE threshold
  // Dynamic threshold = 5% of peak yield (not a fixed number)
  // If peak was 50 links/page, stop when < 2.5 links/page
  // If peak was 5 links/page, stop when < 0.25 links/page
  const dynamicThreshold = Math.max(peakYield * 0.05, 0.1);
  const windowSize = Math.min(yieldPerPage.length, 5);
  const recentYield = yieldPerPage.slice(-windowSize);
  const avgRecentYield = recentYield.reduce((s, n) => s + n, 0) / windowSize;

  if (avgRecentYield < dynamicThreshold) {
    return {
      continue: false,
      reason: `Yield dropped to ${avgRecentYield.toFixed(1)} links/page (peak was ${peakYield})`,
      trend: 'exhausted',
    };
  }

  // Phase 3: Consecutive low-yield detection
  // If last N pages ALL yield below threshold, stop even if average is above
  if (consecutiveLowYield >= 5) {
    return {
      continue: false,
      reason: `${consecutiveLowYield} consecutive pages below threshold`,
      trend: 'exhausted',
    };
  }

  // Phase 4: Still productive
  const trend = avgRecentYield > peakYield * 0.3 ? 'productive' : 'declining';
  return {
    continue: true,
    reason: `${avgRecentYield.toFixed(1)} links/page — ${trend}`,
    trend,
  };
}

// Update tracker after each page visit
function trackPageVisit(tracker: YieldTracker, newLinksOnPage: number): void {
  tracker.yieldPerPage.push(newLinksOnPage);
  tracker.totalNewLinks += newLinksOnPage;
  tracker.peakYield = Math.max(tracker.peakYield, newLinksOnPage);

  const dynamicThreshold = Math.max(tracker.peakYield * 0.05, 0.1);
  if (newLinksOnPage < dynamicThreshold) {
    tracker.consecutiveLowYield++;
  } else {
    tracker.consecutiveLowYield = 0;
  }
}
```

### Adaptive sampleSize — Signal-Based, Not Tiered

**[Obj-3 Resolution]** No fixed tier lookup. Sample count is driven by diminishing returns AT THE HUB LEVEL.

```typescript
// Instead of fixed tiers, sample siblings until yield drops
function pickSampleCount(hub: {
  childCount: number;
  /** Yield from first 2 sibling samples (if available) */
  initialSampleYield?: number[];
}): number {
  // Visit all if few — no sampling needed
  if (hub.childCount <= 3) return hub.childCount;

  // If we have initial sample yield data, use it to decide
  if (hub.initialSampleYield && hub.initialSampleYield.length >= 2) {
    const avgYield =
      hub.initialSampleYield.reduce((s, n) => s + n, 0) / hub.initialSampleYield.length;
    // High yield → sample more. Low yield → fewer samples needed.
    // Ratio: 1 sample per 5 children at low yield, 1 per 3 at high yield
    const ratio = avgYield > 10 ? 3 : avgYield > 2 ? 4 : 5;
    return Math.min(hub.childCount, Math.max(2, Math.ceil(hub.childCount / ratio)));
  }

  // No yield data yet — start with 2 samples, then adaptive
  return Math.min(hub.childCount, 2);
}
```

### User Override via Intervention

The adaptive algorithm runs by default. User can override:

- **"Explore all"** on a tree node → visits ALL children of that hub (ignores sample limit)
- **"Stop"** → stops immediately
- The tree shows which nodes were visited vs projected, so user can see what was sampled

---

## 6. Intervention Infrastructure (Track C) — Complete Design

### 6.1 Principles

1. **User is always in control**: Every automatic system action is visible and reversible
2. **No progress lost**: Interventions inject into the running exploration — never stop-and-restart (tree and discovered URLs are preserved)
3. **Two layers, one goal**: Strategic (Decision Cards, §9) and Tactical (Tree Node Actions, §4.2) both steer the same backend exploration via the same POST-alongside-SSE mechanism
4. **Guided mode activates everything**: All interventions are available in "Guided Discovery" (D7 §22). "Crawl Full Sitemap" skips discovery entirely. "Discover Everything" (future) auto-accepts decisions.

### 6.2 Architecture: POST-alongside-SSE

```
┌─────────────────────────────────────────────────────────────────────┐
│ Studio (Browser)                                                     │
│                                                                     │
│  DiscoveryPanel                                                     │
│    ├── DiscoveryConsole ─── Decision Cards ──┐                      │
│    │                                          │ ConsoleAction        │
│    ├── DiscoveryTree ─── Node Actions ───────┤                      │
│    │                                          ▼                      │
│    └── BrowserDiscoveryInline ──── handleDiscoveryAction()           │
│              │                           │                           │
│     EventSource (SSE) ◄──────┐    POST /intervention ──────┐       │
│              │                │           │                  │       │
└──────────────┼────────────────┼───────────┼──────────────────┼───────┘
               │                │           │                  │
┌──────────────┼────────────────┼───────────┼──────────────────┼───────┐
│ Search-AI    │                │           │                  │       │
│              ▼                │           ▼                  │       │
│     SSE proxy (events) ──────┘   Intervention endpoint      │       │
│                                       │                     │       │
│                               Forward to MCP ───────────────┘       │
└───────────────────────────────────────┼─────────────────────────────┘
                                        │
┌───────────────────────────────────────┼─────────────────────────────┐
│ Crawler MCP Server                    ▼                             │
│                              command-queue.ts                       │
│                              enqueueCommand()                       │
│                                       │                             │
│                              depth-prober.ts                        │
│                              checkCommandQueue()                    │
│                              (between each page visit)              │
└─────────────────────────────────────────────────────────────────────┘
```

**What exists today:**

- `command-queue.ts`: In-memory per-exploration queue with enqueue/dequeue/peek/clear, 50 command cap, 30min TTL eviction
- `POST /discover/browser/:id/intervention` endpoint: Zod-validated, SSRF-protected, forwards to MCP
- `depth-prober.ts`: Calls `checkCommandQueue()` between breadcrumb visits — handles `stop` and `skip-branch`
- `BrowserDiscoveryInline.tsx`: `handleDiscoveryAction()` receives `ConsoleAction` but only handles `explore-branch` (stop+restart) and `proceed-to-crawl` (close)

### 6.3 Complete Intervention Catalog

#### I-1: Stop & Use Results (UX-9a)

**User intent**: "I have enough. Stop exploring and let me configure the crawl."

| Aspect             | Detail                                                                               |
| ------------------ | ------------------------------------------------------------------------------------ |
| **Trigger**        | Stop button (always visible during discovery), or Decision Card "Stop & use results" |
| **Mechanism**      | Frontend-only: `stopBrowserExplore()` closes SSE, sets status='done'                 |
| **Tree impact**    | Preserved — all discovered nodes remain                                              |
| **Section impact** | All included sections preserved, auto-added sections marked with [NEW]               |
| **Backend**        | Not needed — SSE close triggers cleanup                                              |
| **Transition**     | Status → `done`, completion decision cards appear                                    |
| **Status**         | **Implemented** (stop button works)                                                  |

**Wireframe:**

```
┌─────────────────────────────────────────┐
│ [■ Stop]  Exploring... 47 nodes found   │
└─────────────────────────────────────────┘
      │
      ▼ user clicks Stop
┌─────────────────────────────────────────┐
│ ✓ Discovery stopped — 47 nodes found    │
│                                         │
│ [Use these results]  [Explore more...]  │  ← completion decision cards
└─────────────────────────────────────────┘
```

---

#### I-2: Run in Background (UX-9b)

**User intent**: "Keep discovering, but let me review what you've found so far."

| Aspect             | Detail                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**        | "Run in background" button or Decision Card                                                                                                    |
| **Mechanism**      | Frontend-only: CSS collapse DiscoveryPanel to a compact banner. SSE stays open, progress events still update tree/console in background state. |
| **Tree impact**    | Continues growing — user can expand banner to see full tree at any time                                                                        |
| **Section impact** | Auto-added sections appear in the section list below the banner with [NEW] badges                                                              |
| **Backend**        | No change — exploration continues                                                                                                              |
| **Transition**     | Panel collapses to 1-line banner. Completion triggers expand prompt.                                                                           |
| **Status**         | **Designed, not implemented**                                                                                                                  |

**Wireframe — collapsed banner:**

```
┌──────────────────────────────────────────────────────────┐
│ 🔍 Discovery running... 89 links · 12 pages   [View] [■]│
└──────────────────────────────────────────────────────────┘
```

**Wireframe — completion notification (banner):**

```
┌──────────────────────────────────────────────────────────┐
│ ✓ Discovery complete — 340 URLs, 3 new sections          │
│   [Review results]  [Auto-include all]                   │
└──────────────────────────────────────────────────────────┘
```

**Component state:**

```typescript
interface BackgroundModeState {
  /** Whether panel is collapsed to banner */
  isBackground: boolean;
  /** Stats tracked while in background */
  bgStats: { linksAtCollapse: number; pagesAtCollapse: number; newSections: number };
}
```

---

#### I-3: Add Sample URL (UX-9c)

**User intent**: "I know a specific page I want you to visit — add it to the exploration queue."

| Aspect               | Detail                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------- |
| **Trigger**          | Manual URL paste input in console area, or "Add URL" chip                                     |
| **Mechanism**        | POST `/intervention` with `{ type: 'add-sample', payload: { url } }`                          |
| **Tree impact**      | URL added to exploration queue; when visited, new tree nodes appear                           |
| **Backend handling** | `depth-prober.ts` checks queue → sees `add-sample` → adds URL to frontier with priority boost |
| **Validation**       | Same-origin check (must match base domain), SSRF protection                                   |
| **Status**           | **Backend endpoint implemented**, **frontend input not wired**                                |

**Wireframe — inline input:**

```
┌── Discovery Console ────────────────────────────────────┐
│ 14:32:10 Visiting /support/printers/...                 │
│ 14:32:12 Found 15 child links                          │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 🔗 Add URL to explore: [https://epson.com/...    ] │ │
│ │                                    [Add to queue]  │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Console feedback after adding:**

```
14:32:15  ➕ Queued /support/faq for exploration (user-added)
14:32:20  Visiting /support/faq... (user-requested)          ← when depth-prober reaches it
```

**Backend change needed in `depth-prober.ts`:**

```typescript
// In checkCommandQueue handling:
if (cmd.type === 'add-sample' && cmd.payload?.url) {
  // Add to frontier with high priority so it's visited next
  frontier.push({ url: cmd.payload.url, depth: 0, priority: 'user-requested' });
  emitProgress(); // Notify frontend that URL was queued
}
```

---

#### I-4: Explore Branch (UX-9e)

**User intent**: "This section looks interesting — go deeper here."

| Aspect               | Detail                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**          | Tree node action "Visit & discover" or "Go deeper", or Decision Card "Explore {section}"                                                  |
| **Mechanism**        | POST `/intervention` with `{ type: 'explore-branch', payload: { url } }`                                                                  |
| **Tree impact**      | Target node transitions to `visiting` state (spinner), children appear as discovered                                                      |
| **Backend handling** | `depth-prober.ts` checks queue → sees `explore-branch` → pushes URL to front of frontier, visits it on next iteration, discovers children |
| **Console feedback** | "User requested: explore /support/scanners" → "Visiting /support/scanners..." → "Found 28 child links"                                    |
| **Status**           | **Backend endpoint implemented**, **depth-prober handles `stop` and `skip-branch` only — needs `explore-branch` handler**                 |

**Backend change needed in `depth-prober.ts`:**

```typescript
// In checkCommandQueue handling (add after skip-branch):
if (cmd.type === 'explore-branch' && cmd.payload?.url) {
  // Insert at front of breadcrumb queue with high priority
  const targetUrl = cmd.payload.url;
  sortedCrumbs.unshift({
    href: targetUrl,
    text: new URL(targetUrl).pathname.split('/').filter(Boolean).pop() ?? targetUrl,
    depth: 0, // treated as a new root for exploration
  });
  progress.currentAction = `User requested: exploring ${new URL(targetUrl).pathname}`;
  emitProgress();
}
```

**Visual state transitions:**

```
Tree before:                            Tree after user clicks "Visit & discover":
  ▶ Scanners (projected) [🧭][+][x]   →   ⟳ Scanners (visiting...)
                                              ○ WF-2860 (discovered)
                                              ○ DS-530 (discovered)
                                              ○ ES-580W (discovered)
```

---

#### I-5: Skip Branch (UX-9f)

**User intent**: "I don't need this section — skip it."

| Aspect               | Detail                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**          | Tree node action "Skip" or "Skip branch", or Decision Card "Skip {section}"                                                                                         |
| **Mechanism**        | Dual: (1) Client-side: mark node as `skipped` in tree state. (2) POST `/intervention` with `{ type: 'skip-branch', payload: { url } }` so backend doesn't visit it. |
| **Tree impact**      | Node and all children transition to `skipped` state (greyed out with strikethrough). Undo available.                                                                |
| **Section impact**   | If node was part of an auto-added section, section gets excluded                                                                                                    |
| **Backend handling** | `depth-prober.ts` already handles: `if (cmd.type === 'skip-branch' && cmd.payload?.url === crumb.href) continue;`                                                   |
| **Status**           | **Fully implemented** (backend + tree node state change)                                                                                                            |

**Visual state transitions:**

```
Before:                                After skip:                    After undo:
  ○ Downloads (discovered)             ⊘ Downloads (skipped)          ○ Downloads (discovered)
    ○ Drivers                            ⊘ Drivers                      ○ Drivers
    ○ Firmware                           ⊘ Firmware                     ○ Firmware
         [🧭][+][x]                          [↩ Undo skip]                  [🧭][+][x]
```

---

#### I-6: Explore All at Level (UX-9g)

**User intent**: "Visit all the sibling sections at this level."

| Aspect               | Detail                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Trigger**          | Tree node action "Add all children to crawl" on a visited hub, or Decision Card "Explore all {N} remaining sections" |
| **Mechanism**        | POST `/intervention` with `{ type: 'explore-all', payload: { urls: [...siblingUrls] } }`                             |
| **Tree impact**      | Multiple nodes transition to `visiting` state; results appear incrementally                                          |
| **Backend handling** | `depth-prober.ts` checks queue → sees `explore-all` → adds all URLs to frontier                                      |
| **Rate limiting**    | Max 20 URLs per `explore-all` intervention (prevent runaway)                                                         |
| **Status**           | **Backend endpoint accepts type**, **depth-prober does not handle it yet**                                           |

**Backend change needed in `depth-prober.ts`:**

```typescript
if (cmd.type === 'explore-all' && cmd.payload?.urls) {
  const urls = cmd.payload.urls.slice(0, 20); // cap at 20
  for (const url of urls) {
    if (!visitedUrls.has(normalizeUrl(url))) {
      sortedCrumbs.unshift({
        href: url,
        text: new URL(url).pathname.split('/').filter(Boolean).pop() ?? url,
        depth: 0,
      });
    }
  }
  progress.currentAction = `User requested: exploring ${urls.length} sections`;
  emitProgress();
}
```

---

#### I-7: Undo Skip

**User intent**: "I changed my mind — bring back that section I skipped."

| Aspect          | Detail                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Trigger**     | Tree node action "Undo skip" on a skipped node                                                                       |
| **Mechanism**   | Client-only: transition node from `skipped` back to `discovered`. POST `undo-skip` to backend to re-add to frontier. |
| **Tree impact** | Node and children revert to `discovered` state, actions become available again                                       |
| **Status**      | **Frontend tree-utils has the action defined**, **backend endpoint accepts type**, **wiring incomplete**             |

---

#### I-8: Add to Scope (without exploring)

**User intent**: "I want to crawl this URL/branch without exploring it further."

| Aspect             | Detail                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**        | Tree node action "Add to scope" (+), or Decision Card "Include {category}"                                                   |
| **Mechanism**      | Client-only: adds URL(s) to crawl scope. If crawl-as-you-discover is active (D6), immediately queues for crawling.           |
| **Tree impact**    | Node gets a checkmark badge (✓ scope). Does NOT trigger exploration.                                                         |
| **Section impact** | URL/pattern added as a section or merged into existing section                                                               |
| **Backend**        | No intervention POST needed — scope management is frontend state. Crawl-as-you-discover pipeline handles actual crawl queue. |
| **Status**         | **Tree action defined**, **wiring to section state incomplete**                                                              |

---

#### I-9: Add Children to Scope

**User intent**: "Include all children of this hub in the crawl, without exploring each one."

| Aspect          | Detail                                                        |
| --------------- | ------------------------------------------------------------- |
| **Trigger**     | Tree node action "Add all children to crawl" on a visited hub |
| **Mechanism**   | Client-only: bulk-adds all child URLs to crawl scope          |
| **Tree impact** | All children get ✓ scope badge                                |
| **Status**      | **Tree action defined**, **wiring incomplete**                |

---

#### I-10: Edit Samples / Pause-Resume (UX-9d)

**User intent**: "I want to change the sample URLs while discovery is running."

| Aspect                    | Detail                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**               | "Edit samples" button in the DiscoveryConsole or sample URL chip area                                                                                                       |
| **Mechanism**             | Phase 1 (current): Stop discovery, edit samples, restart. Phase 2 (future): Pause via POST, edit, resume via POST.                                                          |
| **Progress preservation** | Phase 1: Tree and sections are preserved in React state, but backend exploration restarts. Phase 2: Backend pauses, queue drains, edits applied, resume from current state. |
| **Status**                | **Phase 1 possible today** (stop/restart pattern), **Phase 2 not implemented**                                                                                              |

**Phase 1 wireframe:**

```
User clicks "Edit samples"
  → Discovery stops (tree preserved)
  → Sample URL inputs become editable
  → Confirmation: "Discovery will restart with your changes. Progress is preserved."
  → User edits → clicks "Resume"
  → BrowserDiscoveryInline restarts with new sampleUrls
  → Tree continues from existing state (nav nodes preserved, depth probing restarts)
```

### 6.4 Intervention ↔ Strategy Mode Matrix

Not all interventions make sense in every strategy mode:

| Intervention              | Crawl Sitemap | Discover Everything (future) | Guided Discovery   |
| ------------------------- | ------------- | ---------------------------- | ------------------ |
| I-1 Stop & use results    | N/A           | ✅ (stop auto-discovery)     | ✅                 |
| I-2 Run in background     | N/A           | ✅                           | ✅                 |
| I-3 Add sample URL        | N/A           | ✅ (added to auto queue)     | ✅                 |
| I-4 Explore branch        | N/A           | Auto (system decides)        | ✅ (user triggers) |
| I-5 Skip branch           | N/A           | N/A (auto-includes all)      | ✅ (user triggers) |
| I-6 Explore all at level  | N/A           | Auto                         | ✅ (user triggers) |
| I-7 Undo skip             | N/A           | N/A                          | ✅                 |
| I-8 Add to scope          | N/A           | Auto                         | ✅ (user triggers) |
| I-9 Add children to scope | N/A           | Auto                         | ✅ (user triggers) |
| I-10 Edit samples         | N/A           | ✅                           | ✅                 |

### 6.5 Frontend Action Dispatch

All interventions flow through a single dispatch function in `BrowserDiscoveryInline.tsx`:

```typescript
const handleDiscoveryAction = useCallback(
  async (action: ConsoleAction) => {
    const exploreId = exploreIdRef.current;

    // ── Decision Card actions ──
    if (action.type === 'decision-card') {
      const card = action.card;
      switch (card.action.type) {
        case 'proceed-to-crawl':
          onClose(); // transition to configure step
          return;
        case 'explore-branch':
          await postIntervention(exploreId, {
            type: 'explore-branch',
            payload: { url: card.action.payload.url },
          });
          return;
        case 'explore-all-nav':
          await postIntervention(exploreId, {
            type: 'explore-all',
            payload: { urls: card.action.payload.urls },
          });
          return;
        case 'add-category':
          // Client-only: add URLs to scope
          addUrlsToScope(card.action.payload.urls ?? []);
          return;
        case 'skip-category':
          // Client + backend: skip all URLs in category
          for (const url of card.action.payload.urls ?? []) {
            await postIntervention(exploreId, {
              type: 'skip-branch',
              payload: { url },
            });
          }
          return;
        case 'browse-titles':
          setShowBrowseTitles(true);
          return;
      }
    }

    // ── Tree node actions (interventions) ──
    if (action.type === 'intervention') {
      const { type, payload } = action.intervention;
      switch (type) {
        case 'stop':
          handleStop();
          return;
        case 'explore-branch':
        case 'add-sample':
        case 'explore-all':
        case 'skip-branch':
        case 'undo-skip':
          await postIntervention(exploreId, action.intervention);
          return;
        case 'add-to-scope':
        case 'add-children-to-scope':
          // Client-only: add to scope, no backend call
          addUrlsToScope(payload?.urls ?? (payload?.url ? [payload.url] : []));
          return;
        case 'background':
          setBackgroundMode(true);
          return;
      }
    }

    // ── Browse titles ──
    if (action.type === 'browse-titles') {
      setShowBrowseTitles(true);
    }

    // ── Crawl mode change ──
    if (action.type === 'set-crawl-mode') {
      setCrawlConfig(action.config);
    }
  },
  [handleStop, onClose],
);

/** POST intervention to backend */
async function postIntervention(
  exploreId: string | null,
  intervention: Intervention,
): Promise<void> {
  if (!exploreId) return;
  try {
    await fetch(`/api/crawl/discover/browser/${exploreId}/intervention`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intervention),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Intervention failed:', msg); // TODO: toast
  }
}
```

### 6.6 Backend Command Processing (depth-prober.ts)

The depth-prober currently only handles `stop` and `skip-branch`. Complete handling for all intervention types:

```typescript
// Between each page visit in any exploration phase:
const cmd = checkCommandQueue();
if (cmd) {
  switch (cmd.type) {
    case 'stop':
      // Terminate exploration
      return; // break out of current loop

    case 'skip-branch':
      // Skip this URL if it matches
      if (cmd.payload?.url) {
        skipSet.add(normalizeUrl(cmd.payload.url));
        progress.currentAction = `Skipped: ${cmd.payload.url}`;
        emitProgress();
      }
      break;

    case 'explore-branch':
      // Prioritize this URL — insert at front of frontier
      if (cmd.payload?.url && !visitedUrls.has(normalizeUrl(cmd.payload.url))) {
        frontier.unshift({
          href: cmd.payload.url,
          text: extractPathSegment(cmd.payload.url),
          depth: 0,
          priority: 'user-requested',
        });
        progress.currentAction = `Queued for exploration: ${cmd.payload.url}`;
        emitProgress();
      }
      break;

    case 'add-sample':
      // Add URL to frontier with user-requested priority
      if (cmd.payload?.url && !visitedUrls.has(normalizeUrl(cmd.payload.url))) {
        frontier.push({
          href: cmd.payload.url,
          text: extractPathSegment(cmd.payload.url),
          depth: 0,
          priority: 'user-requested',
        });
        progress.currentAction = `User added sample: ${cmd.payload.url}`;
        emitProgress();
      }
      break;

    case 'explore-all':
      // Batch-add multiple URLs to frontier
      if (cmd.payload?.urls) {
        const added: string[] = [];
        for (const url of cmd.payload.urls.slice(0, 20)) {
          if (!visitedUrls.has(normalizeUrl(url))) {
            frontier.unshift({
              href: url,
              text: extractPathSegment(url),
              depth: 0,
              priority: 'user-requested',
            });
            added.push(url);
          }
        }
        progress.currentAction = `Queued ${added.length} URLs for exploration`;
        emitProgress();
      }
      break;

    case 'undo-skip':
      // Remove URL from skip set
      if (cmd.payload?.url) {
        skipSet.delete(normalizeUrl(cmd.payload.url));
        // Re-add to frontier if not already visited
        if (!visitedUrls.has(normalizeUrl(cmd.payload.url))) {
          frontier.push({
            href: cmd.payload.url,
            text: extractPathSegment(cmd.payload.url),
            depth: 0,
            priority: 'normal',
          });
        }
        progress.currentAction = `Undo skip: ${cmd.payload.url}`;
        emitProgress();
      }
      break;

    case 'add-to-scope':
    case 'add-children-to-scope':
      // These are client-only — no backend action needed
      // (included in command-queue schema for completeness but no-op on backend)
      break;
  }
}
```

**Key design decisions:**

- `explore-branch` uses `unshift` (front of queue) → visited next
- `add-sample` uses `push` (back of queue) → visited when current work completes
- `explore-all` uses `unshift` with 20-URL cap → batch exploration starts immediately
- `skipSet` persists across the exploration session — backend won't revisit skipped URLs
- Every command that changes state emits a progress event so the frontend sees immediate feedback

### 6.7 Console Feedback for Every Intervention

Every intervention produces a timestamped console entry so the user knows their action was received:

| Intervention   | Console Entry                                             |
| -------------- | --------------------------------------------------------- |
| Stop           | `✓ Discovery stopped — {N} URLs found`                    |
| Background     | `▶ Running in background — you can review sections below` |
| Add sample     | `➕ Queued {url} for exploration (user-added)`            |
| Explore branch | `🧭 Exploring {section name}... (user-requested)`         |
| Skip branch    | `⊘ Skipped {section name} and {N} children`               |
| Explore all    | `🧭 Exploring {N} sections... (user-requested)`           |
| Undo skip      | `↩ Restored {section name} — will be explored`            |
| Add to scope   | `✓ Added {section name} to crawl scope ({N} URLs)`        |
| Add children   | `✓ Added {N} children of {section name} to crawl scope`   |

### 6.8 Auto-Add Sections with Visual Distinction (D5)

When discovery finds a clear cluster of URLs matching a pattern, the section is **auto-added** to the section list. In **Guided Discovery** mode, the user confirms or rejects; in **Discover Everything** mode (future), all are auto-included.

**Auto-add criteria** — a cluster becomes an auto-added section when:

1. Pattern has >= 5 matched URLs AND
2. Confidence is 'verified' (at least 2 pages actually visited) AND
3. URLs are under a consistent URL prefix (not scattered)

**Visual distinction in section list:**

```typescript
interface SectionDisplayState {
  /** How this section was created */
  origin: 'user-created' | 'auto-discovered' | 'sitemap';
  /** Whether user has explicitly confirmed this section */
  confirmed: boolean;
  /** Whether user has dismissed/removed this section */
  dismissed: boolean;
}
```

**Wireframe — auto-added sections below user sections:**

```
── Your Sections ──────────────────────────────────────
  ✅ Printers (45 pages)            [configured by user]
  ✅ Support Articles (23 pages)    [configured by user]

── Added from discovery ──────────────────────────────
  🆕 Scanners (28 pages)            [include ✓] [exclude]
  🆕 Downloads (34 pages)           [include ✓] [exclude]
  🆕 FAQ (12 pages)                 [include ✓] [exclude]

  [Include all new]  [Exclude all new]
```

**Console notification**: `14:32:08  Auto-added "ET-Series" section (12 URLs matched) [NEW]`

**Rules:**

- Does NOT auto-add projected-only clusters (need at least 2 verified)
- Does NOT add if user already has a section covering the same URL prefix
- In Guided mode: does NOT auto-start crawling — sections are in "ready" state, user confirms
- In Discover Everything mode (future): auto-included and auto-starts crawling if D6 is active
- Badge disappears after user interacts with the section (edit, confirm, toggle)
- Dismissing (excluding) is reversible — section moves to a collapsed "Excluded" group

### 6.9 Transparency Features

#### 6.9.1 "Next Actions" Queue Display (§16.1, Obj-1)

Show what the system plans to do next — not just what it's doing now:

```
── Discovery Console ─────────────────────────────────
  14:32:10  Visiting /support/printers/et-series...

  Coming up:
    1. /support/scanners (breadcrumb hub — 28 estimated)
    2. /support/projectors (breadcrumb hub — 15 estimated)
    3. /downloads (nav section — not yet visited)
```

**Data source**: `nextTargets` field in enriched `DepthProbeProgress`:

```typescript
// Already defined in progress type — needs to be populated by depth-prober
interface DepthProbeProgress {
  // ... existing fields ...
  nextTargets?: Array<{ url: string; reason: string }>;
}
```

**Backend**: Depth-prober exposes the top 3 entries from its internal frontier. Emitted with each progress event.

#### 6.9.2 Iteration History Display (§16.2, Obj-8)

When user runs multiple discovery iterations (explore branch, then another branch), show aggregate progress:

```
── Discovery History ─────────────────────────────────
  Run 1: Seed /support/printers → 553 URLs, 8 pages visited
  Run 2: Explore /support/scanners → 200 new URLs, 5 pages visited
  Run 3: Explore /downloads → 38 new URLs, 3 pages visited
  ─────────────────────────────────────────────────
  Total: 791 unique URLs from 16 pages across 3 runs
```

**Data model:**

```typescript
interface DiscoveryIteration {
  runId: string;
  seed: string;
  trigger: 'initial' | 'explore-branch' | 'explore-all' | 'add-sample';
  newUrlCount: number;
  pagesVisited: number;
  duration: number;
  timestamp: number;
}
```

**Frontend**: Tracked in `DiscoveryPanel` state. Each `explore-branch` or `explore-all` intervention starts a new iteration. Displayed in a collapsible "History" section of the console.

### 6.10 Implementation Priority

| Priority                      | Interventions                                                            | Reason                                                            |
| ----------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **P0 — Guided Discovery MVP** | I-1 (stop), I-4 (explore branch), I-5 (skip branch), I-8 (add to scope)  | Core selection loop: browse tree → explore or skip → add to scope |
| **P1 — Full steering**        | I-3 (add sample), I-6 (explore all), I-7 (undo skip), I-9 (add children) | Complete set of user controls                                     |
| **P2 — Background + polish**  | I-2 (background), I-10 (edit samples), §6.9 transparency features        | Nice-to-have for power users                                      |

---

## 7. Implementation Order

### Sprint 1: Foundation (~2 days)

1. **DiscoveryActivity.tsx** — natural language status replacing current progress display
2. **DiscoveryTree.tsx** — tree built from accumulated progress events
3. **DiscoveryPanel.tsx** — wraps Activity + Tree inside BrowserDiscoveryInline
4. Wire into BrowserDiscoveryInline running state

### Sprint 2: Interactions (~2 days)

5. **Background mode** — collapse to banner, user works on sections
6. **Tree interactions** — Explore (stop+restart), Skip (client-only)
7. **"Grouping URLs..."** status in timeline during clustering

### Sprint 3: Adaptive Budget (~1 day)

8. **Diminishing returns** in depth-prober.ts (replace static caps)
9. **Adaptive sampleSize** based on hub child count
10. **Yield indicator** in DiscoveryActivity

### Sprint 4: Polish (~2 days)

11. **State4Crawl.tsx** — crawl progress in-panel
12. **Wire crawling/done** in CrawlFlowV5
13. **Non-destructive back** (Step 2→1)
14. **Manual URL paste** in Step 2
15. **Custom scope input** in Step 3

---

## 8. New Types

### 8.1 Canonical `DiscoveredUrl` Type

**[C1 Resolution]** Neither `DiscoveredLink` (navigation-explorer) nor `DepthProbeLink` (depth-prober) has all fields needed by the frontend algorithms. We define a canonical frontend type and explicit mappers.

**Location**: `packages/crawler/src/types/discovered-url.ts` (shared between backend and frontend)

```typescript
// ─── Canonical URL type — used by all frontend algorithms ────────

interface DiscoveredUrl {
  /** Normalized absolute URL */
  href: string;
  /** Link text or page title (from anchor text, then enriched by visit) */
  text: string;
  /** How this URL was found */
  confidence: 'verified' | 'projected' | 'inferred';
  /** Depth in the site hierarchy */
  depth: number;
  /** Which URL group/pattern this belongs to */
  group?: string;
  /** Page role if visited */
  sourceRole?: 'hub' | 'leaf' | 'mixed';
  /** Breadcrumb chain from root to this URL (populated from depth prober) */
  breadcrumbChain?: Array<{ text: string; href: string }>;
  /** Title of the page (populated when page was actually visited) */
  pageTitle?: string;
}

// ─── Mappers from actual backend types ──────────────────────────

function fromDepthProbeLink(link: DepthProbeLink, breadcrumbs?: Breadcrumb[]): DiscoveredUrl {
  return {
    href: link.href,
    text: link.text,
    confidence: link.confidence, // already 'verified' | 'projected' | 'inferred'
    depth: link.depth,
    group: link.group,
    sourceRole: link.sourceRole,
    breadcrumbChain: breadcrumbs?.map((b) => ({ text: b.text, href: b.href })),
  };
}

function fromDiscoveredLink(link: DiscoveredLink): DiscoveredUrl {
  return {
    href: link.href,
    text: link.text,
    confidence: 'verified', // DiscoveredLink has no confidence → always verified
    depth: 0, // DiscoveredLink has no depth → seed level
    group: undefined,
    sourceRole: undefined,
    breadcrumbChain: undefined,
  };
}
```

**Mapping point**: In `BrowserDiscoveryInline.tsx`, when the `complete` SSE event arrives, `result.links` (typed as `DepthProbeLink[]` from the proxy) are mapped via `fromDepthProbeLink` before being passed to any algorithm. The breadcrumb chain comes from `result.breadcrumbs`.

### 8.2 Shared Utility: `isLikelyVariable`

**[C3 Resolution]** This function exists in `apps/search-ai/src/services/crawler/pattern-matcher.ts` (backend-only). For frontend use, we extract it to the shared `packages/crawler` package.

**Location**: `packages/crawler/src/intelligence/utils/url-heuristics.ts`

```typescript
/**
 * Heuristic: does this URL path segment look like a variable (SKU, UUID, ID)?
 * Used in both backend pattern-matcher and frontend objective derivation.
 */
export function isLikelyVariable(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true; // pure numeric
  if (/^[0-9a-f]{8,}$/i.test(segment)) return true; // hex hash
  if (/^[A-Z]{1,3}[-_]\d{3,}/i.test(segment)) return true; // SKU: ET-2850, XP-5200
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment)) return true; // UUID prefix
  if (segment.length > 30) return true; // very long slug
  return false;
}
```

### 8.3 Discovery Tree

```typescript
// ─── Discovery Tree ──────────────────────────────────────────────

interface DiscoveryTreeNode {
  /** Display name — human-friendly version of path segment */
  displayName: string;
  /** Raw URL path segment (for matching/lookup) */
  pathSegment: string;
  /** Full URL */
  url: string;
  /** Source of this node */
  source: 'breadcrumb' | 'visited-hub' | 'sibling' | 'projected' | 'seed' | 'nav-extracted';
  /** Current state */
  state: 'visited' | 'discovered' | 'visiting' | 'skipped' | 'failed';
  /** Links found at this node (only for visited) */
  linkCount?: number;
  /** Child nodes */
  children: DiscoveryTreeNode[];
  /** Depth in tree */
  depth: number;
  /** Confidence */
  confidence: 'verified' | 'projected';
  /** Page classification (hub/leaf/mixed) */
  role?: 'hub' | 'leaf' | 'mixed';
  /** Page title if visited (from <title> or breadcrumb text) */
  title?: string;
}

// [M5 Resolution] displayName is for UI rendering (title-cased, hyphens → spaces),
// pathSegment is for tree lookups (exact match against URL segments).
// formatDisplayName('All-In-Ones') → "All In Ones"
function formatDisplayName(segment: string): string {
  return segment.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
```

### 8.4 Discovery Console & Intervention Types

```typescript
// ─── Console Types ───────────────────────────────────────────────

interface YieldStatus {
  rate: number;
  trend: 'increasing' | 'stable' | 'declining' | 'exhausted';
  label: string;
}

// Console action — triggered by action chips or Decision Cards
type ConsoleAction =
  | { type: 'intervention'; intervention: Intervention }
  | { type: 'decision-card'; card: DecisionCard }
  | { type: 'browse-titles' }
  | { type: 'set-crawl-mode'; config: CrawlAsYouDiscoverConfig };

// ─── Intervention ────────────────────────────────────────────────

type InterventionType =
  | 'stop'
  | 'background'
  | 'add-sample'
  | 'edit-pause'
  | 'explore-branch'
  | 'skip-branch'
  | 'explore-all'
  | 'undo-skip' // [Obj-2 gap] undo for accidental skip
  | 'add-to-scope' // [D4] add URL to crawl scope without exploring
  | 'add-children-to-scope'; // [D4] add all children of hub to scope

interface Intervention {
  type: InterventionType;
  payload?: { url?: string; urls?: string[]; maxDepth?: number };
}
```

### 8.5 Content Tag Matchers

**[L2 Resolution]** Define the constant referenced in §9.4:

```typescript
const CONTENT_TAG_MATCHERS: Record<string, { matchers: ObjectiveMatcher[] }> = {
  products: {
    matchers: [
      { type: 'title-keyword', pattern: 'product', weight: 0.9 },
      { type: 'url-regex', pattern: '/(products?|shop|store|catalog)(/|$)', weight: 0.8 },
      { type: 'breadcrumb-label', pattern: 'product', weight: 0.7 },
    ],
  },
  faq: {
    matchers: [
      { type: 'title-keyword', pattern: 'faq', weight: 0.9 },
      { type: 'title-keyword', pattern: 'frequently asked', weight: 0.9 },
      { type: 'url-regex', pattern: '/(faq|help|questions)(/|$)', weight: 0.8 },
    ],
  },
  support: {
    matchers: [
      { type: 'title-keyword', pattern: 'support', weight: 0.9 },
      { type: 'url-regex', pattern: '/(support|help|service)(/|$)', weight: 0.8 },
    ],
  },
  downloads: {
    matchers: [
      { type: 'title-keyword', pattern: 'download', weight: 0.9 },
      { type: 'url-regex', pattern: '/(downloads?|drivers?|software|firmware)(/|$)', weight: 0.8 },
    ],
  },
  docs: {
    matchers: [
      { type: 'title-keyword', pattern: 'documentation', weight: 0.9 },
      { type: 'url-regex', pattern: '/(docs?|documentation|guides?|manuals?)(/|$)', weight: 0.8 },
    ],
  },
  blog: {
    matchers: [
      { type: 'title-keyword', pattern: 'blog', weight: 0.9 },
      { type: 'url-regex', pattern: '/(blog|news|articles?|posts?)(/|$)', weight: 0.8 },
    ],
  },
};
```

---

## 9. Dynamic Decision Cards — Context-Aware User Guidance

### 9.1 The Problem with Free-Text Objectives

Users think in **intent**, not URL patterns. But free-text input ("Find all FAQ pages") is:

- Hard to parse reliably (what does "pages like this" mean?)
- Overwhelming — user doesn't know what to type
- Error-prone — user can type things the system can't act on

### 9.2 Solution: Decision Cards

Instead of free-text, the system generates **context-aware action cards** based on what it has discovered. These appear at the bottom of the Discovery Console (§4.3) and change dynamically as discovery progresses.

**Key principle**: The user never types free text for objectives. They click cards that the system generates from real discovered content. The "I'm looking for something else..." fallback shows a **filtered dropdown of discovered page titles and URL patterns** — not a text input.

#### Two Layers of Steering

**Layer 1 — Tactical** (§4.2): Per-node action verbs in the tree — Visit & discover, Add to crawl scope, Go deeper, Verify, Skip. Like turn-by-turn directions.

**Layer 2 — Strategic** (Decision Cards): System-generated cards based on discovery state. Like a GPS suggesting destinations from your current location.

### 9.3 Decision Card Data Model

```typescript
// ─── Decision Cards ─────────────────────────────────────────────

interface DecisionCard {
  id: string;
  /** Human-readable action description */
  label: string;
  /** Why this card is being shown */
  reason: string;
  /** The action to take when clicked */
  action: DecisionAction;
  /** Priority for display ordering (higher = more prominent) */
  priority: number;
  /** Visual category for styling */
  category: 'explore' | 'add' | 'skip' | 'objective' | 'crawl';
  /** Optional data for rich rendering */
  meta?: {
    urlCount?: number;
    sectionName?: string;
    matchedPattern?: string;
    confidence?: number;
  };
}

interface DecisionAction {
  type:
    | 'explore-branch' // Visit a specific branch
    | 'explore-all-nav' // Visit all unexplored nav sections
    | 'add-category' // Add all URLs matching a category to scope
    | 'skip-category' // Skip all URLs matching a category
    | 'set-objective' // Set a strategic objective (generated, not free-text)
    | 'find-similar' // Find pages similar to a discovered one
    | 'proceed-to-crawl' // Move to crawl configuration
    | 'browse-titles'; // Show dropdown of discovered titles for selection
  payload: {
    url?: string;
    urls?: string[];
    category?: string;
    objectiveQuery?: string;
    objectiveMode?: ObjectiveMatchMode;
  };
}

// The objective is still created behind the scenes — but the USER never
// types it. The system derives it from the card action.
type ObjectiveMatchMode = 'title' | 'url-path' | 'by-example' | 'content-tag';

interface DiscoveryObjective {
  id: string;
  /** System-generated from decision card (NOT user-typed) */
  query: string;
  mode: ObjectiveMatchMode;
  matchers: ObjectiveMatcher[];
  status: 'searching' | 'partial' | 'satisfied' | 'no-matches';
  matchedUrls: string[];
  estimatedTotal: number;
  unexploredCandidates: UnexploredCandidate[];
  /** Which decision card created this objective */
  sourceCardId: string;
}

interface ObjectiveMatcher {
  type: 'title-keyword' | 'url-regex' | 'url-prefix' | 'breadcrumb-label';
  pattern: string;
  weight: number;
}

interface UnexploredCandidate {
  url: string;
  reason: string;
  confidence: number;
}
```

### 9.3b Decision Card Generation Algorithm

Cards are regenerated on three explicit triggers:

| Trigger            | When                                           | Cards Generated                                                                                                                      |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **hub-discovered** | After visiting a hub with >5 children          | Per-category actions: [Include in crawl], [Explore deeper], [Skip]. Quick bulk: [Include all N], [Include top 3 by size], [Skip all] |
| **yield-update**   | When yield trend changes (declining/exhausted) | [Stop & use results], [Switch to {unexplored branch}], [Adjust budget]                                                               |
| **complete**       | When discovery run finishes                    | [Proceed to crawl], [Explore {gap}] for each coverage gap, [Run another iteration]                                                   |

```typescript
function generateDecisionCards(
  phase: DiscoveryLoopState,
  tree: DiscoveryTreeNode[],
  navStructure: NavNode[] | null,
  discoveredUrls: DiscoveredUrlSet,
  objectives: DiscoveryObjective[],
  coverage: CoverageAnalysis | null,
): DecisionCard[] {
  const cards: DecisionCard[] = [];

  // ── Phase-specific cards ──

  if (phase === 'reviewing' || phase === 'auto-discovering') {
    // Card 1: Unexplored nav sections
    if (navStructure) {
      const unexplored = navStructure.filter(
        (nav) => !tree.some((t) => t.state === 'visited' && urlSharesPrefix(t.url, nav.href)),
      );
      for (const nav of unexplored.slice(0, 3)) {
        cards.push({
          id: `explore-nav-${nav.href}`,
          label: `Explore "${nav.label}" section`,
          reason: `Found in site navigation but not yet visited`,
          action: {
            type: 'explore-branch',
            payload: { url: nav.href },
          },
          priority: 80,
          category: 'explore',
          meta: { sectionName: nav.label, urlCount: nav.estimatedChildren },
        });
      }
      if (unexplored.length > 3) {
        cards.push({
          id: 'explore-all-nav',
          label: `Explore all ${unexplored.length} remaining sections`,
          reason: `${unexplored.length} navigation sections not yet visited`,
          action: { type: 'explore-all-nav', payload: { urls: unexplored.map((n) => n.href) } },
          priority: 70,
          category: 'explore',
        });
      }
    }

    // Card 2: High-yield branches with unvisited children
    const hubsWithChildren = flattenTree(tree).filter(
      (n) =>
        n.state === 'visited' &&
        n.role === 'hub' &&
        n.children.some((c) => c.state === 'discovered'),
    );
    for (const hub of hubsWithChildren.slice(0, 2)) {
      const unvisitedCount = hub.children.filter((c) => c.state === 'discovered').length;
      cards.push({
        id: `go-deeper-${hub.url}`,
        label: `Go deeper into "${hub.displayName}" (${unvisitedCount} unvisited)`,
        reason: `This hub has ${unvisitedCount} child pages not yet explored`,
        action: { type: 'explore-branch', payload: { url: hub.url } },
        priority: 60,
        category: 'explore',
        meta: { urlCount: unvisitedCount },
      });
    }

    // Card 3: Content-type objectives from discovered patterns
    if (coverage?.categories) {
      const lowCoverage = coverage.categories.filter((c) => c.confidence === 'low');
      for (const cat of lowCoverage.slice(0, 2)) {
        cards.push({
          id: `find-more-${cat.label}`,
          label: `Find more "${cat.label}" pages`,
          reason: `Only ${cat.verifiedCount} verified — likely more exist`,
          action: {
            type: 'set-objective',
            payload: { objectiveQuery: cat.label, objectiveMode: 'content-tag' },
          },
          priority: 50,
          category: 'objective',
          meta: { urlCount: cat.urlCount, confidence: cat.verifiedCount / cat.urlCount },
        });
      }
    }

    // Card 4: Skip suggestion for low-signal branches
    const lowSignalBranches = flattenTree(tree).filter(
      (n) => n.state === 'visited' && n.linkCount === 0 && n.role === 'leaf',
    );
    if (lowSignalBranches.length > 2) {
      cards.push({
        id: 'skip-low-signal',
        label: `Skip ${lowSignalBranches.length} empty pages (no content found)`,
        reason: 'These pages had no meaningful links or content',
        action: {
          type: 'skip-category',
          payload: { urls: lowSignalBranches.map((n) => n.url) },
        },
        priority: 30,
        category: 'skip',
      });
    }

    // Card 5: Quick bulk actions for categories (when multiple exist)
    if (coverage?.categories && coverage.categories.length > 2) {
      const allCats = coverage.categories;
      cards.push({
        id: 'bulk-include-all',
        label: `Include all ${allCats.length} categories in crawl`,
        reason: `Quick action: add all ${allCats.reduce((s, c) => s + c.urlCount, 0)} URLs to scope`,
        action: {
          type: 'add-category',
          payload: { urls: allCats.flatMap((c) => c.examples.map((e) => e.url)) },
        },
        priority: 45,
        category: 'add',
      });
      // Include top 3 by size
      const top3 = [...allCats].sort((a, b) => b.urlCount - a.urlCount).slice(0, 3);
      cards.push({
        id: 'bulk-include-top3',
        label: `Include top 3 by size (${top3.map((c) => c.label).join(', ')})`,
        reason: `${top3.reduce((s, c) => s + c.urlCount, 0)} URLs from largest categories`,
        action: {
          type: 'add-category',
          payload: { urls: top3.flatMap((c) => c.examples.map((e) => e.url)) },
        },
        priority: 44,
        category: 'add',
      });
      cards.push({
        id: 'bulk-skip-all',
        label: `Skip all categories`,
        reason: 'Discard everything and start fresh or try different seed URL',
        action: {
          type: 'skip-category',
          payload: { urls: allCats.flatMap((c) => c.examples.map((e) => e.url)) },
        },
        priority: 15,
        category: 'skip',
      });
    }
  }

  // ── Trigger: yield-update — when yield drops, offer redirect or stop ──

  if (phase === 'auto-discovering' || phase === 'targeted-discovering') {
    // Yield declining cards (generated when YieldTracker reports 'declining' or 'exhausted')
    const unexploredNav =
      navStructure?.filter(
        (nav) => !tree.some((t) => t.state === 'visited' && urlSharesPrefix(t.url, nav.href)),
      ) ?? [];

    if (unexploredNav.length > 0) {
      for (const nav of unexploredNav.slice(0, 3)) {
        cards.push({
          id: `switch-to-${nav.href}`,
          label: `Switch to "${nav.label}"`,
          reason: `${nav.estimatedChildren ?? '?'} pages estimated — not yet visited`,
          action: { type: 'explore-branch', payload: { url: nav.href } },
          priority: 55,
          category: 'explore',
          meta: { sectionName: nav.label },
        });
      }
    }
  }

  // ── Trigger: complete — discovery finished, offer next steps with gap analysis ──

  if (phase === 'reviewing') {
    // Gap-based exploration suggestions
    if (coverage?.unexploredNavCategories) {
      for (const gap of coverage.unexploredNavCategories.slice(0, 3)) {
        cards.push({
          id: `explore-gap-${gap.href}`,
          label: `Explore "${gap.label}" (not yet visited)`,
          reason: 'Found in site navigation but not covered by discovery',
          action: { type: 'explore-branch', payload: { url: gap.href } },
          priority: 65,
          category: 'explore',
          meta: { sectionName: gap.label, urlCount: gap.estimatedChildren },
        });
      }
    }

    // Run another iteration
    cards.push({
      id: 'run-another-iteration',
      label: 'Run another discovery iteration',
      reason: 'Explore deeper or discover more content with new seed',
      action: { type: 'explore-all-nav', payload: {} },
      priority: 40,
      category: 'explore',
    });
  }

  // ── Always-available cards ──

  // "I'm looking for something else" — shows dropdown, NOT free text
  cards.push({
    id: 'browse-titles',
    label: "I'm looking for something else...",
    reason: 'Browse discovered page titles and URL patterns',
    action: { type: 'browse-titles', payload: {} },
    priority: 10,
    category: 'explore',
  });

  // Proceed to crawl (if enough URLs discovered)
  if (discoveredUrls.size > 5) {
    cards.push({
      id: 'proceed-to-crawl',
      label: `Proceed to crawl (${discoveredUrls.size} URLs ready)`,
      reason: 'Configure crawl scope and start extraction',
      action: { type: 'proceed-to-crawl', payload: {} },
      priority: 20,
      category: 'crawl',
    });
  }

  // Sort by priority descending
  return cards.sort((a, b) => b.priority - a.priority);
}
```

### 9.3c "Browse Titles" Dropdown (Fallback Instead of Free Text)

When user clicks "I'm looking for something else...", instead of a text input, show a **searchable dropdown** of all discovered content:

```typescript
interface BrowseTitlesState {
  /** All discovered page titles + URL segments, deduped */
  items: BrowseItem[];
  /** Filter text (filters the dropdown, NOT sent as free text objective) */
  filterText: string;
  /** Grouped by category for easier browsing */
  groups: BrowseGroup[];
}

interface BrowseItem {
  label: string; // page title or formatted URL segment
  url: string; // the actual URL
  source: 'title' | 'url-segment' | 'nav-label';
  count: number; // how many URLs share this pattern
}

interface BrowseGroup {
  label: string; // e.g., "Support", "Products", "Downloads"
  items: BrowseItem[];
}

function buildBrowseItems(
  discoveredUrls: DiscoveredUrlSet,
  tree: DiscoveryTreeNode[],
  navStructure: NavNode[] | null,
): BrowseItem[] {
  const items: BrowseItem[] = [];
  const seen = new Set<string>();

  // From discovered URL titles
  for (const url of discoveredUrls.values()) {
    if (url.text && !seen.has(url.text.toLowerCase())) {
      seen.add(url.text.toLowerCase());
      items.push({ label: url.text, url: url.href, source: 'title', count: 1 });
    }
  }

  // From tree node display names (grouped)
  for (const node of flattenTree(tree)) {
    if (!seen.has(node.displayName.toLowerCase())) {
      seen.add(node.displayName.toLowerCase());
      items.push({
        label: node.displayName,
        url: node.url,
        source: 'url-segment',
        count: node.children.length || 1,
      });
    }
  }

  // From nav labels
  if (navStructure) {
    for (const nav of navStructure) {
      if (!seen.has(nav.label.toLowerCase())) {
        seen.add(nav.label.toLowerCase());
        items.push({
          label: nav.label,
          url: nav.href,
          source: 'nav-label',
          count: nav.estimatedChildren ?? 0,
        });
      }
    }
  }

  return items.sort((a, b) => b.count - a.count);
}
```

**UI**: Rendered as a searchable dropdown with type-ahead filtering:

```
┌──────────────────────────────────────────┐
│ 🔍 Filter by title or section...         │
├──────────────────────────────────────────┤
│ Support (45 pages)              [Explore] │
│ Printers (32 pages)             [Explore] │
│ ET-Series (15 pages)          [Add to scope]│
│ FAQ (12 pages)                  [Explore] │
│ How to clean print heads       [Add to scope]│
│ Ink replacement guide          [Add to scope]│
│ Downloads (not explored)        [Explore] │
│ ...                                       │
└──────────────────────────────────────────┘
```

When user selects an item, the system creates the appropriate objective automatically (using `deriveMatchers` from §9.4) — the user never needs to understand match modes or type queries.

### 9.4 Algorithm: Objective → Matchers

When user adds an objective, we derive matchers from the query string:

```typescript
function deriveMatchers(query: string, mode: ObjectiveMatchMode): ObjectiveMatcher[] {
  const matchers: ObjectiveMatcher[] = [];

  switch (mode) {
    case 'title':
      // "FAQ" → match page titles containing FAQ, Frequently Asked, Help
      const keywords = expandKeywords(query); // synonym expansion
      for (const kw of keywords) {
        matchers.push({
          type: 'title-keyword',
          pattern: kw,
          weight: kw === query.toLowerCase() ? 1.0 : 0.6, // exact match > synonym
        });
      }
      // Also derive URL pattern from title (FAQ → /faq/, /help/, /frequently-asked)
      const urlSlugs = titleToUrlSlugs(query); // "FAQ" → ["faq", "faqs", "help"]
      for (const slug of urlSlugs) {
        matchers.push({
          type: 'url-regex',
          pattern: `/${slug}(/|$)`,
          weight: 0.5, // lower confidence than title match
        });
      }
      break;

    case 'url-path':
      // "/support/printers/" → prefix match + all children
      matchers.push({
        type: 'url-prefix',
        pattern: query.replace(/\/$/, ''),
        weight: 1.0,
      });
      break;

    case 'by-example':
      // User provides a URL → extract title keywords + URL structure
      const exampleUrl = new URL(query);
      const segments = exampleUrl.pathname.split('/').filter(Boolean);
      // Fixed segments become matchers, variable segments become wildcards
      for (const seg of segments) {
        if (!isLikelyVariable(seg)) {
          matchers.push({
            type: 'url-regex',
            pattern: `/${seg}/`,
            weight: 0.7,
          });
          matchers.push({
            type: 'breadcrumb-label',
            pattern: seg.replace(/-/g, ' '),
            weight: 0.5,
          });
        }
      }
      break;

    case 'content-tag':
      // Predefined tags: "Products", "Support", "Blog", "FAQ", "Downloads"
      const tagConfig = CONTENT_TAG_MATCHERS[query.toLowerCase()];
      if (tagConfig) {
        matchers.push(...tagConfig.matchers);
      }
      break;
  }

  return matchers;
}
```

**Keyword expansion** (no LLM — static synonym map):

```typescript
const KEYWORD_SYNONYMS: Record<string, string[]> = {
  faq: ['faq', 'faqs', 'frequently asked', 'help', 'questions'],
  products: ['products', 'product', 'shop', 'store', 'catalog', 'catalogue'],
  support: ['support', 'help', 'service', 'assistance', 'troubleshooting'],
  downloads: ['downloads', 'download', 'drivers', 'software', 'firmware'],
  blog: ['blog', 'news', 'articles', 'posts', 'updates'],
  docs: ['docs', 'documentation', 'guides', 'manual', 'manuals', 'tutorials'],
};

function expandKeywords(query: string): string[] {
  const lower = query.toLowerCase().trim();
  // Check if query matches any synonym group
  for (const [key, synonyms] of Object.entries(KEYWORD_SYNONYMS)) {
    if (synonyms.includes(lower)) return synonyms;
  }
  // No expansion — use as-is
  return [lower];
}
```

### 9.5 Algorithm: Evaluate Objective Satisfaction

Runs after every discovery iteration (progress event batch or discovery complete):

```typescript
function evaluateObjective(
  objective: DiscoveryObjective,
  discoveredUrls: DiscoveredUrl[],
  treeNodes: DiscoveryTreeNode[],
  navStructure: NavNode[] | null,
): ObjectiveEvaluation {
  // Step 1: Score every discovered URL against objective matchers
  const matches: ScoredMatch[] = [];
  for (const url of discoveredUrls) {
    const score = scoreUrlAgainstObjective(url, objective.matchers);
    if (score >= 0.4) {
      matches.push({ url: url.href, title: url.text, score });
    }
  }

  // Step 2: Estimate total potential matches from projections + nav
  let estimatedTotal = matches.length;
  const unexplored: UnexploredCandidate[] = [];

  // Check projected (unvisited) URLs in tree
  for (const node of flattenTree(treeNodes)) {
    if (node.state === 'discovered' && node.confidence === 'projected') {
      const score = scoreNodeAgainstObjective(node, objective.matchers);
      if (score >= 0.3) {
        estimatedTotal += node.linkCount ?? 1;
        unexplored.push({
          url: node.url,
          reason: `Projected node "${node.name}" matches "${objective.query}" (score: ${score.toFixed(1)})`,
          confidence: score,
        });
      }
    }
  }

  // Check nav structure for branches not yet explored
  if (navStructure) {
    for (const navNode of navStructure) {
      const inTree = treeNodes.some((t) => urlMatchesNavNode(t.url, navNode));
      if (!inTree) {
        const labelScore = matchLabel(navNode.label, objective.matchers);
        if (labelScore >= 0.3) {
          estimatedTotal += navNode.estimatedChildren ?? 10;
          unexplored.push({
            url: navNode.href,
            reason: `Navigation link "${navNode.label}" not yet explored`,
            confidence: labelScore,
          });
        }
      }
    }
  }

  // Step 3: Determine satisfaction
  const coverage = estimatedTotal > 0 ? matches.length / estimatedTotal : 0;
  const status: DiscoveryObjective['status'] =
    matches.length === 0 ? 'no-matches' : coverage >= 0.8 ? 'satisfied' : 'partial';

  return { matches, estimatedTotal, unexplored, status, coverage };
}

function scoreUrlAgainstObjective(url: DiscoveredUrl, matchers: ObjectiveMatcher[]): number {
  let maxScore = 0;
  for (const m of matchers) {
    let score = 0;
    switch (m.type) {
      case 'title-keyword':
        if (url.text?.toLowerCase().includes(m.pattern)) score = m.weight;
        break;
      case 'url-regex':
        if (new RegExp(m.pattern, 'i').test(url.href)) score = m.weight;
        break;
      case 'url-prefix':
        if (new URL(url.href).pathname.startsWith(m.pattern)) score = m.weight;
        break;
      case 'breadcrumb-label':
        // Check if any breadcrumb in the URL's chain matches
        if (url.breadcrumbs?.some((b) => b.text.toLowerCase().includes(m.pattern))) {
          score = m.weight;
        }
        break;
    }
    maxScore = Math.max(maxScore, score);
  }
  return maxScore;
}
```

### 9.6 Algorithm: Objective → Exploration Priority Queue

When objectives are active, the depth prober's next-page selection is influenced:

```typescript
// Inside depth-prober.ts — modified page selection
function selectNextTarget(
  candidates: ProbeTarget[],
  objectives: DiscoveryObjective[],
  visited: Set<string>,
): ProbeTarget | null {
  if (objectives.length === 0) {
    // Default behavior: breadth-first by depth, diverse sampling
    return candidates.filter((c) => !visited.has(c.url))[0] ?? null;
  }

  // Score each candidate by how well it serves active objectives
  const scored = candidates
    .filter((c) => !visited.has(c.url))
    .map((c) => {
      let objectiveScore = 0;
      for (const obj of objectives) {
        if (obj.status === 'satisfied') continue; // skip already-met objectives
        const match = scoreNodeAgainstObjective({ url: c.url, name: c.label }, obj.matchers);
        // Unsatisfied objectives get a boost
        const urgency = obj.status === 'no-matches' ? 1.5 : 1.0;
        objectiveScore = Math.max(objectiveScore, match * urgency);
      }
      return { target: c, objectiveScore };
    });

  // Sort: highest objective score first, then by depth (shallower first)
  scored.sort((a, b) => {
    if (Math.abs(a.objectiveScore - b.objectiveScore) > 0.1) {
      return b.objectiveScore - a.objectiveScore;
    }
    return a.target.depth - b.target.depth;
  });

  return scored[0]?.target ?? null;
}
```

### 9.7 Hub Page Handling — Content vs Navigation

When user says "explore this page" and it's a hub (has links but no content):

```typescript
interface HubExplorationResult {
  /** The hub page itself */
  hub: { url: string; title: string; role: 'hub' | 'leaf' | 'mixed' };
  /** Child pages discovered on this hub */
  children: ChildPageSummary[];
  /** Children grouped by inferred category */
  categories: CategoryGroup[];
}

interface ChildPageSummary {
  url: string;
  title: string;
  /** Inferred from title keywords + URL patterns */
  inferredCategory: string;
}

interface CategoryGroup {
  label: string;
  count: number;
  examples: ChildPageSummary[];
  /** Does this category match any active objective? */
  matchesObjective?: string;
}

// After visiting a hub, categorize its children by title similarity
function categorizeChildren(children: ChildPageSummary[]): CategoryGroup[] {
  // Step 1: Extract title keywords (remove stop words, domain-specific terms)
  const titleTokens = children.map((c) => ({
    child: c,
    tokens: tokenizeTitle(c.title),
  }));

  // Step 2: Group by shared leading keyword
  //   "Epson ET-2850 Printer" → "Printer"
  //   "Epson XP-5200 Printer" → "Printer"
  //   "How to clean print heads" → "How to" (FAQ-like)
  const groups = new Map<string, ChildPageSummary[]>();
  for (const { child, tokens } of titleTokens) {
    const category = inferCategory(tokens); // extract dominant keyword
    const existing = groups.get(category) ?? [];
    existing.push(child);
    groups.set(category, existing);
  }

  // Step 3: Convert to CategoryGroup[], sorted by count desc
  return Array.from(groups.entries())
    .map(([label, items]) => ({
      label,
      count: items.length,
      examples: items.slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count);
}

function inferCategory(tokens: string[]): string {
  // Use the last non-variable token as category
  // "Epson ET-2850 All-in-One Printer" → tokens: ["epson", "all-in-one", "printer"]
  // → category: "printer" (skip brand, skip model SKU)
  const meaningful = tokens.filter(
    (t) =>
      t.length > 2 &&
      !isLikelyVariable(t) && // skip SKUs, IDs (from shared url-heuristics.ts)
      !BRAND_WORDS.has(t), // skip "epson", "hp", etc.
  );
  return meaningful[meaningful.length - 1] ?? tokens[0] ?? 'Other';
}

// [M2 Resolution] Title tokenization is fragile for domain-specific content.
// Use a dual strategy: try URL-structure grouping first (via the existing
// UrlClusterer's trie algorithm which is proven), fall back to title-based
// only when URL patterns don't produce meaningful groups.
function categorizeChildrenRobust(children: ChildPageSummary[]): CategoryGroup[] {
  // Strategy 1: URL-structure grouping (use existing UrlClusterer)
  const clusterer = new UrlClusterer({ minGroupSize: 2, maxGroups: 10 });
  const clusterResult = clusterer.cluster(children.map((c) => c.url));

  if (clusterResult.groups.length >= 2) {
    // URL patterns produced meaningful groups — use them
    return clusterResult.groups
      .map((g) => ({
        label: deriveCategoryLabel(g.pattern, []),
        count: g.count,
        examples: g.examples.slice(0, 5).map((url) => {
          const child = children.find((c) => c.url === url);
          return child ?? { url, title: '', inferredCategory: '' };
        }),
      }))
      .sort((a, b) => b.count - a.count);
  }

  // Strategy 2: Fall back to title-based categorization
  return categorizeChildren(children);
}
```

**UI for hub exploration result**:

```
You explored "Support" — found 45 child pages:

  📁 Printers (18 pages)          [Include all] [Skip]
     "Epson ET-2850 Printer", "Epson XP-5200"...
     🎯 Matches objective "Products"

  📁 FAQ (12 pages)               [Include all] [Skip]
     "How to clean print heads", "Ink replacement"...
     🎯 Matches objective "FAQ pages"

  📁 Downloads (15 pages)         [Include all] [Skip]
     "ET-2850 Drivers", "XP-5200 Firmware"...

  [Include all categories]  [Only matching objectives]
```

---

## 10. Navigation-First Discovery

### 10.1 Problem

Deep discovery visits ~50 pages but can miss entire top-level sections. A site might have 12 categories but if the sample URL is under `/support/printers/`, discovery only sees that subtree.

### 10.2 Solution: Shallow Navigation Extraction

Before deep exploration, do a **1-2 page shallow pass** to extract the site's navigation structure. This costs almost nothing (1-2 page visits) but gives us the complete top-level skeleton.

### 10.3 Algorithm: Extract Site Navigation

```typescript
interface NavNode {
  /** Display text from the nav link */
  label: string;
  /** URL */
  href: string;
  /** Nesting depth in the nav menu */
  depth: number;
  /** Children (sub-menus) */
  children: NavNode[];
  /** Estimated child page count (from nav, not verified) */
  estimatedChildren?: number;
  /** Source: which nav region this came from */
  source: 'header-nav' | 'footer-nav' | 'sitemap-page' | 'mega-menu';
}

interface NavExtractionResult {
  /** Top-level nav structure */
  navigation: NavNode[];
  /** How many top-level categories found */
  categoryCount: number;
  /** Confidence in extraction */
  confidence: 'high' | 'medium' | 'low';
  /** What method worked */
  method: 'mega-menu' | 'header-links' | 'footer-links' | 'sitemap-page';
}

async function extractSiteNavigation(page: Page, baseUrl: string): Promise<NavExtractionResult> {
  // Step 1: Navigate to homepage
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);

  // Step 2: Try mega-menu extraction (best quality)
  const megaMenu = await extractMegaMenu(page);
  if (megaMenu.length >= 3) {
    return {
      navigation: megaMenu,
      categoryCount: megaMenu.length,
      confidence: 'high',
      method: 'mega-menu',
    };
  }

  // Step 3: Try header nav links
  const headerNav = await extractNavRegion(page, 'header nav, nav[role="navigation"], .main-nav');
  if (headerNav.length >= 3) {
    return {
      navigation: headerNav,
      categoryCount: headerNav.length,
      confidence: 'medium',
      method: 'header-links',
    };
  }

  // Step 4: Try footer nav (often has complete site structure)
  const footerNav = await extractNavRegion(page, 'footer nav, footer ul, .footer-links');
  if (footerNav.length >= 3) {
    return {
      navigation: footerNav,
      categoryCount: footerNav.length,
      confidence: 'medium',
      method: 'footer-links',
    };
  }

  // Step 5: Fallback — try /sitemap or /site-map page
  const sitemapPage = await trySitemapPage(page, baseUrl);
  if (sitemapPage.length >= 3) {
    return {
      navigation: sitemapPage,
      categoryCount: sitemapPage.length,
      confidence: 'medium',
      method: 'sitemap-page',
    };
  }

  return {
    navigation: [...headerNav, ...footerNav],
    categoryCount: headerNav.length + footerNav.length,
    confidence: 'low',
    method: 'header-links',
  };
}

async function extractMegaMenu(page: Page): Promise<NavNode[]> {
  // [H3 Resolution] Mega-menus are typically display:none until hover.
  // We MUST use Playwright hover events to reveal sub-menus before reading DOM.
  // Strategy: find top-level nav items, hover each via Playwright, wait for
  // sub-menu to become visible, THEN extract children.

  // Step 1: Find top-level nav items
  const topLevelSelectors = [
    'nav > ul > li > a',
    'header nav > ul > li > a',
    '[role="menubar"] > li > a',
    '.main-navigation > ul > li > a',
  ];
  const navItemHandles = await page.$$(topLevelSelectors.join(', '));
  const nodes: NavNode[] = [];

  for (const itemHandle of navItemHandles) {
    const href = await itemHandle.evaluate((el) => (el as HTMLAnchorElement).href);
    const label = await itemHandle.evaluate((el) => el.textContent?.trim() ?? '');
    if (!href || !label || label.length > 50) continue;

    // Step 2: Hover to reveal sub-menu
    const parentLi = await itemHandle.evaluateHandle((el) => el.closest('li'));
    if (parentLi) {
      await parentLi.asElement()?.hover();
      // Wait briefly for CSS transitions / JS to show dropdown
      await page.waitForTimeout(300);
    }

    // Step 3: Extract now-visible children
    const children = await page.evaluate((parentSelector) => {
      const li = document.querySelector(parentSelector);
      if (!li) return [];
      // Look for sub-menu that is now visible
      const subMenus = li.querySelectorAll('ul, [role="menu"], .dropdown-menu, .mega-menu');
      const childNodes: NavNode[] = [];
      for (const subMenu of subMenus) {
        // Check visibility — skip still-hidden menus
        const style = window.getComputedStyle(subMenu);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const subLinks = subMenu.querySelectorAll('a[href]');
        for (const sub of subLinks) {
          const subHref = (sub as HTMLAnchorElement).href;
          const subLabel = sub.textContent?.trim() ?? '';
          if (subHref && subLabel && subLabel.length <= 50) {
            childNodes.push({
              label: subLabel,
              href: subHref,
              depth: 1,
              children: [],
              source: 'mega-menu',
            });
          }
        }
      }
      return childNodes;
    }, `li:has(> a[href="${href}"])`);

    nodes.push({
      label,
      href,
      depth: 0,
      children: children ?? [],
      source: 'mega-menu',
      estimatedChildren: children?.length || undefined,
    });
  }

  return nodes;
}

async function extractNavRegion(page: Page, selector: string): Promise<NavNode[]> {
  // [L5 Resolution] Extract links from a specific nav region
  return page.evaluate((sel) => {
    const region = document.querySelector(sel);
    if (!region) return [];
    const links = region.querySelectorAll('a[href]');
    const nodes: NavNode[] = [];
    for (const link of links) {
      const href = (link as HTMLAnchorElement).href;
      const label = link.textContent?.trim() ?? '';
      if (href && label && label.length <= 50 && !href.startsWith('javascript:')) {
        nodes.push({ label, href, depth: 0, children: [], source: 'header-nav' });
      }
    }
    return nodes;
  }, selector);
}

async function trySitemapPage(page: Page, baseUrl: string): Promise<NavNode[]> {
  // [L5 Resolution] Try common HTML sitemap page paths
  const candidates = ['/sitemap', '/site-map', '/sitemap.html', '/pages'];
  for (const path of candidates) {
    try {
      const resp = await page.goto(new URL(path, baseUrl).href, {
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      });
      if (resp && resp.status() === 200) {
        return extractNavRegion(page, 'main, .content, article, body');
      }
    } catch {
      /* next candidate */
    }
  }
  return [];
}
```

### 10.4 How Nav Extraction Feeds Into Discovery

```
                 ┌──────────────────────┐
                 │ 1. Nav Extraction     │  ← 1-2 page visits
                 │    (homepage + hover) │
                 └──────────┬───────────┘
                            │
                   NavNode[] (skeleton)
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                  ▼
  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
  │ 2. Deep Probe │ │ Tree Skeleton │ │ Gap Detection │
  │ (user's seed) │ │ (show in UI)  │ │ (what's not   │
  │               │ │               │ │  explored)    │
  └───────────────┘ └───────────────┘ └───────────────┘
          │                                    │
          │           ┌────────────────────────┘
          ▼           ▼
  ┌─────────────────────┐
  │ 3. Coverage Summary  │
  │    X of Y categories │
  │    explored          │
  └─────────────────────┘
```

The tree starts with the **nav skeleton** (all nodes as `state: 'discovered'`, `source: 'nav-extracted'`), then deep probing fills in verified data. This means the user sees the FULL site structure from the start — not just what's been explored.

### 10.5 New SSE Event: `nav-extracted`

```typescript
// New event emitted at the start of depth probing, before Phase 1
interface NavExtractedEvent {
  type: 'nav-extracted';
  navigation: NavNode[];
  categoryCount: number;
  confidence: 'high' | 'medium' | 'low';
  method: string;
}
```

The frontend receives this event and pre-populates the tree with the full navigation skeleton.

---

## 11. Iterative Discovery Loop

### 11.1 Discovery is NOT One-Shot

The current model: user provides sample URLs → discovery runs once → done. This fails for large sites because a single run can't cover everything.

**New model**: Discovery is a **conversation** between user and system:

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│ 1. Auto-     │────▶│ 2. Review    │────▶│ 3. Set       │
│    Discover  │     │    Results   │     │    Objectives│
└─────────────┘     └──────────────┘     └──────┬───────┘
                           ▲                     │
                           │                     ▼
                    ┌──────┴───────┐     ┌──────────────┐
                    │ 5. Review    │◀────│ 4. Targeted  │
                    │    Again     │     │    Discovery │
                    └──────────────┘     └──────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │ 6. Configure │
                    │    Crawl     │
                    └──────────────┘
```

### 11.2 State Machine

```typescript
type DiscoveryLoopState =
  | 'nav-extracting' // Phase 0: extract site navigation
  | 'auto-discovering' // Phase 1: initial deep probe from seed
  | 'reviewing' // Phase 2: user reviews results + coverage
  | 'setting-objectives' // Phase 3: user adds/modifies objectives
  | 'targeted-discovering' // Phase 4: system explores specific branches
  | 'ready-for-crawl'; // Phase 5: user satisfied, configure scope

interface DiscoveryLoopContext {
  state: DiscoveryLoopState;
  /** Accumulated across all iterations */
  allDiscoveredUrls: DiscoveredUrl[];
  /** Tree grows across iterations */
  treeNodes: DiscoveryTreeNode[];
  /** Nav skeleton (from Phase 0) */
  navStructure: NavNode[] | null;
  /** Active objectives */
  objectives: DiscoveryObjective[];
  /** How many discovery iterations have run */
  iterationCount: number;
  /** Coverage analysis (recomputed after each iteration) */
  coverage: CoverageAnalysis;
}
```

### 11.3 Algorithm: Merge Results Across Iterations

**[H1 Resolution]** All URL comparison uses `normalizeDiscoveryUrl` — a single normalization function that strips fragments, trailing slashes, and tracking params, but preserves meaningful query params. This replaces the mismatch between the clusterer's pathname-only approach and pattern-matcher's query-preserving approach.

**[H2 Resolution]** No `structuredClone`. Tree mutations are incremental via `upsertNode` (defined in §4.2). The URL set uses a `Map<string, DiscoveredUrl>` instead of rebuilding arrays on each merge.

```typescript
// ─── Single normalization function for all discovery URL comparisons ───
function normalizeDiscoveryUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // Strip fragment
    url.hash = '';
    // Strip tracking params
    const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'ref'];
    for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
    // Sort remaining params for consistency
    url.searchParams.sort();
    // Strip trailing slash (but keep "/" for root)
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    url.pathname = path;
    return url.href;
  } catch {
    return raw;
  }
}

// ─── URL accumulator — O(1) dedup, no array rebuilding ───
class DiscoveredUrlSet {
  private map = new Map<string, DiscoveredUrl>();

  add(url: DiscoveredUrl): boolean {
    const key = normalizeDiscoveryUrl(url.href);
    if (this.map.has(key)) {
      // Upgrade confidence if new evidence is stronger
      const existing = this.map.get(key)!;
      if (url.confidence === 'verified' && existing.confidence !== 'verified') {
        existing.confidence = 'verified';
        if (url.pageTitle) existing.pageTitle = url.pageTitle;
        if (url.breadcrumbChain) existing.breadcrumbChain = url.breadcrumbChain;
      }
      return false; // not new
    }
    this.map.set(key, url);
    return true; // genuinely new
  }

  get size(): number {
    return this.map.size;
  }
  values(): IterableIterator<DiscoveredUrl> {
    return this.map.values();
  }
  toArray(): DiscoveredUrl[] {
    return Array.from(this.map.values());
  }
  has(href: string): boolean {
    return this.map.has(normalizeDiscoveryUrl(href));
  }
}

function mergeDiscoveryResults(
  urlSet: DiscoveredUrlSet,
  newResults: DiscoveredUrl[],
  tree: DiscoveryTreeNode[],
): { newCount: number } {
  let newCount = 0;

  for (const url of newResults) {
    const isNew = urlSet.add(url);
    if (isNew) {
      newCount++;
      // Incremental tree insertion — mutates in-place, no deep clone
      upsertNode(tree, url.href, {
        displayName: url.text || formatDisplayName(extractLastSegment(url.href)),
        pathSegment: extractLastSegment(url.href),
        source: 'sibling',
        state: 'discovered',
        confidence: url.confidence === 'verified' ? 'verified' : 'projected',
        title: url.pageTitle,
      });
    }
  }

  return { newCount };
}
```

### 11.3b Tree State Preservation Across Explore-Branch

**[H5 Resolution]** When user clicks "Explore branch" (which stops current run and restarts with new seed), the existing tree state MUST be preserved. The frontend holds tree state in React state — it is NOT reset when a new SSE stream starts.

```typescript
// In BrowserDiscoveryInline.tsx / DiscoveryPanel.tsx:
// Tree state lives in a useRef that persists across discovery runs.
// When a new run starts (explore-branch intervention):
//   1. Current tree is KEPT (not cleared)
//   2. New progress events UPDATE nodes in the existing tree
//   3. Nodes from previous runs keep their state (visited/discovered)
//   4. Only the target branch transitions to 'visiting'

// This is achieved by:
//   a) NOT resetting treeRef.current when startDiscovery is called
//   b) The upsertNode function only ADDS or UPDATES — never deletes
//   c) The 'complete' handler finalizes only nodes from the current run

interface DiscoveryRunMeta {
  runId: string;
  startedAt: number;
  seed: string;
  /** Nodes that were 'visiting' during this run (for finalization) */
  activeNodes: Set<string>;
}

// On new run start:
function onNewRunStart(tree: DiscoveryTreeNode[], seed: string): DiscoveryRunMeta {
  return {
    runId: crypto.randomUUID(),
    startedAt: Date.now(),
    seed,
    activeNodes: new Set(),
  };
}

// On run complete: only finalize THIS run's active nodes
function onRunComplete(tree: DiscoveryTreeNode[], run: DiscoveryRunMeta): void {
  walkTree(tree, (node) => {
    if (node.state === 'visiting' && run.activeNodes.has(node.url)) {
      node.state = 'visited';
    }
  });
}
```

### 11.4 When to Stop Iterating

```typescript
function shouldSuggestMoreDiscovery(context: DiscoveryLoopContext): {
  suggest: boolean;
  reason: string;
} {
  // All objectives satisfied?
  const unsatisfied = context.objectives.filter((o) => o.status !== 'satisfied');
  if (unsatisfied.length > 0) {
    return {
      suggest: true,
      reason: `${unsatisfied.length} objective(s) not yet satisfied: ${unsatisfied.map((o) => o.query).join(', ')}`,
    };
  }

  // Low coverage of nav structure?
  if (context.navStructure && context.coverage.navCoverageRatio < 0.5) {
    const unexplored = context.coverage.unexploredNavCategories;
    return {
      suggest: true,
      reason: `${unexplored.length} site sections not yet explored: ${unexplored
        .slice(0, 3)
        .map((n) => n.label)
        .join(', ')}...`,
    };
  }

  // Diminishing returns — signal-based, not a fixed threshold
  // [Obj-3 + L1 Resolution] Compare last iteration yield to first iteration yield
  if (context.iterationCount >= 2) {
    const lastYield = context.coverage.lastIterationNewUrls;
    const firstYield = context.coverage.firstIterationNewUrls ?? lastYield;
    // If last iteration found < 5% of what the first found, diminishing returns
    const yieldRatio = firstYield > 0 ? lastYield / firstYield : 0;
    if (yieldRatio < 0.05) {
      return {
        suggest: false,
        reason: `Last exploration found ${lastYield} new URLs (${Math.round(yieldRatio * 100)}% of initial) — diminishing returns.`,
      };
    }
  }

  return { suggest: false, reason: 'Coverage looks good.' };
}
```

---

## 12. Coverage Analysis & Gap Detection

### 12.1 Purpose

After each discovery iteration, compute a coverage analysis that tells the user:

- What was found (by category, with confidence)
- What might be missing (gaps)
- How to fill gaps (actionable suggestions)

### 12.2 Data Model

```typescript
interface CoverageAnalysis {
  /** Categories discovered, each with URL count and confidence */
  categories: DiscoveredCategory[];
  /** Categories from nav that haven't been explored */
  unexploredNavCategories: NavNode[];
  /** Overall coverage ratio: explored categories / total known categories */
  navCoverageRatio: number;
  /** Objective satisfaction summary */
  objectivesSummary: ObjectiveSummary[];
  /** URLs from last iteration that were genuinely new */
  lastIterationNewUrls: number;
  /** URLs from FIRST iteration (baseline for diminishing returns) */
  firstIterationNewUrls?: number;
  /** Totals */
  totalVerified: number;
  totalProjected: number;
  totalFromSitemap: number;
}

interface DiscoveredCategory {
  /** Human-readable label derived from URL patterns + titles */
  label: string;
  /** URL pattern(s) in this category */
  patterns: string[];
  /** Total URLs (verified + projected) */
  urlCount: number;
  /** How many were actually visited vs projected */
  verifiedCount: number;
  projectedCount: number;
  /** Confidence in coverage completeness */
  confidence: 'high' | 'medium' | 'low';
  /** Why this confidence level */
  confidenceReason: string;
  /** Sample URLs for display */
  examples: Array<{ url: string; title: string }>;
  /** Which objectives this category satisfies */
  matchesObjectives: string[];
}
```

### 12.3 Algorithm: Build Coverage Analysis

```typescript
function buildCoverageAnalysis(
  discoveredUrls: DiscoveredUrl[],
  clusteredGroups: UrlGroup[],
  navStructure: NavNode[] | null,
  objectives: DiscoveryObjective[],
  treeNodes: DiscoveryTreeNode[],
  sitemapUrls: string[],
): CoverageAnalysis {
  // Step 1: Convert UrlGroups into DiscoveredCategories
  const categories: DiscoveredCategory[] = clusteredGroups.map((group) => {
    const verified = group.examples.filter((u) =>
      discoveredUrls.some(
        (d) =>
          normalizeDiscoveryUrl(d.href) === normalizeDiscoveryUrl(u) && d.confidence === 'verified',
      ),
    ).length;
    const projected = group.count - verified;

    // Derive human label from pattern + sample titles
    const label = deriveCategoryLabel(group.pattern, discoveredUrls);

    // Assess confidence
    const confidence = assessCategoryConfidence(verified, projected, group.count);

    // Check objective matches
    const matchesObjectives = objectives
      .filter((obj) => obj.matchedUrls.some((u) => group.examples.includes(u)))
      .map((obj) => obj.query);

    return {
      label,
      patterns: [group.pattern],
      urlCount: group.count,
      verifiedCount: verified,
      projectedCount: projected,
      confidence: confidence.level,
      confidenceReason: confidence.reason,
      examples: group.examples.slice(0, 5).map((u) => ({
        url: u,
        title:
          discoveredUrls.find((d) => normalizeDiscoveryUrl(d.href) === normalizeDiscoveryUrl(u))
            ?.text ?? '',
      })),
      matchesObjectives,
    };
  });

  // Step 2: Cross-reference with nav structure to find gaps
  let unexploredNav: NavNode[] = [];
  let navCoverageRatio = 1.0;

  if (navStructure && navStructure.length > 0) {
    const exploredPrefixes = new Set(
      treeNodes
        .filter((n) => n.state === 'visited')
        .map((n) => new URL(n.url).pathname.split('/').slice(0, 3).join('/')),
    );

    unexploredNav = navStructure.filter((nav) => {
      const navPrefix = new URL(nav.href).pathname.split('/').slice(0, 3).join('/');
      return !exploredPrefixes.has(navPrefix);
    });

    navCoverageRatio = 1 - unexploredNav.length / navStructure.length;
  }

  // Step 3: Objective summary
  const objectivesSummary = objectives.map((obj) => ({
    query: obj.query,
    status: obj.status,
    matchCount: obj.matchedUrls.length,
    estimatedTotal: obj.estimatedTotal,
    coverage: obj.estimatedTotal > 0 ? obj.matchedUrls.length / obj.estimatedTotal : 0,
    suggestions: obj.unexploredCandidates.slice(0, 3),
  }));

  return {
    categories,
    unexploredNavCategories: unexploredNav,
    navCoverageRatio,
    objectivesSummary,
    lastIterationNewUrls: 0, // set by caller
    totalVerified: discoveredUrls.filter((u) => u.confidence === 'verified').length,
    totalProjected: discoveredUrls.filter((u) => u.confidence === 'projected').length,
    totalFromSitemap: sitemapUrls.length,
  };
}

function deriveCategoryLabel(pattern: string, urls: DiscoveredUrl[]): string {
  // "/support/{slug}" → "Support"
  // "/products/printers/{slug}" → "Printers"
  const segments = pattern.split('/').filter(Boolean);
  // Use the last fixed (non-slug) segment as the label
  const fixedSegments = segments.filter((s) => !s.includes('{'));
  const lastFixed = fixedSegments[fixedSegments.length - 1] ?? segments[0];
  // Title-case it
  return lastFixed.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// [M3 Resolution] Show raw numbers instead of arbitrary threshold buckets.
// Confidence is a continuous value — UI renders the bar proportionally.
function assessCategoryConfidence(
  verified: number,
  projected: number,
  total: number,
): { level: 'high' | 'medium' | 'low'; score: number; reason: string } {
  // Score is 0-1 based on multiple signals:
  // - verifiedRatio: how many of the total URLs were actually visited
  // - sampleDiversity: did we see enough unique patterns to trust projection
  // - absoluteVerified: at least 2-3 verified pages needed for any projection
  const verifiedRatio = verified / Math.max(total, 1);
  const absoluteScore = Math.min(verified / 3, 1.0); // 3+ verified = full marks
  const ratioScore = Math.min(verifiedRatio / 0.3, 1.0); // 30%+ verified = full marks
  const score = absoluteScore * 0.6 + ratioScore * 0.4; // weighted blend

  const level = score >= 0.7 ? 'high' : score >= 0.3 ? 'medium' : 'low';
  const reason = `${verified} verified, ${projected} projected (${Math.round(verifiedRatio * 100)}% sample rate)`;

  return { level, score, reason };
}
```

### 12.4 UI: Coverage Summary Panel

```
┌─────────────────────────────────────────────────────────┐
│ Discovery Summary                                        │
│                                                          │
│ Verified: 553 URLs from 8 pages visited                  │
│ Projected: 2,847 URLs from pattern analysis              │
│ Sitemap: 6 URLs (low coverage — JS-heavy site)           │
│                                                          │
│ ── Categories Found ───────────────────────────────────── │
│                                                          │
│ ✅ Printers        1,200 URLs   ●●●● High               │
│    /support/printers/{slug}                               │
│    "ET-2850 Printer", "XP-5200 Printer"...               │
│    🎯 Matches: "Products"                                │
│                                                          │
│ ✅ Support Articles  800 URLs   ●●●○ Medium              │
│    /support/{category}/article-{id}                       │
│    "How to clean print heads"...                          │
│                                                          │
│ ⚠️ FAQ Pages          12 URLs   ●●○○ Low                 │
│    Only found under /support/printers/                    │
│    🎯 Matches: "FAQ" — 12/~50 est.  [Explore more]      │
│                                                          │
│ ── Not Yet Explored ──────────────────────────────────── │
│                                                          │
│ ❓ Downloads (from site navigation)      [Explore]       │
│ ❓ Scanners (from site navigation)       [Explore]       │
│ ❓ Projectors (from site navigation)     [Explore]       │
│                                                          │
│ ── Objectives ────────────────────────────────────────── │
│                                                          │
│ 🎯 "FAQ pages"    12/~50 URLs   ⚠️ Incomplete           │
│    Suggestion: Explore FAQ under Scanners, Projectors    │
│    [Auto-explore all FAQ branches]                        │
│                                                          │
│ 🎯 "Products"     1,200 URLs    ✅ Satisfied             │
│                                                          │
│ [Proceed to crawl scope]  [+ Add objective]              │
└─────────────────────────────────────────────────────────┘
```

---

## 13. Large-Volume Discovery Strategy

### 13.1 The Multiplier Effect

Discovery doesn't visit every page — it samples and projects:

```
                    Pages       Multiplier
                    ─────       ──────────
Visit (verified):     50        × 1
Project (patterns):  5,000      × 100
Sitemap (existing):  6          × 0.12
                    ─────
Total scope:         5,056      from only 50 page visits
```

For a site with 50,000 pages, visiting 50 and projecting 5,000 gives 10% coverage — the URL patterns are enough for the crawl phase to fetch all pages matching those patterns.

### 13.2 When Projection Isn't Enough

Projection fails when:

1. **Sections have no structural pattern** — e.g., flat `/page-123` IDs with no hierarchy
2. **JS-only navigation** — links not in DOM until after interaction
3. **Different URL structures per section** — `/products/category/item` vs `/kb/article-title`

### 13.3 Multiple Web Sources Strategy

For large sites, user can configure **multiple web sources** targeting different sections:

```typescript
interface MultiSourceConfig {
  sources: WebSource[];
  /** How to merge results across sources */
  mergeStrategy: 'union' | 'intersection';
}

interface WebSource {
  /** User-given name for this source */
  label: string;
  /** Seed URL for discovery */
  seedUrl: string;
  /** Optional objective (what to find starting here) */
  objective?: string;
  /** Discovery status */
  status: 'pending' | 'running' | 'complete';
  /** Discovered URLs from this source */
  discoveredUrls: DiscoveredUrl[];
}
```

**UI concept**: In Step 1, instead of a single URL input:

```
Web Sources for epson.com

  📍 Support Pages                    [Running... 553 URLs]
     Seed: https://epson.com/support/printers/et-series
     Objective: Product support content

  📍 Knowledge Base                   [Pending]
     Seed: https://epson.com/support/knowledge-base
     Objective: FAQ and troubleshooting

  [+ Add another source]
```

Each source runs its own discovery → results merge → deduplicate → unified coverage analysis.

### 13.4 Title-as-Category Matching

Users know page titles, not URL patterns. When user says "I want all FAQ pages", the post-discovery matcher should search by title, not just URL:

```typescript
function matchByTitle(
  allUrls: DiscoveredUrl[],
  titleQuery: string,
): { matches: DiscoveredUrl[]; patterns: string[] } {
  const keywords = expandKeywords(titleQuery);
  const matches: DiscoveredUrl[] = [];

  for (const url of allUrls) {
    const title = url.text?.toLowerCase() ?? '';
    const href = url.href.toLowerCase();

    const titleMatch = keywords.some((kw) => title.includes(kw));
    const urlMatch = keywords.some((kw) => href.includes(kw));

    if (titleMatch || urlMatch) {
      matches.push(url);
    }
  }

  // Extract URL patterns from matches (so crawl can find MORE)
  const matchUrls = matches.map((m) => m.href);
  const patterns = learnPatterns(matchUrls);

  return {
    matches,
    // [H4 Resolution] Actual field name is `isVariable`, not `variable`
    // See pattern-matcher.ts TemplateSegment type (line 20-27)
    patterns: patterns.map(
      (p) =>
        p.pathPrefix + '/' + p.segments.map((s) => (s.isVariable ? '{slug}' : s.value)).join('/'),
    ),
  };
}
```

This is powerful: from 12 matched FAQ URLs, `learnPatterns` extracts the URL template, and the crawl phase uses that template to fetch ALL FAQ pages — even ones not discovered.

### 13.5 Discovery → Crawl Handoff

The gap between discovery and crawling is where the **projection multiplier** operates:

```
Discovery found:
  Pattern: /support/printers/{brand}/{model}
  Verified: 8 URLs (visited)
  Projected: 200 URLs (from template × known brands × estimated models)

Crawl scope:
  Match rule: /support/printers/**
  Estimated pages: ~200
  Strategy: Start crawl, follow links matching pattern
  Stop when: No new pages found for 50 consecutive fetches

Result: Crawl finds 187 actual pages (projection was 93% accurate)
```

The key insight: **crawl doesn't need every URL upfront**. It needs **patterns** and a **scope boundary**. The crawler follows links within scope, discovering pages that weren't individually projected.

---

## 14. Updated Implementation Order

Revised to incorporate all review resolutions and new sections.

### Sprint 1: Backend Foundation (~3 days)

**Goal**: Enriched progress events + nav extraction — the data layer everything else needs.

1. **Enrich `DepthProbeProgress`** — add `currentUrl`, `discoveredOnPage[]`, `siblings[]`, `currentRole`, `nextTargets[]` to depth-prober.ts (§3, §16.1) — C2 resolution
2. **Extract `isLikelyVariable`** to `packages/crawler/src/intelligence/utils/url-heuristics.ts` (§8.2) — C3 resolution
3. **Define `DiscoveredUrl`** type + mappers in `packages/crawler/src/types/discovered-url.ts` (§8.1) — C1 resolution
4. **Define `normalizeDiscoveryUrl`** in shared package (§11.3) — H1 resolution
5. **`extractSiteNavigation()`** in depth-prober.ts with Playwright hover (§10.3, H3 resolution)
6. **`nav-extracted` SSE event** — emit nav skeleton before deep probing (§10.5)
7. **Signal-based `YieldTracker`** — replace static caps in depth-prober.ts (§5) — Obj-3 resolution

### Sprint 2: Frontend Tree + Console (~3 days)

**Goal**: Real-time discovery visualization with enriched events.

8. **DiscoveryTree.tsx** — tree built from enriched progress events via `upsertNode` (§4.2, C2 resolution). Use `displayName` + `pathSegment` split (M5 resolution). **Auto-collapse** at 30 visible nodes + breadcrumb trail (D1)
9. **DiscoveryConsole.tsx** — scrollable log with timestamped entries, system decisions, action chips (§4.3, D2). Replaces DiscoveryActivity.
10. **DiscoveryPanel.tsx** — wraps Console + Tree + CoverageSummary (§4.1)
11. **Wire into BrowserDiscoveryInline** — pass enriched progress, tree state in `useRef` (H5 resolution)
12. **`DiscoveredUrlSet`** — Map-based accumulator replacing array + structuredClone (§11.3, H2 resolution)
13. **Sample URL input prominence** — font sizes, contrast, container (§17.3)
    14b. **Action-specific verbs** — `getNodeActions()` per node state: Visit & discover, Add to scope, Go deeper, Verify, Skip (§4.2, D4)

### Sprint 3: Coverage Analysis + Caching (~2 days)

**Goal**: Post-discovery transparency — categories, gaps, confidence.

14. **`buildCoverageAnalysis()`** — with `normalizeDiscoveryUrl` consistency (§12.3, H1 resolution)
15. **`assessCategoryConfidence()`** — continuous score + raw numbers (§12.3, M3 resolution)
16. **Coverage Summary UI** — categories, gaps, objectives, iteration history (§12.4, §16.2)
17. **Discovery state caching** — save/restore via crawl draft system (§17.1)

### Sprint 4: Decision Cards + Iterative Loop (~3 days)

**Goal**: Context-aware user guidance replacing free-text objectives.

18. **Decision Card system** — `DecisionCard`, `DecisionAction`, `generateDecisionCards()` (§9.3, §9.3b, D3)
19. **Browse Titles dropdown** — `buildBrowseItems()`, searchable filtered list (§9.3c, D3)
20. **Objective data model** — `DiscoveryObjective`, `ObjectiveMatcher`, `CONTENT_TAG_MATCHERS` (§9.3, §8.5) — created from card actions, not free text
21. **`deriveMatchers()`** — with `isLikelyVariable` from shared package (§9.4)
22. **`evaluateObjective()`** — with `DiscoveredUrl.breadcrumbChain` support (§9.5)
23. **`fuzzyMatchTitle()`** — abbreviation expansion + word overlap (§18.1)
24. **`selectNextTarget()`** — objective-aware page selection in depth-prober (§9.6)
25. **Auto-add sections** — criteria check, [NEW] badge, console notification, dismiss action (§6, D5)
26. **Iterative discovery loop** — state machine, signal-based stop suggestion (§11.2, §11.4)

### Sprint 5: Interventions + Hub Categorization (~3 days)

**Goal**: Per-node and strategic control during discovery.

27. **Background mode** — collapse to banner with state preservation
28. **Tree interactions** — state-specific verb actions (§4.2, D4), Undo-skip (§8.4)
29. **Tree state preservation** — `DiscoveryRunMeta` for cross-run tree continuity (§11.3b, H5 resolution)
30. **Hub categorization** — `categorizeChildrenRobust()` — URL clusterer first, title fallback (§9.7, M2 resolution)
31. **POST-alongside-SSE** — intervention endpoint + command queue in depth-prober (§6 Phase 2)

### Sprint 6: Crawl-as-you-Discover + Multi-Source (~3 days)

**Goal**: Parallel crawl pipeline + large-volume support.

32. **Crawl-as-you-discover** — `CrawlAsYouDiscoverConfig`, three modes, `maybeQueueForCrawl()`, batch submission (§21, D6)
33. **Mode selection UX** — Decision Card for crawl mode at discovery start (§21.6)
34. **Parallel progress display** — dual discovery + crawl progress bars (§21.5)
35. **Sequential multi-source** — shared `DiscoveredUrlSet` + tree across runs (§19, M4 resolution)

### Sprint 7: Flow Polish (~2 days)

**Goal**: End-to-end flow completion.

36. **Title-as-category matching** — `matchByTitle()` with `s.isVariable` fix (§13.4, H4 resolution)
37. **Adaptive sampleSize** — signal-based, not tiered (§5)
38. **State4Crawl.tsx** — crawl progress in-panel
39. **Flow wiring** — crawling/done states, non-destructive back

---

## 15. Open Questions for Review

1. ~~**Tree depth**: Show FULL URL hierarchy or just 2-3 levels?~~ **RESOLVED §4.2**: Auto-collapse when total visible nodes > 30. Breadcrumb trail for deep navigation. User can manually expand/collapse.

2. ~~**Background mode**: Auto-add sections or stage until user reviews?~~ **RESOLVED §6**: Auto-add with visual distinction ([NEW] badge, dismissible). Console shows why each section was added.

3. **Nav extraction timing**: Should nav extraction run as a SEPARATE phase (visible to user) or silently before deep probing? **Recommendation**: Visible in console ("Extracting site navigation...") but not a blocking step in the UI.

4. ~~**Objective UX**: Free-text input vs structured form?~~ **RESOLVED §9**: Dynamic Decision Cards — no free text. System generates action cards from discovered content. "Browse titles" dropdown as fallback.

5. **Multi-source MVP**: Should multiple web sources be in Sprint 1 (simple — multiple seed URLs in existing input) or a later sprint (full source management UI)?

6. ~~**Objective persistence**: Session-only or saved?~~ **RESOLVED §17.1**: Saved to crawl draft (discovery state caching). Objectives persist across sessions.

7. **Coverage threshold**: At what coverage ratio should we suggest "proceed to crawl" vs "explore more"? Proposal: 60% nav coverage + all objectives satisfied.

8. ~~**Crawl timing**: Sequential (discover then crawl) or parallel?~~ **RESOLVED §21**: Three modes — review-first (default), crawl-all, crawl-matched. User selects at discovery start.

---

## 16. Transparency Enhancements

### 16.1 "Next Actions" Queue Display

**[Obj-1 gap]** The Activity zone shows what's happening NOW but not what's PLANNED. Add a "coming up" indicator:

```tsx
// In DiscoveryActivity.tsx — below the current action message
interface NextActionsProps {
  /** Upcoming pages in the exploration queue (from enriched progress) */
  nextTargets: Array<{ url: string; reason: string }>;
  /** Max to show */
  maxVisible?: number; // default 3
}

// Rendered as:
// "Visiting /Support/Printers/ET-Series..."
// Next: /Support/Scanners (breadcrumb hub), /Support/Projectors (breadcrumb hub)
```

**Backend change**: Add `nextTargets?: Array<{ url: string; reason: string }>` to `DepthProbeProgress`. The depth prober already knows its exploration queue — expose the top 3 entries.

### 16.2 Iteration History

**[Obj-8 gap]** Show progress across discovery iterations so user knows if additional rounds are productive:

```
── Discovery History ───────────────────────────────
  Run 1: Seed /support/printers/et-series → 553 URLs, 8 pages visited
  Run 2: Explore /support/scanners         → 200 new URLs, 5 pages visited
  Run 3: Objective "FAQ pages"             → 38 new URLs, 3 pages visited
  ─────────────────────────────────────────────────
  Total: 791 unique URLs from 16 pages across 3 runs
```

```typescript
interface DiscoveryIteration {
  runId: string;
  seed: string;
  trigger: 'auto' | 'explore-branch' | 'objective' | 'manual';
  newUrlCount: number;
  pagesVisited: number;
  duration: number;
  timestamp: number;
}

// Stored in DiscoveryLoopContext
interface DiscoveryLoopContext {
  // ... existing fields ...
  /** History of all discovery iterations */
  iterations: DiscoveryIteration[];
}
```

---

## 17. Missing Feedback Items

These items were in `feedback_crawler_ux.md` but not addressed in the original design.

### 17.1 Discovery Result Caching

**[Feedback item 3]** Discovery results should persist across browser sessions. Currently, if the user navigates away and comes back, all discovery data is lost.

**Solution**: Save discovery state to the existing crawl draft system.

```typescript
// Extend the existing CrawlDraft with discovery state
interface CrawlDraftDiscoveryState {
  /** Serialized tree */
  treeNodes: DiscoveryTreeNode[];
  /** All discovered URLs (from DiscoveredUrlSet) */
  discoveredUrls: DiscoveredUrl[];
  /** Active objectives */
  objectives: DiscoveryObjective[];
  /** Nav structure */
  navStructure: NavNode[] | null;
  /** Iteration history */
  iterations: DiscoveryIteration[];
  /** Coverage analysis snapshot */
  coverage: CoverageAnalysis | null;
  /** Timestamp of last update */
  savedAt: number;
}

// Save after each discovery run completes:
// updateCrawlDraft(draftId, { discoveryState: serializeDiscoveryState(context) })

// Restore on page load:
// const draft = await getCrawlDraft(draftId);
// if (draft.discoveryState) restoreDiscoveryState(draft.discoveryState);
```

**Persistence points**:

- After each discovery run completes (auto-save)
- When user clicks "Run in background" (save before collapsing)
- When user navigates away (beforeunload save)
- After each objective is added/removed

### 17.1b Resume Discovery Flow (UJ-18)

**[UJ-18]** "Resume later without re-doing discovery." §17.1 defines WHAT to persist. This section defines the resume FLOW.

#### When to resume

The user returns to a crawl draft that has saved discovery state. Two entry points:

1. **Same session** — user navigated away (e.g., to Data section) and came back. Discovery state is in React state + saved to draft as a safety net.
2. **New session** — user closed the browser, returns hours/days later. Discovery state is loaded from the crawl draft.

#### Resume flow

```
┌─────────────────────────────────────────────────────┐
│ User opens crawl draft with saved discoveryState    │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ Resume Discovery Banner                     │    │
│  │                                             │    │
│  │ "You left off with 142 discovered pages     │    │
│  │  across 4 sections. 2 sections included."   │    │
│  │                                             │    │
│  │ [Continue Discovery]  [Start Fresh]         │    │
│  │ [Proceed to Crawl →]                        │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Three resume actions:**

| Action                 | What happens                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Continue Discovery** | Restore tree, sections, objectives, coverage from draft. Open Discovery Panel in the state it was left. User can steer further, add samples, include/exclude sections. New depth probing starts from where it left off (unexplored branches are still available). |
| **Start Fresh**        | Clear saved discoveryState from draft. Reset to Step 1 (url-entry) or Step 2 (analyzing) depending on whether profile data is still valid.                                                                                                                        |
| **Proceed to Crawl**   | Skip further discovery. Use the saved sections/scope as-is. Go directly to Step 3 (configure) → Step 4 (crawl).                                                                                                                                                   |

#### What "Continue Discovery" restores

From `CrawlDraftDiscoveryState` (§17.1):

| Restored          | Source                | User sees                                        |
| ----------------- | --------------------- | ------------------------------------------------ |
| Tree structure    | `treeNodes[]`         | Full tree with visited/discovered/skipped states |
| Discovered URLs   | `discoveredUrls[]`    | Pattern scores, sections, page counts            |
| Objectives        | `objectives[]`        | Active objectives with match status              |
| Nav structure     | `navStructure`        | Site navigation overlay on tree                  |
| Iteration history | `iterations[]`        | Console shows past iteration summaries           |
| Coverage snapshot | `coverage`            | Coverage summary bar is populated                |
| Scope selections  | `sections[].included` | Include/exclude toggles restored                 |

**What is NOT restored** — backend discovery state (depth prober position, command queue). The backend always starts fresh. But because the tree and discovered URLs are restored, the system knows which branches were already explored and won't revisit them.

#### Backend behavior on resume

```typescript
// When continuing discovery after resume:
// 1. Restored discoveredUrls are pre-loaded into the DiscoveredUrlSet
// 2. Depth prober receives the pre-visited URLs as "already-visited" set
// 3. Hub fan-out skips branches that are already fully explored
// 4. New discovery only explores unexplored branches

interface ResumeDiscoveryRequest {
  draftId: string;
  /** URLs already visited — depth prober skips these */
  visitedUrls: string[];
  /** Branches already explored — fan-out skips these */
  exploredBranches: string[];
  /** Current sample URLs (may have been edited) */
  sampleUrls: string[];
}
```

#### Re-crawl / incremental discovery (future)

When a user has already completed a crawl and wants to refresh or expand:

1. Load the previous crawl's discovery state from the source record
2. Show: "Last crawled 2 weeks ago. 142 pages across 4 sections."
3. Options: [Refresh existing] [Expand to new sections] [Full re-discovery]
4. **Refresh**: Re-crawl the same scope, detect changed/new/removed pages
5. **Expand**: Resume discovery from the previous tree, steer to new branches

This is a competitive differentiator — no enterprise crawler handles incremental discovery well. Deferred to Phase 4+.

### 17.2 Clickable Sample URL Chips

**[Feedback item 1]** During discovery, sample URLs should be clickable chips that open in a new tab. Already partially implemented in `SampleUrlInput.tsx` read-only mode — the chips render as `<a>` tags with `target="_blank"`. Verify this works end-to-end.

### 17.3 Sample URL Input Prominence

**[Feedback item 4]** The sample URL input needs better visibility:

- Show 1 input by default (already done)
- Bump font sizes: heading 18px, description 14px, input 16px
- Rewrite i18n copy to be more action-oriented
- Add visual emphasis (border, background highlight)

**Implementation**: CSS-only changes in `SampleUrlInput.tsx`:

```tsx
// Heading: text-sm → text-base font-semibold (18px equivalent with design tokens)
// Description: text-sm → text-sm (14px, stays same but better contrast)
// Input: text-sm → text-base font-mono (16px)
// Container: add bg-background-elevated rounded-lg p-4 border border-default
```

---

## 18. Fuzzy Matching for Title Search

**[Obj-7 gap]** The current `title.includes(keyword)` is exact substring matching. "frequently asked questions" matches "FAQ" only if the synonym map catches it.

### 18.1 Lightweight Fuzzy Strategy (no external libraries)

```typescript
function fuzzyMatchTitle(title: string, query: string): number {
  const titleLower = title.toLowerCase();
  const queryLower = query.toLowerCase();

  // Level 1: Exact substring (highest confidence)
  if (titleLower.includes(queryLower)) return 1.0;

  // Level 2: Synonym expansion (from KEYWORD_SYNONYMS)
  const synonyms = expandKeywords(queryLower);
  for (const syn of synonyms) {
    if (titleLower.includes(syn)) return 0.9;
  }

  // Level 3: Abbreviation expansion
  // "FAQ" → check if title contains words starting with F, A, Q
  if (queryLower.length <= 5 && queryLower === queryLower.toUpperCase()) {
    const titleWords = titleLower.split(/\s+/);
    const queryChars = queryLower.split('');
    let matchIdx = 0;
    for (const word of titleWords) {
      if (matchIdx < queryChars.length && word.startsWith(queryChars[matchIdx])) {
        matchIdx++;
      }
    }
    if (matchIdx === queryChars.length) return 0.8;
  }

  // Level 4: Word overlap (Jaccard-like)
  const queryWords = new Set(queryLower.split(/\s+/).filter(w => w.length > 2));
  const titleWords = new Set(titleLower.split(/\s+/).filter(w => w.length > 2));
  if (queryWords.size > 0) {
    let overlap = 0;
    for (const qw of queryWords) {
      for (const tw of titleWords) {
        if (tw.includes(qw) || qw.includes(tw)) { overlap++; break; }
      }
    }
    const score = overlap / queryWords.size;
    if (score >= 0.5) return 0.6 * score;
  }

  return 0; // no match
}

// Replace exact match in scoreUrlAgainstObjective:
case 'title-keyword':
  const fuzzyScore = fuzzyMatchTitle(url.text ?? '', m.pattern);
  if (fuzzyScore > 0) score = m.weight * fuzzyScore;
  break;
```

### 18.2 Projected URL Label Quality

**[Obj-7 gap]** Projected URLs have no page titles — they were never visited. Labels fall back to URL path segments like "et-series" instead of "ET Series Printers."

**Mitigation strategy**:

1. For projected URLs under a visited hub, inherit the hub's category label: "ET Series" (from hub) + pattern depth label
2. If the hub visit extracted page titles from child links (the `<a>` text), use those as projected URL labels — this data is already in `DiscoveredUrl.text` from the `discoveredOnPage` progress field
3. Mark projected-URL labels with "(projected)" suffix in the UI so user knows it's an estimate

---

## 19. Multi-Source Architecture (M4 Resolution)

**[M4 Resolution]** Multiple web sources need to work with the single-SSE architecture.

### 19.1 Sequential Discovery with Shared State

Sources run **sequentially, not in parallel**. Each source:

1. Gets its own SSE stream (new `exploreId`)
2. Shares the same `DiscoveredUrlSet` and `DiscoveryTreeNode[]` tree
3. Results merge into the shared state via `mergeDiscoveryResults`
4. Coverage analysis runs after each source completes

```typescript
// In DiscoveryPanel state:
interface MultiSourceState {
  sources: WebSource[];
  currentSourceIndex: number;
  sharedUrlSet: DiscoveredUrlSet;
  sharedTree: DiscoveryTreeNode[];
}

// Flow:
// 1. User adds sources with seed URLs
// 2. System runs source[0] → merges results → updates coverage
// 3. System runs source[1] → merges results → updates coverage
// 4. After all sources: show unified coverage summary
// 5. User can add more sources based on gaps
```

### 19.2 Why Not Parallel

Parallel SSE streams would require:

- Multiple Playwright browser contexts (memory-heavy)
- Concurrent write to shared tree state (race conditions)
- Multiple progress displays competing for attention

Sequential is simpler, avoids resource conflicts, and the user can see results after each source before deciding whether to add more.

---

## 21. Crawl-as-you-Discover

### 21.1 Motivation

Currently, discovery and crawling are strictly sequential: discover all URLs → configure scope → crawl. For large sites, this means the user waits for discovery to finish before ANY crawling begins. The crawl-as-you-discover model lets the two pipelines run in parallel.

### 21.2 Three Modes

```typescript
interface CrawlAsYouDiscoverConfig {
  /** Whether to crawl during discovery */
  mode: 'disabled' | 'crawl-all' | 'crawl-matched' | 'review-first';
  /** For 'crawl-matched': which patterns/objectives to auto-crawl */
  matchCriteria?: {
    /** Auto-crawl URLs matching active objectives */
    objectives?: string[]; // objective IDs from DiscoveryObjective
    /** Auto-crawl URLs matching these content tags */
    contentTags?: string[];
    /** Auto-crawl URLs matching these URL prefixes */
    urlPrefixes?: string[];
    /** Auto-crawl URLs matching these URL patterns */
    patterns?: string[];
    /** Minimum confidence to auto-crawl */
    minConfidence: 'verified' | 'projected';
    /** Minimum score tier (from link scoring) */
    minScoreTier?: 'hot' | 'warm';
  };
  /** Crawl settings applied to auto-started pages */
  crawlDefaults: {
    /** HTTP-only, browser-based, or auto-detect per page */
    strategy: 'http' | 'browser' | 'auto';
    /** Max concurrent crawl workers */
    concurrency: number; // default 3
  };
}
```

| Mode                       | Behavior                                                                          | Best For                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Crawl All**              | Every discovered URL is queued for crawling immediately                           | Small sites where user wants maximum speed                                                 |
| **Crawl Matched**          | Only URLs matching user's criteria are auto-crawled                               | Large sites where user knows what they want (e.g., "crawl all FAQ pages as you find them") |
| **Review First** (default) | Discovery completes fully, then user reviews and configures scope before crawling | First-time use, unfamiliar sites                                                           |

### 21.3 Parallel Pipeline Architecture

```
Discovery SSE Stream                    Crawl Pipeline
─────────────────────                   ──────────────
progress event
  │
  ├─→ Update tree + console
  │
  ├─→ Check auto-crawl criteria ────→ YES → Queue URL for crawl
  │   (if mode != 'review-first')        │
  │                                      ▼
  │                              ┌───────────────┐
  │                              │ Crawl Queue    │
  │                              │ (batched)      │
  │                              └───────┬───────┘
  │                                      │
  │                                      ▼
  │                              ┌───────────────┐
  │                              │ Batch Crawl    │
  │                              │ (existing      │
  │                              │  submitBatch)  │
  │                              └───────────────┘
  │
  ├─→ complete event
       │
       ├─→ mode='crawl-all'/'crawl-matched':
       │   Show crawl progress alongside discovery summary
       │   "Discovered 553 URLs, 200 already crawled, 353 queued"
       │
       └─→ mode='review-first':
           Show standard review + scope configuration
```

### 21.4 Data Flow — Discovery → Crawl Queue

```typescript
interface CrawlAsYouDiscoverState {
  config: CrawlAsYouDiscoverConfig;
  /** URLs queued for crawling during discovery */
  queuedUrls: Set<string>;
  /** URLs already crawled */
  crawledUrls: Set<string>;
  /** Crawl progress (from existing useCrawlProgress hook) */
  crawlProgress: CrawlProgress | null;
  /** Whether the parallel crawl has started */
  crawlStarted: boolean;
}

// Called on each discovery progress event when crawl-as-you-discover is active:
function maybeQueueForCrawl(
  url: DiscoveredUrl,
  config: CrawlAsYouDiscoverConfig,
  state: CrawlAsYouDiscoverState,
): boolean {
  if (config.mode === 'disabled' || config.mode === 'review-first') return false;
  if (state.queuedUrls.has(url.href)) return false;

  if (config.mode === 'crawl-all') {
    state.queuedUrls.add(url.href);
    return true;
  }

  // crawl-matched: check criteria
  if (config.mode === 'crawl-matched' && config.matchCriteria) {
    const { contentTags, urlPrefixes, minConfidence } = config.matchCriteria;

    // Confidence check
    if (minConfidence === 'verified' && url.confidence !== 'verified') return false;

    // URL prefix match
    if (urlPrefixes?.some((prefix) => url.href.startsWith(prefix))) {
      state.queuedUrls.add(url.href);
      return true;
    }

    // Content tag match (uses existing CONTENT_TAG_MATCHERS)
    if (contentTags?.length) {
      for (const tag of contentTags) {
        const tagConfig = CONTENT_TAG_MATCHERS[tag.toLowerCase()];
        if (tagConfig) {
          const score = tagConfig.matchers.reduce((max, m) => {
            if (m.type === 'url-regex' && new RegExp(m.pattern, 'i').test(url.href))
              return Math.max(max, m.weight);
            if (m.type === 'title-keyword' && url.text?.toLowerCase().includes(m.pattern))
              return Math.max(max, m.weight);
            return max;
          }, 0);
          if (score >= 0.5) {
            state.queuedUrls.add(url.href);
            return true;
          }
        }
      }
    }
  }

  return false;
}

// Batch submission — don't submit one URL at a time, batch them
const CRAWL_BATCH_SIZE = 20;
const CRAWL_BATCH_INTERVAL = 5000; // 5 seconds

function flushCrawlQueue(state: CrawlAsYouDiscoverState): string[] {
  const pending = [...state.queuedUrls].filter((url) => !state.crawledUrls.has(url));
  if (pending.length < CRAWL_BATCH_SIZE) return []; // wait for more
  const batch = pending.slice(0, CRAWL_BATCH_SIZE);
  for (const url of batch) state.crawledUrls.add(url);
  return batch;
  // Caller submits via existing submitBatchCrawl()
}
```

### 21.5 UI: Parallel Progress Display

When crawl-as-you-discover is active, show dual progress with per-category crawl status:

```
┌──────────────────────────────────────────────────────┐
│ Discovery: 553 URLs found · 8 pages visited          │
│ ████████████░░░░░░░ Active                            │
│                                                       │
│ Crawl Progress                                        │
│ ████████████░░░░░░░░ 342/553 pages                   │
│                                                       │
│ ✅ Printers       45/45  complete                     │
│ 🔄 FAQ            8/12   crawling...                  │
│ ⏳ Scanners       0/28   queued                       │
│ ✅ Downloads      34/34  complete                     │
│ ⏳ Projectors     0/22   queued                       │
│                                                       │
│ Quality: 89% rich content · 6% thin · 5% failed      │
│                                                       │
│ [Pause crawl]  [Skip remaining]  [Re-crawl failed]   │
│ [Adjust scope]                                        │
└──────────────────────────────────────────────────────┘
```

**Per-category crawl status** tracks each discovered category independently:

```typescript
interface CategoryCrawlStatus {
  label: string;
  /** Total URLs in this category */
  total: number;
  /** URLs successfully crawled */
  crawled: number;
  /** URLs currently being crawled */
  active: number;
  /** URLs queued but not started */
  queued: number;
  /** URLs that failed */
  failed: number;
  /** Overall status */
  status: 'complete' | 'crawling' | 'queued' | 'paused';
}
```

**Actions**:

- **[Pause crawl]** — stops all active crawl workers, queued URLs remain
- **[Skip remaining]** — cancel all queued URLs, keep what's already crawled
- **[Re-crawl failed]** — re-queue only the failed URLs for another attempt
- **[Adjust scope]** — open scope configuration to add/remove categories

### 21.6 Mode Selection UX

The mode selector appears in the Discovery Console as a Decision Card when discovery starts:

```
┌──────────────────────────────────────────┐
│ How should we handle discovered pages?    │
│                                          │
│ ○ Review first (recommended)             │
│   Complete discovery, then configure      │
│   crawl scope                            │
│                                          │
│ ○ Crawl all as discovered                │
│   Start crawling immediately — every      │
│   discovered page gets crawled           │
│                                          │
│ ○ Crawl matched pages                    │
│   Only crawl pages matching criteria:    │
│   [FAQ] [Support] [Products] [Custom...] │
│                                          │
│ [Continue]                               │
└──────────────────────────────────────────┘
```

This appears as a one-time prompt during the first discovery run. The choice is saved in the crawl draft for subsequent sessions.

---

## 22. Upfront Strategy Selection (D7) — Guided Discovery

### 22.1 Problem

After Step 1 profiling completes, the user has sitemap data (sections, page counts, site type) but no clear decision point about HOW to proceed. The current flow:

1. Step 1 profiles → sections appear
2. User reviews sections → "Try browser discovery" button at the bottom
3. Browser discovery starts → nav extraction populates tree with 47 nodes
4. **Dead zone**: Tree looks populated, but no decision cards appear (they require depth-probing progress events, not nav extraction)
5. User doesn't know what to do with the tree

The intervention and transparency features (D1-D6) are implemented but **gated on depth-probing progress events** that only fire AFTER the user has already committed to browser discovery. The decision point is too late.

### 22.2 Design: Strategy Selection After Profiling

After Step 1 analysis completes (sitemap parsed, sections populated), present **three strategy cards** as the primary action — BEFORE any discovery starts.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Step 2: Choose Your Approach                                       │
│                                                                     │
│  We found {N} sections with {M} pages from the sitemap.            │
│  How would you like to proceed?                                     │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  📄 Crawl Full   │  │  🔍 Discover     │  │  🧭 Guided       │  │
│  │  Sitemap         │  │  Everything      │  │  Discovery       │  │
│  │                  │  │                  │  │                  │  │
│  │  Trust the       │  │  Let the system  │  │  You guide the   │  │
│  │  sitemap. Crawl  │  │  explore beyond  │  │  system. Browse  │  │
│  │  all {M} pages   │  │  the sitemap     │  │  the site tree,  │  │
│  │  directly.       │  │  automatically.  │  │  pick sections,  │  │
│  │                  │  │  Auto-adds all   │  │  go deeper where │  │
│  │  Best for: sites │  │  discovered      │  │  you want.       │  │
│  │  with complete   │  │  sections.       │  │                  │  │
│  │  sitemaps        │  │                  │  │  Best for: large │  │
│  │                  │  │  Best for: sites │  │  sites, specific │  │
│  │  ~{time}         │  │  with thin       │  │  content needs   │  │
│  │                  │  │  sitemaps         │  │                  │  │
│  │  [Start Crawl]   │  │  [Coming Soon]   │  │  [Start]         │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│                                                                     │
│  ── Already discovered sections ──────────────────────────────────  │
│  ☑ Support > Printers > All In Ones (67 pages)                     │
│  ☑ Support > Printers > Inkjet (43 pages)                          │
│  ...                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### 22.3 Strategy Definitions

#### Strategy A: "Crawl Full Sitemap"

- **Action**: Skip discovery entirely. Use sitemap sections as-is.
- **Flow**: Strategy card → section checklist (select/deselect) → Step 3 Configure → Step 4 Crawl
- **When recommended**: Site has sitemap with ≥20 pages, site type is documentation/e-commerce
- **Implementation**: Existing flow — just skip browser discovery, go straight to `handleContinue()`
- **No new code needed** — this is the current default path minus the discovery detour

#### Strategy B: "Discover Everything" (Coming Soon — backlog STRAT-2)

- **Status**: DEFERRED — requires defining auto-discovery principles, HTTP-based discovery role, and automatic stopping criteria before implementation
- **Action**: Start browser discovery in auto-add mode. All discovered sections are automatically included.
- **Flow**: Strategy card → BrowserDiscoveryInline starts → DiscoveryPanel shows progress → auto-adds all sections → completion → Step 3 Configure → Step 4 Crawl
- **When recommended**: Thin sitemap (<20 pages) or no sitemap
- **Crawl-as-you-discover (D6)**: Can optionally enable `crawl-all` mode so crawling starts immediately as pages are discovered
- **Implementation**: Sets `crawlAsYouDiscover.mode = 'crawl-all'`, auto-includes all sections
- **Open questions before implementation**:
  1. What are the auto-discovery principles? (When to stop, what to include/exclude, how to handle infinite sites)
  2. When does HTTP-based discovery (ExplorePanel) run vs browser-based? What triggers escalation?
  3. How does auto-mode interact with robots.txt restrictions?
- **UI**: Card shown with "Coming Soon" badge, not clickable

#### Strategy C: "Guided Discovery" (this design)

- **Action**: Start browser discovery with the full intervention UX (D1-D6). User steers.
- **Flow**: Strategy card → BrowserDiscoveryInline + DiscoveryPanel with tree, console, decision cards → user selects/skips/goes deeper → only selected sections get crawled
- **When recommended**: Large sites (>200 pages), user has specific content goals
- **This is where ALL the existing D1-D6 features become relevant**:
  - DiscoveryTree (D1) — browse, select, go deeper
  - DiscoveryConsole (D2) — see what's happening
  - Decision Cards (D3) — respond to hub discovery, yield signals
  - Action verbs (D4) — per-node steering
  - Auto-add sections (D5) — with [NEW] badge, user can exclude
  - Crawl-as-you-discover (D6) — `crawl-matched` mode for selected content

### 22.4 Component: `StrategySelector`

```typescript
interface StrategyOption {
  id: 'crawl-sitemap' | 'discover-all' | 'guided-discovery';
  icon: LucideIcon; // FileText | Search | Compass
  title: string; // i18n key
  description: string; // i18n key
  bestFor: string; // i18n key
  estimatedTime: string; // computed from section data
  recommended: boolean; // true for the best-fit strategy
  disabled?: boolean; // true if prerequisites not met
  disabledReason?: string; // e.g., "No sitemap found" for crawl-sitemap
}

interface StrategySelectorProps {
  sections: CrawlSection[]; // from Step 1 profiling
  profile: SiteProfile | null; // site type, has sitemap, etc.
  allSectionPages: number; // total pages across all sections
  onSelectStrategy: (strategy: StrategyOption['id']) => void;
}
```

**Recommendation logic:**

```typescript
function getRecommendedStrategy(
  sections: CrawlSection[],
  allSectionPages: number,
  profile: SiteProfile | null,
): StrategyOption['id'] {
  const hasSitemap = sections.length > 0;
  const THIN_THRESHOLD = 20;

  if (!hasSitemap) return 'guided-discovery'; // no sitemap → must discover
  if (allSectionPages < THIN_THRESHOLD) return 'discover-all'; // thin sitemap → discover more
  if (allSectionPages > 200) return 'guided-discovery'; // huge site → user should steer
  return 'crawl-sitemap'; // good sitemap → trust it
}
```

**Card styling:**

- Recommended strategy gets a highlighted border (accent color) + "Recommended" badge
- "Crawl Full Sitemap" is disabled (greyed out) when no sitemap exists (`sections.length === 0`)
- Each card shows estimated time based on page count and strategy complexity
- Cards use design tokens: `bg-background-subtle`, `border-accent` for recommended, `hover:border-accent/50`

### 22.5 Integration into CrawlFlowV5

**New sub-state within `analyzing`:**

The `analyzing` state currently transitions to `configure` via `handleContinue()`. With strategy selection:

```
url-entry → analyzing → [profiling completes] → STRATEGY SELECTOR visible
                                                   │
                         ┌─────────────────────────┼─────────────────────────┐
                         ▼                         ▼                         ▼
                   "Crawl Full Sitemap"     "Discover Everything"     "Guided Discovery"
                         │                    (Coming Soon)                  │
                         │                                                   ▼
                         │                                        BrowserDiscoveryInline
                         │                                        + DiscoveryPanel (D1-D6)
                         │                                                   │
                         │                                                   ▼
                         │                                        [user selects sections]
                         │                                                   │
                         ▼───────────────────────────────────────────────────▼
                                              configure
                                                  │
                                              crawling
                                                  │
                                               done
```

**Active paths (this implementation):**

- **Crawl Full Sitemap** → section checklist → configure → crawl
- **Guided Discovery** → browser discovery with full D1-D6 UX → user selects → configure → crawl

**Deferred:**

- **Discover Everything** → Coming Soon (requires auto-discovery principles)

**State machine change:**

- Add `selectedStrategy: StrategyOption['id'] | null` to State2Analysis local state
- StrategySelector renders when `analysisComplete && !selectedStrategy`
- Section list + discovery panels render when `selectedStrategy !== null`
- "Crawl Full Sitemap" sets `selectedStrategy` and immediately shows section checklist (existing flow)
- "Guided Discovery" sets `selectedStrategy` and opens BrowserDiscoveryInline with DiscoveryPanel

**No changes to CrawlFlowState type** — this is internal to State2Analysis, not a flow-level state.

### 22.6 Guided Discovery: Enhanced Tree Interaction

When the user selects "Guided Discovery", the DiscoveryPanel activates with enhanced interaction mode:

**Changes from current implementation:**

1. **Actions always visible (not hover-only)**: In guided mode, show the primary action button on every tree node always — not hidden behind hover. The secondary actions can remain on hover.

2. **Larger touch targets**: Increase from `w-3 h-3` (12px) to `w-4 h-4` (16px) with `p-1` padding, making total click target 24px.

3. **Checkbox instead of state circle**: In guided mode, replace the `Circle` state icon with a functional checkbox. Checking = "include in crawl scope". The tree becomes a selection interface, not just a display.

4. **Bulk section actions**: "Select all in this branch" and "Skip this branch" buttons at each non-leaf node.

5. **Status bar**: Replace "0 links · 0 pages · 47 tree nodes" with "{N} selected for crawling · {M} discovered · {K} skipped"

6. **Decision cards appear earlier**: In guided mode, generate an initial decision card immediately after nav extraction completes (not waiting for depth-probing hub classification):
   ```
   Trigger: 'nav-complete' (new trigger)
   Cards: "Explore top sections", "Select all navigation items", "Start with {recommended section}"
   ```

### 22.7 Interaction Flow — Guided Discovery

```
1. User clicks "Guided Discovery"
2. Nav extraction runs → tree populates with projected nodes
3. Initial decision cards appear: "Select sections to explore" / "Explore everything"
4. User browses tree, checks nodes they want
5. For checked nodes → depth prober visits them → enriched progress fires
6. Hub-discovered / yield-update decision cards appear naturally
7. User can "Go deeper" on visited nodes → more children appear
8. User can stop at any time → only checked nodes are included in crawl scope
9. On stop/complete → sections built from checked tree nodes → Step 3 Configure
```

### 22.8 When No Sitemap Exists

If Step 1 profiling returns zero sections (no sitemap), the strategy selector adapts:

- "Crawl Full Sitemap" is **disabled** with tooltip "No sitemap found on this site"
- "Discover Everything" and "Guided Discovery" remain available
- Recommended defaults to "Guided Discovery"
- Copy changes: "We couldn't find a sitemap. Use discovery to explore what's on this site."

### 22.9 Relationship to Existing Features

| Existing Feature         | Strategy A (Crawl Sitemap) | Strategy B (Discover All) | Strategy C (Guided)        |
| ------------------------ | -------------------------- | ------------------------- | -------------------------- |
| D1 Auto-collapse tree    | N/A                        | Active (read-only)        | Active (interactive)       |
| D2 Discovery Console     | N/A                        | Active                    | Active                     |
| D3 Decision Cards        | N/A                        | Auto-accepted             | Presented to user          |
| D4 Action verbs          | N/A                        | N/A (auto mode)           | Primary interaction        |
| D5 Auto-add sections     | N/A                        | All auto-added            | User confirms/rejects      |
| D6 Crawl-as-you-discover | N/A                        | `crawl-all` mode          | `crawl-matched` mode       |
| Intervention POST        | N/A                        | N/A                       | Active                     |
| YieldTracker             | N/A                        | Active (auto-stop)        | Active (user can override) |

### 22.10 Types

```typescript
/** D7: Strategy selection after profiling */
type CrawlStrategy = 'crawl-sitemap' | 'discover-all' | 'guided-discovery';

interface StrategySelectionState {
  /** Which strategy the user chose — null until they select */
  selected: CrawlStrategy | null;
  /** Whether the strategy selector should be shown */
  showSelector: boolean;
  /** Timestamp when strategy was selected */
  selectedAt?: number;
}

/** Extended DiscoveryPanel props for guided mode */
interface GuidedDiscoveryConfig {
  /** In guided mode, actions are always visible (not hover-only) */
  alwaysShowActions: boolean;
  /** In guided mode, tree nodes have checkboxes for selection */
  selectionMode: boolean;
  /** In guided mode, nav-complete triggers initial decision cards */
  earlyDecisionCards: boolean;
}
```

### 22.11 Implementation Notes

**What changes:**

1. New `StrategySelector` component (~150 LOC)
2. `State2Analysis.tsx` — add `selectedStrategy` state, conditionally render StrategySelector vs sections+discovery
3. `DiscoveryTree.tsx` — add `selectionMode` prop: checkbox vs circle, always-visible vs hover actions
4. `DiscoveryPanel.tsx` — add `nav-complete` trigger for early decision cards in guided mode
5. `DiscoveryConsole.tsx` — no changes (already supports decision cards)
6. i18n keys for strategy card titles, descriptions, recommendations

**What does NOT change:**

- CrawlFlowV5 state machine (strategy is internal to State2Analysis)
- depth-prober.ts (backend unchanged)
- SSE proxy (unchanged)
- BrowserDiscoveryInline (unchanged — it's the shell)
- Decision card generation logic (additive — new `nav-complete` trigger)
- Tree utils, url-set, console-utils (unchanged)
- All existing D1-D6 features remain intact

---

## 23. Objective Compliance Review

Cross-reference of every Tier 1+2 objective (from `project_crawler_objectives.md`) against the complete design. This review ensures no objective is lost or deviated from after the D7 (upfront strategy) and §6 (complete intervention) additions.

### Tier 1: Core Objectives

| #   | Objective                                                                                     | Design Coverage                                                                                                                              | Status            | Deviations                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **Transparency** — user sees what system is doing, found, plans to do next                    | §4.3 Discovery Console (scrollable log), §6.7 console feedback for every intervention, §6.9.1 "Next Actions" queue, §6.9.2 iteration history | **Full coverage** | None — enhanced with console feedback table (§6.7)                                                                                                                                                                                |
| G2  | **Intervention** — user can steer discovery mid-run                                           | §6.3 complete catalog (I-1 through I-10), §4.2 tree node actions, §9 decision cards, §6.5 frontend dispatch, §6.6 backend processing         | **Full coverage** | Original design had Phase 1 (stop/restart) vs Phase 2 (POST-alongside-SSE) split. New design unifies all interventions through POST-alongside-SSE — no progress-losing stop/restart. This is **better** than the original intent. |
| G3  | **No Static Caps** — adaptive mode with user intervention, not fixed maxPageVisits/sampleSize | §5 YieldTracker (signal-based stopping), §22.9 YieldTracker active in Guided mode, user can override                                         | **Full coverage** | None                                                                                                                                                                                                                              |
| G4  | **Title-as-Category** — use page titles for section naming                                    | §9.3c browse-titles dropdown, §18 fuzzy matching, §12 coverage analysis with title grouping                                                  | **Full coverage** | None                                                                                                                                                                                                                              |
| G5  | **Hub Fan-out** — discover deeper from hub pages                                              | §6.3 I-4 (explore branch), I-6 (explore all at level), §4.2 "Go deeper" tree action, §9.3b hub-discovered decision cards                     | **Full coverage** | None                                                                                                                                                                                                                              |
| G6  | **Post-Discovery Matching** — match discovered URLs to objectives                             | §9.4 deriveMatchers, §9.5 evaluateObjective, §9.3c browse-titles for objective creation                                                      | **Full coverage** | None                                                                                                                                                                                                                              |
| G7  | **Large Volume** — handle sites with thousands of pages                                       | §13 large-volume strategy (prefix sampling, confidence projection), §22 "Crawl Full Sitemap" for large sitemaps                              | **Full coverage** | D7 adds a new path: large sites with good sitemaps can skip discovery entirely (Crawl Full Sitemap). This is **complementary**, not a deviation.                                                                                  |
| G8  | **Iterative Discovery** — multiple discovery runs building on each other                      | §11 iterative discovery loop, §6.9.2 iteration history display, §6.3 I-4/I-6 trigger new iterations                                          | **Full coverage** | None                                                                                                                                                                                                                              |

### Tier 2: Flow Objectives

| #   | Objective                         | Design Coverage                       | Status            | Deviations                    |
| --- | --------------------------------- | ------------------------------------- | ----------------- | ----------------------------- |
| G9  | **Step 4 crawl-in-panel**         | §7 Sprint 4 item 11, backlog UX-A2/A3 | Designed, backlog | Not affected by D7/§6 changes |
| G10 | **Extraction preview**            | §17 backlog UX-A11                    | Backlog only      | Not affected                  |
| G11 | **Site compatibility/robots.txt** | Backlog H-3, NEW-5                    | Backlog only      | Not affected                  |
| G12 | **Per-URL error transparency**    | Backlog UX-A12                        | Backlog only      | Not affected                  |
| G13 | **Non-destructive back**          | Implemented in CrawlFlowV5            | **Done**          | Not affected                  |
| G14 | **Manual URL paste**              | Implemented in State2Analysis         | **Done**          | Not affected                  |
| G15 | **Custom scope input**            | Backlog UX-A6                         | Backlog only      | Not affected                  |

### Key Design Questions — Self-Review

**Q: Does D7 (upfront strategy selection) weaken transparency?**
A: No. "Crawl Full Sitemap" has no discovery phase, so transparency is N/A (user sees section checklist directly). "Guided Discovery" activates the FULL transparency UX — console, tree, next-actions, iteration history. If anything, transparency is **stronger** because the user enters with the "I'm steering" mental model.

**Q: Does D7 reduce the user's ability to intervene?**
A: No. All 10 interventions (I-1 through I-10) are available in Guided Discovery. "Crawl Full Sitemap" has no discovery to intervene in. The only change is WHEN the first decision happens — it moves from mid-discovery (decision cards after hub classification) to pre-discovery (strategy selection after profiling). This is **earlier**, not later.

**Q: Does unifying all interventions through POST-alongside-SSE deviate from the original phased approach?**
A: The original §6 recommended Phase 1 (stop/restart) first, Phase 2 (POST-alongside-SSE) later. The backend infrastructure for Phase 2 is already implemented (command-queue.ts, intervention endpoint, depth-prober checkCommandQueue). The new §6 design completes the remaining work: extending depth-prober to handle all command types, and wiring the frontend dispatch. This is **ahead** of the original plan, not a deviation.

**Q: Is the "Discover Everything" (Coming Soon) deferral a gap?**
A: It defers one of three strategies, but the two active strategies cover the primary use cases:

- Good sitemap → "Crawl Full Sitemap" (most common)
- Need to explore → "Guided Discovery" (power user)
  "Discover Everything" is the "set and forget" path for thin sitemaps. Deferring it until auto-discovery principles are defined avoids shipping a half-designed auto mode. This is a **deliberate scope choice**, not a gap.

**Q: Are there any objectives NOT covered by any design section?**
A: Tier 3-5 objectives (quality, security, architecture) are separate tracks and were never in scope for this design doc. All Tier 1 and Tier 2 objectives are covered or explicitly deferred with rationale.

Cross-reference of every Tier 1+2 objective (from `project_crawler_objectives.md`) against the complete design. This review ensures no objective is lost or deviated from after the D7 (upfront strategy) and §6 (complete intervention) additions.

### Tier 1: Core Objectives

| #   | Objective                                                                                     | Design Coverage                                                                                                                              | Status            | Deviations                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **Transparency** — user sees what system is doing, found, plans to do next                    | §4.3 Discovery Console (scrollable log), §6.7 console feedback for every intervention, §6.9.1 "Next Actions" queue, §6.9.2 iteration history | **Full coverage** | None — enhanced with console feedback table (§6.7)                                                                                                                                                                                |
| G2  | **Intervention** — user can steer discovery mid-run                                           | §6.3 complete catalog (I-1 through I-10), §4.2 tree node actions, §9 decision cards, §6.5 frontend dispatch, §6.6 backend processing         | **Full coverage** | Original design had Phase 1 (stop/restart) vs Phase 2 (POST-alongside-SSE) split. New design unifies all interventions through POST-alongside-SSE — no progress-losing stop/restart. This is **better** than the original intent. |
| G3  | **No Static Caps** — adaptive mode with user intervention, not fixed maxPageVisits/sampleSize | §5 YieldTracker (signal-based stopping), §22.9 YieldTracker active in Guided mode, user can override                                         | **Full coverage** | None                                                                                                                                                                                                                              |
| G4  | **Title-as-Category** — use page titles for section naming                                    | §9.3c browse-titles dropdown, §18 fuzzy matching, §12 coverage analysis with title grouping                                                  | **Full coverage** | None                                                                                                                                                                                                                              |
| G5  | **Hub Fan-out** — discover deeper from hub pages                                              | §6.3 I-4 (explore branch), I-6 (explore all at level), §4.2 "Go deeper" tree action, §9.3b hub-discovered decision cards                     | **Full coverage** | None                                                                                                                                                                                                                              |
| G6  | **Post-Discovery Matching** — match discovered URLs to objectives                             | §9.4 deriveMatchers, §9.5 evaluateObjective, §9.3c browse-titles for objective creation                                                      | **Full coverage** | None                                                                                                                                                                                                                              |
| G7  | **Large Volume** — handle sites with thousands of pages                                       | §13 large-volume strategy (prefix sampling, confidence projection), §22 "Crawl Full Sitemap" for large sitemaps                              | **Full coverage** | D7 adds a new path: large sites with good sitemaps can skip discovery entirely (Crawl Full Sitemap). This is **complementary**, not a deviation.                                                                                  |
| G8  | **Iterative Discovery** — multiple discovery runs building on each other                      | §11 iterative discovery loop, §6.9.2 iteration history display, §6.3 I-4/I-6 trigger new iterations                                          | **Full coverage** | None                                                                                                                                                                                                                              |

### Tier 2: Flow Objectives

| #   | Objective                         | Design Coverage                       | Status            | Deviations                    |
| --- | --------------------------------- | ------------------------------------- | ----------------- | ----------------------------- |
| G9  | **Step 4 crawl-in-panel**         | §7 Sprint 4 item 11, backlog UX-A2/A3 | Designed, backlog | Not affected by D7/§6 changes |
| G10 | **Extraction preview**            | §17 backlog UX-A11                    | Backlog only      | Not affected                  |
| G11 | **Site compatibility/robots.txt** | Backlog H-3, NEW-5                    | Backlog only      | Not affected                  |
| G12 | **Per-URL error transparency**    | Backlog UX-A12                        | Backlog only      | Not affected                  |
| G13 | **Non-destructive back**          | Implemented in CrawlFlowV5            | **Done**          | Not affected                  |
| G14 | **Manual URL paste**              | Implemented in State2Analysis         | **Done**          | Not affected                  |
| G15 | **Custom scope input**            | Backlog UX-A6                         | Backlog only      | Not affected                  |

### Key Design Questions — Self-Review

**Q: Does D7 (upfront strategy selection) weaken transparency?**
A: No. "Crawl Full Sitemap" has no discovery phase, so transparency is N/A (user sees section checklist directly). "Guided Discovery" activates the FULL transparency UX — console, tree, next-actions, iteration history. If anything, transparency is **stronger** because the user enters with the "I'm steering" mental model.

**Q: Does D7 reduce the user's ability to intervene?**
A: No. All 10 interventions (I-1 through I-10) are available in Guided Discovery. "Crawl Full Sitemap" has no discovery to intervene in. The only change is WHEN the first decision happens — it moves from mid-discovery (decision cards after hub classification) to pre-discovery (strategy selection after profiling). This is **earlier**, not later.

**Q: Does unifying all interventions through POST-alongside-SSE deviate from the original phased approach?**
A: The original §6 recommended Phase 1 (stop/restart) first, Phase 2 (POST-alongside-SSE) later. The backend infrastructure for Phase 2 is already implemented (command-queue.ts, intervention endpoint, depth-prober checkCommandQueue). The new §6 design completes the remaining work: extending depth-prober to handle all command types, and wiring the frontend dispatch. This is **ahead** of the original plan, not a deviation.

**Q: Is the "Discover Everything" (Coming Soon) deferral a gap?**
A: It defers one of three strategies, but the two active strategies cover the primary use cases:

- Good sitemap → "Crawl Full Sitemap" (most common)
- Need to explore → "Guided Discovery" (power user)
  "Discover Everything" is the "set and forget" path for thin sitemaps. Deferring it until auto-discovery principles are defined avoids shipping a half-designed auto mode. This is a **deliberate scope choice**, not a gap.

**Q: Are there any objectives NOT covered by any design section?**
A: Tier 3-5 objectives (quality, security, architecture) are separate tracks and were never in scope for this design doc. All Tier 1 and Tier 2 objectives are covered or explicitly deferred with rationale.

### Objective Conflict Resolutions

Where objectives create tension with each other or with design decisions, explicit resolutions are documented here. Each resolution names the governing principle so future design changes can evaluate whether the principle still holds.

#### Summary

| #   | Conflict                                        | Severity   | Resolution                                                                                        | Principle                          |
| --- | ----------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | UJ-16 vs D6 — Selection contract vs auto-crawl  | **HIGH**   | Scope flows down from samples; D6 only crawls in-scope; pre-ingestion review is contract boundary | Scope flows down, never up         |
| 2   | UJ-4 vs G7 — Precise selection at scale         | **MEDIUM** | Progressive disclosure + exclusion patterns                                                       | Precision available, not mandatory |
| 3   | G1 vs G7 — Transparency vs information overload | **LOW**    | Counter on FIFO cap                                                                               | Transparent hiding                 |
| 4   | UJ-6 — Completeness bounded by exploration      | **LOW**    | Explicit boundary language                                                                        | Honest boundaries                  |
| 5   | G2 vs G3 — User override vs adaptive signals    | **LOW**    | User always wins, with advisory warning                                                           | User decides, system advises       |

#### 1. UJ-16 vs D6 — Selection contract vs auto-crawl (HIGH)

**Resolution: Scope flows down from samples. D6 only crawls in-scope items. Pre-ingestion review is the contract boundary.**

The conflict between "selection is the contract" (UJ-16) and crawl-as-you-discover (D6) is resolved by defining clear scope rules based on the user's sample URLs:

**Scope Flow Rules:**

| Relationship to sample URL               | Discovery effect                        | In crawl scope?                                                |
| ---------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| Sample URL itself                        | Visited, patterns extracted             | **Yes** — user explicitly pointed here                         |
| Children (downward from sample)          | Discovered via depth probing            | **Yes** — subtree of user's intent                             |
| Parents (upward from sample)             | Visited for breadcrumb-climb navigation | **No** — discovery hubs only, never auto-included              |
| Siblings (lateral, same level as sample) | Discovered via parent hub               | **No** — shown as [NEW] sections, user must explicitly include |

**Key principles:**

- **Samples teach the system where to LOOK, scope defines what to CRAWL.** Providing a sample URL at `/support/printers/troubleshooting` means: include everything under `/support/printers/**`, discover siblings like `/support/scanners/` but do NOT auto-include them.
- **Scope flows DOWN, never UP.** Parents are visited during breadcrumb-climb to discover siblings and understand structure, but parent URLs are never added to crawl scope. This prevents recursive blow-up where one deep sample URL pulls in the entire site.
- **D6 crawl-as-you-discover only crawls URLs that are IN SCOPE.** It does not speculatively crawl discovered-but-unselected content. The speed benefit comes from crawling in-scope pages as soon as they're discovered, rather than waiting for discovery to complete.
- **Pre-ingestion review (Step 3) is the final contract boundary.** Before any content enters the knowledge base, the user sees everything that was crawled and confirms. This is where UJ-16's "selection is the contract" is enforced.
- **User can always unselect.** Auto-included children (sub-branches of sample) can be excluded via I-5 skip-branch, D5 section [exclude] toggle, or tree node "Skip" action. Selection is the default for the sample's subtree, but every inclusion is reversible (UJ-11).

**Scenario walkthrough:**

1. User provides sample: `/support/printers/troubleshooting`
2. System extracts patterns, starts depth probing from that URL
3. Breadcrumb-climb visits `/support/printers/` (hub) → discovers siblings: `drivers`, `faq`, `downloads`
4. These siblings are IN SCOPE (children of `/support/printers/`, which is parent of the sample's branch)
5. Breadcrumb-climb visits `/support/` (higher hub) → discovers siblings: `scanners`, `projectors`
6. These siblings are NOT in scope — shown as [NEW] sections with [include] toggle
7. D6 starts crawling in-scope pages (`/support/printers/**`) while user reviews [NEW] sections
8. User includes "Scanners" → `/support/scanners/**` enters scope → D6 starts crawling those too
9. Step 3 pre-ingestion review: user sees all crawled content, confirms before ingestion

**Governing principle:** Steering is consent for the sample's subtree. Everything else requires explicit user action.

#### 2. UJ-4 vs G7 — Precise selection at scale (MEDIUM)

**Resolution: Progressive disclosure + exclusion patterns.**

Small sites show page-level checkboxes. All sites show section-level selection with a "Show pages" expander revealing individual pages. Power users can add exclusion patterns within sections (e.g., "include Support but exclude `/support/downloads/*`"). This means every user gets the level of precision they need without being forced into page-by-page selection on large sites.

**Principle: precision is available but not mandatory.**

#### 3. G1 vs G7 — Transparency vs information overload (LOW)

**Resolution: Counter on FIFO cap.**

The console already uses a 200-entry FIFO and the tree auto-collapses at 30 nodes. Add a visible counter: "Showing 200 of 1,247 events" so the user knows information is being hidden rather than absent. No change to the underlying FIFO or collapse behavior — just surface awareness.

**Principle: transparent hiding.**

#### 4. UJ-6 — Completeness bounded by exploration (LOW)

**Resolution: Explicit boundary language.**

When showing content-type results, include boundary context: "Found 12 FAQ pages in explored areas. 3 branches not yet explored may contain more." No system change needed — pure UX communication that sets correct expectations about what the system has and has not seen.

**Principle: honest boundaries.**

#### 5. G2 vs G3 — User override vs adaptive signals (LOW)

**Resolution: User always wins, with advisory warning.**

When user overrides YieldTracker (e.g., "go deeper" on a declining branch), show warning: "This branch has low discovery rate (2 new pages in last 15 visited). Continue anyway?" User confirms, system obeys. No budget system — that reintroduces static caps (violates G3). The YieldTracker remains advisory-only; it never blocks the user.

**Principle: user decides, system advises.**

---

## 20. Review Resolution Index

All findings from the architecture review have been resolved inline. This index maps finding IDs to their resolution locations:

| Finding    | Severity | Resolution Location                    | Summary                                                                                        |
| ---------- | -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| C1         | CRITICAL | §8.1                                   | Defined `DiscoveredUrl` type + mappers from `DepthProbeLink`/`DiscoveredLink`                  |
| C2         | CRITICAL | §3 (data flow) + §4.2 (tree algorithm) | Enriched `DepthProbeProgress` with `currentUrl`, `discoveredOnPage`, `siblings`                |
| C3         | CRITICAL | §8.2                                   | Moved `isLikelyVariable` to shared `packages/crawler/src/intelligence/utils/`                  |
| H1         | HIGH     | §11.3                                  | Single `normalizeDiscoveryUrl` function for all comparisons                                    |
| H2         | HIGH     | §11.3                                  | Replaced `structuredClone` with `DiscoveredUrlSet` (Map-based) + in-place `upsertNode`         |
| H3         | HIGH     | §10.3                                  | Added Playwright hover events before reading mega-menu children                                |
| H4         | HIGH     | §13.4                                  | Fixed `s.variable` → `s.isVariable`                                                            |
| H5         | HIGH     | §11.3b                                 | Tree state preserved via `useRef`, `DiscoveryRunMeta` tracks per-run active nodes              |
| M1         | MEDIUM   | Kept                                   | Full objective system retained for production scope                                            |
| M2         | MEDIUM   | §9.7                                   | Added `categorizeChildrenRobust` — tries URL clusterer first, falls back to title              |
| M3         | MEDIUM   | §12.3                                  | `assessCategoryConfidence` now returns continuous `score` + raw numbers                        |
| M4         | MEDIUM   | §19                                    | Sequential multi-source with shared state (avoids parallel SSE complexity)                     |
| M5         | MEDIUM   | §8.3                                   | Split `displayName` (UI) from `pathSegment` (lookup) in `DiscoveryTreeNode`                    |
| L1         | LOW      | §11.4                                  | Fixed template literal (backticks)                                                             |
| L2         | LOW      | §8.5                                   | Defined `CONTENT_TAG_MATCHERS` constant                                                        |
| L3         | LOW      | §11.4                                  | Removed static `lastYield < 5` — uses ratio to first iteration instead                         |
| L5         | LOW      | §10.3                                  | Defined `extractNavRegion` and `trySitemapPage` functions                                      |
| Obj-1      | Gap      | §16.1                                  | Added "next actions" queue display in Activity zone                                            |
| Obj-2      | Gap      | §8.4                                   | Added `undo-skip` intervention type                                                            |
| Obj-3      | Gap      | §5                                     | Replaced all static caps with signal-based `YieldTracker`                                      |
| Obj-5      | Gap      | §12.3                                  | Continuous confidence score, not binary threshold                                              |
| Obj-7      | Gap      | §18                                    | Fuzzy matching for titles + projected URL label quality strategy                               |
| Obj-8      | Gap      | §16.2                                  | Iteration history display                                                                      |
| Feedback-1 | Missing  | §17.2                                  | Clickable sample URL chips                                                                     |
| Feedback-3 | Missing  | §17.1                                  | Discovery result caching via crawl draft                                                       |
| Feedback-4 | Missing  | §17.3                                  | Sample URL input prominence                                                                    |
| D1         | Decision | §4.2                                   | Auto-collapsing tree with breadcrumb trail (threshold: 30 visible nodes)                       |
| D2         | Decision | §4.3                                   | Discovery Console replacing DiscoveryActivity — scrollable log + action chips                  |
| D3         | Decision | §9                                     | Dynamic Decision Cards replacing free-text objectives                                          |
| D4         | Decision | §4.2                                   | Action-specific verbs per node state (Visit & discover, Add to scope, Go deeper, Verify, Skip) |
| D5         | Decision | §6                                     | Auto-add sections with [NEW] badge, dismissible, console transparency                          |
| D6         | Decision | §21                                    | Crawl-as-you-discover — three modes (review-first, crawl-all, crawl-matched)                   |
| D7         | Decision | §22                                    | Upfront strategy selection — Crawl Full Sitemap / Discover Everything / Guided Discovery       |
