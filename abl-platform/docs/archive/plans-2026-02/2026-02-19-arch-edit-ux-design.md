# Arch Edit UX Redesign

## Goal

Redesign the spec generation edit experience so that Arch plans before executing, the UI stays persistent during edits and cascades, and users are guided through a sequential review of each generated artifact.

## Problems Solved

1. **Auto-commit without approval** — Arch generates artifacts and commits them silently when the API response includes data. No plan, no preview, no explicit apply step.
2. **UI disappears during cascade** — Editing topology triggers downstream regeneration, which replaces the entire review screen with the pipeline stepper. Chat and spec content vanish.
3. **No guided review** — Users land on a free-form tab view with "Import to Project" at the bottom. No structured walkthrough of what was generated.
4. **Chat history lost** — Edit messages are cleared on tab switch and on commit. No per-stage threads.

## Design

### 1. Plan-Then-Execute Chat Flow

Three-phase conversation within the edit chat:

**Phase 1 — Clarify (optional)**
Arch asks clarifying questions if the request is ambiguous. Skipped for clear requests.

**Phase 2 — Plan**
Arch presents a structured plan in a conversational message. The message has `type: 'plan'` and renders with:

- A summary of proposed changes (structured bullet list)
- Two buttons: **"Go ahead"** and **"Refine..."**
- "Go ahead" sends a system message to Arch triggering artifact generation
- "Refine..." lets the user type more instructions before Arch re-plans

**Phase 3 — Execute + Apply**
After user approves the plan:

- Arch generates artifacts (typing indicator shows)
- Response arrives as a `type: 'proposal'` message showing a change summary ("+1 agent, +1 routing edge, +2 API endpoints")
- Two buttons on the proposal: **"Apply"** and **"Reject"**
- "Apply" commits the changes and triggers downstream cascade
- "Reject" keeps the chat open so user can try again or refine

No auto-commit. The response handler never calls `commitEdit` on data detection. Proposals sit in chat until the user clicks Apply.

### 2. Slide-Over Chat Panel

A slide-over panel within the review area with four states:

| State         | Width                      | Behavior                                                  |
| ------------- | -------------------------- | --------------------------------------------------------- |
| **Collapsed** | 0px (button on right edge) | "Edit with Arch" button visible. Click to open.           |
| **Default**   | ~380px                     | Standard chat panel. Header with minimize/expand buttons. |
| **Expanded**  | ~50-60% of review area     | For complex conversations and detailed plans.             |
| **Minimized** | ~48px strip                | Arch icon + unread indicator dot. Click to re-expand.     |

Transitions: collapsed ↔ default ↔ expanded, and default/expanded → minimized → default.

**Persistence:**

- Chat messages persist across minimize/expand (stored in spec-generation store).
- Each stage gets its own message thread. Switching stages starts a new thread but previous threads are kept.
- Messages persist across tab switches.

**During cascade:**

- Slide-over auto-minimizes.
- The right area shows a compact vertical pipeline progress (stages being regenerated with spinners).
- When cascade completes, pipeline progress disappears and slide-over can be re-expanded.
- Left panel content stays visible the entire time.

### 3. Sequential Guided Review

After pipeline completes, the user is guided through each stage in order:

```
Pipeline completes
  → Topology tab (auto-selected)
    [Edit with Arch]  [Looks good → Review Agents]
  → Agents tab
    [Edit with Arch]  [Looks good → Review API Spec]
  → API Spec tab
    [Edit with Arch]  [Looks good → Review Mocks]
  → Mocks tab
    [Edit with Arch]  [Looks good → Create Project]
```

**Tab behavior:**

- Tabs are visible but stages ahead of the current review step are dimmed/disabled.
- User can go back to already-reviewed stages (to re-edit) but cannot skip forward.
- Going back un-reviews that stage and everything after it.
- Small progress indicator: checkmarks on reviewed tabs.

**Edit during review:**

- "Edit with Arch" opens the slide-over chat for the current stage.
- After applying changes + cascade, review progress resets from the edited stage forward.
- User resumes guided review from the edited stage.

**Regenerate:**

- Moves to a secondary position (dropdown or "..." menu). Resets everything and re-runs the full pipeline.

### 4. Tab-Specific Actions

| Tab          | Actions                                                      |
| ------------ | ------------------------------------------------------------ |
| **Topology** | Edit via Arch only                                           |
| **Agents**   | Edit via Arch only                                           |
| **API Spec** | Download spec (`.yaml`/`.json`), Upload spec (validate-only) |
| **Mocks**    | Deploy to Vercel                                             |

**Upload flow (API Spec):**

- File picker for `.yaml`/`.json`.
- Validates the uploaded file is valid OpenAPI 3.x.
- If valid: replaces `stageResults.openapi`, triggers mocks cascade, resets review from API Spec forward.
- If invalid: shows error toast with validation message. No replacement.

### 5. Store Changes (`spec-generation-store`)

**New state fields:**

```typescript
reviewStep: SpecGenStage | null;
// Which stage the user is currently reviewing. Null during pipeline run.
// Set to 'topology' when pipeline completes.

reviewedStages: Set<SpecGenStage>;
// Stages the user has clicked "Looks good" on.

editMessages: Record<SpecGenStage, ArchMessage[]>;
// Per-stage chat threads. Persists across minimize/expand and tab switches.

editPanelState: 'collapsed' | 'default' | 'expanded' | 'minimized';
// Controls slide-over chat sizing.

pendingProposal: {
  stage: SpecGenStage;
  data: unknown;
  summary: string;
  changes: { type: string; description: string }[];
} | null;
// Holds unapplied proposal until user clicks Apply or Reject.
```

**Modified fields:**

- `editingStage` stays but no longer auto-clears on commit. Clears when user explicitly closes chat or advances review step.
- `commitEdit` only called when user clicks "Apply" on a pending proposal (not from message handler).

**New actions:**

```typescript
advanceReview(): void;
// Marks current reviewStep as reviewed, advances to next stage.

goBackToStage(stage: SpecGenStage): void;
// Un-reviews from that stage forward, sets reviewStep.

applyProposal(): void;
// Commits pendingProposal data, clears proposal, triggers cascade.

rejectProposal(): void;
// Clears pendingProposal, keeps chat open.

setEditPanelState(state: 'collapsed' | 'default' | 'expanded' | 'minimized'): void;

uploadOpenAPISpec(spec: OpenAPISpec): void;
// Validates, replaces stageResults.openapi, triggers mocks cascade.
```

**Cascade behavior:**

- When cascade starts, `editPanelState` auto-sets to `'minimized'`.
- `reviewedStages` clears from the edited stage forward.
- `reviewStep` stays on the current stage.

### 6. Chat Message Types

Extended `ArchMessage.type`:

```typescript
type?: 'message' | 'error' | 'plan' | 'proposal' | 'system';
```

| Type         | Rendering                             | Buttons                  |
| ------------ | ------------------------------------- | ------------------------ |
| `'message'`  | Normal chat bubble                    | None                     |
| `'error'`    | Red border + AlertCircle icon         | None                     |
| `'plan'`     | Structured summary card               | "Go ahead" / "Refine..." |
| `'proposal'` | Change summary card                   | "Apply" / "Reject"       |
| `'system'`   | Centered muted small text (no bubble) | None                     |

**ArchChatResponse additions:**

```typescript
plan?: {
  summary: string;
  changes: { type: string; description: string }[];
};

proposal?: {
  stage: SpecGenStage;
  data: unknown;
  summary: string;
  changes: { type: string; description: string }[];
};
```

**API route changes (`/api/arch/chat`):**

- New context field: `editPhase: 'planning' | 'executing'`
- When `editPhase === 'planning'`: Arch returns a plan (no artifacts generated)
- When `editPhase === 'executing'`: Arch generates artifacts and returns a proposal
- Same `resolveArchLLMClient(tenantId)` — no change to LLM resolution

## Behavioral Summary

| Scenario                     | Before                                    | After                                                                           |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| User sends edit request      | Auto-commits if response has data         | Arch plans → user approves → Arch executes → user applies                       |
| Cascade regeneration         | ReviewScreen replaced by PipelineStepper  | Left panel stays, right shows compact progress, chat minimizes                  |
| After pipeline completes     | Free tab browsing + "Import to Project"   | Sequential guided review: Topology → Agents → API Spec → Mocks → Create Project |
| Edit chat panel              | Fixed 340px column, history lost on close | Slide-over with collapsed/default/expanded/minimized states, per-stage threads  |
| OpenAPI spec                 | Read-only                                 | Download + upload (validate-only)                                               |
| Deploy to Vercel             | Global action on bottom bar               | Mocks tab only                                                                  |
| Tab navigation during review | All tabs freely accessible                | Forward tabs disabled until current stage reviewed                              |
