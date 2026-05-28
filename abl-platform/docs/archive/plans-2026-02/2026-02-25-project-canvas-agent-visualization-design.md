# Project Canvas & Agent Visualization — Design Document

**Date**: 2026-02-25 (updated 2026-03-04)
**Status**: Layer 1 implemented — interactive edges, smooth zoom, layout improvements complete
**Problem**: Agent developers and project leads cannot visualize or understand what is happening at the project level (multi-agent topology) or at the agent level (agent internals). The current mini-topology is too small and non-interactive. The current agent detail page is an accordion of collapsed sections that hides the big picture.

**Solution**: A two-layer interactive canvas system using `@xyflow/react` v12 + ELK.js layout. Layer 1 (Project Canvas) shows all agents and their relationships. Layer 2 (Agent Detail) shows the internals of a single agent. Non-agent elements use a side panel; agents use a full-view transition.

**References**: n8n (visual workflow canvas), Decagon AOP (structured clarity + observability).

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Layer 1 — Project Canvas](#2-layer-1--project-canvas)
   - [2.1 ELK Layout Configuration](#21-elk-layout-configuration)
   - [2.2 Node Types](#22-node-types)
   - [2.3 Edge Types](#23-edge-types)
   - [2.4 Badges & Indicators](#24-badges--indicators)
   - [2.5 Views — Zoom, Pan, Center, Fit](#25-views--zoom-pan-center-fit)
   - [2.6 Events](#26-events)
   - [2.7 CSS Animations & Transitions](#27-css-animations--transitions)
   - [2.8 Side Panel (Non-Agent Elements)](#28-side-panel-non-agent-elements)
   - [2.9 Full View Transition (Agent Nodes)](#29-full-view-transition-agent-nodes)
3. [Layer 2 — Agent Detail Canvas](#3-layer-2--agent-detail-canvas)
   - [3.1 Scripted Agent View](#31-scripted-agent-view)
   - [3.2 Reasoning Agent View](#32-reasoning-agent-view)
   - [3.3 ELK Layout (Agent Internals)](#33-elk-layout-agent-internals)
   - [3.4 Node Types (Agent Internals)](#34-node-types-agent-internals)
   - [3.5 Edge Types (Agent Internals)](#35-edge-types-agent-internals)
   - [3.6 Badges & Indicators (Agent Internals)](#36-badges--indicators-agent-internals)
   - [3.7 Views — Zoom, Pan, Center, Fit](#37-views--zoom-pan-center-fit)
   - [3.8 Events (Agent Internals)](#38-events-agent-internals)
   - [3.9 CSS Animations & Transitions](#39-css-animations--transitions-1)
   - [3.10 Side Panel (Step/Tool Detail)](#310-side-panel-steptool-detail)
4. [Shared Infrastructure](#4-shared-infrastructure)
5. [Data Flow](#5-data-flow)
6. [Responsive Behavior](#6-responsive-behavior)
7. [Accessibility](#7-accessibility)
8. [Migration from Current Topology](#8-migration-from-current-topology)
9. [Agent Pattern Topologies (L1 Complexity)](#9-agent-pattern-topologies-l1-complexity)
   - [9.1 Pattern Catalog](#91-pattern-catalog) — Star, Nested Supervisors, Return Handoffs, Delegate Chains, Mesh, Chain, Fan-Out, Escalation, Remote Agents, Mixed
   - [9.2 Edge Overlap Resolution](#92-edge-overlap-resolution) — Handle multiplexing, smart edge routing
10. [Large Graph Handling (30+ Agents)](#10-large-graph-handling-30-agents)
    - [10.1 Performance Tiers](#101-performance-tiers) — Standard / Optimized / Scaled / Heavy
    - [10.2 Semantic Zoom (3 Detail Levels)](#102-semantic-zoom-3-detail-levels) — Compact Pill / Summary Card / Full Card
    - [10.3 Collapse / Expand Groups](#103-collapse--expand-groups) — Auto-grouping, collapse animation
    - [10.4 Search & Filter Overlay](#104-search--filter-overlay) — Fuzzy search, filter chips, dimming
    - [10.5 Layout Strategies by Graph Size](#105-layout-strategies-by-graph-size) — Dynamic spacing
    - [10.6 Viewport Culling & Rendering](#106-viewport-culling--rendering)
11. [Complex Branching (L2 — Scripted Agent Detail)](#11-complex-branching-l2--scripted-agent-detail)
    - [11.1 Branching Constructs in ABL](#111-branching-constructs-in-abl) — ON_INPUT, ON_SUCCESS/FAILURE, ON_RESULT, CHECK
    - [11.2 Multi-Way Branching (8+ branches)](#112-multi-way-branching-on_input-with-8-branches) — BranchTableNode, virtual gather points
    - [11.3 Binary Branching](#113-binary-branching-on_success--on_failure-check)
    - [11.4 Merge Points (Fan-In)](#114-merge-points-fan-in)
    - [11.5 Cycles and Back-Edges](#115-cycles-and-back-edges-loops-in-flow) — DFS detection, BackEdge rendering, self-loops
    - [11.6 Digressions (Global Escape Routes)](#116-digressions-global-escape-routes)
    - [11.7 Long-Range Edges](#117-long-range-edges-jump-targets) — Edge curvature, hover dimming
12. [Large Agent Detail Handling (L2 at Scale)](#12-large-agent-detail-handling-l2-at-scale)
    - [12.1 Step Count Thresholds](#121-step-count-thresholds)
    - [12.2 Semantic Zoom for L2 Nodes](#122-semantic-zoom-for-l2-nodes)
    - [12.3 Sub-Flow Collapsing](#123-sub-flow-collapsing)
    - [12.4 Reasoning Agent at Scale](#124-reasoning-agent-at-scale-many-toolsrules) — Tool/rule grouping
13. [Edge Overlap & Crossing Resolution](#13-edge-overlap--crossing-resolution)
    - [13.1 Bidirectional Edge Pairs](#131-bidirectional-edge-pairs) — Parallel offset rendering
    - [13.2 Multi-Edge Between Same Pair](#132-multi-edge-between-same-pair) — Stacked edges
    - [13.3 Edge Crossing Minimization](#133-edge-crossing-minimization) — Hover isolation, connected-subgraph highlighting
    - [13.4 Node Overlap Prevention](#134-node-overlap-prevention) — Snap on drag stop
14. [Appendix: Complete Node & Edge Type Registry](#14-appendix-complete-node--edge-type-registry)
15. [Appendix: ELK Configuration Matrix](#15-appendix-elk-configuration-matrix)
16. [Agent Detail — Scripted Agent Patterns (L2 Complexity)](#16-agent-detail--scripted-agent-patterns-l2-complexity)
    - [16.1 Linear Chain Flow](#161-linear-chain-flow) — Simple sequential, 5 steps
    - [16.2 Single Binary Branch](#162-single-binary-branch-on_success--on_failure) — Diamond node, 2 paths
    - [16.3 Nested Binary Branches](#163-nested-binary-branches) — Branch within branch
    - [16.4 Wide Fan-Out (ON_INPUT 10 branches)](#164-wide-fan-out-on_input-with-10-branches) — BranchTableNode
    - [16.5 Simple Retry Cycle](#165-simple-retry-cycle) — BackEdge + loop badge
    - [16.6 Multiple Overlapping Cycles](#166-multiple-overlapping-cycles) — Authentication_Agent pattern
    - [16.7 Long-Range Jump](#167-long-range-jump) — confirm → welcome
    - [16.8 Parallel Verification Paths](#168-parallel-verification-paths-swim-lanes) — Swim lanes
    - [16.9 Gather-Heavy Flow](#169-gather-heavy-flow) — Multiple gather groups
    - [16.10 Maximum Complexity Mixed](#1610-maximum-complexity-mixed) — All constructs combined
17. [Agent Detail — Reasoning Agent Patterns (L2 Complexity)](#17-agent-detail--reasoning-agent-patterns-l2-complexity)
    - [17.1 Minimal Reasoning Agent](#171-minimal-reasoning-agent) — Goal + 2 tools
    - [17.2 Standard Reasoning Agent](#172-standard-reasoning-agent) — 8 tools, 3 rules, handoffs
    - [17.3 Tool-Heavy Agent (15+ tools)](#173-tool-heavy-reasoning-agent-15-tools) — Auto-grouping by prefix
    - [17.4 Constraint-Heavy Agent (10+ rules)](#174-constraint-heavy-reasoning-agent-10-rules) — Rule grouping by category
    - [17.5 Mixed Mode (Reasoning + Gather + Delegates)](#175-mixed-mode-reasoning--gather--delegates) — Full complexity
18. [Agent Detail — Views & Interactions Deep Dive](#18-agent-detail--views--interactions-deep-dive)
    - [18.1 Zoomed-Out Overview](#181-zoomed-out-overview-zoom-03-05) — Compact pills, strategic view
    - [18.2 Standard Working View](#182-standard-working-view-zoom-05-08) — Summary cards, understanding view
    - [18.3 Zoomed-In Detail](#183-zoomed-in-detail-zoom-08-20) — Full cards, editing view
    - [18.4 Pan Behavior & Navigation](#184-pan-behavior--navigation) — Keyboard nav, breadcrumbs
    - [18.5 Centering & Focus](#185-centering--focus) — Search results, expand, entry point
    - [18.6 Side Panel Interactions](#186-side-panel-interactions) — Open/close, crossfade, width
    - [18.7 L1 to L2 Transitions](#187-l1-to-l2-transitions) — Frame-by-frame timing, URL state
19. [Test Scenarios](#19-test-scenarios)
    - [19.1 L1 Project Canvas — Topology Scenarios](#191-l1-project-canvas--topology-scenarios) — T1-T20: Empty, star, nested, chain, mesh, return handoffs, mixed, large, extreme, compilation errors
    - [19.2 L2 Agent Detail — Scripted Agent Scenarios](#192-l2-agent-detail--scripted-agent-scenarios) — S1-S16: Minimal, linear, branching, cycles, gather, tools, maximum complexity
    - [19.3 L2 Agent Detail — Reasoning Agent Scenarios](#193-l2-agent-detail--reasoning-agent-scenarios) — R1-R6: Minimal, standard, tool-heavy, constraint-heavy, delegates, handoffs
    - [19.4 Interaction Scenarios](#194-interaction-scenarios) — I1-I13: Transitions, panels, search, drag, collapse, keyboard, navigation
    - [19.5 Edge Cases & Error Scenarios](#195-edge-cases--error-scenarios) — E1-E10: API failures, compilation errors, truncation, cycles, network errors
    - [19.6 Responsive Scenarios](#196-responsive-scenarios) — RES1-RES4: Desktop, laptop, tablet, mobile
    - [19.7 Performance Scenarios](#197-performance-scenarios) — P1-P6: Load times, frame rates, layout computation budgets
20. [Modern Architecture Reference](#20-modern-architecture-reference)
    - [20.1 Technology Stack Upgrade Path](#201-technology-stack-upgrade-path)
    - [20.2 Vercel React Best Practices Applied](#202-vercel-react-best-practices-applied) — 57 rules, 8 categories
    - [20.3 React Flow v12 Performance Patterns](#203-react-flow-v12-performance-patterns) — Memoization, selectors, culling
    - [20.4 ELK.js Configuration Reference](#204-elkjs-configuration-reference) — L1, L2 scripted, L2 reasoning configs
    - [20.5 SSR + Streaming Architecture](#205-ssr--streaming-architecture) — Server fetch, Suspense stream, client hydrate
    - [20.6 Performance Budget (Updated)](#206-performance-budget-updated) — TTFB, layout, FPS, bundle targets
21. [Implementation Status (2026-03-04)](#21-implementation-status-2026-03-04)
    - [21.1 Layer 1 — What's Implemented](#211-layer-1--whats-implemented) — Interactive edges, zoom, layout
    - [21.2 Layer 1 — Not Yet Implemented](#212-layer-1--not-yet-implemented) — L2 detail, search, groups
    - [21.3 Files Modified](#213-files-modified) — 11 files across canvas, store, DSL
    - [21.4 Custom Event Pattern](#214-custom-event-pattern) — Edge delete/edit/change-type events
    - [21.5 DSL Mutation Interfaces](#215-dsl-mutation-interfaces) — AddHandoffConfig, AddDelegateConfig

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                     Project Canvas (L1)                      │
│                                                              │
│  ┌──────────┐    handoff    ┌──────────┐    delegate         │
│  │Supervisor│──────────────▶│ Booking  │──────────────▶ ...  │
│  │  Agent   │               │  Agent   │                     │
│  └──────────┘               └──────────┘                     │
│       │ escalate                                             │
│       ▼                                                      │
│  ┌──────────┐                                                │
│  │ Fallback │    ← Click on Booking Agent                    │
│  │  Agent   │                                                │
│  └──────────┘        │                                       │
│                      ▼                                       │
│  ┌───────────────────────────────────────────────────────┐   │
│  │              Agent Detail Canvas (L2)                 │   │
│  │                                                       │   │
│  │  [Start] → [Greet] → [Gather] → [Search] → [Branch]  │   │
│  │                         ↕           ↕         ↙  ↘    │   │
│  │                    (side panel)  (side panel) ...  ... │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**Two distinct `<ReactFlow>` instances**, not nested:

- **L1**: Project-level topology. Rendered in the project agents page.
- **L2**: Agent-level internals. Rendered when the user drills into an agent (full-view transition).

Each layer has its own `nodeTypes`, `edgeTypes`, ELK layout configuration, event handlers, and animation behavior.

**Library Stack**:

- `@xyflow/react` v12.4+ — Canvas, nodes, edges, viewport, controls, SSR support, built-in dark mode (`colorMode`)
- `React Flow UI` (shadcn CLI) — Pre-built BaseNode, StatusIndicator, NodeSearch, ZoomSlider, LabeledGroupNode, DevTools
- `elkjs` — Auto-layout engine (replaces dagre; actively maintained, supports subflows, port-aware routing, 12+ algorithms)
- Zustand 5 — Split canvas stores: viewport (high-freq) | selection (medium) | data (low-freq)
- Tailwind CSS 4 + CSS variables — All styling via existing design tokens
- CSS animations (keyframes) — Node entrance, edge drawing, selection glow
- `@xyflow/react` viewport transitions — Zoom, pan, fit, center (duration + easing)
- Web Workers — ELK.js layout computation off main thread for non-blocking UI
- React 19 + Next.js 15 — Server Components for data fetching, Suspense streaming, `startTransition` for layout recalc

**Vercel React Best Practices** (57 rules, 8 categories) applied throughout:

- `async-suspense-boundaries`: Stream topology data progressively via Suspense
- `bundle-dynamic-imports`: `next/dynamic` for canvas components (~150KB code-split)
- `rerender-defer-reads`: Derived selectors, never raw `nodes[]` in components
- `rendering-content-visibility`: `content-visibility: auto` on off-screen panel content
- `rerender-transitions`: `startTransition` for non-urgent layout recalculation
- `js-set-map-lookups`: `Map<string, Node>` for O(1) node resolution (not array iteration)
- `rendering-svg-precision`: Reduced SVG coordinate decimals for edge paths

---

## 2. Layer 1 — Project Canvas

The full-page canvas that replaces the current mini-topology + card grid. This is the primary view when navigating to a project's agents page.

### 2.1 ELK Layout Configuration

```typescript
const PROJECT_LAYOUT_CONFIG: ElkLayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN', // Top-to-bottom: supervisor at top, children below
  'elk.layered.spacing.nodeNodeBetweenLayers': '120', // 120px vertical gap between ranks
  'elk.spacing.nodeNode': '80', // 80px horizontal gap between siblings
  'elk.padding': '[top=40,left=40,bottom=40,right=40]',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP', // Better than Dagre's default
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.edgeRouting': 'ORTHOGONAL', // Clean right-angle edge paths (native — no manual offset hack)
  'elk.layered.mergeEdges': 'true', // Merge parallel edges between same pair
  'elk.portConstraints': 'FIXED_ORDER', // Port-aware routing reduces edge crossings
};

// Node dimensions registered with ELK (via `layoutOptions` per node)
const PROJECT_NODE_DIMENSIONS = {
  supervisor: { width: 280, height: 140 },
  agent: { width: 260, height: 120 },
};
```

**Why ELK.js over Dagre**:

| Feature               | Dagre (deprecated)                 | ELK.js (active)                        |
| --------------------- | ---------------------------------- | -------------------------------------- |
| Maintenance           | Unmaintained since 2018            | Active (Eclipse Foundation)            |
| Subflow support       | None                               | Native hierarchy                       |
| Layout algorithms     | 1 (network simplex)                | 12+ (layered, force, stress, radial)   |
| Edge routing          | Basic (manual offset hacks needed) | Orthogonal, splines, polyline (native) |
| Port-aware routing    | No                                 | Yes (reduces crossings automatically)  |
| Async API             | Synchronous (blocks main thread)   | Promise-based (Web Worker ready)       |
| Crossing minimization | Basic                              | LAYER_SWEEP, INTERACTIVE strategies    |

**Why DOWN (top-to-bottom)**:

- Supervisors naturally sit "above" the agents they orchestrate
- Matches the mental model of delegation flowing downward
- Entry point at the top — the first thing the eye hits
- Consistent with the existing TopologyCanvas vertical layout

**Re-layout triggers**:

- Initial load (agents fetched)
- Agent added or removed
- User clicks "Auto-layout" button (resets manual positions)

**Position persistence**:

- After ELK computes initial positions, user can drag nodes freely
- Dragged positions stored in Zustand (persisted to localStorage per project)
- A "Reset layout" button re-runs ELK and clears saved positions

### 2.2 Node Types

Two custom node types registered with `@xyflow/react`:

#### SupervisorNode

```
┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐
╔═══════════════════════════════════════════╗
║  ⊞  Customer Support Supervisor          ║  ← Network icon + name
║  ─────────────────────────────────────    ║
║  SUPERVISOR  │  Reasoning  │  ● Entry    ║  ← Role + mode + entry badge
║                                          ║
║  "Routes customer inquiries to the       ║  ← Goal (3-line clamp)
║   appropriate specialized agent..."      ║
║  ─────────────────────────────────────    ║
║  3 routes  │  claude-sonnet-4-6          ║  ← Route count + model
╚═══════════════════════════════════════════╝
└─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘ ← Dashed group boundary (optional)
```

**Styling**:

- Border: `2px solid hsl(var(--accent))` (indigo)
- Background: `hsl(var(--accent-subtle))` with `0.6` opacity
- Border-radius: `var(--radius-xl)` (12px)
- Shadow: `var(--shadow-md)`
- Width: 280px, min-height: 140px

**Handles**:

- Bottom center: `<Handle type="source" position={Position.Bottom} />` — for outgoing handoff/delegate/escalate edges
- Top center: `<Handle type="target" position={Position.Top} />` — for incoming edges (if another agent escalates to this supervisor)
- Handles hidden by default, visible on hover (CSS opacity transition)

#### AgentNode

```
╔═══════════════════════════════════════╗
║  ◆  Hotel Booking Agent              ║  ← Sparkles icon + name
║  ─────────────────────────────────    ║
║  Scripted  │  5 tools  │  3 steps    ║  ← Mode + tool count + step count
║                                      ║
║  "Help customers find and book       ║  ← Goal (2-line clamp)
║   hotel rooms"                       ║
║  ─────────────────────────────────    ║
║  gpt-4o  │  2h ago                   ║  ← Model + last updated
╚═══════════════════════════════════════╝
```

**Styling**:

- Border: `1px solid hsl(var(--border))`
- Background: `hsl(var(--background-elevated))`
- Border-radius: `var(--radius-xl)` (12px)
- Shadow: `var(--shadow-sm)`
- Width: 260px, min-height: 120px

**Selected state**: Border becomes `2px solid hsl(var(--accent))`, shadow becomes `var(--shadow-glow)`

**Hover state**: `translateY(-2px)`, shadow lifts to `var(--shadow-lg)`, border tints to `hsl(var(--accent) / 0.3)`. Uses `transition: all var(--duration-normal) var(--ease-out)`.

**Handles**:

- Top center: `<Handle type="target" position={Position.Top} />`
- Bottom center: `<Handle type="source" position={Position.Bottom} />`
- Left/Right handles added dynamically when edges require horizontal connections

#### Entry Marker

The entry agent (supervisor or single agent) gets an additional visual indicator:

- Small green pulse dot (`status-pulse` CSS class) at top-left corner
- "Entry" text badge using `bg-success-subtle text-success` styling
- Subtle green border glow: `box-shadow: 0 0 0 3px hsl(var(--success) / 0.15)`

### 2.3 Edge Types

Three custom edge types, all extending `BaseEdge` from `@xyflow/react`:

#### HandoffEdge

- **Style**: Solid stroke, `2px`, color `hsl(var(--accent))` (indigo)
- **Path**: `SmoothStepEdge` path function (step-like routing that avoids overlapping nodes)
- **Marker**: Arrow marker at target end (`markerEnd: MarkerType.ArrowClosed`)
- **Label**: "handoff" or custom label from DSL, rendered via `EdgeLabelRenderer`
- **Label styling**: `text-xs font-medium` pill with `bg-background-elevated border border-muted rounded-full px-2 py-0.5`

#### DelegateEdge

- **Style**: Dashed stroke (`strokeDasharray: "8,4"`), `2px`, color `hsl(var(--foreground-muted))`
- **Path**: `SmoothStepEdge`
- **Marker**: Open arrow at target (`markerEnd: MarkerType.Arrow`)
- **Label**: "delegate" or custom label
- **Animation**: Dash offset animation for a flowing/moving effect:
  ```css
  @keyframes dash-flow {
    to {
      stroke-dashoffset: -24;
    }
  }
  .edge-delegate path {
    animation: dash-flow 1.5s linear infinite;
  }
  ```

#### EscalateEdge

- **Style**: Dotted stroke (`strokeDasharray: "4,4"`), `2px`, color `hsl(var(--warning))`
- **Path**: `SmoothStepEdge`
- **Marker**: Diamond marker at target end (custom SVG marker def)
- **Label**: "escalate" with warning icon
- **Label styling**: `bg-warning-subtle text-warning` pill

**Edge hover**: All edges thicken to `3px` and increase opacity on hover. Connected nodes get a subtle highlight ring (`box-shadow`). Transition: `var(--duration-fast)`.

**Edge click**: Opens the side panel with edge details (source agent, target agent, edge type, condition if any).

### 2.4 Badges & Indicators

Badges rendered inside custom node components using standard Tailwind classes:

| Badge           | Styling                                                                                         | Where                 |
| --------------- | ----------------------------------------------------------------------------------------------- | --------------------- |
| **Supervisor**  | `bg-purple-subtle text-purple text-xs font-medium px-2 py-0.5 rounded-full`                     | SupervisorNode header |
| **Reasoning**   | `bg-info-subtle text-info text-xs font-medium px-2 py-0.5 rounded-full`                         | Both node types       |
| **Scripted**    | `bg-background-muted text-foreground-muted text-xs font-medium px-2 py-0.5 rounded-full`        | Both node types       |
| **Entry**       | `bg-success-subtle text-success text-xs font-medium px-2 py-0.5 rounded-full` + green pulse dot | Entry agent only      |
| **Tool count**  | `text-xs text-muted` with wrench icon `w-3 h-3`                                                 | Both node types       |
| **Step count**  | `text-xs text-muted` with list icon `w-3 h-3`                                                   | Scripted agents only  |
| **Model**       | `text-xs text-subtle font-mono`                                                                 | Both node types       |
| **Route count** | `text-xs text-muted` with git-branch icon                                                       | Supervisor only       |

**Zoom-level badge visibility**:

- Zoom ≥ 0.7: All badges visible
- Zoom 0.4–0.7: Only name + mode + entry badges visible. Tool/step/model badges hidden.
- Zoom < 0.4: Only name visible. All badges hidden. Nodes become compact pills.

This is implemented by reading `useViewport().zoom` inside node components and conditionally rendering badge rows.

### 2.5 Views — Zoom, Pan, Center, Fit

All viewport operations use `useReactFlow()` hook methods with smooth animated transitions.

#### Zoom Levels

| Level        | Zoom Range   | What's Visible                                      | Trigger                                          |
| ------------ | ------------ | --------------------------------------------------- | ------------------------------------------------ |
| **Overview** | 0.2–0.4      | Node name pills only, edge lines, layout shape      | `fitView()` on large graphs (10+ agents)         |
| **Standard** | 0.5–0.8      | Full node cards with badges, edge labels            | Default zoom after `fitView()` on typical graphs |
| **Detailed** | 0.9–1.5      | Everything + hover interactions + handle visibility | Manual zoom-in or `setCenter()` on a node        |
| **Max**      | 1.5 (capped) | —                                                   | `maxZoom` prop on `<ReactFlow>`                  |

#### fitView (Initial Load & Reset)

Called on:

- Initial canvas mount (after ELK layout completes)
- "Fit all" button in controls
- After agent added/removed (re-layout)

```typescript
fitView({
  padding: 0.15, // 15% padding around node bounds
  duration: 500, // 500ms smooth transition
  maxZoom: 1.0, // Don't zoom in beyond 1.0 on fit
});
```

Animation: Eases in with `var(--ease-spring)` equivalent (custom ease function passed to viewport methods).

#### setCenter (Focus on Node)

Called when:

- User searches and selects an agent from search results
- User clicks a node in the mini-map
- External navigation targets a specific agent (URL hash `#agent-name`)

```typescript
setCenter(node.position.x + nodeWidth / 2, node.position.y + nodeHeight / 2, {
  zoom: 1.0,
  duration: 400,
});
```

The target node also gets a brief attention pulse: `box-shadow` scales from `0 0 0 0px` to `0 0 0 8px hsl(var(--accent) / 0.3)` and back over 600ms. CSS animation:

```css
@keyframes attention-pulse {
  0% {
    box-shadow: 0 0 0 0px hsl(var(--accent) / 0.4);
  }
  50% {
    box-shadow: 0 0 0 8px hsl(var(--accent) / 0);
  }
  100% {
    box-shadow: 0 0 0 0px hsl(var(--accent) / 0);
  }
}
.node-attention {
  animation: attention-pulse 0.6s var(--ease-out) 1;
}
```

#### Pan

- **Mouse**: Click-drag on empty canvas area (default `@xyflow/react` behavior)
- **Trackpad**: Two-finger scroll
- **Keyboard**: Arrow keys pan by 50px increments
- **Momentum**: Not custom — uses browser default scroll physics

Pan is unrestricted (no bounds clamping) — users can scroll beyond the node bounding box.

#### Zoom

- **Mouse wheel**: Zoom in/out centered on cursor position
- **Trackpad**: Pinch-to-zoom
- **Keyboard**: `Cmd+/Cmd-` or `+`/`-` keys
- **Controls component**: Zoom in / zoom out buttons
- **Double-click on empty area**: Zoom in by 0.5 centered on click point
- **Min zoom**: 0.15 (very zoomed out — useful for 20+ agent projects)
- **Max zoom**: 1.5

All programmatic zoom uses `duration: 300` for smooth transition.

#### Mini-Map

Rendered in bottom-right corner via `<MiniMap>`:

```typescript
<MiniMap
  position="bottom-right"
  pannable={true}
  zoomable={true}
  maskColor="hsl(var(--background) / 0.7)"
  bgColor="hsl(var(--background-subtle))"
  nodeColor={(node) => {
    if (node.type === 'supervisor') return 'hsl(var(--accent))';
    if (node.data?.isEntry) return 'hsl(var(--success))';
    return 'hsl(var(--foreground-muted))';
  }}
  nodeBorderRadius={4}
  style={{ width: 160, height: 100, borderRadius: 'var(--radius-lg)', border: '1px solid hsl(var(--border-muted))' }}
/>
```

- Pannable: click-drag in mini-map to pan the main canvas
- Zoomable: scroll in mini-map to zoom
- Supervisor nodes colored accent (indigo), entry nodes green, others muted

### 2.6 Events

#### Node Events

| Event               | Handler                              | Behavior                                                                                           |
| ------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `onNodeClick`       | `handleNodeClick(event, node)`       | If agent node → initiate full-view transition (Section 2.9). If other node type → open side panel. |
| `onNodeDoubleClick` | `handleNodeDoubleClick(event, node)` | Center + zoom to 1.0 on the node with 400ms transition                                             |
| `onNodeMouseEnter`  | `handleNodeHover(event, node)`       | Highlight connected edges (increase opacity, thicken). Show connection count tooltip.              |
| `onNodeMouseLeave`  | `handleNodeLeave(event, node)`       | Reset edge highlighting                                                                            |
| `onNodeDragStop`    | `handleNodeDragStop(event, node)`    | Persist new position to Zustand store (debounced, saved to localStorage)                           |
| `onNodeContextMenu` | `handleNodeContextMenu(event, node)` | Show context menu: "View Details", "Edit in DSL Editor", "Set as Entry", "Remove"                  |

#### Edge Events

| Event              | Handler                        | Behavior                                                                                                          |
| ------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `onEdgeClick`      | `handleEdgeClick(event, edge)` | Open side panel showing: source agent, target agent, edge type, condition (if any), link to edit coordination DSL |
| `onEdgeMouseEnter` | `handleEdgeHover(event, edge)` | Thicken edge to 3px, highlight connected nodes with ring                                                          |
| `onEdgeMouseLeave` | `handleEdgeLeave(event, edge)` | Reset to default styling                                                                                          |

#### Viewport Events

| Event              | Handler                          | Behavior                                                                            |
| ------------------ | -------------------------------- | ----------------------------------------------------------------------------------- |
| `onViewportChange` | `handleViewportChange(viewport)` | Update Zustand with current `{ x, y, zoom }`. Used for zoom-level badge visibility. |
| `onMoveEnd`        | `handleMoveEnd(event, viewport)` | Persist viewport position (debounced, localStorage per project)                     |

#### Selection Events

| Event               | Handler                                   | Behavior                                                              |
| ------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `onSelectionChange` | `handleSelectionChange({ nodes, edges })` | Update selected state in store. Multi-select enabled via Shift+click. |

#### Keyboard Shortcuts

| Key                    | Action                                                          |
| ---------------------- | --------------------------------------------------------------- |
| `Escape`               | Deselect all, close side panel                                  |
| `f`                    | Fit all nodes in view                                           |
| `1`                    | Reset zoom to 1.0                                               |
| `0`                    | Fit view (same as `f`)                                          |
| `/`                    | Focus search input                                              |
| `Delete` / `Backspace` | Disabled (no deletion from canvas — must use DSL or UI actions) |

### 2.7 CSS Animations & Transitions

#### Node Entrance (Initial Load)

Nodes appear with a staggered fade-in-scale animation. Each node's delay is based on its ELK layer (level):

```css
@keyframes node-enter {
  0% {
    opacity: 0;
    transform: scale(0.85) translateY(12px);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.react-flow__node[data-entering='true'] {
  animation: node-enter var(--duration-slow) var(--ease-spring) both;
}

/* Stagger by rank level — computed inline via style prop */
/* Level 0: delay 0ms, Level 1: delay 80ms, Level 2: delay 160ms, etc. */
```

Implementation: After ELK layout, nodes are added with `data.entering = true` and `style.animationDelay = level * 80 + 'ms'`. After animation completes (listen to `animationend`), `entering` flag is removed.

#### Edge Entrance (After Nodes)

Edges draw in after nodes have landed. Uses SVG stroke-dasharray animation:

```css
@keyframes edge-draw {
  from {
    stroke-dashoffset: var(--edge-length);
  }
  to {
    stroke-dashoffset: 0;
  }
}

.react-flow__edge[data-entering='true'] path {
  stroke-dasharray: var(--edge-length);
  animation: edge-draw var(--duration-slower) var(--ease-out) both;
}
```

Edge length is computed from the SVG path and set as a CSS custom property via `style` prop.

Delay: Edges start drawing 200ms after the last node lands (total node stagger + 200ms).

#### Selection Transition

When a node is selected:

```css
.react-flow__node.selected {
  transition:
    border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-normal) var(--ease-spring);
  border-color: hsl(var(--accent));
  box-shadow: var(--shadow-glow);
}
```

#### Hover Transition

```css
.react-flow__node:hover {
  transition:
    transform var(--duration-normal) var(--ease-spring),
    box-shadow var(--duration-normal) var(--ease-out);
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}
```

#### Edge Hover Transition

```css
.react-flow__edge:hover path {
  transition:
    stroke-width var(--duration-fast) var(--ease-out),
    stroke-opacity var(--duration-fast) var(--ease-out);
  stroke-width: 3;
  stroke-opacity: 1;
}
```

#### Viewport Transitions

All programmatic viewport changes (fitView, setCenter, zoomTo) use:

- Duration: 300–500ms depending on distance
- Easing: Custom ease function matching `var(--ease-spring)`:
  ```typescript
  const easeSpring = (t: number) => 1 - Math.pow(1 - t, 3); // cubic ease-out approximation
  ```

### 2.8 Side Panel (Non-Agent Elements)

For edges, conditions, and any non-agent canvas element — a **side panel** slides in from the right.

**Trigger**: `onEdgeClick`, context menu on conditions, or clicking annotation elements.

**Panel dimensions**: 360px wide, full canvas height, overlays the canvas (doesn't push it).

**Entrance animation**:

```css
@keyframes panel-slide-in {
  from {
    opacity: 0;
    transform: translateX(24px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.side-panel-enter {
  animation: panel-slide-in var(--duration-slow) var(--ease-spring) both;
}
```

**Exit animation**: Reverse — `translateX(0) → translateX(24px)`, opacity `1 → 0`, duration `var(--duration-normal)`.

**Panel content for edge click**:

```
┌─────────────────────────────────┐
│  ✕  Edge Details                │  ← Close button + title
│  ───────────────────────────    │
│  Type: Handoff                  │  ← Edge type with colored badge
│  ───────────────────────────    │
│  From: Customer Support Supv.   │  ← Source agent (clickable link)
│  To:   Hotel Booking Agent      │  ← Target agent (clickable link)
│  ───────────────────────────    │
│  Condition:                     │
│  "When customer asks about      │  ← Condition text (if any)
│   hotel reservations"           │
│  ───────────────────────────    │
│  [Edit in DSL Editor]           │  ← Action button
└─────────────────────────────────┘
```

**Dismiss**: Click `✕`, press `Escape`, or click on empty canvas area.

When the side panel is open and the user clicks a different edge, the panel content cross-fades (opacity transition, no slide — it's already open).

### 2.9 Full View Transition (Agent Nodes)

When the user clicks an **agent node**, instead of opening a side panel, the canvas transitions into the **Agent Detail Canvas** (Layer 2). This is the key interaction that separates "glance at edge info" from "drill into agent internals."

**Transition sequence** (total ~600ms):

1. **Zoom to node** (0–300ms): `setCenter()` with duration 300ms, zooming to 1.0 centered on the clicked node.

2. **Node expand** (200–500ms): The clicked node visually expands while other nodes and edges fade out:

   ```css
   /* Other nodes fade out */
   @keyframes node-fade-out {
     to {
       opacity: 0;
       transform: scale(0.9);
     }
   }
   .react-flow__node:not(.transitioning-target) {
     animation: node-fade-out var(--duration-slow) var(--ease-out) both;
   }

   /* Edges fade out */
   .react-flow__edge {
     animation: node-fade-out var(--duration-normal) var(--ease-out) both;
   }

   /* Target node stays and grows */
   .react-flow__node.transitioning-target {
     transition: transform var(--duration-slow) var(--ease-spring);
     transform: scale(1.05);
     z-index: 100;
   }
   ```

3. **Canvas swap** (400–600ms): React state swaps from L1 to L2. The L2 canvas mounts with the agent detail nodes fading in:
   ```css
   @keyframes canvas-enter {
     from {
       opacity: 0;
     }
     to {
       opacity: 1;
     }
   }
   .agent-detail-canvas {
     animation: canvas-enter var(--duration-normal) var(--ease-out) both;
     animation-delay: 100ms;
   }
   ```

**Back navigation**: A breadcrumb / back button at the top. Clicking it reverses the transition — L2 fades out, L1 fades in with the previously clicked node centered.

**URL state**: The transition updates the URL hash to `#agent/{agentName}` so it's bookmarkable and browser-back works.

---

## 3. Layer 2 — Agent Detail Canvas

A separate `<ReactFlow>` instance that visualizes the internals of a single agent. The visualization differs based on the agent's execution mode.

### 3.1 Scripted Agent View

Scripted agents have a deterministic flow defined by FLOW steps with `then` transitions and optional branching.

**Visual representation**: A flowchart showing the step-by-step execution path.

```
  ┌─────────┐     ┌──────────┐     ┌──────────────┐     ┌────────────┐
  │  START   │────▶│  greet   │────▶│ gather_info  │────▶│  search    │
  │  (entry) │     │          │     │              │     │            │
  └─────────┘     └──────────┘     └──────────────┘     └────────────┘
                                     │  📋 gather     │     │  🔧 tool call
                                     │  - name        │     │  search_hotels
                                     │  - check_in    │     └──────┬─────┘
                                     │  - check_out   │            │
                                     └────────────────┘            ▼
                                                            ┌────────────┐
                                                     ┌──────│  branch    │──────┐
                                                     │      │            │      │
                                                     ▼      └────────────┘      ▼
                                              ┌────────────┐            ┌────────────┐
                                              │  confirm   │            │  no_results│
                                              │            │            │            │
                                              │  🔧 book   │            │  💬 respond│
                                              └────────────┘            └────────────┘
```

Each step node shows:

- Step name (header)
- Icons for what the step does: `💬` respond, `🔧` tool call, `📋` gather
- Tool name (if `call` is defined)
- Gather field names (if step has gather)
- Branch indicators (if `hasBranching`)

### 3.2 Reasoning Agent View

Reasoning agents don't have deterministic flows — they decide what to do based on their goal, tools, and constraints. The visualization shows their **capability map**.

```
                        ┌──────────────────────────┐
                        │       🎯  GOAL            │
                        │  "Help customers find     │
                        │   and book hotel rooms"   │
                        └────────────┬─────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
            ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
            │  🔧 TOOL      │ │  🔧 TOOL      │ │  🔧 TOOL      │
            │  search_hotels│ │  check_avail │ │  make_booking│
            │  HTTP GET     │ │  HTTP GET     │ │  HTTP POST   │
            └──────────────┘ └──────────────┘ └──────────────┘

                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
            ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
            │  🛡️ RULE       │ │  🛡️ RULE       │ │  ↗️ HANDOFF   │
            │  Must verify  │ │  Max 3        │ │  billing_agt │
            │  identity     │ │  retries      │ │  "payment"   │
            └──────────────┘ └──────────────┘ └──────────────┘
```

**Layout**: Goal node at top, then tool nodes in a row, then rule/coordination nodes below. ELK with `DOWN` direction handles this naturally by ranking: goal → tools → constraints → coordination.

### 3.3 ELK Layout (Agent Internals)

```typescript
const AGENT_LAYOUT_CONFIG: Record<string, ElkLayoutOptions> = {
  scripted: {
    'elk.direction': 'RIGHT', // Left-to-right for flow steps (like n8n)
    'elk.layered.spacing.nodeNodeBetweenLayers': '80', // 80px between step columns
    'elk.spacing.nodeNode': '40', // 40px between parallel branches
    'elk.padding': '[top=32,left=32,bottom=32,right=32]',
  },
  reasoning: {
    'elk.direction': 'DOWN', // Top-to-bottom for capability hierarchy
    'elk.layered.spacing.nodeNodeBetweenLayers': '60', // 60px between tiers (goal → tools → rules)
    'elk.spacing.nodeNode': '32', // 32px between sibling nodes
    'elk.padding': '[top=32,left=32,bottom=32,right=32]',
  },
};

const AGENT_NODE_DIMENSIONS = {
  start: { width: 80, height: 40 },
  step: { width: 200, height: 100 }, // Scripted flow step
  branch: { width: 100, height: 60 }, // Diamond-shaped decision
  goal: { width: 280, height: 80 }, // Reasoning goal
  tool: { width: 200, height: 72 }, // Tool capability
  rule: { width: 200, height: 60 }, // Constraint/guardrail
  handoff: { width: 180, height: 60 }, // Handoff target
  gather: { width: 200, height: 80 }, // Gather fields group
  respond: { width: 200, height: 60 }, // Response step
};
```

**Why LR for scripted**: Flow steps read naturally left-to-right, matching the mental model of sequential execution. Same direction as n8n. Branching forks vertically (up/down) which ELK handles via `elk.spacing.nodeNode`.

**Why TB for reasoning**: The goal sits at the top as the "north star", tools are the available actions below it, and constraints/handoffs are the boundaries at the bottom. This is a hierarchical capability map, not a sequential flow.

### 3.4 Node Types (Agent Internals)

#### StartNode

Small pill marking the entry point.

- Shape: Rounded pill, `80×40`
- Style: `bg-success text-success-foreground rounded-full font-medium text-sm`
- Content: "Start" with play icon
- Handle: Right side (source) for scripted, bottom for reasoning

#### StepNode (Scripted Only)

Represents a flow step.

```
╔════════════════════════════╗
║  greet_customer            ║  ← Step name
║  ──────────────────────    ║
║  💬 "Welcome! How can I   ║  ← Respond text (2-line clamp)
║      help you today?"     ║
║  ──────────────────────    ║
║  🔧 search_hotels          ║  ← Tool call (if any)
╚════════════════════════════╝
```

- Border: `1px solid hsl(var(--border))`
- Background: `hsl(var(--background-elevated))`
- Radius: `var(--radius-lg)`
- Width: 200px
- Handles: Left (target), Right (source) for main `then` flow
- Additional bottom handles if step has branches

**With gather indicator**: If the step gathers fields, a small badge appears:

```
┌─ 📋 3 fields ─┐  (attached to bottom of step node)
```

#### BranchNode (Scripted Only)

Diamond-shaped decision point for conditional routing.

- Shape: Rotated square (diamond) via CSS `transform: rotate(45deg)` on inner element
- Dimensions: 100×60 (before rotation)
- Background: `hsl(var(--warning-subtle))`
- Border: `1px solid hsl(var(--warning) / 0.3)`
- Content: Condition text or "?" if implicit
- Handles: Left (target), Top (branch A), Bottom (branch B) — labels on outgoing edges

#### GoalNode (Reasoning Only)

The central goal/purpose of the reasoning agent.

- Visually prominent: `bg-accent-subtle border-2 border-accent`
- Width: 280px
- Content: Target icon + "Goal" label + full goal text
- Radius: `var(--radius-xl)`
- Shadow: `var(--shadow-md)`
- Handle: Bottom (source, connects to tools/rules)

#### ToolNode (Both Modes)

Represents a tool binding.

```
╔════════════════════════════╗
║  🔧  search_hotels         ║  ← Wrench icon + tool name
║  ──────────────────────    ║
║  HTTP GET  │  /api/search  ║  ← Binding type + endpoint
╚════════════════════════════╝
```

- Background: `hsl(var(--background-muted))`
- Border: `1px solid hsl(var(--border-muted))`
- Width: 200px
- Handles: Top (target from goal/step), bottom (source to downstream if tool chains)

#### RuleNode (Reasoning Only)

Constraint or guardrail.

```
╔════════════════════════════╗
║  🛡️  Must verify identity   ║  ← Shield icon + rule text
║      before booking        ║
╚════════════════════════════╝
```

- Background: `hsl(var(--warning-subtle))`
- Border: `1px solid hsl(var(--warning) / 0.2)`
- Width: 200px

#### HandoffTargetNode (Both Modes)

Where this agent can hand off to.

```
╔════════════════════════════╗
║  ↗️  billing_agent          ║  ← Arrow icon + target name
║  "For payment issues"      ║  ← Condition text
╚════════════════════════════╝
```

- Background: `hsl(var(--info-subtle))`
- Border: `1px solid hsl(var(--info) / 0.2)`
- Clicking this node navigates back to L1 canvas and centers on the target agent

#### GatherGroupNode (Scripted Only)

A grouped sub-node attached to a step, showing gather fields.

```
╔════════════════════════════╗
║  📋  Gather Fields          ║
║  ──────────────────────    ║
║  • name (text, required)   ║
║  • check_in (date, req.)   ║
║  • check_out (date, req.)  ║
╚════════════════════════════╝
```

- Background: `hsl(var(--purple-subtle))`
- Border: `1px solid hsl(var(--purple) / 0.2)`
- Connected to its parent step via a short dashed edge

#### RespondNode (Scripted Only)

Terminal respond step.

- Background: `hsl(var(--success-subtle))`
- Content: Chat bubble icon + truncated response text
- No outgoing handles (terminal node)

### 3.5 Edge Types (Agent Internals)

#### FlowEdge (Scripted — `then` connections)

- Style: Solid, `2px`, color `hsl(var(--foreground-muted))`
- Path: `SmoothStepEdge` for horizontal flow
- Marker: Arrow at target

#### BranchEdge (Scripted — conditional branches)

- Style: Solid, `2px`, color `hsl(var(--warning))`
- Label: Condition text ("found", "not_found", "yes", "no")
- Path: `SmoothStepEdge`

#### CapabilityEdge (Reasoning — goal to tools/rules)

- Style: Dashed, `1.5px`, color `hsl(var(--border))`
- No label
- Path: `BezierEdge` (curved, organic feel)
- Represents "this agent CAN use this tool" — not a directional flow

#### GatherEdge (Scripted — step to gather group)

- Style: Dotted, `1px`, color `hsl(var(--purple) / 0.4)`
- Short, connects step node to its gather sub-node
- No arrow marker

### 3.6 Badges & Indicators (Agent Internals)

| Badge                   | Where             | Styling                                                       |
| ----------------------- | ----------------- | ------------------------------------------------------------- |
| **Entry step**          | StartNode         | Green pulse dot + "Entry" text                                |
| **HTTP / MCP / Lambda** | ToolNode          | `text-xs font-mono bg-background-muted px-1.5 py-0.5 rounded` |
| **Required**            | Gather field rows | Red dot `w-1.5 h-1.5 bg-error rounded-full`                   |
| **Branching**           | BranchNode        | Warning-colored diamond shape itself is the indicator         |
| **Gather count**        | StepNode badge    | `📋 N fields` pill at bottom edge                             |

### 3.7 Views — Zoom, Pan, Center, Fit

Same viewport controls as L1, but with different defaults:

| Behavior           | L2 Config                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| **Initial view**   | `fitView({ padding: 0.2, maxZoom: 1.2, duration: 400 })` after node entrance animation completes |
| **Min zoom**       | 0.3                                                                                              |
| **Max zoom**       | 2.0 (allows closer inspection of step details)                                                   |
| **Default zoom**   | Auto-fit — typically lands at 0.6–1.0 depending on agent complexity                              |
| **Center on step** | Search or breadcrumb click → `setCenter(stepNode, { zoom: 1.2, duration: 350 })`                 |

**Zoom-level detail visibility** (L2):

- Zoom ≥ 0.8: Full content — step text, tool endpoints, gather field names, response preview
- Zoom 0.5–0.8: Step names + icons only. Text truncated to single line.
- Zoom < 0.5: Step names as compact pills, edges only

### 3.8 Events (Agent Internals)

| Event                             | Handler              | Behavior                                                                                                  |
| --------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `onNodeClick` (StepNode)          | `handleStepClick`    | Open side panel (Section 3.10) with full step details — editable respond text, tool params, gather config |
| `onNodeClick` (ToolNode)          | `handleToolClick`    | Open side panel with tool details — binding type, endpoint, parameters, return type                       |
| `onNodeClick` (GoalNode)          | `handleGoalClick`    | Open side panel with goal + persona edit                                                                  |
| `onNodeClick` (HandoffTargetNode) | `handleHandoffClick` | Navigate back to L1, center on target agent                                                               |
| `onNodeClick` (RuleNode)          | `handleRuleClick`    | Open side panel with rule/constraint edit                                                                 |
| `onNodeClick` (GatherGroupNode)   | `handleGatherClick`  | Open side panel with gather field editor                                                                  |
| `onEdgeClick` (any)               | `handleEdgeClick`    | Open side panel with transition details (condition, next step)                                            |
| `onNodeDoubleClick` (any)         | —                    | Center + zoom to 1.2 on node                                                                              |

**No drag** in L2: Nodes are not draggable in the agent detail view — layout is auto-computed from the DSL structure. This keeps the view consistent and prevents drift from the actual agent definition.

### 3.9 CSS Animations & Transitions

#### Node Entrance (L2)

When the agent detail canvas mounts, nodes stagger in based on their execution order (for scripted) or tier (for reasoning):

```css
@keyframes step-enter {
  0% {
    opacity: 0;
    transform: translateX(-16px) scale(0.92);
  }
  100% {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
}

/* Scripted: nodes enter left-to-right following flow */
.agent-detail-canvas .react-flow__node[data-entering='true'] {
  animation: step-enter var(--duration-slow) var(--ease-spring) both;
}
```

```css
@keyframes tier-enter {
  0% {
    opacity: 0;
    transform: translateY(-12px) scale(0.92);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* Reasoning: nodes enter top-to-bottom by tier */
.agent-detail-canvas.reasoning .react-flow__node[data-entering='true'] {
  animation: tier-enter var(--duration-slow) var(--ease-spring) both;
}
```

Stagger delay: 60ms per node in execution order (scripted) or 50ms per node within a tier, 120ms between tiers (reasoning).

#### Edge Drawing (L2)

Same stroke-dashoffset animation as L1, but with shorter duration (`var(--duration-slow)` = 300ms) since edges are shorter.

#### Side Panel Transition (L2)

Same slide-in pattern as L1 side panel (Section 2.8).

#### Back-to-L1 Transition

1. L2 nodes fade out with a converge animation (all nodes move toward center + shrink):

   ```css
   @keyframes converge-out {
     to {
       opacity: 0;
       transform: scale(0.85);
     }
   }
   ```

   Duration: `var(--duration-normal)` (200ms).

2. L1 canvas fades in with the previously selected agent centered:

   ```css
   @keyframes canvas-fade-in {
     from {
       opacity: 0;
     }
     to {
       opacity: 1;
     }
   }
   ```

   Duration: `var(--duration-normal)` (200ms), starts after L2 fade completes.

3. L1 viewport restores previous zoom/pan state from Zustand store.

### 3.10 Side Panel (Step/Tool Detail)

In L2, clicking **any node** opens a side panel (not a full-view transition — that's only for L1 → L2 agent drill-down).

**Panel dimensions**: 400px wide (slightly wider than L1 panel — more content to show).

**Panel content varies by node type**:

**StepNode panel**:

```
┌─────────────────────────────────────┐
│  ✕  Step: greet_customer            │
│  ───────────────────────────────    │
│  [Response]                         │
│  ┌─────────────────────────────┐    │
│  │ Welcome! How can I help you │    │ ← Editable textarea
│  │ today?                      │    │
│  └─────────────────────────────┘    │
│  ───────────────────────────────    │
│  [Tool Call]                        │
│  search_hotels                      │
│  Binding: HTTP GET /api/search      │
│  ───────────────────────────────    │
│  [Next Step]                        │
│  → gather_info                      │ ← Clickable, centers on that node
│  ───────────────────────────────    │
│  [Branches]                         │
│  • "found" → confirm_booking        │
│  • "not_found" → no_results         │
│  ───────────────────────────────    │
│  [Gather Fields]                    │
│  • name (text, required)            │
│  • check_in (date, required)        │
│  ───────────────────────────────    │
│  [Open in DSL Editor]               │ ← Action button
└─────────────────────────────────────┘
```

**ToolNode panel**:

```
┌─────────────────────────────────────┐
│  ✕  Tool: search_hotels             │
│  ───────────────────────────────    │
│  Description:                       │
│  Search available hotels...         │
│  ───────────────────────────────    │
│  Binding: HTTP                      │
│  Method: GET                        │
│  Endpoint: /api/v1/hotels/search    │
│  ───────────────────────────────    │
│  Parameters:                        │
│  ┌────────┬────────┬──────────┐     │
│  │ Name   │ Type   │ Required │     │
│  ├────────┼────────┼──────────┤     │
│  │ city   │ string │ ✓        │     │
│  │ date   │ date   │ ✓        │     │
│  │ guests │ number │ ✗        │     │
│  └────────┴────────┴──────────┘     │
│  ───────────────────────────────    │
│  Return Type: object                │
│  ───────────────────────────────    │
│  [Edit Tool]                        │
└─────────────────────────────────────┘
```

**GoalNode panel**: Goal text (editable) + Persona text (editable) + Model selector + Temperature.

**RuleNode panel**: Constraint text (editable) + Type (constraint vs guardrail) + Enforcement level.

**Cross-node navigation in panel**: Clickable links in the panel (e.g., "→ gather_info" in the Next Step row) trigger `setCenter()` on the target node with a 350ms transition and open its panel.

---

## 4. Shared Infrastructure

### Canvas Store (Zustand)

```typescript
// SPLIT STORES: viewport (high-freq) | selection (medium) | canvas data (low-freq)
// Per Vercel rule `rerender-defer-reads`: Don't subscribe to state only used in callbacks.
// Per React Flow perf guide: Never access nodes[] directly — it changes on every pan/zoom frame.

// Store 1: Viewport — changes on EVERY pan/zoom frame (60fps during interaction)
interface ViewportStore {
  zoom: number;
  position: XYPosition;
  semanticZoomLevel: 'compact' | 'summary' | 'full'; // derived from zoom
  setViewport: (zoom: number, position: XYPosition) => void;
}
const useViewportStore = create<ViewportStore>((set) => ({
  zoom: 1,
  position: { x: 0, y: 0 },
  semanticZoomLevel: 'full',
  setViewport: (zoom, position) =>
    set({
      zoom,
      position,
      // Derive semantic level (Vercel rule `rerender-derived-state`)
      semanticZoomLevel: zoom < 0.35 ? 'compact' : zoom < 0.65 ? 'summary' : 'full',
    }),
}));

// Store 2: Selection — changes on click (low-medium frequency)
interface SelectionStore {
  selectedNodeIds: Set<string>; // Set for O(1) lookup (Vercel rule `js-set-map-lookups`)
  selectedEdgeIds: Set<string>;
  hoveredNodeId: string | null;
  sidePanelContent: SidePanelContent | null;
  selectNode: (id: string) => void;
  selectEdge: (id: string) => void;
  setHovered: (id: string | null) => void;
  openSidePanel: (content: SidePanelContent) => void;
  closeSidePanel: () => void;
}

// Store 3: Canvas Data — changes on topology fetch or layout recalculation
interface CanvasDataStore {
  layer: 'project' | 'agent';
  selectedAgentId: string | null;
  nodeMap: Map<string, CanvasNode>; // Map for O(1) lookup (not array)
  edgeMap: Map<string, CanvasEdge>;
  layout: ElkLayoutResult | null;
  performanceTier: 'standard' | 'optimized' | 'scaled' | 'heavy';

  // Persistence (per project)
  projectViewport: Record<string, Viewport>;
  nodePositions: Record<string, Record<string, XYPosition>>;

  // Actions
  setLayer: (layer: 'project' | 'agent') => void;
  drillIntoAgent: (agentId: string) => void;
  backToProject: () => void;
  setLayout: (layout: ElkLayoutResult) => void;
  persistNodePosition: (projectId: string, nodeId: string, position: XYPosition) => void;
  persistViewport: (projectId: string, viewport: Viewport) => void;
  resetLayout: (projectId: string) => void;
}
```

Persisted to `localStorage` via Zustand `persist` middleware (consistent with existing store patterns).

### ELK Layout Engine (Web Worker)

Layout computation runs in a **Web Worker** to avoid blocking the main thread (critical for 30+ agent graphs).

```typescript
// workers/elk-layout.worker.ts
import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

self.onmessage = async (event) => {
  const { graph, options } = event.data;
  try {
    const result = await elk.layout(graph, { layoutOptions: options });
    self.postMessage({ type: 'success', layout: result });
  } catch (error) {
    self.postMessage({ type: 'error', error: String(error) });
  }
};
```

```typescript
// hooks/useAutoLayout.ts — shared hook used by both L1 and L2
function useAutoLayout(
  nodes: Node[],
  edges: Edge[],
  options: ElkLayoutOptions,
): { layoutedNodes: Node[]; layoutedEdges: Edge[]; isComputing: boolean } {
  const [layout, setLayout] = useState<ElkLayoutResult | null>(null);
  const [isComputing, setIsComputing] = useState(false);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    workerRef.current = new Worker(new URL('../workers/elk-layout.worker.ts', import.meta.url));
    return () => workerRef.current?.terminate();
  }, []);

  useEffect(() => {
    if (!workerRef.current || nodes.length === 0) return;
    setIsComputing(true);

    const graph = nodesToElkGraph(nodes, edges);
    workerRef.current.postMessage({ graph, options });

    workerRef.current.onmessage = (e) => {
      if (e.data.type === 'success') {
        // Non-urgent update — use startTransition (Vercel rule `rerender-transitions`)
        startTransition(() => {
          setLayout(e.data.layout);
          setIsComputing(false);
        });
      }
    };
  }, [nodes, edges, options]);

  const layoutedNodes = useMemo(
    () => (layout ? applyElkPositions(nodes, layout) : nodes),
    [nodes, layout],
  );

  return { layoutedNodes, layoutedEdges: edges, isComputing };
}
```

Layout is fully async and non-blocking. The `startTransition` wrapper ensures layout application doesn't interrupt active user interactions (dragging, typing).

### Custom Node/Edge Registration

```typescript
// L1 node types
const projectNodeTypes: NodeTypes = {
  supervisor: SupervisorNode,
  agent: AgentNode,
};

// L1 edge types
const projectEdgeTypes: EdgeTypes = {
  handoff: HandoffEdge,
  delegate: DelegateEdge,
  escalate: EscalateEdge,
};

// L2 node types
const agentNodeTypes: NodeTypes = {
  start: StartNode,
  step: StepNode,
  branch: BranchNode,
  goal: GoalNode,
  tool: ToolNode,
  rule: RuleNode,
  handoff: HandoffTargetNode,
  gather: GatherGroupNode,
  respond: RespondNode,
};

// L2 edge types
const agentEdgeTypes: EdgeTypes = {
  flow: FlowEdge,
  branch: BranchEdge,
  capability: CapabilityEdge,
  gather: GatherEdge,
};
```

These are defined **outside** of components (static objects) as required by `@xyflow/react` — never create `nodeTypes`/`edgeTypes` inside render.

### React Flow UI Components (shadcn CLI)

All custom nodes are composed on top of React Flow UI's **BaseNode** component rather than built from scratch. This provides consistent styling, built-in accessibility (keyboard nav, ARIA), and alignment with shadcn/ui.

**Installation** (one-time setup):

```bash
npx shadcn@latest add https://ui.reactflow.dev/base-node
npx shadcn@latest add https://ui.reactflow.dev/status-indicator
npx shadcn@latest add https://ui.reactflow.dev/labeled-group-node
npx shadcn@latest add https://ui.reactflow.dev/node-search
npx shadcn@latest add https://ui.reactflow.dev/zoom-slider
npx shadcn@latest add https://ui.reactflow.dev/edge-with-button
npx shadcn@latest add https://ui.reactflow.dev/devtools
```

**Composition pattern** (all node types follow this):

```tsx
import {
  BaseNode,
  BaseNodeHeader,
  BaseNodeHeaderTitle,
  BaseNodeContent,
  BaseNodeFooter,
} from '@/components/ui/base-node';
import { StatusIndicator } from '@/components/ui/status-indicator';

const AgentNode = React.memo(({ data }: NodeProps<AgentNodeData>) => {
  const semanticLevel = useViewportStore((s) => s.semanticZoomLevel);

  if (semanticLevel === 'compact') return <CompactPill data={data} />;

  return (
    <BaseNode>
      <BaseNodeHeader>
        <StatusIndicator status={data.mode === 'scripted' ? 'info' : 'success'} />
        <BaseNodeHeaderTitle>{data.name}</BaseNodeHeaderTitle>
      </BaseNodeHeader>
      {semanticLevel === 'full' && (
        <BaseNodeContent>
          <p className="text-xs text-foreground-muted line-clamp-3">{data.goal}</p>
        </BaseNodeContent>
      )}
      <BaseNodeFooter>
        <Badge variant="outline">{data.toolCount} tools</Badge>
        <Badge variant="outline">{data.mode}</Badge>
      </BaseNodeFooter>
      <Handle type="source" position={Position.Bottom} />
      <Handle type="target" position={Position.Top} />
    </BaseNode>
  );
});
```

**Built-in controls** replacing custom implementations:

| Need                | React Flow UI Component | Replaces                             |
| ------------------- | ----------------------- | ------------------------------------ |
| Node search overlay | `<NodeSearch />`        | Custom search overlay (Section 10.4) |
| Zoom control        | `<ZoomSlider />`        | Custom zoom buttons                  |
| Group containers    | `<LabeledGroupNode />`  | Custom supervisor group node         |
| Debug inspector     | `<DevTools />`          | Manual console debugging             |
| Edge actions        | `<EdgeWithButton />`    | Custom edge click handlers           |

**Dark mode**: React Flow v12 provides `colorMode="system"` prop that syncs with our `data-theme` attribute. No custom theme wiring needed — the `<ReactFlow colorMode={theme}>` prop handles it.

---

## 5. Data Flow

### L1 — Project Canvas

**Server Component data fetch** (Vercel rule `async-suspense-boundaries`):

```tsx
// app/projects/[id]/agents/page.tsx — SERVER COMPONENT
// Data fetched on server, no client waterfall
import { Suspense } from 'react';
import dynamic from 'next/dynamic';

// Code-split the canvas (~150KB) — Vercel rule `bundle-dynamic-imports`
const ProjectCanvas = dynamic(() => import('@/components/canvas/ProjectCanvas'), {
  ssr: false,
  loading: () => <CanvasSkeleton />,
});

export default async function AgentsPage({ params }: { params: { id: string } }) {
  // Fetch topology data on the server — arrives pre-fetched for the client
  const topologyPromise = fetchTopology(params.id);

  return (
    <Suspense fallback={<CanvasSkeleton />}>
      <ProjectCanvas topologyPromise={topologyPromise} />
    </Suspense>
  );
}
```

**Client-side pipeline** (inside `ProjectCanvas`):

```
topologyPromise (pre-fetched on server, streamed to client via Suspense)
  → { topology: { nodes, edges }, agentSummaries, errors }

                              ↓

Transform: topologyToReactFlowNodes(topology, summaries)
  → maps TopologyNode → ReactFlow Node (with type, data, position placeholder)
  → maps TopologyEdge → ReactFlow Edge (with type, data)
  → uses Map<string, Node> for O(1) lookups (Vercel rule `js-set-map-lookups`)

                              ↓

Layout: useAutoLayout(nodes, edges, PROJECT_LAYOUT_CONFIG)
  → ELK.js runs in Web Worker (non-blocking)
  → startTransition wraps layout result application (non-urgent)
  → merges with persisted positions (if user has previously dragged)

                              ↓

Render: <ReactFlow
           nodes={layoutedNodes}
           edges={layoutedEdges}
           nodeTypes={projectNodeTypes}
           colorMode={theme}
           onlyRenderVisibleElements={nodes.length > 10}
         />

                              ↓

Fallback: if topology API fails or has gaps,
  → buildClientTopology(agents) extracts from raw DSL (existing pattern)
  → merge server + client summaries (existing pattern)
```

### L2 — Agent Detail Canvas

```
Source: agent IR (already loaded by useAgentIR hook on L1)
  → AgentIR contains: execution.mode, flow.steps, tools, constraints, coordination

                              ↓

Transform: agentIRToReactFlowNodes(agentIR)
  → if mode === 'scripted':
      - StartNode for entry point
      - StepNode for each flow step (composed on BaseNode)
      - BranchNode for steps with conditional transitions
      - GatherGroupNode for steps with gather fields (LabeledGroupNode)
      - ToolNode for tool calls referenced in steps
      - RespondNode for terminal respond steps
      - Edges: flow (then), branch (conditions), gather (step→gather)
  → if mode === 'reasoning':
      - GoalNode from agentIR.identity.goal
      - ToolNode for each tool (auto-grouped via LabeledGroupNode when > 6)
      - RuleNode for each constraint/guardrail
      - HandoffTargetNode for each handoff target
      - Edges: capability (goal→tools, goal→rules)

                              ↓

Layout: useAutoLayout(nodes, edges, AGENT_LAYOUT_CONFIG[mode])
  → ELK.js in Web Worker (same hook as L1, different config)
  → ELK natively handles: subflows, back-edges, port ordering
  → no position persistence for L2 (layout always auto-computed)

                              ↓

Render: <ReactFlow
           nodes={layoutedNodes}
           edges={layoutedEdges}
           nodeTypes={agentNodeTypes}
           colorMode={theme}
         />
```

---

## 6. Responsive Behavior

| Breakpoint               | Canvas Behavior                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **≥ 1280px** (desktop)   | Full canvas with side panel overlay (panel doesn't push canvas)                                                                                   |
| **1024–1279px** (laptop) | Canvas shrinks when side panel opens (panel pushes canvas left by 360px). Mini-map hidden.                                                        |
| **768–1023px** (tablet)  | Side panel becomes a bottom sheet (slides up from bottom, 50% height). Mini-map hidden. Controls reduced to zoom buttons only.                    |
| **< 768px** (mobile)     | Canvas in view-only mode (pan/zoom only). No side panel — node click navigates to full-page detail. Simplified node rendering (name + mode only). |

Responsive behavior is handled at the layout level — canvas components themselves are size-agnostic.

---

## 7. Accessibility

| Concern                 | Implementation                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keyboard navigation** | Arrow keys to move between nodes (using `@xyflow/react` built-in keyboard navigation). Tab to move focus between nodes. Enter to "click" the focused node.                                                |
| **Screen reader**       | Each node has `aria-label` with full description: "Supervisor agent: Customer Support, Reasoning mode, 3 routes, Entry point". Edges have `aria-label`: "Handoff from Customer Support to Hotel Booking". |
| **Focus visible**       | Focused node gets `focus-ring` styling (2px accent border + 4px box-shadow).                                                                                                                              |
| **Reduced motion**      | Respect `prefers-reduced-motion`: disable stagger animations, edge drawing, and viewport easing. Transitions become instant.                                                                              |
| **Color contrast**      | All badge text meets WCAG AA contrast ratios against their backgrounds. Edge colors supplemented by line style (solid/dashed/dotted) — never color alone.                                                 |
| **Panel accessibility** | Side panel has `role="complementary"`, focus trap when open, `aria-labelledby` pointing to panel title.                                                                                                   |

```css
@media (prefers-reduced-motion: reduce) {
  .react-flow__node[data-entering='true'],
  .react-flow__edge[data-entering='true'] path {
    animation: none !important;
  }

  .react-flow__node,
  .react-flow__edge path {
    transition-duration: 0ms !important;
  }
}
```

---

## 8. Migration from Current Topology

### What Gets Replaced

| Current Component                     | Replacement                       | Notes                                                |
| ------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| `AgentMiniTopology` (SVG)             | L1 Project Canvas                 | Full interactive canvas instead of static mini-map   |
| `TopologyCanvas` (SVG in DesignStage) | L1 Project Canvas (embedded mode) | Same canvas component, different container           |
| `FlowMiniGraph` (SVG)                 | L2 Scripted Agent View            | Full interactive flow instead of static linear graph |
| Agent card grid                       | Toggle-able alternative view      | Card grid remains as a view option, not removed      |

### What Gets Kept

- Agent card grid as an alternative "List View" toggle
- Client-side DSL fallback topology (`buildClientTopology()`) — still needed when server compilation fails
- Topology API response format — the data model is unchanged, only the rendering changes
- Agent detail accordion — accessible via side panel in L2 (not removed, repurposed)

### Incremental Rollout

1. **Phase 1**: L1 Project Canvas — replaces mini-topology, coexists with card grid as a toggle
2. **Phase 2**: L2 Agent Detail Canvas (Scripted) — flow visualization for scripted agents
3. **Phase 3**: L2 Agent Detail Canvas (Reasoning) — capability map for reasoning agents
4. **Phase 4**: Side panel editing — make panels editable (not just read-only), deprecate accordion view

Each phase is independently shippable and testable.

---

## 9. Agent Pattern Topologies (L1 Complexity)

The ABL platform supports diverse multi-agent patterns. Each produces a distinct graph shape on the L1 canvas. This section specifies how each pattern is laid out, styled, and handled at scale.

### 9.1 Pattern Catalog

#### Pattern A: Single Supervisor + Children (Star)

The most common pattern. One supervisor routes to N specialized agents.

```
                    ┌──────────────┐
                    │  Supervisor  │
                    │   (entry)    │
                    └──────┬───────┘
              ┌────────┬───┴───┬────────┐
              ▼        ▼       ▼        ▼
         ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
         │ Agent  │ │ Agent  │ │ Agent  │ │ Agent  │
         │   A    │ │   B    │ │   C    │ │   D    │
         └────────┘ └────────┘ └────────┘ └────────┘
```

**Layout**: ELK layered (DOWN direction) naturally handles this — supervisor at layer 0, all children at layer 1 spread horizontally. `elk.spacing.nodeNode: 80` prevents overlap.

**Real examples**: TravelDesk (1 supervisor + 8 children), BankNexus (1 + 3), Airlines (1 + 3).

**Edge types**: All `handoff` edges from supervisor. Each has a priority label (P1, P2, etc.).

#### Pattern B: Nested Supervisors (Hierarchical Tree)

Supervisors of supervisors. Tested and supported by the compiler.

```
                    ┌──────────────────┐
                    │ Travel Supervisor│
                    │     (entry)      │
                    └────────┬─────────┘
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
       ┌──────────────┐ ┌────────┐ ┌────────────┐
       │Hotel Superv. │ │ Flight │ │  Support   │
       │  (sub-supv)  │ │ Agent  │ │   Agent    │
       └──────┬───────┘ └────────┘ └────────────┘
         ┌────┴────┐
         ▼         ▼
    ┌────────┐ ┌────────┐
    │ Search │ │ Booking│
    │  Agent │ │  Agent │
    └────────┘ └────────┘
```

**Layout challenge**: ELK layered (DOWN) handles this naturally as a tree. The sub-supervisor occupies layer 1, its children occupy layer 2. No special handling needed.

**Visual distinction**: Sub-supervisors use `SupervisorNode` type (accent border, "SUPERVISOR" badge) at whatever depth they appear. The dashed group boundary around a supervisor is drawn as a React Flow group node (`type: 'group'`, `parentId` on children):

```typescript
// Group node wrapping a sub-supervisor and its children
{
  id: 'group-hotel-supervisor',
  type: 'group',
  position: { x: 0, y: 0 },  // ELK-computed
  style: {
    width: computedGroupWidth,
    height: computedGroupHeight,
    border: '2px dashed hsl(var(--accent) / 0.2)',
    borderRadius: 'var(--radius-xl)',
    background: 'hsl(var(--accent) / 0.03)',
    padding: 16,
  },
  data: { label: 'Hotel Domain' },
}
```

**Group sizing**: Computed after ELK layout — bounding box of the sub-supervisor + all its children + 16px padding on all sides.

**Nesting depth limit for visualization**: Groups render cleanly up to 3 levels deep. Beyond that, the innermost groups collapse into a single node with a "+N agents" indicator (see Section 10.3 — Collapse/Expand).

#### Pattern C: Return Handoffs (Bidirectional)

Agent A hands off to Agent B with `RETURN: true`. After B completes, control returns to A. This creates a logical bidirectional flow.

```
         ┌──────────────┐
         │  Supervisor  │
         └──────┬───────┘
                │ handoff (RETURN: true)
                ▼
         ┌──────────────┐
         │    Auth       │───── handoff (RETURN: true) ────▶ ┌────────────┐
         │   Agent       │◀── return flow ────────────────── │  Booking   │
         └──────────────┘                                    │   Agent    │
                                                             └────────────┘
```

**Edge rendering for return handoffs**:

A return handoff renders as **two parallel edges** between the same node pair:

1. **Forward edge**: Standard `HandoffEdge` (solid, accent, arrow at target)
2. **Return edge**: New `ReturnEdge` type — dashed, lighter color `hsl(var(--accent) / 0.4)`, arrow pointing back at source, offset by 20px perpendicular to the forward edge

```typescript
// ReturnEdge — new edge type for L1
const projectEdgeTypes: EdgeTypes = {
  handoff: HandoffEdge,
  'handoff-return': ReturnHandoffEdge, // NEW
  delegate: DelegateEdge,
  escalate: EscalateEdge,
};
```

**ReturnHandoffEdge rendering**:

```typescript
function ReturnHandoffEdge({ sourceX, sourceY, targetX, targetY, ...props }: EdgeProps) {
  // Offset perpendicular to edge direction by 20px
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.sqrt(dx * dx + dy * dy);
  const nx = -dy / len * 20;  // Normal vector * offset
  const ny = dx / len * 20;

  // Forward edge (solid, normal position)
  const forwardPath = getSmoothStepPath({ sourceX, sourceY, targetX, targetY });

  // Return edge (offset, dashed, reversed arrow)
  const returnPath = getSmoothStepPath({
    sourceX: targetX + nx, sourceY: targetY + ny,
    targetX: sourceX + nx, targetY: sourceY + ny,
  });

  return (
    <>
      <BaseEdge path={forwardPath} style={{ stroke: 'hsl(var(--accent))', strokeWidth: 2 }}
                markerEnd={MarkerType.ArrowClosed} />
      <BaseEdge path={returnPath}
                style={{
                  stroke: 'hsl(var(--accent) / 0.4)',
                  strokeWidth: 1.5,
                  strokeDasharray: '6,3',
                }}
                markerEnd={MarkerType.Arrow} />
    </>
  );
}
```

**Label**: The forward edge shows "handoff" + condition. The return edge shows a small "return" label with the `on_return` action.

**Side panel for return handoffs**: Shows both directions — the forward handoff config (condition, context.pass, history strategy) AND the return config (on_return action, timeout, mapping).

#### Pattern D: Delegate Chains (Synchronous Sub-Calls)

An agent delegates to another agent, waits for the result, and continues. Unlike handoffs, delegates are synchronous function calls.

```
         ┌──────────────┐
         │   Booking    │
         │   Agent      │
         └──────┬───────┘
                │ delegate (synchronous)
                ▼
         ┌──────────────┐
         │    Price     │
         │  Calculator  │
         └──────────────┘
```

**Edge styling**: `DelegateEdge` — dashed, muted color, flowing dash animation. The "synchronous call" nature is communicated by a small "sync" badge on the edge label:

```
─ ─ ─ ▷ [delegate · sync] ─ ─ ─ ▷
```

**Mixed handoff + delegate from same agent**: When an agent has both handoffs AND delegates (e.g., Authentication Agent hands off to Booking Manager but delegates to OTP Verifier), both edge types render from the same source node. ELK places delegate targets in the same layer as the source (since control returns), while handoff targets go to a lower layer.

#### Pattern E: Mesh / Peer-to-Peer (No Central Supervisor)

Agents hand off to each other without a central supervisor. Any agent can initiate.

```
         ┌────────────┐          ┌────────────┐
         │   Agent A   │◀────────│   Agent B   │
         │   (entry)   │────────▶│             │
         └──────┬──────┘         └──────┬──────┘
                │                       │
                │     ┌────────────┐    │
                └────▶│   Agent C   │◀──┘
                      │             │
                      └─────────────┘
```

**Layout challenge**: No clear hierarchy. ELK layered (DOWN) still works — it assigns layers based on the longest path from the entry node. But the graph may look "flat" with many nodes in the same layer.

**Solution**: For mesh patterns (detected when >50% of agents have bidirectional edges), switch to a modified layout:

- `'elk.direction': 'RIGHT'` (left-to-right) — entry on left, peers spread right
- Increase `'elk.spacing.nodeNode': '100'` to prevent visual crowding
- Bidirectional edges use the offset rendering from Pattern C

**Detection heuristic**:

```typescript
function detectTopologyPattern(
  nodes: TopologyNode[],
  edges: TopologyEdge[],
): 'tree' | 'mesh' | 'chain' {
  const supervisorCount = nodes.filter((n) => n.type === 'supervisor').length;
  const bidirectionalPairs = countBidirectionalPairs(edges);
  const totalEdges = edges.length;

  if (supervisorCount > 0) return 'tree';
  if (bidirectionalPairs / totalEdges > 0.3) return 'mesh';
  return 'chain';
}
```

#### Pattern F: Linear Chain (Pipeline)

Agents hand off in sequence, each doing one phase. No supervisor, no branching.

```
  ┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐
  │ Intake │───▶│ Verify │───▶│ Process│───▶│Complete│
  │(entry) │    │        │    │        │    │        │
  └────────┘    └────────┘    └────────┘    └────────┘
```

**Layout**: `'elk.direction': 'RIGHT'` forced for chain patterns (all agents have exactly 1 incoming and 1 outgoing edge, no cycles). Each agent gets its own layer.

#### Pattern G: Fan-Out (Parallel Dispatch)

Supervisor sends to multiple agents simultaneously via `__fan_out__`.

```
                    ┌──────────────┐
                    │  Supervisor  │
                    │   (entry)    │
                    └──────┬───────┘
                           │ fan-out
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐   ┌────────┐   ┌────────┐
         │Flight  │   │ Hotel  │   │  Car   │
         │Search  │   │Search  │   │ Rental │
         └────────┘   └────────┘   └────────┘
```

**New edge type**: `FanOutEdge` — similar to HandoffEdge but with a special "parallel" visual:

- Triple-line stroke effect (3 parallel thin lines instead of 1 thick line)
- Color: `hsl(var(--purple))` (AI/LLM color — fan-out is an LLM-decided routing)
- Label: "fan-out" with a split icon

```css
.edge-fan-out path {
  stroke: hsl(var(--purple));
  stroke-width: 2;
  /* Double parallel lines via filter */
  filter: url(#parallel-lines-filter);
}
```

**Updated edge types**:

```typescript
const projectEdgeTypes: EdgeTypes = {
  handoff: HandoffEdge,
  'handoff-return': ReturnHandoffEdge,
  delegate: DelegateEdge,
  escalate: EscalateEdge,
  'fan-out': FanOutEdge, // NEW
};
```

#### Pattern H: Escalation Paths (Human Exit)

Agents escalate to human queues. Escalation is not a transfer to another AI agent.

```
         ┌──────────────┐
         │   Booking    │
         │   Agent      │
         └──────┬───────┘
                │ escalate
                ▼
         ╔══════════════╗
         ║  Human Queue ║  ← Not an AI agent — special node type
         ║  "Billing"   ║
         ╚══════════════╝
```

**New node type**: `EscalationTargetNode` — represents the human queue exit point.

```
╔══════════════════════════════╗
║  👤  Human: Billing Queue    ║
║  ──────────────────────────  ║
║  Priority: high              ║
║  Skills: billing, refunds    ║
╚══════════════════════════════╝
```

- Background: `hsl(var(--warning-subtle))`
- Border: `2px solid hsl(var(--warning))`
- Double-border effect (inset shadow) to distinguish from AI agents
- Icon: Person icon instead of robot/sparkles/network
- Position: ELK places these at the bottom layer (they have no outgoing edges)

**Updated L1 node types**:

```typescript
const projectNodeTypes: NodeTypes = {
  supervisor: SupervisorNode,
  agent: AgentNode,
  'escalation-target': EscalationTargetNode, // NEW
  'remote-agent': RemoteAgentNode, // NEW (see below)
};
```

#### Pattern I: Remote Agents (Cross-Service A2A)

Agents with `LOCATION: remote` live in a different service. They appear on the canvas but are visually distinct.

```
╔═══════════════════════════════╗
║  🌐  External Payment Agent   ║  ← Globe icon
║  ──────────────────────────── ║
║  Remote (A2A)                 ║
║  endpoint: pay.example.com    ║
╚═══════════════════════════════╝
```

- Border: `2px dashed hsl(var(--info))`
- Background: `hsl(var(--info-subtle))`
- Badge: "Remote" + protocol badge (A2A / REST)
- Reduced detail: No tools count, no model (unknown — remote)
- Click behavior: Side panel shows remote config (endpoint, protocol, auth), not full-view transition (no IR to inspect)

#### Pattern J: Mixed Coordination (Handoff + Delegate + Escalate + Fan-Out)

Real-world projects combine all patterns. The TravelDesk example has handoffs (P1-P7), return handoffs (P4-P6), escalation triggers, and error-handler-triggered handoffs.

```
                          ┌──────────────────┐
                          │   Supervisor      │
                          │     (entry)       │
                          └────────┬──────────┘
         ┌──────────┬──────┬───────┼───────┬──────────┬──────────┐
         ▼          ▼      ▼       ▼       ▼          ▼          ▼
    ┌─────────┐ ┌──────┐ ┌─────┐ ┌─────┐ ┌────────┐ ┌────────┐ ┌────────┐
    │Welcome  │ │ Auth │ │Sales│ │Book-│ │Payment │ │Farewell│ │Fallback│
    │  Agent  │ │Agent │ │Agent│ │ ing │ │ Agent  │ │ Agent  │ │ Agent  │
    └─────────┘ └──┬───┘ └─────┘ └──┬──┘ └────────┘ └────────┘ └────────┘
                   │ return          │ delegate
                   ▼                 ▼
              ┌────────┐       ┌──────────┐
              │Booking │       │   Fee    │
              │Manager │       │Calculator│
              └────────┘       └──────────┘
                   │ escalate
                   ▼
              ╔══════════╗
              ║  Human   ║
              ║  Queue   ║
              ╚══════════╝
```

**Edge coloring at scale**: When many edge types converge on the canvas, the color coding must remain distinguishable:

| Edge Type        | Color                       | Line Style          | Arrow        | Mnemonic                   |
| ---------------- | --------------------------- | ------------------- | ------------ | -------------------------- |
| Handoff          | `--accent` (indigo)         | Solid               | Closed arrow | Solid = permanent transfer |
| Handoff (return) | `--accent` + `--accent/0.4` | Solid + dashed pair | Both arrows  | Paired = round trip        |
| Delegate         | `--foreground-muted`        | Dashed, animated    | Open arrow   | Dashed = temporary         |
| Escalate         | `--warning` (amber)         | Dotted              | Diamond      | Dotted = exit system       |
| Fan-out          | `--purple`                  | Solid, triple-line  | Closed arrow | Purple = LLM-decided       |

### 9.2 Edge Overlap Resolution

When multiple edges connect between the same pair of agents (e.g., handoff + delegate between A and B), or when edges cross other nodes:

#### Same-Pair Multi-Edges

Use **handle multiplexing** — each edge connects to a different handle position on the node:

```typescript
// Generate handles dynamically based on outgoing edge count
function computeHandlePositions(edges: Edge[], nodeId: string): HandleConfig[] {
  const outgoing = edges.filter((e) => e.source === nodeId);
  const incoming = edges.filter((e) => e.target === nodeId);

  // Distribute source handles evenly along bottom edge
  return outgoing.map((edge, i) => ({
    id: `source-${edge.id}`,
    type: 'source' as const,
    position: Position.Bottom,
    style: { left: `${((i + 1) / (outgoing.length + 1)) * 100}%` },
  }));
}
```

This spreads multiple outgoing edges across the bottom of the source node, preventing overlap.

#### Cross-Node Edge Routing

When edges must cross other nodes (unavoidable in mesh patterns), ELK.js handles this natively:

**Strategy 1: ELK orthogonal edge routing** (default)

```typescript
const meshLayoutConfig: ElkLayoutOptions = {
  ...PROJECT_LAYOUT_CONFIG,
  'elk.edgeRouting': 'ORTHOGONAL', // Clean right-angle paths that route around nodes
  'elk.layered.spacing.edgeEdgeBetweenLayers': '30', // Edge separation between parallel edges
  'elk.layered.spacing.nodeNodeBetweenLayers': '140', // More vertical space
};
```

ELK's orthogonal router automatically routes edges around nodes — no manual offset hacks or A\* pathfinding libraries needed. Edge crossings are minimized by the `LAYER_SWEEP` crossing minimization strategy.

**Strategy 2: ELK spline routing** (for aesthetic-priority views)

```typescript
const aestheticLayoutConfig: ElkLayoutOptions = {
  ...PROJECT_LAYOUT_CONFIG,
  'elk.edgeRouting': 'SPLINES', // Smooth curved paths
  'elk.layered.edgeRouting.splines.mode': 'CONSERVATIVE', // Avoid overlapping nodes
};
```

Spline routing produces visually softer edges (like Bezier curves) while still routing around nodes. Use for smaller graphs (≤ 15 agents) where aesthetics matter more than density.

---

## 10. Large Graph Handling (30+ Agents)

Projects with 30+ agents require specific strategies to remain legible and performant.

### 10.1 Performance Tiers

| Agent Count | Tier          | Optimizations Applied                                                                                                                                                                                                        |
| ----------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–10        | **Standard**  | No optimizations. Full animations, all badges, full-detail nodes.                                                                                                                                                            |
| 11–30       | **Optimized** | `onlyRenderVisibleElements={true}`. Reduced entrance animation (stagger capped at 15 nodes, rest appear instantly).                                                                                                          |
| 31–80       | **Scaled**    | + Semantic zoom (3 detail levels). + ELK with `'elk.layered.layering.strategy': 'NETWORK_SIMPLEX'` (faster). + Node CSS simplified (no `box-shadow` on hover). + Edge animations disabled. + Collapse/expand groups enabled. |
| 81+         | **Heavy**     | + ELK layout in dedicated Web Worker (async, non-blocking). + Canvas renderer at zoom < 0.3. + Aggressive viewport culling. + Default to collapsed groups. + `content-visibility: auto` on off-screen nodes.                 |

Tier is determined on initial data load and sets a `canvasPerformanceTier` in the Zustand store.

### 10.2 Semantic Zoom (3 Detail Levels)

Nodes render differently based on zoom level. This is implemented inside the custom node component using the `useStore` hook for zoom detection:

```typescript
const zoomSelector = (s: ReactFlowState) => s.transform[2];

function AgentNode({ data }: NodeProps<AgentNodeData>) {
  const zoom = useStore(zoomSelector);

  if (zoom < 0.35) return <CompactPill data={data} />;
  if (zoom < 0.65) return <SummaryCard data={data} />;
  return <FullCard data={data} />;
}
```

#### Level 1: Compact Pill (zoom < 0.35)

Nodes collapse to small colored pills showing only the name:

```
┌──────────────────┐
│ Hotel Booking    │   (pill shape, 140×32)
└──────────────────┘
```

- Supervisors: accent-colored pill
- Regular agents: muted pill
- Entry: green left-border indicator
- No badges, no goal text, no metadata
- Edges simplified to thin lines (1px, reduced opacity)
- Edge labels hidden

#### Level 2: Summary Card (zoom 0.35–0.65)

Nodes show name + key badges only:

```
╔═══════════════════════════╗
║  Hotel Booking Agent      ║
║  Scripted  │  5 tools     ║
╚═══════════════════════════╝
```

- Name + mode badge + tool/step count
- No goal text, no model, no timestamps
- Edge labels visible
- Width reduced to 200px (from 260px)

#### Level 3: Full Card (zoom ≥ 0.65)

Full node rendering as specified in Section 2.2.

### 10.3 Collapse / Expand Groups

For large projects, groups of related agents can be collapsed into a single summary node.

**Automatic grouping heuristic**:

1. **Supervisor groups**: Each supervisor + its direct children form a collapsible group
2. **Domain groups**: Agents sharing the same `domain` field form a collapsible group
3. **Manual groups**: User can select multiple nodes and group them (stored in canvas store)

**Collapsed group node**:

```
╔═══════════════════════════════╗
║  📁  Hotel Domain              ║
║  ──────────────────────────── ║
║  4 agents (1 supervisor)      ║
║  ──────────────────────────── ║
║  ▸ Click to expand            ║
╚═══════════════════════════════╝
```

- Background: `hsl(var(--background-muted))`
- Border: `2px dashed hsl(var(--border))`
- Width: 240px
- Click: Expands the group (reveals child nodes with staggered entrance animation)
- Double-click: Drill into the supervisor's children (centers + zooms)

**Collapse behavior**:

- All internal edges (between group members) are hidden
- External edges (from/to nodes outside the group) are re-routed to the group node
- The group node inherits all external handles from its children

**Expand animation**:

```css
@keyframes group-expand {
  0% {
    opacity: 0;
    transform: scale(0.7);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

/* Children appear from the center of the group node */
.group-child-expanding {
  transform-origin: center;
  animation: group-expand var(--duration-slow) var(--ease-spring) both;
}
```

**Collapse animation**: Reverse — children shrink toward group center, then group summary node appears.

**Keyboard shortcut**: `g` while hovering a supervisor node toggles its group expand/collapse.

### 10.4 Search & Filter Overlay

For large graphs, visual scanning is insufficient. A search/filter system overlays the canvas:

**Search bar**: Floating at top-center, triggered by `/` key.

```
┌────────────────────────────────────────┐
│  🔍  Search agents...                  │
│  ──────────────────────────────────    │
│  ▸ Hotel Booking Agent (scripted)      │ ← Results highlight matching nodes
│  ▸ Hotel Search Agent (reasoning)      │
│  ▸ Hotel Supervisor (supervisor)       │
└────────────────────────────────────────┘
```

- Fuzzy search across: agent name, goal text, tool names, domain
- Selecting a result: `setCenter()` on that node + attention pulse
- Non-matching nodes dim to 20% opacity while search is active

**Filter chips**: Below the search bar, quick toggles:

```
[All] [Supervisors] [Reasoning] [Scripted] [Has Errors]
```

- Active filter dims non-matching nodes (opacity 0.2, pointer-events: none)
- Matching nodes remain fully interactive
- Edges between dimmed nodes also dim

**Implementation**: Filter state stored in Zustand. Node components read filter state and apply conditional CSS classes:

```css
.react-flow__node[data-dimmed='true'] {
  opacity: 0.15;
  pointer-events: none;
  transition: opacity var(--duration-normal) var(--ease-out);
}

.react-flow__edge[data-dimmed='true'] path {
  opacity: 0.08;
  transition: opacity var(--duration-normal) var(--ease-out);
}
```

### 10.5 Layout Strategies by Graph Size

| Agent Count | ELK Config Override                                                                                          | Additional                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 1–5         | Default config. `fitView` lands at zoom ~1.0                                                                 | —                                                |
| 6–15        | Default config. `fitView` lands at zoom ~0.6–0.8                                                             | —                                                |
| 16–30       | `nodeNodeBetweenLayers: 100`, `nodeNode: 60` (tighter). `fitView` lands at zoom ~0.4–0.6                     | Semantic zoom active                             |
| 31–60       | `nodeNodeBetweenLayers: 80`, `nodeNode: 50`. `layering.strategy: NETWORK_SIMPLEX`. Auto-group by supervisor. | Groups collapsed by default                      |
| 61+         | `nodeNodeBetweenLayers: 60`, `nodeNode: 40`. ELK in Web Worker.                                              | Groups collapsed. Compact pills at default zoom. |

**Dynamic spacing**: `elk.spacing.nodeNode` and `elk.layered.spacing.nodeNodeBetweenLayers` are computed based on agent count:

```typescript
function computeLayoutSpacing(nodeCount: number): Partial<ElkLayoutOptions> {
  if (nodeCount <= 15)
    return { 'elk.layered.spacing.nodeNodeBetweenLayers': '120', 'elk.spacing.nodeNode': '80' };
  if (nodeCount <= 30)
    return { 'elk.layered.spacing.nodeNodeBetweenLayers': '100', 'elk.spacing.nodeNode': '60' };
  if (nodeCount <= 60)
    return { 'elk.layered.spacing.nodeNodeBetweenLayers': '80', 'elk.spacing.nodeNode': '50' };
  return { 'elk.layered.spacing.nodeNodeBetweenLayers': '60', 'elk.spacing.nodeNode': '40' };
}
```

### 10.6 Viewport Culling & Rendering

`@xyflow/react` provides `onlyRenderVisibleElements` for viewport culling. Additional measures for 80+ node graphs:

**Simplified rendering at distance**: When a node is in the viewport but the zoom is below the compact-pill threshold (0.35), render a pure-CSS colored rectangle instead of a React component:

```typescript
// In node component
if (zoom < 0.2 && performanceTier === 'heavy') {
  // Return a minimal DOM element — no React children
  return (
    <div
      className="w-full h-full rounded-lg"
      style={{ background: nodeColor, border: '1px solid hsl(var(--border))' }}
    />
  );
}
```

**Edge simplification at distance**: Below zoom 0.3, replace `SmoothStepEdge` with `StraightEdge` (cheaper SVG path computation).

---

## 11. Complex Branching (L2 — Scripted Agent Detail)

Scripted agents can have far more complex flows than a simple linear chain. This section specifies handling for all branching constructs supported by ABL.

### 11.1 Branching Constructs in ABL

The flow step executor supports 4 distinct branching mechanisms. Each produces different graph shapes:

| Construct                      | Graph Shape                        | Fan-Out                 | Merge Point?                            |
| ------------------------------ | ---------------------------------- | ----------------------- | --------------------------------------- |
| `ON_INPUT` (N branches)        | 1 → N conditional targets          | Up to 8+ branches       | Yes, branches may reconverge            |
| `ON_SUCCESS` / `ON_FAILURE`    | 1 → 2 (success path, failure path) | Binary                  | Often merge at a shared downstream step |
| `ON_RESULT` (pattern matching) | 1 → N conditional targets          | Up to N result patterns | Yes                                     |
| `CHECK` (inline guard)         | 1 → 2 (pass, fail)                 | Binary                  | Yes                                     |

### 11.2 Multi-Way Branching (ON_INPUT with 8+ branches)

The `hotel_booking_advanced` example has a `confirm` step with 8 ON_INPUT branches pointing to 7 different targets. This is the hardest layout challenge.

**Visualization approach**: The branch point is extracted as an explicit `BranchNode` (diamond) with multiple outgoing edges:

```
                                    ┌─── "confirm" ──▶ [complete]
                                    │
                                    ├─── "back" ─────▶ [payment_method]
                                    │
          ┌────────────┐           ├─── "cancel" ───▶ [welcome]
          │  confirm   │───────▶  ◇
          │            │           ├─── "change dest" ▶ [get_destination]
          └────────────┘           │
                                    ├─── "change date" ▶ [get_dates]
                                    │
                                    ├─── "change hotel"▶ [select_hotel]
                                    │
                                    ├─── "change room" ▶ [select_room]
                                    │
                                    └─── else ────────▶ [confirm] (self)
```

**Diamond node with multiple handles**: The `BranchNode` gets dynamically generated handles based on its outgoing edge count:

```typescript
function BranchNode({ data }: NodeProps<BranchNodeData>) {
  const branchCount = data.branches.length;

  return (
    <div className="branch-diamond">
      <Handle type="target" position={Position.Left} id="input" />

      {/* Spread output handles across right side (for LR layout) */}
      {data.branches.map((branch, i) => (
        <Handle
          key={branch.id}
          type="source"
          position={Position.Right}
          id={`branch-${i}`}
          style={{
            top: `${((i + 1) / (branchCount + 1)) * 100}%`,
          }}
        />
      ))}

      <div className="branch-diamond-inner">
        <span className="text-xs font-medium">{data.conditionSummary || '?'}</span>
      </div>
    </div>
  );
}
```

**Layout with ELK**: For N branches, ELK's `elk.spacing.nodeNode` spreads target nodes vertically (in RIGHT layout). But with 8+ branches, the vertical spread becomes extreme.

**Solution for high fan-out (>4 branches)**:

1. **Compact branch rendering**: When a branch node has > 4 outgoing edges, switch from diamond → **table node**:

```
╔══════════════════════════════════════╗
║  ◇  confirm — Branching (8 paths)   ║
║  ─────────────────────────────────── ║
║  "confirm"       → [complete]        ║
║  "back"          → [payment_method]  ║
║  "cancel"        → [welcome]         ║
║  "change dest."  → [get_destination] ║
║  "change date"   → [get_dates]       ║
║  + 3 more...     [expand]            ║
╚══════════════════════════════════════╝
```

- Width: 320px (wider to accommodate the table)
- Background: `hsl(var(--warning-subtle))`
- Each target link is clickable (centers on target node + attention pulse)
- "Expand" shows all branches inline
- Edges from this node still connect to all targets, but the table provides the text reference

2. **Edge bundling for high fan-out**: When > 4 edges leave the branch node, use a **virtual gathering point** — a small invisible node 40px to the right of the branch, from which individual edges fan out. This produces a cleaner visual than 8 edges sprouting from one point:

```
  [confirm] ──▶ ◇ ──▶ (gather) ─┬──▶ [complete]
                                 ├──▶ [payment_method]
                                 ├──▶ [welcome]
                                 ├──▶ [get_destination]
                                 ├──▶ [get_dates]
                                 ├──▶ [select_hotel]
                                 ├──▶ [select_room]
                                 └──▶ [confirm] (self-loop)
```

The gather node is invisible (`opacity: 0, width: 1, height: 1`) — just a layout anchor for ELK.

### 11.3 Binary Branching (ON_SUCCESS / ON_FAILURE, CHECK)

The simpler case — a step either succeeds or fails, each path leads to a different next step.

```
          ┌────────────┐           success    ┌─────────────┐
          │   search   │───────▶ ◇ ────────▶  │  show_results│
          │            │           │           └─────────────┘
          └────────────┘           │ failure
                                   └────────▶  ┌─────────────┐
                                               │  no_results  │
                                               └─────────────┘
```

**Diamond node**: Small, 80×48, with exactly 2 outgoing edges labeled "success" (green) and "failure" (red/warning).

**CHECK guard**: Similar to ON_SUCCESS but the diamond shows the condition text:

```
          ┌────────────┐           ✓ pass     ┌─────────────┐
          │   verify   │───────▶ ◇ ────────▶  │  proceed     │
          │            │       "guests ≤ 10"  └─────────────┘
          └────────────┘           │ ✗ fail
                                   └────────▶  ┌─────────────┐
                                               │  too_many    │
                                               └─────────────┘
```

### 11.4 Merge Points (Fan-In)

When multiple branches converge to the same step, that step has multiple incoming edges. This is common:

- Both success and failure paths converge to a "retry" step
- All branches of `ON_INPUT` eventually reconverge to a later step
- Back-navigation (e.g., "change date" → `get_dates` → ... → `confirm`) creates long-range connections

**ELK handling**: ELK naturally handles fan-in — a node with multiple incoming edges is placed at the rank satisfying all incoming edges. No special treatment needed.

**Visual clarity for merge points**: Nodes with 3+ incoming edges get a subtle "merge" indicator — a small funnel icon at the top-left:

```css
.node-merge-indicator {
  position: absolute;
  top: -8px;
  left: -8px;
  width: 16px;
  height: 16px;
  background: hsl(var(--info-subtle));
  border: 1px solid hsl(var(--info) / 0.3);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: hsl(var(--info));
}
```

**Side panel for merge nodes**: Shows "Incoming from: step_a (then), step_b (on_success), step_c (on_input: 'back')" — helping the developer understand why this step has multiple entry points.

### 11.5 Cycles and Back-Edges (Loops in Flow)

ABL scripted flows explicitly support cycles:

- `email_code_verify → email_code_sent → email_code_verify` (retry loop)
- `select_hotel → search_and_show → select_hotel` (filter and re-show)
- `confirm → welcome` (cancel and restart)

**Cycle detection**: Before layout, detect back-edges via DFS:

```typescript
function partitionEdges(
  nodes: Node[],
  edges: Edge[],
  entryId: string,
): { forwardEdges: Edge[]; backEdges: Edge[] } {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const backEdgeIds = new Set<string>();
  const adj = new Map<string, Edge[]>();

  edges.forEach((e) => {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e);
  });

  function dfs(nodeId: string) {
    visited.add(nodeId);
    inStack.add(nodeId);
    for (const edge of adj.get(nodeId) || []) {
      if (inStack.has(edge.target)) {
        backEdgeIds.add(edge.id);
      } else if (!visited.has(edge.target)) {
        dfs(edge.target);
      }
    }
    inStack.delete(nodeId);
  }

  dfs(entryId);

  return {
    forwardEdges: edges.filter((e) => !backEdgeIds.has(e.id)),
    backEdges: edges.filter((e) => backEdgeIds.has(e.id)),
  };
}
```

**Layout**: Pass only `forwardEdges` to ELK for layout computation. Back-edges are rendered separately with a custom path.

**BackEdge rendering**: A new edge type that curves backward (right-to-left in LR layout, bottom-to-top in TB layout):

```typescript
function BackEdge({ sourceX, sourceY, targetX, targetY, ...props }: EdgeProps) {
  // Route: exit source to the right, curve up/down, enter target from left
  const loopOffset = 60;  // How far the loop extends beyond the rightmost point

  const path = [
    `M ${sourceX} ${sourceY}`,
    // Go right from source
    `C ${sourceX + loopOffset} ${sourceY},`,
    // Arc above/below the flow
    `  ${targetX - loopOffset} ${targetY},`,
    // Enter target from left
    `  ${targetX} ${targetY}`,
  ].join(' ');

  return (
    <BaseEdge
      path={path}
      style={{
        stroke: 'hsl(var(--warning))',
        strokeWidth: 1.5,
        strokeDasharray: '6,3',
      }}
      markerEnd={MarkerType.Arrow}
      {...props}
    />
  );
}
```

**Back-edge visual cues**:

- Dashed line (distinguishes from forward flow)
- Warning color (amber) — loops are noteworthy
- Small loop icon (`↺`) at the edge midpoint
- Edge label shows the condition that triggers the loop back

```css
@keyframes loop-pulse {
  0%,
  100% {
    stroke-opacity: 0.6;
  }
  50% {
    stroke-opacity: 1;
  }
}

.edge-back-edge path {
  animation: loop-pulse 2s var(--ease-in-out) infinite;
}
```

**Self-loops** (step → itself): Rendered as a small circular arc on the right side of the node:

```typescript
function SelfLoopEdge({ sourceX, sourceY }: EdgeProps) {
  const radius = 24;
  const path = `M ${sourceX} ${sourceY - 8}
                A ${radius} ${radius} 0 1 1 ${sourceX} ${sourceY + 8}`;

  return (
    <BaseEdge
      path={path}
      style={{ stroke: 'hsl(var(--warning))', strokeDasharray: '4,3' }}
      markerEnd={MarkerType.Arrow}
    />
  );
}
```

### 11.6 Digressions (Global Escape Routes)

ABL steps can have `digressions` — intent-based exits available from any step (e.g., "speak to human", "cancel").

**Rendering**: Digressions are NOT rendered as edges from every step (that would create N×M edges). Instead:

1. A **floating legend panel** at the top-right of the L2 canvas shows global digressions:

```
┌─────────────────────────────┐
│  Global Digressions          │
│  ─────────────────────────   │
│  🗣 "speak to human" → ESC.  │
│  ✕  "cancel" → [welcome]    │
└─────────────────────────────┘
```

2. Each step node shows a small `↗` icon if it has digressions. Clicking the icon opens the side panel with digression details.

3. When hovering the digression legend entry, ALL step nodes that support that digression get a subtle highlight ring.

### 11.7 Long-Range Edges (Jump Targets)

Some transitions jump many steps backward or forward (e.g., `confirm → get_destination` — skipping 4 intermediate steps). In LR layout, these create long horizontal edges that cross many nodes.

**Handling**:

1. **ELK's edge routing**: SmoothStepEdge paths route around intermediate nodes via bend points
2. **Edge curvature for long jumps**: When the source and target are more than 3 ranks apart, increase the edge curvature offset to route above or below the main flow:

```typescript
function computeEdgeCurvature(sourceRank: number, targetRank: number): number {
  const rankDistance = Math.abs(targetRank - sourceRank);
  if (rankDistance <= 2) return 0; // Standard routing
  if (rankDistance <= 4) return 40; // Mild curve offset
  return 60 + (rankDistance - 4) * 10; // Increasing curve for longer jumps
}
```

3. **Hover dimming**: When hovering a long-range edge, dim all other edges to 10% opacity so the long-range connection is clearly visible against the clutter.

---

## 12. Large Agent Detail Handling (L2 at Scale)

A scripted agent with 12+ steps and extensive branching (like the `hotel_booking_advanced` example) creates a dense L2 canvas.

### 12.1 Step Count Thresholds

| Step Count | L2 Strategy                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------- |
| 1–6        | Standard rendering. All nodes visible. `fitView` at zoom ~0.8–1.0                            |
| 7–12       | Standard rendering. `fitView` at zoom ~0.5–0.7. Semantic zoom active.                        |
| 13–20      | Collapsed sub-flows (optional). Back-edges rendered. Edge simplification at low zoom.        |
| 21+        | Mandatory sub-flow collapsing. Step groups auto-detected. Compact node rendering by default. |

### 12.2 Semantic Zoom for L2 Nodes

Same pattern as L1 but with different thresholds:

#### Level 1: Compact (zoom < 0.4)

```
┌────────────┐
│ greet      │   (pill, 120×28)
└────────────┘
```

Name only. No step content, no icons, no badges.

#### Level 2: Summary (zoom 0.4–0.75)

```
╔═══════════════════════╗
║  greet_customer       ║
║  💬 🔧 📋             ║  ← Icons only (respond, tool, gather)
╚═══════════════════════╝
```

Name + activity icons. No text content.

#### Level 3: Full (zoom ≥ 0.75)

Full rendering as specified in Section 3.4.

### 12.3 Sub-Flow Collapsing

For agents with 13+ steps, detect collapsible sub-flows:

**Detection heuristic**: A sub-flow is a contiguous sequence of 3+ steps where:

- Each step has exactly 1 incoming and 1 outgoing edge (no branching, no merge)
- The sequence forms a linear chain within the larger graph

**Collapsed sub-flow node**:

```
╔═════════════════════════════════╗
║  📁 Gathering Phase (4 steps)   ║
║  ───────────────────────────── ║
║  get_dest → get_dates →        ║
║  get_guests → search           ║
║  ▸ Click to expand             ║
╚═════════════════════════════════╝
```

- Clicking expands the sub-flow inline (child nodes appear between the previous and next step)
- Double-clicking zooms to the sub-flow and expands it

### 12.4 Reasoning Agent at Scale (Many Tools/Rules)

A reasoning agent with 15+ tools and 10+ constraints creates a wide/tall capability map.

**Strategy**: Group tools and rules by category:

```
                    ┌────────────────┐
                    │    🎯 GOAL      │
                    └────────┬───────┘
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────────┐ ┌─────────────┐ ┌────────────────┐
     │ 📁 Search Tools │ │ 📁 Booking  │ │ 📁 Payment    │
     │ (4 tools)       │ │ Tools (3)   │ │ Tools (2)     │
     │ ▸ expand        │ │ ▸ expand    │ │ ▸ expand      │
     └────────────────┘ └─────────────┘ └────────────────┘
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────────┐ ┌─────────────┐ ┌────────────────┐
     │ 🛡️ Auth Rules   │ │ 🛡️ Rate     │ │ ↗️ Handoffs    │
     │ (2 rules)       │ │ Limits (3)  │ │ (2 targets)   │
     └────────────────┘ └─────────────┘ └────────────────┘
```

**Auto-grouping for reasoning agents**:

- Tools grouped by shared prefix (e.g., `search_hotels`, `search_flights` → "Search Tools")
- If no prefix grouping, tools grouped by binding type (HTTP tools, MCP tools, Lambda tools)
- Rules grouped by type: constraints vs guardrails
- Handoff targets shown individually (rarely > 5)

**Collapse thresholds**:

- Tools: Collapsed if > 6 tools total
- Rules: Collapsed if > 5 rules total
- Individual groups: Collapsed if > 3 members

---

## 13. Edge Overlap & Crossing Resolution

### 13.1 Bidirectional Edge Pairs

When agents A and B both handoff to each other (possibly with different conditions), render as parallel offset edges:

**Implementation**: Detect bidirectional pairs during edge preprocessing:

```typescript
function preprocessEdges(edges: Edge[]): Edge[] {
  const pairMap = new Map<string, Edge[]>();

  edges.forEach((edge) => {
    const key = [edge.source, edge.target].sort().join('::');
    if (!pairMap.has(key)) pairMap.set(key, []);
    pairMap.get(key)!.push(edge);
  });

  return edges.map((edge) => {
    const key = [edge.source, edge.target].sort().join('::');
    const pair = pairMap.get(key)!;
    if (pair.length <= 1) return edge;

    // Offset this edge perpendicular to its direction
    const isFirst = pair[0].id === edge.id;
    return {
      ...edge,
      data: {
        ...edge.data,
        offset: isFirst ? -15 : 15, // pixels perpendicular
      },
    };
  });
}
```

The custom edge component reads `data.offset` and shifts its control point:

```typescript
function OffsetSmoothStepEdge(props: EdgeProps) {
  const offset = props.data?.offset || 0;
  const [path, labelX, labelY] = getSmoothStepPath({
    ...props,
    // Shift control points by offset
    sourceY: props.sourceY + offset,
    targetY: props.targetY + offset,
  });

  return <BaseEdge path={path} {...props} />;
}
```

### 13.2 Multi-Edge Between Same Pair

When an agent has BOTH a handoff AND a delegate to the same target (or multiple handoffs with different conditions), render as stacked edges with increasing offset:

```
Agent A ═══════════════▶ Agent B     (handoff, offset 0)
Agent A ─ ─ ─ ─ ─ ─ ─ ▷ Agent B     (delegate, offset +20)
Agent A ·····················▶ Agent B     (escalate, offset -20)
```

Offset increases by 20px per additional edge in the pair.

### 13.3 Edge Crossing Minimization

ELK's `LAYER_SWEEP` crossing minimization strategy handles most cases well. For the remaining crossings:

1. **Visual de-emphasis of crossings**: At crossing points, the edge that crosses over another gets a brief gap (like a "jump" in circuit diagrams):

```css
/* Applied via SVG pattern at crossing detection */
.edge-crossing-gap {
  stroke-dasharray: 4 8 4; /* Gap at crossing point */
}
```

This is a Phase 3 enhancement. Phase 1 accepts crossings as-is.

2. **Hover isolation**: When a user hovers any edge, all OTHER edges dim to 15% opacity. This makes even heavily crossed graphs instantly readable for the focused edge.

```css
.react-flow__edge:not(:hover) {
  transition: opacity var(--duration-fast) var(--ease-out);
}

.react-flow.edge-hover-active .react-flow__edge:not(.highlighted) path {
  opacity: 0.15;
}
```

3. **Connected-subgraph highlighting**: When hovering a node, highlight ALL edges and nodes in its connected component (direct connections only, 1 hop). Everything else dims. This is the primary technique for reading dense graphs.

### 13.4 Node Overlap Prevention

ELK prevents node overlap by design (nodes are registered with dimensions and ELK respects them via `elk.spacing.nodeNode`). However, manual drag in L1 can cause overlaps.

**Overlap detection on drag stop**:

```typescript
function handleNodeDragStop(event: React.MouseEvent, node: Node) {
  const overlapping = getIntersectingNodes(node);
  if (overlapping.length > 0) {
    // Snap to nearest non-overlapping position
    const snapped = findNearestNonOverlappingPosition(node, overlapping);
    updateNode(node.id, { position: snapped });
  }
  persistNodePosition(projectId, node.id, node.position);
}
```

Non-overlapping position finder: Moves the node in the direction it was dragged until it clears all intersections. Uses `getIntersectingNodes()` from `useReactFlow()`.

---

## 14. Appendix: Complete Node & Edge Type Registry

### L1 (Project Canvas) — Final

```typescript
const projectNodeTypes: NodeTypes = {
  supervisor: SupervisorNode,
  agent: AgentNode,
  'escalation-target': EscalationTargetNode,
  'remote-agent': RemoteAgentNode,
  group: GroupNode, // Collapsed agent group
};

const projectEdgeTypes: EdgeTypes = {
  handoff: HandoffEdge,
  'handoff-return': ReturnHandoffEdge,
  delegate: DelegateEdge,
  escalate: EscalateEdge,
  'fan-out': FanOutEdge,
};
```

### L2 (Agent Detail) — Final

```typescript
const agentNodeTypes: NodeTypes = {
  start: StartNode,
  step: StepNode,
  branch: BranchNode,
  'branch-table': BranchTableNode, // High fan-out (>4 branches)
  goal: GoalNode,
  tool: ToolNode,
  'tool-group': ToolGroupNode, // Collapsed tool group
  rule: RuleNode,
  'rule-group': RuleGroupNode, // Collapsed rule group
  handoff: HandoffTargetNode,
  gather: GatherGroupNode,
  respond: RespondNode,
  'sub-flow': SubFlowNode, // Collapsed linear sub-flow
};

const agentEdgeTypes: EdgeTypes = {
  flow: FlowEdge,
  branch: BranchEdge,
  'back-edge': BackEdge, // Cycle/loop
  'self-loop': SelfLoopEdge, // Step → itself
  capability: CapabilityEdge,
  gather: GatherEdge,
};
```

---

## 15. Appendix: ELK Configuration Matrix

| Context                        | `elk.direction` | `elk.layered.spacing.nodeNodeBetweenLayers` | `elk.spacing.nodeNode` | `elk.spacing.edgeEdge` | `elk.layered.layering.strategy` | `elk.layered.cycleBreaking.strategy` |
| ------------------------------ | --------------- | ------------------------------------------- | ---------------------- | ---------------------- | ------------------------------- | ------------------------------------ |
| L1, tree pattern, ≤15 agents   | DOWN            | 120                                         | 80                     | 10                     | NETWORK_SIMPLEX                 | GREEDY                               |
| L1, tree pattern, 16-30 agents | DOWN            | 100                                         | 60                     | 15                     | NETWORK_SIMPLEX                 | GREEDY                               |
| L1, tree pattern, 31-60 agents | DOWN            | 80                                          | 50                     | 20                     | NETWORK_SIMPLEX                 | GREEDY                               |
| L1, tree pattern, 61+ agents   | DOWN            | 60                                          | 40                     | 20                     | NETWORK_SIMPLEX                 | GREEDY                               |
| L1, mesh pattern, any count    | RIGHT           | 140                                         | 100                    | 30                     | NETWORK_SIMPLEX                 | GREEDY                               |
| L1, chain pattern, any count   | RIGHT           | 100                                         | 60                     | 10                     | LONGEST_PATH                    | GREEDY                               |
| L2, scripted, ≤8 steps         | RIGHT           | 80                                          | 40                     | 10                     | NETWORK_SIMPLEX                 | GREEDY                               |
| L2, scripted, 9-15 steps       | RIGHT           | 70                                          | 35                     | 15                     | NETWORK_SIMPLEX                 | GREEDY                               |
| L2, scripted, 16+ steps        | RIGHT           | 60                                          | 30                     | 15                     | NETWORK_SIMPLEX                 | GREEDY                               |
| L2, reasoning, any             | DOWN            | 60                                          | 32                     | 10                     | NETWORK_SIMPLEX                 | GREEDY                               |

**Notes**:

- `elk.layered.cycleBreaking.strategy: 'GREEDY'` is always used -- it produces better layouts than the default DFS when cycles exist (which is common in ABL flows)
- `elk.layered.layering.strategy: 'NETWORK_SIMPLEX'` is the default and produces optimal layering for most graphs
- `elk.layered.layering.strategy: 'LONGEST_PATH'` used for pure chain patterns (fastest, trivially optimal for linear graphs)
- Back-edges are excluded from ELK input and rendered separately (Section 11.5)

---

## 16. Agent Detail -- Scripted Agent Patterns (L2 Complexity)

This section provides exhaustive visualization specifications for every flow pattern that ABL scripted agents can produce. Each sub-section includes an ASCII diagram of the expected canvas layout, ELK configuration overrides, node count estimates, semantic zoom behavior, and side panel content.

All patterns use the L2 scripted ELK base config from Section 3.3 unless overrides are specified:

```typescript
// Base config reference (from Section 3.3)
const SCRIPTED_BASE = {
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.spacing.nodeNode': '40',
  'elk.padding': '[top=32,left=32,bottom=32,right=32]',
};
```

### 16.1 Linear Chain (A -> B -> C -> D)

The simplest pattern. Every step has exactly one incoming edge and one outgoing edge. No branching, no cycles, no merge points. The `simple_booking` example (welcome -> get_destination -> get_dates -> search -> book) is the canonical case.

**Expected canvas layout (LR)**:

```
  ┌─────────┐  then   ┌──────────────┐  then   ┌──────────────┐  then   ┌──────────────┐  then   ┌──────────────┐
  │  START   │────────▶│   welcome    │────────▶│get_destination│────────▶│  get_dates   │────────▶│   search     │
  │  (pill)  │         │              │         │              │         │              │         │              │
  │  80x40   │         │  200x100     │         │  200x100     │         │  200x100     │         │  200x100     │
  └─────────┘         │  RESPOND:    │         │  GATHER:     │         │  GATHER:     │         │  CALL:       │
                       │  "Welcome!"  │         │  destination │         │  checkin_date│         │  search_     │
                       └──────────────┘         └──────────────┘         │  checkout_   │         │  hotels      │
                                                                         └──────────────┘         └──────┬───────┘
                                                                                                         │ then
                                                                                                         ▼
                                                                                                  ┌──────────────┐
                                                                                                  │    book      │
                                                                                                  │              │
                                                                                                  │  GATHER +    │
                                                                                                  │  CALL:       │
                                                                                                  │  create_     │
                                                                                                  │  booking     │
                                                                                                  └──────────────┘
```

**Note on LR wrapping**: When the chain exceeds 5 steps, ELK's LR layout produces a single very wide row. The canvas relies on `fitView()` to zoom out and show the full chain. No wrapping or multi-row layout is applied -- the chain reads strictly left-to-right.

**ELK config**: Use base config unchanged. `'elk.layered.layering.strategy': 'LONGEST_PATH'` is optimal for pure linear graphs (trivially optimal, fastest computation).

```typescript
const LINEAR_CHAIN_OVERRIDES = {
  'elk.layered.layering.strategy': 'LONGEST_PATH', // Override from base 'NETWORK_SIMPLEX'
};
```

**Node count estimate**: N steps + 1 StartNode = N+1 nodes. For `simple_booking`: 6 nodes. If steps have gather fields rendered as GatherGroupNodes: add 1 per step with gather. For `simple_booking` with gather sub-nodes: 6 + 3 = 9 nodes. Edges: N (one per transition) + gather edges.

**Edge routing**: All edges are horizontal `SmoothStepEdge` paths. No vertical divergence. Every edge follows the same horizontal band. Edge labels ("then") are omitted for linear chains since all transitions are implicit `then` -- reducing visual clutter.

```typescript
// Suppress "then" labels on FlowEdges in linear chains
function shouldShowEdgeLabel(edge: Edge, graphPattern: 'linear' | 'branching' | 'mixed'): boolean {
  if (graphPattern === 'linear' && edge.data?.transitionType === 'then') return false;
  return true;
}
```

**Semantic zoom behavior**:

| Zoom Range | What is Visible                                                                                                     | Use Case                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| < 0.4      | Compact pills in a horizontal row. Edges as thin lines. Reads like a breadcrumb trail.                              | Quick scan of step count and order |
| 0.4-0.75   | Step names + activity icons (respond/tool/gather). GatherGroupNodes hidden.                                         | Understanding the flow structure   |
| >= 0.75    | Full step content: respond text, tool names, gather field names. GatherGroupNodes visible below their parent steps. | Reading and editing step details   |

**Side panel content for the most interesting node** (the `search` step -- it has CALL + RESPOND):

```
+-------------------------------------+
|  x  Step: search                    |
|  -----------------------------------+
|  [Tool Call]                        |
|  search_hotels                      |
|  Params: destination, checkin_date, |
|          checkout_date              |
|  Binding: HTTP GET /api/search      |
|  -----------------------------------+
|  [Response]                         |
|  +-------------------------------+  |
|  | Here are available hotels:    |  |
|  | {{hotels}}. Which one would   |  |
|  | you like?                     |  |
|  +-------------------------------+  |
|  -----------------------------------+
|  [Next Step]                        |
|  -> book                            |
|  -----------------------------------+
|  [Previous Steps]                   |
|  <- get_dates                       |
|  -----------------------------------+
|  [Open in DSL Editor]               |
+-------------------------------------+
```

### 16.2 Diamond Pattern (Single Binary Branch + Merge)

A step makes a tool call, the result determines one of two paths (ON_SUCCESS / ON_FAILURE or CHECK), and both paths eventually converge at a downstream step. The `search_and_show` step in `hotel_booking_advanced` is the canonical example: ON_SUCCESS goes to `select_hotel`, ON_FAIL goes back to `get_destination`.

**Expected canvas layout (LR)**:

```
                                                        success     ┌──────────────┐
                                                     ┌─────────────▶│ select_hotel │
                                                     │              │              │
  ... ──▶ ┌──────────────┐  call   ┌──────┐        │              └──────────────┘
          │search_and_show│────────▶│  ◇   │────────┤
          │              │         │      │        │
          │ CALL:        │         │ result│        │              ┌──────────────┐
          │ search_hotels│         └──────┘        └─────────────▶│get_destination│
          └──────────────┘                           failure       │  (back)      │
                                                                   └──────────────┘
```

The diamond node (rotated square, `100x60`) sits between the calling step and the two branch targets. ELK places the two targets at the same rank, offset vertically by `elk.spacing.nodeNode`.

**Detailed layout geometry**:

```
  Rank 0         Rank 1        Rank 2          Rank 3
  (upstream)     (step)        (diamond)       (targets)

               ┌──────────┐
               │ search_  │                 ┌──────────────┐
  ...─────────▶│ and_show │──────▶  ◇  ───▶│ select_hotel │   (top branch, y - elk.spacing.nodeNode/2)
               │          │        │  │     └──────────────┘
               └──────────┘        │  │
                                   │  │     ┌──────────────┐
                                   └──┘───▶ │get_destination│  (bottom branch, y + elk.spacing.nodeNode/2)
                                             └──────────────┘
```

**Diamond node handles**: Left handle (target, receives edge from the calling step). Top-right handle (source, labeled "success" in green `hsl(var(--success))`). Bottom-right handle (source, labeled "failure" in amber `hsl(var(--warning))`).

**ELK config**: Base config. No overrides needed. ELK's `elk.spacing.nodeNode: '40'` provides sufficient vertical separation between the two branch targets.

**Node count estimate**: For one diamond: 1 calling step + 1 BranchNode + 2 target steps = 4 nodes for the diamond region. Typical agent with one diamond: 8-12 total nodes.

**Merge point handling**: If both branches converge to the same downstream step (e.g., both success and failure eventually reach `review_booking`), that merge step has 2 incoming edges. ELK places it at the rank after both branches. The merge step gets the funnel indicator (Section 11.4).

```
  ... ──▶ ┌─────────┐  ──▶  ◇  ──┬──▶ [path_A] ──┬──▶ ┌─────────────┐
          │  step   │             │               │    │ merge_step  │ (funnel icon)
          └─────────┘             └──▶ [path_B] ──┘    └─────────────┘
```

**Edge styling on the diamond**:

| Outgoing Edge  | Color                 | Label                       | Style     |
| -------------- | --------------------- | --------------------------- | --------- |
| Success / Pass | `hsl(var(--success))` | "success" or condition text | Solid 2px |
| Failure / Fail | `hsl(var(--warning))` | "failure" or condition text | Solid 2px |

**Semantic zoom behavior**: At zoom < 0.5, the diamond collapses into the calling step -- the step node shows a small fork icon in its bottom-right corner. The two branch paths render as direct edges from the step to the targets, with colored dots (green/amber) instead of labels. At zoom >= 0.5, the full diamond renders.

**Side panel for the BranchNode**:

```
+-------------------------------------+
|  x  Branch: search result           |
|  -----------------------------------+
|  Type: ON_SUCCESS / ON_FAILURE      |
|  Source Step: search_and_show       |
|  -----------------------------------+
|  [Branches]                         |
|  (green dot) success                |
|    -> select_hotel                  |
|    Response: "Found {{hotels.       |
|    length}} hotels..."              |
|                                     |
|  (amber dot) failure                |
|    -> get_destination               |
|    Response: "No hotels found..."   |
|  -----------------------------------+
|  [Source Tool Call]                  |
|  search_hotels(destination, ...)    |
+-------------------------------------+
```

### 16.3 Multi-Diamond Pattern (Nested Branching)

A step branches, and one of its branches contains another branch. The `email_code_verify` step in the Authentication Agent demonstrates this: ON_SUCCESS checks `verify_code.valid`, and within the ELSE of that check, `verification_attempts >= 3` creates a second branch.

**Flow structure**:

```
email_code_verify
  ON_SUCCESS:
    IF verify_code.valid == true  ->  auth_success
    ELSE:
      SET verification_attempts += 1
      IF verification_attempts >= 3  ->  auth_locked
      ELSE                           ->  email_code_sent (retry)
  ON_FAIL:
    SET verification_attempts += 1
    IF verification_attempts >= 3  ->  auth_locked
    ELSE                           ->  email_code_sent (retry)
```

**Expected canvas layout (LR)**:

```
                                                               ┌──────────────┐
                                                      valid───▶│ auth_success │
                                                     │         └──────────────┘
                                     success  ┌─────┐│
               ┌──────────────┐    ┌────────▶│ ◇1  │┤
               │email_code_   │    │         │     ││         ┌──────┐   ┌──────────────┐
  ... ────────▶│   verify     │───▶│  ◇0    │ └─────┘└────────▶│ ◇2  │──▶│ auth_locked  │
               │              │    │        │                 │     │   └──────────────┘
               │ CALL:        │    │        │                 └──────┘
               │ verify_code  │    └────────▶                     │
               └──────────────┘      failure │                    │     ┌──────────────┐
                                             │                    └────▶│email_code_sent│
                                             │                          │  (retry)     │
                                             │                          └──────────────┘
                                             │        ┌──────┐
                                             └───────▶│ ◇3  │──────(same targets as above)
                                                      └──────┘
```

**ELK rank assignment with nested conditionals**: Each diamond occupies its own rank. The outer diamond (success vs failure) is at rank R. The inner diamond (valid vs attempts check) is at rank R+1. Target nodes from the inner diamond are at rank R+2.

```
  Rank R        Rank R+1      Rank R+2       Rank R+3
  (outer ◇)     (inner ◇)     (innermost ◇)  (targets)

    ◇0  ────────▶  ◇1  ───────────────────────▶ auth_success
     │               │
     │               └──────────▶  ◇2  ────────▶ auth_locked
     │                              │
     │                              └──────────▶ email_code_sent
     │
     └──────────▶  ◇3  (failure path)
                    │
                    ├──────────────────────────▶ auth_locked
                    └──────────────────────────▶ email_code_sent
```

**ELK config overrides**: When nested branching is detected (diamond depth > 1), increase `elk.layered.spacing.nodeNodeBetweenLayers` to prevent horizontal crowding of the nested diamonds:

```typescript
const NESTED_BRANCH_OVERRIDES = {
  'elk.layered.spacing.nodeNodeBetweenLayers': '100', // Up from 80 — more room between nested diamond columns
  'elk.spacing.nodeNode': '50', // Up from 40 — more vertical room for the expanded branch tree
};
```

**Node count estimate**: Per nesting level, add 1 BranchNode per condition. For the Authentication Agent `email_code_verify`: 1 outer diamond + 2 inner diamonds (one per outer branch) + 3 unique target steps = 7 nodes for this region alone. Full Authentication Agent: approximately 14 flow nodes + 4-6 branch nodes + 1 start node = 19-21 nodes.

**Shared target deduplication**: `auth_locked` and `email_code_sent` are targets of multiple branches. They appear once in the layout. All branch paths that lead to them converge as multiple incoming edges on those nodes. The funnel indicator (Section 11.4) marks these merge points.

**Semantic zoom behavior**: At zoom < 0.5, the entire nested diamond collapses. The calling step shows a "branching" badge with the number of possible outcomes (e.g., "3 paths"). Edges from the step directly connect to all eventual target steps, skipping the diamond chain. At zoom 0.5-0.75, diamonds render but inner content is hidden (just the diamond shape). At zoom >= 0.75, diamonds show condition text.

**Side panel for inner BranchNode (diamond 2 -- attempts check)**:

```
+-------------------------------------+
|  x  Branch: attempt check           |
|  -----------------------------------+
|  Type: Nested conditional           |
|  Parent Branch: ON_SUCCESS (invalid)|
|  -----------------------------------+
|  Condition:                         |
|  verification_attempts >= 3         |
|  -----------------------------------+
|  [Branches]                         |
|  (amber dot) true                   |
|    -> auth_locked                   |
|    SET: account_locked = true       |
|                                     |
|  (green dot) false                  |
|    -> email_code_sent               |
|    Response: "That code is          |
|    incorrect. You have {{3 -        |
|    verification_attempts}}          |
|    attempt(s) remaining."           |
|  -----------------------------------+
|  [Context]                          |
|  This branch is reached when the    |
|  verification code was invalid.     |
|  Parent: email_code_verify          |
+-------------------------------------+
```

### 16.4 Wide Fan-Out Pattern (ON_INPUT with 4-8+ Branches)

The `confirm` step in `hotel_booking_advanced` has 10 ON_INPUT branches pointing to 8 distinct targets. This is the widest fan-out in any real ABL agent.

**Branch inventory for `confirm`**:

| #   | Condition                              | Target          | Edge Type            |
| --- | -------------------------------------- | --------------- | -------------------- |
| 1   | `input == "confirm" OR input == "yes"` | COMPLETE        | forward              |
| 2   | `input == "back"`                      | payment_method  | back-edge            |
| 3   | `input == "cancel"`                    | welcome         | long-range back-edge |
| 4   | `input contains "change destination"`  | get_destination | long-range back-edge |
| 5   | `input contains "change date"`         | get_dates       | long-range back-edge |
| 6   | `input contains "change hotel"`        | select_hotel    | back-edge            |
| 7   | `input contains "change room"`         | select_room     | back-edge            |
| 8   | `input contains "change guest"`        | guest_details   | back-edge            |
| 9   | `input contains "change payment"`      | payment_method  | back-edge            |
| 10  | ELSE                                   | confirm         | self-loop            |

**Rendering decision**: Since branch count > 4, use `BranchTableNode` (Section 11.2) instead of a diamond:

```
  ... ──▶ ┌──────────────┐     ┌════════════════════════════════════════╗
          │   confirm    │────▶║  ◇  confirm — Branching (10 paths)    ║
          │              │     ║  ───────────────────────────────────── ║
          │  GATHER:     │     ║  "confirm"/"yes"  -> [COMPLETE]       ║
          │  confirmation│     ║  "back"           -> [payment_method] ║
          └──────────────┘     ║  "cancel"         -> [welcome]        ║
                               ║  "change dest."   -> [get_destination]║
                               ║  "change date"    -> [get_dates]      ║
                               ║  + 5 more...      [expand]            ║
                               ╚════════════════════════════════════════╝
                                    │  │  │  │  │  │  │  │  │  ↺
                                    │  │  │  │  │  │  │  │  │  (self-loop)
                                    ▼  ▼  ▼  ▼  ▼  ▼  ▼  ▼  ▼
                              (edges fan out to targets across the graph)
```

**BranchTableNode dimensions**: Width 320px, height varies: `base 80px + (min(displayed_rows, 5) * 24px)`. With 5 visible rows + "expand": `80 + 5*24 = 200px`. Expanded with all 10 rows: `80 + 10*24 = 320px`.

**Virtual gather point for edge bundling**: A single invisible anchor node (`width: 1, height: 1, opacity: 0`) sits 40px to the right of the BranchTableNode. All 10 outgoing edges route through this anchor before fanning out to their targets:

```
  [confirm] ──▶ [BranchTable] ──▶ (invisible anchor) ─┬──▶ [COMPLETE]
                                                        ├──▶ [payment_method]
                                                        ├──▶ [welcome]          (back-edge)
                                                        ├──▶ [get_destination]  (back-edge)
                                                        ├──▶ [get_dates]        (back-edge)
                                                        ├──▶ [select_hotel]     (back-edge)
                                                        ├──▶ [select_room]      (back-edge)
                                                        ├──▶ [guest_details]    (back-edge)
                                                        ├──▶ [payment_method]   (back-edge, merged with #2)
                                                        └──▶ [confirm]          (self-loop)
```

**Edge classification**: Of the 10 edges, only 1 is a forward edge (to COMPLETE). The remaining 9 are back-edges or a self-loop. The back-edges are rendered using `BackEdge` styling (Section 11.5): dashed, amber, curving above or below the main flow.

**Edge routing for back-edges from wide fan-out**: The back-edges are stacked vertically with increasing curvature offset to prevent overlap:

```typescript
function computeBackEdgeOffset(
  backEdgeIndex: number,
  totalBackEdges: number,
  direction: 'above' | 'below',
): number {
  const baseOffset = 40;
  const increment = 25;
  const sign = direction === 'above' ? -1 : 1;
  return sign * (baseOffset + backEdgeIndex * increment);
}
```

Back-edges to targets that are **above** the BranchTableNode in the layout (earlier steps) route above the flow. Back-edges to targets **below** route below. This distributes the visual weight:

```
        (back-edges route ABOVE the flow to earlier steps)
     ╭──────────────────────────────────────────────────────────╮
     │      ╭────────────────────────────────────────╮          │
     │      │      ╭───────────────────────╮         │          │
     ▼      ▼      ▼                       │         │          │
  [welcome][get_d][get_dates]  ...  [pay_m][review] [confirm]──▶[BranchTable]──▶[COMPLETE]
                                                         ↺
                                                    (self-loop on right side)
```

**ELK config overrides**:

```typescript
const WIDE_FANOUT_OVERRIDES = {
  'elk.layered.spacing.nodeNodeBetweenLayers': '100', // More horizontal room for the BranchTableNode width
  'elk.spacing.nodeNode': '50', // More vertical room for edge routing
  'elk.spacing.edgeEdge': '25', // More separation between parallel back-edges
};
```

**Node count estimate**: BranchTableNode adds 1 node + 1 invisible anchor = 2 extra. Full `hotel_booking_advanced` with wide fan-out: 12 steps + 1 start + 3-4 branch nodes (other steps have branching too) + 1 BranchTable + 1 anchor = approximately 18-20 nodes.

**Semantic zoom behavior**:

| Zoom Range | BranchTableNode Rendering                   | Back-Edges                                          |
| ---------- | ------------------------------------------- | --------------------------------------------------- |
| < 0.4      | Compact pill labeled "confirm (10 paths)"   | Hidden entirely -- reduces to the forward edge only |
| 0.4-0.6    | Small table showing top 3 rows + "+ 7 more" | Shown as thin faded lines with no labels            |
| 0.6-0.8    | Table showing top 5 rows + "+ 5 more"       | Shown with condition labels                         |
| >= 0.8     | Full expanded table, all 10 rows visible    | Full rendering with labels and loop icons           |

**Side panel for the BranchTableNode**:

```
+-------------------------------------+
|  x  Branch: confirm (10 paths)      |
|  -----------------------------------+
|  Type: ON_INPUT multi-way branch    |
|  Source Step: confirm               |
|  -----------------------------------+
|  [All Branches]                     |
|                                     |
|  1. "confirm" / "yes"              |
|     CALL: create_booking(...)       |
|     RESPOND: "BOOKING CONFIRMED!" |
|     -> COMPLETE                     |
|                                     |
|  2. "back"                          |
|     -> payment_method               |
|                                     |
|  3. "cancel"                        |
|     RESPOND: "Booking cancelled..." |
|     -> welcome (restart)            |
|                                     |
|  4. "change destination"            |
|     -> get_destination              |
|                                     |
|  5. "change date"                   |
|     -> get_dates                    |
|                                     |
|  6. "change hotel"                  |
|     -> select_hotel                 |
|                                     |
|  7. "change room"                   |
|     -> select_room                  |
|                                     |
|  8. "change guest"                  |
|     -> guest_details                |
|                                     |
|  9. "change payment"               |
|     -> payment_method               |
|                                     |
| 10. (else)                          |
|     RESPOND: "Please type           |
|     'confirm'..."                   |
|     -> confirm (self)               |
|  -----------------------------------+
|  [Back-Edge Summary]                |
|  8 back-edges, 1 self-loop          |
|  Longest jump: confirm -> welcome   |
|  (spans 11 steps)                   |
+-------------------------------------+
```

### 16.5 Cycle/Retry Pattern (Step Loops Back)

ABL scripted flows support explicit cycles: a step's `then` or `ON_INPUT` branch points back to an earlier step. The Authentication Agent contains two distinct retry patterns:

**Pattern A: Tight retry loop** -- `email_code_sent -> email_code_verify -> email_code_sent` (invalid code, try again)

**Pattern B: Self-loop** -- `choose_method -> choose_method` (invalid input, ask again)

**Pattern C: Multi-step retry** -- `email_enter -> email_flow_start` (invalid email format, re-enter)

**Expected canvas layout (LR) for tight retry loop (Pattern A)**:

```
                                                            ╭──────────────────╮
                                                            │ (back-edge)      │
                                                            │ "code incorrect" │
                                                            │                  │
  ... ──▶ ┌──────────────┐  then   ┌──────────────┐       │                  │
          │email_code_   │────────▶│email_code_   │───────╯
          │   sent       │         │   verify     │
          │              │◀────────│              │
          │  GATHER:     │ ↺retry  │  CALL:       │──────────▶  ◇  ──▶ ...
          │  verification│         │  verify_code │          (success/fail)
          │  _code       │         └──────────────┘
          └──────────────┘
```

**Back-edge rendering for tight loops**: When the back-edge target is the immediately preceding step (rank distance = 1), the back-edge curves tightly above the two nodes:

```typescript
function computeBackEdgePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  rankDistance: number,
): string {
  if (rankDistance === 1) {
    // Tight loop: small arc above the pair
    const midX = (sourceX + targetX) / 2;
    const arcHeight = 50;
    return `M ${sourceX} ${sourceY}
            C ${sourceX} ${sourceY - arcHeight},
              ${targetX} ${targetY - arcHeight},
              ${targetX} ${targetY}`;
  }
  // Longer loops use the standard BackEdge path (Section 11.5)
  // ...
}
```

**Loop indicator**: A small circular badge at the midpoint of the back-edge arc showing the loop icon and attempt count from the constraints (if available):

```
          ╭───── ↺ (max 3) ─────╮
          │                      │
  [email_code_sent] ──▶ [email_code_verify]
```

The badge renders as:

- Shape: Circle, 20px diameter
- Background: `hsl(var(--warning-subtle))`
- Border: `1px solid hsl(var(--warning) / 0.3)`
- Content: `↺` icon + optional "max N" text at zoom >= 0.8
- Position: Midpoint of the back-edge arc

**Self-loop rendering (Pattern B)**:

```
          ╭──↺──╮
          │     │
  ┌──────────────┐
  │ choose_method│
  │              │
  │  GATHER:     │
  │  auth_method │
  └──────────────┘
```

Self-loop renders as a small circular arc on the right side of the node (Section 11.5). The arc radius is 24px. A small label appears at the apex of the arc showing the ELSE condition.

**ELK config**: Base config. Back-edges are excluded from ELK input (Section 11.5). ELK sees only forward edges and computes a clean layout. Back-edges and self-loops are rendered as overlays after ELK positioning.

**Node count estimate**: Cycles add 0 extra nodes (they reuse existing nodes). The additional rendering cost is in the edge overlays only.

**Semantic zoom behavior**:

| Zoom Range | Cycle Rendering                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| < 0.4      | Back-edges hidden. Self-loops shown as a tiny dot on the node corner.                                                                            |
| 0.4-0.6    | Back-edges shown as thin amber dashed lines with no labels. Self-loops as small arcs.                                                            |
| 0.6-0.8    | Back-edges with condition labels. Loop indicator badge visible. Self-loops with "else" label.                                                    |
| >= 0.8     | Full rendering. Loop indicator shows "max N" if constraints define an attempt limit. Self-loop shows full ELSE respond text in tooltip on hover. |

**Side panel for a node involved in a cycle (email_code_verify)**:

```
+-------------------------------------+
|  x  Step: email_code_verify         |
|  -----------------------------------+
|  [Tool Call]                        |
|  verify_code(email, verification_   |
|  code)                              |
|  -----------------------------------+
|  [Branches]                         |
|  ON_SUCCESS:                        |
|    IF valid == true -> auth_success |
|    ELSE:                            |
|      SET attempts += 1             |
|      IF attempts >= 3              |
|        -> auth_locked              |
|      ELSE                          |
|        -> email_code_sent (RETRY)  |  <-- labeled as retry
|                                     |
|  ON_FAILURE:                        |
|    SET attempts += 1               |
|    IF attempts >= 3                |
|      -> auth_locked                |
|    ELSE                            |
|      -> email_code_sent (RETRY)    |
|  -----------------------------------+
|  [Loop Analysis]                    |
|  Part of retry loop:               |
|  email_code_sent <-> email_code_    |
|  verify                             |
|  Max iterations: 3 (from           |
|  constraint: verification_attempts  |
|  < 3)                               |
|  -----------------------------------+
|  [Incoming Edges]                   |
|  <- email_code_sent (forward)      |
|  -----------------------------------+
|  [Outgoing Edges]                   |
|  -> auth_success (success, valid)  |
|  -> auth_locked (attempts >= 3)    |
|  -> email_code_sent (retry loop)   |
+-------------------------------------+
```

### 16.6 Long-Range Jump Pattern (Skipping Multiple Steps)

The `confirm -> welcome` transition in `hotel_booking_advanced` jumps backward across 11 steps. The `confirm -> get_destination` jump spans 9 steps. These create long horizontal edges that cross the entire flow.

**Expected canvas layout (LR)**:

```
  (long-range back-edge from confirm to welcome, curving ABOVE the entire flow)
  ╭─────────────────────────────────────────────────────────────────────────────────────────╮
  │                                                                                         │
  │  ╭──────────────────────────────────────────────────────────────────────────╮            │
  │  │                                                                          │            │
  ▼  ▼                                                                          │            │
  [welcome] ──▶ [get_dest] ──▶ [get_dates] ──▶ ... (6 more steps) ... ──▶ [review] ──▶ [confirm]
                                                                                         │
                                                                               ──────────┘──▶ [COMPLETE]
```

**Edge curvature calculation** (expanding Section 11.7):

```typescript
function computeLongRangeEdgePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  rankDistance: number,
  edgeIndex: number, // Which long-range edge is this (for stacking)
  totalLongRange: number, // How many long-range edges exist
): string {
  // Base vertical offset increases with rank distance
  const baseOffset = 60 + (rankDistance - 3) * 12;

  // Stack offset when multiple long-range edges exist
  const stackOffset = edgeIndex * 30;

  // Total offset above the flow
  const yOffset = -(baseOffset + stackOffset);

  // Bezier control points
  const cp1x = sourceX + 60;
  const cp1y = sourceY + yOffset;
  const cp2x = targetX - 60;
  const cp2y = targetY + yOffset;

  return `M ${sourceX} ${sourceY}
          C ${cp1x} ${cp1y},
            ${cp2x} ${cp2y},
            ${targetX} ${targetY}`;
}
```

**Edge routing rule**: Long-range back-edges (rank distance > 3) ALWAYS route above the main flow. Long-range forward edges (rare, but possible with GOTO) route below. This convention prevents crossing between back-edges and forward edges.

When multiple long-range edges exist (the `confirm` step has 5 back-edges spanning 3+ ranks), they stack vertically above the flow with 30px spacing between arcs:

```
  ╭── confirm -> welcome ─────────────────────────────────────────╮  (outermost, highest arc)
  │ ╭── confirm -> get_destination ────────────────────────────╮  │
  │ │ ╭── confirm -> get_dates ─────────────────────────────╮  │  │
  │ │ │                                                      │  │  │
  ▼ ▼ ▼                                                      │  │  │
  [welcome] ──▶ [get_dest] ──▶ [get_dates] ──▶ ... ──▶ [confirm]─┘──┘──┘
```

The outermost arc (longest jump) is tallest. Shorter jumps nest inside. This creates a visually nested arc structure that is readable.

**ELK config overrides**: When long-range edges are detected, increase padding to reserve vertical space above the flow for the arcs:

```typescript
function computeTopMargin(longestJumpRankDistance: number): number {
  if (longestJumpRankDistance <= 3) return 32; // Default
  return 32 + (longestJumpRankDistance - 3) * 20;
}
```

**Hover interaction**: When hovering a long-range edge, all other edges dim to 10% opacity (Section 11.7). Additionally, the source and target nodes get attention-pulse rings, and all intermediate nodes (nodes between source and target in rank order) get a subtle underline indicator showing "this step is being skipped."

**Node count estimate**: No extra nodes. The long-range edges connect existing step nodes.

**Semantic zoom behavior**:

| Zoom Range | Long-Range Edge Rendering                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| < 0.4      | Hidden entirely. The flow appears as a simple chain.                                                          |
| 0.4-0.6    | Shown as thin amber arcs with no labels. Only the longest 3 arcs visible (the rest hidden to reduce clutter). |
| >= 0.6     | All arcs visible with condition labels at their apex.                                                         |

**Side panel**: No dedicated side panel for long-range edges. Clicking a long-range edge opens the standard edge side panel showing source step, target step, condition, and the rank distance ("jumps back 11 steps").

### 16.7 Parallel Verification Paths (Authentication Agent Pattern)

The Authentication Agent has two independent verification sub-flows that diverge from `choose_method` and converge at `auth_success` / `auth_locked`:

- **Email path**: `email_flow_start -> email_enter -> email_code_sent -> email_code_verify`
- **Booking-ref path**: `booking_ref_flow -> booking_ref_verify`

Each path has its own retry loops. Both paths can reach `auth_success` (on valid verification) or `auth_locked` (on 3 failed attempts).

**Expected canvas layout (LR)**:

```
                              EMAIL PATH
                       ╭─────────────────────────────────────────────────────╮
                       │                                                     │
                       │   ┌────────────┐   ┌────────────┐   ┌────────────┐ │
                       │   │ email_flow │──▶│ email_     │──▶│email_code_ │ │
                       ├──▶│  _start    │   │  enter     │   │   sent     │ │
                       │   │            │   │            │   │            │ │
                       │   │ GATHER:    │   │ CALL:      │   │ GATHER:    │ │
  ┌─────────┐  then   │   │  email     │   │verify_email│   │ verif_code │ │
  │  START  │────────▶ │   └────────────┘   └────────────┘   └─────┬──────┘ │
  └─────────┘          │                                           │        │
       │               │                                           ▼        │    ┌─────────────┐
       ▼               │                                     ┌────────────┐ │    │             │
  ┌──────────────┐     │                                     │email_code_ │─┼───▶│auth_success │
  │check_recent_ │──▶──┤                                     │  verify    │ │    │             │
  │   auth       │     │                                     │            │ │    └─────────────┘
  └──────────────┘     │                                     │ CALL:      │ │
       │               │                                     │verify_code │─┼──╮
       ▼               │                                     └────────────┘ │  │
  ┌──────────────┐     │                                           ↕ retry  │  │
  │choose_method │─────┤                                                    │  │  ┌─────────────┐
  │              │     │   BOOKING-REF PATH                                 │  ├─▶│ auth_locked │
  │ GATHER:      │     ╰─────────────────────────────────────────────────────╯  │  │             │
  │ auth_method  │     │                                                        │  └─────────────┘
  └──────────────┘     │   ┌──────────────┐   ┌──────────────┐                  │
                       │   │booking_ref_  │──▶│booking_ref_  │─────────────────╯
                       └──▶│   flow       │   │   verify     │──────────────────▶(auth_success)
                           │              │   │              │
                           │ GATHER:      │   │ CALL:        │
                           │ booking_ref  │   │lookup_booking│
                           │ last_name    │   └──────────────┘
                           └──────────────┘        ↕ retry
```

**Swim-lane treatment**: The two parallel paths are visually separated by a horizontal divider zone. This is not a formal React Flow group node -- it is a visual annotation implemented as a background rectangle:

```typescript
interface SwimLane {
  id: string;
  label: string;
  nodeIds: string[]; // Nodes belonging to this lane
  y: number; // Computed: average Y of contained nodes
  height: number; // Computed: max Y - min Y + padding
  color: string; // Subtle background tint
}

const lanes: SwimLane[] = [
  {
    id: 'email-path',
    label: 'Email Verification',
    nodeIds: ['email_flow_start', 'email_enter', 'email_code_sent', 'email_code_verify'],
    color: 'hsl(var(--info) / 0.04)',
    // y, height computed after ELK layout
  },
  {
    id: 'booking-ref-path',
    label: 'Booking Reference',
    nodeIds: ['booking_ref_flow', 'booking_ref_verify'],
    color: 'hsl(var(--purple) / 0.04)',
  },
];
```

**Swim-lane rendering**: After ELK computes node positions, compute the bounding box of each lane's nodes, add 24px padding, and render a rounded rectangle behind the nodes:

```
╔══ Email Verification ═══════════════════════════════════════════╗
║  [email_flow_start] ──▶ [email_enter] ──▶ [email_code_sent]   ║
║                                              ──▶ [verify]      ║
╚═════════════════════════════════════════════════════════════════╝

╔══ Booking Reference ════════════════════════════════════════════╗
║  [booking_ref_flow] ──▶ [booking_ref_verify]                   ║
╚═════════════════════════════════════════════════════════════════╝
```

Lane rectangles:

- Background: lane color (very subtle tint)
- Border: `1px dashed hsl(var(--border-muted))`
- Border-radius: `var(--radius-xl)`
- Label: `text-xs font-medium text-muted` positioned at top-left inside the rectangle

**Swim-lane detection heuristic**: Detect parallel paths when a single node (the diverge point) has 2+ outgoing edges to nodes that have no cross-edges between their respective sub-graphs until they converge at a shared downstream node:

```typescript
function detectParallelPaths(
  divergeNodeId: string,
  edges: Edge[],
  nodes: Node[],
): ParallelPathGroup[] {
  const outgoing = edges.filter((e) => e.source === divergeNodeId);
  if (outgoing.length < 2) return [];

  // BFS from each outgoing target, collecting reachable nodes
  // If two BFS trees have NO intersection (except at converge points), they are parallel
  const paths = outgoing.map((edge) => ({
    startEdge: edge,
    reachable: bfsReachable(edge.target, edges),
  }));

  // Check pairwise independence
  // ...
}
```

**ELK config overrides**: When parallel paths are detected, increase `elk.spacing.nodeNode` to provide space between the swim lanes:

```typescript
const PARALLEL_PATH_OVERRIDES = {
  'elk.spacing.nodeNode': '60', // Up from 40 — more vertical space between swim lanes
};
```

**Node count estimate**: Authentication Agent total: 10 step nodes + 1 start + 4-6 branch nodes + 2 converge nodes = approximately 17-19 nodes.

**Semantic zoom behavior**: At zoom < 0.5, swim-lane backgrounds are hidden. At zoom >= 0.5, swim-lane backgrounds and labels become visible. At zoom >= 0.8, full lane label text and all node content are visible.

**Side panel for `choose_method` (the diverge point)**:

```
+-------------------------------------+
|  x  Step: choose_method             |
|  -----------------------------------+
|  [Gather]                           |
|  auth_method (required)             |
|  -----------------------------------+
|  [Parallel Paths]                   |
|  This step diverges into parallel   |
|  verification flows:                |
|                                     |
|  Path 1: Email Verification        |
|    "email" / "1" / "code"           |
|    -> email_flow_start              |
|    Steps: email_flow_start ->       |
|    email_enter -> email_code_sent   |
|    -> email_code_verify             |
|                                     |
|  Path 2: Booking Reference          |
|    "booking" / "reference" / "2"    |
|    -> booking_ref_flow              |
|    Steps: booking_ref_flow ->       |
|    booking_ref_verify               |
|                                     |
|  Else: self-loop (invalid input)   |
|  -----------------------------------+
|  [Convergence Points]               |
|  Both paths converge at:            |
|  - auth_success (successful auth)   |
|  - auth_locked (3 failed attempts)  |
+-------------------------------------+
```

### 16.8 Gather-Heavy Flow (Every Step Has Gather Fields)

The `hotel_booking_advanced` flow has gather fields on 8 of its 12 steps. When every step has a `GatherGroupNode` attached below it, the vertical space requirement is significant.

**Steps with gather in `hotel_booking_advanced`**:

| Step            | Gather Fields                                          | Field Count |
| --------------- | ------------------------------------------------------ | ----------- |
| get_destination | destination                                            | 1           |
| get_dates       | checkin_date, checkout_date                            | 2           |
| get_guests      | num_guests, num_rooms                                  | 2           |
| select_hotel    | selected_hotel                                         | 1           |
| select_room     | room_type                                              | 1           |
| guest_details   | guest_name, guest_email, guest_phone                   | 3           |
| payment_method  | payment_type (+ conditional: card_number, expiry, cvv) | 1-4         |
| confirm         | confirmation                                           | 1           |

**The problem**: If every GatherGroupNode renders below its parent step at full size, the flow becomes very tall vertically in LR layout:

```
  BAD (vertical explosion):

  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │get_dest  │     │get_dates │     │get_guests│
  └──────────┘     └──────────┘     └──────────┘
       │                │                │
       ▼                ▼                ▼
  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │GATHER    │     │GATHER    │     │GATHER    │   <-- 80px+ per gather node
  │destination│    │checkin_d │     │num_guests│       adds up fast
  └──────────┘     │checkout_d│     │num_rooms │
                   └──────────┘     └──────────┘
```

**Solution: Inline gather badge + expand-on-click**:

At the default zoom level, gather fields are NOT rendered as separate `GatherGroupNode` sub-nodes. Instead, each step shows an inline badge:

```
  ┌──────────────────┐
  │ get_dates        │
  │ ──────────────── │
  │ GATHER: 2 fields │ <-- compact badge, no separate node
  │ ──────────────── │
  │ -> get_guests    │
  └──────────────────┘
```

The `GatherGroupNode` appears only when:

1. The user clicks the gather badge (opens side panel with full gather details), OR
2. The zoom level >= 1.0 (at very high zoom, show gather detail inline)

**GatherGroupNode positioning (when visible at high zoom)**:

```
  ┌──────────────────┐
  │ get_dates        │
  │ ──────────────── │
  │ GATHER: 2 fields │
  └──────────┬───────┘
             │ (gather edge, dotted, 1px, purple)
             ▼
  ┌──────────────────┐
  │ GATHER           │
  │ ──────────────── │
  │ . checkin_date   │
  │   (date, req.)   │
  │ . checkout_date  │
  │   (date, req.)   │
  └──────────────────┘
```

The GatherGroupNode is positioned directly below its parent step, offset by 20px vertically. It is excluded from ELK layout (not a graph node) -- positioned absolutely relative to its parent:

```typescript
function positionGatherNodes(
  stepNodes: Node[],
  gatherGroups: Map<string, GatherGroupNode>,
): Node[] {
  return stepNodes.flatMap((step) => {
    const gather = gatherGroups.get(step.id);
    if (!gather) return [step];

    const gatherNode: Node = {
      ...gather,
      position: {
        x: step.position.x,
        y: step.position.y + STEP_NODE_HEIGHT + 20,
      },
    };

    return [step, gatherNode];
  });
}
```

**ELK config**: Base config. GatherGroupNodes are excluded from the ELK graph to prevent them from affecting rank/separation calculations.

**Node count estimate**: With gather visible: 12 steps + 1 start + branch nodes + 8 gather nodes = approximately 25-30 nodes. Without gather (default): 12 + 1 + branch nodes = approximately 17-20 nodes.

**Semantic zoom behavior**:

| Zoom Range | Gather Rendering                                                                       |
| ---------- | -------------------------------------------------------------------------------------- |
| < 0.5      | Hidden. No badge, no sub-node.                                                         |
| 0.5-0.75   | Inline badge: "N fields" pill at bottom of step.                                       |
| 0.75-1.0   | Inline badge with field names listed: "destination, checkin_date".                     |
| >= 1.0     | Full GatherGroupNode rendered below the step with field types and required indicators. |

**Side panel for GatherGroupNode (get_dates)**:

```
+-------------------------------------+
|  x  Gather: get_dates               |
|  -----------------------------------+
|  Strategy: hybrid                   |
|  -----------------------------------+
|  [Fields]                           |
|                                     |
|  checkin_date                       |
|    Type: date                       |
|    Required: yes                    |
|    Prompt: (default)                |
|                                     |
|  checkout_date                      |
|    Type: date                       |
|    Required: yes                    |
|    Prompt: (default)                |
|  -----------------------------------+
|  [Validation]                       |
|  (none configured)                  |
|  -----------------------------------+
|  [Edit Gather Fields]               |
+-------------------------------------+
```

### 16.9 Tool-Chain Flow (Sequential Tool Calls)

When every step makes a tool call, each step has a ToolNode associated with it. The `search_and_show`, `select_hotel` (conditional call), `promo_check`, `email_enter`, `email_code_verify`, `booking_ref_verify`, and `book` steps all make tool calls.

**Expected canvas layout (LR) for a tool-chain segment**:

```
  ┌──────────────┐  then   ┌──────────────┐  then   ┌──────────────┐
  │ email_enter  │────────▶│email_code_   │────────▶│email_code_   │
  │              │         │   sent       │         │   verify     │
  │ CALL:        │         │              │         │ CALL:        │
  │ verify_email │         │ GATHER:      │         │ verify_code  │
  └──────┬───────┘         │ verif_code   │         └──────┬───────┘
         │                 └──────────────┘                │
         ▼  (tool detail)                                  ▼  (tool detail)
  ┌──────────────┐                                  ┌──────────────┐
  │ verify_email │                                  │ verify_code  │
  │ HTTP POST    │                                  │ HTTP POST    │
  │ /api/verify  │                                  │ /api/code    │
  └──────────────┘                                  └──────────────┘
```

**ToolNode positioning**: Same strategy as GatherGroupNodes -- ToolNodes are positioned below their calling step, excluded from ELK layout:

```typescript
function positionToolNodes(stepNodes: Node[], toolBindings: Map<string, ToolDefinition>): Node[] {
  return stepNodes.flatMap((step) => {
    if (!step.data.call) return [step];

    const tool = toolBindings.get(step.data.call);
    if (!tool) return [step];

    const toolNode: Node = {
      id: `tool-${step.id}-${tool.name}`,
      type: 'tool',
      position: {
        x: step.position.x,
        y: step.position.y + STEP_NODE_HEIGHT + 20,
      },
      data: {
        name: tool.name,
        toolType: tool.tool_type,
        endpoint: tool.http_binding?.endpoint,
        method: tool.http_binding?.method,
      },
    };

    return [step, toolNode];
  });
}
```

**Preventing vertical collision between ToolNodes and GatherGroupNodes**: When a step has BOTH a tool call AND gather fields, the ToolNode sits below the step and the GatherGroupNode sits below the ToolNode:

```
  ┌──────────────┐
  │  step        │
  │ CALL + GATHER│
  └──────┬───────┘
         │ (tool edge)
         ▼
  ┌──────────────┐
  │ tool_name    │  (ToolNode, 200x72)
  │ HTTP POST    │
  └──────┬───────┘
         │ (gather edge)
         ▼
  ┌──────────────┐
  │ GATHER       │  (GatherGroupNode, 200x80+)
  │ . field_a    │
  │ . field_b    │
  └──────────────┘
```

Vertical stacking order: step -> tool (offset +120px) -> gather (offset +212px). These offsets are constants:

```typescript
const SUB_NODE_OFFSETS = {
  toolBelowStep: STEP_NODE_HEIGHT + 20, // 100 + 20 = 120
  gatherBelowTool: TOOL_NODE_HEIGHT + 20, // 72 + 20 = 92
  gatherBelowStep: STEP_NODE_HEIGHT + 20, // When no tool: 120
  gatherBelowStepWithTool: STEP_NODE_HEIGHT + 20 + TOOL_NODE_HEIGHT + 20, // 212
};
```

**ELK config**: Base config. ToolNodes and GatherGroupNodes are both excluded from the ELK graph.

**Node count estimate**: For a 10-step flow where 6 steps have tool calls: 10 + 1 start + branch nodes + 6 tool nodes = approximately 20-25 nodes. If gather is also visible: add gather nodes on top.

**Semantic zoom behavior**:

| Zoom Range | ToolNode Rendering                                                        |
| ---------- | ------------------------------------------------------------------------- |
| < 0.5      | Hidden. Step shows a small wrench icon.                                   |
| 0.5-0.75   | Step shows tool name inline: "CALL: search_hotels". No separate ToolNode. |
| >= 0.75    | Full ToolNode rendered below the step with binding type and endpoint.     |

**Side panel for ToolNode (verify_code)**:

```
+-------------------------------------+
|  x  Tool: verify_code               |
|  -----------------------------------+
|  Description:                       |
|  Verify the 6-digit code entered    |
|  by the user                        |
|  -----------------------------------+
|  Binding: HTTP                      |
|  Method: POST                       |
|  Endpoint: /api/tools/verify_code   |
|  Auth: bearer                       |
|  -----------------------------------+
|  Parameters:                        |
|  +--------+---------+----------+    |
|  | Name   | Type    | Required |    |
|  +--------+---------+----------+    |
|  | email  | string  | yes      |    |
|  | code   | string  | yes      |    |
|  +--------+---------+----------+    |
|  -----------------------------------+
|  Returns:                           |
|  { valid: boolean, user_id:         |
|    string, token: string }          |
|  -----------------------------------+
|  Hints:                             |
|  Cacheable: no                      |
|  Latency: fast                      |
|  Side effects: yes                  |
|  -----------------------------------+
|  Called By:                          |
|  email_code_verify                  |
|  -----------------------------------+
|  [Edit Tool]                        |
+-------------------------------------+
```

### 16.10 Mixed Pattern (Branches + Cycles + Gather + Tools + Digressions)

The "maximum complexity" agent -- `hotel_booking_advanced` combined with features from the Authentication Agent -- exercises every visualization pattern simultaneously. This sub-section specifies how they compose.

**Full `hotel_booking_advanced` canvas layout (LR)**:

```
  (long-range back-edges from confirm, curving above)
  ╭──────────────────────────────────────────────────────────────────────────────────────────────────────────╮
  │  ╭──────────────────────────────────────────────────────────────────────────────────────────╮           │
  │  │  ╭───────────────────────────────────────────────────────────────────────────╮           │           │
  │  │  │  ╭─────────────────────────────────────────────────────────╮              │           │           │
  │  │  │  │  ╭──────────────────────────────────────────╮          │              │           │           │
  ▼  ▼  ▼  ▼  ▼                                          │          │              │           │           │
  [START]──▶[welcome]──▶[get_dest]──▶[get_dates]──▶[get_guests]──▶[search]──▶◇──┬▶[select_hotel]──▶[select_room]
                                                                      │         │         │                  │
                                                                      │         └▶[get_d] │                  │
                                                                      │       (failure)   │                  │
                                                                   (tool:                  │                  │
                                                                   search_                 │                  │
                                                                   hotels)                 ▼                  ▼
                                                                               ──▶[promo_check]──▶[guest_dtl]──▶[pay_method]──▶[review]──▶[confirm]
                                                                                       │                                                    │
                                                                                       ↺ retry                                        [BranchTable]
                                                                                  (invalid code)                                       10 paths
                                                                                                                                           │
                                                                                                                                           ▼
                                                                                                                                      [COMPLETE]
```

**Element inventory for maximum complexity**:

| Element Type         | Count  | Source                                                                                        |
| -------------------- | ------ | --------------------------------------------------------------------------------------------- |
| StepNode             | 12     | Flow steps                                                                                    |
| StartNode            | 1      | Entry point                                                                                   |
| BranchNode (diamond) | 2      | search_and_show ON_SUCCESS/FAIL, promo_check nested                                           |
| BranchTableNode      | 1      | confirm ON_INPUT (10 branches)                                                                |
| Virtual anchor       | 1      | For confirm fan-out bundling                                                                  |
| GatherGroupNode      | 8      | (visible at zoom >= 1.0 only)                                                                 |
| ToolNode             | 4      | search_hotels, check_availability, apply_promo_code, create_booking (visible at zoom >= 0.75) |
| **Total (base)**     | **17** | Without sub-nodes                                                                             |
| **Total (full)**     | **29** | With all sub-nodes visible                                                                    |

**Edge inventory**:

| Edge Type                        | Count                                                  |
| -------------------------------- | ------------------------------------------------------ |
| FlowEdge (forward `then`)        | 11                                                     |
| BranchEdge (from diamonds)       | 4                                                      |
| BackEdge (from confirm branches) | 7                                                      |
| SelfLoopEdge                     | 3 (get_destination, choose_method equiv, confirm ELSE) |
| GatherEdge                       | 8 (at high zoom)                                       |
| ToolEdge                         | 4 (at high zoom)                                       |
| **Total (base)**                 | **25**                                                 |
| **Total (full)**                 | **37**                                                 |

**Sub-flow collapsing strategy**: For this 12-step agent, sub-flow collapsing is optional (threshold is 13+ in Section 12.1). But if enabled, the linear chain `get_destination -> get_dates -> get_guests` (3 steps, no branching) collapses into one `SubFlowNode`:

```
  [START] ──▶ [welcome] ──▶ [Gathering Phase (3 steps)] ──▶ [search_and_show] ──▶ ...
```

This reduces visible node count from 17 to 15 (base) and from 29 to 22 (full).

**Recommended zoom levels for different use cases**:

| Use Case                                   | Recommended Zoom          | What is Visible                                                                                                 |
| ------------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| "What does this agent do?"                 | 0.35-0.5 (fitView result) | All step pills, forward edges, branch indicators. No tools, no gather, no back-edges. Reads like a summary.     |
| "What is the flow structure?"              | 0.5-0.7                   | Step names + icons, branch diamonds, back-edge arcs (top 3 longest). Swim lanes if parallel paths exist.        |
| "I need to edit step X"                    | 0.7-1.0                   | Full step content, tool names, gather badges, all edges. Click a step to open side panel.                       |
| "I am debugging a specific transition"     | 1.0-1.5                   | All sub-nodes visible (tools, gather). Full edge labels. Response text readable. Back-edge conditions readable. |
| "I am comparing two steps' gather configs" | 1.2-2.0                   | GatherGroupNodes fully expanded. Can read field types and validation rules.                                     |

**ELK config**: Uses base scripted config for <= 12 steps. The `hotel_booking_advanced` falls in the "7-12 steps" tier from Section 12.1. Applied overrides:

```typescript
const MIXED_PATTERN_CONFIG = {
  ...SCRIPTED_BASE,
  'elk.layered.spacing.nodeNodeBetweenLayers': '80', // Standard
  'elk.spacing.nodeNode': '50', // Slightly increased for branch vertical spread
  'elk.spacing.edgeEdge': '20', // Increased for back-edge routing
};
```

**Global digressions rendering**: If the agent has `global_digressions` (the Authentication Agent does -- "speak_to_human" and "cancel"), the floating legend panel from Section 11.6 appears in the top-right corner. It does not affect layout.

---

## 17. Agent Detail -- Reasoning Agent Patterns (L2 Complexity)

Reasoning agents do not have deterministic flows. Their L2 visualization is a capability map: goal at the top, tools and constraints below, coordination targets at the bottom. This section covers every complexity tier.

All reasoning agent patterns use the L2 reasoning ELK base config from Section 3.3:

```typescript
const REASONING_BASE = {
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '60',
  'elk.spacing.nodeNode': '32',
  'elk.padding': '[top=32,left=32,bottom=32,right=32]',
};
```

### 17.1 Minimal Reasoning Agent (Goal + 1-2 Tools, No Constraints)

The simplest reasoning agent. Example: a `stock_lookup` agent with a goal and 1-2 tools.

**Expected canvas layout (TB)**:

```
         ┌──────────────────────────────┐
         │         GOAL                 │
         │  "Look up stock prices and   │
         │   provide market data"       │
         │         280x80               │
         └──────────────┬───────────────┘
                        │ (capability edge, dashed)
              ┌─────────┴─────────┐
              ▼                   ▼
     ┌────────────────┐  ┌────────────────┐
     │ get_stock_     │  │ get_market_    │
     │ price          │  │ summary       │
     │                │  │               │
     │ HTTP GET       │  │ HTTP GET      │
     │ /api/stocks    │  │ /api/market   │
     │  200x72        │  │  200x72       │
     └────────────────┘  └────────────────┘
```

**ELK config**: Base config. Two ranks: rank 0 = GoalNode, rank 1 = ToolNodes.

**Node count estimate**: 1 GoalNode + 2 ToolNodes = 3 nodes, 2 CapabilityEdges.

**Semantic zoom behavior**: This graph is so small that semantic zoom never changes the rendering. `fitView` lands at zoom approximately 1.0. All content is always fully visible.

**Side panel for GoalNode**:

```
+-------------------------------------+
|  x  Goal                            |
|  -----------------------------------+
|  [Goal Text]                        |
|  +-------------------------------+  |
|  | Look up stock prices and      |  |
|  | provide market data           |  |
|  +-------------------------------+  |
|  -----------------------------------+
|  [Persona]                          |
|  +-------------------------------+  |
|  | Helpful financial data        |  |
|  | assistant                     |  |
|  +-------------------------------+  |
|  -----------------------------------+
|  [Execution Config]                 |
|  Mode: reasoning                    |
|  Model: (from deployment)           |
|  Max iterations: 10                 |
|  Temperature: 0.7                   |
|  -----------------------------------+
|  [Edit Goal & Persona]              |
+-------------------------------------+
```

### 17.2 Standard Reasoning Agent (Goal + 3-6 Tools + 2-3 Constraints + 1-2 Handoffs)

The typical production reasoning agent. Example: `Booking_Manager` (8 tools, 7 constraints, 4 handoffs, 2 delegates).

**Expected canvas layout (TB)**:

```
                                    ┌──────────────────────────────────┐
                                    │              GOAL                │
                                    │  "Help authenticated users       │
                                    │   manage their reservations"     │
                                    │            280x80                │
                                    └──────────────────┬───────────────┘
                                                       │
                     ┌──────────┬──────────┬───────────┼───────────┬──────────┬──────────┐
                     ▼          ▼          ▼           ▼           ▼          ▼          ▼
               ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
               │list_user_│ │get_book_ │ │check_    │ │check_    │ │get_      │ │modify_   │
               │bookings  │ │details   │ │trip_     │ │change_   │ │change_   │ │booking   │
               │          │ │          │ │status    │ │eligiblty │ │options   │ │          │
               │ HTTP GET │ │ HTTP GET │ │ HTTP GET │ │ HTTP GET │ │ HTTP GET │ │ HTTP POST│
               └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
                                                                          ┌──────────┐ ┌──────────┐
                                                                          │cancel_   │ │get_      │
                                                                          │booking   │ │upgrade_  │
                                                                          │          │ │options   │
                                                                          │ HTTP POST│ │ HTTP GET │
                                                                          └──────────┘ └──────────┘

                     ┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
                     ▼          ▼          ▼          ▼          ▼          ▼          ▼
               ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
               │ pre_     │ │ pre_     │ │ pre_     │ │ pre_     │ │ pre_     │ │ always:  │
               │ change:  │ │ change:  │ │ change:  │ │ cancel:  │ │ cancel:  │ │ must be  │
               │ >24h     │ │ eligible │ │ modif.   │ │ not done │ │ can_mod  │ │ auth'd   │
               │ before   │ │ == true  │ │ fare     │ │          │ │          │ │          │
               └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘

                     ┌──────────────┬──────────────┬──────────────┬──────────────┐
                     ▼              ▼              ▼              ▼              ▼
               ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
               │ HANDOFF:     │ │ HANDOFF:     │ │ HANDOFF:     │ │ HANDOFF:     │
               │ Live_Agent_  │ │ Live_Agent_  │ │ Live_Agent_  │ │ Sales_Agent  │
               │ Transfer     │ │ Transfer     │ │ Transfer     │ │              │
               │ "non-modif." │ │ "insists"    │ │ "req human"  │ │ "new booking"│
               └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘

                                          ┌──────────────┬──────────────┐
                                          ▼              ▼              ▼
                                    ┌──────────────┐ ┌──────────────┐
                                    │ DELEGATE:    │ │ DELEGATE:    │
                                    │ Fee_         │ │ Refund_      │
                                    │ Calculator   │ │ Processor    │
                                    │ "calc fees"  │ │ "process     │
                                    │              │ │  refund"     │
                                    └──────────────┘ └──────────────┘
```

**Rank assignment**: ELK DOWN assigns ranks:

- Rank 0: GoalNode
- Rank 1: ToolNodes (all tools at same rank)
- Rank 2: RuleNodes (all constraints at same rank)
- Rank 3: HandoffTargetNodes
- Rank 4: DelegateNodes (if present)

```typescript
// Explicit rank hints for reasoning agent nodes
function assignReasoningRanks(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    switch (node.type) {
      case 'goal':
        return { ...node, data: { ...node.data, rank: 0 } };
      case 'tool':
        return { ...node, data: { ...node.data, rank: 1 } };
      case 'rule':
        return { ...node, data: { ...node.data, rank: 2 } };
      case 'handoff':
        return { ...node, data: { ...node.data, rank: 3 } };
      case 'gather':
        return { ...node, data: { ...node.data, rank: 4 } };
      default:
        return node;
    }
  });
}
```

**ELK config**: Base reasoning config. With 8 tools side-by-side, `elk.spacing.nodeNode: '32'` produces a total width of approximately `8 * 200 + 7 * 32 = 1824px`.

**Node count estimate**: 1 goal + 8 tools + 7 rules + 4 handoffs + 2 delegates = 22 nodes. CapabilityEdges: 8 (goal->tools) + 7 (goal->rules) + 4 (goal->handoffs) + 2 (goal->delegates) = 21 edges.

**Semantic zoom behavior**:

| Zoom Range | What is Visible                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| < 0.35     | GoalNode as colored pill, tools/rules/handoffs as small dots in rows. Edge lines only.                                          |
| 0.35-0.6   | GoalNode with truncated text. Tool/rule nodes as name-only pills. Handoff nodes as name pills.                                  |
| 0.6-0.8    | GoalNode full text. Tool nodes with name + binding type. Rule nodes with truncated condition. Handoff nodes with name + target. |
| >= 0.8     | Everything visible: tool endpoints, rule full text, handoff conditions, delegate config.                                        |

**Side panel for RuleNode (pre_change: >24h before departure)**:

```
+-------------------------------------+
|  x  Constraint: pre_change          |
|  -----------------------------------+
|  Phase: pre_change                  |
|  -----------------------------------+
|  [Condition]                        |
|  check_trip_status.departure_in_    |
|  hours > 24                         |
|  -----------------------------------+
|  [On Failure]                       |
|  "Changes cannot be made within     |
|  24 hours of departure. For         |
|  emergency changes, I'll connect    |
|  you with our support team."        |
|  -----------------------------------+
|  [Dependencies]                     |
|  Requires tool: check_trip_status   |
|  -----------------------------------+
|  [Edit Constraint]                  |
+-------------------------------------+
```

### 17.3 Tool-Heavy Agent (15+ Tools)

The `Incident_Manager` telco agent has 6 tools, but real production agents can have 15-20+. When tools exceed 6, grouping and collapsing are required.

**Tool grouping strategy** (from Section 12.4, expanded):

Step 1: Group by shared prefix.

```
search_hotels, search_flights, search_cars -> "Search Tools (3)"
book_hotel, book_flight, book_car          -> "Booking Tools (3)"
cancel_hotel, cancel_flight                -> "Cancel Tools (2)"
get_user_profile, get_user_bookings        -> "User Tools (2)"
send_email, send_sms, send_notification    -> "Notification Tools (3)"
validate_payment, process_payment          -> "Payment Tools (2)"
```

Step 2: If prefix grouping produces < 3 groups, fall back to binding-type grouping (HTTP vs MCP vs Lambda).

Step 3: Individual tools that do not fit any group remain ungrouped.

**Expected canvas layout (TB) with 15 tools grouped**:

```
                              ┌────────────────────────┐
                              │          GOAL           │
                              └───────────┬────────────┘
                                          │
          ┌──────────┬───────────┬────────┼────────┬───────────┬──────────┐
          ▼          ▼           ▼        ▼        ▼           ▼          ▼
     ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐
     │ Search   │ │ Booking   │ │ Cancel   │ │ User     │ │ Notific.  │ │ Payment  │
     │ Tools    │ │ Tools     │ │ Tools    │ │ Tools    │ │ Tools     │ │ Tools    │
     │ (3)      │ │ (3)       │ │ (2)      │ │ (2)      │ │ (3)       │ │ (2)      │
     │ > expand │ │ > expand  │ │ > expand │ │ > expand │ │ > expand  │ │ > expand │
     └──────────┘ └───────────┘ └──────────┘ └──────────┘ └───────────┘ └──────────┘
```

**ToolGroupNode rendering**:

```
+============================+
|  Search Tools (3)           |
|  ---------------------------+
|  . search_hotels    HTTP   |
|  . search_flights   HTTP   |
|  . search_cars      HTTP   |
|  ---------------------------+
|  > Click to expand          |
+============================+
```

- Collapsed: width 200px, height `60 + (min(member_count, 3) * 20)px`. Shows tool names in a compact list.
- Expanded: The ToolGroupNode dissolves and its member ToolNodes appear in a horizontal row at the same rank position. Animated with `group-expand` from Section 10.3.

**ELK config overrides for tool-heavy agents**:

```typescript
const TOOL_HEAVY_OVERRIDES = {
  'elk.spacing.nodeNode': '24', // Tighter horizontal spacing (groups are wider than individual tools)
  'elk.layered.spacing.nodeNodeBetweenLayers': '50', // Slightly less vertical space (groups add height)
};
```

**Node count estimate**: 1 goal + 6 group nodes (collapsed) = 7 nodes. Expanded: 1 goal + 15 tool nodes = 16 nodes. With constraints and handoffs: add 5-10 more.

**Semantic zoom behavior**:

| Zoom Range | Tool Rendering                                                   |
| ---------- | ---------------------------------------------------------------- |
| < 0.4      | Tool groups as tiny pills with just the count ("3", "2").        |
| 0.4-0.6    | Group names visible ("Search Tools (3)"). Member names hidden.   |
| 0.6-0.8    | Group with member name list. Collapsed.                          |
| >= 0.8     | Groups expandable on click. Expanded groups show full ToolNodes. |

**Side panel for ToolGroupNode**:

```
+-------------------------------------+
|  x  Tool Group: Search Tools        |
|  -----------------------------------+
|  [Members] (3 tools)                |
|                                     |
|  search_hotels                      |
|    HTTP GET /api/hotels/search      |
|    Params: destination, checkin,    |
|    checkout, guests                 |
|                                     |
|  search_flights                     |
|    HTTP GET /api/flights/search     |
|    Params: origin, destination,     |
|    date, passengers                 |
|                                     |
|  search_cars                        |
|    HTTP GET /api/cars/search        |
|    Params: location, pickup_date,   |
|    return_date                      |
|  -----------------------------------+
|  [Expand on Canvas]                 |
+-------------------------------------+
```

### 17.4 Constraint-Heavy Agent (10+ Rules)

When an agent has 10+ constraints across multiple phases (`pre_change`, `pre_cancel`, `always`, etc.), the rule row becomes very wide.

**Rule grouping strategy**: Group by constraint phase. Each phase becomes a `RuleGroupNode`:

```
pre_change (3 rules)  ->  "Pre-Change Rules (3)"
pre_cancel (3 rules)  ->  "Pre-Cancel Rules (3)"
always (1 rule)       ->  "Always-Active Rules (1)"
pre_resolve (1 rule)  ->  "Pre-Resolve Rules (1)"
```

**Expected canvas layout (TB)**:

```
                              ┌────────────────────────┐
                              │          GOAL           │
                              └───────────┬────────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
              ┌──────────┐         ┌──────────┐         ┌──────────┐
              │ Tool A   │         │ Tool B   │         │ Tool C   │
              └──────────┘         └──────────┘         └──────────┘

                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
          ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
          │ Pre-Change     │   │ Pre-Cancel     │   │ Always-Active  │
          │ Rules (3)      │   │ Rules (3)      │   │ Rules (1)      │
          │ ─────────────  │   │ ─────────────  │   │ ─────────────  │
          │ . >24h before  │   │ . not complete │   │ . must be      │
          │ . eligible     │   │ . can modify   │   │   auth'd       │
          │ . modif. fare  │   │ . >24h before  │   └────────────────┘
          │ > expand       │   │ > expand       │
          └────────────────┘   └────────────────┘
```

**RuleGroupNode rendering**:

```
+============================+
|  Pre-Change Rules (3)       |
|  ---------------------------+
|  . departure_in_hours > 24 |
|  . eligible == true         |
|  . is_modifiable_fare       |
|  ---------------------------+
|  > Click to expand          |
+============================+
```

- Background: `hsl(var(--warning-subtle))`
- Border: `1px solid hsl(var(--warning) / 0.2)`
- Collapsed: Shows truncated condition text per rule
- Expanded: Each rule becomes a full RuleNode

**ELK config**: Base reasoning config. No overrides needed for grouped constraints.

**Node count estimate**: With grouping: 1 goal + N tools + M rule groups + P handoffs. Without grouping: 1 + N + 10+ rules + P. Grouping reduces the constraint tier from 10+ nodes to 3-4 group nodes.

**Semantic zoom behavior**: Same as tool groups. At low zoom, groups are pills with counts. At high zoom, groups are expandable.

**Side panel for RuleGroupNode (Pre-Cancel Rules)**:

```
+-------------------------------------+
|  x  Constraint Group: Pre-Cancel    |
|  -----------------------------------+
|  Phase: pre_cancel                  |
|  Applied before: cancel operations  |
|  -----------------------------------+
|  [Rules] (3 constraints)            |
|                                     |
|  1. Trip not completed              |
|     REQUIRE: is_completed == false  |
|     ON_FAIL: "This trip has         |
|     already been completed..."      |
|                                     |
|  2. Booking modifiable              |
|     REQUIRE: can_modify == true     |
|     ON_FAIL: "This booking type     |
|     cannot be cancelled online..."  |
|                                     |
|  3. >24h before departure           |
|     REQUIRE: departure_in_hours > 24|
|     ON_FAIL: "Cancellations cannot  |
|     be processed within 24 hours.." |
|  -----------------------------------+
|  [Expand on Canvas]                 |
+-------------------------------------+
```

### 17.5 Mixed Mode Agent (Reasoning + Gather Fields + Delegates)

The `Booking_Manager` is the canonical mixed-mode reasoning agent: it has a goal, 8 tools, 7 constraints, 4 handoffs, 2 delegates, AND 5 gather fields. The gather fields add a unique tier to the reasoning capability map.

**Expected canvas layout (TB)**:

```
                              ┌────────────────────────┐
                              │          GOAL           │
                              │  "Help authenticated    │
                              │   users manage their    │
                              │   reservations"         │
                              └───────────┬────────────┘
                                          │
                    ┌─────────────┬────────┼────────┬─────────────┐
                    ▼             ▼        ▼        ▼             ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
              │list_user │ │get_book_ │ │check_    │ │ ...      │ │get_      │
              │_bookings │ │details   │ │trip_stat │ │ (3 more) │ │upgrade_  │
              └──────────┘ └──────────┘ └──────────┘ └──────────┘ │options   │
                                                                   └──────────┘

                    ┌──────────────┬──────────────┬──────────────┐
                    ▼              ▼              ▼              ▼
              ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
              │Pre-Change (3)│ │Pre-Cancel (3)│ │ Always (1)   │ │              │
              └──────────────┘ └──────────────┘ └──────────────┘ │              │
                                                                  └──────────────┘

                    ┌──────────────────────────────────────────────┐
                    ▼                                              ▼
              ┌──────────────────────────┐   ┌──────────────────────────┐
              │ GATHER                   │   │ GATHER                   │
              │ . selected_booking (req) │   │ . change_details         │
              │ . action_type (req)      │   │ . cancellation_reason    │
              │                          │   │ . confirmation           │
              └──────────────────────────┘   └──────────────────────────┘

                    ┌──────────────┬──────────────┬──────────────┬──────────────┐
                    ▼              ▼              ▼              ▼              ▼
              ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
              │ HANDOFF:     │ │ HANDOFF:     │ │ HANDOFF:     │ │ HANDOFF:     │
              │ Live_Agent   │ │ Live_Agent   │ │ Live_Agent   │ │ Sales_Agent  │
              └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘

                              ┌──────────────┬──────────────┐
                              ▼              ▼              ▼
                        ┌──────────────┐ ┌──────────────┐
                        │ DELEGATE:    │ │ DELEGATE:    │
                        │ Fee_Calc     │ │ Refund_Proc  │
                        └──────────────┘ └──────────────┘
```

**Rank assignment for mixed mode**:

| Rank | Content                                                   |
| ---- | --------------------------------------------------------- |
| 0    | GoalNode                                                  |
| 1    | ToolNodes (or ToolGroupNodes if > 6)                      |
| 2    | RuleNodes (or RuleGroupNodes if > 5)                      |
| 3    | GatherGroupNodes (split into required vs optional groups) |
| 4    | HandoffTargetNodes                                        |
| 5    | DelegateNodes                                             |

**Gather field grouping for reasoning agents**: Gather fields split into two groups:

- **Required fields**: `selected_booking`, `action_type` -- these are the agent's primary information needs
- **Optional/contextual fields**: `change_details`, `cancellation_reason`, `confirmation` -- collected only when relevant

Each group is a `GatherGroupNode`:

```
+============================+       +============================+
|  Required Information       |       |  Contextual Information     |
|  ---------------------------+       |  ---------------------------+
|  . selected_booking (string)|       |  . change_details (string) |
|    "Which booking..."       |       |    "What specific..."       |
|  . action_type (string)     |       |  . cancellation_reason     |
|    "What would you like..." |       |    "Could you share..."     |
+============================+       |  . confirmation (boolean)  |
                                      |    "Would you like..."      |
                                      +============================+
```

**ELK config**: Base reasoning config with increased `elk.layered.spacing.nodeNodeBetweenLayers` for the extra ranks:

```typescript
const MIXED_REASONING_OVERRIDES = {
  'elk.layered.spacing.nodeNodeBetweenLayers': '50', // Tighter than base — more ranks to fit
  'elk.spacing.nodeNode': '28', // Slightly tighter — more nodes per row
};
```

**Node count estimate**: 1 goal + 8 tools + 3 rule groups + 2 gather groups + 4 handoffs + 2 delegates = 20 nodes. Edges: 8 + 3 + 2 + 4 + 2 = 19 CapabilityEdges.

**Semantic zoom behavior**: Same tiers as Section 17.2. The gather row follows the same pattern as rule groups: visible as a labeled pill at low zoom, expandable at high zoom.

**Side panel for DelegateNode (Fee_Calculator)**:

```
+-------------------------------------+
|  x  Delegate: Fee_Calculator        |
|  -----------------------------------+
|  Target Agent: Fee_Calculator       |
|  -----------------------------------+
|  [When]                             |
|  action_type == "modify" OR         |
|  action_type == "change_dates" OR   |
|  action_type == "change_passengers" |
|  OR action_type == "upgrade"        |
|  -----------------------------------+
|  [Purpose]                          |
|  Calculate total fees and price     |
|  differences for the requested      |
|  changes                            |
|  -----------------------------------+
|  [Input Mapping]                    |
|  booking_id <- selected_booking     |
|  change_type <- action_type         |
|  changes <- change_details          |
|  -----------------------------------+
|  [Return Mapping]                   |
|  total_fee -> quoted_fee            |
|  breakdown -> fee_breakdown         |
|  -----------------------------------+
|  [Use Result]                       |
|  "Present fee breakdown to          |
|  customer before asking for         |
|  confirmation"                      |
|  -----------------------------------+
|  [Error Handling]                   |
|  Timeout: 10s                       |
|  On Failure: RESPOND "Unable to     |
|  calculate fees right now..."       |
|  -----------------------------------+
|  [Navigate to Agent]                |
|  Click to view Fee_Calculator in L2 |
+-------------------------------------+
```

---

## 18. Agent Detail -- Views & Interactions Deep Dive

This section specifies exactly what the user sees and how they interact with the L2 canvas at every zoom level, covering navigation, pan behavior, centering, side panel interactions, and L1/L2 transitions.

### 18.1 Zoomed-Out Overview (Zoom 0.3-0.5 on a 12-Step Scripted Agent)

This is the "strategic" view. The user wants to understand the overall flow shape without reading details.

**What is visible**:

| Element              | Rendering                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| StepNode             | Compact pill: `120x28`, name only, `text-xs`, rounded-full. Background color indicates type: green for START, muted for regular steps, amber for steps with branching. |
| BranchNode (diamond) | Tiny diamond, `40x24`, no text. Warning-colored.                                                                                                                       |
| BranchTableNode      | Compact pill: `140x28`, shows "confirm (10)" -- name + branch count.                                                                                                   |
| GatherGroupNode      | Hidden entirely.                                                                                                                                                       |
| ToolNode             | Hidden entirely.                                                                                                                                                       |
| FlowEdge             | Thin line, `1px`, reduced opacity (`0.5`). No labels.                                                                                                                  |
| BranchEdge           | Thin line, `1px`, branch-colored (green/amber). No labels.                                                                                                             |
| BackEdge             | Hidden for rank distance <= 3. Shown as faint amber arc for rank distance > 3 (only the 3 longest arcs).                                                               |
| SelfLoopEdge         | Tiny dot indicator at the node corner.                                                                                                                                 |
| Swim lanes           | Hidden.                                                                                                                                                                |
| Digression legend    | Hidden.                                                                                                                                                                |

**ASCII representation of what the user sees**:

```
  [START]─[welcome]─[get_d]─[get_dt]─[get_g]─[search]─◇─[sel_h]─[sel_r]─[promo]─[guest]─[pay]─[review]─[confirm(10)]
                                                         │
                                                         └─[get_d]
```

The entire flow fits in the viewport as a single visual line with one small branch. The shape tells the user: "this is a mostly linear flow with one branch point and a complex decision at the end."

**How edges simplify**: `SmoothStepEdge` is replaced with `StraightEdge` at this zoom level (per Section 10.6). This produces cleaner, simpler lines with less rendering cost.

```typescript
function getEdgePathComponent(zoom: number): typeof SmoothStepEdge | typeof StraightEdge {
  if (zoom < 0.5) return StraightEdge;
  return SmoothStepEdge;
}
```

**Quick-scan use case**: The user opens the agent detail, the canvas fits all nodes in view, and they can immediately tell:

- How many steps the flow has (count the pills)
- Where branching occurs (see diamonds / wide pills)
- Whether there are retry loops (see amber arcs above)
- The overall complexity (linear vs branching vs parallel)

### 18.2 Standard Working View (Zoom 0.5-0.8)

This is the "understanding" zoom level. The user is studying the flow structure, deciding which step to edit, or tracing a path through branches.

**What is visible**:

| Element           | Rendering                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| StepNode          | Summary card: `200x60`, name + activity icons row (respond icon, tool icon, gather icon). Single-line truncated text for respond/tool. |
| BranchNode        | Diamond: `80x48`, shows condition type ("result", "input") but not the full condition text.                                            |
| BranchTableNode   | Table: `280x120`, shows top 5 rows truncated to branch label + target name.                                                            |
| GatherGroupNode   | Hidden. Step shows inline badge: "3 fields" pill.                                                                                      |
| ToolNode          | Hidden. Step shows inline tool name: "search_hotels" as secondary text.                                                                |
| FlowEdge          | `2px` solid line, full opacity. Label hidden for `then` transitions, shown for branch transitions.                                     |
| BranchEdge        | `2px` solid line, branch-colored. Short condition label visible ("success", "failure", "confirm").                                     |
| BackEdge          | All visible. Dashed amber lines with condition labels. Loop indicator badges visible.                                                  |
| SelfLoopEdge      | Small arc with "else" label.                                                                                                           |
| Swim lanes        | Visible as faint background rectangles with lane labels.                                                                               |
| Digression legend | Visible in top-right corner.                                                                                                           |

**ASCII representation**:

```
                                              ╭── ↺(max 3) ──╮
  ╭──── "cancel" -> [welcome] ────────────────╮               │
  │                                            │               │
  ▼                                            │               │
  [START]──▶[welcome     ]──▶[get_dest    ]──▶[get_dates  ]──▶[get_guests ]──▶[search_and_ ]──▶ ◇  ──┬▶[select_hotel]
             RESPOND         GATHER:1f         GATHER:2f       GATHER:2f       show              │     GATHER:1f
                                                                                CALL:search_      │
                                                                                hotels            └▶[get_dest]

  ... ──▶[select_room]──▶[promo_check]──▶[guest_dtl  ]──▶[pay_method  ]──▶[review     ]──▶[confirm(10)]
           GATHER:1f       CALL:apply_     GATHER:3f       GATHER:1-4f      RESPOND         [BranchTable]
                           promo                                                             5 rows shown
```

**Side panel interaction at this zoom**: Clicking any step opens the side panel. The canvas does NOT re-zoom when the side panel opens. The panel overlays the right edge of the canvas. If the clicked node is partially obscured by the panel, the canvas pans left by `panel_width / 2` (200px) over 300ms.

```typescript
function adjustViewportForPanel(
  clickedNodeX: number,
  clickedNodeWidth: number,
  canvasWidth: number,
  panelWidth: number,
): XYPosition | null {
  const nodeRightEdge = clickedNodeX + clickedNodeWidth;
  const visibleWidth = canvasWidth - panelWidth;

  if (nodeRightEdge > visibleWidth) {
    // Node is under the panel — pan left
    const panAmount = panelWidth / 2;
    return { x: -panAmount, y: 0 }; // Delta to apply to viewport
  }
  return null; // No adjustment needed
}
```

**Node selection + edge highlighting**: Clicking a node selects it (accent border + glow). All edges connected to the selected node increase to `3px` stroke width and full opacity. All edges NOT connected to the selected node reduce to 30% opacity. This is the "connected-subgraph highlighting" from Section 13.3, applied at 1-hop distance.

```css
/* When a node is selected, dim unrelated edges */
.react-flow.node-selected .react-flow__edge:not(.edge-connected) path {
  opacity: 0.3;
  transition: opacity var(--duration-fast) var(--ease-out);
}

.react-flow.node-selected .react-flow__edge.edge-connected path {
  stroke-width: 3;
  opacity: 1;
  transition: stroke-width var(--duration-fast) var(--ease-out);
}
```

### 18.3 Zoomed-In Detail (Zoom 0.8-2.0)

This is the "editing" zoom level. The user is reading step content, inspecting tool parameters, or examining gather field configuration.

**What is visible (zoom 0.8-1.0)**:

| Element         | Rendering                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| StepNode        | Full card: `200x100`, name + respond text (2-line clamp) + tool name + gather badge with field names.             |
| BranchNode      | Full diamond: `100x60`, condition text visible.                                                                   |
| BranchTableNode | Full table: `320x200+`, all rows visible, each row shows condition + target + any SET/RESPOND.                    |
| GatherGroupNode | Inline badge with field names: "destination, checkin_date, checkout_date". Not yet expanded to separate sub-node. |
| ToolNode        | Visible below step: name + binding type + endpoint.                                                               |
| All edge types  | Full rendering with labels, loop indicators, condition text.                                                      |

**What is visible (zoom 1.0-2.0)**:

| Element         | Rendering                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| StepNode        | Full card, respond text now 4-line clamp (more text visible).                                                    |
| GatherGroupNode | Fully expanded sub-node below step. Shows each field with type, required indicator, and prompt text (truncated). |
| ToolNode        | Shows parameters table inline: name + type + required for each parameter.                                        |

**ASCII representation at zoom 1.2**:

```
  ┌══════════════════════════════╗
  ║  search_and_show             ║
  ║  ────────────────────────── ║
  ║  RESPOND:                    ║
  ║  "Found {{hotels.length}}    ║
  ║   hotels in {{destination}}: ║
  ║   {{#each hotels}}..."       ║
  ║  ────────────────────────── ║
  ║  CALL: search_hotels         ║
  ╚══════════════════════════════╝
         │
         ▼  (tool detail edge)
  ┌──────────────────────────────┐
  │  search_hotels               │
  │  ──────────────────────────  │
  │  HTTP GET                    │
  │  /api/hotels/search          │
  │  ──────────────────────────  │
  │  Params:                     │
  │  +─────────────+────+─────+  │
  │  │ destination  │str │ req │  │
  │  │ checkin      │date│ req │  │
  │  │ checkout     │date│ req │  │
  │  │ guests       │num │ req │  │
  │  +─────────────+────+─────+  │
  └──────────────────────────────┘
```

**Tool parameters visible in ToolNodes**: At zoom >= 1.0, ToolNodes expand from `200x72` to `200x(72 + param_count * 20)`. The parameter table renders inside the node:

```typescript
function computeToolNodeHeight(tool: ToolDefinition, zoom: number): number {
  const baseHeight = 72;
  if (zoom < 1.0) return baseHeight;
  const paramRows = tool.parameters.length;
  const tableHeight = 24 + paramRows * 20; // Header + rows
  return baseHeight + tableHeight;
}
```

**Gather field names visible**: At zoom >= 0.8, the GatherGroupNode badge expands from "3 fields" to listing the field names:

```
  ┌──── GATHER ─────────────────┐
  │  . guest_name (string, req) │
  │  . guest_email (email, req) │
  │  . guest_phone (string, req)│
  └─────────────────────────────┘
```

**Response text readable**: At zoom >= 1.0, respond text in StepNodes expands from 2-line clamp to 4-line clamp. At zoom >= 1.5, the full respond text is shown (no clamp, node height grows to accommodate).

### 18.4 Pan Behavior & Navigation

**Following a flow path**: The most common interaction is tracing execution from left to right. The user pans horizontally to follow the chain.

- **Mouse drag**: Click-drag on empty canvas. Horizontal panning follows the LR flow naturally.
- **Trackpad horizontal scroll**: Two-finger swipe left/right pans horizontally. This is the primary navigation method on laptops.
- **Scroll wheel**: Vertical scroll on mouse pans vertically (useful for branches). Horizontal scroll pans horizontally if the mouse supports it.

**Keyboard navigation between steps**:

| Key           | Behavior                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tab`         | Move focus to the next step in flow order (follows `then` transitions). If at a branch, Tab moves to the first branch target (alphabetical). |
| `Shift+Tab`   | Move focus to the previous step (reverse flow order).                                                                                        |
| `Right Arrow` | Same as Tab (next step in LR layout).                                                                                                        |
| `Left Arrow`  | Same as Shift+Tab (previous step).                                                                                                           |
| `Up Arrow`    | When at a branch target, move to the sibling branch above (in visual layout, not flow order).                                                |
| `Down Arrow`  | When at a branch target, move to the sibling branch below.                                                                                   |
| `Enter`       | "Click" the focused node -- opens side panel.                                                                                                |
| `Escape`      | Close side panel, deselect all.                                                                                                              |

**Focus follows flow order, not spatial position**: When the user presses Tab on `search_and_show`, focus moves to the diamond branch node, not to whatever node happens to be spatially adjacent. This ensures keyboard navigation traces the execution path.

```typescript
function computeFlowOrder(steps: FlowStep[], entryPoint: string): string[] {
  // BFS from entry point following `then` transitions
  const order: string[] = [];
  const visited = new Set<string>();
  const queue = [entryPoint];

  while (queue.length > 0) {
    const step = queue.shift()!;
    if (visited.has(step)) continue;
    visited.add(step);
    order.push(step);

    const def = steps.find((s) => s.name === step);
    if (!def) continue;

    // Add `then` target
    if (def.then) queue.push(def.then);
    // Add branch targets
    if (def.on_input) def.on_input.forEach((b) => queue.push(b.then));
    if (def.on_success) queue.push(def.on_success.then);
    if (def.on_failure) queue.push(def.on_failure.then);
  }

  return order;
}
```

**Breadcrumb trail for deep flows**: A thin breadcrumb bar at the top of the L2 canvas shows the flow path from START to the currently focused/selected step:

```
  START  >  welcome  >  get_destination  >  get_dates  >  get_guests  >  search_and_show  >  [select_hotel]
```

- Each breadcrumb is clickable: clicking it centers+zooms to that step.
- The breadcrumb updates as the user navigates (Tab, click, search).
- If the path includes a branch, the breadcrumb shows the branch taken: `search_and_show > (success) > select_hotel`.
- Breadcrumb bar styling: `bg-background-subtle/80 backdrop-blur-sm border-b border-muted text-xs font-mono px-4 py-1.5`. Fixed at top of canvas viewport, does not scroll.

### 18.5 Centering & Focus

**Center on entry step (initial load)**: When L2 mounts, after the stagger entrance animation completes (approximately 60ms \* node_count + 200ms for edges), the viewport calls:

```typescript
// Center on the START node, then fitView if the graph is too large
const startNode = nodes.find((n) => n.type === 'start');
if (startNode && nodes.length <= 8) {
  // Small graph: center on start at comfortable zoom
  setCenter(
    startNode.position.x + 40, // Half of START node width
    startNode.position.y + 20, // Half of START node height
    { zoom: 1.0, duration: 400 },
  );
} else {
  // Large graph: fit all nodes
  fitView({ padding: 0.2, maxZoom: 1.0, duration: 400 });
}
```

**Center on a step from search results**: When the user uses the search overlay (Section 10.4) and selects a step:

1. Dim all non-matching nodes to 20% opacity.
2. `setCenter` on the target step at zoom 1.0 with 350ms duration.
3. Apply the `node-attention` pulse animation (Section 2.5) to the target node.
4. If the side panel is open, update its content to the target step.

```typescript
function centerOnSearchResult(nodeId: string) {
  const node = getNode(nodeId);
  if (!node) return;

  // Center viewport
  setCenter(node.position.x + node.width! / 2, node.position.y + node.height! / 2, {
    zoom: 1.0,
    duration: 350,
  });

  // Select the node
  setSelectedNodes([nodeId]);

  // Apply attention pulse
  updateNode(nodeId, {
    className: clsx(node.className, 'node-attention'),
  });

  // Remove pulse after animation completes
  setTimeout(() => {
    updateNode(nodeId, {
      className: node.className?.replace('node-attention', ''),
    });
  }, 600);
}
```

**Center on a step from side panel link**: When the side panel shows "Next Step: -> gather_info" and the user clicks it:

1. `setCenter` on the target step at current zoom level (do not change zoom) with 350ms duration.
2. Update the side panel content to show the target step's details (cross-fade animation, see Section 18.6).
3. Update the selection state to highlight the target step.
4. Update the breadcrumb trail.

**Center + zoom from collapsed sub-flow expand**: When the user clicks "expand" on a `SubFlowNode`:

1. The SubFlowNode dissolves (opacity 0 over 200ms).
2. The contained steps appear at the SubFlowNode's position with `group-expand` animation (Section 10.3).
3. The layout is recomputed for the expanded nodes (ELK runs only on the expanded sub-flow region, preserving positions of all other nodes).
4. `fitView` is called with `nodes: expandedNodeIds` (fit only the expanded nodes, not the entire graph) at zoom 0.8-1.0, duration 400ms.

```typescript
function expandSubFlow(subFlowId: string) {
  const subFlow = getNode(subFlowId);
  if (!subFlow) return;

  const childIds = subFlow.data.childNodeIds;

  // 1. Hide sub-flow node
  updateNode(subFlowId, { hidden: true });

  // 2. Show child nodes with animation
  childIds.forEach((id, i) => {
    updateNode(id, {
      hidden: false,
      data: { ...getNode(id)!.data, entering: true },
      style: { animationDelay: `${i * 60}ms` },
    });
  });

  // 3. Fit view to the expanded region
  setTimeout(
    () => {
      fitView({
        nodes: childIds.map((id) => ({ id })),
        padding: 0.3,
        maxZoom: 1.0,
        duration: 400,
      });
    },
    childIds.length * 60 + 100,
  );
}
```

### 18.6 Side Panel Interactions

**Panel open/close transitions**:

- **Opening**: Panel slides in from the right with `panel-slide-in` animation (Section 2.8): `translateX(24px) -> translateX(0)`, opacity `0 -> 1`, duration `var(--duration-slow)` (300ms), easing `var(--ease-spring)`.
- **Closing**: Reverse animation: `translateX(0) -> translateX(24px)`, opacity `1 -> 0`, duration `var(--duration-normal)` (200ms), easing `var(--ease-out)`.
- **Triggers for close**: Click `x` button, press `Escape`, click on empty canvas area, click the same node again (toggle behavior).

**Cross-step navigation within panel**: The side panel contains clickable links to other steps (next step, branch targets, incoming edges, tool references). When the user clicks one of these links:

1. The panel content cross-fades to the new step's details. This is NOT a close+reopen -- the panel stays open and its content transitions:

```css
@keyframes panel-content-crossfade {
  0% {
    opacity: 1;
    transform: translateY(0);
  }
  40% {
    opacity: 0;
    transform: translateY(-8px);
  }
  60% {
    opacity: 0;
    transform: translateY(8px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

.panel-content-transitioning {
  animation: panel-content-crossfade var(--duration-slow) var(--ease-out) both;
}
```

2. The canvas centers on the new target node (Section 18.5).
3. The selection updates to the new node.
4. The breadcrumb updates.

**Implementation**: The side panel component tracks `previousNodeId` and `currentNodeId`. When `currentNodeId` changes and the panel is already open, it triggers the cross-fade:

```typescript
function usePanelTransition(currentNodeId: string | null) {
  const [transitioning, setTransitioning] = useState(false);
  const prevNodeId = useRef<string | null>(null);

  useEffect(() => {
    if (prevNodeId.current && currentNodeId && prevNodeId.current !== currentNodeId) {
      setTransitioning(true);
      const timer = setTimeout(() => setTransitioning(false), 300);
      return () => clearTimeout(timer);
    }
    prevNodeId.current = currentNodeId;
  }, [currentNodeId]);

  return transitioning;
}
```

**Panel content updating when clicking different nodes**: The content structure changes based on node type. When the user clicks a StepNode, the panel shows step details. When they click a ToolNode, the panel shows tool details. The panel header always shows the node type and name. Below the header, the content section is the part that cross-fades.

**Panel width adjustment for different content types**:

| Node Type                    | Panel Width | Reason                                                        |
| ---------------------------- | ----------- | ------------------------------------------------------------- |
| StepNode                     | 400px       | Standard -- shows respond text, tool, gather, branches        |
| ToolNode                     | 400px       | Standard -- shows params table, binding config                |
| BranchNode / BranchTableNode | 440px       | Wider -- branch conditions can be long, table rows need space |
| GoalNode                     | 400px       | Standard -- goal text + persona                               |
| RuleNode / RuleGroupNode     | 400px       | Standard                                                      |
| GatherGroupNode              | 440px       | Wider -- field definitions with types, validation, hints      |

Width changes are animated: `transition: width var(--duration-normal) var(--ease-out)`. The panel content reflows smoothly.

### 18.7 L1 to L2 Transitions

**Entering L2 from L1 (node click -> transition -> L2 mount)**:

Detailed frame-by-frame specification (expanding Section 2.9):

| Time (ms) | What Happens                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | User clicks an AgentNode on L1. `drillIntoAgent(agentId)` is called.                                                                                                   |
| 0-50      | The clicked node gets `transitioning-target` class. Its z-index is set to 100.                                                                                         |
| 0-300     | `setCenter()` smoothly moves the viewport to center on the clicked node at zoom 1.0.                                                                                   |
| 100-400   | All other nodes and edges begin `node-fade-out` animation (opacity 0, scale 0.9). Duration 300ms.                                                                      |
| 200-500   | The clicked node begins `scale(1.05)` transition.                                                                                                                      |
| 400       | React state changes: `layer` switches from `'project'` to `'agent'`. URL updates to `#agent/{agentName}`. The L2 data transformation (`agentIRToReactFlowNodes`) runs. |
| 400-500   | L1 `<ReactFlow>` unmounts. L2 `<ReactFlow>` mounts with `opacity: 0`.                                                                                                  |
| 500-600   | L2 canvas fades in (`canvas-enter` animation, 200ms).                                                                                                                  |
| 600-900   | L2 nodes stagger in with `step-enter` animation (scripted) or `tier-enter` (reasoning). 60ms per node.                                                                 |
| 900-1200  | L2 edges draw in with stroke-dashoffset animation.                                                                                                                     |
| 1200+     | L2 is fully interactive. `fitView()` called (or `setCenter` on START).                                                                                                 |

**Total transition time**: Approximately 1.0-1.2 seconds for a typical agent with 8-12 steps.

**State preserved during transition**: The L1 viewport state (`{ x, y, zoom }`) is saved to the Zustand store before L2 mounts. The `selectedAgentId` is set. This allows restoration when returning to L1.

**Exiting L2 back to L1 (back button -> transition -> L1 restore)**:

| Time (ms) | What Happens                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | User clicks back button or presses `Escape` (when side panel is closed and nothing is selected). `backToProject()` is called.                |
| 0-200     | L2 nodes play `converge-out` animation (opacity 0, scale 0.85). Duration 200ms.                                                              |
| 200       | React state changes: `layer` switches from `'agent'` to `'project'`. URL updates to remove `#agent/{agentName}`.                             |
| 200-300   | L2 `<ReactFlow>` unmounts. L1 `<ReactFlow>` mounts with `opacity: 0`.                                                                        |
| 300-500   | L1 canvas fades in (`canvas-fade-in`, 200ms).                                                                                                |
| 500-800   | L1 viewport restores to the saved `{ x, y, zoom }` from before the drill-in. The previously selected agent node gets `node-attention` pulse. |
| 800+      | L1 is fully interactive.                                                                                                                     |

**Total return time**: Approximately 0.5-0.8 seconds.

**Clicking a HandoffTargetNode in L2**: HandoffTargetNodes represent edges to other agents. Clicking one should navigate to that agent. Two behaviors depending on context:

**Case A: Target agent exists in the project** -- Navigate to the target agent's L2 directly.

| Time (ms) | What Happens                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | User clicks HandoffTargetNode (e.g., "Booking_Manager").                                                                                                   |
| 0-200     | L2 nodes play `converge-out`.                                                                                                                              |
| 200-400   | Brief L1 flash: L1 mounts, viewport centers on the target agent with 200ms transition. The target agent gets `node-attention` pulse.                       |
| 400-600   | L1 transitions into the target agent's L2 (same as the standard L1->L2 transition, but the center step is skipped since the viewport is already centered). |
| 600-1000  | Target agent L2 mounts, nodes stagger in.                                                                                                                  |

This creates a "through" navigation: L2(Agent A) -> flash L1(centered on Agent B) -> L2(Agent B). The L1 flash is brief (200ms) but visible, maintaining spatial context.

**Case B: Target agent does not exist in the project** (e.g., a remote agent or a handoff to a name that is not compiled). The HandoffTargetNode shows a tooltip: "Agent not found in project. This may be a remote agent or not yet defined." No navigation occurs. The side panel opens with whatever information is available (target name, condition, context passing config).

**URL state management**:

```
Base URL:         /projects/{projectId}/agents
L1 (no hash):     /projects/{projectId}/agents
L1 + selection:   /projects/{projectId}/agents#selected=AgentName
L2:               /projects/{projectId}/agents#agent/AgentName
L2 + step focus:  /projects/{projectId}/agents#agent/AgentName/step/step_name
```

**URL parsing on page load**: On initial page load, the component reads the URL hash:

```typescript
function parseCanvasURL(hash: string): CanvasRoute {
  if (!hash) return { layer: 'project' };

  const agentMatch = hash.match(/^#agent\/([^/]+)$/);
  if (agentMatch) return { layer: 'agent', agentName: agentMatch[1] };

  const stepMatch = hash.match(/^#agent\/([^/]+)\/step\/([^/]+)$/);
  if (stepMatch) return { layer: 'agent', agentName: stepMatch[1], stepName: stepMatch[2] };

  const selectedMatch = hash.match(/^#selected=(.+)$/);
  if (selectedMatch) return { layer: 'project', selectedAgent: selectedMatch[1] };

  return { layer: 'project' };
}
```

If the URL indicates L2 on page load, the component skips the L1->L2 transition animation and directly mounts L2 with the standard entrance animation. If a step name is specified, the canvas centers on that step after mounting.

**Browser back/forward**: `hashchange` events trigger navigation. Pressing browser back from L2 returns to L1 with the standard exit animation. Pressing browser forward from L1 (if L2 was previously visited) re-enters L2 with the standard entrance animation.

---

That is the complete content for Sections 16, 17, and 18. Here is a summary of what was covered:

**Section 16 (Scripted Agent Patterns)** covers 10 distinct flow patterns: linear chain, single diamond, nested diamond, wide fan-out (10-branch ON_INPUT), retry cycles, long-range jumps, parallel verification paths with swim lanes, gather-heavy flows, tool-chain flows, and the "maximum complexity" mixed pattern. Each includes ASCII diagrams, ELK config overrides, node/edge counts, semantic zoom tiers, and full side panel specifications.

**Section 17 (Reasoning Agent Patterns)** covers 5 complexity tiers: minimal (2 tools), standard (8 tools + constraints + handoffs), tool-heavy (15+ tools with grouping), constraint-heavy (10+ rules with phase grouping), and mixed mode (reasoning + gather + delegates). Each includes layout diagrams, rank assignment logic, grouping strategies, and side panel specifications.

**Section 18 (Views & Interactions Deep Dive)** covers 7 interaction areas: zoomed-out overview, standard working view, zoomed-in detail, pan/keyboard navigation, centering/focus behavior, side panel interactions (open/close/crossfade/width adjustment), and complete L1/L2 transition choreography with frame-by-frame timing and URL state management.

## 19. Test Scenarios

This section defines every meaningful test scenario for the Project Canvas and Agent Visualization system. Each scenario specifies exact setup data, user actions, expected visual outcomes, and measurable acceptance criteria. Scenarios are organized by layer and concern.

### 19.1 L1 Project Canvas — Topology Scenarios

---

#### T1: Empty Project (0 Agents)

**Setup**: Project exists with no agents. Topology API returns `{ topology: { nodes: [], edges: [] }, agentSummaries: [], errors: [] }`.

**Action**: User navigates to the project agents page.

**Expected**:

- Canvas renders with an empty viewport (background dot grid visible).
- A centered empty-state illustration appears with the text "No agents yet" and a "Create Agent" primary action button.
- Mini-map renders but is blank. Controls (zoom in/out/fit) are present but zoom buttons are disabled (nothing to zoom to).
- No ELK layout computation occurs (zero nodes).

```
┌──────────────────────────────────────────────┐
│                                              │
│                                              │
│           [ No agents yet ]                  │
│         [ + Create Agent ]                   │
│                                              │
│                                              │
└──────────────────────────────────────────────┘
```

**Acceptance criteria**:

- No JavaScript errors in console.
- `fitView()` is NOT called (no nodes to fit).
- Performance tier: `standard` (0 agents < 10).
- Empty state renders within 200ms of page load.
- "Create Agent" button navigates to the DSL editor.

---

#### T2: Single Agent (No Topology)

**Setup**: Project with 1 reasoning agent (`Hotel_Search`). No supervisor, no handoffs. Topology: 1 node, 0 edges.

**Action**: User navigates to the project agents page.

**Expected**:

- Single `AgentNode` rendered at canvas center.
- Node shows: name "Hotel Search", mode badge "Reasoning", tool count, goal text (2-line clamp), model badge.
- Entry badge with green pulse dot is present (single agent = entry by default).
- No edges rendered.
- `fitView()` centers the single node at zoom 1.0.
- Mini-map shows a single colored dot.

```
┌──────────────────────────────────────────────┐
│                                              │
│         ╔═══════════════════════╗            │
│         ║  ◆  Hotel Search     ║            │
│         ║  Reasoning │ 3 tools ║            │
│         ║  ● Entry             ║            │
│         ║  "Help customers..." ║            │
│         ╚═══════════════════════╝            │
│                                              │
└──────────────────────────────────────────────┘
```

**Acceptance criteria**:

- `fitView()` called once, resulting zoom is between 0.9 and 1.0.
- Performance tier: `standard`.
- Node entrance animation plays (fade-in-scale, 300ms).
- No edge entrance animation (0 edges).
- Click on node triggers L1-to-L2 full-view transition.

---

#### T3: Single Supervisor + 3 Children (Simple Star)

**Setup**: BankNexus project. 1 supervisor (`BankNexus_Supervisor`) + 3 agents (`Get_Balance`, `Fund_Transfer`, `Transaction_History`). 3 handoff edges from supervisor to each child. All are `RETURN: true`.

**Action**: User navigates to the project agents page.

**Expected**:

- ELK DOWN layout produces a 2-rank graph.
- Rank 0: `SupervisorNode` centered at top, with "Entry" badge and green pulse.
- Rank 1: 3 `AgentNode` instances spread horizontally with 80px gaps.
- 3 forward handoff edges (solid indigo) + 3 return edges (dashed, lighter indigo) = 6 total edges rendered.
- Return edges offset by 15px from forward edges (parallel pair rendering).

```
                 ┌───────────────────┐
                 │ BankNexus Supv.   │  rank 0
                 │ SUPERVISOR│Reason.│
                 │ ● Entry           │
                 └─────────┬─────────┘
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
   │ Get_Balance  │ │Fund_Transfer│ │Trans_History│  rank 1
   │  Reasoning   │ │  Reasoning  │ │  Reasoning  │
   └─────────────┘ └─────────────┘ └─────────────┘
```

**Acceptance criteria**:

- Node count = 4, edge count = 6 (3 forward + 3 return).
- `fitView()` lands at zoom between 0.7 and 1.0.
- Performance tier: `standard` (4 agents).
- Layout width: approximately `3 * 260px (node width) + 2 * 80px (gaps) + 2 * 40px (margins)` = ~1020px.
- Stagger animation: rank 0 nodes at delay 0ms, rank 1 nodes at delay 80ms.
- Edges draw in 200ms after last node lands.
- All 3 return edges use `handoff-return` edge type with dashed styling and reversed arrow.

---

#### T4: Single Supervisor + 8 Children (Wide Star)

**Setup**: TravelDesk project (simplified). 1 supervisor (`TravelDesk_Supervisor`) + 8 children (`Welcome_Agent`, `Authentication_Agent`, `Sales_Agent`, `Booking_Manager`, `Payment_Agent`, `Farewell_Agent`, `Fallback_Handler`, `Live_Agent_Transfer`). Mix of return and non-return handoffs.

**Action**: User navigates to the project agents page.

**Expected**:

- ELK DOWN layout, 2 ranks. Rank 1 is very wide (8 nodes _ 260px + 7 _ 80px = 2640px).
- `fitView()` zooms out to fit the wide layout, landing at approximately zoom 0.4-0.6.
- At this zoom, semantic zoom activates: nodes show Full Card (if zoom >= 0.65) or Summary Card (if zoom 0.35-0.65).
- Return handoff edges (to Welcome_Agent, Authentication_Agent, Fallback_Handler) rendered as parallel pairs.
- Non-return handoff edges (to Live_Agent_Transfer, Farewell_Agent) rendered as single solid edges.
- Edge labels visible at Summary zoom level, showing handoff condition summaries.

```
                          ┌─────────────────────┐
                          │ TravelDesk Supv.     │
                          │ SUPERVISOR │ ● Entry │
                          └──────────┬──────────┘
    ┌──────┬──────┬──────┬──────┬────┴───┬──────┬──────┬──────┐
    ▼      ▼      ▼      ▼      ▼        ▼      ▼      ▼
 [Welc.] [Auth] [Sales] [Book] [Paym.] [Fare.] [Fall.] [Live]
```

**Acceptance criteria**:

- Node count = 9, edge count >= 8 (forward handoffs) + N (return edges for RETURN:true handoffs).
- `fitView()` zoom: 0.35 to 0.65 (wide graph).
- Performance tier: `standard` (9 agents < 10).
- All 8 children aligned at rank 1 (same vertical position, within 2px tolerance).
- Node width at Summary zoom: 200px (reduced from 260px).
- No horizontal scrollbar required (canvas pans freely).

---

#### T5: Nested Supervisors (2 Levels, 3+4+2 Agents)

**Setup**: Travel project. Root supervisor `Travel_Supervisor` (rank 0) routes to `Hotel_Supervisor` (sub-supervisor, rank 1), `Flight_Agent` (rank 1), and `Support_Agent` (rank 1). `Hotel_Supervisor` routes to `Search_Agent`, `Booking_Agent`, `Review_Agent`, and `Pricing_Agent` (rank 2). Total: 9 agents, 2 supervisors.

**Action**: User navigates to the project agents page.

**Expected**:

- 3-rank ELK DOWN layout.
- `Travel_Supervisor` at rank 0 (entry).
- `Hotel_Supervisor`, `Flight_Agent`, `Support_Agent` at rank 1.
- `Search_Agent`, `Booking_Agent`, `Review_Agent`, `Pricing_Agent` at rank 2.
- `Hotel_Supervisor` rendered as `SupervisorNode` (accent border, "SUPERVISOR" badge) at rank 1.
- Dashed group boundary drawn around `Hotel_Supervisor` and its 4 children, labeled "Hotel Domain".
- Group node uses accent/3% background fill.

```
                    ┌──────────────────┐
                    │ Travel_Supervisor│  rank 0
                    │    (entry)       │
                    └────────┬─────────┘
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
    ┌─ ─ ─ ─ ─ ─ ─ ─ ┐ ┌────────┐    ┌────────────┐
    │┌──────────────┐  │ │ Flight │    │  Support   │  rank 1
    ││Hotel_Superv. │  │ │ Agent  │    │   Agent    │
    │└──────┬───────┘  │ └────────┘    └────────────┘
    │  ┌──┬─┴──┬──┐    │
    │  ▼  ▼    ▼  ▼    │
    │ [S] [B] [R] [P]  │  rank 2
    └─ ─ ─ ─ ─ ─ ─ ─ ┘
      Hotel Domain group
```

**Acceptance criteria**:

- Node count = 9 (2 supervisors + 7 agents), plus 1 group node.
- Edge count: 3 (root → rank 1) + 4 (hotel_supv → rank 2) = 7 minimum.
- Group boundary renders with dashed border at `accent/0.2` opacity.
- Group sizing: bounding box of `Hotel_Supervisor` + 4 children + 16px padding on all sides.
- `fitView()` zoom: 0.5 to 0.8.
- Performance tier: `standard` (9 agents).
- Both supervisors have accent-colored borders and "SUPERVISOR" badges.
- Only `Travel_Supervisor` has the "Entry" badge.

---

#### T6: Nested Supervisors (3 Levels Deep)

**Setup**: Enterprise project. Root supervisor → 2 domain supervisors → 1 sub-domain supervisor → 2 leaf agents. Total: 3 supervisors + 4 leaf agents = 7 nodes. 3 nesting levels.

**Action**: User navigates to the project agents page.

**Expected**:

- 4-rank ELK DOWN layout (entry → domain supervisors → sub-domain supervisor → leaf agents).
- 2 levels of group boundaries: outer group for domain supervisor + its children, inner group for sub-domain supervisor + its children.
- Inner group boundary is visually nested inside the outer group (smaller, tighter dashed border).
- Per Section 9.1 Pattern B, nesting renders cleanly up to 3 levels. This is the edge case.

```
                    ┌──────────────┐
                    │   Root Supv. │  rank 0
                    └──────┬───────┘
              ┌────────────┴────────────┐
              ▼                         ▼
    ┌─ ─ ─ ─ ─ ─ ─ ─ ─ ┐    ┌──────────────┐
    │ ┌──────────────┐   │    │  Sales Supv. │  rank 1
    │ │  Ops Supv.   │   │    └──────┬───────┘
    │ └──────┬───────┘   │           ▼
    │   ┌─ ─ ┴ ─ ─ ┐    │    ┌──────────────┐
    │   │┌────────┐ │   │    │ Sales Agent  │  rank 2
    │   ││Sub Supv│ │   │    └──────────────┘
    │   │└──┬─────┘ │   │
    │   │ ┌─┴─┐     │   │
    │   │ [A] [B]   │   │    rank 3
    │   └─ ─ ─ ─ ─ ┘    │
    └─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

**Acceptance criteria**:

- 3 nested group boundaries visible, each with progressively tighter padding.
- Innermost group uses same dashed-border styling but at reduced opacity (accent/0.15) to avoid visual heaviness.
- No node overlap between group boundaries and their contents.
- Group labels ("Ops Domain", "Sub-Domain") placed at top-left of each group boundary.
- `fitView()` zoom: 0.5 to 0.8.
- Performance tier: `standard` (7 agents).

---

#### T7: Linear Chain (4 Agents in Sequence)

**Setup**: Pipeline project. 4 agents: `Intake` → `Verify` → `Process` → `Complete`. Each agent has exactly 1 handoff to the next. No supervisor. `Intake` is the entry.

**Action**: User navigates to the project agents page.

**Expected**:

- Pattern detection returns `'chain'` (no supervisors, no bidirectional edges, each node has in-degree <= 1 and out-degree <= 1).
- Layout switches to `elk.direction: 'RIGHT'` (left-to-right) per Section 9.1 Pattern F.
- 4 nodes in a horizontal line, each at its own rank (rank 0 through 3).
- 3 handoff edges connecting them sequentially.
- `Intake` has the "Entry" badge at far left.

```
  ┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐
  │ Intake │───▶│ Verify │───▶│Process │───▶│Complete│
  │● Entry │    │        │    │        │    │        │
  └────────┘    └────────┘    └────────┘    └────────┘
```

**Acceptance criteria**:

- ELK uses `elk.direction: 'RIGHT'`, `elk.layered.layering.strategy: 'LONGEST_PATH'`.
- Node count = 4, edge count = 3.
- All 4 nodes have the same Y position (within 2px tolerance).
- `fitView()` zoom: 0.7 to 1.0.
- Layout width: approximately `4 * 260px + 3 * 100px + 2 * 40px` = ~1420px.
- Performance tier: `standard`.

---

#### T8: Mesh (4 Agents, All Connected to Each Other)

**Setup**: 4 peer agents: `A`, `B`, `C`, `D`. Each hands off to every other agent. A is the entry. 12 directed handoff edges (4 \* 3). Bidirectional pairs: 6.

**Action**: User navigates to the project agents page.

**Expected**:

- Pattern detection returns `'mesh'` (bidirectional pairs / total edges = 6/12 = 0.5 > 0.3).
- Layout switches to `elk.direction: 'RIGHT'`, `elk.spacing.nodeNode: '100'` per Section 9.1 Pattern E.
- Bidirectional edge pairs rendered with 15px offset (parallel lines).
- Dense edge rendering, but hover isolation makes individual edges readable.
- No supervisor nodes, no group boundaries.

```
  ┌────────┐ ◀══▶ ┌────────┐
  │Agent A │      │Agent B │
  │● Entry │      │        │
  └────┬───┘      └───┬────┘
       │     ╲  ╱     │
       │      ╳       │
       │     ╱  ╲     │
  ┌────┴───┐      ┌───┴────┐
  │Agent C │      │Agent D │
  │        │ ◀══▶ │        │
  └────────┘      └────────┘
```

**Acceptance criteria**:

- Node count = 4, edge count = 12 (6 bidirectional pairs \* 2).
- Bidirectional pairs detected: 6.
- Each bidirectional pair renders as 2 offset edges (forward + reverse).
- `fitView()` zoom: 0.6 to 0.9.
- Performance tier: `standard` (4 agents).
- Hover on any edge dims all other edges to 15% opacity.
- Connected-subgraph highlighting on node hover shows all 3 connected edges.

---

#### T9: Return Handoffs (Supervisor -> Auth -> Booking, with Returns)

**Setup**: From TravelDesk. `Supervisor` → `Authentication_Agent` (RETURN: true), then `Authentication_Agent` → `Booking_Manager` (RETURN: true). After auth completes, control returns to supervisor, which then routes to booking. After booking completes, auth handoff returns.

**Action**: User navigates to the project agents page.

**Expected**:

- 3 nodes in a path: Supervisor (rank 0) → Auth (rank 1) → Booking (rank 2).
- Supervisor → Auth: forward handoff edge (solid) + return edge (dashed, lighter).
- Auth → Booking: forward handoff edge (solid) + return edge (dashed, lighter).
- Return edges use `handoff-return` edge type, arrow pointing back at source.
- Edge labels: forward shows "handoff" + condition, return shows "return".

```
  ┌──────────┐     handoff (return:true)    ┌──────────┐     handoff (return:true)    ┌──────────┐
  │Supervisor│ ═══════════════════════════▶  │   Auth   │ ═══════════════════════════▶  │ Booking  │
  │          │ ◁─ ─ ─ ─ ─ return ─ ─ ─ ─ ─ │          │ ◁─ ─ ─ ─ ─ return ─ ─ ─ ─ ─ │          │
  └──────────┘                               └──────────┘                               └──────────┘
```

**Acceptance criteria**:

- Edge count = 4 (2 forward + 2 return).
- Return edges offset by 15px perpendicular to forward edges.
- Return edges have `strokeDasharray: '6,3'` and opacity 0.4 of accent color.
- Return edge arrow markers point toward the source node.
- Side panel for a return edge shows both forward and return configuration.
- `fitView()` zoom: 0.6 to 1.0.

---

#### T10: Mixed Coordination (Handoff + Delegate + Escalate from Same Supervisor)

**Setup**: Full TravelDesk project. `TravelDesk_Supervisor` (entry) with 7 handoff targets (P1-P7), including return handoffs (P4, P6, P7). `Booking_Manager` has 2 delegates (`Fee_Calculator`, `Refund_Processor`), 4 handoffs to `Live_Agent_Transfer` and `Sales_Agent`, and escalation triggers. `Authentication_Agent` has 1 handoff to `Booking_Manager`. Total: ~12 agents, mixed edge types.

**Action**: User navigates to the project agents page.

**Expected**:

- Multi-rank TB layout. Supervisor at top, first-level children below, second-level agents (Fee_Calculator, Refund_Processor, Live_Agent_Transfer) at deeper ranks.
- Edge type mix visible: solid indigo (handoff), dashed animated (delegate), dotted amber (escalate), parallel pairs (return handoffs).
- Escalation target (`Human_Queue`) rendered with `EscalationTargetNode` styling (warning border, person icon, double-border effect).
- Delegate edges from `Booking_Manager` to `Fee_Calculator` and `Refund_Processor` show flowing dash animation.
- Multiple edge types between same nodes (e.g., `Booking_Manager` has both handoff to `Live_Agent_Transfer` and escalation trigger) rendered as stacked offset edges.

**Acceptance criteria**:

- At least 3 distinct edge types visible simultaneously: `handoff`, `delegate`, `escalate`.
- At least 1 `handoff-return` edge pair visible.
- Edge color legend distinguishable: indigo (handoff), muted dashed (delegate), amber dotted (escalate).
- Escalation target node uses warning-subtle background and person icon (not robot/sparkles).
- Delegate edges show flowing dash animation (`dash-flow 1.5s linear infinite`).
- Performance tier: `optimized` (12 agents > 10).
- `onlyRenderVisibleElements={true}` applied.
- Node count >= 12, edge count >= 15.

---

#### T11: Fan-Out (Supervisor Fans Out to 3 Agents Simultaneously)

**Setup**: Travel supervisor uses `__fan_out__` to dispatch to `Flight_Search`, `Hotel_Search`, and `Car_Rental` simultaneously. 3 fan-out edges.

**Action**: User navigates to the project agents page.

**Expected**:

- Supervisor at rank 0, 3 agents at rank 1 (same layout as star pattern T3).
- Fan-out edges use `FanOutEdge` type: purple color (`hsl(var(--purple))`), triple-line visual, closed arrow marker.
- Edge labels show "fan-out" with a split icon.
- Distinct from standard handoff edges (which are indigo solid).

```
                    ┌──────────────┐
                    │  Supervisor  │
                    │   (entry)    │
                    └──────┬───────┘
                           │ fan-out (purple, triple-line)
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐   ┌────────┐   ┌────────┐
         │Flight  │   │ Hotel  │   │  Car   │
         │Search  │   │Search  │   │ Rental │
         └────────┘   └────────┘   └────────┘
```

**Acceptance criteria**:

- 3 edges of type `fan-out` (not `handoff`).
- Edge color: purple (not indigo).
- Edge label includes split icon visual.
- Fan-out edges are solid (not dashed), distinguishing from delegate.
- Performance tier: `standard` (4 agents).

---

#### T12: Remote Agents (2 Local + 1 Remote)

**Setup**: Project with `Supervisor` (local), `Booking_Agent` (local), and `Payment_Service` (remote, `LOCATION: remote`, endpoint `pay.example.com`).

**Action**: User navigates to the project agents page.

**Expected**:

- `Supervisor` and `Booking_Agent` render as standard `SupervisorNode` and `AgentNode`.
- `Payment_Service` renders as `RemoteAgentNode`: dashed info-colored border, globe icon, "Remote (A2A)" badge, endpoint URL shown.
- Remote agent has reduced detail: no tool count, no model badge.
- Handoff edge from `Supervisor` or `Booking_Agent` to `Payment_Service` is standard handoff edge.
- Clicking `Payment_Service` does NOT trigger L1-to-L2 transition. Instead opens side panel with remote config (endpoint, protocol, auth).

```
  ┌──────────────┐    handoff     ┌──────────────┐    handoff     ╔══════════════════╗
  │  Supervisor  │ ──────────────▶│   Booking    │ ──────────────▶║  🌐 Payment Svc  ║
  │   ● Entry   │                │    Agent     │                ║  Remote (A2A)    ║
  └──────────────┘                └──────────────┘                ║  pay.example.com ║
                                                                  ╚══════════════════╝
```

**Acceptance criteria**:

- Remote node has `border: 2px dashed hsl(var(--info))`.
- Remote node background: `hsl(var(--info-subtle))`.
- Remote node shows globe icon, not sparkles/network icon.
- Click on remote node opens side panel (not L2 transition).
- Side panel shows: endpoint URL, protocol type, auth method.
- Performance tier: `standard` (3 agents).

---

#### T13: Escalation Paths (3 Agents Each Escalating to Human Queue)

**Setup**: 3 agents (`Agent_A`, `Agent_B`, `Agent_C`) each have `ESCALATE` triggers. All escalate to the same logical human queue "Support Queue". 1 supervisor routes to all 3. Total: 4 AI agents + 1 escalation target node.

**Action**: User navigates to the project agents page.

**Expected**:

- Supervisor at rank 0, 3 agents at rank 1, `EscalationTargetNode` at rank 2 (bottom of graph, no outgoing edges).
- 3 escalate edges (dotted amber, diamond marker) converge on the human queue node.
- Human queue node: double-border effect, person icon, warning-subtle background, shows "Priority: high" and skills tags.
- `EscalationTargetNode` visually distinct from all AI agent nodes.

```
                 ┌──────────────┐
                 │  Supervisor  │  rank 0
                 └──────┬───────┘
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  rank 1
   │  Agent_A    │ │  Agent_B    │ │  Agent_C    │
   └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
          │ escalate       │ escalate       │ escalate
          └────────────────┼───────────────┘
                           ▼
                  ╔══════════════════╗
                  ║  👤 Support Queue ║  rank 2
                  ║  Priority: high  ║
                  ╚══════════════════╝
```

**Acceptance criteria**:

- 1 `EscalationTargetNode` rendered with warning styling.
- 3 escalate edges all converge on the same target node.
- Escalate edges: `strokeDasharray: '4,4'`, color amber, diamond marker.
- Human queue node has no outgoing edges (ELK places at bottom rank).
- Node count = 5 (4 AI + 1 escalation target), edge count >= 6 (3 handoff + 3 escalate).
- Performance tier: `standard`.

---

#### T14: Large Project (15 Agents, 2 Supervisors, Mixed)

**Setup**: Saludsa-imported project. 1 root supervisor + 15 specialized agents (Password_Reset, Refund_Status, Refund_Guidance, Contract_Data, Contract_Sending, Pending_Payments, Coverage_Certificates, Other_Services, Transfer_Services, Farewell_Handler, Fallback_Handler, Whatsapp_User_Check, Greetings_Br_And_Broker, Transfer_To_Sac, Pca_Xpr_Transfer, Transfer_To_Vitality). Total: 16 nodes. All handoffs from supervisor.

**Action**: User navigates to the project agents page.

**Expected**:

- Wide 2-rank TB layout. Supervisor at top, 15 children spread across rank 1.
- Layout width: approximately `15 * 200px + 14 * 60px` = 3840px at optimized spacing.
- `fitView()` zooms out significantly, landing around zoom 0.3-0.5.
- At zoom 0.3-0.5, semantic zoom renders nodes as Summary Cards (name + mode + count).
- Node entrance animation stagger is capped at 15 nodes (per Optimized tier). Remaining nodes appear instantly.
- `onlyRenderVisibleElements={true}` is enabled.

**Acceptance criteria**:

- Node count = 16, edge count = 15 (minimum, 1 handoff per child).
- Performance tier: `optimized` (16 agents, 11-30 range).
- Semantic zoom active: nodes render as Summary Card at default fitView zoom.
- Stagger animation capped at 15 nodes.
- `fitView()` zoom: 0.3 to 0.5.
- Layout uses `elk.layered.spacing.nodeNodeBetweenLayers: '100', elk.spacing.nodeNode: '60'` (16-30 agent config).
- Mini-map correctly reflects all 16 nodes with supervisor colored accent.

---

#### T15: Very Large Project (30+ Agents, Nested Supervisors, Mixed)

**Setup**: Enterprise telco project extended. 1 root supervisor (`NOC_Supervisor`), 6 specialist agents, plus 3 sub-supervisors each with 3-5 children. Total: 35 agents, 4 supervisors. Mix of handoffs, return handoffs, escalation paths.

**Action**: User navigates to the project agents page.

**Expected**:

- Performance tier: `scaled` (31-80 range).
- ELK uses `elk.layered.layering.strategy: 'NETWORK_SIMPLEX'` for faster layout.
- Semantic zoom renders Compact Pills at default zoom (zoom likely < 0.35).
- Supervisor groups auto-collapsed by default. Each of the 3 sub-supervisor groups shows as a single `GroupNode`.
- Canvas shows: root supervisor + 6 direct children + 3 collapsed group nodes = 10 visible nodes.
- Expanding a group reveals its children with staggered animation.
- Edge animations disabled (no dash-flow on delegate edges, no edge-draw entrance).
- No `box-shadow` on hover (simplified CSS for performance).

**Acceptance criteria**:

- Performance tier: `scaled`.
- `elk.layered.layering.strategy: 'NETWORK_SIMPLEX'` used in ELK config.
- Layout spacing: `elk.layered.spacing.nodeNodeBetweenLayers: '80', elk.spacing.nodeNode: '50'`.
- Groups collapsed by default: 3 `GroupNode` instances visible, each showing "N agents (1 supervisor)".
- Expanding a group: children appear with `group-expand` animation (300ms, spring easing).
- Total node count when all expanded: 35 + 4 group nodes.
- Edge animations: `animation: none` for delegate dash-flow.
- `fitView()` zoom: 0.2 to 0.4.
- Viewport culling active: `onlyRenderVisibleElements={true}`.

---

#### T16: Extreme Project (50+ Agents)

**Setup**: Synthetic stress test. 50 agents organized under 5 supervisors, each with 8-12 children. 1 root supervisor. Nested 2 levels. ~60 handoff edges, ~10 delegate edges, ~5 escalation edges.

**Action**: User navigates to the project agents page.

**Expected**:

- Performance tier: `scaled` (50 agents, 31-80 range).
- All supervisor groups collapsed by default.
- At collapsed state: 1 root supervisor + 5 group nodes visible = 6 visible nodes.
- ELK layout completes in under 200ms (NETWORK_SIMPLEX layering, only 6 nodes to layout).
- `fitView()` at zoom 0.4-0.6 for the collapsed view.
- Expanding all groups shows 50+ nodes. At this point, compact pill rendering activates (zoom < 0.35).
- Edge simplification: `StraightEdge` replaces `SmoothStepEdge` below zoom 0.3.

**Acceptance criteria**:

- No frame drops during initial render (60fps maintained).
- ELK layout time < 200ms for collapsed view.
- ELK layout time < 500ms for fully expanded view (50+ nodes).
- Memory usage increase < 50MB from empty state.
- Performance tier: `scaled`.
- Collapsed group nodes correctly show agent count and supervisor count.
- External edges from collapsed groups re-route to group nodes.
- `fitView()` smooth transition (no jank).

---

#### T17: Compilation Error (3 Agents, 1 Fails to Compile)

**Setup**: Project with 3 agents. 2 compile successfully, 1 fails (e.g., deprecated `MODEL:` section causes compilation failure). Topology API returns partial data: 2 nodes with full summaries, 1 node with error and fallback data from `buildClientTopology()`.

**Action**: User navigates to the project agents page.

**Expected**:

- 3 nodes rendered. The failed agent's node shows an error indicator.
- Error agent node: red error border (`border: 2px solid hsl(var(--error))`), error badge with exclamation icon, goal text extracted from raw DSL (client-side fallback).
- Edges to/from the error agent are rendered with reduced confidence (dashed, lower opacity) since handoff targets may be uncertain.
- Error state does NOT prevent the rest of the canvas from being interactive.
- Tooltip on error agent shows: "Compilation failed: [error message]".

**Acceptance criteria**:

- All 3 nodes render (no missing nodes due to compilation failure).
- Error agent has visible error indicator: red border + error badge.
- Error agent node is clickable: opens side panel showing compilation error details.
- Error agent does NOT support L2 transition (no IR available). Click opens side panel instead.
- Client-side fallback data (goal, tools, mode from DSL parsing) displayed in the error node.
- Non-error agents function normally (click → L2 transition works).
- Performance tier: `standard`.

---

#### T18: Bidirectional Handoffs (A <-> B)

**Setup**: 2 agents, each hands off to the other with different conditions. `Agent_A` → `Agent_B` (WHEN: needs_booking), `Agent_B` → `Agent_A` (WHEN: needs_verification). Both are standard handoffs (not RETURN: true).

**Action**: User navigates to the project agents page.

**Expected**:

- 2 nodes rendered.
- 2 edges between them, rendered as a parallel offset pair (one at +15px, one at -15px).
- Each edge has its own direction, label, and condition.
- Per Section 13.1, bidirectional pairs detected during `preprocessEdges()`.
- Edge labels do not overlap (offset separates them vertically).

```
  ┌────────────┐  ═══▶ "needs_booking" ═══▶  ┌────────────┐
  │  Agent_A   │                               │  Agent_B   │
  │  ● Entry   │  ◁─── "needs_verification" ──│            │
  └────────────┘                               └────────────┘
```

**Acceptance criteria**:

- 2 edges rendered, not overlapping.
- Offset between edges: 30px total (15px each direction from center).
- Each edge has its own arrow direction and label.
- Hover on one edge dims the other.
- Side panel for each edge shows its specific condition.

---

#### T19: Multi-Edge (Handoff + Delegate Between Same Pair)

**Setup**: `Booking_Manager` has both a handoff AND a delegate to `Fee_Calculator`. Handoff: "WHEN: user insists on manual calculation". Delegate: "Calculate fees for changes".

**Action**: User navigates to the project agents page.

**Expected**:

- 2 edges between `Booking_Manager` and `Fee_Calculator`.
- Handoff edge: solid indigo, closed arrow.
- Delegate edge: dashed animated, muted color, open arrow.
- Edges stacked with 20px offset (per Section 13.2).
- Both visually distinct by color AND line style.

```
  ┌────────────────┐ ═══════════════▶ ┌────────────────┐
  │Booking_Manager │ (handoff, solid)  │ Fee_Calculator │
  │                │ ─ ─ ─ ─ ─ ─ ─ ▷ │                │
  └────────────────┘ (delegate, dashed)└────────────────┘
```

**Acceptance criteria**:

- 2 edges of different types between same pair.
- Handoff edge at offset 0, delegate edge at offset +20px.
- Both edge labels visible and non-overlapping.
- Delegate edge has flowing dash animation.
- Hover on handoff edge dims delegate edge and vice versa.

---

#### T20: Agent with No Incoming Edges (Orphan)

**Setup**: Project with 1 supervisor + 3 agents. One additional agent (`Utility_Agent`) exists in the project but is not referenced by any handoff, delegate, or escalation. It has no incoming or outgoing edges.

**Action**: User navigates to the project agents page.

**Expected**:

- 5 nodes rendered. 4 form the standard star pattern. `Utility_Agent` is placed by ELK at a separate position (likely same rank as other leaf agents but offset to the side).
- `Utility_Agent` has no edges connected to it. It appears visually isolated.
- No "Entry" badge on `Utility_Agent`.
- A subtle visual indicator: reduced opacity (0.7) or a small "disconnected" badge.
- ELK places the orphan node at the margin of the layout, not overlapping the connected graph.

**Acceptance criteria**:

- Orphan node renders at its ELK-computed position (not at 0,0).
- Orphan node is interactive (clickable, triggers L2 transition).
- Orphan node has no connection handles highlighted on hover (no edges to highlight).
- `fitView()` includes the orphan node in its bounding box calculation.
- Orphan node's opacity or badge indicates it is disconnected.
- Performance tier: `standard` (5 agents).

---

### 19.2 L2 Agent Detail — Scripted Agent Scenarios

---

#### S1: Minimal Scripted Agent (2 Steps: Greet -> Respond)

**Setup**: Agent with `MODE: scripted`, FLOW with 2 steps: `greet` (RESPOND + THEN: farewell) and `farewell` (RESPOND + THEN: COMPLETE).

**Action**: User clicks the agent node on L1 canvas.

**Expected**:

- L1-to-L2 transition: zoom to node (300ms) → node expands, others fade (200ms) → L2 canvas mounts (200ms).
- L2 canvas shows 3 nodes: `StartNode` → `StepNode(greet)` → `StepNode(farewell)`.
- 2 `FlowEdge` connections: Start → greet, greet → farewell.
- ELK RIGHT layout. All nodes in a horizontal line.
- `fitView()` at zoom ~1.0 (very few nodes, fits easily).
- Both step nodes show response text (full detail at zoom >= 0.75).
- No BranchNodes, no GatherGroupNodes, no ToolNodes.

```
  ┌─────────┐     ┌──────────┐     ┌──────────┐
  │  START   │────▶│  greet   │────▶│ farewell │
  └─────────┘     │ 💬 resp. │     │ 💬 resp. │
                  └──────────┘     └──────────┘
```

**Acceptance criteria**:

- L1-to-L2 transition total time: ~600ms.
- L2 node count = 3 (start + 2 steps), edge count = 2.
- `fitView({ padding: 0.2, maxZoom: 1.2 })` lands at zoom 0.9-1.2.
- Nodes are not draggable (L2 layout is auto-computed).
- Back button / breadcrumb visible. Click returns to L1.
- URL hash updated to `#agent/[agentName]`.

---

#### S2: Linear 5-Step Flow (No Branching)

**Setup**: `Simple_Booking_Flow` agent. 5 steps: `welcome` → `get_destination` → `get_dates` → `search` → `book`. 2 tools (`search_hotels`, `create_booking`). 3 gather steps.

**Action**: User clicks the agent node on L1 canvas.

**Expected**:

- L2 canvas shows 6 nodes: Start + 5 StepNodes, in a horizontal line (LR layout).
- 5 FlowEdges connecting them sequentially.
- `get_destination` step shows gather badge: "1 field" (destination).
- `get_dates` step shows gather badge: "2 fields" (checkin_date, checkout_date).
- `search` step shows tool icon: "search_hotels".
- `book` step shows both gather badge ("1 field") and tool icon ("create_booking").
- GatherGroupNodes attached to gather-heavy steps via short dashed edges.

```
  [START]──▶[welcome]──▶[get_dest]──▶[get_dates]──▶[search]──▶[book]
                          📋 1 field   📋 2 fields   🔧 search  🔧 create
                                                      _hotels    📋 1 field
```

**Acceptance criteria**:

- Node count = 6 (start + 5 steps), plus 3 GatherGroupNodes = 9 total nodes.
- FlowEdge count = 5. GatherEdge count = 3.
- `fitView()` zoom: 0.5 to 0.8.
- Steps appear with staggered animation: 60ms delay between each (total: 5 \* 60ms = 300ms).
- ELK config: `elk.direction: 'RIGHT', elk.layered.spacing.nodeNodeBetweenLayers: '80', elk.spacing.nodeNode: '40'` (<=8 steps).
- Each step click opens side panel with step details.

---

#### S3: Single Binary Branch (ON_SUCCESS / ON_FAILURE)

**Setup**: Agent with 4 steps: `welcome` → `search` (CALL: search_hotels, ON_SUCCESS → `show_results`, ON_FAIL → `no_results`). `show_results` → COMPLETE. `no_results` → `welcome`.

**Action**: User clicks agent node on L1 canvas.

**Expected**:

- L2 canvas shows: Start → `welcome` → `search` → BranchNode (diamond) → two paths.
- BranchNode has 2 outgoing edges: "success" (green label) → `show_results`, "failure" (red label) → `no_results`.
- `no_results` has an edge back to `welcome` (back-edge, rendered as curved dashed line).
- Diamond node: 80x48, warning-subtle background, "?" content.

```
  [START]──▶[welcome]──▶[search]──▶ ◇ ───success──▶ [show_results]
                  ▲                  │
                  │                  └──failure──▶ [no_results]
                  │                                    │
                  └────── back-edge (retry) ───────────┘
```

**Acceptance criteria**:

- BranchNode renders as diamond shape (rotated 45 degrees).
- 2 branch edges: "success" labeled green, "failure" labeled amber/red.
- Back-edge from `no_results` to `welcome` detected by DFS, excluded from ELK layout, rendered as curved path.
- Back-edge uses warning color, dashed line, loop icon at midpoint.
- Back-edge has loop-pulse animation (2s cycle).
- Total nodes: 5 (start, welcome, search, diamond, show_results, no_results) = 6.

---

#### S4: Multi-Way Branch (ON_INPUT with 4 Branches)

**Setup**: `ON_Input_Test` agent. `choose_action` step has `ON_INPUT` with 4 branches: "back" → `get_name`, "1" → `action_result`, "greeting" → `action_result`, "2"/"change name" → `get_name`, "3"/"finish" → `action_result`, else → `choose_action`.

**Action**: User clicks agent node on L1 canvas.

**Expected**:

- `choose_action` step followed by a BranchNode (diamond, since <= 4 distinct targets).
- Diamond has 4 outgoing edges: to `get_name`, to `action_result` (x2 conditions merge into 1 edge), to `choose_action` (self-loop).
- Self-loop on `choose_action` rendered as small circular arc on right side of node.
- Multiple ON_INPUT conditions pointing to same target collapsed into a single edge with combined label.

```
  [START]──▶[get_name]──▶[choose_action]──▶ ◇ ──"1","greeting","3"──▶ [action_result]
                  ▲              ▲           │
                  │              │           ├──"back","2","change"──▶ [get_name]
                  │              │           │
                  │              └───else────┘ (self-loop)
                  │
                  └──────────────────────────┘
```

**Acceptance criteria**:

- BranchNode (diamond) renders with <= 4 outgoing edges (standard diamond, not table).
- Self-loop edge on `choose_action`: circular arc, warning color, dashed.
- Back-edges from `choose_action` to `get_name` detected and rendered as curved paths.
- Edge labels show combined conditions where multiple ON_INPUT branches target the same step.
- Total distinct target steps from branch: 3 (get_name, action_result, choose_action).

---

#### S5: High Fan-Out Branch (ON_INPUT with 8 Branches)

**Setup**: `hotel_booking_advanced` agent, `confirm` step. ON_INPUT with 8 branches targeting 7 distinct steps: confirm → COMPLETE, back → payment_method, cancel → welcome, change destination → get_destination, change date → get_dates, change hotel → select_hotel, change room → select_room, else → confirm (self-loop).

**Action**: User clicks agent node on L1 canvas, navigates to L2.

**Expected**:

- `confirm` step followed by a `BranchTableNode` (NOT diamond — > 4 branches triggers table rendering).
- BranchTableNode (320px wide) shows a table of conditions → targets. First 5 shown, "+ 3 more" collapsible.
- Each target link in the table is clickable (centers on target node + attention pulse).
- Virtual gathering point (invisible node) placed 40px right of branch table, individual edges fan out from there.
- Several back-edges detected: confirm → welcome (8 ranks back), confirm → get_destination (7 ranks back), etc.
- Long-range edges rendered with increased curvature offset (60px+ for jumps > 4 ranks apart).

```
  [...prior steps...]──▶[confirm]──▶ ╔═════════════════════════════════╗
                                      ║  ◇ confirm — Branching (8 paths)║
                                      ║  "confirm"    → [complete]      ║
                                      ║  "back"       → [payment]       ║
                                      ║  "cancel"     → [welcome]       ║
                                      ║  "change dest"→ [get_dest]      ║
                                      ║  "change date"→ [get_dates]     ║
                                      ║  + 3 more...  [expand]          ║
                                      ╚═════════════════════════════════╝
```

**Acceptance criteria**:

- `BranchTableNode` used (not `BranchNode` diamond) because branch count > 4.
- Table shows first 5 branches, collapsible "expand" for remaining 3.
- Virtual gather node inserted: `opacity: 0, width: 1, height: 1`.
- Long-range back-edges (confirm → welcome, 8+ ranks apart) use curvature offset >= 60px.
- Self-loop on confirm rendered as circular arc.
- Hover on any long-range edge dims all other edges to 10% opacity.
- Clicking a target link in the table: `setCenter()` on target node (350ms transition) + attention-pulse animation.

---

#### S6: Nested Branches (Branch Within a Branch)

**Setup**: Agent where step `search_and_show` has ON_SUCCESS/ON_FAIL (binary branch), and within the success path, `select_hotel` has ON_INPUT with 3 branches (back, filter, select).

**Action**: User clicks agent node on L1 canvas.

**Expected**:

- Two BranchNodes in the flow graph.
- First diamond after `search_and_show`: success → `select_hotel`, failure → `get_destination` (back-edge).
- Second diamond after `select_hotel`: "back" → `get_guests` (back-edge), "filter" → `search_and_show` (back-edge), select → `select_room`.
- ELK handles nested branching by placing both diamonds in sequence with their respective targets.
- No visual confusion between the two branch points.

**Acceptance criteria**:

- 2 BranchNode diamonds visible in the flow.
- Each diamond has distinct outgoing edges with clear labels.
- Back-edges from both branches rendered as curved dashed lines.
- Flow is readable left-to-right: the nested branch appears to the right of the first branch's success path.
- No edge crossings between the two branch regions (ELK separates them vertically).

---

#### S7: Simple Cycle (Retry Loop: A -> B -> A)

**Setup**: Agent with `email_code_sent` → `email_code_verify`. On failure, `email_code_verify` → `email_code_sent` (retry). On success, → `auth_success`.

**Action**: User clicks agent node on L1 canvas.

**Expected**:

- Forward flow: `email_code_sent` → `email_code_verify` → diamond → success: `auth_success`, failure: back-edge to `email_code_sent`.
- Back-edge detected by DFS (email_code_verify → email_code_sent creates cycle).
- Back-edge rendered as curved dashed line routing above the forward flow.
- Loop icon (↺) at back-edge midpoint.
- Loop-pulse animation on back-edge (2s cycle, opacity 0.6-1.0).
- Back-edge label: "failure (retry)".

```
              ┌────── back-edge (retry) ──────┐
              │                                │
              ▼                                │
  [email_code_sent]──▶[email_code_verify]──▶ ◇ ──failure─┘
                                              │
                                              └──success──▶ [auth_success]
```

**Acceptance criteria**:

- Back-edge excluded from ELK layout computation.
- Back-edge path curves above the forward nodes (not crossing through them).
- Back-edge color: amber/warning.
- Back-edge has `strokeDasharray: '6,3'`.
- Loop icon visible at edge midpoint.
- Forward edge "success" labeled green, "failure" labeled amber.

---

#### S8: Complex Cycles (Authentication Agent: 2 Parallel Paths, Each with Retry Loops, Merge at Success/Locked)

**Setup**: Full `Authentication_Agent` from TravelDesk. 10 steps: `check_recent_auth` → `choose_method` → (email path: `email_flow_start` → `email_enter` → `email_code_sent` → `email_code_verify`) OR (booking path: `booking_ref_flow` → `booking_ref_verify`) → merge at `auth_success` or `auth_locked`. Multiple cycles: email_code_verify → email_code_sent (retry), booking_ref_verify → booking_ref_flow (retry), email_enter → email_flow_start (invalid email retry), email_enter → choose_method (account not found).

**Action**: User clicks `Authentication_Agent` on L1 canvas.

**Expected**:

- L2 canvas shows the full authentication flow with two parallel paths after `choose_method`.
- `choose_method` has ON_INPUT branch: "email" → `email_flow_start`, "booking" → `booking_ref_flow`, else → self-loop.
- Email path and booking path run in parallel vertical lanes.
- Both paths converge at `auth_success` and `auth_locked` (fan-in merge points).
- 4+ back-edges detected: email retry, booking retry, invalid email retry, choose_method self-loop.
- Merge nodes (`auth_success`, `auth_locked`) show funnel indicator (3+ incoming edges).
- `auth_locked` has a tool call to `lock_account` shown in its step node.

```
  [START]──▶[check_recent_auth]──▶ ◇ ──verified──▶[auth_success]
                                   │
                                   └──not verified──▶[choose_method]──▶ ◇
                                                        ▲ self-loop     │
                                                        │          ┌────┴────┐
                                                        │     "email"   "booking"
                                                        │          │         │
                                                        │          ▼         ▼
                                                        │  [email_flow]  [booking_ref]
                                                        │      │              │
                                                        │      ▼              ▼
                                                        │  [email_enter] [booking_verify]
                                                        │      │  ▲           │  ▲
                                                        │      ▼  │ retry     ▼  │ retry
                                                        │  [code_sent]    [auth_success]
                                                        │      │          [auth_locked]
                                                        │      ▼
                                                        │  [code_verify]──▶[auth_success]
                                                        │      │
                                                        │      └──▶[auth_locked]
                                                        │
                                                        └─ account not found ─┘
```

**Acceptance criteria**:

- Total step nodes: 10 + 1 start = 11 minimum.
- Back-edge count >= 4 (email retry, booking retry, invalid email, choose_method self-loop).
- 2 parallel vertical paths visible (email path and booking path separated by ELK `elk.spacing.nodeNode`).
- Merge nodes (`auth_success`, `auth_locked`) have funnel indicator.
- `auth_success` has >= 3 incoming edges.
- ELK config: `elk.direction: 'RIGHT', elk.layered.spacing.nodeNodeBetweenLayers: '70', elk.spacing.nodeNode: '35'` (9-15 steps).
- `fitView()` zoom: 0.4 to 0.7.
- Self-loop on `choose_method`: circular arc on right side of node.
- All back-edges have loop icon and loop-pulse animation.
- Global digressions ("speak_to_human", "cancel") shown in floating legend panel at top-right.

---

#### S9: Self-Loop (Step -> Itself)

**Setup**: Agent with `choose_method` step where else branch goes back to `choose_method` itself. Also `select_hotel` → `select_hotel` on invalid input.

**Action**: User clicks agent node on L1.

**Expected**:

- Self-loop edge rendered as small circular arc on the right side of the step node.
- Arc radius: 24px.
- Self-loop uses warning color, dashed line (`strokeDasharray: '4,3'`), arrow marker.
- Self-loop label: "else" or "invalid input".
- Self-loop does not interfere with other edges entering/leaving the node.

**Acceptance criteria**:

- `SelfLoopEdge` type used (not `BackEdge` or `FlowEdge`).
- Arc rendered as SVG `A` command (elliptical arc).
- Self-loop arrow points back to the same node.
- Self-loop does not overlap with incoming or outgoing flow edges.
- Self-loop visible at zoom >= 0.4.

---

#### S10: Long-Range Jump (Confirm -> Welcome, 8 Steps Apart)

**Setup**: `hotel_booking_advanced`. The `confirm` step has ON_INPUT "cancel" → `welcome`. These steps are 10 steps apart in the flow (confirm is step 12, welcome is step 1).

**Action**: User navigates to L2 for this agent.

**Expected**:

- Long-range back-edge from `confirm` to `welcome`.
- Edge curvature offset: `60 + (10 - 4) * 10 = 120px` (per `computeEdgeCurvature`).
- The back-edge routes far above (or below) the main flow to avoid crossing through all intermediate nodes.
- Hover on this edge: all other edges dim to 10% opacity, making this long-range connection clearly visible.
- Edge label: "cancel → restart".

**Acceptance criteria**:

- Back-edge curvature offset >= 60px (rank distance > 4).
- Edge does not cross through any intermediate step nodes (routes above/below).
- Hover dimming: all other edges at opacity 0.1 when this edge is hovered.
- Edge is clickable: side panel shows "Long-range transition from confirm to welcome, condition: cancel".
- Edge visible even at low zoom (drawn as simplified straight line below zoom 0.3).

---

#### S11: Gather-Heavy (Every Step Has Gather Fields)

**Setup**: `hotel_booking_flow` agent. Steps: `welcome` (no gather), `get_destination` (1 field), `get_checkin` (1 field), `get_checkout` (1 field), `get_guests` (1 field), `search_hotels` (tool call, no gather), `present_options` (no gather), `get_selection` (1 field), `get_guest_details` (3 fields), `confirm_booking` (tool call). 6 out of 10 steps have gather fields.

**Action**: User clicks agent on L1.

**Expected**:

- L2 canvas shows 11 nodes (start + 10 steps) plus 6 `GatherGroupNode` instances attached to gather steps.
- GatherGroupNodes connected to their parent steps via short dashed `GatherEdge` (dotted, purple/0.4, no arrow).
- Each GatherGroupNode shows field names and types (e.g., "destination (string, required)").
- `get_guest_details` has the largest GatherGroupNode (3 fields): name, email, phone.
- Gather nodes positioned below their parent step nodes in LR layout.

**Acceptance criteria**:

- GatherGroupNode count = 6.
- GatherEdge count = 6.
- GatherGroupNode background: `hsl(var(--purple-subtle))`.
- GatherGroupNode border: `1px solid hsl(var(--purple)/0.2)`.
- Each gather field row shows: field name, type, required indicator (red dot if required).
- Step nodes with gather show gather badge: "📋 N fields".
- Clicking GatherGroupNode opens side panel with editable gather field configuration.

---

#### S12: Tool-Heavy (Every Step Calls a Tool)

**Setup**: Agent with 6 steps, each calling a different tool: `check_recent_verification`, `verify_email`, `send_verification_code`, `verify_code`, `lookup_booking`, `lock_account`. (Based on `Authentication_Agent` tools.)

**Action**: User clicks agent on L1.

**Expected**:

- Each step node shows a wrench icon (🔧) with the tool name.
- ToolNodes also rendered separately in a "Tools Used" row below the flow (or integrated into steps in scripted view).
- In scripted L2 view, tools appear as badges on their calling step, not as separate nodes (tools are embedded in the step context).
- Side panel for each step shows full tool details: name, parameters, return type, binding type.

**Acceptance criteria**:

- Each step node shows tool name badge: "🔧 [tool_name]".
- 6 steps, each with tool badge visible at zoom >= 0.75.
- At zoom 0.4-0.75 (summary level), tool icon visible but tool name truncated to icon only.
- Click on step → side panel includes "Tool Call" section with parameter table.
- No separate ToolNode instances in the LR flow (tools are embedded in steps for scripted mode).

---

#### S13: Mixed (12 Steps, Branches + Cycles + Gather + Tools)

**Setup**: `hotel_booking_advanced` agent. 12 steps, multiple ON_INPUT branches, back-edges (retry, cancel, change), gather fields on 7 steps, tool calls on 4 steps, 1 self-loop.

**Action**: User clicks agent on L1.

**Expected**:

- Dense L2 canvas. ELK config: `elk.direction: 'RIGHT', elk.layered.spacing.nodeNodeBetweenLayers: '70', elk.spacing.nodeNode: '35'` (9-15 step range).
- `fitView()` at zoom 0.4-0.6.
- At default zoom, semantic zoom shows Summary level (step names + icons only).
- Zooming in to >= 0.75 reveals full step text, gather fields, tool names.
- Multiple BranchNodes visible for ON_INPUT branching.
- High fan-out branch at `confirm` step uses BranchTableNode.
- Back-edges for "back" navigation and retry loops rendered with curvature.
- Self-loop on `select_hotel` for invalid input.

**Acceptance criteria**:

- Total nodes >= 20 (start + 12 steps + gather groups + branch nodes).
- Total edges >= 15 (flow + branch + gather + back-edges + self-loops).
- Semantic zoom active: summary at zoom 0.4-0.75, full at >= 0.75.
- At least 1 BranchTableNode (confirm step).
- At least 4 back-edges.
- At least 1 self-loop.
- L2 renders within 500ms (layout + animation).
- No node overlap at any zoom level.

---

#### S14: Digressions (2 Global Escape Routes)

**Setup**: `Authentication_Agent`. 2 global digressions: "speak_to_human" → escalate, "cancel" → complete.

**Action**: User clicks agent on L1.

**Expected**:

- Floating legend panel at top-right of L2 canvas shows: "Global Digressions: 'speak to human' → ESC, 'cancel' → [welcome]".
- Each step node has a small ↗ icon indicating digressions are available.
- Hovering "speak to human" in the legend: ALL step nodes get a subtle highlight ring (indicating they all support this digression).
- Digressions are NOT rendered as edges from every step (that would create 10 \* 2 = 20 extra edges).

**Acceptance criteria**:

- Floating legend visible at top-right, fixed position (doesn't scroll with canvas).
- Legend shows 2 digressions with intent and target.
- Each step node shows ↗ icon (visible at zoom >= 0.75).
- Hover on legend entry: all step nodes highlight simultaneously.
- No extra edges created for digressions.
- Click on ↗ icon on any step opens side panel with digression details.

---

#### S15: Step with CHECK Guard

**Setup**: `booking_with_constraints` agent. Step `collect_trip_info` has `CHECK: num_guests <= 10 AND destination != ""`. On fail → retry self.

**Action**: User clicks agent on L1.

**Expected**:

- After `collect_trip_info`, a small BranchNode (diamond) with condition text "guests <= 10 AND dest != ''".
- Two outgoing edges: pass (green, labeled "✓") → next step, fail (red, labeled "✗") → `collect_trip_info` (back-edge / self-loop).
- CHECK diamond visually similar to ON_SUCCESS/ON_FAILURE diamond but shows the condition text.

```
  [...prior]──▶[collect_trip_info]──▶ ◇ ──✓ pass──▶[search_and_show]
                        ▲          "guests≤10"
                        │              │
                        └───✗ fail─────┘
```

**Acceptance criteria**:

- BranchNode shows condition text (truncated if long, full text in tooltip).
- Pass edge: green label "✓ pass".
- Fail edge: amber/red label "✗ fail".
- Fail edge is a back-edge (self-loop to same step or back to earlier step).
- CHECK guard diamond is smaller than ON_INPUT diamond (80x48 vs 100x60).

---

#### S16: Maximum Complexity Agent (hotel_booking_advanced)

**Setup**: Full `hotel_booking_advanced` agent. 12 flow steps, 4 tools, 7 gather steps, multiple ON_INPUT branches (including 8-way branch at confirm), back-navigation edges, retry loops, self-loops.

**Action**: User clicks agent on L1.

**Expected**: Combination of all previous scripted scenarios (S2-S15) in a single view.

- Start node at far left.
- Linear progression from welcome through gathering steps.
- `search_and_show` has ON_SUCCESS/ON_FAIL branch.
- `select_hotel` has ON_INPUT branch with self-loop.
- `promo_check` has ON_INPUT branch (skip/apply/back).
- `payment_method` has ON_INPUT branch (3 payment types + back).
- `confirm` has 8-way BranchTableNode.
- Multiple long-range back-edges (confirm → welcome, confirm → get_destination, etc.).
- Gather groups on 7 steps.
- Tool badges on 4 steps.

**Acceptance criteria**:

- All 12 steps render without overlap.
- At least 1 BranchTableNode (at confirm step).
- At least 3 BranchNode diamonds (at search, select_hotel, payment_method).
- At least 6 back-edges (retry and navigation).
- At least 1 self-loop (select_hotel → select_hotel, confirm → confirm).
- 7 GatherGroupNodes visible.
- 4 tool badges visible.
- `fitView()` zoom: 0.3 to 0.5 (dense graph).
- Semantic zoom transitions smoothly between compact/summary/full.
- ELK layout time < 100ms (12 steps is well within limits).
- Floating digression legend if agent has global digressions.
- Total render time (layout + entrance animation): < 800ms.

---

### 19.3 L2 Agent Detail — Reasoning Agent Scenarios

---

#### R1: Minimal Reasoning Agent (Goal + 1 Tool)

**Setup**: Agent with `MODE: reasoning`, goal text, 1 tool. No constraints, no handoffs.

**Action**: User clicks agent on L1.

**Expected**:

- L2 canvas: ELK DOWN layout.
- GoalNode at top (280px wide, accent-subtle background, target icon, "Goal" label, goal text).
- 1 ToolNode below, connected by CapabilityEdge (dashed, muted, bezier curve).
- `fitView()` at zoom ~1.0 (very few nodes).

```
            ┌──────────────────────────┐
            │       🎯  GOAL            │
            │  "Help customers find..." │
            └────────────┬─────────────┘
                         │ capability
                         ▼
                 ┌──────────────┐
                 │  🔧 TOOL      │
                 │  search_hotels│
                 └──────────────┘
```

**Acceptance criteria**:

- Node count = 3 (start + goal + tool).
- Edge count = 2 (start → goal, goal → tool).
- GoalNode has accent-subtle background and 2px accent border.
- CapabilityEdge is dashed, muted color, bezier path.
- ToolNode shows tool name and description (if zoom >= 0.8).
- `fitView()` zoom: 0.9-1.2.
- Nodes enter with tier animation: goal at delay 0ms, tool at 50ms + 120ms (next tier).

---

#### R2: Standard Reasoning Agent (Goal + 4 Tools + 2 Rules + 1 Handoff)

**Setup**: Reasoning agent (like `Booking_Manager` simplified). Goal, 4 tools, 2 constraints, 1 handoff target.

**Action**: User clicks agent on L1.

**Expected**:

- TB layout with 3 tiers: Goal (top) → Tools row (middle) → Rules + Handoff row (bottom).
- GoalNode centered at tier 0.
- 4 ToolNodes spread horizontally at tier 1, connected to goal via CapabilityEdges.
- 2 RuleNodes + 1 HandoffTargetNode at tier 2.
- RuleNodes: warning-subtle background, shield icon.
- HandoffTargetNode: info-subtle background, arrow icon, target agent name.
- HandoffTargetNode is clickable: navigates back to L1 and centers on target agent.

```
                    ┌──────────────────────────┐
                    │       🎯  GOAL            │
                    └────────────┬─────────────┘
               ┌────────────────┼────────────────┐────────┐
               ▼                ▼                ▼        ▼
       ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
       │  🔧 list_bkg  │ │  🔧 get_det  │ │  🔧 modify   │ │  🔧 cancel   │
       └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘

               ┌────────────────┼────────────────┐
               ▼                ▼                ▼
       ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
       │  🛡️ auth req. │ │  🛡️ 24h rule  │ │  ↗️ Live_Agt  │
       └──────────────┘ └──────────────┘ └──────────────┘
```

**Acceptance criteria**:

- Node count: 1 start + 1 goal + 4 tools + 2 rules + 1 handoff = 9.
- Edge count: 1 (start → goal) + 4 (goal → tools) + 2 (goal → rules) + 1 (goal → handoff) = 8.
- CapabilityEdge style: dashed, 1.5px, border color, BezierEdge path.
- ToolNodes at same vertical position (within 2px tolerance).
- RuleNodes at same vertical position (within 2px tolerance).
- ELK config: `elk.direction: 'DOWN', elk.layered.spacing.nodeNodeBetweenLayers: '60', elk.spacing.nodeNode: '32'`.
- `fitView()` zoom: 0.6-0.9.
- Click on HandoffTargetNode: returns to L1, centers on target agent.

---

#### R3: Tool-Heavy Reasoning Agent (15 Tools)

**Setup**: Reasoning agent with 15 tools. No rules, no handoffs. Tools have mixed prefixes: 5 "search*\*", 4 "booking*\_", 3 "payment\_\_", 3 misc.

**Action**: User clicks agent on L1.

**Expected**:

- Tool count > 6, so auto-grouping activates (per Section 12.4).
- 3 ToolGroupNodes replace individual tool nodes: "Search Tools (5)", "Booking Tools (4)", "Payment Tools (3)".
- 3 misc tools remain as individual ToolNodes (group count <= 3, not collapsed).
- Each ToolGroupNode is clickable to expand and reveal individual tools.
- Total visible nodes with groups collapsed: 1 goal + 3 groups + 3 individual = 7 nodes.

```
                    ┌────────────────┐
                    │    🎯 GOAL      │
                    └────────┬───────┘
       ┌──────────────┬──────┴──────┬──────────────┐──────┬──────┬──────┐
       ▼              ▼             ▼              ▼      ▼      ▼
  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐┌────────┐┌────────┐
  │📁 Search │  │📁 Booking│  │📁 Payment│  │🔧 misc ││🔧 misc ││🔧 misc │
  │ (5 tools)│  │ (4 tools)│  │ (3 tools)│  │   #1   ││   #2   ││   #3   │
  │▸ expand  │  │▸ expand  │  │▸ expand  │  └────────┘└────────┘└────────┘
  └──────────┘  └──────────┘  └──────────┘
```

**Acceptance criteria**:

- Auto-grouping activates (tool count > 6).
- Tools grouped by shared prefix: "search*\*" (5), "booking*\_" (4), "payment\_\_" (3).
- 3 ToolGroupNodes visible, each showing count and "expand" link.
- 3 individual tools visible (no prefix group).
- Click on ToolGroupNode: expands to show individual ToolNodes with staggered animation.
- Collapse thresholds: individual groups collapsed because each has > 3 members.
- `fitView()` zoom: 0.6-0.9 (moderate node count when grouped).

---

#### R4: Constraint-Heavy Reasoning Agent (10 Rules)

**Setup**: `Booking_Manager` with 10 constraints across 3 categories: `pre_change` (3 rules), `pre_cancel` (3 rules), `always` (4 rules).

**Action**: User clicks agent on L1.

**Expected**:

- Rules auto-grouped by category since total > 5 (per Section 12.4).
- 3 RuleGroupNodes: "Pre-Change Rules (3)", "Pre-Cancel Rules (3)", "Always Rules (4)".
- Each RuleGroupNode expandable to show individual RuleNodes.
- RuleGroupNodes use warning-subtle background.

**Acceptance criteria**:

- Auto-grouping activates (rule count > 5).
- 3 RuleGroupNodes visible with category labels.
- Individual RuleGroupNodes collapsed (each has > 3 members for "Always" group).
- Click to expand reveals individual RuleNodes.
- Each RuleNode shows: shield icon, rule text (truncated), enforcement level.
- `fitView()` zoom: 0.5-0.8.

---

#### R5: Reasoning Agent with Delegates

**Setup**: `Booking_Manager` with 2 delegates: `Fee_Calculator` and `Refund_Processor`. Delegates are synchronous sub-calls, distinct from handoffs.

**Action**: User clicks agent on L1.

**Expected**:

- In L2 reasoning view, delegates appear as a distinct tier below tools.
- DelegateTargetNodes styled similarly to HandoffTargetNodes but with dashed border (indicating synchronous return).
- Each DelegateTargetNode shows: agent name, purpose text, input/output mapping.
- CapabilityEdge from goal to delegate targets uses delegate styling (dashed, animated).

**Acceptance criteria**:

- 2 delegate target nodes visible below tool tier.
- Delegate nodes have dashed border (distinguishing from handoff solid border).
- Delegate edge is dashed with flowing animation (consistent with L1 delegate edge).
- Click on delegate target opens side panel with: purpose, input mapping, output mapping, timeout, on_failure behavior.
- Delegate nodes do NOT navigate to L1 on click (they stay in L2 side panel).

---

#### R6: Reasoning Agent with Multiple Handoff Targets

**Setup**: `TravelDesk_Supervisor` (treated as reasoning agent for L2 view). 7 handoff targets with different conditions and return configurations.

**Action**: User clicks `TravelDesk_Supervisor` on L1.

**Expected**:

- GoalNode at top: "Route customers to the right specialist...".
- Tool tier: 0 explicit tools (supervisor has implicit routing tools but no declared tools).
- Handoff tier: 7 HandoffTargetNodes spread horizontally.
- Return handoffs (Welcome_Agent, Authentication_Agent, Fallback_Handler) have a "return" badge on their node.
- Non-return handoffs (Live_Agent_Transfer, Farewell_Agent, Sales_Agent, Booking_Manager) have no return badge.
- Each HandoffTargetNode shows: target agent name, condition summary, return status.
- Clicking any HandoffTargetNode navigates back to L1 and centers on that agent.

**Acceptance criteria**:

- 7 HandoffTargetNodes visible.
- Handoff nodes with RETURN:true show a visible "return" badge (e.g., "↩ return" text).
- Each handoff shows condition: "WHEN: intent.category == '...'".
- HandoffTargetNodes spread horizontally at same vertical position.
- Click on any handoff target: L2 fades out → L1 fades in → centers on target agent (400ms transition).
- If 7 targets is too wide for screen, nodes wrap to a second row or horizontal scrolling activates.

---

### 19.4 Interaction Scenarios

---

#### I1: Click Agent Node on L1 -> L2 Transition -> Back to L1

**Setup**: Any project with >= 2 agents. User is viewing L1 canvas.

**Action**:

1. User clicks an agent node on L1.
2. User views L2 canvas.
3. User clicks "Back" breadcrumb or browser back button.

**Expected**:

1. **L1 → L2 transition** (total ~600ms):
   - Phase 1 (0-300ms): `setCenter()` zooms to clicked node at 1.0.
   - Phase 2 (200-500ms): Clicked node gets `transitioning-target` class (scale 1.05, z-index 100). Other nodes fade out (opacity 0, scale 0.9). Edges fade out.
   - Phase 3 (400-600ms): L1 unmounts, L2 mounts with `canvas-enter` animation (200ms fade-in).
   - L2 node entrance stagger begins after canvas fade-in.
2. L2 canvas visible with agent internals. URL hash: `#agent/[name]`.
3. **L2 → L1 transition** (~400ms):
   - L2 nodes converge-out (200ms): all nodes shrink toward center, opacity 0.
   - L1 canvas fades in (200ms): previously clicked agent is centered.
   - L1 viewport restores previous zoom/pan state from Zustand store.

**Acceptance criteria**:

- Total L1→L2 transition: 550-650ms.
- Total L2→L1 transition: 350-450ms.
- No visible "flash" of empty canvas between transitions.
- URL hash updates and browser back button works.
- L1 viewport state (zoom, pan) is restored exactly as it was before drill-in.
- L1 node positions (including any manual drags) are preserved.

---

#### I2: Click Edge on L1 -> Side Panel -> Close Panel

**Setup**: L1 canvas with visible edges.

**Action**:

1. User clicks a handoff edge on L1.
2. User reads side panel content.
3. User clicks `X` button to close panel.

**Expected**:

1. Side panel slides in from right: `panel-slide-in` animation (300ms, spring easing). Panel is 360px wide, full canvas height, overlays canvas.
2. Panel shows: edge type (colored badge), source agent (clickable), target agent (clickable), condition text, "Edit in DSL Editor" button.
3. Panel slides out: `translateX(0) → translateX(24px)`, opacity fade, 200ms.

**Acceptance criteria**:

- Panel entrance: 300ms, slides from right.
- Panel exit: 200ms.
- Panel has `role="complementary"`, focus trap when open.
- Escape key closes panel.
- Clicking empty canvas area closes panel.
- Clicking a different edge while panel is open: content cross-fades (no slide — panel stays open).
- Clicking source or target agent link in panel: navigates to that agent (L2 transition).

---

#### I3: Hover Agent on L1 -> Connected Edges Highlight -> Hover Off

**Setup**: L1 canvas with multiple agents and edges.

**Action**:

1. User moves mouse over an agent node.
2. User moves mouse off the agent node.

**Expected**:

1. **Hover on**: All edges connected to this node increase to 3px stroke width and full opacity. All OTHER edges and nodes that are NOT directly connected dim to 15% opacity. Connected nodes get a subtle highlight ring. Transition: 150ms (`--duration-fast`).
2. **Hover off**: All edges and nodes return to default styling. Transition: 150ms.

**Acceptance criteria**:

- Connected edges: stroke width 3px, opacity 1.0.
- Non-connected edges: opacity 0.15.
- Non-connected nodes: opacity 0.15.
- Connected nodes: highlight ring (box-shadow).
- Transition duration: 150ms both in and out.
- No flickering when moving mouse between node and its edge.

---

#### I4: Search for Agent on L1 -> Center + Pulse -> Dismiss Search

**Setup**: L1 canvas with 10+ agents. User presses `/` to open search.

**Action**:

1. User presses `/` key.
2. User types "booking" in search bar.
3. User selects "Booking_Manager" from results.
4. User presses Escape.

**Expected**:

1. Floating search bar appears at top-center: fade-in animation.
2. Results filter in real-time (fuzzy match on agent name, goal, tool names). Non-matching nodes dim to 20% opacity.
3. `setCenter()` on `Booking_Manager` at zoom 1.0 (400ms transition). Node gets `attention-pulse` animation (600ms, accent box-shadow expands and fades).
4. Search bar dismisses. All node opacity restores to 1.0.

**Acceptance criteria**:

- Search bar triggers on `/` key.
- Fuzzy match across: name, goal text, tool names, domain.
- Non-matching nodes dimmed (opacity 0.2, pointer-events: none).
- Selected result: `setCenter()` with 400ms duration.
- Attention pulse: box-shadow from 0px to 8px and back over 600ms.
- Escape dismisses search and restores all opacity.
- Search results show agent type badge (Supervisor/Reasoning/Scripted).

---

#### I5: Drag Agent Node on L1 -> Position Persists -> Reset Layout

**Setup**: L1 canvas with ELK-computed layout.

**Action**:

1. User drags `Agent_A` from its ELK position to a new position.
2. User navigates away and returns.
3. User clicks "Reset Layout".

**Expected**:

1. Node follows mouse during drag. On drop, position saved to Zustand store (debounced, persisted to localStorage per project). Overlap detection runs: if dropped on another node, snaps to nearest non-overlapping position.
2. On return, node appears at the manually dragged position (not ELK-computed position). ELK positions are overridden by persisted positions.
3. "Reset Layout" re-runs ELK and clears all saved positions. All nodes animate to ELK-computed positions.

**Acceptance criteria**:

- Drag position saved to `localStorage` via Zustand persist.
- Position persisted per project (different projects have different positions).
- Overlap detection: `getIntersectingNodes()` called on drag stop.
- If overlap detected: node snaps to nearest non-overlapping position.
- "Reset Layout": clears persisted positions, re-runs ELK, `fitView()`.
- Nodes animate to new positions on reset (300ms transition).

---

#### I6: Collapse/Expand Supervisor Group on L1

**Setup**: L1 canvas with a supervisor + 4 children, displayed as expanded group.

**Action**:

1. User presses `g` while hovering the supervisor node.
2. User presses `g` again.

**Expected**:

1. **Collapse**: Children shrink toward group center (reverse of `group-expand`, 300ms). Internal edges hidden. Group summary node appears: "📁 Hotel Domain, 4 agents (1 supervisor), ▸ Click to expand". External edges re-route to group node.
2. **Expand**: Group summary node transforms into bounding box. Children appear from center with `group-expand` animation (300ms, spring easing). Internal edges re-appear. External edges re-route to individual nodes.

**Acceptance criteria**:

- Collapse animation: 300ms, children converge to center.
- Expand animation: 300ms, children diverge from center with spring easing.
- Collapsed group node shows: folder icon, domain name, agent count, supervisor count.
- External edges correctly re-routed to/from group node in collapsed state.
- Internal edges hidden in collapsed state, visible in expanded state.
- Keyboard shortcut: `g` toggles when hovering supervisor node.
- Click on collapsed group node also expands.

---

#### I7: Click Step Node on L2 -> Side Panel -> Click "Next Step" Link -> Center on Target

**Setup**: L2 scripted agent canvas visible.

**Action**:

1. User clicks `search_hotels` step node.
2. User clicks "→ present_options" link in the side panel "Next Step" row.

**Expected**:

1. Side panel slides in (400px wide) showing step details: response text, tool call info, next step link, branch info, gather fields.
2. `setCenter()` on `present_options` node at zoom 1.2 (350ms transition). Side panel content cross-fades to show `present_options` details. `present_options` node gets attention-pulse animation.

**Acceptance criteria**:

- Side panel width: 400px (L2 panel is wider than L1's 360px).
- "Next Step" link is clickable and styled as a text link.
- Click on link: smooth center transition (350ms) + side panel content swap.
- Attention-pulse on target node: 600ms, accent color.
- Side panel stays open with new content (no close + reopen).

---

#### I8: Zoom from Overview to Detail on L1 with 20 Agents (Semantic Zoom Transition)

**Setup**: L1 canvas with 20 agents. `fitView()` lands at zoom ~0.4.

**Action**: User uses scroll wheel to zoom from 0.4 to 1.0, then back to 0.4.

**Expected**:

- **Zoom 0.4 (start)**: Nodes as Summary Cards (name + mode badge + tool count). Edge labels hidden. Reduced node width (200px).
- **Zoom 0.65 (threshold)**: Nodes transition from Summary Card to Full Card. Badge rows appear. Goal text appears (2-line clamp). Model badge appears. Edge labels appear. Node width expands to 260px.
- **Zoom 0.35 (if zoomed further out)**: Nodes collapse to Compact Pills (name only, 140x32). Edges simplify to 1px thin lines.
- Zoom back to 0.4: nodes return to Summary Card rendering.

**Acceptance criteria**:

- Semantic zoom thresholds: 0.35 (pill), 0.65 (summary/full boundary), per Section 10.2.
- Transition between zoom levels is smooth (no jarring pop-in/pop-out).
- Node component re-renders triggered by `useStore(zoomSelector)`.
- No layout shift when switching between zoom levels (node center position stays constant).
- Badge visibility controlled by conditional rendering inside node component.
- Frame rate during zoom: >= 30fps.

---

#### I9: Click HandoffTargetNode in L2 -> Navigate to Target Agent's L2

**Setup**: L2 reasoning agent view with HandoffTargetNode for "Booking_Manager".

**Action**: User clicks the `Booking_Manager` HandoffTargetNode.

**Expected**:

- L2 current agent fades out (converge-out, 200ms).
- L1 canvas fades in briefly (200ms), centered on `Booking_Manager`.
- Immediately, L1-to-L2 transition begins for `Booking_Manager` (600ms).
- Net effect: cross-agent navigation. User goes from Agent_A's L2 → Agent_B's L2 via a brief L1 intermediary.

**Acceptance criteria**:

- Total transition time: ~1000ms (200ms L2→L1 + 200ms pause + 600ms L1→L2).
- URL hash updates to `#agent/Booking_Manager`.
- Browser back button goes to previous agent's L2 (or L1 if that's where the history points).
- No flash of fully zoomed-out L1 canvas (the L1 intermediary is brief and centered on target).

---

#### I10: Filter by "Scripted" on L1 -> Non-Matching Agents Dim

**Setup**: L1 canvas with mix of Scripted and Reasoning agents (e.g., TravelDesk project).

**Action**:

1. User clicks "Scripted" filter chip below search bar.
2. User clicks "All" filter chip.

**Expected**:

1. All Reasoning agents dim to 15% opacity with `pointer-events: none`. Their edges also dim. Only Scripted agents remain fully interactive. Transition: 200ms ease-out.
2. All agents restore to full opacity and interactivity. Transition: 200ms ease-out.

**Acceptance criteria**:

- Dimmed nodes: opacity 0.15, pointer-events: none.
- Dimmed edges: opacity 0.08.
- Dimmed nodes cannot be clicked, hovered, or dragged.
- Matching nodes remain at full opacity and are interactive.
- Filter state stored in Zustand store.
- Transition: `var(--duration-normal) var(--ease-out)`.
- Active filter chip shows selected state (accent background).

---

#### I11: Multi-Select Agents on L1 (Shift+Click)

**Setup**: L1 canvas with multiple agents.

**Action**:

1. User clicks Agent_A (selects it).
2. User Shift+clicks Agent_B (adds to selection).
3. User Shift+clicks Agent_C (adds to selection).

**Expected**:

- All 3 selected nodes have selection styling: `border-color: hsl(var(--accent))`, `box-shadow: var(--shadow-glow)`.
- `onSelectionChange` fires with `{ nodes: [A, B, C], edges: [] }`.
- Selected state stored in Zustand: `selectedNodes: ['A', 'B', 'C']`.
- Clicking empty canvas deselects all.

**Acceptance criteria**:

- Shift+click adds to selection (does not replace).
- All selected nodes show accent border + glow shadow.
- `selectedNodes` array in store matches selection.
- Escape key deselects all.
- Click on empty canvas deselects all.
- Selection transition: `var(--duration-fast) var(--ease-out)`.

---

#### I12: Keyboard Navigation Through L2 Flow Steps (Tab Between Nodes)

**Setup**: L2 scripted agent view with 5 steps.

**Action**:

1. User presses Tab key repeatedly.
2. User presses Enter on a focused node.

**Expected**:

1. Focus moves between nodes in flow order (start → step 1 → step 2 → ...). Each focused node gets `focus-ring` styling: 2px accent border + 4px box-shadow. `aria-label` announced by screen reader.
2. Enter on focused node opens side panel for that node (same as click).

**Acceptance criteria**:

- Tab order follows flow execution order (not DOM order).
- `focus-ring` visible: 2px border + 4px shadow.
- `aria-label` on each node: "Step: greet_customer, has tool call: search_hotels, has gather: 3 fields".
- Enter key equivalent to click.
- Shift+Tab moves backward through flow order.
- Focus ring styling uses `--border-focus` color variable.

---

#### I13: Browser Back Button from L2 -> L1

**Setup**: User is viewing L2 agent detail canvas.

**Action**: User clicks browser back button.

**Expected**:

- `popstate` event triggers L2→L1 transition.
- L2 converge-out animation (200ms).
- L1 canvas-fade-in animation (200ms).
- L1 restores previous viewport state (zoom, pan, selection).
- URL hash returns to project canvas (no `#agent/` suffix).

**Acceptance criteria**:

- Browser back button works (no React Router conflicts).
- URL hash updates correctly.
- L1 viewport restored from Zustand persisted state.
- Previously clicked agent is visible and centered on L1 after return.
- No duplicate history entries (clicking back once goes to L1, clicking back again leaves the page).

---

### 19.5 Edge Cases & Error Scenarios

---

#### E1: Topology API Returns Empty (Compilation Failed for All Agents)

**Setup**: Project has 3 agents but all fail to compile. Topology API returns empty topology but `buildClientTopology()` extracts basic structure from raw DSL.

**Action**: User navigates to project agents page.

**Expected**:

- Fallback path activates: `buildClientTopology(agents)` called.
- Client-side topology renders agents based on raw DSL parsing (regex on `HANDOFF:`, `DELEGATE:`, `MODE:`, `GOAL:`).
- All agent nodes show error indicator (red border, compilation error badge).
- Warning banner at top of canvas: "Some agents failed to compile. Visualization may be incomplete."
- Edges extracted from DSL (handoff targets parsed from `TO:` lines) rendered with reduced confidence styling (dashed, lower opacity).

**Acceptance criteria**:

- Canvas is NOT empty (fallback topology renders).
- All 3 agents visible as nodes.
- Error badge visible on all nodes.
- Warning banner dismissible but persistent until acknowledged.
- Edges from DSL parsing are dashed (uncertain confidence).
- Clicking error node opens side panel with compilation error, not L2 transition.

---

#### E2: Agent IR Fails to Compile (L2 Shows Raw DSL Fallback)

**Setup**: User clicks an agent that has a valid topology node but failed IR compilation. No AgentIR available for L2 rendering.

**Action**: User clicks the agent on L1.

**Expected**:

- L1-to-L2 transition begins but L2 cannot render flow/capability visualization.
- Fallback L2 view: a structured read-only panel showing raw DSL content with syntax highlighting, goal text extracted by client-side parsing, tool names extracted by client-side parsing, mode badge.
- A banner: "Agent compilation failed. Showing raw DSL. Fix compilation errors to see the full visualization."
- The "Open in DSL Editor" action button is prominently displayed.

**Acceptance criteria**:

- L2 does not crash or show blank canvas.
- Raw DSL displayed with syntax highlighting (YAML-like format).
- Client-side extracted metadata (goal, tools, mode) shown in a summary card above DSL.
- Compilation error message displayed in a callout box.
- "Open in DSL Editor" button navigates to the DSL editor for this agent.
- Back button returns to L1 as normal.

---

#### E3: Agent with No Tools, No Gather, No Flow (Reasoning with Just Goal)

**Setup**: Minimal reasoning agent with only `MODE: reasoning` and `GOAL:` defined. No tools, no constraints, no handoffs, no gather.

**Action**: User clicks the agent on L1.

**Expected**:

- L2 canvas shows: StartNode → GoalNode. Nothing else.
- GoalNode is prominent (280px wide, accent styling).
- No tool tier, no rule tier, no handoff tier.
- `fitView()` at zoom ~1.0.
- Empty-state message below goal: "No tools, constraints, or handoffs defined. This agent relies solely on its goal and LLM reasoning."

**Acceptance criteria**:

- Node count = 2 (start + goal).
- Edge count = 1 (start → goal).
- No errors or warnings in console.
- Empty-state message rendered as a muted text block below the goal.
- `fitView()` zoom: 0.9-1.2.

---

#### E4: Circular References in Topology (A -> B -> C -> A)

**Setup**: 3 agents forming a cycle: `A` hands off to `B`, `B` hands off to `C`, `C` hands off to `A`. `A` is entry.

**Action**: User navigates to project agents page.

**Expected**:

- ELK handles cycles using `elk.layered.cycleBreaking.strategy: 'GREEDY'`. One edge in the cycle is treated as a back-edge for layout purposes.
- All 3 nodes render. ELK assigns ranks based on longest path from entry.
- Back-edge (C → A) rendered with curved dashed line (same treatment as L2 back-edges).
- Canvas is stable (no infinite loops in layout computation).

**Acceptance criteria**:

- All 3 nodes render without layout errors.
- ELK completes layout in < 100ms.
- Back-edge visually distinguished from forward edges (dashed, curved).
- No infinite loops or stack overflows.
- `fitView()` works correctly.
- Loop icon on the back-edge.

---

#### E5: Very Long Agent Name (50+ Characters, Truncation)

**Setup**: Agent named "Issuance_Of_Coverage_Certificates_Coverage_Travel" (50 characters, from Saludsa-imported).

**Action**: User views L1 canvas.

**Expected**:

- Agent name truncated with ellipsis in the node card: "Issuance_Of_Coverage_Certi...".
- Full name visible in tooltip on hover.
- Node width does NOT expand to accommodate long name (stays at 260px).
- Name text uses `text-overflow: ellipsis`, `white-space: nowrap`, `overflow: hidden`.

**Acceptance criteria**:

- Name truncated at node width boundary (260px minus padding).
- Ellipsis visible.
- Tooltip shows full name on hover.
- At Summary zoom level (200px width), name truncates even more aggressively.
- At Compact Pill level (140px), name truncates to ~15 characters.
- `aria-label` on node includes full untruncated name.

---

#### E6: Very Long Goal Text (500+ Characters)

**Setup**: Agent with goal text exceeding 500 characters.

**Action**: User views agent node on L1 canvas at Full Card zoom level.

**Expected**:

- Goal text clamped to 3 lines (for SupervisorNode) or 2 lines (for AgentNode) via CSS `-webkit-line-clamp`.
- Truncation with "..." at the end of the last visible line.
- Full goal text visible in side panel when clicking the node.

**Acceptance criteria**:

- Agent goal text: max 2 lines, `line-clamp: 2`.
- Supervisor goal text: max 3 lines, `line-clamp: 3`.
- Text overflow: ellipsis at clamp boundary.
- Side panel shows full untruncated goal text.
- `aria-label` includes full goal text (not truncated).

---

#### E7: Agent with 0 Edges (Isolated Node, No Coordination)

**Setup**: Single reasoning agent with no HANDOFF, no DELEGATE, no ESCALATE. It exists in a project with other agents but has no connections.

**Action**: User views L1 canvas.

**Expected**:

- Agent rendered at its ELK-computed position.
- No edges connected to it.
- Hover on this node: no edges highlight (no connections exist).
- Node is fully interactive (clickable, triggers L2 transition).
- No error state. An isolated agent is valid (it handles conversations independently).

**Acceptance criteria**:

- Node renders without errors.
- No handles visible (no edges to connect to).
- Hover does not cause "connected-subgraph highlighting" (nothing to highlight).
- Click triggers normal L2 transition.
- `fitView()` includes this node in its bounding box.

---

#### E8: All Agents Are Supervisors (No Leaf Agents)

**Setup**: 3 agents, all declared as `SUPERVISOR:`. Each routes to the others. No leaf agents.

**Action**: User views L1 canvas.

**Expected**:

- All 3 nodes render as `SupervisorNode` (accent border, "SUPERVISOR" badge, network icon).
- Handoff edges between them.
- One supervisor is entry (first one declared, or the one referenced by project config).
- No group boundaries (no supervisor has dedicated "children" — all are peers).
- Pattern likely detected as `'mesh'` if bidirectional.

**Acceptance criteria**:

- All 3 nodes use `SupervisorNode` rendering.
- Entry badge on exactly 1 supervisor.
- No group nodes (no sub-supervisor hierarchy detected).
- Canvas is stable and interactive.

---

#### E9: Two Agents with Identical Names in Different Domains

**Setup**: Two agents both named "Search_Agent" — one in the "hotels" domain, one in the "flights" domain. Different agent IDs but same display name.

**Action**: User views L1 canvas.

**Expected**:

- Both nodes render with the same display name "Search_Agent".
- Domain badge distinguishes them: one shows "hotels" domain badge, the other shows "flights" domain badge.
- Node IDs are different (based on agent IDs, not names), so they are separate nodes.
- Search returns both results, differentiated by domain.
- Click on either navigates to the correct agent's L2 view.

**Acceptance criteria**:

- Both nodes render (no deduplication by name).
- Domain badges visible to distinguish them.
- Search shows both results with domain disambiguation.
- Clicking each navigates to the correct L2 view.
- `aria-label` includes domain: "Agent: Search_Agent, domain: hotels".

---

#### E10: Network Failure During Topology Fetch (Loading -> Error State)

**Setup**: Topology API call fails with network error (timeout, 500, etc.).

**Action**: User navigates to project agents page.

**Expected**:

1. **Loading state** (while API call is in-flight): Canvas area shows skeleton loading. Shimmer effect on placeholder nodes. "Loading topology..." text.
2. **Error state** (after API failure): Skeleton replaced with error state. Error icon + "Failed to load project topology" message + "Retry" button + "View as List" fallback link.
3. **Retry**: Clicking "Retry" re-fetches topology API. Loading state appears again.

**Acceptance criteria**:

- Loading state uses `.skeleton` shimmer class.
- Error state displays within 100ms of API failure.
- Error message is actionable: includes "Retry" button and "View as List" fallback.
- Retry button triggers fresh API call (no cached error).
- "View as List" navigates to the existing agent card grid view.
- No unhandled promise rejection in console.

---

### 19.6 Responsive Scenarios

---

#### RES1: Desktop (1920px) — Full Canvas + Side Panel Overlay

**Setup**: Desktop viewport at 1920x1080. L1 canvas with 8 agents.

**Action**: User clicks an edge to open side panel.

**Expected**:

- Canvas occupies full page width.
- Side panel (360px) overlays the right side of the canvas. Canvas is NOT pushed or resized.
- Mini-map visible in bottom-right corner (160x100).
- Controls (zoom in/out/fit) visible.
- All node detail levels visible (Full Card at default zoom).

**Acceptance criteria**:

- Side panel overlays canvas (position: absolute, right: 0).
- Canvas width unchanged when panel opens.
- Mini-map position: bottom-right, above the controls.
- No horizontal scrollbar.
- All interactive controls accessible.

---

#### RES2: Laptop (1280px) — Canvas Shrinks for Side Panel

**Setup**: Laptop viewport at 1280x800. L1 canvas with 8 agents.

**Action**: User clicks an edge to open side panel.

**Expected**:

- Side panel (360px) opens and pushes the canvas left. Canvas width reduces to 920px.
- Canvas re-runs `fitView()` at the reduced width to ensure all nodes are visible.
- Mini-map hidden (not enough space).
- Controls remain visible.

**Acceptance criteria**:

- Canvas width: 1280px - 360px = 920px when panel open.
- `fitView()` called on panel open/close to re-center content.
- Mini-map hidden at this breakpoint.
- No node truncation or overlap due to reduced canvas width.
- Panel close restores canvas to full 1280px width.

---

#### RES3: Tablet (1024px) — Bottom Sheet Panel

**Setup**: Tablet viewport at 1024x768. L1 canvas with 8 agents.

**Action**: User clicks an edge to open panel.

**Expected**:

- Canvas occupies full width (1024px).
- Side panel becomes a bottom sheet: slides up from bottom, 50% viewport height (384px).
- Canvas remains visible in top half.
- Controls reduced to zoom buttons only (no mini-map, no fit button).
- Bottom sheet has a drag handle for resize.

**Acceptance criteria**:

- Bottom sheet height: 50% of viewport (384px at 768px height).
- Bottom sheet slides up from bottom with spring animation.
- Canvas visible above bottom sheet.
- Touch gestures work: pan (1-finger drag), zoom (pinch).
- Drag handle on bottom sheet for manual resize.
- Escape closes bottom sheet.

---

#### RES4: Mobile (768px) — View-Only Canvas

**Setup**: Mobile viewport at 768x1024 (portrait). L1 canvas with 8 agents.

**Action**: User taps an agent node.

**Expected**:

- Canvas is view-only: pan and zoom work (touch gestures), but no side panel, no L2 transition.
- Tapping an agent navigates to a full-page agent detail view (separate page, not L2 canvas).
- Simplified node rendering: name + mode badge only (no goal text, no model, no timestamps).
- Mini-map hidden. Controls: zoom only.
- Nodes rendered at Compact Pill or Summary Card level regardless of zoom.

**Acceptance criteria**:

- No side panel or bottom sheet.
- Node tap navigates to full-page detail (not L2 canvas overlay).
- Simplified node rendering: name + mode only.
- Touch gestures: 1-finger pan, pinch-to-zoom.
- No deletion or editing actions available.
- Canvas renders within 300ms.

---

### 19.7 Performance Scenarios

---

#### P1: Initial Load with 5 Agents — Time to Interactive

**Setup**: Project with 5 agents (BankNexus: 1 supervisor + 3 children + 1 escalation target).

**Action**: User navigates to project agents page. Measure from navigation start to interactive canvas.

**Expected**:

- **API fetch**: Topology API responds in < 200ms (cached after first load).
- **Data transform**: `topologyToReactFlowNodes()` completes in < 5ms.
- **ELK layout**: `computeELKLayout()` with 5 nodes completes in < 10ms.
- **React render**: First paint of nodes in < 50ms.
- **Node entrance animation**: Stagger completes in ~400ms (5 nodes \* 80ms/rank).
- **Edge entrance**: Starts 200ms after last node, completes in 500ms.
- **Total time to interactive (canvas responds to clicks)**: < 500ms after API response.

**Acceptance criteria**:

- Performance tier: `standard`.
- ELK layout time: < 10ms.
- First meaningful paint: < 300ms after API response.
- Time to interactive: < 500ms after API response.
- Frame rate during entrance animation: >= 60fps.
- No layout shifts after initial render.
- Memory footprint increase: < 5MB.

---

#### P2: Initial Load with 30 Agents — Time to Interactive

**Setup**: 30 agents (Saludsa-imported scale: 1 supervisor + 29 children), 29 handoff edges.

**Action**: User navigates to project agents page.

**Expected**:

- **API fetch**: Topology API responds in < 500ms.
- **Data transform**: < 10ms.
- **ELK layout**: `computeELKLayout()` with 30 nodes + 29 edges in < 50ms. Uses `elk.layered.spacing.nodeNodeBetweenLayers: '100', elk.spacing.nodeNode: '60'` (16-30 range).
- **React render**: `onlyRenderVisibleElements={true}`. Only ~10-15 visible nodes rendered initially.
- **Node entrance animation**: Stagger capped at 15 nodes (Optimized tier). Remaining 15 appear instantly.
- **Semantic zoom**: Default fitView zoom ~0.35, showing Summary Cards.
- **Total time to interactive**: < 800ms after API response.

**Acceptance criteria**:

- Performance tier: `optimized`.
- ELK layout time: < 50ms.
- `onlyRenderVisibleElements={true}` active.
- Entrance animation stagger: capped at 15 nodes.
- First meaningful paint: < 400ms.
- Time to interactive: < 800ms.
- Frame rate during entrance animation: >= 45fps.
- Memory footprint increase: < 15MB.

---

#### P3: Initial Load with 80 Agents — Time to Interactive

**Setup**: 80 agents organized under 8 supervisors (synthetic test data). ~100 edges (handoff + delegate + escalation).

**Action**: User navigates to project agents page.

**Expected**:

- **Performance tier**: `heavy` (81+ agents).
- **ELK layout**: Computed in Web Worker to avoid blocking main thread. Completes in < 300ms.
- **Groups collapsed by default**: 8 supervisor groups collapsed. Visible nodes: 1 root + 8 group nodes = 9 visible nodes.
- **React render**: Canvas renderer at zoom < 0.3 uses pure-CSS colored rectangles instead of React components.
- **No entrance animation**: Nodes appear instantly (animations disabled for Heavy tier).
- **Total time to interactive**: < 1200ms after API response.

**Acceptance criteria**:

- Performance tier: `heavy`.
- ELK computation runs in Web Worker (main thread not blocked).
- ELK layout time (in worker): < 300ms.
- Groups collapsed by default: only ~9 visible nodes.
- No entrance animations (instantly visible).
- Viewport culling aggressive: only visible nodes rendered.
- Edge simplification: `StraightEdge` below zoom 0.3.
- First meaningful paint: < 600ms.
- Time to interactive: < 1200ms.
- Frame rate during pan/zoom: >= 30fps.
- Memory footprint increase: < 40MB.

---

#### P4: Drag Node in 50-Agent Canvas — Frame Rate

**Setup**: 50 agents on canvas. User has zoomed to see ~20 agents in viewport.

**Action**: User clicks and drags a node across the canvas for 2 seconds.

**Expected**:

- Node follows cursor in real-time.
- Frame rate during drag: >= 30fps (target 60fps, minimum acceptable 30fps).
- No jank or stutter during drag.
- Connected edges update in real-time (re-routed to follow dragged node position).
- Other nodes remain in place.
- On drop: overlap detection runs, position persisted.

**Acceptance criteria**:

- Frame rate during drag: >= 30fps measured via `requestAnimationFrame` timing.
- No dropped frames visible to user (no "teleporting" node).
- Edge paths update smoothly during drag.
- `onNodeDragStop` fires within 16ms of mouse release.
- Position persistence (localStorage write) debounced to 250ms after last drag event.

---

#### P5: Zoom In/Out in 50-Agent Canvas — Frame Rate

**Setup**: 50 agents on canvas. User uses scroll wheel to zoom continuously.

**Action**: User scrolls to zoom from 0.2 to 1.0 and back over ~3 seconds.

**Expected**:

- Smooth zoom transition centered on cursor position.
- Semantic zoom level transitions (Compact Pill → Summary Card → Full Card) are seamless — no visible pop-in.
- Frame rate during zoom: >= 30fps.
- Viewport culling activates/deactivates as nodes enter/leave viewport.
- Edge simplification (SmoothStep → Straight) at low zoom is not jarring.

**Acceptance criteria**:

- Frame rate during continuous zoom: >= 30fps.
- Semantic zoom transitions: no visible flash or layout shift during level change.
- Node components re-render efficiently (only zoom-dependent content changes).
- `useStore(zoomSelector)` triggers minimal re-renders (not full tree re-render).
- No memory leaks during rapid zoom in/out (GC stable).

---

#### P6: Open L2 for 12-Step Scripted Agent — Transition + Layout Time

**Setup**: L1 canvas visible. User clicks a scripted agent with 12 flow steps, 5 gather groups, 4 tool calls, 3 branch nodes, 2 back-edges.

**Action**: User clicks the agent node. Measure total time from click to interactive L2 canvas.

**Expected**:

- **L1→L2 transition animation**: ~600ms (zoom + fade + swap).
- **L2 data transform**: `agentIRToReactFlowNodes()` with 12 steps, computing branches, detecting cycles, extracting gather groups: < 20ms.
- **L2 ELK layout**: ~25 nodes + ~20 edges (including branch nodes, gather nodes): < 30ms.
- **L2 node entrance animation**: 25 nodes \* 60ms stagger = ~1500ms total stagger, but first nodes appear within 60ms.
- **Total time from click to first L2 node visible**: < 700ms.
- **Total time to all L2 nodes rendered**: < 2200ms.

**Acceptance criteria**:

- L1→L2 transition: 550-650ms.
- L2 `agentIRToReactFlowNodes()`: < 20ms.
- L2 ELK layout: < 30ms.
- First L2 node visible: < 700ms from click.
- All L2 nodes visible: < 2200ms from click.
- `fitView()` after entrance animation: 400ms smooth transition.
- Frame rate during entrance stagger: >= 45fps.
- Back-edges rendered after forward layout completes.
- No layout shifts during stagger (positions computed before animation starts).

---

## 20. Modern Architecture Reference

This section consolidates the modern architecture decisions applied throughout the design, referencing Vercel React Best Practices, React Flow v12 performance guidelines, and React 19 patterns.

### 20.1 Technology Stack Upgrade Path

The studio currently runs React 18.2, Next.js 14.2, Tailwind 3.4, and dagre 0.8.5. This design targets:

| Package                | Current    | Target     | Migration Notes                                                 |
| ---------------------- | ---------- | ---------- | --------------------------------------------------------------- |
| `react`                | 18.2       | 19.x       | Server Components, `use()` hook, `startTransition` improvements |
| `next`                 | 14.2       | 15.x       | App Router stable, Partial Prerendering, `after()` API          |
| `tailwindcss`          | 3.4        | 4.x        | CSS-first config, `@theme` directive, native cascade layers     |
| `zustand`              | 4.4        | 5.x        | Improved selector memoization, middleware composability         |
| `dagre`                | 0.8.5      | **Remove** | Deprecated, unmaintained since 2018                             |
| `elkjs`                | —          | 0.9.x      | **Add**: async API, subflow support, 12+ algorithms             |
| `@xyflow/react`        | —          | 12.4+      | **Add**: SSR, dark mode, `onlyRenderVisibleElements`            |
| `graphology` + `sigma` | 0.26 + 3.0 | **Remove** | Replaced by @xyflow/react for all canvas rendering              |

### 20.2 Vercel React Best Practices Applied

57 rules across 8 categories. The following rules are specifically relevant to the canvas implementation:

**Category 1: Eliminating Waterfalls (CRITICAL)**

| Rule                        | Application                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `async-suspense-boundaries` | Topology data streams via `<Suspense>` — canvas skeleton shows instantly, data fills in |
| `async-parallel`            | Topology API + Agent IR fetch run via `Promise.all()`, not sequentially                 |

**Category 2: Bundle Size (CRITICAL)**

| Rule                     | Application                                                                      |
| ------------------------ | -------------------------------------------------------------------------------- |
| `bundle-dynamic-imports` | Canvas component loaded via `next/dynamic` (~150KB code-split from main bundle)  |
| `bundle-barrel-imports`  | Import `{ BaseNode }` from `@/components/ui/base-node` directly, not from barrel |
| `bundle-preload`         | Preload L2 canvas chunk on agent node hover (`<link rel="prefetch">`)            |

**Category 3: Server-Side Performance (HIGH)**

| Rule                   | Application                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `server-cache-react`   | `React.cache()` wraps topology fetch for per-request dedup                            |
| `server-serialization` | Topology API returns minimal data — only IDs, names, edges. Full IR loaded on demand. |

**Category 5: Re-render Optimization (MEDIUM)**

| Rule                                | Application                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `rerender-defer-reads`              | Components don't subscribe to `nodes[]` — use `nodeMap.get(id)` via derived selector       |
| `rerender-memo`                     | All custom node/edge components wrapped in `React.memo()`                                  |
| `rerender-derived-state`            | `semanticZoomLevel` derived from `zoom` in store setter, not computed in components        |
| `rerender-transitions`              | Layout recalculation wrapped in `startTransition` (non-urgent, doesn't block interactions) |
| `rerender-use-ref-transient-values` | `useRef` for drag position during node drag (no re-renders)                                |
| `rerender-functional-setstate`      | All store updates use functional form for stable callback references                       |

**Category 6: Rendering Performance (MEDIUM)**

| Rule                            | Application                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| `rendering-content-visibility`  | Side panel content uses `content-visibility: auto` when panel is off-screen |
| `rendering-svg-precision`       | Edge SVG paths reduced to 1 decimal place (from default 6+)                 |
| `rendering-hoist-jsx`           | Static JSX in nodes (icons, dividers) hoisted outside component             |
| `rendering-animate-svg-wrapper` | Edge animations apply to wrapping `<g>` element, not individual `<path>`    |

**Category 7: JavaScript Performance (LOW-MEDIUM)**

| Rule                        | Application                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `js-set-map-lookups`        | `Map<string, Node>` and `Set<string>` for all node/edge lookups (not array `.find()`) |
| `js-index-maps`             | Pre-build adjacency map on topology load for O(1) neighbor lookup                     |
| `js-cache-function-results` | Memoize `nodesToElkGraph()` transformation at module level                            |
| `js-combine-iterations`     | Single pass over nodes for both transform + dimension extraction (not separate loops) |

### 20.3 React Flow v12 Performance Patterns

Per React Flow's official performance guide:

**1. Component memoization** (CRITICAL):

```tsx
// All custom nodes and edges MUST be React.memo
const AgentNode = React.memo(({ data }: NodeProps<AgentNodeData>) => {
  // ...
});

// NodeTypes/EdgeTypes defined OUTSIDE components (static objects)
const projectNodeTypes: NodeTypes = { supervisor: SupervisorNode, agent: AgentNode };
```

**2. Selective store subscriptions** (CRITICAL):

```tsx
// BAD: subscribes to entire nodes array — re-renders on every pan/zoom
const nodes = useNodes();
const selected = nodes.filter((n) => n.selected);

// GOOD: use derived selector with stable reference
const selectedIds = useSelectionStore((s) => s.selectedNodeIds);
```

**3. Viewport culling** (for 10+ nodes):

```tsx
<ReactFlow
  onlyRenderVisibleElements={nodes.length > 10} // Only mount DOM for visible nodes
  elevateNodesOnSelect={false} // Skip z-index recalculation
  elevateEdgesOnSelect={false}
/>
```

**4. CSS simplification at scale**:

```css
/* Standard tier (≤10 agents): full styling */
.agent-node {
  box-shadow: var(--shadow-md);
  transition: all var(--duration-normal);
}

/* Scaled tier (31-80): simplified styling */
.canvas-tier-scaled .agent-node {
  box-shadow: none;
  transition: none;
}

/* Heavy tier (81+): minimal styling */
.canvas-tier-heavy .agent-node {
  border-radius: 4px;
  background: var(--background-muted);
}
```

### 20.4 ELK.js Configuration Reference

Quick reference for ELK layout options used across L1 and L2:

```typescript
// Base options (shared by L1 and L2)
const BASE_ELK_OPTIONS: ElkLayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.portConstraints': 'FIXED_ORDER',
};

// L1: Project Canvas
const L1_ELK_OPTIONS: ElkLayoutOptions = {
  ...BASE_ELK_OPTIONS,
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '120',
  'elk.spacing.nodeNode': '80',
};

// L2: Scripted Agent (LR flow)
const L2_SCRIPTED_ELK_OPTIONS: ElkLayoutOptions = {
  ...BASE_ELK_OPTIONS,
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '60',
  'elk.spacing.nodeNode': '40',
  'elk.layered.cycleBreaking.strategy': 'INTERACTIVE', // Preserves back-edges
};

// L2: Reasoning Agent (TB capability map)
const L2_REASONING_ELK_OPTIONS: ElkLayoutOptions = {
  ...BASE_ELK_OPTIONS,
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '70',
  'elk.spacing.nodeNode': '30',
};

// Override for large graphs (30+ nodes)
const LARGE_GRAPH_OVERRIDES: Partial<ElkLayoutOptions> = {
  'elk.layered.crossingMinimization.strategy': 'INTERACTIVE', // Faster for large graphs
  'elk.layered.spacing.nodeNodeBetweenLayers': '100', // Tighter spacing
  'elk.spacing.nodeNode': '60',
};
```

### 20.5 SSR + Streaming Architecture

```
Browser request → Next.js Server
                    │
                    ├──▶ Static shell rendered (header, sidebar, skeleton) ─────▶ TTFB ~40-90ms
                    │                                                            (from edge cache)
                    │
                    ├──▶ Topology API fetch (server-side, no client waterfall) ──▶ Stream chunk 1
                    │
                    ├──▶ <Suspense> resolves, canvas data arrives ───────────────▶ Stream chunk 2
                    │
                    └──▶ Client hydrates, ReactFlow mounts, ELK layout runs ────▶ Interactive
                                                                                  (TTI ~500-800ms)
```

**Key**: The canvas component is loaded via `next/dynamic({ ssr: false })` because ReactFlow requires DOM APIs. But the **data** is fetched on the server, so the client never makes a separate API call — the topology arrives pre-fetched in the Suspense stream. This eliminates the waterfall: page load → client JS → API call → render.

### 20.6 Performance Budget (Updated)

| Metric                     | Original Budget               | Modern Target                                  | How                                                        |
| -------------------------- | ----------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| TTFB                       | N/A                           | < 90ms                                         | Static shell from edge cache (PPR)                         |
| Canvas bundle              | ~150KB (single chunk)         | ~40KB initial + lazy                           | `next/dynamic` code-split                                  |
| Layout (5 agents)          | < 10ms (main thread)          | < 10ms (Worker)                                | ELK in Worker (non-blocking even if slow)                  |
| Layout (30 agents)         | < 50ms (main thread)          | < 50ms (Worker)                                | ELK in Worker                                              |
| Layout (80 agents)         | < 300ms (main thread, BLOCKS) | < 300ms (Worker, non-blocking)                 | ELK in Worker + `startTransition`                          |
| Pan/zoom FPS               | 30fps                         | 60fps                                          | Split stores, derived selectors, `useRef` for transients   |
| Node re-renders during pan | All mounted nodes             | Only visible                                   | `onlyRenderVisibleElements` + `content-visibility`         |
| Semantic zoom transition   | useState (re-render)          | Derived in store (single set)                  | `semanticZoomLevel` computed in `setViewport`              |
| Side panel (off-screen)    | Full DOM                      | Hidden DOM                                     | `content-visibility: auto` saves ~5ms per panel close/open |
| SVG edge rendering         | Default precision             | 1 decimal                                      | Vercel rule `rendering-svg-precision`                      |
| L1→L2 transition           | CSS keyframes only            | View Transitions API (progressive enhancement) | Smooth cross-document transition where supported           |

---

## 21. Implementation Status

> **Last updated:** 2026-03-04 | **Branch:** `feature/agentcanvas`

&nbsp;

---

### 21.1 Layer 1 — What's Implemented

| Feature                                         | Status | Notes                                                                                                    |
| ----------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| Project Canvas with ELK layout                  | ✅     | Layered DOWN, 140px inter-layer, 100px node spacing, `separateConnectedComponents`                       |
| Agent nodes (full/summary/compact)              | ✅     | Dynamic sizing: 280×180 / 240×120 / 160×48 with CSS transitions                                          |
| Relationship edges (handoff/delegate/escalate)  | ✅     | Color-coded, dash patterns, arrow markers, smooth-step paths                                             |
| Drag-to-connect with inline config form         | ✅     | Handoff: When, Priority, Summary, Pass, History, Return. Delegate: When, Purpose, Input/Returns, Timeout |
| Edge popover (edit/change-type/delete)          | ✅     | Click edge → rich popover. Edit opens pre-populated form. Change Type switches handoff↔delegate.         |
| Escalate DSL mutations                          | ✅     | `addEscalateTrigger()` with When, Reason, Priority, Tags. Escalate targets humans (not canvas edges).    |
| Handoff PRIORITY field                          | ✅     | Priority number in form + `PRIORITY: N` in DSL                                                           |
| Semantic zoom with hysteresis                   | ✅     | 0.03 buffer at thresholds, edge recalculation via `useUpdateNodeInternals`                               |
| Position persistence                            | ✅     | All positions persisted after first layout; no jumping on edge add/edit/delete                           |
| Entry/supervisor pinned to top                  | ✅     | `elk.layered.layerConstraint: FIRST`                                                                     |
| Separated connected components                  | ✅     | 200px gap between groups                                                                                 |
| Unified Agent Editor (slider panel)             | ✅     | Replaced old `AgentDetailPanel`. Coverage comparison in `2026-03-04-unified-agent-editor-design.md` §11. |
| MiniMap, Canvas controls, URL hash deep-linking | ✅     | Standard canvas infrastructure                                                                           |
| Canvas E2E testing skill                        | ✅     | `.claude/skills/canvas-e2e-testing.md` — 6 suites via Playwright MCP                                     |
| Banking test project                            | ✅     | `examples/canvas-test-bank/` — 6 agents, 15 ABL patterns                                                 |

&nbsp;

---

### 21.2 Layer 1 — Not Yet Implemented

| Feature                         | Design Section | Notes                                                         |
| ------------------------------- | -------------- | ------------------------------------------------------------- |
| Layer 2 (Agent Detail Canvas)   | §3             | Internal flow visualization (scripted steps, reasoning tools) |
| Search & Filter overlay         | §10.4          | Fuzzy search, filter chips, dimming                           |
| Collapse/Expand groups          | §10.3          | Auto-grouping for 30+ agents                                  |
| Performance tiers               | §10.1          | Viewport culling, progressive rendering                       |
| Complex branching visualization | §11            | ON_INPUT, ON_SUCCESS/FAILURE, cycles, digressions             |
| Edge overlap resolution         | §13            | Bidirectional pairs, multi-edge stacking                      |

&nbsp;

---

### 21.3 Unified Agent Type Support

Cross-reference: `2026-03-02-unified-agent-type-design.md`

The canvas and editor together cover every concept from the unified agent type design:

&nbsp;

| Unified Concept                         | Canvas                                          | Editor                    |
| --------------------------------------- | ----------------------------------------------- | ------------------------- |
| Multiple conditional HANDOFFs per agent | ✅ Drag-to-connect with WHEN, PRIORITY, CONTEXT | ✅ Handoffs section       |
| DELEGATE with INPUT/RETURNS/TIMEOUT     | ✅ Delegate form with key-value mapping         | ✅ Delegates section      |
| ESCALATE triggers (to humans)           | ✅ DSL mutations, badge on node                 | ✅ Escalation section     |
| Mixed-mode FLOW (REASONING per step)    | ✅ Node badges adapt                            | ✅ Flow section           |
| Reasoning-only agents (no FLOW)         | ✅ "Reasoning" badge, no step count             | ✅ Full editing           |
| GOAL mandatory                          | ✅ Goal text at full zoom                       | ✅ Goal & Persona section |
| Bidirectional handoffs                  | ✅ Both edges visible                           | ✅ Handoffs section       |
| Same target different types             | ✅ Different edge styles                        | ✅ Separate sections      |

&nbsp;

---

### 21.4 Files Modified

&nbsp;

#### Canvas core

| File                     | What                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ProjectCanvas.tsx`      | Connection handling, edge events (delete/edit/change-type), position persistence, zoom tracking, `useUpdateNodeInternals`, renders `AgentEditorSlider` |
| `nodes/AgentNode.tsx`    | Dynamic zoom-responsive sizing (280×180 / 240×120 / 160×48), CSS transitions                                                                           |
| `types.ts`               | `NODE_DIMENSIONS_BY_ZOOM`, updated layout configs                                                                                                      |
| `hooks/useAutoLayout.ts` | Entry node `layerConstraint: FIRST`, zero-position guard                                                                                               |
| `store/canvas-store.ts`  | Zoom hysteresis (0.03 buffer)                                                                                                                          |

&nbsp;

#### Edge system

| File                         | What                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `ConnectionTypePicker.tsx`   | **New.** Two-step type picker → config form. Edit mode. HandoffForm + DelegateForm.     |
| `edges/EdgePopover.tsx`      | **New.** Rich popover: type badge, source→target, When preview, Edit/Change Type/Delete |
| `edges/RelationshipEdge.tsx` | Hover tooltip, selected popover, custom event dispatchers                               |

&nbsp;

#### Agent editor + detail

| File                              | What                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `agent-editor/`                   | **New.** Unified Agent Editor — 17 construct sections. See `2026-03-04-unified-agent-editor-design.md`. |
| `AgentDetailPanel.tsx`            | Original panel (bypassed). Contains incoming relationships code for future porting.                     |
| `AgentListPage.tsx`               | `handleCanvasConnect` with full config passthrough                                                      |
| `lib/agent-canvas/dsl-updater.ts` | `addHandoff`/`addDelegate`/`addEscalateTrigger` with config interfaces                                  |

&nbsp;

---

### 21.5 Custom Event Pattern

Edge interactions use `CustomEvent` between the SVG edge layer and ProjectCanvas:

&nbsp;

| Event                     | Payload                                        | Handler                                                               |
| ------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| `canvas-edge-delete`      | `{ edgeId, source, target, relationshipType }` | removeHandoff/removeDelegate, save, refresh                           |
| `canvas-edge-edit`        | `{ edgeId, source, target, relationshipType }` | Parse relationships (case-insensitive), open config form in edit mode |
| `canvas-edge-change-type` | `{ edgeId, source, target, oldType, newType }` | Remove old, create new preserving When, save, refresh                 |

&nbsp;

---

### 21.6 Semantic Zoom Dimensions

&nbsp;

| Level       | Zoom Range  | Dimensions | Content                                                |
| ----------- | ----------- | ---------- | ------------------------------------------------------ |
| **Full**    | ≥ 0.63      | 280 × 180  | Name, badges, goal text, footer (model, tools, fields) |
| **Summary** | 0.27 – 0.57 | 240 × 120  | Name + type/mode badges. No goal, no footer.           |
| **Compact** | < 0.27      | 160 × 48   | Name only, pill shape                                  |

&nbsp;

---

### 21.7 Superseded Documents

This section (§21) and `2026-03-04-unified-agent-editor-design.md` are the two canonical references. These are historical:

- `docs/plans/2026-03-04-canvas-interactive-edges-jira.md`
- `docs/plans/2026-03-04-canvas-gap-closure-testing-plan.md`
- `docs/fixes/2026-03-03-canvas-zoom-visibility-fix.md`
- `docs/fixes/canvas-zoom-levels-reference.md`
