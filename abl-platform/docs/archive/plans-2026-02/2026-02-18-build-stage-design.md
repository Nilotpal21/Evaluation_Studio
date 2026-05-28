# BUILD Stage: Agent Editor with Visual Designer & Arch Integration

**Date:** 2026-02-18
**Status:** Approved

## Summary

Add a BUILD experience to the agent detail page: a Monaco code editor and visual flow designer (toggled via segmented control), with an integrated Arch AI chat pane for pair-programming. Arch can read, modify, and validate ABL through existing tools — diffs appear inline in the chat with Apply/Reject actions that sync to the editor.

## Context

### What exists

- **Monaco editor** with ABL syntax highlighting, custom theme, live parsing (`ABLEditor.tsx`)
- **Editor store** with dirty tracking, parse/compile errors (`editor-store.ts`)
- **DslEditorTab** with save/versioning in `AgentDetailPage`
- **AgentDetailPage** sets Arch context when viewing an agent
- **All 5 Arch tools** implemented (`arch-tools.ts`): `read_agent_dsl`, `list_project_agents`, `compile_abl`, `query_session_traces`, `modify_agent_abl`
- **Agentic tool-calling loop** in chat API with max 8 iterations
- **ArchDiffView** component with Apply/Reject UI
- **ArchPanel** floating side panel with chat
- **Surgical edit API** route at `/api/projects/[id]/agents/[agentId]/edit`
- **TopologyCanvas** for SVG graph rendering
- **ABL compiler** that produces IR with flow steps, gather fields, tools, constraints

### What's missing (the gap)

1. Editor content is not fed to Arch context — chat doesn't know what user is editing
2. Chat API doesn't extract diffs from tool results into the response payload
3. ArchDiffView exists but is never triggered from chat
4. No visual flow designer for ABL
5. No connection between Apply/Reject on diffs and the editor content
6. Arch chat is only available as a floating panel — not embeddable inline

## Architecture

### Data Flow

```
User edits ABL (code or visual mode)
        ↓
editor-store.dslContent updates
        ↓
useArchEditorBridge syncs currentAbl → arch-store.context
        ↓
User asks Arch a question (or clicks suggestion chip)
        ↓
Chat API receives messages + context.currentAbl + context.agentName
        ↓
Agentic loop calls modify_agent_abl(dryRun=true)
        ↓
Tool returns { diff, modifiedDsl }
        ↓
Chat route extracts diff from tool results → includes in response
        ↓
InlineArchChat renders ArchDiffView inside the message
        ↓
Monaco/Visual shows pending diff decorations
        ↓
User clicks Apply → editorStore.setDslContent(modifiedDsl)
User clicks Reject → clear pendingDiff, no change
```

### Key principle

No new stores. Bridge existing `editor-store` and `arch-store` with a hook. Modify chat route to surface diffs from tool results.

## Layout

### View Modes (segmented control)

| Mode       | Content                                                |
| ---------- | ------------------------------------------------------ |
| **Code**   | Monaco editor (full width)                             |
| **Visual** | Flow graph (full width) + property panel on node click |

Both modes share the same ABL source via `editor-store`. Edits in either mode sync instantly — switch freely.

Arch chat is a collapsible right pane available in both modes:

```
┌────────────────────────────────────────────────────────────────┐
│ [Code] [*Visual]              Save  Compile  [Arch]           │
├──────────────────────────────────────────┬─────────────────────┤
│                                          │                     │
│   Flow graph / Monaco editor             │  Arch Chat          │
│   (full width when chat closed)          │  (collapsible)      │
│                                          │                     │
│                                          │  Diffs appear here  │
│                                          │  with Apply/Reject  │
│                                          │                     │
├──────────────────────────────────────────┴─────────────────────┤
│ 5 steps · 2 gather fields · No issues                         │
└────────────────────────────────────────────────────────────────┘
```

## Components

### New files

| File                                          | Purpose                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/components/build/BuildEditorLayout.tsx`  | Split pane: editor/visual (left) + Arch chat (right, collapsible). Segmented control toggle.         |
| `src/components/build/InlineArchChat.tsx`     | Embeddable Arch chat — reuses `ArchChat` internals, wired to editor context. Not the floating panel. |
| `src/components/build/VisualFlowDesigner.tsx` | ReactFlow-based ABL flow graph. Parses IR → nodes/edges.                                             |
| `src/components/build/FlowNode.tsx`           | Custom ReactFlow node component for flow steps.                                                      |
| `src/components/build/PropertyPanel.tsx`      | Slide-in panel when a node is selected. Editable fields sync back to ABL.                            |
| `src/components/build/GatherPanel.tsx`        | Visual representation of GATHER fields (top section or sidebar).                                     |
| `src/components/build/ConstraintsPanel.tsx`   | Visual constraint badges.                                                                            |
| `src/hooks/useArchEditorBridge.ts`            | Syncs editor-store ↔ arch-store. Debounced currentAbl push, diff application.                        |
| `src/hooks/useMonacoDiffDecorations.ts`       | Monaco deltaDecorations for pending diffs (green/red lines).                                         |
| `src/hooks/useIRToFlowGraph.ts`               | Converts compiled AgentIR → ReactFlow nodes and edges.                                               |
| `src/hooks/useVisualEdits.ts`                 | Property panel edits → spliceSections → ABL update.                                                  |

### Modified files

| File                                        | Change                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/components/agents/AgentDetailPage.tsx` | Replace "DSL Editor" tab with "Build" tab using `BuildEditorLayout`             |
| `src/app/api/arch/chat/route.ts`            | Extract diffs from `modify_agent_abl` tool results, include in response payload |
| `src/store/editor-store.ts`                 | Add `pendingDiff`, `applyPendingDiff()`, `rejectPendingDiff()`                  |
| `src/components/abl/ABLEditor.tsx`          | Accept `pendingDiff` prop, render Monaco decorations via hook                   |

## Visual Designer Detail

### Scripted agents

Flow steps rendered as connected nodes (top-to-bottom dagre layout):

- **Entry node**: Purple accent border, dot indicator
- **RESPOND step**: Default card with text preview
- **CALL step**: Tool icon badge, tool name
- **COLLECT step**: Gather field badges
- **ON_ERROR edge**: Red/dashed line to error handler node
- **THEN edge**: Solid line with arrow

Supplementary panels above the graph:

- **GATHER fields** — chips showing field name, type, required status
- **CONSTRAINTS** — badge list

### Reasoning agents

Goal-centric layout:

- Goal as header card
- Tools as a grid of available tools
- Constraints as guardrail sidebar

### Supervisor agents

Routing tree:

- Supervisor node at top
- Delegate/handoff/escalate edges to child agent nodes
- Routing conditions on edges

### Property Panel

Click any node → right slide-in panel with editable fields:

- **Step name** (text input)
- **Step type** (RESPOND / CALL / COLLECT / etc.)
- **Response text** (textarea, for RESPOND steps)
- **Tool name** (dropdown, for CALL steps)
- **Transition** (THEN → dropdown of other steps)
- **ON_ERROR handler** (optional, link to error step)
- **Delete Step** button

Edits use `spliceSections` from `@agent-platform/project-io` to update the ABL source at the section level. After splice, the ABL is reparsed and both views re-render.

## Chat Route Changes

After the agentic loop completes, scan the conversation for `modify_agent_abl` tool results with `reason: 'dry_run'`. Extract:

```ts
// From the tool result:
{
  applied: false,
  reason: 'dry_run',
  diff: { summary: string },
  modifiedDsl: string
}

// Into the response payload:
{
  message: "Here's the change I'd make...",
  diff: {
    id: crypto.randomUUID(),
    agentName: "...",
    fileName: "agent.abl",
    description: "Added ON_ERROR handler",
    lines: parseDiffSummaryToLines(diff.summary),
    modifiedDsl: modifiedDsl,
    status: 'pending'
  }
}
```

## Editor Store Additions

```ts
interface PendingDiff {
  id: string;
  modifiedDsl: string;
  lines: ArchDiffLine[];
  description: string;
}

// New fields:
pendingDiff: PendingDiff | null;

// New actions:
setPendingDiff: (diff: PendingDiff | null) => void;
applyPendingDiff: () => void;   // dslContent = pendingDiff.modifiedDsl, clear diff
rejectPendingDiff: () => void;  // clear diff, keep current content
```

## Dependencies

- `reactflow` — graph rendering, dagre layout, pan/zoom, node selection
- `@dagrejs/dagre` — automatic graph layout (used by ReactFlow)
- No other new dependencies. Monaco already bundled.

## Error Handling

- If ABL fails to parse → visual mode shows error state with "Switch to Code to fix" prompt
- If property panel edit produces invalid ABL → show inline error, don't apply, keep previous content
- If Arch chat fails → existing error handling in ArchPanel (error message bubble)
- If diff apply conflicts with user edits made after the diff was generated → warn "Code has changed since this diff was generated"

## Testing

- `useIRToFlowGraph` — pure function, unit test IR → nodes/edges mapping
- `useVisualEdits` — unit test property edits → ABL splice output
- `useArchEditorBridge` — test context sync and diff application
- `BuildEditorLayout` — component test for mode toggle, chat pane toggle
- Chat route diff extraction — test agentic loop responses include diffs

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a BUILD experience to the agent detail page with a Code/Visual toggle, integrated Arch AI chat pane, and diff-based pair-programming workflow.

**Architecture:** The existing Monaco editor (`ABLEditor`), editor store, Arch tools, and chat API form the foundation. We bridge them with hooks (`useArchEditorBridge`, `useMonacoDiffDecorations`, `useIRToFlowGraph`), add a split-pane layout (`BuildEditorLayout`), and a ReactFlow-based visual designer. The chat route is modified to extract diffs from tool results.

**Tech Stack:** React 18, Zustand, @xyflow/react (ReactFlow v12), dagre (already installed), Monaco (@monaco-editor/react, already installed), Framer Motion, Tailwind, Vitest.

---

## Task 1: Install @xyflow/react

**Files:**

- Modify: `apps/studio/package.json`

**Step 1: Install the dependency**

Run:

```bash
cd apps/studio && pnpm add @xyflow/react
```

**Step 2: Verify it installed**

Run:

```bash
pnpm ls @xyflow/react --depth=0
```

Expected: Shows `@xyflow/react` version.

**Step 3: Commit**

```bash
git add apps/studio/package.json pnpm-lock.yaml
git commit -m "chore(studio): add @xyflow/react for visual flow designer"
```

---

## Task 2: Add pendingDiff state to editor-store

**Files:**

- Modify: `apps/studio/src/store/editor-store.ts` (lines 9-119)
- Test: `apps/studio/src/__tests__/editor-store-diff.test.ts`

**Step 1: Write the failing test**

Create `apps/studio/src/__tests__/editor-store-diff.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../store/editor-store';

describe('editor-store pendingDiff', () => {
  beforeEach(() => {
    // Reset store between tests
    useEditorStore.setState({
      dslContent: 'AGENT: test\nGOAL: "hello"',
      originalContent: 'AGENT: test\nGOAL: "hello"',
      isDirty: false,
      pendingDiff: null,
    });
  });

  it('starts with null pendingDiff', () => {
    expect(useEditorStore.getState().pendingDiff).toBeNull();
  });

  it('setPendingDiff stores the diff', () => {
    const diff = {
      id: 'diff-1',
      modifiedDsl: 'AGENT: test\nGOAL: "updated"',
      lines: [
        { type: 'removed' as const, content: 'GOAL: "hello"' },
        { type: 'added' as const, content: 'GOAL: "updated"' },
      ],
      description: 'Updated goal',
    };
    useEditorStore.getState().setPendingDiff(diff);
    expect(useEditorStore.getState().pendingDiff).toEqual(diff);
  });

  it('applyPendingDiff updates dslContent and clears diff', () => {
    const diff = {
      id: 'diff-1',
      modifiedDsl: 'AGENT: test\nGOAL: "applied"',
      lines: [],
      description: 'Applied change',
    };
    useEditorStore.getState().setPendingDiff(diff);
    useEditorStore.getState().applyPendingDiff();

    const state = useEditorStore.getState();
    expect(state.dslContent).toBe('AGENT: test\nGOAL: "applied"');
    expect(state.isDirty).toBe(true);
    expect(state.pendingDiff).toBeNull();
  });

  it('rejectPendingDiff clears diff without changing content', () => {
    const original = useEditorStore.getState().dslContent;
    useEditorStore.getState().setPendingDiff({
      id: 'diff-1',
      modifiedDsl: 'AGENT: test\nGOAL: "rejected"',
      lines: [],
      description: 'Rejected change',
    });
    useEditorStore.getState().rejectPendingDiff();

    const state = useEditorStore.getState();
    expect(state.dslContent).toBe(original);
    expect(state.pendingDiff).toBeNull();
  });

  it('applyPendingDiff is a no-op when no diff pending', () => {
    const original = useEditorStore.getState().dslContent;
    useEditorStore.getState().applyPendingDiff();
    expect(useEditorStore.getState().dslContent).toBe(original);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/editor-store-diff.test.ts`
Expected: FAIL — `setPendingDiff` / `applyPendingDiff` / `rejectPendingDiff` not found.

**Step 3: Implement pendingDiff in editor-store**

In `apps/studio/src/store/editor-store.ts`:

Add to `EditorState` interface (after line 36 `saveError`):

```ts
  // Pending diff from Arch
  pendingDiff: {
    id: string;
    modifiedDsl: string;
    lines: { type: 'added' | 'removed' | 'unchanged'; content: string }[];
    description: string;
  } | null;
```

Add to actions (after line 53 `markSaved`):

```ts
  setPendingDiff: (diff: EditorState['pendingDiff']) => void;
  applyPendingDiff: () => void;
  rejectPendingDiff: () => void;
```

Add to initial state (after line 73 `viewMode: 'view'`):

```ts
  pendingDiff: null,
```

Add implementations (after the `markSaved` implementation):

```ts
  setPendingDiff: (diff) => set({ pendingDiff: diff }),

  applyPendingDiff: () =>
    set((state) => {
      if (!state.pendingDiff) return state;
      return {
        dslContent: state.pendingDiff.modifiedDsl,
        isDirty: state.pendingDiff.modifiedDsl !== state.originalContent,
        pendingDiff: null,
      };
    }),

  rejectPendingDiff: () => set({ pendingDiff: null }),
```

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/editor-store-diff.test.ts`
Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
git add apps/studio/src/store/editor-store.ts apps/studio/src/__tests__/editor-store-diff.test.ts
git commit -m "feat(studio): add pendingDiff state to editor store for Arch integration"
```

---

## Task 3: Extract diffs from chat API tool results

**Files:**

- Modify: `apps/studio/src/app/api/arch/chat/route.ts` (lines 168-269 `agenticLoop`, lines 416-425 `generateStubResponse`)
- Test: `apps/studio/src/__tests__/arch-chat-diff-extraction.test.ts`

**Step 1: Write the failing test**

Create `apps/studio/src/__tests__/arch-chat-diff-extraction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

// We test the extraction helper directly since testing the full route requires HTTP setup
// Import will be available after Step 3
import { extractDiffFromToolResults } from '../lib/arch-diff-extractor';

describe('extractDiffFromToolResults', () => {
  it('returns null when no modify_agent_abl results', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ];
    expect(extractDiffFromToolResults(messages)).toBeNull();
  });

  it('extracts diff from dry-run modify_agent_abl result', () => {
    const toolResultContent = JSON.stringify({
      success: true,
      data: {
        applied: false,
        reason: 'dry_run',
        diff: {
          summary: {
            added: ['ON_ERROR'],
            removed: [],
            modified: [],
            unchanged: ['AGENT', 'GOAL', 'FLOW'],
          },
        },
        modifiedDsl: 'AGENT: test\nGOAL: "hi"\nON_ERROR:\n  RESPOND "Sorry"',
      },
    });

    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use' as const, id: 'tool-1', name: 'modify_agent_abl', input: {} }],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'tool-1', content: toolResultContent },
        ],
      },
    ];

    const diff = extractDiffFromToolResults(messages);
    expect(diff).not.toBeNull();
    expect(diff!.modifiedDsl).toBe('AGENT: test\nGOAL: "hi"\nON_ERROR:\n  RESPOND "Sorry"');
    expect(diff!.description).toContain('ON_ERROR');
  });

  it('returns null for applied (non-dry-run) results', () => {
    const toolResultContent = JSON.stringify({
      success: true,
      data: { applied: true, diff: { summary: {} } },
    });

    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use' as const, id: 'tool-1', name: 'modify_agent_abl', input: {} }],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'tool-1', content: toolResultContent },
        ],
      },
    ];

    expect(extractDiffFromToolResults(messages)).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/arch-chat-diff-extraction.test.ts`
Expected: FAIL — module not found.

**Step 3: Create the diff extractor utility**

Create `apps/studio/src/lib/arch-diff-extractor.ts`:

```ts
/**
 * Arch Diff Extractor
 *
 * Scans agentic loop message history for modify_agent_abl dry-run results
 * and extracts structured diff data for the client.
 */

import type { ArchDiffLine } from '../types/arch';

interface ExtractedDiff {
  modifiedDsl: string;
  description: string;
  lines: ArchDiffLine[];
}

interface DiffSummary {
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: string[];
}

/**
 * Scan LLM conversation messages for the last modify_agent_abl dry-run result.
 * Returns extracted diff data or null if none found.
 */
export function extractDiffFromToolResults(
  messages: Array<{ role: string; content: unknown }>,
): ExtractedDiff | null {
  // Walk messages in reverse to find the most recent dry-run result
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;

    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_result' &&
        'content' in block &&
        typeof block.content === 'string'
      ) {
        const parsed = safeJsonParse(block.content);
        if (!parsed?.success || !parsed.data) continue;

        const { data } = parsed;
        if (data.reason !== 'dry_run' || !data.modifiedDsl) continue;

        const summary: DiffSummary = data.diff?.summary ?? {
          added: [],
          removed: [],
          modified: [],
          unchanged: [],
        };
        const description = buildDescription(summary);
        const lines = buildDiffLines(summary);

        return {
          modifiedDsl: data.modifiedDsl,
          description,
          lines,
        };
      }
    }
  }

  return null;
}

function buildDescription(summary: DiffSummary): string {
  const parts: string[] = [];
  if (summary.added.length > 0) parts.push(`Added: ${summary.added.join(', ')}`);
  if (summary.modified.length > 0) parts.push(`Modified: ${summary.modified.join(', ')}`);
  if (summary.removed.length > 0) parts.push(`Removed: ${summary.removed.join(', ')}`);
  return parts.join(' | ') || 'Code change';
}

function buildDiffLines(summary: DiffSummary): ArchDiffLine[] {
  const lines: ArchDiffLine[] = [];
  for (const section of summary.removed) {
    lines.push({ type: 'removed', content: `${section}: (removed)` });
  }
  for (const section of summary.added) {
    lines.push({ type: 'added', content: `${section}: (added)` });
  }
  for (const section of summary.modified) {
    lines.push({ type: 'removed', content: `${section}: (before)` });
    lines.push({ type: 'added', content: `${section}: (after)` });
  }
  for (const section of summary.unchanged) {
    lines.push({ type: 'unchanged', content: `${section}: (unchanged)` });
  }
  return lines;
}

function safeJsonParse(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/arch-chat-diff-extraction.test.ts`
Expected: All 3 tests PASS.

**Step 5: Wire the extractor into the chat route**

In `apps/studio/src/app/api/arch/chat/route.ts`:

Add import at top (after line 29):

```ts
import { extractDiffFromToolResults } from '@/lib/arch-diff-extractor';
```

In the agentic loop success response (around line 108-115), replace:

```ts
return NextResponse.json({
  success: true,
  data: {
    message: result.text,
    suggestions: [],
    toolsUsed: result.toolsUsed.length > 0 ? result.toolsUsed : undefined,
  },
});
```

With:

```ts
const extractedDiff = extractDiffFromToolResults(llmMessages);
return NextResponse.json({
  success: true,
  data: {
    message: result.text,
    suggestions: [],
    toolsUsed: result.toolsUsed.length > 0 ? result.toolsUsed : undefined,
    diff: extractedDiff
      ? {
          id: `diff-${Date.now()}`,
          agentId: context?.agentId ?? '',
          agentName: context?.agentName ?? 'agent',
          fileName: `${context?.agentName ?? 'agent'}.abl`,
          description: extractedDiff.description,
          lines: extractedDiff.lines,
          modifiedDsl: extractedDiff.modifiedDsl,
          status: 'pending' as const,
        }
      : undefined,
  },
});
```

Also update the `agenticLoop` return type to include the messages (so we can extract diffs). Change the function signature (line 168-174) to also return `messages`:

```ts
async function agenticLoop(
  llm: LLMClient,
  systemPrompt: string,
  messages: Message[],
  tools: ToolDefinition[],
  projectId: string,
): Promise<{ text: string; toolsUsed: string[]; messages: Message[] }> {
```

And update all return statements in `agenticLoop` to include `messages`:

- Line 194: `return { text: result.text ?? '', toolsUsed, messages };`
- Line 259: `return { text: result.text ?? '', toolsUsed, messages };`
- Line 268: `return { text: '...', toolsUsed, messages };`

Then at the call site (line 106), destructure `messages` as `llmMessages`:

```ts
const result = await agenticLoop(llm, systemPrompt, llmMessages, tools, projectId);
const extractedDiff = extractDiffFromToolResults(result.messages);
```

**Step 6: Commit**

```bash
git add apps/studio/src/lib/arch-diff-extractor.ts apps/studio/src/__tests__/arch-chat-diff-extraction.test.ts apps/studio/src/app/api/arch/chat/route.ts
git commit -m "feat(studio): extract diffs from Arch tool results in chat API"
```

---

## Task 4: Add modifiedDsl to ArchDiff type and ArchChatResponse

**Files:**

- Modify: `apps/studio/src/types/arch.ts` (lines 70-78)

**Step 1: Update the ArchDiff interface**

In `apps/studio/src/types/arch.ts`, add `modifiedDsl` to `ArchDiff` (after line 77 `status`):

```ts
  /** Full modified DSL content — used by editor to apply the diff */
  modifiedDsl?: string;
```

**Step 2: Commit**

```bash
git add apps/studio/src/types/arch.ts
git commit -m "feat(studio): add modifiedDsl to ArchDiff type"
```

---

## Task 5: Create useArchEditorBridge hook

**Files:**

- Create: `apps/studio/src/hooks/useArchEditorBridge.ts`
- Test: `apps/studio/src/__tests__/arch-editor-bridge.test.ts`

**Step 1: Write the failing test**

Create `apps/studio/src/__tests__/arch-editor-bridge.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEditorStore } from '../store/editor-store';
import { useArchStore } from '../store/arch-store';

// We test the sync logic directly rather than rendering a hook
describe('arch-editor bridge sync logic', () => {
  beforeEach(() => {
    useEditorStore.setState({
      dslContent: 'AGENT: test_agent\nGOAL: "test"',
      originalContent: 'AGENT: test_agent\nGOAL: "test"',
      isDirty: false,
      pendingDiff: null,
    });
    useArchStore.setState({
      context: { page: 'agents' },
    });
  });

  it('syncs editor content to arch context', () => {
    // Simulate what the bridge hook does
    const dsl = useEditorStore.getState().dslContent;
    useArchStore.getState().setContext({
      page: 'agents',
      agentName: 'test_agent',
      currentAbl: dsl,
    });

    const ctx = useArchStore.getState().context;
    expect(ctx.currentAbl).toBe('AGENT: test_agent\nGOAL: "test"');
    expect(ctx.agentName).toBe('test_agent');
  });

  it('applies diff from arch message to editor store', () => {
    const diff = {
      id: 'diff-1',
      modifiedDsl: 'AGENT: test_agent\nGOAL: "updated"',
      lines: [
        { type: 'removed' as const, content: 'GOAL: "test"' },
        { type: 'added' as const, content: 'GOAL: "updated"' },
      ],
      description: 'Updated goal',
    };

    useEditorStore.getState().setPendingDiff(diff);
    useEditorStore.getState().applyPendingDiff();

    expect(useEditorStore.getState().dslContent).toBe('AGENT: test_agent\nGOAL: "updated"');
    expect(useEditorStore.getState().pendingDiff).toBeNull();
  });
});
```

**Step 2: Run test to verify it passes** (these test store logic directly)

Run: `cd apps/studio && pnpm vitest run src/__tests__/arch-editor-bridge.test.ts`
Expected: PASS (since we test store operations, which already exist from Task 2).

**Step 3: Create the hook**

Create `apps/studio/src/hooks/useArchEditorBridge.ts`:

```ts
/**
 * useArchEditorBridge
 *
 * Syncs editor-store ↔ arch-store bidirectionally:
 * 1. Pushes editor content → arch context.currentAbl (debounced)
 * 2. When arch returns a diff → sets editor-store.pendingDiff
 * 3. Provides applyDiff / rejectDiff that update editor content
 */

import { useEffect, useRef, useCallback } from 'react';
import { useEditorStore } from '../store/editor-store';
import { useArchStore } from '../store/arch-store';
import type { ArchDiff } from '../types/arch';

/** Debounce delay for pushing editor content to arch context (ms) */
const CONTEXT_SYNC_DEBOUNCE_MS = 500;

export function useArchEditorBridge(agentName: string) {
  const dslContent = useEditorStore((s) => s.dslContent);
  const setPendingDiff = useEditorStore((s) => s.setPendingDiff);
  const applyPendingDiff = useEditorStore((s) => s.applyPendingDiff);
  const rejectPendingDiff = useEditorStore((s) => s.rejectPendingDiff);
  const setContext = useArchStore((s) => s.setContext);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync editor content → arch context (debounced)
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      setContext({
        page: 'agents',
        agentName,
        currentAbl: dslContent,
      });
    }, CONTEXT_SYNC_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [dslContent, agentName, setContext]);

  // Handle incoming diff from Arch chat response
  const handleArchDiff = useCallback(
    (diff: ArchDiff & { modifiedDsl?: string }) => {
      if (!diff.modifiedDsl) return;

      setPendingDiff({
        id: diff.id,
        modifiedDsl: diff.modifiedDsl,
        lines: diff.lines,
        description: diff.description,
      });
    },
    [setPendingDiff],
  );

  return {
    handleArchDiff,
    applyDiff: applyPendingDiff,
    rejectDiff: rejectPendingDiff,
  };
}
```

**Step 4: Commit**

```bash
git add apps/studio/src/hooks/useArchEditorBridge.ts apps/studio/src/__tests__/arch-editor-bridge.test.ts
git commit -m "feat(studio): add useArchEditorBridge hook for editor ↔ arch sync"
```

---

## Task 6: Create useIRToFlowGraph hook

**Files:**

- Create: `apps/studio/src/hooks/useIRToFlowGraph.ts`
- Test: `apps/studio/src/__tests__/ir-to-flow-graph.test.ts`

**Step 1: Write the failing test**

Create `apps/studio/src/__tests__/ir-to-flow-graph.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { irToFlowGraph } from '../hooks/useIRToFlowGraph';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';

// Minimal scripted agent IR for testing
const SCRIPTED_IR: Partial<AgentIR> = {
  metadata: { name: 'test_agent', version: '1.0', type: 'agent', compiled_at: '', source_hash: '' },
  execution: { mode: 'scripted' },
  flow: {
    steps: ['greeting', 'collect_info', 'confirm'],
    definitions: {
      greeting: {
        name: 'greeting',
        respond: 'Hello! How can I help?',
        then: 'collect_info',
      },
      collect_info: {
        name: 'collect_info',
        collect: ['name', 'email'],
        prompt: 'Please provide your details',
        then: 'confirm',
        on_fail: 'greeting',
      },
      confirm: {
        name: 'confirm',
        respond: 'All set, {{name}}!',
      },
    },
    entry_point: 'greeting',
  },
  gather: { fields: [], strategy: 'hybrid' },
  constraints: { rules: [] },
  tools: [],
};

describe('irToFlowGraph', () => {
  it('converts scripted IR to nodes and edges', () => {
    const { nodes, edges } = irToFlowGraph(SCRIPTED_IR as AgentIR);

    expect(nodes).toHaveLength(3);
    expect(nodes[0].id).toBe('greeting');
    expect(nodes[0].data.isEntry).toBe(true);
    expect(nodes[0].data.stepType).toBe('respond');

    expect(nodes[1].id).toBe('collect_info');
    expect(nodes[1].data.stepType).toBe('collect');

    expect(nodes[2].id).toBe('confirm');
  });

  it('creates edges for then transitions', () => {
    const { edges } = irToFlowGraph(SCRIPTED_IR as AgentIR);

    const thenEdges = edges.filter((e) => e.data?.type === 'then');
    expect(thenEdges).toHaveLength(2);
    expect(thenEdges[0]).toMatchObject({ source: 'greeting', target: 'collect_info' });
    expect(thenEdges[1]).toMatchObject({ source: 'collect_info', target: 'confirm' });
  });

  it('creates edges for on_fail transitions', () => {
    const { edges } = irToFlowGraph(SCRIPTED_IR as AgentIR);

    const failEdges = edges.filter((e) => e.data?.type === 'on_error');
    expect(failEdges).toHaveLength(1);
    expect(failEdges[0]).toMatchObject({ source: 'collect_info', target: 'greeting' });
  });

  it('returns empty graph for reasoning mode', () => {
    const reasoningIR: Partial<AgentIR> = {
      ...SCRIPTED_IR,
      execution: { mode: 'reasoning' },
      flow: undefined,
    };
    const { nodes, edges } = irToFlowGraph(reasoningIR as AgentIR);
    // Reasoning agents get a single goal node
    expect(nodes).toHaveLength(1);
    expect(nodes[0].data.stepType).toBe('goal');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/ir-to-flow-graph.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement irToFlowGraph**

Create `apps/studio/src/hooks/useIRToFlowGraph.ts`:

```ts
/**
 * useIRToFlowGraph
 *
 * Converts compiled AgentIR → ReactFlow nodes and edges.
 * Exported as both a hook (for React) and a pure function (for testing).
 */

import { useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import dagre from 'dagre';
import type { AgentIR, FlowStep } from '@abl/compiler/platform/ir/schema.js';

// =============================================================================
// TYPES
// =============================================================================

export interface FlowNodeData {
  label: string;
  stepType: 'respond' | 'call' | 'collect' | 'check' | 'goal' | 'entry' | 'generic';
  isEntry: boolean;
  respond?: string;
  call?: string;
  collect?: string[];
  then?: string;
  onFail?: string;
  [key: string]: unknown;
}

export type FlowEdgeData = {
  type: 'then' | 'on_error' | 'on_input';
  label?: string;
};

// =============================================================================
// LAYOUT CONSTANTS
// =============================================================================

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;
const RANK_SEP = 60;
const NODE_SEP = 40;

// =============================================================================
// PURE CONVERSION FUNCTION
// =============================================================================

export function irToFlowGraph(ir: AgentIR): {
  nodes: Node<FlowNodeData>[];
  edges: Edge<FlowEdgeData>[];
} {
  if (!ir.flow || ir.execution.mode !== 'scripted') {
    return buildReasoningGraph(ir);
  }

  return buildScriptedGraph(ir);
}

function buildScriptedGraph(ir: AgentIR): {
  nodes: Node<FlowNodeData>[];
  edges: Edge<FlowEdgeData>[];
} {
  const flow = ir.flow!;
  const entryPoint = flow.entry_point ?? flow.steps[0];

  const nodes: Node<FlowNodeData>[] = [];
  const edges: Edge<FlowEdgeData>[] = [];

  for (const stepName of flow.steps) {
    const step = flow.definitions[stepName];
    if (!step) continue;

    const stepType = inferStepType(step);

    nodes.push({
      id: stepName,
      type: 'flowNode',
      position: { x: 0, y: 0 }, // Will be set by dagre
      data: {
        label: stepName,
        stepType,
        isEntry: stepName === entryPoint,
        respond: step.respond,
        call: step.call,
        collect: step.collect,
        then: step.then,
        onFail: step.on_fail,
      },
    });

    // THEN edges
    if (step.then) {
      edges.push({
        id: `${stepName}-then-${step.then}`,
        source: stepName,
        target: step.then,
        type: 'smoothstep',
        animated: false,
        data: { type: 'then' },
      });
    }

    // ON_FAIL / ON_ERROR edges
    if (step.on_fail) {
      edges.push({
        id: `${stepName}-error-${step.on_fail}`,
        source: stepName,
        target: step.on_fail,
        type: 'smoothstep',
        animated: false,
        style: { strokeDasharray: '5 5' },
        data: { type: 'on_error' },
      });
    }

    // ON_INPUT branch edges
    if (step.on_input) {
      for (const branch of step.on_input) {
        if (branch.then) {
          edges.push({
            id: `${stepName}-input-${branch.then}`,
            source: stepName,
            target: branch.then,
            type: 'smoothstep',
            animated: false,
            label: branch.when ?? undefined,
            data: { type: 'on_input', label: branch.when },
          });
        }
      }
    }
  }

  // Apply dagre layout
  return applyDagreLayout(nodes, edges);
}

function buildReasoningGraph(ir: AgentIR): {
  nodes: Node<FlowNodeData>[];
  edges: Edge<FlowEdgeData>[];
} {
  const nodes: Node<FlowNodeData>[] = [
    {
      id: 'goal',
      type: 'flowNode',
      position: { x: 0, y: 0 },
      data: {
        label: ir.identity?.goal ?? 'Agent Goal',
        stepType: 'goal',
        isEntry: true,
      },
    },
  ];

  return { nodes, edges: [] };
}

function inferStepType(step: FlowStep): FlowNodeData['stepType'] {
  if (step.call) return 'call';
  if (step.collect && step.collect.length > 0) return 'collect';
  if (step.gather) return 'collect';
  if (step.check) return 'check';
  if (step.respond) return 'respond';
  return 'generic';
}

function applyDagreLayout(
  nodes: Node<FlowNodeData>[],
  edges: Edge<FlowEdgeData>[],
): { nodes: Node<FlowNodeData>[]; edges: Edge<FlowEdgeData>[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: RANK_SEP, nodesep: NODE_SEP });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const layoutNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });

  return { nodes: layoutNodes, edges };
}

// =============================================================================
// REACT HOOK
// =============================================================================

export function useIRToFlowGraph(ir: AgentIR | null) {
  return useMemo(() => {
    if (!ir) return { nodes: [], edges: [] };
    return irToFlowGraph(ir);
  }, [ir]);
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/ir-to-flow-graph.test.ts`
Expected: All 4 tests PASS.

**Step 5: Commit**

```bash
git add apps/studio/src/hooks/useIRToFlowGraph.ts apps/studio/src/__tests__/ir-to-flow-graph.test.ts
git commit -m "feat(studio): add useIRToFlowGraph hook for visual flow designer"
```

---

## Task 7: Create FlowNode component

**Files:**

- Create: `apps/studio/src/components/build/FlowNode.tsx`

**Step 1: Create the custom ReactFlow node**

Create `apps/studio/src/components/build/FlowNode.tsx`:

```tsx
/**
 * FlowNode — custom ReactFlow node for ABL flow steps.
 *
 * Renders a card with step type icon, name, and brief description.
 * Entry nodes have a purple accent border. Error nodes have red.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MessageSquare, Wrench, ClipboardList, Shield, Target, Circle } from 'lucide-react';
import clsx from 'clsx';
import type { FlowNodeData } from '../../hooks/useIRToFlowGraph';

const STEP_TYPE_CONFIG: Record<
  FlowNodeData['stepType'],
  {
    icon: typeof MessageSquare;
    color: string;
    bg: string;
    label: string;
  }
> = {
  respond: { icon: MessageSquare, color: 'text-accent', bg: 'bg-accent-subtle', label: 'Respond' },
  call: { icon: Wrench, color: 'text-success', bg: 'bg-success-subtle', label: 'Call' },
  collect: {
    icon: ClipboardList,
    color: 'text-warning',
    bg: 'bg-warning-subtle',
    label: 'Collect',
  },
  check: { icon: Shield, color: 'text-info', bg: 'bg-info-subtle', label: 'Check' },
  goal: { icon: Target, color: 'text-purple', bg: 'bg-purple-subtle', label: 'Goal' },
  entry: { icon: Circle, color: 'text-accent', bg: 'bg-accent-subtle', label: 'Entry' },
  generic: { icon: Circle, color: 'text-muted', bg: 'bg-background-muted', label: 'Step' },
};

function FlowNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as FlowNodeData;
  const config = STEP_TYPE_CONFIG[nodeData.stepType] ?? STEP_TYPE_CONFIG.generic;
  const Icon = config.icon;

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2 !h-2 !bg-border !border-background"
      />
      <div
        className={clsx(
          'px-4 py-3 rounded-xl border bg-background-elevated shadow-sm min-w-[200px] max-w-[260px]',
          'transition-default cursor-pointer',
          nodeData.isEntry && 'border-accent/50 ring-1 ring-accent/20',
          !nodeData.isEntry && 'border-default',
          selected && 'border-accent ring-2 ring-accent/30 shadow-md',
        )}
      >
        {/* Header row */}
        <div className="flex items-center gap-2 mb-1">
          <div className={clsx('w-5 h-5 rounded-md flex items-center justify-center', config.bg)}>
            <Icon className={clsx('w-3 h-3', config.color)} />
          </div>
          <span className="text-xs font-medium text-foreground truncate">{nodeData.label}</span>
          {nodeData.isEntry && (
            <span className="ml-auto text-[10px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded-full">
              entry
            </span>
          )}
        </div>

        {/* Description preview */}
        {nodeData.respond && (
          <p className="text-[11px] text-muted leading-tight line-clamp-2 mt-1">
            {nodeData.respond.slice(0, 80)}
            {nodeData.respond.length > 80 ? '...' : ''}
          </p>
        )}
        {nodeData.call && (
          <p className="text-[11px] font-mono text-success mt-1">{nodeData.call}</p>
        )}
        {nodeData.collect && nodeData.collect.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {nodeData.collect.map((field) => (
              <span
                key={field}
                className="text-[10px] px-1.5 py-0.5 rounded-md bg-warning/10 text-warning font-medium"
              >
                {field}
              </span>
            ))}
          </div>
        )}

        {/* Step type badge */}
        <div className="mt-2 flex items-center gap-1.5">
          <span className={clsx('text-[10px] font-medium uppercase tracking-wider', config.color)}>
            {config.label}
          </span>
          {nodeData.then && <span className="text-[10px] text-subtle">→ {nodeData.then}</span>}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2 !h-2 !bg-border !border-background"
      />
    </>
  );
}

export const FlowNode = memo(FlowNodeComponent);
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/build/FlowNode.tsx
git commit -m "feat(studio): add FlowNode component for visual flow designer"
```

---

## Task 8: Create VisualFlowDesigner component

**Files:**

- Create: `apps/studio/src/components/build/VisualFlowDesigner.tsx`

**Step 1: Create the visual designer**

Create `apps/studio/src/components/build/VisualFlowDesigner.tsx`:

```tsx
/**
 * VisualFlowDesigner
 *
 * ReactFlow-based visual representation of an ABL agent's flow.
 * Parses the editor's DSL content → IR → ReactFlow nodes/edges.
 * Click a node to open the PropertyPanel.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type OnSelectionChangeParams,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { useEditorStore } from '../../store/editor-store';
import { useABLParsing } from '../../hooks/useABLParsing';
import { useIRToFlowGraph, type FlowNodeData } from '../../hooks/useIRToFlowGraph';
import { FlowNode } from './FlowNode';
import { PropertyPanel } from './PropertyPanel';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';

const nodeTypes = { flowNode: FlowNode };

interface VisualFlowDesignerProps {
  className?: string;
  projectId: string;
  agentName: string;
}

export function VisualFlowDesigner({ className, projectId, agentName }: VisualFlowDesignerProps) {
  const { dslContent, compiledIR, parseErrors, compileErrors } = useEditorStore();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const ir = compiledIR as AgentIR | null;
  const { nodes, edges } = useIRToFlowGraph(ir);

  const selectedNodeData = useMemo(() => {
    if (!selectedNodeId) return null;
    const node = nodes.find((n) => n.id === selectedNodeId);
    return (node?.data as FlowNodeData | null) ?? null;
  }, [selectedNodeId, nodes]);

  const handleSelectionChange = useCallback(({ nodes: selectedNodes }: OnSelectionChangeParams) => {
    if (selectedNodes.length === 1) {
      setSelectedNodeId(selectedNodes[0].id);
    } else {
      setSelectedNodeId(null);
    }
  }, []);

  const hasErrors = parseErrors.length > 0 || compileErrors.length > 0;

  // Error state — can't visualize unparseable ABL
  if (hasErrors || !ir) {
    return (
      <div className={clsx('flex items-center justify-center h-full', className)}>
        <div className="text-center max-w-sm">
          <AlertCircle className="w-8 h-8 text-error mx-auto mb-3" />
          <h3 className="text-sm font-semibold text-foreground mb-1">Cannot render visual view</h3>
          <p className="text-xs text-muted">
            {parseErrors.length > 0
              ? `${parseErrors.length} parse error${parseErrors.length !== 1 ? 's' : ''} — switch to Code view to fix.`
              : compileErrors.length > 0
                ? `${compileErrors.length} compile error${compileErrors.length !== 1 ? 's' : ''} — switch to Code view to fix.`
                : 'Compile the ABL first using the Compile button.'}
          </p>
        </div>
      </div>
    );
  }

  // Empty flow
  if (nodes.length === 0) {
    return (
      <div className={clsx('flex items-center justify-center h-full', className)}>
        <div className="text-center max-w-sm">
          <p className="text-sm text-muted">No flow steps to visualize.</p>
          <p className="text-xs text-subtle mt-1">Add a FLOW section in Code view.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={clsx('h-full flex', className)}>
      <div className="flex-1 min-w-0">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onSelectionChange={handleSelectionChange}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.3}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="hsl(var(--border-muted))" gap={20} size={1} />
            <Controls
              showInteractive={false}
              className="!bg-background-elevated !border-default !shadow-sm !rounded-lg"
            />
            <MiniMap
              nodeColor={() => 'hsl(var(--accent))'}
              maskColor="hsl(var(--background) / 0.8)"
              className="!bg-background-elevated !border-default !rounded-lg"
            />
          </ReactFlow>
        </ReactFlowProvider>
      </div>

      {/* Property panel */}
      {selectedNodeId && selectedNodeData && (
        <PropertyPanel
          stepName={selectedNodeId}
          data={selectedNodeData}
          projectId={projectId}
          agentName={agentName}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/build/VisualFlowDesigner.tsx
git commit -m "feat(studio): add VisualFlowDesigner component with ReactFlow"
```

---

## Task 9: Create PropertyPanel component

**Files:**

- Create: `apps/studio/src/components/build/PropertyPanel.tsx`

**Step 1: Create the property panel**

Create `apps/studio/src/components/build/PropertyPanel.tsx`:

```tsx
/**
 * PropertyPanel
 *
 * Slide-in panel showing editable properties for a selected flow step node.
 * Edits are written back to the ABL source via section splicing.
 */

import { useState, useCallback } from 'react';
import { X, MessageSquare, Wrench, ClipboardList, Shield } from 'lucide-react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { springs } from '../../lib/animation';
import type { FlowNodeData } from '../../hooks/useIRToFlowGraph';

interface PropertyPanelProps {
  stepName: string;
  data: FlowNodeData;
  projectId: string;
  agentName: string;
  onClose: () => void;
}

const PANEL_WIDTH = 300;

const STEP_TYPE_ICONS: Record<string, typeof MessageSquare> = {
  respond: MessageSquare,
  call: Wrench,
  collect: ClipboardList,
  check: Shield,
};

export function PropertyPanel({
  stepName,
  data,
  projectId,
  agentName,
  onClose,
}: PropertyPanelProps) {
  const Icon = STEP_TYPE_ICONS[data.stepType] ?? MessageSquare;

  return (
    <motion.div
      initial={{ x: PANEL_WIDTH, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: PANEL_WIDTH, opacity: 0 }}
      transition={springs.gentle}
      className="h-full border-l border-default bg-background-elevated overflow-y-auto shrink-0"
      style={{ width: PANEL_WIDTH }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-default sticky top-0 bg-background-elevated z-10">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-4 h-4 text-accent shrink-0" />
          <span className="text-sm font-semibold text-foreground truncate">{stepName}</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-muted hover:text-foreground rounded-lg hover:bg-background-muted transition-default"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Properties */}
      <div className="p-4 space-y-4">
        {/* Step type */}
        <PropertyField label="Type">
          <span className="text-sm text-foreground font-mono capitalize">{data.stepType}</span>
        </PropertyField>

        {/* Entry badge */}
        {data.isEntry && (
          <div className="text-xs font-medium text-accent bg-accent/10 px-2 py-1 rounded-md inline-block">
            Entry Point
          </div>
        )}

        {/* Response text (RESPOND steps) */}
        {data.respond && (
          <PropertyField label="Response">
            <div className="text-xs text-foreground bg-background-muted rounded-lg p-3 font-mono leading-relaxed whitespace-pre-wrap border border-default">
              {data.respond}
            </div>
          </PropertyField>
        )}

        {/* Tool call (CALL steps) */}
        {data.call && (
          <PropertyField label="Tool">
            <span className="text-sm font-mono text-success">{data.call}</span>
          </PropertyField>
        )}

        {/* Collect fields */}
        {data.collect && data.collect.length > 0 && (
          <PropertyField label="Fields">
            <div className="flex flex-wrap gap-1.5">
              {data.collect.map((field) => (
                <span
                  key={field}
                  className="text-xs px-2 py-1 rounded-md bg-warning/10 text-warning border border-warning/20 font-medium"
                >
                  {field}
                </span>
              ))}
            </div>
          </PropertyField>
        )}

        {/* Transition */}
        {data.then && (
          <PropertyField label="Then">
            <span className="text-sm text-foreground">→ {data.then}</span>
          </PropertyField>
        )}

        {/* Error handler */}
        {data.onFail && (
          <PropertyField label="On Error">
            <span className="text-sm text-error">→ {data.onFail}</span>
          </PropertyField>
        )}
      </div>
    </motion.div>
  );
}

function PropertyField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/build/PropertyPanel.tsx
git commit -m "feat(studio): add PropertyPanel component for flow node inspection"
```

---

## Task 10: Create InlineArchChat component

**Files:**

- Create: `apps/studio/src/components/build/InlineArchChat.tsx`

**Step 1: Create the embeddable chat**

Create `apps/studio/src/components/build/InlineArchChat.tsx`:

```tsx
/**
 * InlineArchChat
 *
 * Embeddable Arch chat for the build pane. Reuses ArchChat but wired
 * to the editor context (not the floating ArchPanel).
 * Handles diff application through the editor bridge.
 */

import { useCallback } from 'react';
import { Sparkles, X } from 'lucide-react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { ArchIcon } from '../arch/ArchIcon';
import { ArchChat } from '../arch/ArchChat';
import { useArchStore } from '../../store/arch-store';
import { useEditorStore } from '../../store/editor-store';
import { sendArchChat } from '../../api/arch';
import { springs } from '../../lib/animation';
import type { ArchMessage, ArchDiff, LifecycleStage } from '../../types/arch';

interface InlineArchChatProps {
  projectId: string;
  agentName: string;
  className?: string;
  onClose: () => void;
}

const CHAT_WIDTH = 360;

export function InlineArchChat({ projectId, agentName, className, onClose }: InlineArchChatProps) {
  const { conversations, activeConversationId, isTyping, suggestions } = useArchStore();
  const { addMessage, setTyping, setSuggestions } = useArchStore();
  const { setPendingDiff, applyPendingDiff, rejectPendingDiff } = useEditorStore();
  const dslContent = useEditorStore((s) => s.dslContent);

  const messages = conversations[activeConversationId] ?? [];

  const handleSend = useCallback(
    async (text: string) => {
      const userMsg: ArchMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      };
      addMessage(userMsg);
      setTyping(true);

      try {
        const allMessages = [...messages, userMsg];
        const chatMessages = allMessages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const response = await sendArchChat({
          projectId,
          stage: 'build' as LifecycleStage,
          messages: chatMessages,
          context: {
            page: 'agents',
            agentId: agentName,
            agentName,
            currentAbl: dslContent,
          },
        });

        const archMsg: ArchMessage = {
          id: `arch-${Date.now()}`,
          role: 'arch',
          content: response.message,
          timestamp: new Date().toISOString(),
          agentName: 'Arch',
          diff: response.diff,
        };
        addMessage(archMsg);

        // If response includes a diff, set it as pending in the editor
        if (response.diff?.modifiedDsl) {
          setPendingDiff({
            id: response.diff.id ?? `diff-${Date.now()}`,
            modifiedDsl: response.diff.modifiedDsl,
            lines: response.diff.lines ?? [],
            description: response.diff.description ?? 'Code change',
          });
        }

        if (response.suggestions && response.suggestions.length > 0) {
          setSuggestions(response.suggestions);
        }
      } catch (err) {
        console.error('Inline Arch chat error:', err);
        addMessage({
          id: `arch-error-${Date.now()}`,
          role: 'arch',
          content: 'Sorry, I encountered an error. Please try again.',
          timestamp: new Date().toISOString(),
          agentName: 'Arch',
        });
      } finally {
        setTyping(false);
      }
    },
    [
      addMessage,
      setTyping,
      setSuggestions,
      setPendingDiff,
      messages,
      projectId,
      agentName,
      dslContent,
    ],
  );

  const handleApplyDiff = useCallback(
    (diffId: string) => {
      applyPendingDiff();
    },
    [applyPendingDiff],
  );

  const handleRejectDiff = useCallback(
    (diffId: string) => {
      rejectPendingDiff();
    },
    [rejectPendingDiff],
  );

  return (
    <motion.div
      initial={{ x: CHAT_WIDTH, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: CHAT_WIDTH, opacity: 0 }}
      transition={springs.gentle}
      className={clsx(
        'h-full border-l border-default bg-background-elevated flex flex-col shrink-0',
        className,
      )}
      style={{ width: CHAT_WIDTH }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-default shrink-0">
        <div className="flex items-center gap-2">
          <ArchIcon size={16} />
          <span className="text-sm font-semibold text-foreground">Arch</span>
          <span className="text-xs text-muted">Build Mode</span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-muted hover:text-foreground rounded-lg hover:bg-background-muted transition-default"
          aria-label="Close Arch"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Chat */}
      <ArchChat
        messages={messages}
        isTyping={isTyping}
        suggestions={suggestions}
        onSendMessage={handleSend}
        onApplyDiff={handleApplyDiff}
        onRejectDiff={handleRejectDiff}
        placeholder={`Ask Arch about ${agentName}...`}
        className="flex-1 min-h-0"
      />
    </motion.div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/build/InlineArchChat.tsx
git commit -m "feat(studio): add InlineArchChat component for build pane"
```

---

## Task 11: Create BuildEditorLayout component

**Files:**

- Create: `apps/studio/src/components/build/BuildEditorLayout.tsx`

**Step 1: Create the layout**

Create `apps/studio/src/components/build/BuildEditorLayout.tsx`:

```tsx
/**
 * BuildEditorLayout
 *
 * Split pane: Code editor OR Visual designer (left) + Arch chat (right, collapsible).
 * Segmented control toggles between Code and Visual modes.
 */

import { useState, useCallback, useEffect } from 'react';
import { Code, GitBranch, Sparkles, Play, Save, Loader2 } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { ABLEditor } from '../abl/ABLEditor';
import { VisualFlowDesigner } from './VisualFlowDesigner';
import { InlineArchChat } from './InlineArchChat';
import { ArchIcon } from '../arch/ArchIcon';
import { useEditorStore } from '../../store/editor-store';
import { useArchEditorBridge } from '../../hooks/useArchEditorBridge';
import { useABLParsing } from '../../hooks/useABLParsing';
import { Button } from '../ui/Button';

type ViewMode = 'code' | 'visual';

interface BuildEditorLayoutProps {
  projectId: string;
  agentName: string;
  onSave?: () => void;
}

export function BuildEditorLayout({ projectId, agentName, onSave }: BuildEditorLayoutProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('code');
  const [showArch, setShowArch] = useState(false);

  const { isDirty, parseErrors, compileErrors, isCompiling, pendingDiff } = useEditorStore();
  const { compileABL } = useABLParsing();

  // Bridge editor ↔ arch stores
  useArchEditorBridge(agentName);

  const totalErrors = parseErrors.length + compileErrors.length;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-default bg-background-subtle shrink-0">
        {/* Left: View mode toggle */}
        <div className="flex items-center gap-3">
          <ViewModeToggle mode={viewMode} onChange={setViewMode} />

          {isDirty && (
            <span className="text-xs text-warning flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-warning" />
              Unsaved
            </span>
          )}

          {pendingDiff && (
            <span className="text-xs text-accent flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              Pending change
            </span>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={
              isCompiling ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )
            }
            onClick={compileABL}
            disabled={isCompiling || parseErrors.length > 0}
          >
            Compile
          </Button>
          {onSave && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Save className="w-3.5 h-3.5" />}
              onClick={onSave}
              disabled={!isDirty}
            >
              Save
            </Button>
          )}
          <div className="w-px h-5 bg-border-muted" />
          <button
            onClick={() => setShowArch((v) => !v)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-default',
              showArch
                ? 'bg-purple-subtle text-purple border border-purple/30'
                : 'text-muted hover:text-foreground hover:bg-background-muted border border-transparent',
            )}
            title="Toggle Arch AI"
          >
            <ArchIcon size={14} />
            Arch
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex">
        {/* Main editor / visual area */}
        <div className="flex-1 min-w-0 min-h-0">
          {viewMode === 'code' ? (
            <ABLEditor onSave={onSave} />
          ) : (
            <VisualFlowDesigner projectId={projectId} agentName={agentName} />
          )}
        </div>

        {/* Arch chat pane */}
        <AnimatePresence>
          {showArch && (
            <InlineArchChat
              projectId={projectId}
              agentName={agentName}
              onClose={() => setShowArch(false)}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-default bg-background-subtle text-xs shrink-0">
        <div className="flex items-center gap-4">
          {totalErrors > 0 ? (
            <span className="text-error">
              {totalErrors} error{totalErrors !== 1 ? 's' : ''}
            </span>
          ) : (
            <span className="text-success">No issues</span>
          )}
          <span className="text-subtle">{viewMode === 'code' ? 'Code' : 'Visual'} mode</span>
        </div>
        <span className="text-subtle">⌘S to save</span>
      </div>
    </div>
  );
}

// =============================================================================
// VIEW MODE TOGGLE
// =============================================================================

function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="flex items-center bg-background-muted rounded-lg p-0.5 border border-default">
      <ToggleButton
        active={mode === 'code'}
        onClick={() => onChange('code')}
        icon={<Code className="w-3.5 h-3.5" />}
        label="Code"
      />
      <ToggleButton
        active={mode === 'visual'}
        onClick={() => onChange('visual')}
        icon={<GitBranch className="w-3.5 h-3.5" />}
        label="Visual"
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-default',
        active
          ? 'bg-background-elevated text-foreground shadow-sm'
          : 'text-muted hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/build/BuildEditorLayout.tsx
git commit -m "feat(studio): add BuildEditorLayout with Code/Visual toggle and Arch pane"
```

---

## Task 12: Wire BuildEditorLayout into AgentDetailPage

**Files:**

- Modify: `apps/studio/src/components/agents/AgentDetailPage.tsx` (lines 26-32, 130-131)

**Step 1: Update the agent detail page**

In `apps/studio/src/components/agents/AgentDetailPage.tsx`:

Add import (after line 20):

```ts
import { BuildEditorLayout } from '../build/BuildEditorLayout';
```

Replace the `TABS` array (lines 26-32) with:

```ts
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'versions', label: 'Versions' },
  { id: 'build', label: 'Build' },
  { id: 'model', label: 'Model' },
  { id: 'chat', label: 'Chat' },
];
```

Replace the `editor` tab rendering (line 130-131) — find the block that renders `DslEditorTab` and replace with `BuildEditorLayout`:

```tsx
{
  activeTab === 'build' && projectId && agentName && (
    <BuildEditorLayout
      projectId={projectId}
      agentName={agentName}
      onSave={undefined} // DslEditorTab handles save internally; TODO: extract save logic
    />
  );
}
```

Remove the old `DslEditorTab` import if it's now unused. Keep it if the `editor` tab ID is still referenced elsewhere — check first.

**Step 2: Verify the app builds**

Run: `cd apps/studio && pnpm build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add apps/studio/src/components/agents/AgentDetailPage.tsx
git commit -m "feat(studio): replace DSL Editor tab with Build tab in AgentDetailPage"
```

---

## Task 13: Integration — load DSL into editor when Build tab opens

**Files:**

- Modify: `apps/studio/src/components/build/BuildEditorLayout.tsx`

The `DslEditorTab` currently loads the agent's DSL content on mount (lines 38-51 of `DslEditorTab.tsx`). We need the same loading in `BuildEditorLayout`.

**Step 1: Add DSL loading effect**

In `BuildEditorLayout`, add these imports:

```ts
import { fetchRuntimeAgent, saveDslWorkingCopy } from '../../api/runtime-agents';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
```

Add the loading effect and save handler inside the component (before the return):

```ts
const { setOriginalContent, setDslContent, dslContent } = useEditorStore();

// Load agent DSL content when component mounts
useEffect(() => {
  let cancelled = false;
  (async () => {
    try {
      const result = await fetchRuntimeAgent(projectId, agentName);
      if (!cancelled && result.agent.dslContent) {
        setOriginalContent(result.agent.dslContent);
        setDslContent(result.agent.dslContent);
      }
    } catch {
      // Agent may not have DSL content yet
    }
  })();
  return () => {
    cancelled = true;
  };
}, [projectId, agentName, setOriginalContent, setDslContent]);

// Save handler
const handleSave = useCallback(async () => {
  try {
    await saveDslWorkingCopy(projectId, agentName, dslContent);
    setOriginalContent(dslContent);
    toast.success('Working copy saved');
  } catch (err) {
    toast.error(sanitizeError(err, 'Failed to save'));
  }
}, [projectId, agentName, dslContent, setOriginalContent]);
```

Then pass `handleSave` as `onSave` to the `ABLEditor` and Save button:

```tsx
  <ABLEditor onSave={handleSave} />
  ...
  <Button ... onClick={handleSave} disabled={!isDirty}>Save</Button>
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/build/BuildEditorLayout.tsx
git commit -m "feat(studio): load agent DSL and wire save in BuildEditorLayout"
```

---

## Task 14: End-to-end test — build and verify

**Step 1: Build the studio app**

Run: `pnpm build`
Expected: Build succeeds with no errors.

**Step 2: Run all existing tests**

Run: `cd apps/studio && pnpm vitest run`
Expected: All tests pass (including pre-existing ones).

**Step 3: Run the new tests specifically**

Run:

```bash
cd apps/studio && pnpm vitest run src/__tests__/editor-store-diff.test.ts src/__tests__/arch-chat-diff-extraction.test.ts src/__tests__/ir-to-flow-graph.test.ts src/__tests__/arch-editor-bridge.test.ts
```

Expected: All new tests pass.

**Step 4: Final commit**

```bash
git add -A
git commit -m "test(studio): verify BUILD stage integration"
```

---

## Summary of deliverables

| Task | What it delivers                            |
| ---- | ------------------------------------------- |
| 1    | @xyflow/react dependency                    |
| 2    | `pendingDiff` state in editor store         |
| 3    | Diff extraction from chat API tool results  |
| 4    | `modifiedDsl` on ArchDiff type              |
| 5    | `useArchEditorBridge` hook                  |
| 6    | `useIRToFlowGraph` hook + dagre layout      |
| 7    | `FlowNode` custom ReactFlow node            |
| 8    | `VisualFlowDesigner` component              |
| 9    | `PropertyPanel` for node inspection         |
| 10   | `InlineArchChat` embeddable chat            |
| 11   | `BuildEditorLayout` with Code/Visual toggle |
| 12   | Wiring into AgentDetailPage                 |
| 13   | DSL loading and save integration            |
| 14   | Build + test verification                   |

**Total: 14 tasks, ~30 commits.** Each task is independent enough for a fresh subagent.
