# Arch AI — In-Project Agent Modification Loop

**Date**: 2026-04-09
**Status**: Design — awaiting user review before implementation plan
**Branch**: `features/arch-ai`
**Owners**: Arch AI team
**Scope**: `apps/studio` (arch-v3 UI + IN_PROJECT tool overrides in `buildInProjectTools`), `packages/arch-ai` (prompts + compile-time verification test)

---

## Problem

Modifying agents inside an existing project via Arch AI is unreliable and the review UI is primitive. The observable failure mode (captured in a screenshot on 2026-04-09 against `LeadQualifier`):

1. User asks the specialist to fix a lead-qualifier agent.
2. The LLM proposes a YAML diff via `propose_modification`.
3. The diff tab shows an ugly text-only Visual/Code toggle with no syntax highlighting.
4. User clicks Accept.
5. `apply_modification` compiles the proposed code and rejects it with errors like:
   - `Line 40: Unknown section: COMPLETION: Valid sections: AGENT:, ... COMPLETE: ...`
   - `ERROR: Entry point "greeting" does not match any defined step. Available steps: definitions`
6. The chat shows `Request failed` / `Failed to apply changes to UnqualifiedHandler` with no path to recovery — the user has to retype their original request.

Five root causes identified during exploration:

| #   | Root cause                                   | Evidence                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Specialist prompt teaches invalid ABL syntax | `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts:101` uses `COMPLETION:`. The parser at `packages/core/src/parser/agent-based-parser.ts:526` only accepts `COMPLETE:`. Every scripted-agent proposal fails.                                                               |
| 2   | No compile check BEFORE the diff is shown    | `apps/studio/src/app/api/arch-ai/message/route.ts:2084` returns proposals without calling `validateProjectAgentCode`. Validation only happens inside `apply_modification` at line 920, after the user has already accepted.                                                                |
| 3   | Diff UI is text-only, not Monaco             | `apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx:42-111` uses a custom `<pre>` line-by-line renderer with a Visual/Code toggle. Monaco `DiffEditor` is not used anywhere in the codebase despite the ABL tokenizer/hover provider already existing in `ArchDSLViewer.tsx`. |
| 4   | One monolithic "FULL" change per proposal    | The IN_PROJECT override returns a single change with `construct: 'FULL'` and the entire file as before/after (`route.ts:2125-2132`). The card iterates as if multi-section, rendering one giant hard-to-navigate diff.                                                                     |
| 5   | No retry loop on failed apply                | When `apply_modification` fails, the LLM never sees the compiler error and never gets a chance to fix itself. The user is stuck.                                                                                                                                                           |

## Goals

- Users can reliably add and modify agents inside an existing project without being trapped by transient LLM syntax errors.
- The diff review is a first-class Monaco experience with ABL syntax highlighting, section-level navigation, and inline error markers.
- Invalid proposals are self-repaired automatically up to twice per user turn; if repair fails, the user sees a clear blocked state and can send structured feedback in one click.
- Specialist prompt ABL examples are guaranteed to parse cleanly, enforced by a CI test. The class of "prompt teaches broken syntax" bugs is eliminated permanently.

## Non-Goals

- Fixing the BUILD phase `propose_modification` path (different code path, different data source — `session.metadata.files` vs live `ProjectAgent` collection). Documented as deferred.
- Editable Monaco on the 'after' side of the diff (power-user escape hatch for a later spec).
- Prose-level audit of specialists with no yaml fences (`onboarding.ts`, `multi-agent-architect.ts`, etc.) — covered by a separate workstream.
- Consolidating the parallel `agent_ops.propose_modification` path in `apps/studio/src/lib/arch-ai/tools/agent-ops.ts`. That path is still wired through the legacy `apps/studio/src/app/api/arch-ai/chat/route.ts` (222-line route using `getToolsForContext`), not dead. The user's failing in-project flow goes through `apps/studio/src/app/api/arch-ai/message/route.ts:4490` (`buildInProjectTools`), which defines its own `propose_modification` tool at line 2085. This spec fixes only the `message` route path; a follow-up spec can consolidate the two routes.

## Design Decisions (from clarifying questions)

| Decision         | Choice                                                                                           | Rationale                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope            | Full modification loop: Monaco diff + pre-validation + self-repair + prompt audit                | User explicitly asked for "all" — the four concerns reinforce each other (e.g., self-repair only helps if the prompt stops lying).                                                                                                                                                                                                                          |
| Failure handling | Auto self-repair, then surface blocked state                                                     | Hides transient LLM mistakes from the user while still unblocking them when repair genuinely fails.                                                                                                                                                                                                                                                         |
| Diff layout      | Monaco side-by-side + section jump-chips                                                         | Preserves whole-file context for cross-section validation errors; chips let users jump to changed sections in 200-line agents without scrolling.                                                                                                                                                                                                            |
| Repair location  | In-tool, inside `buildInProjectTools` closure, relying on `executeMultiTurn`'s natural tool-loop | IN_PROJECT runs through `executeMultiTurn` at `route.ts:2754`, which pushes tool results back to the LLM automatically. The repair counter lives in a `Map` closed over by the tools object so it resets per POST /message. The tool echoes `attemptedCode` in failure results to work around `multi-turn-executor.ts`'s tool-input replay drop (line 131). |
| Prompt scope     | Audit all specialists + build-time compile verification                                          | Permanently kills the class of "prompt teaches broken syntax" bugs via CI enforcement.                                                                                                                                                                                                                                                                      |
| Blocked state UX | Errors inline, Accept disabled, pre-filled Modify textbox                                        | Single affordance for repair; user can edit the repair prompt or add their own context before sending.                                                                                                                                                                                                                                                      |

---

## Architecture Overview

### Happy path

```
User: "Fix the QualifiedLeadHandler — remove confirm step"
  ↓
abl-construct-expert (routeByContent picks the specialist based on user text)
  ↓ tool call
propose_modification(agentName, change, updatedCode)
  ↓ NEW: validateProjectAgentCode() runs IN-TOOL
  ↓ ✓ valid
Tool result → ModificationProposal { changes, validation: { valid: true }, reviewStatus: 'pending' }
  ↓
Diff tab (Monaco DiffEditor + section chips from identifySections())
  ↓
User clicks Accept
  ↓
apply_modification uses cached pendingMutation.after → applyProjectAgentModification()
  ↓
DB updated, diff tab shows 'applied' state
```

### Failure path

```
propose_modification tool .execute() → validateProjectAgentCode() → ✗ invalid
  ↓
Increment repairCounts.get(agentName) in the tool's closure-scoped Map
  ↓ under cap (count < 3 — initial + up to 2 retries)
Return { success: false, validation: { errors, warnings, hint } }
  ↓
executeMultiTurn pushes the tool result (including attemptedCode) to the LLM
  ↓
LLM regenerates updatedCode and calls propose_modification again
  ↓ at cap (count >= 3)
Return { success: true, proposal: { reviewStatus: 'blocked', validation } }
  ↓
LLM treats it as success and stops regenerating
  ↓
Diff tab renders with Monaco error markers + disabled Accept + pre-filled Modify
```

### Boundaries in scope

- `apps/studio/src/app/api/arch-ai/message/route.ts` — `validateProjectAgentCode` structured-error refactor (lines ~697–792), `buildInProjectTools` at line 1604 (repair counter + test-only export), `propose_modification` tool override at line ~2085 (rewritten to match the Section 3 pseudocode).
- `apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx` and `InProjectArtifactPanel.tsx` — diff review UI (rewritten to use Monaco, render blocked state, pass validation through).
- `apps/studio/src/components/arch-v3/panels/ArchDiffEditor.tsx` — **new** Monaco DiffEditor wrapper with ABL language registration + error markers.
- `apps/studio/src/lib/arch-ai/compute-changed-sections.ts` — **new** client-side utility that wraps `identifySections()` from `@agent-platform/project-io`.
- `apps/studio/src/types/arch.ts` — `ProposalReviewStatus` extension, `ProposalValidation` type, `ModificationProposal` additions.
- `apps/studio/src/hooks/useArchChat.ts` — `VALID_PROPOSAL_REVIEW_STATUSES` extension, `normalizeProposal` carrying validation, `normalizeValidation` helper.
- `packages/arch-ai/src/types/session.ts` — `PendingMutation` extension (add `reviewStatus` and `validation` optional fields).
- `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts` and `integration-methodologist.ts` — prompt audit.
- `packages/arch-ai/src/__tests__/prompts-compile.test.ts` — **new** build-time verification test that calls BOTH `parseAgentBasedABL` and `compileABLtoIR`.

**Referenced for context, not extended**: `packages/arch-ai/src/coordinator/loop-detection.ts` (`LoopDetector`), `packages/arch-ai/src/executor/executor-guards.ts` (`ExecutorGuards`), `packages/arch-ai/src/executor/multi-turn-executor.ts`. These ARE wired into the IN_PROJECT path through `executeMultiTurn` at `route.ts:2754`, so the first pass's claim that they were "dead code in the Studio route" was incorrect. But `LoopDetector` tracks exact-input-hash loops and won't catch per-agent repair retries (each regenerated `updatedCode` is a different hash), so we add a separate per-agent counter rather than extending `LoopDetector`. The reason we don't wrap the retry in `LoopDetector` is semantic, not architectural.

---

## Section 1 — Data Model and Tool Contract

The blocked-proposal path needs four coordinated type changes across the stack. Skipping any one causes the validation payload to be silently dropped at the boundary it crosses.

### 1.1 — `ProjectAgentValidationResult` becomes structured (`route.ts:697–702`)

The current shape returns flat strings:

```ts
// route.ts:697–702 — BEFORE
interface ProjectAgentValidationResult {
  valid: boolean;
  errors: string[]; // "Line 40: Unknown section: COMPLETION..."
  warnings: string[];
  hint?: string;
}
```

The parser (`packages/core/src/parser/agent-based-parser.ts`) already emits structured errors with `line`, `column`, `message` fields — `validateProjectAgentCode` currently stringifies them at line 715–717 and 771–774. We switch to structured:

```ts
// route.ts:697–702 — AFTER
interface ValidationIssue {
  line?: number;
  message: string;
  severity: 'error' | 'warning';
  source: 'parse' | 'compile';
  agent?: string; // dependent-agent errors get the agent name
}

interface ProjectAgentValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  hint?: string;
}
```

`validateProjectAgentCode` stops flattening and instead builds `ValidationIssue` objects. Existing callers that consume `errors.join('\n')` or `errors[0]` need to read `.map(e => e.message).join('\n')` and `errors[0].message`. There is only one non-tool caller (`applyProjectAgentModification` at `route.ts:921`) and its error surfacing at line 926 already wraps the first element as a string — update it to `validation.errors[0]?.message`.

### 1.2 — `ModificationProposal` adds `validation` and `'blocked'` reviewStatus (`apps/studio/src/types/arch.ts:755–773`)

```ts
// types/arch.ts — AFTER
import type { ValidationIssue } from '@agent-platform/arch-ai'; // re-exported from session.ts

export type ProposalReviewStatus = 'pending' | 'applying' | 'applied' | 'rejected' | 'blocked'; // NEW

export interface ProposalValidation {
  valid: boolean;
  errors: ValidationIssue[]; // same shape as route.ts's ValidationIssue — full information preserved
  warnings: ValidationIssue[];
  hint?: string;
  repairAttempts: number;
}

export interface ModificationProposal {
  agentName: string;
  changes: ProposedChange[];
  compilationStatus?: { success: boolean; errors: string[]; warnings: string[] };
  change?: string;
  currentCode?: string;
  proposedCode?: string;
  linesChanged?: number;
  reviewStatus?: ProposalReviewStatus;
  validation?: ProposalValidation; // NEW
  applyError?: string;
}
```

`ProposalValidation.errors` carries the SAME `ValidationIssue` objects the tool produced — including `line?`, `source`, and `agent?`. The first pass dropped `source` and `agent` under the client's flattened shape, which made dependent-agent errors and line-less compile errors impossible to render. Keeping the full shape end-to-end means the UI can split errors into "gutter-renderable" (has `line`, no `agent`) and "list-only" (no `line`, or has `agent` pointing at a dependent agent) — see Section 2 for the split rules.

### 1.3 — `useArchChat.normalizeProposal` preserves 'blocked' and `validation` (`useArchChat.ts:94–186`)

Without this, the client silently drops the blocked state because `VALID_PROPOSAL_REVIEW_STATUSES` at line 96 is a closed set of 4 values and `normalizeProposal` at line 159 never reads `proposal.validation`.

```ts
// useArchChat.ts — changes

const VALID_PROPOSAL_REVIEW_STATUSES = new Set<ProposalReviewStatus>([
  'pending',
  'applying',
  'applied',
  'rejected',
  'blocked',  // NEW
]);

function normalizeValidationIssue(e: Record<string, unknown>): ValidationIssue {
  return {
    line: typeof e.line === 'number' ? e.line : undefined,
    message: typeof e.message === 'string' ? e.message : '',
    severity: e.severity === 'warning' ? 'warning' : 'error',
    source:
      e.source === 'parse' || e.source === 'compile' ? (e.source as 'parse' | 'compile') : undefined,
    agent: typeof e.agent === 'string' ? e.agent : undefined,
  };
}

function normalizeValidation(v: unknown): ProposalValidation | undefined {
  if (!isRecord(v) || typeof v.valid !== 'boolean') return undefined;
  const errors = Array.isArray(v.errors)
    ? v.errors.filter(isRecord).map(normalizeValidationIssue)
    : [];
  const warnings = Array.isArray(v.warnings)
    ? v.warnings.filter(isRecord).map(normalizeValidationIssue)
    : [];
  return {
    valid: v.valid,
    errors,
    warnings,
    hint: typeof v.hint === 'string' ? v.hint : undefined,
    repairAttempts: typeof v.repairAttempts === 'number' ? v.repairAttempts : 0,
  };
}

function normalizeProposal(proposal, fallbackStatus = 'pending') {
  // ... existing fields ...
  return {
    // ...
    reviewStatus,  // now accepts 'blocked' because the set was extended
    validation: normalizeValidation(proposal.validation),  // NEW
    applyError: ...,
  };
}
```

### 1.4 — `PendingMutation` stores validation + reviewStatus (`packages/arch-ai/src/types/session.ts:22–29`)

Without this, a blocked proposal that survives a page reload has no validation context — the user would rehydrate to a blank diff tab.

```ts
// packages/arch-ai/src/types/session.ts — AFTER
export interface PendingMutation {
  tool: string;
  target: string;
  scope: 'SMALL' | 'MEDIUM' | 'LARGE';
  before?: unknown;
  after?: unknown;
  changeSummary?: string;
  reviewStatus?: 'pending' | 'blocked'; // NEW — 'pending' is the implied default
  validation?: PersistedValidation; // NEW (see below)
}

// NEW — structurally identical to the ValidationIssue[] that validateProjectAgentCode
// produces, so the persisted shape round-trips without information loss.
export interface PersistedValidation {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  hint?: string;
  repairAttempts: number;
}

export interface ValidationIssue {
  line?: number;
  message: string;
  severity: 'error' | 'warning';
  source?: 'parse' | 'compile';
  agent?: string; // dependent-agent error marker (e.g. the edit broke AgentB)
}
```

The `ValidationIssue` shape is defined ONCE in `packages/arch-ai/src/types/session.ts` and imported by both the server-side `ProjectAgentValidationResult` (Section 1.1) and the client-side `ProposalValidation` (Section 1.2). This kills the drift between the tool's validation contract and the client's render contract — they reference the same type.

### 1.5 — `useArchChat` rehydration reconstructs the diff tab (`apps/studio/src/hooks/useArchChat.ts:368–392`)

Adding `validation` to the type is insufficient. The live rehydration block hard-codes `reviewStatus: 'pending'`, drops `validation`, and rebuilds the proposal with `changes: []`. With that in place, a reloaded blocked proposal falls through to the `changes.length === 0` empty-state branch at `InProjectArtifactPanel.tsx:235` and disappears entirely. The "blocked state survives page reload" E2E scenario (Section 6 test #4) would fail.

The rehydration block must:

1. Read `pendingMut.reviewStatus` and `pendingMut.validation` from the persisted `PendingMutation`
2. Reconstruct the `changes` array (single `FULL` entry) from `before`/`after` so the non-empty guard passes
3. Pass both the status and the validation through `normalizeProposal`

```ts
// useArchChat.ts:368–392 — rehydration block AFTER
if (pendingMut?.target && pendingMut.after) {
  const beforeCode = typeof pendingMut.before === 'string' ? pendingMut.before : '';
  const afterCode = typeof pendingMut.after === 'string' ? pendingMut.after : '';
  const restoredStatus: ProposalReviewStatus = pendingMut.reviewStatus ?? 'pending';

  const restoredProposal = normalizeProposal(
    {
      agentName: pendingMut.target,
      // Reconstruct a single FULL change so InProjectArtifactPanel's
      // `changes.length === 0` bailout doesn't fire on reload.
      changes: [
        {
          construct: 'FULL',
          before: beforeCode || null,
          after: afterCode,
          rationale: pendingMut.changeSummary ?? 'Rehydrated from session metadata',
        },
      ],
      currentCode: beforeCode || undefined,
      proposedCode: afterCode,
      change: pendingMut.changeSummary,
      reviewStatus: restoredStatus, // NEW — was hard-coded 'pending'
      validation: pendingMut.validation, // NEW — was dropped entirely
    },
    restoredStatus,
  );
  upsertDiffTab(restoredProposal, `restored-${pendingMut.target}`);
}
```

### 1.6 — `InProjectArtifactPanel.tsx:235` bailout guard

The current bailout (`if (!proposal?.changes?.length) return "no changes yet"`) is defensive but brittle: if any future code path produces a blocked proposal without reconstructed changes, the errors disappear. With 1.5 in place, rehydrated proposals always have at least one change, but we also soften the guard so blocked proposals render even without changes:

```tsx
// InProjectArtifactPanel.tsx:233–253 — AFTER
case 'diff': {
  const proposal = tab.data as ModificationProposal | undefined;
  const hasChanges = (proposal?.changes?.length ?? 0) > 0;
  const isBlocked = proposal?.reviewStatus === 'blocked';
  if (!proposal || (!hasChanges && !isBlocked)) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-foreground-muted">
        {t('no_changes_yet')}
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto p-4">
      <InProjectDiffCard
        changes={proposal.changes}
        status={proposal.reviewStatus ?? 'pending'}
        validation={proposal.validation}  // NEW
        onAccept={onDiffAccept}
        onReject={onDiffReject}
        onModify={onDiffModify}
      />
    </div>
  );
}
```

### 1.7 — `propose_modification` tool contract (return shape summary)

Full `execute` pseudocode is in Section 3. The return-shape contract is:

```ts
// On validation success (under cap or fresh)
{ success: true, proposal: ModificationProposal /* reviewStatus: 'pending' */ }

// On validation failure, under cap
{
  success: false,
  error: { code: 'VALIDATION_FAILED', message: string },
  validation: ProposalValidation,
  attemptedCode: string,     // NEW — echoes input.updatedCode so LLM sees its own submission
  attemptNumber: number,     // 1-indexed
  repairBudgetRemaining: number,
}

// On validation failure, cap reached
{ success: true, proposal: ModificationProposal /* reviewStatus: 'blocked', validation: {...} */ }
```

The "cap reached" branch returns `success: true` deliberately: from the LLM's perspective the tool succeeded (it got a proposal back), so the specialist stops retrying. The blocked state lives on the proposal itself, not on the tool call success flag.

### 1.8 — `generate_agent` is out of scope for the repair loop

The first pass said `generate_agent` would share the repair counter with `propose_modification`. That was wrong. The live `generate_agent` tool in `buildInProjectTools` at `route.ts:2343–2400` has a fundamentally different interaction model:

- It writes the new agent **directly to the `ProjectAgent` collection** on success (line 2381).
- It does **NOT** produce a proposal, does **NOT** set `pendingMutation`, and has **no diff-tab UX**.
- Its current validation is parse-only (line 2368–2378), not compile, and it never goes through `validateProjectAgentCode`.

Applying "the same validate-and-repair pattern" would require redesigning `generate_agent` into a propose-review-accept flow to match `propose_modification` — which is a different feature, not a variation. Scoped out of this spec. What this spec DOES do for `generate_agent`:

- Nothing. The tool keeps its current behavior unchanged. The repair counter in `buildInProjectTools` is called only by `propose_modification`.

See Open Question #8 for the follow-up: harmonizing `generate_agent` with the propose-review-accept pattern, including whether a new agent should require user review before being persisted (it currently does not).

### 1.9 — Why validate in propose, not apply

Validation runs twice in the happy path (propose and apply). The cost is ~50–150ms per compile — negligible compared to an LLM round-trip, and the double-check is a safety net if the proposal was cached across a session refresh. Moving validation earlier means transient LLM mistakes never reach the user.

---

## Section 2 — Diff UI Components

### New file: `apps/studio/src/components/arch-v3/panels/ArchDiffEditor.tsx`

A read-only Monaco `DiffEditor` wrapper that mirrors the language registration from `ArchDSLViewer.tsx` (ABL tokenizer, `abl-dark` theme, hover provider).

```tsx
interface ArchDiffEditorProps {
  original: string;
  modified: string;
  fileName: string;
  renderSideBySide?: boolean; // default true
  // Only errors with a definite line AND no `agent` field become Monaco markers
  // on the modified side. Dependent-agent errors and line-less errors are
  // rendered in the error-list banner above the editor (see Blocked state).
  errorMarkers?: Array<{ line: number; message: string; severity: 'error' | 'warning' }>;
  onJumpToSection?: (sectionName: string) => void;
}
```

On mount:

1. Registers the ABL language + theme (idempotent)
2. Attaches the hover provider to both original and modified models
3. If `errorMarkers` is non-empty, calls `monaco.editor.setModelMarkers()` on the modified model for gutter squiggles + tooltips
4. Exposes an imperative `jumpToSection(name)` ref method using `editor.revealLineInCenter()`

**Error-rendering split (important)**

`ValidationIssue[]` contains three shapes:

| Shape                               | Example                                                      | Rendering                                       |
| ----------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| Has `line`, no `agent`              | `Line 40: Unknown section: COMPLETION`                       | Monaco gutter marker at line 40 AND list banner |
| No `line`, no `agent`               | `ABL validation failed: parser returned no document`         | List banner only                                |
| Has `agent` (dependent-agent error) | `[LeadIntake] handoff target QualifiedLeadHandler not found` | List banner only, prefixed with the agent name  |

`InProjectDiffCard` computes `errorMarkers` by filtering `proposal.validation.errors` where `e.line != null && !e.agent`. The full list (unfiltered) is shown in the banner above the diff editor so nothing is silently dropped.

### Rewritten `InProjectDiffCard.tsx`

Layout:

```
┌─────────────────────────────────────────────────────────┐
│ QualifiedLeadHandler.abl.yaml              [side] [inline] │  top bar (view toggle)
├─────────────────────────────────────────────────────────┤
│ [FLOW ↓]  [COMPLETE ↓]  [PERSONA ↓]   2 sections changed │  section chips
├─────────────────────────────────────────────────────────┤
│                                                         │
│     <Monaco DiffEditor, full file>                      │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ 💡 Removed confirm step; lowercased reasoning keyword.  │  rationale from LLM
├─────────────────────────────────────────────────────────┤
│   [Accept]    [Modify]    [Reject]                      │  action bar
└─────────────────────────────────────────────────────────┘
```

Section chips are computed client-side via a new utility `computeChangedSections(before, after)` that calls `identifySections()` from `@agent-platform/project-io` on both sides and diffs the section ranges. `identifySections()` uses the `SECTION_HEADERS` constant in `packages/project-io/src/diff/section-splicer.ts:22-53`.

**Known divergence**: that list is NOT the same as the parser's canonical list in `packages/core/src/parser/agent-based-parser.ts:505-543`. The splicer has `TOOLIMPORTS` and `VOICE` that the parser doesn't; the parser has `ATTACHMENTS`, `DESTINATIONS`, `STEPS`, `ACTION_HANDLERS`, `MULTI_INTENT`, `LOOKUP_TABLES`, `SYSTEM_PROMPT`, `INSTRUCTIONS`, and `INTENTS` that the splicer doesn't. For chip computation this is acceptable — the chips are a navigation aid, not a validation mechanism, and sections that fall outside the splicer's list are simply not chipified. But the first-pass claim that the chip list "stays in sync with the parser automatically" was wrong.

See Open Question #5 for a proper fix (unified section registry).

### Blocked state rendering

When `proposal.reviewStatus === 'blocked'`:

- Top bar gains a red "⚠ Validation failed" pill
- Error list renders above the Monaco editor
- `errorMarkers` prop populated from `proposal.validation.errors` so Monaco's gutter shows errors inline
- Accept disabled with tooltip "Fix validation errors first"
- Modify textbox **pre-opened and pre-filled** with:
  ```
  Please fix these compiler errors:
  - Line 40: Unknown section: COMPLETION — use COMPLETE:
  - Line 12: Entry point "greeting" does not match any defined step
  ```
- User can edit, add context, then Send to trigger a new LLM turn

### What gets deleted

- The `viewMode` state and Visual/Code toggle in `InProjectDiffCard.tsx`
- `computeLineDiff` utility (custom line-diff) — Monaco handles this now
- The per-`ChangeCard` iteration (FULL construct path always rendered one card)

### `InProjectArtifactPanel.tsx`

Passes the new `proposal.validation` through to `InProjectDiffCard`. Tab-level state machine stays the same plus the new `blocked` status. The `isNew` pulse-dot already exists and fires when the tab is created.

---

## Section 3 — Self-Repair Loop in `buildInProjectTools`

### Runtime layer the fix targets

Correction from the first pass: **IN_PROJECT does not use Vercel AI SDK's `streamText()` directly.** It goes through `packages/arch-ai/src/executor/multi-turn-executor.ts` via the call at `apps/studio/src/app/api/arch-ai/message/route.ts:2754` (`executeMultiTurn(...)`). That executor runs a tool-loop of its own, complete with `ExecutorGuards` (which wraps `LoopDetector`). The bare `streamText()` call at `route.ts:4585` is the ONBOARDING path, not IN_PROJECT.

The tools passed into `executeMultiTurn` are still built by `buildInProjectTools(ctx, sessionId, projectId)` at `route.ts:1604`, so the repair counter can still live there. But there are two real constraints the executor imposes on the repair story:

**Constraint 1 — the replay loses tool inputs.** When a server-side tool finishes, `multi-turn-executor.ts:131–149` pushes only the tool result back into the LLM's message history:

```ts
// multi-turn-executor.ts:131
messages.push({
  role: 'assistant',
  content: '',                   // original text may have been empty anyway
  toolCallId: result.toolCallId,
  toolName: result.toolName,
  // NOTE: the original `input` (our updatedCode) is NOT stored.
});
messages.push({
  role: 'tool',
  content: toolResultContent,    // only the JSON-serialized tool result
  ...
});
```

On re-invocation, the LLM sees a tool call it made (empty input in the replay) followed by the tool result. If the tool result contains only the validation errors, the LLM knows **what** is wrong but not **which code** produced it — so "repair" becomes "regenerate from scratch while trying to avoid the listed mistakes", not "fix specific lines of my previous attempt". The same class of bug is already documented for ask_user in `docs/arch/analysis/2026-04-08-blueprint-loop-analysis.md`.

**Fix: the tool echoes its input into the failed result.** Every failed `propose_modification` returns `attemptedCode: input.updatedCode` as part of the result payload. The LLM then sees its own previous code in the tool-result content and can make targeted fixes. This is a narrow, in-tool fix — it does not require rewriting the history reconstruction in multi-turn-executor.

**Constraint 2 — the cross-turn replay in `route.ts:304` strips inputs entirely.** When the user sends a NEW message in a follow-up turn, the route reconstructs Vercel messages from persisted `StoredMessage`s and pushes assistant tool calls with `input: {}` (line 313). This affects only the FIRST turn after rehydration, not the in-turn repair loop. It's addressed separately: the persisted `PendingMutation` already carries `before`/`after`, and we extend it with `validation` so the diff tab rehydrates its blocked state from session metadata instead of needing the original tool call input.

**Where the counter lives.** The repair counter is still a per-request `Map<string, number>` closed over by `buildInProjectTools`. It resets automatically when the outer function is called on the next POST `/message`. We do NOT extend `LoopDetector` — its semantics are "3 identical tool calls with the same input hash", which won't catch repair loops because each regenerated `updatedCode` has a different hash. A separate per-agent counter is the right tool.

### Repair counter in `buildInProjectTools` (`route.ts:1604`)

```ts
function buildInProjectTools(
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  sessionId: string,
  projectId: string,
) {
  const buildTools = buildBuildTools(ctx, sessionId);

  // NEW: per-request repair counter. Fresh Map per POST /message call because
  // this function is called per request. No cross-request persistence needed.
  // Key: lowercased agentName (normalized so LLM casing jitter doesn't split the counter).
  const repairCounts = new Map<string, number>();
  const REPAIR_CAP = 3; // initial failure + 2 retries

  const recordRepairAttempt = (agentName: string): number => {
    const key = agentName.toLowerCase();
    const count = (repairCounts.get(key) ?? 0) + 1;
    repairCounts.set(key, count);
    return count;
  };
  const resetRepairAttempt = (agentName: string): void => {
    repairCounts.delete(agentName.toLowerCase());
  };

  return {
    ...buildTools,
    // ...other IN_PROJECT tools...
    propose_modification: tool({
      /* see below */
    }),
    // ...
  };
}
```

### `propose_modification` `execute` callback (replaces `route.ts:2093–2153`)

```ts
execute: async (input) => {
  try {
    // Validate BEFORE constructing the proposal
    const validation = await validateProjectAgentCode(
      ctx,
      projectId,
      input.agentName,
      input.updatedCode,
    );

    if (!validation.valid) {
      const count = recordRepairAttempt(input.agentName);
      const capReached = count >= REPAIR_CAP;

      log.info('propose_modification validation failed', {
        sessionId,
        agentName: input.agentName,
        attempt: count,
        capReached,
        errors: validation.errors.slice(0, 3),
      });

      if (!capReached) {
        // Under cap: return failure. multi-turn-executor feeds this result
        // (stringified) to the LLM; the LLM sees the errors AND its own
        // previous code (via attemptedCode) and can produce a targeted fix.
        return {
          success: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: validation.errors[0]?.message ?? 'ABL validation failed',
          },
          validation: {
            errors: validation.errors,
            warnings: validation.warnings,
            hint: validation.hint,
          },
          // CRITICAL: the multi-turn-executor message replay (see multi-turn-executor.ts:131)
          // drops the original tool call's `input`, so the LLM won't otherwise see
          // what code it submitted. Echoing it into the result makes the fix-in-place
          // loop possible without changing the executor's history reconstruction.
          attemptedCode: input.updatedCode,
          attemptNumber: count,
          repairBudgetRemaining: REPAIR_CAP - count,
        };
      }

      // Cap reached: build a blocked proposal and return success.
      // From the LLM's perspective the tool succeeded; it stops regenerating.
      const { ProjectAgent } = await import('@agent-platform/database/models');
      const existing = await ProjectAgent.findOne({
        projectId,
        tenantId: ctx.tenantId,
        name: input.agentName,
      });
      const currentCode = existing?.dslContent ?? '';

      const blockedProposal = {
        agentName: input.agentName,
        change: input.change,
        currentCode,
        proposedCode: input.updatedCode,
        linesChanged: Math.abs(
          input.updatedCode.split('\n').length - currentCode.split('\n').length,
        ),
        reviewStatus: 'blocked' as const,
        changes: [
          {
            construct: 'FULL' as const,
            before: currentCode || null,
            after: input.updatedCode,
            rationale: input.change,
          },
        ],
        validation: {
          valid: false,
          errors: validation.errors,
          warnings: validation.warnings,
          hint: validation.hint,
          repairAttempts: count,
        },
      };

      // Write to session metadata so the blocked state survives page reload
      await sessionService.setPendingMutation(ctx, sessionId, {
        tool: 'apply_modification',
        target: input.agentName,
        scope: classifyMutationScope(currentCode, input.updatedCode),
        before: currentCode,
        after: input.updatedCode,
        changeSummary: input.change,
        // NEW: persist validation so rehydrated tabs can render the blocked state
        validation: blockedProposal.validation,
        reviewStatus: 'blocked',
      });

      log.info('propose_modification cap reached — returning blocked proposal', {
        sessionId,
        agentName: input.agentName,
        repairAttempts: count,
        firstError: validation.errors[0]?.message,
      });

      return { success: true, proposal: blockedProposal };
    }

    // Valid: clear any prior repair attempts for this agent and emit the proposal
    resetRepairAttempt(input.agentName);

    const { ProjectAgent } = await import('@agent-platform/database/models');
    const existing = await ProjectAgent.findOne({
      projectId,
      tenantId: ctx.tenantId,
      name: input.agentName,
    });
    if (!existing) {
      return {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Agent "${input.agentName}" not found in this project`,
        },
      };
    }

    const currentCode = existing.dslContent || '';
    const proposal = {
      agentName: input.agentName,
      change: input.change,
      currentCode,
      proposedCode: input.updatedCode,
      linesChanged: Math.abs(
        input.updatedCode.split('\n').length - currentCode.split('\n').length,
      ),
      reviewStatus: 'pending' as const,
      changes: [
        {
          construct: 'FULL' as const,
          before: currentCode || null,
          after: input.updatedCode,
          rationale: input.change,
        },
      ],
      validation: {
        valid: true,
        errors: [],
        warnings: validation.warnings,
        repairAttempts: 0,
      },
    };

    await sessionService.setPendingMutation(ctx, sessionId, {
      tool: 'apply_modification',
      target: input.agentName,
      scope: classifyMutationScope(currentCode, input.updatedCode),
      before: currentCode,
      after: input.updatedCode,
      changeSummary: input.change,
    });

    return { success: true, proposal };
  } catch (err: unknown) {
    return {
      success: false,
      error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
    };
  }
},
```

**Under the cap**: the tool returns `success: false` with the validation details AND `attemptedCode: input.updatedCode`. `multi-turn-executor.ts:139–149` stringifies the result and pushes it into the LLM's history as a tool-role message. The specialist sees its own previous code in the next turn's context and retries with a targeted fix.

**At the cap**: the tool returns `success: true` with a blocked proposal. The LLM treats this as success and stops regenerating. The user now owns the next move via the pre-filled Modify textbox.

**On success**: the counter is cleared for this agent so a follow-up edit in the same request starts fresh (e.g., `propose → apply → propose again` within one turn).

**Counting semantics (canonical)**: `recordRepairAttempt` increments before checking the cap, so:

| Call # | Return value                                                                                  | LLM sees    | Behavior                     |
| ------ | --------------------------------------------------------------------------------------------- | ----------- | ---------------------------- |
| 1      | `{ success: false, attemptedCode, attemptNumber: 1 }`                                         | Under cap   | LLM regenerates              |
| 2      | `{ success: false, attemptedCode, attemptNumber: 2 }`                                         | Under cap   | LLM regenerates              |
| 3      | `{ success: true, proposal: { reviewStatus: 'blocked', validation: { repairAttempts: 3 } } }` | Cap reached | LLM stops; user sees blocked |

So `REPAIR_CAP = 3` ≡ "up to 2 additional retries after the initial failure" ≡ "LLM gets 3 total attempts". Integration and E2E tests assert against these exact values.

### `generate_agent` is OUT of scope

First-pass assumption corrected. `generate_agent` in `buildInProjectTools` (`route.ts:2343`) writes directly to the `ProjectAgent` collection with no proposal / pendingMutation / diff-tab UX. Applying the same repair-loop contract would require redesigning the tool into a propose-review-accept flow, which is a different feature. This spec leaves `generate_agent` untouched. See Section 1.8 and Open Question #8.

### Edge cases

- **Parallel tool calls on different agents**: Counter is keyed by agentName (lowercased), so concurrent edits to different agents don't interfere.
- **LLM casing jitter**: The counter normalizes agentName to lowercase to stop the LLM from accidentally getting a fresh budget by changing `QualifiedLeadHandler` to `qualifiedLeadHandler`.
- **Session expires mid-repair**: The blocked proposal is persisted via `sessionService.setPendingMutation` including the `validation` field. On reconnect or a later request, the diff tab rehydrates from session metadata — the user sees the same blocked state they saw before.
- **New user turn arrives**: A new POST /message call rebuilds `buildInProjectTools`, so the `repairCounts` Map is a fresh `Map()`. No cleanup needed.
- **User forces "Fix this"**: The pre-filled Modify textbox triggers a new POST /message with the compiler errors in the user message. Because it's a new request, the counter is reset, and the LLM gets a fresh 3-attempt budget.

---

## Section 4 — Specialist Prompt Audit + Build-Time Verification

### Files in scope

| File                                                                    | yaml blocks | Known bugs                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`      | 7           | `COMPLETION:` at line 101 (should be `COMPLETE:`). `BEHAVIOR_PROFILES:` at line 162 and repeated at line 177 (should be `BEHAVIOR_PROFILE:`). Missing rule about lowercase fields inside FLOW step definitions. Missing rule about FLOW entry-point ↔ definitions alignment. "compiler-verified examples" comment at line 6 is a lie. |
| `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts` | 4           | None confirmed. To be validated by the new test.                                                                                                                                                                                                                                                                                      |

The other 8 specialist files (`analyst.ts`, `channel-voice.ts`, `diagnostician.ts`, `entity-collection.ts`, `multi-agent-architect.ts`, `observability-analyst.ts`, `onboarding.ts`, `testing-eval.ts`) have no yaml fences and are out of scope for this audit.

### Audit fixes in `abl-construct-expert.ts`

1. **Line 101 — fix `COMPLETION:` → `COMPLETE:`.** Match the parser and the ABL spec.
2. **Line 162 — fix `BEHAVIOR_PROFILES:` → `BEHAVIOR_PROFILE:`** (the "Behavior Profiles" example). The parser only recognizes the singular form — see `packages/core/src/parser/agent-based-parser.ts:261` and the known-section list at line 505–543. Without this fix, commit 1 lands with a broken example and commit 2's compile-time verification test fails on the first run.
3. **Line 177 — fix the "Key Syntax Rules" bullet** that lists `BEHAVIOR_PROFILES` to say `BEHAVIOR_PROFILE`. This is the prose that teaches the LLM which construct name to use; leaving it plural reintroduces the bug the next time the LLM generates an agent with a behavior profile.
4. **Add the field-casing rule** after the fixed bullet: `Inside FLOW step definitions, fields are LOWERCASE: reasoning:, present:, then:, gather:. Only top-level section headers are UPPERCASE.`
5. **Add a FLOW exit-point rule**: `Every step named in FLOW.steps must have a matching entry in FLOW.definitions. The entry point (first step listed) must be defined.`
6. **Replace the false claim at line 6** with: `## ABL Syntax Examples\n\nThese examples are validated at build time by a CI test that compiles every yaml block in this file.`

### New file: `packages/arch-ai/src/__tests__/prompts-compile.test.ts`

**Critical: this test must COMPILE, not just parse.** The first pass said "parse only, no compile" — that was wrong. Parse-only misses exactly the class of bug the spec is built to prevent: `FLOW.entry_point` mismatches, handoff targets that don't resolve, cross-section references. Those are caught by `compileABLtoIR`, not `parseAgentBasedABL`. The parser accepts structurally well-formed YAML with unknown references; the compiler rejects them.

Shape (full code in implementation plan):

- Iterate every `.ts` file under `packages/arch-ai/src/prompts/specialists/`
- For each file, extract every ` ```yaml ... ``` ` block via a regex scan
- Wrap fragments in a minimal `AGENT: _TestStub\nGOAL: "stub"\n...` stub (skipped if the block already starts with `AGENT:` or `SUPERVISOR:`). Fragment wrapping is lossy — a fragment that references an external handoff target will fail compile-time validation. The test accepts this as a feature: specialist example fragments should be complete enough to round-trip through the compiler, OR they should be annotated with an inline ` # @skip-compile` marker that the test honors.
- Call `parseAgentBasedABL(code)` from `@abl/core`. If parse errors, record them and skip the compile step for that block.
- Call `compileABLtoIR([parseResult.document])` from `@abl/compiler`. Collect both `compilation_errors` and `compilation_warnings` with severity filtering.
- Collect failures into a list with `{ file, blockIndex, stage: 'parse' | 'compile', errors }`
- Assert the failure list is empty with a readable diagnostic that includes the file, block index, and the specific error lines.

Runs in ~400–600ms (parse + compile for every block). Rides the existing `packages/arch-ai` vitest workflow in CI.

**Follow-up**: once the test passes, restore the "validated at build time" claim in `abl-construct-expert.ts:6` to reflect reality. Until then, the claim is still aspirational and should be worded as such.

---

## Section 5 — Error Handling and Observability

### Observability

- **Repair attempts**: `log.info('propose_modification repair', { sessionId, agentName, attempt, errors: errors.slice(0, 3) })` inside the `propose_modification` tool's `execute` callback on every recorded repair attempt (see Section 3 pseudocode).
- **Cap reached**: `log.info('propose_modification cap reached', { sessionId, agentName, repairAttempts, firstError })` inside the tool's `execute` callback. The blocked proposal is also persisted to `sessionService.setPendingMutation` with `reviewStatus: 'blocked'` and `validation`, so the journal/history surfaces it via the existing session-metadata read path. (No dependency on a separate `traceStore` — that was an incorrect assumption in the first pass.)

### Validation-passes-propose-fails-apply race

Another actor modifies the project between propose and apply (e.g., renames a handoff target). `apply_modification` already re-validates at `route.ts:920`, so this is caught. The existing `applyError` field on `ModificationProposal` surfaces it; the diff tab shows the error and the user can re-propose. No change needed.

### Streaming disconnection

If the SSE connection drops between `propose_modification` and the client receiving it, the proposal is also written to `sessionService.setPendingMutation` (existing behavior at `route.ts:2135`). On reconnect, the diff tab rehydrates from session metadata via the existing `useArchChat` rehydration path.

### Blocked proposal replaced by new turn

User sends feedback via the pre-filled Modify textbox. New `propose_modification` call creates a new proposal; the old blocked proposal's tab is replaced via the existing `updateTab` mechanism in `InProjectArtifactPanel.tsx:47–63`. No stale state.

---

## Section 6 — Testing Plan

Per CLAUDE.md: **≥5 E2E + ≥5 integration scenarios mandatory.**

### Integration tests (`apps/studio/src/__tests__/arch-ai/propose-modification-validation.test.ts`)

`buildInProjectTools` is not exported today. First change: add a test-only export (named export of the function) so tests can call it directly. The integration tests then invoke `tools.propose_modification.execute(input)` without going through HTTP or `executeMultiTurn`.

1. **Valid code** — `execute({ agentName: 'X', change: '...', updatedCode: GOOD })` → `{ success: true, proposal: { reviewStatus: 'pending', validation: { valid: true, repairAttempts: 0 } } }`
2. **`COMPLETION:` keyword** — `updatedCode` contains `COMPLETION:` → `{ success: false, validation: { errors: [{ message: /Unknown section: COMPLETION/ }] }, attemptedCode: GOOD_WITH_COMPLETION, attemptNumber: 1, repairBudgetRemaining: 2 }`
3. **Entry-point mismatch** — `FLOW.steps` references a step not in `definitions` → `{ success: false, validation: { errors: [{ message: /Entry point/ }] }, attemptNumber: 1 }` (this test only passes if Section 1's structured-error refactor is in place)
4. **Counter semantics — cap reaches on 3rd call**:
   - Call 1 (invalid) → `{ success: false, attemptNumber: 1, repairBudgetRemaining: 2 }`
   - Call 2 (invalid) → `{ success: false, attemptNumber: 2, repairBudgetRemaining: 1 }`
   - Call 3 (invalid) → `{ success: true, proposal: { reviewStatus: 'blocked', validation: { repairAttempts: 3 } } }`
5. **Independent counters** — invalid call for agent A, then agent B, then A again → A counter = 2, B counter = 1; neither is blocked.
6. **Counter reset on success** — invalid, invalid, then valid for the same agent → counter cleared. A subsequent invalid call is counted as `attemptNumber: 1`, not 3.
7. **Counter freshness per request** — rebuilding `buildInProjectTools` gives a new `Map`; counters from the previous request do not leak in.
8. **`attemptedCode` echo** — every failed result contains `attemptedCode === input.updatedCode` (assert field-level equality). This protects the multi-turn-executor workaround.
9. **`PendingMutation` persistence on block** — after the cap-reaching call, assert `sessionService.getById(...).metadata.pendingMutation` contains `{ reviewStatus: 'blocked', validation: { repairAttempts: 3, errors: [...] } }`.
10. `prompts-compile.test.ts` — every yaml block in every specialist file both **parses AND compiles** cleanly (lives in `packages/arch-ai/src/__tests__/` since the prompts are in that package).

### E2E tests (`apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts`)

Follow the existing mock-LLM pattern in `apps/studio/src/__tests__/e2e/arch-ai-message-streaming.e2e.test.ts`: spin up a real MongoDB via `MongoMemoryServer`, a real Node HTTP server that mimics the OpenAI chat-completions API, and hit the real `POST /api/arch-ai/message` route with `NextRequest`. The mock HTTP server returns scripted responses keyed on call count so sequential tool calls in the same `executeMultiTurn` loop get different scripted responses. No codebase mocks.

1. **Happy path** — seed agent via POST /api/projects/:id/agents → mock LLM scripts a single `propose_modification` tool call with valid code → assert SSE stream contains `{reviewStatus: 'pending'}` proposal in a `tool_result` event → the test harness then POSTs the same endpoint with `{action: 'accept'}` (existing accept flow) → assert `GET /api/projects/:id/agents/:name` returns the new code.
2. **Self-repair succeeds** — mock LLM scripts invalid code (call 1: `COMPLETION:`), then valid code (call 2). Assert the first `tool_result` event has `success: false, attemptNumber: 1, attemptedCode: …`; the second has `success: true, proposal: {reviewStatus: 'pending'}`; and the client side of the SSE stream only surfaces the second (blocked/pending tabs never see the first failure).
3. **Repair cap reached** — mock LLM scripts invalid code three times. Assert calls 1 and 2 return `success: false, attemptNumber: 1|2`; call 3 returns `success: true, proposal: {reviewStatus: 'blocked', validation: {repairAttempts: 3}}`. Assert the session's `pendingMutation.reviewStatus === 'blocked'` after the stream ends.
4. **Blocked state survives page reload** — run test 3 to completion, close the SSE stream, then re-hydrate by calling `GET /api/arch-ai/sessions/:id` and loading the diff tab. Assert the tab shows the blocked proposal including the validation errors and the `attemptedCode`.
5. **Modify feedback repairs a blocked proposal** — run test 3, then issue a new POST /api/arch-ai/message with the pre-filled modify payload (simulating the user clicking Send on the Modify textbox). Mock LLM scripts a single valid `propose_modification` for this new turn. Assert the NEW request gets a fresh repair budget (the previous request's 3 attempts don't carry over), the tool call succeeds, and the diff tab transitions from `blocked` back to `pending`.
6. **`attemptedCode` propagates across `executeMultiTurn` turns** — invalid call 1, then invalid call 2 in the same in-turn loop. Sniff the LLM request body sent on call 2 and assert it contains a tool-role message whose content includes the `attemptedCode` from call 1. (This verifies the multi-turn-executor workaround is actually working.)
7. **Sequential proposals for different agents (singleton tab)** — mock LLM scripts `propose_modification(LeadIntake, valid)` then `propose_modification(QualifiedLeadHandler, valid)` in the same in-turn loop. Assert the store's `artifactTabs` array contains exactly ONE tab with `type: 'diff'`, and that its payload is the LATEST proposal (QualifiedLeadHandler). This documents the current singleton-tab behavior; see Open Question #5 for the multi-tab future.

The original "two diff tabs open in parallel" scenario has been dropped because the current client store in `apps/studio/src/hooks/useArchChat.ts:188` (`upsertDiffTab`) always targets the first diff tab and replaces it on each new proposal. Supporting multiple simultaneous diff tabs is a separate expansion of the store model.

E2E tests use the real runtime (no `vi.mock` of platform components per CLAUDE.md E2E standards). The mock LLM is an HTTP server that impersonates the OpenAI endpoint — model resolution is pointed at this server via the existing test configuration pattern. This is the same DI shape used in `arch-ai-message-streaming.e2e.test.ts` and `arch-ai-multimodality.e2e.test.ts`; there is no `ArchAICoordinator` class and no constructor DI.

### Unit tests

- `computeChangedSections(before, after)` — returns correct section names given various diffs (added, removed, modified sections)
- `ArchDiffEditor` — renders, applies error markers, exposes `jumpToSection` ref method (React Testing Library)
- `wrapIfFragment` helper in prompts-compile test — correctly wraps fragments and leaves full agents alone

---

## Rollout and Rollback

### No feature flag

All changes ship directly on `features/arch-ai` with no feature flag gating. The Monaco diff is a strict UX improvement (the current Visual/Code toggle is being deleted, not kept in parallel), and the backend changes (pre-diff validation, self-repair, prompt audit) are strict correctness improvements. A flag would add cognitive overhead and a dead code path that has to be maintained or cleaned up later.

Rollback is per-commit: each of the nine commits in the sequence below is independently revertable. The most impactful single revert is commit 6 (`feat(studio): validate ABL in propose_modification + request-scoped repair counter`), which restores the old behavior of validating only at apply-time. Commits 3–5 are pure type/refactor commits and are safe standalone even if later commits are reverted.

### Commit sequencing (per CLAUDE.md commit discipline — ≤40 files, ≤3 packages per commit)

The sequence below interleaves type changes, the audit, and the behavioral changes so that each commit leaves the build green. Every commit is independently revertable; the `arch-ai` package and `studio` app are touched in separate commits where possible.

1. `fix(arch-ai): audit ABL examples in specialist prompts` — `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts` (COMPLETION→COMPLETE, field casing rule, FLOW entry-point rule), `integration-methodologist.ts` (any issues surfaced by the compile test in commit 2).
2. `feat(arch-ai): compile-time verification for specialist prompt examples` — `packages/arch-ai/src/__tests__/prompts-compile.test.ts`. Calls `parseAgentBasedABL` + `compileABLtoIR`. Must land AFTER commit 1 so it passes on first run.
3. `refactor(arch-ai): extend PendingMutation with reviewStatus + validation` — `packages/arch-ai/src/types/session.ts`. Pure type addition, no behavior change. Makes the session-service persist the blocked state.
4. `refactor(studio): extend ModificationProposal with validation field and blocked status` — `apps/studio/src/types/arch.ts`, `apps/studio/src/hooks/useArchChat.ts` (extend `VALID_PROPOSAL_REVIEW_STATUSES` set and add `normalizeValidation`). Normalizer must be updated in the same commit or the new field gets silently dropped. No behavior change until the tool writes it.
5. `refactor(studio): structured errors in validateProjectAgentCode` — `apps/studio/src/app/api/arch-ai/message/route.ts` (lines ~697–792). Changes the return shape from `string[]` to `ValidationIssue[]`, updates the single non-tool caller at `applyProjectAgentModification`. No behavior change for the user.
6. `feat(studio): validate ABL in propose_modification + request-scoped repair counter` — `apps/studio/src/app/api/arch-ai/message/route.ts` (rewrite the `propose_modification` tool in `buildInProjectTools`: pre-validation, `repairCounts` Map, `attemptedCode` echo, blocked-state synthesis, `PendingMutation` with validation). Depends on commits 3, 4, 5.
7. `feat(studio): Monaco diff editor for in-project modification review` — `apps/studio/src/components/arch-v3/panels/ArchDiffEditor.tsx` (new), `apps/studio/src/lib/arch-ai/compute-changed-sections.ts` (new), `InProjectDiffCard.tsx` (rewrite — uses Monaco, keeps existing pending/applying/applied/rejected rendering).
8. `feat(studio): blocked-state rendering for failed proposals` — `InProjectDiffCard.tsx` (error markers, disabled Accept, pre-filled Modify textbox), `InProjectArtifactPanel.tsx` (pass validation through).
9. `test(studio): integration + E2E tests for in-project modification loop` — new test files under `apps/studio/src/__tests__/`. Uses mock-LLM HTTP server pattern from `arch-ai-message-streaming.e2e.test.ts`.

---

## Open Questions (deferred)

1. Does the BUILD phase `propose_modification` path (which operates on `session.metadata.files` build artifacts, not the live `ProjectAgent` collection) have the same validation gap? — Separate audit, separate spec.
2. Should the parallel `agent_ops.propose_modification` path in `chat/route.ts` (via `executeAgentOps` in `apps/studio/src/lib/arch-ai/tools/agent-ops.ts`) be consolidated with the `message/route.ts` path? — Follow-up spec. Both routes currently exist; only the `message` route path is fixed here.
3. Fix the broader input-replay bug. `apps/studio/src/app/api/arch-ai/message/route.ts:304` and `packages/arch-ai/src/executor/multi-turn-executor.ts:131` both drop tool call inputs when rebuilding history. This spec works around it via `attemptedCode` echoing inside `propose_modification`. The same class of bug already hurts the ask_user flow (see `docs/arch/analysis/2026-04-08-blueprint-loop-analysis.md`). A proper fix would preserve tool inputs end-to-end, but that touches streaming, persistence, and every tool's replay contract — out of scope here.
4. Normalize agentName on the write path in `propose_modification`? — The repair counter already normalizes to lowercase for its key (`route.ts:1637,1643`), so counter-side case collisions cannot occur. What remains is the `ProjectAgent.findOne` lookup inside `propose_modification` itself (`route.ts:2011-2015`), which uses `name: input.agentName` with exact casing. If the LLM sends `QualifiedLeadHandler` once and `qualifiedLeadHandler` on a later attempt, the second lookup can return `AGENT_NOT_FOUND` even though the agent exists. Fix would be a case-insensitive lookup (collation or pre-normalized indexed field). Fine for now — LLMs rarely jitter casing mid-session — but could be tightened later.
5. Unify the section-header registry. `packages/core/src/parser/agent-based-parser.ts:505-543` and `packages/project-io/src/diff/section-splicer.ts:22-53` currently maintain separate, divergent lists. A shared module at `packages/core/src/parser/section-registry.ts` (or similar) consumed by both would kill the drift. This spec soft-references the splicer's list; the drift is not load-bearing for chip navigation but will bite eventually.
6. Expand the diff-tab store model to support multiple simultaneous diff tabs. Today, `apps/studio/src/hooks/useArchChat.ts:188` (`upsertDiffTab`) and `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx:46` both assume a singleton diff tab. The E2E test in Section 6 documents this behavior rather than testing the multi-tab assumption that the first-pass spec made. A future spec could add per-agent diff tabs with tab labels like `Changes: LeadIntake`.
7. Fold the per-agent repair counter into `LoopDetector`. The counter is a sibling concept — both detect loops, just with different grouping keys. Extending `LoopDetector` with a mode flag (`'exact-input-hash' | 'per-target'`) would unify them. Not done here because it changes `packages/arch-ai`'s public API and the closure approach is sufficient for this spec.
8. Harmonize `generate_agent` with the propose-review-accept pattern. Today `generate_agent` in `buildInProjectTools` (`route.ts:2343`) writes directly to the `ProjectAgent` collection on success, with no diff review and only parse-level validation. A future spec could: (a) run full `validateProjectAgentCode` on creation, (b) route the create through `propose_modification`-like proposals so the user reviews the new agent's code before it goes live, (c) share the repair counter so a sequence like `generate_agent(X) → propose_modification(X) → generate_agent(X)` has a unified budget. Tracked as a follow-up because it changes user-visible behavior (new agents currently materialize immediately).

---

## References

**Parser and section lists**

- `packages/core/src/parser/agent-based-parser.ts:505–543` — canonical parser section list (the list that `COMPLETION:` doesn't match)
- `packages/core/src/parser/agent-based-parser.ts:330–338` — `MISSING_ENTRY_POINT` compile-time validation
- `packages/project-io/src/diff/section-splicer.ts:22–53` — section headers for splicing (NOT in sync with the parser; see Open Question #5)
- `packages/project-io/src/diff/section-splicer.ts:72` — `identifySections()` function signature
- `packages/project-io/src/diff/index.ts:1` — re-exports `identifySections`

**Studio runtime — message route**

- `apps/studio/src/app/api/arch-ai/message/route.ts:304–316` — cross-turn Vercel message replay that strips tool inputs
- `apps/studio/src/app/api/arch-ai/message/route.ts:697–792` — `validateProjectAgentCode` (will be refactored to structured errors)
- `apps/studio/src/app/api/arch-ai/message/route.ts:921` — `applyProjectAgentModification` validation call site
- `apps/studio/src/app/api/arch-ai/message/route.ts:1604` — `buildInProjectTools` (repair counter goes here)
- `apps/studio/src/app/api/arch-ai/message/route.ts:2085` — existing `propose_modification` tool override to be rewritten
- `apps/studio/src/app/api/arch-ai/message/route.ts:2754` — `executeMultiTurn(...)` call for IN_PROJECT (the real runtime path)
- `apps/studio/src/app/api/arch-ai/message/route.ts:4490` — `isInProject` branch selecting `buildInProjectTools`

**Studio runtime — client**

- `apps/studio/src/types/arch.ts:755–773` — `ModificationProposal` + `ProposalReviewStatus` (extension target)
- `apps/studio/src/hooks/useArchChat.ts:94–186` — `VALID_PROPOSAL_REVIEW_STATUSES` + `normalizeProposal` (extension target)
- `apps/studio/src/hooks/useArchChat.ts:188–204` — `upsertDiffTab` (singleton diff tab — see E2E test #7)
- `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx:46–63` — `updateDiffProposal` (single `tab.type === 'diff'` lookup)

**Arch-ai package — executor + session types**

- `packages/arch-ai/src/types/session.ts:22–29` — `PendingMutation` (extension target for `reviewStatus` + `validation`)
- `packages/arch-ai/src/executor/multi-turn-executor.ts:131–149` — tool-result replay that drops tool inputs (the reason `attemptedCode` must be echoed)
- `packages/arch-ai/src/executor/specialist-executor.ts:175–203` — server-side tool execution; `toolResult` preserved, `input` not
- `packages/arch-ai/src/coordinator/loop-detection.ts:155` — `LoopDetector` (referenced for context; NOT extended — see Open Question #7)
- `packages/arch-ai/src/executor/executor-guards.ts:24` — `ExecutorGuards` (wraps `LoopDetector`; referenced for context)

**Test infrastructure**

- `apps/studio/src/__tests__/e2e/arch-ai-message-streaming.e2e.test.ts` — canonical mock-LLM HTTP server pattern used by the new E2E tests

**Docs**

- `docs/reference/ABL_SPEC.md:3.13` — `COMPLETE:` reference
- `docs/arch/analysis/2026-04-08-blueprint-loop-analysis.md` — same class of input-replay bug for ask_user
- Screenshot (2026-04-09) showing the `LeadQualifier` failure against `UnqualifiedHandler`
