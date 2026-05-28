# Arch AI Build-Phase UX — Design Spec

**Date:** 2026-04-12
**Branch:** arch/knowledge
**Status:** Draft (revised after review)

## Problem

During the Build phase of Arch AI — both **onboarding project creation** (`/arch` page) and **in-project overlay** (`ArchOverlay`) — the system generates multiple agents in parallel. The current UX has three issues:

1. **Streaming indicator disappears too early** — The pulsing dot in ArchOverlay only shows when `!hasContent` (`ArchOverlay.tsx:311`). As soon as the first `text_delta` or `activity` event arrives, it vanishes — even though the response is still streaming and the `done` event hasn't fired. This affects ALL messages, not just generation.

2. **Input placeholder mismatch** — Both surfaces show "Thinking..." during BUILD phase streaming (`page.tsx:708`, `ArchOverlay.tsx:352`). The system isn't thinking — it's building agents. The visual state doesn't distinguish generation from a simple LLM response.

3. **Onboarding page has duplicate build UI** — `page.tsx:535` renders `BuildProgressCard` (from `arch-ai-store`) at the top of the BUILD section, AND `page.tsx:603` renders `ActivitySteps` below each message with build activity groups. The `ActivitySteps` display is redundant and creates visual noise since it shows the same agents that `BuildProgressCard` already covers.

**Note:** Input blocking already works correctly. The `chatState` stays `'streaming'` throughout the SSE stream, and `ChatInputBar` is disabled until the `done` event fires. This is purely a visual UX improvement.

## Target Surfaces

Both surfaces are in scope:

| Surface                       | File                                                         | What changes                                                                                           |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **Onboarding** (`/arch` page) | `apps/studio/src/app/arch/page.tsx`                          | Input placeholder during BUILD, suppress duplicate `ActivitySteps` when `BuildProgressCard` is visible |
| **In-project overlay**        | `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` | Streaming indicator persistence, render `BuildProgressCard` during BUILD, input placeholder            |

## Existing Build Components — Reuse, Don't Duplicate

**`BuildProgressCard`** (`apps/studio/src/components/arch-v3/chat/BuildProgressCard.tsx`) already implements the generation card UX:

- Per-agent rows with 4-stage pipeline pips (Gen → Comp → Enrich → Done)
- Progress bar at top
- Status dots (pending, generating, compiled, warning, error)
- Elapsed time per agent
- Token usage per agent
- Reads from `arch-ai-store` (`filePanelFiles`, `buildStages`, `agentElapsed`, `agentUsage`)

**`BuildSummaryCard`** (`apps/studio/src/components/arch-v3/chat/BuildSummaryCard.tsx`) renders a completion card when all agents are built:

- Agent grid with mode icons and tool counts
- Quality check status
- Clickable agent names navigate to the file in the artifact panel

**Decision: Reuse `BuildProgressCard` on both surfaces.** No new generation card component needed. The existing card is more capable than anything the spec would have created.

## Data Sources — Build Events Contract

Build progress flows through **two parallel paths**, both already implemented:

### Path 1: Store-driven (for `BuildProgressCard`)

`BuildProgressCard` reads four store slices: `filePanelFiles`, `buildStages`, `agentElapsed`, `agentUsage`. These are populated by **two sets of SSE events** working together:

**File-status events** — populate `filePanelFiles` (which drives the card's row status and compiled counter):

| SSE Event        | Schema (`sse-events.ts`)                                                                       | Hook handler (`useArchChat.ts`)                                                  | Store update                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `file_changed`   | `FileChangedEventSchema` (line 47) — `{ path, action, content? }`                              | Line 644 — adds file to store, sets status to `'compiling'` when content arrives | `filePanelFiles[name] = { content, compileStatus: 'compiling' }` |
| `compile_result` | `CompileResultEventSchema` (line 54) — `{ agent, status: 'pass'\|'fail', errors?, warnings? }` | Line 716 — updates file status to `'success'`, `'warning'`, or `'error'`         | `filePanelFiles[name].compileStatus` updated                     |

**Build-stage events** — populate `buildStages`, `agentElapsed`, `agentUsage` (which drive the 4-stage pipeline pips and telemetry):

| SSE Event              | Schema (`sse-events.ts`)                                                                                                              | Hook handler (`useArchChat.ts`)                                                               | Store update                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `build_agent_start`    | `BuildAgentStartEventSchema` (line 183) — `{ agent, mode, role }`                                                                     | Line 1137 — creates `build-${agent}` activity group + `setBuildStage(agent, 'gen', 'active')` | `buildStages[agent].gen = 'active'`                               |
| `build_agent_stage`    | `BuildAgentStageEventSchema` (line 190) — `{ agent, stage: 'compiling'\|'enriching'\|'done' }`                                        | Line 1170 — transitions stages sequentially                                                   | `buildStages[agent].*` transitions                                |
| `build_agent_compiled` | `BuildAgentCompiledEventSchema` (line 204) — `{ agent, elapsed, mode, agentType, toolCount, handoffCount, quality, warnings, usage }` | Line 1185 — marks all stages complete, sets elapsed/usage                                     | `buildStages[agent].* = 'complete'`, `agentElapsed`, `agentUsage` |
| `build_agent_enriched` | `BuildAgentEnrichedEventSchema` (line 225) — `{ agent, injected, reason }`                                                            | Line 1232 — appends enrichment step to activity group                                         | Activity group step added                                         |
| `build_agent_error`    | `BuildAgentErrorEventSchema` (line 232) — `{ agent, error, stage }`                                                                   | Line 1258 — marks failing stage as `'error'`, sets group status to `'error'`                  | `buildStages[agent][failingStage] = 'error'`                      |

**Important:** The card's `deriveAgentStatus()` function (`BuildProgressCard.tsx:42`) reads `file.compileStatus` from `filePanelFiles` — NOT from `buildStages`. The `buildStages` data drives the 4-stage pipeline pips. Both event sets are required for the full card to render correctly. The card also needs `topologyAgents` (from `session.metadata.topology.agents`) to know the full agent list before events arrive.

### Path 2: Activity-group-driven (for `ActivitySteps`)

The same events also create activity groups on the last assistant message:

- `build_agent_start` creates a group `build-${agent}` with an active step `Generating ${mode}...`
- `build_agent_compiled` marks the group as `done` with a summary
- `build_agent_error` marks the group as `error`

Additionally, the **onboarding flow** (`route.ts:5369`) emits regular `activity` events with groups `build:${name}` via `onboardActivity.start/done`.

### Status Vocabulary

`ActivityStep.status` is `'active' | 'done' | 'error' | 'warning' | 'info'` — there is **no `'pending'` at step level** (`useArchChat.ts:28`).

`ActivityGroup.status` is `'active' | 'done' | 'error' | 'pending'` — group-level `'pending'` exists for agents that haven't started yet (`useArchChat.ts:39`).

`StageStatus` in `arch-ai-store` is `'pending' | 'active' | 'complete' | 'error'` — the 4-stage pipeline used by `BuildProgressCard`.

## Changes

### 1. Streaming Indicator Persistence (ArchOverlay — all messages)

**File:** `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`

Remove the `!hasContent` guard. Show pulsing dots whenever `chatState === 'streaming'`, regardless of whether content has started arriving.

```typescript
// Before (line 311-317):
const hasContent = last?.thinkingText || last?.activityGroups?.length || last?.content;
return !hasContent ? <dots /> : null;

// After:
{chatState === 'streaming' && <dots />}
```

### 2. Render BuildProgressCard in ArchOverlay During BUILD

**File:** `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`

**Visibility rule:** Render whenever `phase === 'BUILD'` AND topology agents exist — regardless of `chatState`. The card reads from `arch-ai-store` (not streaming state), so it should persist across multiple streaming turns within the BUILD phase. This matches how `page.tsx:527` already renders it for onboarding (no streaming check there either).

**Data:** `phase` from `useArchChat()`, `topologyAgents` from `session.metadata.topology.agents`.

**Note:** The current code (`ArchOverlay.tsx:319`) guards on `isBuildPhase && chatState === 'streaming'` — this needs to be changed to `isBuildPhase` only (drop the streaming check).

### 3. Suppress Duplicate ActivitySteps During BUILD

**File:** `apps/studio/src/app/arch/page.tsx` (onboarding)
**File:** `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` (in-project)

When `BuildProgressCard` is visible (i.e., `phase === 'BUILD'` and topology agents exist), suppress `ActivitySteps` rendering for messages whose activity groups are all build groups (IDs matching `/^build[-:]/`). This eliminates the duplicate progress display.

Non-build activity groups (e.g., tool steps in other phases) still render as `ActivitySteps`.

**Helper:**

```typescript
function isBuildOnlyGroups(groups: ActivityGroup[]): boolean {
  return groups.length > 0 && groups.every((g) => /^build[-:]/.test(g.id));
}
```

### 4. ChatInputBar — Generating Placeholder

**File:** `apps/studio/src/components/chat/ChatInputBar.tsx`

Add `'generating'` to the `disabledReason` union. When active:

- Placeholder: "Generating agents..."
- Border: animated accent pulse (`border-accent/30 animate-pulse`)

Already implemented in prior edit.

**File:** `apps/studio/src/app/arch/page.tsx` (onboarding, line 708)

Pass `disabledReason: 'generating'` when `phase === 'BUILD'` and `chatState === 'streaming'`:

```typescript
disabledReason={
  chatState === 'streaming' && phase === 'BUILD'
    ? 'generating'
    : chatState === 'streaming'
      ? 'streaming'
      : undefined
}
```

**File:** `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` (already done)

Same pattern using `isBuildPhase` flag.

### 5. Failure Behavior — Existing Behavior Only

No new failure UI work in this spec. The existing components already handle errors:

**`BuildProgressCard` (`BuildProgressCard.tsx:42-58`):**

- `deriveAgentStatus()` maps `compileStatus: 'error'` → red error `StatusDot`
- `StagePip` shows red for errored stages
- Fraction counter (`line 165-168`) counts only `compiled` + `warning` — errored agents are excluded from the numerator
- The card does NOT display the error message text inline; it shows only the status dot and label "Error"

**`ActivitySteps` (`ActivitySteps.tsx:199-228`):**

- Each build group collapses independently via its own 3-second auto-collapse timer
- Collapsed summary shows the group's `summary` field — for compiled agents this is the per-agent summary from `build_agent_compiled`; for errored agents this is the raw error string from `build_agent_error`
- There is NO cross-group aggregation (e.g., "5 of 6 compiled") — each group collapses with its own summary

**Input area on failure:** The stream still ends with a `done` event, so `chatState` returns to `'idle'` and input re-enables normally. The LLM will respond with a message about the failure and may offer to retry.

## Files Summary

| Action | File                                                         | Description                                                                                                                         |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Modify | `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` | Streaming indicator persistence, render BuildProgressCard during BUILD, suppress duplicate ActivitySteps, generating disabledReason |
| Modify | `apps/studio/src/app/arch/page.tsx`                          | Suppress duplicate ActivitySteps during BUILD when BuildProgressCard is visible, generating disabledReason on ChatInputBar          |
| Modify | `apps/studio/src/components/chat/ChatInputBar.tsx`           | Add `'generating'` disabledReason, placeholder, border pulse                                                                        |

## No New Components

**No `GenerationProgressCard` needed.** The existing `BuildProgressCard` already provides per-agent progress with 4-stage pipeline, elapsed time, and token usage — driven by dedicated `build_agent_*` SSE events and `arch-ai-store`.

## No Backend Changes

All data needed is already in the SSE events (`build_agent_start`, `build_agent_stage`, `build_agent_compiled`, `build_agent_enriched`, `build_agent_error`). The `done` event correctly signals stream completion. No new events, API changes, or state machine modifications required.

## Testing

- **Streaming indicator**: Send any message in ArchOverlay — pulsing dots stay visible throughout entire streaming state, not just before first content
- **BuildProgressCard in overlay**: Start a BUILD phase in an existing project — card renders with per-agent pipeline stages
- **Onboarding BUILD**: Start a new project → proceed to BUILD — verify `BuildProgressCard` at top, no duplicate `ActivitySteps` for build groups
- **Input placeholder**: During BUILD streaming, both surfaces show "Generating agents..." with accent border pulse
- **Non-BUILD streaming**: Phases other than BUILD still show "Thinking..." placeholder
- **Failure**: If an agent fails, card shows error state, fraction excludes failed agents, input re-enables after stream ends
- **Mixed content**: Messages with both build and non-build activity groups show `ActivitySteps` for the non-build groups
