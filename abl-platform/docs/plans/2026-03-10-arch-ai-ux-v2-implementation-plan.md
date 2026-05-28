# Arch AI UX V2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build parallel v2 chat + artifact components with Q&A history, XyFlow topology graph, Monaco ABL editor, and smart tab management — zero changes to v1.

**Architecture:** New components alongside v1. Single boolean flag in AppShell switches between them. V2 reuses existing `ProjectCanvas`, `AgentNode`, `ABLEditor`, `transform.ts`, and all ask-user renderers. Same `/api/arch-ai/chat` route and tools.

**Tech Stack:** React, Zustand, XyFlow/ReactFlow, Monaco Editor (@monaco-editor/react), Tailwind CSS, Framer Motion.

**Design doc:** `docs/plans/2026-03-10-arch-ai-ux-v2-design.md`

**CRITICAL:** Do NOT modify any existing v1 component. Only create new files and modify AppShell for the flag switch.

---

## Task 1: QACard + ConversationDivider Components

**Files:**

- Create: `apps/studio/src/components/arch-ai/v2/QACard.tsx`
- Create: `apps/studio/src/components/arch-ai/v2/ConversationDivider.tsx`

**Step 1: Create QACard**

Shows the question text + answered value together as a card. When answered, the interactive component collapses to show question + answer chips.

```tsx
// QACard.tsx
'use client';
import { clsx } from 'clsx';

interface QACardProps {
  question: string;
  answer: string | string[];
  componentType?: string;
}

export function QACard({ question, answer, componentType }: QACardProps) {
  const answers = Array.isArray(answer) ? answer : [answer];
  const isConfirmation = componentType === 'confirmation';

  return (
    <div className="my-3 rounded-xl border border-border/60 bg-background-subtle/50 px-4 py-3">
      <p className="text-sm text-muted-foreground mb-2">{question}</p>
      <div className="flex flex-wrap gap-1.5">
        {answers.map((a, i) => (
          <span
            key={i}
            className={clsx(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
              isConfirmation
                ? a === 'confirmed'
                  ? 'bg-green-500/10 text-green-600'
                  : 'bg-muted text-muted-foreground'
                : 'bg-purple/10 text-purple',
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40" />
            {a}
          </span>
        ))}
      </div>
    </div>
  );
}
```

**Step 2: Create ConversationDivider**

```tsx
// ConversationDivider.tsx
'use client';

interface ConversationDividerProps {
  label: string;
  status?: 'running' | 'complete' | 'error';
}

export function ConversationDivider({ label, status = 'complete' }: ConversationDividerProps) {
  return (
    <div className="flex items-center gap-3 my-4 px-2">
      <div className="flex-1 h-px bg-border/50" />
      <span className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1.5">
        {status === 'running' && (
          <span className="w-1.5 h-1.5 rounded-full bg-purple animate-pulse" />
        )}
        {status === 'complete' && <span className="w-1.5 h-1.5 rounded-full bg-green-500" />}
        {label}
      </span>
      <div className="flex-1 h-px bg-border/50" />
    </div>
  );
}
```

**Step 3: Verify they render** (manual — import in a test page or storybook-style)

---

## Task 2: TopologyGraphTab — XyFlow Canvas

**Files:**

- Create: `apps/studio/src/components/arch-ai/v2/TopologyGraphTab.tsx`

**Step 1: Create TopologyGraphTab**

Wraps the existing `ProjectCanvas` with topology data from the chat store. Read-only mode — no editing, no drag-to-connect.

```tsx
// TopologyGraphTab.tsx
'use client';
import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useChatStore } from '@/store/chat-store';
import type { TopologyData, TopologyNode, TopologyEdge } from '@/types/arch';

// Lazy-load ReactFlow (heavy dependency)
const ProjectCanvas = dynamic(
  () => import('@/components/canvas/ProjectCanvas').then((m) => ({ default: m.ProjectCanvas })),
  { ssr: false, loading: () => <CanvasPlaceholder /> },
);

export function TopologyGraphTab() {
  const rawTopology = useChatStore((s) => s.artifacts.topology);

  // Transform topology to use real agent names as IDs (fix supervisor_001 issue)
  const topology = useMemo<TopologyData | null>(() => {
    if (!rawTopology?.nodes) return null;

    const nameMap = new Map<string, string>();
    const nodes: TopologyNode[] = rawTopology.nodes.map((n: any) => {
      const name = n.name ?? n.id;
      nameMap.set(n.id, name);
      return {
        ...n,
        id: name,
        name,
        isEntry: n.isEntry ?? n.type === 'supervisor',
      };
    });

    const edges: TopologyEdge[] = (rawTopology.edges ?? []).map((e: any) => ({
      ...e,
      from: nameMap.get(e.from ?? e.source) ?? e.from ?? e.source,
      to: nameMap.get(e.to ?? e.target) ?? e.to ?? e.target,
    }));

    return { nodes, edges };
  }, [rawTopology]);

  if (!topology) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Topology will appear here after generation.
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <ProjectCanvas topology={topology} projectId="preview" className="h-full" />
    </div>
  );
}

function CanvasPlaceholder() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-6 h-6 border-2 border-purple/30 border-t-purple rounded-full animate-spin" />
    </div>
  );
}
```

**Note:** `ProjectCanvas` expects a `projectId` prop. For preview mode, pass `"preview"` — the canvas won't make API calls in read-only rendering. If it does, we can add a `readOnly` prop check.

---

## Task 3: AgentCodeTab — Monaco Editor Accordion

**Files:**

- Create: `apps/studio/src/components/arch-ai/v2/AgentCodeTab.tsx`

**Step 1: Create AgentCodeTab**

Accordion list of agents. Expanding an agent shows read-only Monaco editor with ABL syntax highlighting.

```tsx
// AgentCodeTab.tsx
'use client';
import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import dynamic from 'next/dynamic';
import { useChatStore } from '@/store/chat-store';

// Lazy-load Monaco (very heavy)
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

export function AgentCodeTab() {
  const agents = useChatStore((s) => s.artifacts.agents);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  // Auto-expand first agent
  const firstAgent = agents?.[0]?.name;
  const activeAgent = expandedAgent ?? firstAgent ?? null;

  if (!agents || agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Agents will appear here after generation.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {agents.map((agent: any) => {
        const isExpanded = agent.name === activeAgent;
        const hasCode = !!agent.ablContent?.trim();
        const isValid = agent.validationStatus !== 'failed' && agent.validationStatus !== 'error';
        const isGenerating = agent.validationStatus === 'generating';

        return (
          <div key={agent.name} className="border-b border-border last:border-b-0">
            {/* Header */}
            <button
              onClick={() => setExpandedAgent(isExpanded ? null : agent.name)}
              className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-accent/5 transition-colors"
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}

              {/* Status icon */}
              {isGenerating ? (
                <Loader2 className="h-3.5 w-3.5 text-purple animate-spin" />
              ) : isValid && hasCode ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
              )}

              <span className="text-sm font-medium text-foreground truncate">
                {formatName(agent.name)}
              </span>

              <div className="ml-auto flex items-center gap-1.5">
                {agent.mode && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-muted-foreground">
                    {agent.mode}
                  </span>
                )}
                {(agent.type === 'supervisor' ||
                  agent.name?.toLowerCase().includes('supervisor')) && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple/10 text-purple">
                    supervisor
                  </span>
                )}
              </div>
            </button>

            {/* Monaco editor */}
            {isExpanded && hasCode && (
              <div className="h-[300px] border-t border-border">
                <MonacoEditor
                  height="100%"
                  language="yaml"
                  theme="vs-dark"
                  value={agent.ablContent}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    lineNumbers: 'on',
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    padding: { top: 8, bottom: 8 },
                    renderLineHighlight: 'none',
                    wordWrap: 'on',
                  }}
                />
              </div>
            )}

            {/* No code fallback */}
            {isExpanded && !hasCode && (
              <div className="px-4 py-3 text-xs text-muted-foreground border-t border-border bg-background-subtle">
                {isGenerating
                  ? 'Generating...'
                  : 'No ABL code available — agent will be created with minimal definition.'}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatName(name: string): string {
  return name.replace(/_/g, ' ');
}
```

**Note:** Uses `vs-dark` theme and `yaml` language mode. ABL syntax is close enough to YAML for basic highlighting. The existing `abl-monarch.ts` tokenizer can be registered if needed, but for read-only preview `yaml` is sufficient.

---

## Task 4: ArtifactPanelV2 — Smart Tabs + Auto-Switch

**Files:**

- Create: `apps/studio/src/components/arch-ai/v2/ArtifactPanelV2.tsx`

**Step 1: Create ArtifactPanelV2**

Smart tabs: only show what has data. Auto-switch to Agents when generation starts.

```tsx
// ArtifactPanelV2.tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { clsx } from 'clsx';
import { useChatStore } from '@/store/chat-store';
import { TopologyGraphTab } from './TopologyGraphTab';
import { AgentCodeTab } from './AgentCodeTab';

type TabId = 'topology' | 'agents';

export function ArtifactPanelV2({
  onClose,
  onCreateProject,
}: {
  onClose: () => void;
  onCreateProject: () => void;
}) {
  const topology = useChatStore((s) => s.artifacts.topology);
  const agents = useChatStore((s) => s.artifacts.agents);
  const isCreating = useChatStore((s) => s.isCreating);

  const hasTopology = !!topology?.nodes?.length;
  const hasAgents = agents && agents.length > 0;

  // Determine available tabs
  const tabs: { id: TabId; label: string; count?: number }[] = [];
  if (hasTopology) tabs.push({ id: 'topology', label: 'Topology', count: topology?.nodes?.length });
  if (hasAgents) tabs.push({ id: 'agents', label: 'Agents', count: agents?.length });

  // Auto-switch: when agents appear for the first time, switch to agents tab
  const [activeTab, setActiveTab] = useState<TabId>('topology');
  const prevHadAgents = useRef(false);
  useEffect(() => {
    if (hasAgents && !prevHadAgents.current) {
      setActiveTab('agents');
      prevHadAgents.current = true;
    }
  }, [hasAgents]);

  // If no data at all, don't render
  if (tabs.length === 0) return null;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Tab bar */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5',
                activeTab === tab.id
                  ? 'bg-accent/15 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/10',
              )}
            >
              {tab.label}
              {tab.count != null && (
                <span className="text-[10px] text-muted-foreground/60">{tab.count}</span>
              )}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/10 hover:text-foreground transition-colors"
          aria-label="Close preview"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'topology' && <TopologyGraphTab />}
        {activeTab === 'agents' && <AgentCodeTab />}
      </div>

      {/* Action bar */}
      {!isCreating && (hasTopology || hasAgents) && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onCreateProject}
            className="px-4 py-2 rounded-lg bg-purple text-white text-sm font-medium hover:bg-purple/90 transition-colors"
          >
            Create Project
          </button>
        </div>
      )}
    </div>
  );
}
```

---

## Task 5: ArchChatPanelV2 — Chat with Q&A History

**Files:**

- Create: `apps/studio/src/components/arch-ai/v2/ArchChatPanelV2.tsx`

This is the core component. It wraps the existing `useChat` hook but renders messages differently:

- User messages: right-aligned bubbles
- Assistant text: left-aligned prose
- ask_user tool: `QACard` showing question + answer
- generate_topology: `ConversationDivider("Generating architecture")` + inline preview
- generate_agents: `ConversationDivider("Generating agents")` + inline preview
- create_project: `CreateProjectApproval` (reuse existing)

**Key difference from v1:** When an `ask_user` tool result is rendered, show the question (from `input.question`) AND the answer. V1 only shows "Answered: X".

Implementation approach:

- Copy the `useChat` setup from v1 `ArchAIChatPanel.tsx` (transport, sendAutomaticallyWhen)
- Reuse existing `AskUserRenderer`, `ThinkingIndicator`, `InlineTopologyPreview`, `InlineAgentsPreview`, `CreateProjectApproval`
- Replace the `AnsweredChip` with `QACard`
- Add `ConversationDivider` between phases
- Reuse `ChatInputBar` for input

**Step 1:** Create the file by adapting v1's message rendering logic. The file will be ~400 lines. Key changes:

1. Replace `AnsweredChip` usage with `QACard`:

```tsx
// V1: <AnsweredChip input={input} output={output} />
// V2:
<QACard question={input?.question ?? ''} answer={output} componentType={input?.component?.type} />
```

2. Add ConversationDivider before tool calls:

```tsx
if (toolName === 'generate_topology') {
  if (state === 'call' || state === 'input-available') {
    return (
      <ConversationDivider key={toolCallId} label="Generating architecture" status="running" />
    );
  }
  // ... existing topology preview
}
```

3. Wire artifact versions to v2 store (same useEffect as v1, no changes needed)

---

## Task 6: ChatPageV2 + ProjectArchAIPageV2 — Layout Wrappers

**Files:**

- Create: `apps/studio/src/components/arch-ai/v2/ChatPageV2.tsx`
- Create: `apps/studio/src/components/arch-ai/v2/ProjectArchAIPageV2.tsx`

These are thin wrappers that compose:

- `ArchChatPanelV2` (left)
- `ArtifactPanelV2` (right, animated slide-in)

Same layout structure as v1 but using v2 components.

```tsx
// ChatPageV2.tsx — home chat v2
'use client';
import { AnimatePresence, motion } from 'framer-motion';
import { useChatStore } from '@/store/chat-store';
import { ArchChatPanelV2 } from './ArchChatPanelV2';
import { ArtifactPanelV2 } from './ArtifactPanelV2';

export function ChatPageV2() {
  const showPanel = useChatStore((s) => s.showArtifactPanel);
  const setShowPanel = useChatStore((s) => s.setShowArtifactPanel);

  return (
    <div className="flex h-full bg-background">
      <div
        className={`flex flex-col transition-all duration-300 ${showPanel ? 'w-1/2' : 'w-full'}`}
      >
        <ArchChatPanelV2 />
      </div>
      <AnimatePresence>
        {showPanel && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: '50%', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="border-l border-border overflow-hidden"
          >
            <ArtifactPanelV2
              onClose={() => setShowPanel(false)}
              onCreateProject={() => {
                window.dispatchEvent(new Event('arch-ai:create-project'));
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

`ProjectArchAIPageV2.tsx` is similar but wraps with project sidebar context.

---

## Task 7: AppShell Flag Switch

**Files:**

- Modify: `apps/studio/src/components/navigation/AppShell.tsx`
- Create: `apps/studio/src/lib/arch-ai/constants.ts` (add flag — or use existing)

**Step 1: Add feature flag**

In `constants.ts` add:

```typescript
export const ARCH_V2_ENABLED = true;
```

**Step 2: Add lazy imports in AppShell**

```typescript
const ChatPageV2 = dynamic(
  () => import('../arch-ai/v2/ChatPageV2').then((m) => ({ default: m.ChatPageV2 })),
  { ssr: false },
);
const ProjectArchAIPageV2 = dynamic(
  () =>
    import('../arch-ai/v2/ProjectArchAIPageV2').then((m) => ({ default: m.ProjectArchAIPageV2 })),
  { ssr: false },
);
```

**Step 3: Switch in render**

```typescript
// Home chat
if (area === 'projects' && page === 'chat') {
  return ARCH_V2_ENABLED ? <ChatPageV2 /> : <ArchHomeChatPage />;
}

// Project arch-ai
case 'arch-ai':
  return ARCH_V2_ENABLED ? <ProjectArchAIPageV2 /> : <ProjectArchAIPage />;
```

---

## Task 8: Topology Name Fix in Generator

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/tools/generate-topology.ts` (response mapping only)

The topology generator returns nodes with IDs like `supervisor_001`. Fix to use the actual agent names.

Check the topology result shape and map `node.id` to `node.name` in the tool result. This ensures the artifact panel displays real names.

**This is the ONLY v1 file we touch**, and it's a data mapping fix, not a behavior change.

---

## Task Summary

| #   | Task                          | Files           | Risk                        |
| --- | ----------------------------- | --------------- | --------------------------- |
| 1   | QACard + ConversationDivider  | 2 new           | None                        |
| 2   | TopologyGraphTab (XyFlow)     | 1 new           | Low — wraps existing canvas |
| 3   | AgentCodeTab (Monaco)         | 1 new           | Low — wraps existing editor |
| 4   | ArtifactPanelV2 (smart tabs)  | 1 new           | None                        |
| 5   | ArchChatPanelV2 (Q&A history) | 1 new           | Medium — message parsing    |
| 6   | Layout wrappers               | 2 new           | None                        |
| 7   | AppShell flag switch          | 1 modify + flag | Trivial                     |
| 8   | Topology name fix             | 1 modify        | Low — data mapping          |

**Total: 8 new files, 2 modified files, 0 v1 breakage risk**
