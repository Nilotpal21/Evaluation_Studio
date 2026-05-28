# Arch AI Build-Phase UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the visual waiting experience during Arch AI BUILD phase — persistent streaming indicator, build progress card in the overlay, distinct "Generating agents..." input state, and suppression of duplicate activity steps.

**Architecture:** Reuse the existing `BuildProgressCard` (store-driven via `build_agent_*` and `file_changed`/`compile_result` SSE events) in both the onboarding page and in-project overlay. Filter build-specific activity groups from `ThinkingPanel` when the card is visible. Extend `ChatInputBar` with a `'generating'` disabled reason for BUILD-phase streaming.

**Tech Stack:** React, Zustand (`arch-ai-store`), Tailwind CSS, SSE streaming

**Spec:** `docs/superpowers/specs/2026-04-12-arch-generation-progress-card-design.md`

**Pre-existing state:** Most changes are already committed. The plan covers the remaining uncommitted work (`ChatInputBar`), the spec document commit, and verification testing.

---

### Task 1: Commit ChatInputBar Generating State

The `'generating'` disabledReason type, placeholder, and border pulse are already implemented but uncommitted.

**Files:**

- Modified: `apps/studio/src/components/chat/ChatInputBar.tsx:21` (type union)
- Modified: `apps/studio/src/components/chat/ChatInputBar.tsx:208-213` (placeholder chain)
- Modified: `apps/studio/src/components/chat/ChatInputBar.tsx:304-306` (border class)

- [ ] **Step 1: Verify the diff is correct**

Run: `git diff HEAD -- apps/studio/src/components/chat/ChatInputBar.tsx`

Expected: Three changes:

1. Line 21: `'generating'` added to `disabledReason` union
2. Lines 208-213: `'Generating agents...'` placeholder inserted before `'widget-pending'` check
3. Lines 304-306: `disabledReason === 'generating'` → `'border-accent/30 animate-pulse'` added to border class

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`

Expected: Clean (no errors)

- [ ] **Step 3: Format**

Run: `npx prettier --write apps/studio/src/components/chat/ChatInputBar.tsx`

Expected: "unchanged" (already formatted)

- [ ] **Step 4: Commit**

```bash
git add apps/studio/src/components/chat/ChatInputBar.tsx
git commit -m "[ABLP-162] feat(studio): add generating disabledReason to ChatInputBar

ChatInputBar now accepts disabledReason='generating' for BUILD phase streaming.
Shows 'Generating agents...' placeholder and pulsing accent border."
```

---

### Task 2: Commit Design Spec

**Files:**

- Created: `docs/superpowers/specs/2026-04-12-arch-generation-progress-card-design.md`

- [ ] **Step 1: Commit spec**

```bash
git add docs/superpowers/specs/2026-04-12-arch-generation-progress-card-design.md
git commit -m "[ABLP-162] docs(studio): add build-phase UX design spec

Covers streaming indicator persistence, BuildProgressCard in overlay,
build group suppression, generating input state, and failure behavior."
```

---

### Task 3: Verify Streaming Indicator Persistence

This was committed in prior commits. Verify it works correctly on both surfaces.

**Files:**

- Verify: `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx:320-327`
- Verify: `apps/studio/src/app/arch/page.tsx:685-692`

- [ ] **Step 1: Read ArchOverlay streaming indicator code**

Confirm that the streaming indicator renders unconditionally when `chatState === 'streaming'`:

```typescript
{chatState === 'streaming' && (
  <div className="flex items-center gap-1.5 py-2 ...">
    <span className="... animate-pulse" />
    <span className="... animate-pulse [animation-delay:150ms]" />
    <span className="... animate-pulse [animation-delay:300ms]" />
  </div>
)}
```

There must be NO `!hasContent` guard. The dots show for the entire streaming duration.

- [ ] **Step 2: Read page.tsx streaming indicator code**

Same pattern at `page.tsx:685-692`. No `!hasContent` guard.

- [ ] **Step 3: Manual test — ArchOverlay**

1. Open Studio, navigate to an existing project
2. Open the Arch overlay (in-project chat panel)
3. Send any message
4. Observe: 3 pulsing dots should appear immediately and stay visible even after ThinkingPanel content starts arriving
5. Observe: dots disappear only when the response completes (chatState returns to idle)

- [ ] **Step 4: Manual test — Onboarding page**

1. Navigate to `/arch`
2. Start a new project or continue an existing onboarding session
3. Send a message
4. Observe: same behavior — dots persist throughout streaming

---

### Task 4: Verify BuildProgressCard in ArchOverlay

Already committed. Verify the card renders correctly during BUILD phase.

**Files:**

- Verify: `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx:313-318`
- Verify: `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx:84-91` (topologyAgentNames memo)

- [ ] **Step 1: Read the rendering logic**

Confirm:

```typescript
{isBuildPhase && (
  <div className="my-2">
    <BuildProgressCard topologyAgents={topologyAgentNames} />
  </div>
)}
```

Where `isBuildPhase = phase === 'BUILD' && topologyAgentNames.length > 0`. The card renders throughout BUILD (no `chatState` guard), matching `page.tsx:527` behavior.

- [ ] **Step 2: Read the data derivation**

Confirm `topologyAgentNames` is derived from `session.metadata.topology.agents`:

```typescript
const topologyAgentNames = useMemo(() => {
  const topology = session?.metadata?.topology as { agents?: Array<{ name: string }> } | undefined;
  return topology?.agents?.map((a) => a.name) ?? [];
}, [session?.metadata?.topology]);
```

- [ ] **Step 3: Manual test**

1. Open an existing project that has agents built (BUILD phase completed or in-progress)
2. Open the Arch overlay
3. Observe: `BuildProgressCard` should render with per-agent rows, pipeline stage pips, elapsed times
4. If streaming: card updates live as `build_agent_*` events arrive
5. If not streaming: card shows final state from store

---

### Task 5: Verify Build Group Suppression in ThinkingPanel

Already committed. Verify that build activity groups are filtered out when `BuildProgressCard` is visible.

**Files:**

- Verify: `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx:294-298`
- Verify: `apps/studio/src/app/arch/page.tsx:606-609`

- [ ] **Step 1: Read ArchOverlay filter**

Confirm the ThinkingPanel receives filtered groups:

```typescript
<ThinkingPanel
  activityGroups={
    isBuildPhase
      ? msg.activityGroups?.filter((g) => !/^build[-:]/.test(g.id))
      : msg.activityGroups
  }
  ...
/>
```

- [ ] **Step 2: Read page.tsx filter**

Same pattern using `isBuildWithCard`:

```typescript
activityGroups={
  isBuildWithCard
    ? msg.activityGroups?.filter((g) => !/^build[-:]/.test(g.id))
    : msg.activityGroups
}
```

- [ ] **Step 3: Manual test — no duplicate during BUILD**

1. Start a new project creation flow
2. Proceed through INTERVIEW → BLUEPRINT → BUILD
3. During BUILD: `BuildProgressCard` should show at top
4. ThinkingPanel should NOT show any `build-${agent}` or `build:${agent}` groups
5. Non-build activity (e.g., tool steps from other phases) should still show in ThinkingPanel

---

### Task 6: Verify Generating Input State

Task 1 commits the ChatInputBar changes. Verify both surfaces pass `'generating'` correctly.

**Files:**

- Verify: `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx:357-364`
- Verify: `apps/studio/src/app/arch/page.tsx:708-714`
- Verify: `apps/studio/src/components/chat/ChatInputBar.tsx:21,208-213,304-306`

- [ ] **Step 1: Read ArchOverlay disabledReason logic**

```typescript
disabledReason={
  !initialized
    ? 'connecting'
    : chatState === 'streaming' && isBuildPhase
      ? 'generating'
      : chatState === 'streaming'
        ? 'streaming'
        : undefined
}
```

- [ ] **Step 2: Read page.tsx disabledReason logic**

```typescript
disabledReason={
  chatState === 'streaming' && phase === 'BUILD'
    ? 'generating'
    : chatState === 'streaming'
      ? 'streaming'
      : undefined
}
```

- [ ] **Step 3: Manual test — BUILD placeholder**

1. Start a BUILD phase on either surface
2. During streaming: input should show "Generating agents..." (not "Thinking...")
3. Input border should pulse with accent color
4. Send button should be hidden (isStreaming behavior)

- [ ] **Step 4: Manual test — non-BUILD placeholder**

1. Send a message during INTERVIEW or BLUEPRINT phase
2. During streaming: input should show "Thinking..." (default)
3. No accent border pulse

---

### Task 7: Final Typecheck + Commit Guard

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit -p apps/studio/tsconfig.json`

Expected: Clean

- [ ] **Step 2: Prettier check**

Run: `npx prettier --check apps/studio/src/components/chat/ChatInputBar.tsx apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx apps/studio/src/app/arch/page.tsx`

Expected: All files formatted

- [ ] **Step 3: Verify no console.log leaks**

Run: `grep -rn 'console\.\(log\|warn\|error\|info\)' apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx apps/studio/src/app/arch/page.tsx apps/studio/src/components/chat/ChatInputBar.tsx`

Expected: No matches (or only pre-existing dev-mode guarded ones)
