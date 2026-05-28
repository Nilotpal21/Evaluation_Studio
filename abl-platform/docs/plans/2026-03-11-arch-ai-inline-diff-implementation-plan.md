# Arch AI Inline Diff — Implementation Plan

> **For Claude:** Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Implement the BUILD stage's core interaction pattern from the master design doc (`ARCH_AI_ASSISTANT_DESIGN.md` Section 6): conversational agent modification with inline diffs, Apply/Reject buttons, and artifact panel integration.

**Design Doc Reference:** Sections 3 (Stage 3: BUILD), 6 (Iterative Agent Modification), and 7 (Visual Design Specifications).

**Branch:** `feature/arch-ai-ux-v2`
**Worktree:** `.worktrees/arch-ai-ux-v2`

**CRITICAL:** Do NOT modify any V1 component. Only create new V2 files or modify existing V2 files.

---

## Architecture

### Data Flow

```
User: "Add a reviews tool to Product_Search_Agent"
  ↓
LLM calls agent_ops.modify(dryRun: true, edits: [{section: "TOOLS", content: "..."}])
  ↓
Backend: spliceSections() → diffABL() → validateDsl()
  ↓
Returns: { success: true, data: { applied: false, diff: ABLDiffResult, modifiedDsl } }
  ↓
Frontend: ArchChatPanelV2 detects agent_ops output with diff + applied===false
  ↓
Renders: ArchDiffView inline in chat (NOT just artifact tab)
  ↓
User clicks Apply → addToolOutput({ output: 'apply' }) → LLM calls agent_ops.modify(dryRun: false)
  ↓
User clicks Reject → addToolOutput({ output: 'reject' }) → LLM suggests alternatives
```

### Key Existing Backend

- `spliceSections(original, edits)` — section-based surgical editing (packages/project-io)
- `diffABL(before, after)` — section-aware diff computation (packages/project-io)
- `agent_ops.modify(dryRun: true)` — returns `{ applied: false, diff: ABLDiffResult }`
- `agent_ops.modify(dryRun: false)` — persists changes + returns `{ applied: true, diff }`
- `ABLDiffResult` — `{ hasChanges, sections: SectionDiff[], summary: { added, removed, modified, unchanged } }`
- `SectionDiff` — `{ section, status: 'added'|'removed'|'modified'|'unchanged', beforeContent, afterContent }`

### Key Existing Frontend

- `DiffViewer` in `components/chat/artifact-tabs/DiffViewer.tsx` — section-aware with Apply/Reject (V1 artifact tab)
- `DiffViewer` in `components/ui/DiffViewer.tsx` — simple LCS line-based diff (generic)
- `DynamicTabRenderer` in `v2/tabs/DynamicTabRenderer.tsx` — already has a basic `DiffView` tab renderer

---

## Task 1: Create ArchDiffView Component (Inline Chat Diff)

**Files:**

- Create: `apps/studio/src/components/arch-ai/v2/ArchDiffView.tsx`

**Step 1: Create the inline diff component**

This renders INSIDE the chat message (like Bitbucket PR review), not in the artifact panel. Key design requirements from the master design doc:

- Shows agent name in header
- Summary line: "+N added, ~M modified, -P removed"
- For each changed section: section name badge + before/after with context lines
- Modified sections: red lines (removed) + green lines (added) with 2 lines context
- Added sections: all green with + prefix
- Removed sections: all red with - prefix
- Apply and Reject buttons at the bottom
- After Apply: buttons replaced with "Applied" badge
- After Reject: buttons replaced with "Rejected" badge
- Monospace font for diff content
- Compact — max 300px height with scroll for large diffs

```tsx
interface ArchDiffViewProps {
  agentName: string;
  diff: ABLDiffResult;
  status: 'pending' | 'applied' | 'rejected';
  onApply: () => void;
  onReject: () => void;
  validationErrors?: Array<{ line?: number; message: string }>;
}
```

**Design from master doc (Section 3, line 294-320):**

```
┌─ Proposed change to Agent_Name ────────────────────┐
│                                                      │
│  +1 section added, ~1 modified                      │
│                                                      │
│  ┌ TOOLS (modified) ─────────────────────────────┐  │
│  │   search_products(user_id: string)            │  │
│  │ + get_reviews(product_id: string) -> {        │  │
│  │ +   reviews: array }                          │  │
│  │   apply_filters(user_id: string)              │  │
│  └───────────────────────────────────────────────┘  │
│                                                      │
│  ┌──────────┐  ┌──────────┐                         │
│  │  Apply   │  │  Reject  │                         │
│  └──────────┘  └──────────┘                         │
└──────────────────────────────────────────────────────┘
```

**Styling (from design doc Section 7):**

- Diff appearance: `slide-in-right` (250ms)
- Added: `bg-green-500/10 text-green-600`
- Removed: `bg-red-500/10 text-red-600`
- Modified badge: `bg-amber-500/10 text-amber-600`
- Font: monospace, text-[13px]
- Apply button: `bg-purple text-white`
- Reject button: `border border-foreground/10 text-foreground/60`

**Step 2: Add context lines**

For modified sections, show 2 lines of unchanged context above/below the change using a simple LCS diff between `beforeContent` and `afterContent`:

```
  existing_line_1          ← context (unchanged)
  existing_line_2          ← context (unchanged)
- removed_line             ← red background
+ added_line               ← green background
  existing_line_3          ← context (unchanged)
  existing_line_4          ← context (unchanged)
```

Use the LCS algorithm from `components/ui/DiffViewer.tsx` (already exists) to compute line-level diffs within each section.

---

## Task 2: Wire ArchDiffView into ArchChatPanelV2

**Files:**

- Modify: `apps/studio/src/components/arch-ai/v2/ArchChatPanelV2.tsx`

**Step 1: Import ArchDiffView**

**Step 2: Add diff detection in AssistantMessageV2**

In the tool rendering section for `agent_ops`, detect when the output has `diff` and `applied === false`:

```tsx
if (toolName === 'agent_ops') {
  const data = output?.data;
  if (data?.diff && data?.applied === false) {
    // Render inline diff with Apply/Reject
    return (
      <ArchDiffView
        key={toolCallId}
        agentName={data.name ?? input?.agentName ?? 'Agent'}
        diff={data.diff}
        status="pending"
        validationErrors={data.errors}
        onApply={() => addToolOutput({ toolCallId, tool: toolName, output: 'apply' })}
        onReject={() => addToolOutput({ toolCallId, tool: toolName, output: 'reject' })}
      />
    );
  }
  if (data?.diff && data?.applied === true) {
    return (
      <ArchDiffView
        key={toolCallId}
        agentName={data.name ?? input?.agentName ?? 'Agent'}
        diff={data.diff}
        status="applied"
        onApply={() => {}}
        onReject={() => {}}
      />
    );
  }
}
```

**Step 3: Handle Apply/Reject tool output**

When user clicks Apply, the tool output `'apply'` is sent back to the LLM via `addToolOutput`. The LLM's system prompt already instructs it to call `agent_ops.modify(dryRun: false)` when the user approves.

When user clicks Reject, the tool output `'reject'` tells the LLM the user declined. The LLM should suggest alternatives or ask what to change.

**Step 4: Also open diff in artifact panel**

When a diff is detected, also add it as a dynamic tab (already wired in the addTab bridge):

```tsx
openTab({
  type: 'diff',
  label: 'Proposed Changes',
  data: { diff: data, status: 'pending' },
  toolCallId: callId,
});
```

This is already in the code from the previous dynamic tab port. Verify it works.

---

## Task 3: Upgrade DiffView in DynamicTabRenderer

**Files:**

- Modify: `apps/studio/src/components/arch-ai/v2/tabs/DynamicTabRenderer.tsx`

**Step 1: Replace the basic DiffView**

The current `DiffView` in DynamicTabRenderer is basic (just renders raw diff text). Replace it with proper section-aware rendering that matches the `ArchDiffView` but in a full-panel layout (not compact inline).

Reuse the same section rendering logic from `ArchDiffView` but without the compact height constraint — full scrollable view with all sections visible.

---

## Task 4: Update System Prompt for Diff Workflow

**Files:**

- Modify: `apps/studio/src/lib/arch-ai/system-prompt.ts`

**Step 1: Add diff workflow instructions**

Add to the in-project system prompt section:

```
## Agent Modification Workflow

When the user asks to modify an agent (add a tool, change the goal, update persona, etc.):

1. ALWAYS call agent_ops with action: 'modify', dryRun: true first
2. Use the edits array for surgical changes (preferred) or content for full replacement
3. The UI will show the diff to the user with Apply/Reject buttons
4. Wait for the user's response:
   - If "apply": call agent_ops with dryRun: false to persist
   - If "reject": ask what they'd like to change instead
5. Never apply changes without showing the diff first (always dryRun: true first)

Section edit format:
- edits: [{ section: "TOOLS", content: "TOOLS:\n  new_tool(param: type) -> { result: type }" }]
- To remove a section: { section: "CONSTRAINTS", content: null }
- To add a new section: { section: "ESCALATE", content: "ESCALATE:\n  ..." }
```

---

## Task 5: Add Validation Error Display

**Files:**

- Modify: `apps/studio/src/components/arch-ai/v2/ArchDiffView.tsx`

**Step 1: Show validation errors below the diff**

When `agent_ops.modify` returns validation errors along with the diff (backend returns both), show them below the diff content but above the Apply/Reject buttons:

```
┌─ Proposed change to Agent_Name ────────────────────┐
│  ... diff content ...                                │
│                                                      │
│  ⚠ 2 validation warnings:                          │
│  • Line 15: GATHER field 'email' has no prompt      │
│  • Line 22: Tool 'send_email' has no return type    │
│                                                      │
│  ┌──────────┐  ┌──────────┐                         │
│  │  Apply   │  │  Reject  │                         │
│  └──────────┘  └──────────┘                         │
└──────────────────────────────────────────────────────┘
```

If there are errors (not warnings), disable the Apply button and show:

```
│  ✗ 1 error — fix before applying:                  │
│  • Line 8: Invalid TOOLS syntax                     │
│                                                      │
│  ┌──────────────────┐  ┌──────────┐                 │
│  │  Apply (blocked) │  │  Reject  │                 │
│  └──────────────────┘  └──────────┘                 │
```

---

## Task 6: In-Project Suggestion Chips for Modifications

**Files:**

- Modify: `apps/studio/src/components/arch-ai/v2/ArchChatPanelV2.tsx`

**Step 1: Enhance deriveFollowUps for in-project context**

After an `agent_ops.read` result, show modification-oriented follow-ups:

```
"Suggest improvements"
"Add error handling"
"Add a new tool"
```

After an `agent_ops.compile` result with errors:

```
"Fix the errors"
"Explain the errors"
"Revert to previous version"
```

After an `agent_ops.modify` with `applied: true`:

```
"Compile the agent"
"Run a test conversation"
"Show the updated code"
```

**Step 2: Add project-specific suggestions to empty state**

Update the project suggestions array:

```tsx
const suggestions = project
  ? [
      'List all agents in this project',
      'Show the project topology',
      'Explain the main agent',
      'Run a test conversation',
    ]
  : HOME_SUGGESTIONS;
```

These are already good for the BUILD stage. No change needed here unless we want to add debug-oriented ones (defer to session_ops plan).

---

## Task 7: E2E Tests for Diff Workflow

**Files:**

- Modify: `apps/studio/e2e/arch-ai-v2.spec.ts`

**Step 1: Add in-project diff tests**

```typescript
test.describe('Arch AI V2 — Inline Diffs', () => {
  test('asking to modify agent shows inline diff with Apply/Reject', ...);
  test('clicking Apply persists changes and shows Applied badge', ...);
  test('clicking Reject shows Rejected badge and LLM suggests alternatives', ...);
  test('validation errors shown below diff', ...);
  test('diff also opens in artifact panel tab', ...);
});
```

Note: These tests require a real project with agents. Use the Shopping Assistant project for testing.

---

## Task Summary

| #   | Task                                | Files    | Risk                    | Depends On |
| --- | ----------------------------------- | -------- | ----------------------- | ---------- |
| 1   | ArchDiffView component              | 1 new    | Low — pure UI           | None       |
| 2   | Wire into ArchChatPanelV2           | 1 modify | Medium — tool rendering | Task 1     |
| 3   | Upgrade DynamicTabRenderer DiffView | 1 modify | Low                     | Task 1     |
| 4   | System prompt diff instructions     | 1 modify | Low                     | None       |
| 5   | Validation error display            | 1 modify | Low                     | Task 1     |
| 6   | Suggestion chips for modifications  | 1 modify | Low                     | None       |
| 7   | E2E tests                           | 1 modify | Low                     | Tasks 1-6  |

**Total: 1 new file, 4 modified files, 0 backend changes**

**Estimated implementation order:** Tasks 1 → 2 → 3 → 4 → 5 → 6 → 7

---

## Future Work (Separate Sessions)

These features are deferred to separate implementation plans:

### Session Debug & Traces

- `session_ops` tool (list, get, analyze, compare)
- Enhanced TracesView (waterfall timeline, agent breakdown)
- Inline trace expansion in chat
- Debug suggestion chips
- Proactive alerts from analytics
- Cross-page deep links

### Design Doc Alignment (Remaining Gaps)

- Assisted/Pro mode toggle
- Project Brief panel (auto-populating during Ideate)
- Stage progress indicator (Ideate → Design → Build → Test → Deploy → Evolve)
- Proactive suggestion chips (contextual per page)
- Arch side panel (collapsible persistent assistant)
- Eval framework (personas, scenarios, LLM-judge, heat map)
- Deploy readiness checklist
- Upload & extract ("I found X endpoints in your API spec")
