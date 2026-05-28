# Arch In-Project Panel Redesign

**Status:** Brainstorm-approved · ready for implementation plan
**Date:** 2026-05-15
**Owner:** Sriharsha Nalluri
**Surface:** `apps/studio` — Arch in-project overlay (`/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx`)
**Mockup:** `.superpowers/brainstorm/79770-1778837987/content/proposed-design-v3.html`

## 1. Problem

The in-project Arch overlay is functional but inconsistent with the onboarding (`/arch`) experience and hides journal context behind a toggle. Four pain points motivated this redesign:

1. The **journal is the running record of Arch's thinking** — interview answers, blueprint drafts, build progress — yet it lives behind the artifact-panel toggle. Users open the overlay and see an empty chat with no visible memory of the project's history.
2. The **artifact toggle is conditional** — it hides during the resume gate and uses two separate icon buttons (`PanelLeftOpen` when in chat state, `PanelLeftClose` when in artifacts state). State is implicit; visibility is fragile.
3. The **artifact panel is too narrow** at `74vw`. After subtracting the fixed 540px chat column, only ~525px (on a 1440px screen) remains for blueprint diagrams, plan steps, and topology graphs. Real content gets squeezed.
4. The **chat footer diverges from onboarding** — `variant="compact"`, `px-3 pb-3`, no file attachments. The onboarding footer is the user-vetted version with a single rounded card holding the textarea on top and a bottom row with paperclip + hint + send. Two surfaces, one mental model is broken.

## 2. Goals · Non-Goals

**Goals**

- Journal is the **first, pinned, non-closeable** artifact tab — always present whenever the artifact panel is shown.
- A single, always-visible **"Show artifacts" / "Hide artifacts"** CTA in the overlay header, with a clear active state.
- Artifact panel grows to **85vw**, kept as an easily-adjustable constant.
- In-project chat footer matches onboarding **verbatim** — same variant, padding, attachment row, and send button.

**Non-Goals**

- No new artifact types. We are not adding new tabs.
- No changes to the artifact tab content components (`JournalPanel`, `BlueprintDocumentPanel`, etc.).
- No changes to onboarding (`/arch`). It is the reference, not the patient.
- No change to the `'ide'` overlay state. It remains in the type but unwired, as today.

## 3. Current state (what exists today)

**File:** `apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx`

- Overlay states (`OverlayState` in `lib/arch-ai/types/arch.ts:575`): `'closed' | 'chat' | 'artifacts' | 'ide'`. Only `chat ↔ artifacts` is user-reachable.
- Width map at `ArchOverlay.tsx:49-53`:
  ```ts
  const OVERLAY_WIDTHS = {
    chat: 'w-[540px]',
    artifacts: 'w-[74vw]',
    ide: 'w-[90vw]',
  };
  ```
- Chat panel hard-coded `w-[540px]` at line 872.
- Two-button toggle at lines 822-839 — `PanelLeftOpen` shown only when `visibleOverlayState === 'chat'` and not in resume gate; `PanelLeftClose` shown only when `showArtifacts` is true.
- Footer (`ArchOverlay.tsx:723-770`) renders `<ChatInputBar variant="compact" showModelLabel={false} ... />` inside `<div className="px-3 pb-3">`. No `attachments`, `onAttachFiles`, or `onRemoveAttachment` props passed.
- Journal tab is **auto-seeded** by `ensureJournalTab` after session load (`ArchOverlay.tsx:164-169`), but `closeOverlay()` clears `artifactTabs: []` in the store (`arch-ai-store.ts:506-509`), and reaching the journal still requires opening the artifact panel.
- `InProjectArtifactPanel` (`lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx`) reads `artifactTabs` from the store and renders a tab strip; closeability is determined by `NON_CLOSEABLE_TABS` (`store/arch-ai-store.ts:23-31`), which already includes `'journal'`. The current gap is **positional** (journal isn't guaranteed first) and **toggle visibility** (panel itself can be closed).

**Onboarding footer reference:** `apps/studio/src/app/arch/page.tsx:1846-1875` (entry state) and `2074-2128` (messages state). Uses `composerAttachments` state + `handleComposerAttachFiles` + `removeComposerAttachment` callbacks defined inline in the same file at lines 1029, 1201, 1352.

## 4. Design

### 4.1 Journal as pinned-first tab

**Behavior**

- When the artifact panel opens (any time `overlayState` transitions to `'artifacts'`), the journal tab is guaranteed to exist AND occupy position `0` in `artifactTabs`.
- Journal cannot be closed (already enforced via `NON_CLOSEABLE_TABS`). The redesign also makes the close-X visually absent on the journal tab — no need for a disabled `×` that does nothing.
- A small "pin" affordance (Lucide `Pin` icon at 10px, 60% opacity) precedes the label to signal pinned status.
- On overlay re-open after `closeOverlay()` (which clears tabs), the seed logic re-runs and journal is recreated at index 0.

**Implementation**

- Add `ensureJournalFirst(tabs)` helper in the store — idempotent: if `tabs[0]?.type !== 'journal'`, prepend or move it.
- Call it (a) inside the existing `ensureJournalTab` effect in `ArchOverlay`, and (b) once after any `addTab` action whose new tab is not journal-typed.
- Render guard in `InProjectArtifactPanel`'s tab strip: skip the close button when `tab.type === 'journal'`.

### 4.2 Persistent "Show / Hide artifacts" CTA

**Visual**

- Single button in the overlay header right cluster, replacing the two separate icon buttons.
- States:
  - **Closed** (`overlayState === 'chat'`): label "Show artifacts", neutral bg (`bg-background-muted`), neutral border (`border-border`), panel-with-right-arrow icon.
  - **Open** (`overlayState === 'artifacts'`): label "Hide artifacts", accent-tinted bg (`bg-accent-subtle`), accent border (`border-accent/40`), panel-with-left-arrow icon.
- Always rendered, including during the resume gate (current behavior hides it).
- Disabled only when `overlayState === 'closed'` (the overlay itself isn't open — but this case is unreachable since the header only renders when open).

**Behavior**

- Click flips between `chat` and `artifacts` states via `setOverlayState`. Same state transitions as today, just one control instead of two.
- Tooltip mirrors the label.

**Markup sketch** (Tailwind, no new tokens):

```tsx
<button
  onClick={() => setOverlayState(showArtifacts ? 'chat' : 'artifacts')}
  className={clsx(
    'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
    showArtifacts
      ? 'border-accent/40 bg-accent-subtle text-accent-foreground'
      : 'border-border bg-background-muted text-foreground-muted hover:bg-background-elevated hover:text-foreground',
  )}
  title={showArtifacts ? t('hide_artifacts') : t('show_artifacts')}
  aria-pressed={showArtifacts}
  data-testid="arch-artifacts-toggle"
>
  {showArtifacts ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
  <span>{showArtifacts ? t('hide_artifacts') : t('show_artifacts')}</span>
</button>
```

The toggle replaces lines 822-839 in `ArchOverlay.tsx`. The conditional that hides it during resume gate (`!resumeGateVisible &&` guard) is removed.

### 4.3 Artifact panel width — 85vw

- Change `OVERLAY_WIDTHS.artifacts` from `w-[74vw]` to `w-[85vw]` at `ArchOverlay.tsx:51`.
- That is the entire change. The chat column stays `w-[540px]`; the artifact pane takes `flex-1`, so it gains ~175px on a 1440-wide screen.
- The width constant doubles as the "easy config" — a single edit to bump it later if needed.
- Update the stale doc comment at `ArchOverlay.tsx:78-87` ("400px") to reflect the actual 540px chat + 85vw overlay.

### 4.4 Chat footer — onboarding parity

**Code change in `ArchOverlay.tsx` (lines 723-770):**

```diff
- <div className="px-3 pb-3">
+ <div className="shrink-0 px-6 pb-6 pt-3">
    <ChatInputBar
-     variant="compact"
      showModelLabel={false}
      onSend={handleSendWithFiles}
+     attachments={composerAttachments}
+     onAttachFiles={(files) => void handleComposerAttachFiles(files)}
+     onRemoveAttachment={removeComposerAttachment}
      ...
```

Wrapping the input in `motion.div` with `layoutId="arch-chat-input"` is **NOT** copied — that layout-id is for the onboarding entry-to-messages transition, irrelevant to the overlay.

**Composer attachment plumbing — refactor required:**

Today the composer attachment state lives inline in `apps/studio/src/app/arch/page.tsx` (`composerAttachments`, `handleComposerAttachFiles`, `removeComposerAttachment`, plus the upload effect at line 1462+). It is **not** a reusable hook. To share with the in-project overlay we will:

1. Extract a new hook `useComposerAttachments({ sessionId, projectId })` to `apps/studio/src/lib/arch-ai/hooks/use-composer-attachments.ts`. The hook owns: `composerAttachments` state, `handleComposerAttachFiles`, `removeComposerAttachment`, the upload effect (currently lines ~1473-1530 in `page.tsx`), and the `pendingBlobKey` invalidation logic.
2. Replace the inline logic in `apps/studio/src/app/arch/page.tsx` with `const { composerAttachments, handleComposerAttachFiles, removeComposerAttachment } = useComposerAttachments(...)`. This is a no-behavior-change refactor.
3. Wire the same hook in `ArchOverlay.tsx`.

This refactor lands as a **separate `refactor()` commit** before the `feat()` commit that wires the in-project footer — per CLAUDE.md commit discipline (additive feature commits, restructure first).

**Existing `handleSendWithFiles` in `ArchOverlay`** (lines 496-537): keeps working as-is — it already accepts a `files: File[]` argument from `ChatInputBar.onSend`. The only new wire is the attachment lifecycle props.

### 4.5 Surfaces unchanged

- `InProjectArtifactPanel` empty state (lines 96-119) unchanged. Once the seed logic guarantees journal is at index 0, the empty state is unreachable in normal flow (journal always present when session loads); it remains as a safety net for the brief moment before `ensureJournalFirst` runs.
- `SmartWelcome` (the chat-side empty-state) unchanged.
- Resume gate UX unchanged except that the toggle button is now visible alongside it.
- All non-journal tab content (`BlueprintDocumentPanel`, `PlanPanel`, `TopologyGraph`, `InProjectDiffCard`, etc.) untouched.

## 5. Data & state

No store schema changes. Existing primitives are sufficient:

- `useArchAIStore`'s `artifactTabs: ArtifactTab[]` array (ordered). Position 0 becomes load-bearing — `ensureJournalFirst` enforces it.
- `OverlayState` type unchanged. `'ide'` stays in the union, unwired.
- `NON_CLOSEABLE_TABS` already includes `'journal'`.

## 6. Testing

**E2E (Playwright)** — extend the existing `apps/studio/e2e/` overlay coverage:

1. Open overlay → assert toggle is visible (regardless of resume gate state).
2. Click toggle → assert overlay width changes to 85vw and journal tab is the first tab.
3. Add a Plan tab → assert journal stays at index 0.
4. Close overlay → reopen → assert journal is re-seeded at index 0.
5. Footer interaction — attach a file via the paperclip → assert the attachment chip renders inside the input card (same selector as onboarding).

**Component tests (vitest):**

1. `ensureJournalFirst` — pure-function test covering: empty array, journal missing, journal already first, journal in position 2 (move-to-front).
2. `useComposerAttachments` — happy path, max-file limit, upload-failure, removeAttachment. Pure DI for the upload client.

**Visual regression:**

- Take a Playwright screenshot of the open-artifacts and closed-artifacts states and diff against the onboarding footer to confirm visual parity. (Strict diff against onboarding's footer crop is optional but recommended.)

## 7. Risks & mitigations

| Risk                                                                                         | Mitigation                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `composerAttachments` extraction breaks onboarding                                           | Land refactor as a separate commit with full onboarding E2E green before in-project wiring; refactor must be behavior-identical                                                    |
| Width jump from 74vw → 85vw feels jarring                                                    | `transition-[width] duration-200 ease-out` already in place (`ArchOverlay.tsx:784`); no new motion needed                                                                          |
| Toggle visible during resume gate may distract from the resume CTA                           | Toggle is a secondary control (smaller, neutral background); resume gate's primary buttons (`Resume` / `Start new`) keep their visual weight and continue to occupy the chat panel |
| `ensureJournalFirst` races with `addTab` actions called before session load                  | Wrap in store action so the invariant is enforced inside `setState`, not via effect ordering                                                                                       |
| Attachment hook references `ARCH_AI_FILES` constants — must match what onboarding uses today | Hook reuses the existing import from `@/lib/arch-ai/constants` — no duplication                                                                                                    |

## 8. Rollout

Single PR, three commits in order:

1. `refactor(arch-ai): extract useComposerAttachments hook` — onboarding now uses the hook; no behavior change. Includes hook unit tests.
2. `feat(arch-ai): pin journal first, replace artifact toggle, widen panel to 85vw` — store helper + overlay header + width constant + InProjectArtifactPanel close-button guard. Includes E2E tests 1-4.
3. `feat(arch-ai): bring in-project chat footer to onboarding parity` — drop `compact` variant, wire attachments via hook, bump padding. Includes E2E test 5.

No feature flag needed. All changes are visible-on-merge UI refinements; no data migration; no API change.

## 9. Open questions

None. All four decisions were locked during brainstorm (visual companion v3 approved 2026-05-15):

- Journal pinned at index 0, non-closeable.
- Single CTA, always visible, with show/hide labels and accent-tinted open state.
- 85vw, single constant.
- Footer matches onboarding via shared `useComposerAttachments` hook.

## 10. References

- Mockup: `.superpowers/brainstorm/79770-1778837987/content/proposed-design-v3.html`
- ChatInputBar: `apps/studio/src/components/chat/ChatInputBar.tsx`
- Onboarding footer reference: `apps/studio/src/app/arch/page.tsx:1846-1875`, `2074-2128`
- Composer attachment logic to extract: `apps/studio/src/app/arch/page.tsx:1029, 1201, 1352, 1462-1530`
- Overlay component being modified: `apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx`
- Store invariants: `apps/studio/src/lib/arch-ai/store/arch-ai-store.ts` (`NON_CLOSEABLE_TABS`, `closeOverlay`, `addTab`, `setOverlayState`)
- Artifact tab list rendering: `apps/studio/src/lib/arch-ai/components/arch/panels/InProjectArtifactPanel.tsx`
