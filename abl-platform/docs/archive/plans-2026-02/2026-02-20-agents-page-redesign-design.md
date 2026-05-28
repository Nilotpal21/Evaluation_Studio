# Agents Page Redesign — Mini Topology + Rich Cards

**Goal:** Replace the flat, bland agent list with a compact topology mini-map showing agent relationships and a 2-column grid of rich agent cards with medium detail.

**Architecture:** New `AgentMiniTopology` SVG component + `AgentCard` component, backed by a server-side topology API that compiles agents to IR and extracts relationships via `extractAppStaticGraph()`.

---

## 1. Overall Page Structure

```
┌─────────────────────────────────────────────────────────┐
│  PageHeader: "Agents" + project context                 │
│  [Search] [Start Agent ▼] [Import] [Create Agent]       │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐   │
│  │          COMPACT TOPOLOGY MINI-MAP               │   │
│  │   supervisor ──┬──▶ booking ──▶ faq              │   │
│  │                └──▶ cancel                       │   │
│  │          ~150px tall, SVG, animated              │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────┐            │
│  │ Supervisor card   │  │ Booking card     │            │
│  └──────────────────┘  └──────────────────┘            │
│  ┌──────────────────┐  ┌──────────────────┐            │
│  │ FAQ card          │  │ Cancel card      │            │
│  └──────────────────┘  └──────────────────┘            │
│       2-column responsive grid with stagger             │
└─────────────────────────────────────────────────────────┘
```

- Existing search/toolbar stays at the top
- Topology mini-map sits between toolbar and cards
- Cards replace the current `AgentRow` list with a 2-column grid
- When there's only 1 agent or no relationships, topology section hides

---

## 2. Compact Topology Mini-Map

**Component:** `AgentMiniTopology` — purpose-built, not reusing `TopologyCanvas` (which has zoom/pan/drag overkill for a glanceable overview).

**Data source:** `GET /api/projects/:id/topology` (server-side IR compilation).

**Layout:** Horizontal BFS — supervisor centered at left, children fanning out right. Small constants (node width ~100px, height ~32px).

**Visual treatment:**

- Background: `bg-background-elevated` card with `rounded-xl border-default`
- Nodes: Rounded pills colored by type:
  - Supervisor: `bg-accent-subtle border-accent/30 text-accent` (indigo)
  - Entry (non-supervisor): `bg-purple-subtle border-purple/30 text-purple`
  - Regular: `bg-background-muted border-default text-foreground`
- Edges: Curved SVG bezier paths
  - Routing/handoff: `stroke: accent` solid
  - Delegation: `stroke: purple` dashed
  - Escalation: `stroke: error` dotted
- Animated entrance: nodes scale in with `springs.soft`, edges draw with `pathLength` animation

**Interaction:**

- Hover node: highlight edges, show tooltip with execution mode
- Click node: smooth-scroll to corresponding agent card below
- No zoom/pan

**Edge cases:**

- 1 agent, no relationships: hide topology section
- No supervisor (all independent): flat horizontal row of pills, no edges
- 8+ agents: cap at ~8 visible, show "+N more" pill
- Loading: skeleton placeholder with shimmer circles + lines

---

## 3. Rich Agent Cards

**Component:** `AgentCard` replaces inline `AgentRow`.

**Card structure:**

```
┌─────────────────────────────────────────────┐
│  [icon]  Agent Name                [Chat ▶] │
│          SUPERVISOR · REASONING · 🟢 Active  │
│  ─────────────────────────────────────────── │
│  Routes customers to booking, FAQ, or       │
│  cancellation agents based on intent.       │
│                                             │
│  hotel-booking · 3 tools · 2 fields         │
│  v2.1 production · Modified 2h ago          │
└─────────────────────────────────────────────┘
```

**Visual zones:**

1. Header: Icon (40x40 rounded-lg) + name (`text-sm font-semibold`) + Chat button (ghost, hover-visible)
2. Badges: Agent type + execution mode + active status as pill badges
3. Divider: `border-b border-default my-3`
4. Description: 2-line clamped (`line-clamp-2 text-sm text-muted`). Fallback: "No description" in `text-subtle italic`
5. Metadata: Domain, tools count, gather fields count — `text-xs text-muted` with dot separators
6. Footer: Active version + relative time modified — `text-xs text-dim`

**Visual differentiation:**

| Type                   | Border                                   | Icon bg                            | Accent      |
| ---------------------- | ---------------------------------------- | ---------------------------------- | ----------- |
| Start + Supervisor     | `border-accent/30 ring-1 ring-accent/10` | `bg-accent text-accent-foreground` | Indigo glow |
| Start (non-supervisor) | `border-accent/30`                       | `bg-accent text-accent-foreground` | Indigo      |
| Supervisor (not start) | `border-purple/30`                       | `bg-purple-subtle text-purple`     | Purple      |
| Regular                | `border-default`                         | `bg-accent-subtle text-accent`     | Default     |

**Grid:** `grid grid-cols-1 md:grid-cols-2 gap-4` with `stagger-children` entrance animation.

**Enriched data from topology API:** `agentSummaries` map provides `toolsCount`, `gatherFieldsCount`, `executionMode`, `goal`, `description` per agent.

---

## 4. API Endpoint & Data Flow

**Endpoint:** `GET /api/projects/:projectId/topology`

**Response:**

```typescript
interface ProjectTopologyResponse {
  topology: {
    nodes: Array<{
      id: string;
      name: string;
      type: 'supervisor' | 'agent';
      isEntry: boolean;
      executionMode: 'reasoning' | 'scripted';
    }>;
    edges: Array<{
      from: string;
      to: string;
      type: 'routing' | 'handoff' | 'delegate' | 'escalation';
      label?: string;
    }>;
  };
  agentSummaries: Record<
    string,
    {
      toolsCount: number;
      gatherFieldsCount: number;
      executionMode: string;
      goal: string | null;
      description: string | null;
    }
  >;
}
```

**Server-side flow:**

1. Fetch all project agents from DB
2. Compile each agent's DSL to IR
3. Call `extractAppStaticGraph()` for relationships
4. Extract `agentSummaries` from compiled IRs
5. Return simplified topology + summaries

**Client-side data flow:**

```
AgentListPage
  ├── useSWR('/api/projects/:id/agents')     → agents list
  ├── useSWR('/api/projects/:id/topology')   → topology + summaries
  │
  ├── <AgentMiniTopology topology={...} onSelectAgent={scrollToCard} />
  └── <div className="grid grid-cols-2">
        {agents.map(agent => <AgentCard agent={agent} summary={summaries[agent.name]} />)}
      </div>
```

**Error handling:**

- Topology failure: mini-map shows subtle warning, cards render fine without summaries
- Both SWR fetches are independent — topology failure doesn't block cards

---

## 5. Animations & Loading States

**Loading sequence:**

1. Mount → skeleton states immediately
2. Agents list arrives → cards stagger in
3. Topology arrives → mini-map fades in, pushes cards down with `springs.gentle`

**Skeletons:**

- Topology: `rounded-xl bg-background-elevated` ~150px with shimmer circles + lines
- Cards: 4 skeleton cards in 2-col grid with shimmer blocks

**Entrance animations:**

- Mini-map: container `animate-fade-in`, nodes scale in with `springs.soft` (100ms stagger), edges draw with `pathLength`
- Cards: `stagger-children` CSS class — each card `animate-fade-in-up` with 50ms delay

**Interaction animations:**

- Cards: `card-hover` (lift 2px + shadow-lg)
- Chat button: `opacity-0 group-hover:opacity-100 transition-default`
- Topology nodes: brightness + edge highlight on hover
- Topology click: brief scale pulse (`springs.snappy`)

All animations use existing CSS utilities and Framer Motion springs from `lib/animation.ts`.

---

## 6. File Plan

| Action | File                                                 | Purpose                                         |
| ------ | ---------------------------------------------------- | ----------------------------------------------- |
| Create | `src/components/agents/AgentMiniTopology.tsx`        | Compact SVG topology mini-map                   |
| Create | `src/components/agents/AgentCard.tsx`                | Rich agent card component                       |
| Create | `src/app/api/projects/[projectId]/topology/route.ts` | Server-side IR compilation endpoint             |
| Modify | `src/components/agents/AgentListPage.tsx`            | Wire up topology + cards grid, replace AgentRow |
| Create | `src/components/agents/AgentCardSkeleton.tsx`        | Skeleton loading for cards                      |
| Create | `src/components/agents/TopologySkeleton.tsx`         | Skeleton loading for mini-map                   |

All paths relative to `apps/studio/`. No changes to design tokens, stores, or existing types.

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the flat agent list with a compact topology mini-map and 2-column rich agent cards.

**Architecture:** New `GET /api/projects/:id/topology` endpoint compiles all agents to IR and extracts relationships. Client renders an SVG mini-map (`AgentMiniTopology`) above a responsive grid of `AgentCard` components. Both use SWR for data fetching.

**Tech Stack:** Next.js 15 API routes, `@abl/compiler` (compileABLtoIR, extractAppStaticGraph), `@abl/core` (parseAgentBasedABL), React 18, Framer Motion, SWR, Tailwind CSS, Lucide icons.

**Design doc:** `docs/plans/2026-02-20-agents-page-redesign-design.md`

---

## Task 1: Topology API Endpoint

Build the server-side endpoint that compiles project agents to IR and returns topology + agent summaries.

**Files:**

- Create: `apps/studio/src/app/api/projects/[id]/topology/route.ts`

**Step 1: Create the topology route file**

Create `apps/studio/src/app/api/projects/[id]/topology/route.ts`:

```typescript
/**
 * GET /api/projects/:id/topology — Compile agents and return topology graph + summaries
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR, platform } from '@abl/compiler';
import type { CompilationOutput } from '@abl/compiler';
import { getProjectAgents } from '@/services/project-service';
import { requireAuth, isAuthError } from '@/lib/auth';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  try {
    const agents = await getProjectAgents(id);

    if (!agents || agents.length === 0) {
      return NextResponse.json({
        topology: { nodes: [], edges: [] },
        agentSummaries: {},
      });
    }

    // Parse and compile all agents
    const parsedDocs: any[] = [];
    const parseErrors: string[] = [];

    for (const agent of agents) {
      if (!agent.dslContent) continue;
      const parsed = parseAgentBasedABL(agent.dslContent);
      if (parsed.errors.length > 0 || !parsed.document) {
        parseErrors.push(`${agent.name}: ${parsed.errors.map((e: any) => e.message).join(', ')}`);
        continue;
      }
      parsedDocs.push(parsed.document);
    }

    if (parsedDocs.length === 0) {
      return NextResponse.json({
        topology: { nodes: [], edges: [] },
        agentSummaries: {},
        errors: parseErrors.length > 0 ? parseErrors : undefined,
      });
    }

    // Compile all parsed documents together
    const compilation: CompilationOutput = compileABLtoIR(parsedDocs);

    // Extract app-level graph
    const appGraph = platform.extractAppStaticGraph(compilation, 'project');

    // Build simplified topology for the mini-map
    const nodes = appGraph.app.agents.map((agentName) => {
      const ir = compilation.agents[agentName];
      return {
        id: agentName,
        name: agentName,
        type: (ir?.metadata.type === 'supervisor' ? 'supervisor' : 'agent') as
          | 'supervisor'
          | 'agent',
        isEntry: agentName === appGraph.app.entryAgent,
        executionMode: (ir?.execution.mode || 'reasoning') as 'reasoning' | 'scripted',
      };
    });

    const edges = appGraph.app.connections.map((conn) => ({
      from: conn.from,
      to: conn.to,
      type: conn.type as 'routing' | 'handoff' | 'delegate' | 'escalation',
      label: conn.label || undefined,
    }));

    // Build agent summaries from compiled IR
    const agentSummaries: Record<
      string,
      {
        toolsCount: number;
        gatherFieldsCount: number;
        executionMode: string;
        goal: string | null;
        description: string | null;
      }
    > = {};

    for (const [name, ir] of Object.entries(compilation.agents)) {
      agentSummaries[name] = {
        toolsCount: ir.tools?.length ?? 0,
        gatherFieldsCount: ir.gather?.fields?.length ?? 0,
        executionMode: ir.execution?.mode ?? 'reasoning',
        goal: ir.identity?.goal ?? null,
        description: ir.identity?.description ?? ir.metadata?.name ?? null,
      };
    }

    return NextResponse.json({
      topology: { nodes, edges },
      agentSummaries,
      errors: parseErrors.length > 0 ? parseErrors : undefined,
    });
  } catch (error) {
    console.error('[Projects] Topology error:', error);
    return NextResponse.json({ error: 'Failed to compile topology' }, { status: 500 });
  }
}
```

**Step 2: Verify the endpoint compiles**

Run: `pnpm --filter @agent-platform/studio build`

Expected: Build succeeds with no type errors related to the new route.

**Step 3: Commit**

```bash
git add apps/studio/src/app/api/projects/[id]/topology/route.ts
git commit -m "[ABLP-2] feat(studio): add topology API endpoint for agents page"
```

---

## Task 2: AgentCard Component

Build the rich agent card that replaces `AgentRow`.

**Files:**

- Create: `apps/studio/src/components/agents/AgentCard.tsx`

**Step 1: Create AgentCard component**

Create `apps/studio/src/components/agents/AgentCard.tsx`:

```typescript
/**
 * AgentCard Component
 *
 * Rich card for the agents grid. Shows name, description, type badges,
 * metadata (tools, fields, domain), and version info.
 */

import { clsx } from 'clsx';
import {
  Bot,
  Sparkles,
  Network,
  Play,
  Tag,
  Clock,
  Wrench,
  FormInput,
} from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { parseActiveVersions, type RuntimeAgent } from '../../api/runtime-agents';

export interface AgentSummary {
  toolsCount: number;
  gatherFieldsCount: number;
  executionMode: string;
  goal: string | null;
  description: string | null;
}

interface AgentCardProps {
  agent: RuntimeAgent;
  summary?: AgentSummary | null;
  isStart: boolean;
  supervisor: boolean;
  onOpen: () => void;
  onChat: () => void;
  className?: string;
}

export function AgentCard({
  agent,
  summary,
  isStart,
  supervisor,
  onOpen,
  onChat,
  className,
}: AgentCardProps) {
  const versions = parseActiveVersions(agent.activeVersions);
  const activeVersion = versions.production || versions.staging || null;
  const executionMode = summary?.executionMode ?? (supervisor ? 'reasoning' : null);
  const description = summary?.description ?? agent.description;

  const cardVariant = isStart && supervisor
    ? 'border-accent/30 ring-1 ring-accent/10'
    : isStart
      ? 'border-accent/30'
      : supervisor
        ? 'border-purple/30'
        : 'border-default';

  const iconVariant = isStart
    ? 'bg-accent text-accent-foreground'
    : supervisor
      ? 'bg-purple-subtle text-purple'
      : 'bg-accent-subtle text-accent';

  return (
    <div
      onClick={onOpen}
      className={clsx(
        'rounded-xl border bg-background-elevated p-5 cursor-pointer card-hover group transition-default',
        cardVariant,
        className,
      )}
    >
      {/* Header: Icon + Name + Chat */}
      <div className="flex items-start gap-3">
        <div
          className={clsx(
            'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
            iconVariant,
          )}
        >
          {isStart ? (
            <Sparkles className="w-5 h-5" />
          ) : supervisor ? (
            <Network className="w-5 h-5" />
          ) : (
            <Bot className="w-5 h-5" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">
            {agent.name.replace(/_/g, ' ')}
          </h3>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {supervisor && <Badge variant="purple">Supervisor</Badge>}
            {isStart && <Badge variant="accent">Start</Badge>}
            {executionMode && (
              <Badge variant="default">
                {executionMode === 'scripted' ? 'Scripted' : 'Reasoning'}
              </Badge>
            )}
            {activeVersion && (
              <Badge variant="success" dot>
                Active
              </Badge>
            )}
          </div>
        </div>

        <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-default">
          <Button
            variant="ghost"
            size="sm"
            icon={<Play className="w-3.5 h-3.5" />}
            onClick={(e) => {
              e.stopPropagation();
              onChat();
            }}
          >
            Chat
          </Button>
        </div>
      </div>

      {/* Divider */}
      <div className="border-b border-default my-3" />

      {/* Description */}
      <p
        className={clsx(
          'text-sm line-clamp-2 mb-3',
          description ? 'text-muted' : 'text-subtle italic',
        )}
      >
        {description || 'No description'}
      </p>

      {/* Metadata */}
      <div className="flex items-center gap-3 text-xs text-muted">
        {agent.domain && (
          <span className="flex items-center gap-1">
            <Tag className="w-3 h-3" />
            {agent.domain}
          </span>
        )}
        {summary && summary.toolsCount > 0 && (
          <span className="flex items-center gap-1">
            <Wrench className="w-3 h-3" />
            {summary.toolsCount} tool{summary.toolsCount !== 1 ? 's' : ''}
          </span>
        )}
        {summary && summary.gatherFieldsCount > 0 && (
          <span className="flex items-center gap-1">
            <FormInput className="w-3 h-3" />
            {summary.gatherFieldsCount} field{summary.gatherFieldsCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 mt-2 text-xs text-dim">
        {activeVersion && (
          <span>{activeVersion} production</span>
        )}
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {formatRelativeTime(agent.updatedAt)}
        </span>
      </div>
    </div>
  );
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
```

**Step 2: Verify the component compiles**

Run: `pnpm --filter @agent-platform/studio build`

Expected: Build succeeds. (Component not wired up yet — just verifying types.)

**Step 3: Commit**

```bash
git add apps/studio/src/components/agents/AgentCard.tsx
git commit -m "[ABLP-2] feat(studio): add AgentCard component for agents grid"
```

---

## Task 3: Skeleton Components

Build skeleton loading placeholders for both the topology and cards.

**Files:**

- Create: `apps/studio/src/components/agents/TopologySkeleton.tsx`
- Create: `apps/studio/src/components/agents/AgentCardSkeleton.tsx`

**Step 1: Create TopologySkeleton**

Create `apps/studio/src/components/agents/TopologySkeleton.tsx`:

```typescript
/**
 * TopologySkeleton — shimmer placeholder for the topology mini-map.
 */

import { clsx } from 'clsx';

export function TopologySkeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-default bg-background-elevated p-6',
        className,
      )}
    >
      <div className="flex items-center justify-center gap-8 h-[100px]">
        {/* Supervisor node */}
        <div className="flex flex-col items-center gap-2">
          <div className="w-24 h-8 rounded-full skeleton" />
          <div className="w-16 h-2 rounded skeleton" />
        </div>

        {/* Connection lines placeholder */}
        <div className="flex flex-col gap-3">
          <div className="w-12 h-0.5 skeleton" />
          <div className="w-12 h-0.5 skeleton" />
          <div className="w-12 h-0.5 skeleton" />
        </div>

        {/* Child nodes */}
        <div className="flex flex-col gap-3">
          <div className="w-20 h-7 rounded-full skeleton" />
          <div className="w-20 h-7 rounded-full skeleton" />
          <div className="w-20 h-7 rounded-full skeleton" />
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Create AgentCardSkeleton**

Create `apps/studio/src/components/agents/AgentCardSkeleton.tsx`:

```typescript
/**
 * AgentCardSkeleton — shimmer placeholder for agent cards.
 */

import { clsx } from 'clsx';

export function AgentCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-default bg-background-elevated p-5',
        className,
      )}
    >
      {/* Header row */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg skeleton shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="w-32 h-4 rounded skeleton mb-2" />
          <div className="flex gap-1.5">
            <div className="w-16 h-5 rounded-full skeleton" />
            <div className="w-20 h-5 rounded-full skeleton" />
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="border-b border-default my-3" />

      {/* Description lines */}
      <div className="w-full h-3 rounded skeleton mb-2" />
      <div className="w-3/4 h-3 rounded skeleton mb-3" />

      {/* Metadata */}
      <div className="flex gap-3">
        <div className="w-20 h-3 rounded skeleton" />
        <div className="w-16 h-3 rounded skeleton" />
      </div>

      {/* Footer */}
      <div className="w-24 h-3 rounded skeleton mt-2" />
    </div>
  );
}

export function AgentCardSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <AgentCardSkeleton key={i} />
      ))}
    </div>
  );
}
```

**Step 3: Verify build**

Run: `pnpm --filter @agent-platform/studio build`

Expected: Build succeeds.

**Step 4: Commit**

```bash
git add apps/studio/src/components/agents/TopologySkeleton.tsx apps/studio/src/components/agents/AgentCardSkeleton.tsx
git commit -m "[ABLP-2] feat(studio): add skeleton loading components for agents page"
```

---

## Task 4: AgentMiniTopology Component

Build the compact SVG topology mini-map.

**Files:**

- Create: `apps/studio/src/components/agents/AgentMiniTopology.tsx`

**Step 1: Create the mini topology component**

Create `apps/studio/src/components/agents/AgentMiniTopology.tsx`:

```typescript
/**
 * AgentMiniTopology Component
 *
 * Compact SVG mini-map showing agent relationships.
 * Horizontal BFS layout — supervisor at left, children fanning right.
 * Click a node to scroll to its card.
 */

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { springs } from '../../lib/animation';

// ─── Types ───────────────────────────────────────────────

interface TopoNode {
  id: string;
  name: string;
  type: 'supervisor' | 'agent';
  isEntry: boolean;
  executionMode: 'reasoning' | 'scripted';
}

interface TopoEdge {
  from: string;
  to: string;
  type: 'routing' | 'handoff' | 'delegate' | 'escalation';
  label?: string;
}

export interface MiniTopologyData {
  nodes: TopoNode[];
  edges: TopoEdge[];
}

interface AgentMiniTopologyProps {
  topology: MiniTopologyData;
  onSelectAgent?: (agentName: string) => void;
  className?: string;
}

// ─── Layout Constants ────────────────────────────────────

const NW = 100;
const NH = 32;
const LEVEL_GAP = 60;
const NODE_GAP = 12;
const PADDING = 24;
const MAX_VISIBLE_NODES = 8;

// ─── Layout ──────────────────────────────────────────────

interface LayoutNode {
  node: TopoNode;
  x: number;
  y: number;
  col: number;
}

function layoutMiniTopology(topology: MiniTopologyData): {
  nodes: LayoutNode[];
  width: number;
  height: number;
  overflow: number;
} {
  if (topology.nodes.length === 0) {
    return { nodes: [], width: 200, height: 80, overflow: 0 };
  }

  const entryNode = topology.nodes.find((n) => n.isEntry) ?? topology.nodes[0];

  // Build adjacency
  const children = new Map<string, string[]>();
  for (const edge of topology.edges) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from)!.push(edge.to);
  }

  // BFS to assign columns (horizontal layout)
  const visited = new Set<string>();
  const colMap = new Map<string, number>();
  const queue: { id: string; col: number }[] = [{ id: entryNode.id, col: 0 }];
  visited.add(entryNode.id);
  colMap.set(entryNode.id, 0);

  while (queue.length > 0) {
    const { id, col } = queue.shift()!;
    const kids = children.get(id) ?? [];
    for (const kid of kids) {
      if (!visited.has(kid) && topology.nodes.some((n) => n.id === kid)) {
        visited.add(kid);
        colMap.set(kid, col + 1);
        queue.push({ id: kid, col: col + 1 });
      }
    }
  }

  // Add unvisited nodes at col 1
  for (const node of topology.nodes) {
    if (!colMap.has(node.id)) {
      colMap.set(node.id, 1);
    }
  }

  // Determine overflow
  const overflow = Math.max(0, topology.nodes.length - MAX_VISIBLE_NODES);
  const visibleNodes = topology.nodes.slice(0, MAX_VISIBLE_NODES);

  // Group by column
  const columns = new Map<number, TopoNode[]>();
  for (const node of visibleNodes) {
    const col = colMap.get(node.id) ?? 1;
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col)!.push(node);
  }

  const maxCol = Math.max(...Array.from(columns.keys()), 0);

  // Position nodes
  const layoutNodes: LayoutNode[] = [];
  let maxHeight = 0;

  for (let col = 0; col <= maxCol; col++) {
    const nodesAtCol = columns.get(col) ?? [];
    const totalHeight = nodesAtCol.length * NH + (nodesAtCol.length - 1) * NODE_GAP;
    maxHeight = Math.max(maxHeight, totalHeight);

    for (let i = 0; i < nodesAtCol.length; i++) {
      const x = PADDING + col * (NW + LEVEL_GAP);
      const y = PADDING + i * (NH + NODE_GAP);
      layoutNodes.push({ node: nodesAtCol[i], x, y, col });
    }
  }

  // Center vertically
  for (let col = 0; col <= maxCol; col++) {
    const nodesAtCol = layoutNodes.filter((n) => n.col === col);
    const totalHeight = nodesAtCol.length * NH + (nodesAtCol.length - 1) * NODE_GAP;
    const offset = (maxHeight - totalHeight) / 2;
    for (const n of nodesAtCol) {
      n.y += offset;
    }
  }

  const width = PADDING * 2 + (maxCol + 1) * NW + maxCol * LEVEL_GAP;
  const height = PADDING * 2 + maxHeight;

  return { nodes: layoutNodes, width, height: Math.max(height, 80), overflow };
}

// ─── Bezier Path ─────────────────────────────────────────

function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
}

// ─── Edge Styles ─────────────────────────────────────────

function edgeStroke(type: TopoEdge['type'], active: boolean): string {
  if (active) return 'hsl(var(--accent))';
  switch (type) {
    case 'delegate': return 'hsl(var(--purple))';
    case 'escalation': return 'hsl(var(--error))';
    default: return 'hsl(var(--accent) / 0.4)';
  }
}

function edgeDash(type: TopoEdge['type']): string | undefined {
  switch (type) {
    case 'delegate': return '6 3';
    case 'escalation': return '3 3';
    default: return undefined;
  }
}

// ─── Component ───────────────────────────────────────────

export function AgentMiniTopology({
  topology,
  onSelectAgent,
  className,
}: AgentMiniTopologyProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const layout = useMemo(() => layoutMiniTopology(topology), [topology]);

  // Don't render if only 1 node with no edges
  if (topology.nodes.length <= 1 && topology.edges.length === 0) {
    return null;
  }

  const posMap = new Map<string, { cx: number; cy: number }>();
  for (const ln of layout.nodes) {
    posMap.set(ln.node.id, { cx: ln.x + NW / 2, cy: ln.y + NH / 2 });
  }

  return (
    <div
      className={clsx(
        'rounded-xl border border-default bg-background-elevated overflow-auto',
        className,
      )}
    >
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="block mx-auto"
      >
        {/* Edges */}
        {topology.edges.map((edge, i) => {
          const from = posMap.get(edge.from);
          const to = posMap.get(edge.to);
          if (!from || !to) return null;

          const active = hoveredId === edge.from || hoveredId === edge.to;

          return (
            <motion.path
              key={`edge-${i}`}
              d={bezierPath(from.cx + NW / 2, from.cy, to.cx - NW / 2, to.cy)}
              fill="none"
              stroke={edgeStroke(edge.type, active)}
              strokeWidth={active ? 2 : 1.5}
              strokeDasharray={edgeDash(edge.type)}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: active ? 1 : 0.7 }}
              transition={{ delay: 0.3 + i * 0.08, duration: 0.4 }}
            />
          );
        })}

        {/* Nodes */}
        {layout.nodes.map((ln, i) => {
          const isHovered = hoveredId === ln.node.id;
          const isSupervisor = ln.node.type === 'supervisor';

          const fill = isSupervisor
            ? 'hsl(var(--accent-subtle))'
            : isHovered
              ? 'hsl(var(--background-muted))'
              : 'hsl(var(--background-elevated))';
          const stroke = isSupervisor || isHovered
            ? 'hsl(var(--accent) / 0.5)'
            : 'hsl(var(--border))';

          return (
            <motion.g
              key={ln.node.id}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.1, ...springs.soft }}
              style={{ cursor: onSelectAgent ? 'pointer' : 'default' }}
              onClick={() => onSelectAgent?.(ln.node.id)}
              onMouseEnter={() => setHoveredId(ln.node.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <rect
                x={ln.x}
                y={ln.y}
                width={NW}
                height={NH}
                rx={NH / 2}
                fill={fill}
                stroke={stroke}
                strokeWidth={isHovered ? 2 : 1}
              />

              {/* Entry indicator */}
              {ln.node.isEntry && (
                <circle
                  cx={ln.x + 10}
                  cy={ln.y + NH / 2}
                  r={3}
                  fill="hsl(var(--accent))"
                />
              )}

              <text
                x={ln.x + NW / 2}
                y={ln.y + NH / 2 + 1}
                fontSize={10}
                fontWeight={isSupervisor ? '600' : '500'}
                fill={isSupervisor ? 'hsl(var(--accent))' : 'hsl(var(--foreground))'}
                textAnchor="middle"
                dominantBaseline="middle"
                fontFamily="var(--font-sans)"
              >
                {ln.node.name.length > 12
                  ? ln.node.name.slice(0, 11) + '\u2026'
                  : ln.node.name}
              </text>
            </motion.g>
          );
        })}

        {/* Overflow indicator */}
        {layout.overflow > 0 && (
          <motion.g
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.8 }}
          >
            <rect
              x={layout.width - PADDING - 50}
              y={layout.height / 2 - NH / 2}
              width={50}
              height={NH}
              rx={NH / 2}
              fill="hsl(var(--background-muted))"
              stroke="hsl(var(--border))"
              strokeWidth={1}
            />
            <text
              x={layout.width - PADDING - 25}
              y={layout.height / 2 + 1}
              fontSize={10}
              fontWeight="500"
              fill="hsl(var(--foreground-muted))"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              +{layout.overflow}
            </text>
          </motion.g>
        )}
      </svg>
    </div>
  );
}
```

**Step 2: Verify build**

Run: `pnpm --filter @agent-platform/studio build`

Expected: Build succeeds.

**Step 3: Commit**

```bash
git add apps/studio/src/components/agents/AgentMiniTopology.tsx
git commit -m "[ABLP-2] feat(studio): add AgentMiniTopology compact SVG component"
```

---

## Task 5: Wire Everything into AgentListPage

Replace `AgentRow` with the new components and add topology fetching.

**Files:**

- Modify: `apps/studio/src/components/agents/AgentListPage.tsx`

**Step 1: Rewrite AgentListPage**

Replace the entire contents of `apps/studio/src/components/agents/AgentListPage.tsx`:

```typescript
/**
 * AgentListPage Component
 *
 * Grid of agents with a compact topology mini-map.
 * Default view when selecting a project.
 */

import { useRef, useState, useCallback } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Bot, Plus, Search, Network, Upload } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useProjectStore } from '../../store/project-store';
import {
  parseActiveVersions,
  type RuntimeAgent,
  type RuntimeAgentListResponse,
} from '../../api/runtime-agents';
import { updateProject } from '../../api/projects';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { EmptyState } from '../ui/EmptyState';
import { CreateAgentDialog } from './CreateAgentDialog';
import { ImportDialog } from '../projects/ImportDialog';
import { AgentCard, type AgentSummary } from './AgentCard';
import { AgentMiniTopology, type MiniTopologyData } from './AgentMiniTopology';
import { TopologySkeleton } from './TopologySkeleton';
import { AgentCardSkeletonGrid } from './AgentCardSkeleton';

// ─── Types ───────────────────────────────────────────────

interface TopologyResponse {
  topology: MiniTopologyData;
  agentSummaries: Record<string, AgentSummary>;
  errors?: string[];
}

// ─── Helpers ─────────────────────────────────────────────

function isSupervisor(agent: RuntimeAgent): boolean {
  if (!agent.dslContent) return false;
  return /^\s*SUPERVISOR\s*:/m.test(agent.dslContent);
}

function findStartAgentId(agents: RuntimeAgent[], entryAgentName?: string | null): string | null {
  if (agents.length === 0) return null;

  if (entryAgentName) {
    const explicit = agents.find((a) => a.name === entryAgentName);
    if (explicit) return explicit.id;
  }

  const supervisor = agents.find(isSupervisor);
  if (supervisor) return supervisor.id;

  const sorted = [...agents].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  return sorted[0].id;
}

// ─── Component ───────────────────────────────────────────

export function AgentListPage() {
  const { projectId, navigate } = useNavigationStore();
  const { currentProject, updateProject: updateProjectStore } = useProjectStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Fetch agents
  const agentsKey = projectId ? `/api/projects/${projectId}/agents` : null;
  const {
    data: agentsData,
    error: agentsError,
    isLoading: agentsLoading,
    mutate,
  } = useSWR<RuntimeAgentListResponse>(agentsKey);
  const agents = agentsData?.agents ?? [];
  const error = agentsError ? String(agentsError) : null;

  // Fetch topology (independent SWR call)
  const topoKey = projectId && agents.length > 0
    ? `/api/projects/${projectId}/topology`
    : null;
  const { data: topoData, isLoading: topoLoading } = useSWR<TopologyResponse>(topoKey);

  const startAgentId = findStartAgentId(agents, currentProject?.entryAgentName);

  const filtered = agents
    .filter(
      (a) =>
        a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.description?.toLowerCase().includes(searchQuery.toLowerCase()),
    )
    .sort((a, b) => {
      if (a.id === startAgentId) return -1;
      if (b.id === startAgentId) return 1;
      return 0;
    });

  const handleOpenAgent = (agent: RuntimeAgent) => {
    navigate(`/projects/${projectId}/agents/${agent.name}`);
  };

  const handleChatAgent = (agent: RuntimeAgent) => {
    navigate(`/projects/${projectId}/agents/${agent.name}/chat`);
  };

  const handleAgentCreated = (agentName: string) => {
    setShowCreateDialog(false);
    mutate();
    navigate(`/projects/${projectId}/agents/${agentName}`);
  };

  const handleStartAgentChange = async (value: string) => {
    if (!projectId) return;
    const entryAgentName = value || null;
    try {
      await updateProject(projectId, { entryAgentName });
      updateProjectStore(projectId, { entryAgentName });
      toast.success(
        entryAgentName ? `Start agent set to ${entryAgentName}` : 'Start agent set to auto-detect',
      );
    } catch (err) {
      console.error('Failed to update start agent:', err);
      toast.error('Failed to update start agent');
    }
  };

  const handleTopologySelect = useCallback((agentName: string) => {
    const el = cardRefs.current.get(agentName);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight animation
      el.classList.add('ring-2', 'ring-accent/40');
      setTimeout(() => el.classList.remove('ring-2', 'ring-accent/40'), 1500);
    }
  }, []);

  const startAgentOptions = [
    { value: '', label: 'Auto-detect' },
    ...agents.map((a) => ({ value: a.name, label: a.name.replace(/_/g, ' ') })),
  ];

  // Should we show the topology?
  const showTopology = !agentsLoading && agents.length > 1;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <PageHeader
          title="Agents"
          description={
            currentProject
              ? `${currentProject.name} — ${agents.length} agent${agents.length !== 1 ? 's' : ''}`
              : undefined
          }
        />

        {/* Search + Create + Start Agent */}
        <div className="mt-6 mb-6 flex items-end gap-3">
          <div className="flex-1">
            <Input
              placeholder="Search agents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              icon={<Search className="w-4 h-4" />}
            />
          </div>
          {agents.length > 1 && (
            <div className="w-48">
              <Select
                label="Start Agent"
                options={startAgentOptions}
                value={currentProject?.entryAgentName ?? ''}
                onChange={(e) => handleStartAgentChange(e.target.value)}
              />
            </div>
          )}
          <Button
            variant="ghost"
            icon={<Upload className="w-4 h-4" />}
            onClick={() => setShowImport(true)}
          >
            Import
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreateDialog(true)}>
            Create Agent
          </Button>
        </div>

        {/* Topology Mini-Map */}
        {showTopology && (
          topoLoading ? (
            <TopologySkeleton className="mb-6" />
          ) : topoData?.topology && topoData.topology.edges.length > 0 ? (
            <div className="mb-6 animate-fade-in">
              <AgentMiniTopology
                topology={topoData.topology}
                onSelectAgent={handleTopologySelect}
              />
            </div>
          ) : null
        )}

        {/* Agent Cards */}
        {agentsLoading ? (
          <AgentCardSkeletonGrid />
        ) : error ? (
          <EmptyState
            icon={<Bot className="w-6 h-6" />}
            title="Failed to load agents"
            description={error}
            action={
              <Button variant="secondary" onClick={() => mutate()}>
                Retry
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          searchQuery ? (
            <EmptyState
              icon={<Search className="w-6 h-6" />}
              title="No matching agents"
              description={`No agents match "${searchQuery}"`}
            />
          ) : (
            <EmptyState
              icon={<Bot className="w-6 h-6" />}
              title="No agents yet"
              description="Create your first agent to get started"
              action={
                <Button
                  icon={<Plus className="w-4 h-4" />}
                  onClick={() => setShowCreateDialog(true)}
                >
                  Create Agent
                </Button>
              }
            />
          )
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 stagger-children">
            {filtered.map((agent) => (
              <div
                key={agent.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(agent.name, el);
                }}
              >
                <AgentCard
                  agent={agent}
                  summary={topoData?.agentSummaries?.[agent.name] ?? null}
                  isStart={agent.id === startAgentId}
                  supervisor={isSupervisor(agent)}
                  onOpen={() => handleOpenAgent(agent)}
                  onChat={() => handleChatAgent(agent)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Agent Dialog */}
      {projectId && (
        <CreateAgentDialog
          open={showCreateDialog}
          onClose={() => setShowCreateDialog(false)}
          projectId={projectId}
          onCreated={handleAgentCreated}
        />
      )}

      {/* Import Dialog */}
      {projectId && (
        <ImportDialog
          open={showImport}
          onClose={() => setShowImport(false)}
          projectId={projectId}
          onImported={() => mutate()}
        />
      )}
    </div>
  );
}
```

**Step 2: Verify build**

Run: `pnpm --filter @agent-platform/studio build`

Expected: Build succeeds. All imports resolve. No type errors.

**Step 3: Visual verification**

Run: `pnpm --filter @agent-platform/studio dev`

Open http://localhost:3000, navigate to a project with agents. Verify:

- Topology mini-map renders above the card grid (if 2+ agents with relationships)
- Cards show in a 2-column grid with name, badges, description, metadata
- Skeleton loading appears before data arrives
- Clicking a topology node scrolls to the corresponding card
- Hover effects work on cards (lift + shadow)
- Chat button appears on card hover
- Empty state shows when no agents
- Search filtering works

**Step 4: Commit**

```bash
git add apps/studio/src/components/agents/AgentListPage.tsx
git commit -m "[ABLP-2] feat(studio): wire topology + rich cards into agents page"
```

---

## Task 6: Polish & Edge Cases

Handle remaining edge cases and visual refinements.

**Files:**

- Modify: `apps/studio/src/components/agents/AgentListPage.tsx` (minor)
- Modify: `apps/studio/src/components/agents/AgentMiniTopology.tsx` (minor)

**Step 1: Add topology error handling**

In `AgentListPage.tsx`, after the topology SWR hook, add a fallback for compilation errors:

```typescript
// After the topoData check in the topology section, add:
{topoData?.errors && topoData.errors.length > 0 && (
  <div className="mb-6 rounded-xl border border-warning/30 bg-warning-subtle/30 px-4 py-3 text-xs text-warning">
    Topology incomplete — {topoData.errors.length} agent{topoData.errors.length !== 1 ? 's' : ''} failed to compile
  </div>
)}
```

**Step 2: Add card transition class for highlight**

In `AgentCard.tsx`, add `transition-all duration-300` to the outer div so the ring highlight from topology click animates smoothly. The `transition-default` class should already handle this.

**Step 3: Verify all edge cases**

Test manually:

- Project with 0 agents → empty state
- Project with 1 agent → no topology, single card
- Project with 2+ agents, no supervisor → no topology edges, cards render
- Project with supervisor + children → topology + cards
- Agent with no description → "No description" italic fallback
- Agent with no dslContent → card renders without enriched data
- Search filtering → topology stays visible, cards filter

**Step 4: Commit**

```bash
git add -A
git commit -m "[ABLP-2] fix(studio): add topology error handling and polish edge cases"
```

---

## Verification Checklist

After all tasks, run:

```bash
pnpm --filter @agent-platform/studio build
```

Verify visually:

- [ ] Topology renders for multi-agent projects with relationships
- [ ] Topology hides for single-agent projects
- [ ] Cards show in 2-column grid
- [ ] Cards display: name, badges, description, metadata, version, relative time
- [ ] Skeleton loading for both topology and cards
- [ ] Click topology node → scroll to card
- [ ] Card click → navigate to agent detail
- [ ] Card hover → lift + shadow + chat button
- [ ] Search works
- [ ] Start agent selector works
- [ ] Empty states render correctly
- [ ] Stagger entrance animations play
