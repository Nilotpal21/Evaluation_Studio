# LLD: Arch v0.3 UX Polish Sprint

**Feature Spec**: `docs/arch/design/ux-polish-sprint.md`  
**HLD**: (combined in feature spec — tactical polish, not new feature)  
**Test Spec**: (manual browser verification — UX changes)  
**Status**: DRAFT  
**Date**: 2026-04-05

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                    | Rationale                                                        | Alternatives Rejected                    |
| --- | ------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| D-1 | Use framer-motion for animations            | Already installed (v12.31.0), widely used, 60fps guarantees      | CSS transitions only (harder for layout) |
| D-2 | Navigation header at /arch level            | Simplest — doesn't touch ArchShell layout logic                  | Breadcrumbs, back button in ArchShell    |
| D-3 | Design tokens via Tailwind semantic classes | Platform standard, theme-aware                                   | CSS-in-JS, inline styles                 |
| D-4 | 4 sequential commits (not 1 mega-commit)    | Atomic, reviewable, revertable                                   | Single commit (unrevertable if breaks)   |
| D-5 | Welcome cards over tutorial overlay         | Non-intrusive, user-initiated discovery                          | Modal tutorial, Shepherd.js guided tour  |
| D-6 | Animations opt-in (not all-at-once)         | Phase 3 only animates, Phases 1-2 keep existing instant behavior | Animate everything immediately           |
| D-7 | No CSS `will-change` initially              | Add only if profiling shows jank                                 | Preemptive `will-change` (can hurt perf) |
| D-8 | Template chips send pre-filled prompts      | Faster onboarding, users see examples                            | Open modal with form, link to docs       |

### Key Interfaces & Types

```typescript
// No new types — all changes are UI/CSS/animation
// Existing types from arch-v3 remain unchanged
```

### Module Boundaries

| Module                                                                  | Responsibility                      | Depends On                       |
| ----------------------------------------------------------------------- | ----------------------------------- | -------------------------------- |
| `apps/studio/src/app/arch/page.tsx`                                     | /arch route page, navigation header | Next.js Link, lucide-react icons |
| `apps/studio/src/components/arch-v3/layout/ArchShell.tsx`               | Layout shell, panel orchestration   | framer-motion (Phase 3 only)     |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`            | In-project overlay                  | framer-motion (Phase 3 only)     |
| `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx` | Artifact tab panel                  | framer-motion (Phase 3 only)     |
| `apps/studio/src/components/arch-v3/widgets/*.tsx`                      | 5 widget components                 | framer-motion (Phase 3 only)     |
| `packages/design-tokens`                                                | Semantic color tokens               | None (already exists)            |

---

## 2. File-Level Change Map

### New Files

None — all changes are modifications to existing files.

### Modified Files

| File                                                                    | Change Description                                                                            | Risk                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| `apps/studio/src/app/arch/page.tsx`                                     | Add navigation header with back button, phase indicator                                       | Low — additive above existing content |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`            | Replace hardcoded `bg-purple/10` → `bg-accent/5`, add slide-in animation                      | Low — isolated component              |
| `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx` | Replace `bg-purple`, `text-purple`, `border-purple` → semantic tokens, add tab fade animation | Low — styling only                    |
| `apps/studio/src/components/arch-v3/widgets/Confirmation.tsx`           | Semantic tokens + fade-in animation                                                           | Low                                   |
| `apps/studio/src/components/arch-v3/widgets/FileUpload.tsx`             | Semantic tokens + fade-in animation                                                           | Low                                   |
| `apps/studio/src/components/arch-v3/widgets/MultiSelect.tsx`            | Semantic tokens + fade-in animation                                                           | Low                                   |
| `apps/studio/src/components/arch-v3/widgets/SingleSelect.tsx`           | Semantic tokens + fade-in animation                                                           | Low                                   |
| `apps/studio/src/components/arch-v3/widgets/TextInput.tsx`              | Semantic tokens + fade-in animation                                                           | Low                                   |
| `apps/studio/src/components/arch-v3/chat/ResumeDialog.tsx`              | Semantic tokens                                                                               | Low                                   |
| `apps/studio/src/components/arch-v3/chat/ApprovalGate.tsx`              | Semantic tokens (Accept=success, Modify=warning, Reject=error)                                | Low                                   |
| `apps/studio/src/components/arch-v3/layout/ArchShell.tsx`               | Add framer-motion LayoutGroup for panel width animations                                      | Medium — layout behavior changes      |

### Deleted Files

None.

---

## 3. Implementation Phases

CRITICAL: Each phase must be independently deployable and testable.
No phase should leave the system in a broken state.

### Phase 1: Navigation & Structure

**Goal**: Users can navigate back to project list from /arch page

**Tasks**:

1.1. Add navigation header to `/arch` page (`page.tsx:539`)

- Import `Link` from `next/link`, `ArrowLeft` from `lucide-react`
- Wrap existing `<ArchShell />` in parent `<div className="h-full flex flex-col">`
- Insert header above ArchShell with back button and phase indicator
- Back button links to `/projects`
- Phase indicator shows current phase from `phase` state

  1.2. Update page layout structure

- ArchShell no longer assumes `h-full` from parent
- ArchShell becomes `flex-1` child of page wrapper
- Verify scrolling still works (chat messages, artifact panels)

  1.3. Style navigation header

- Use semantic tokens: `border-border`, `text-foreground-muted`
- Back button uses `btn-ghost` class (if exists) or inline hover styles
- Header height: `py-4` (consistent with other Studio headers)

**Files Touched**:

- `apps/studio/src/app/arch/page.tsx` — add header div at line 539, wrap ArchShell

**Exit Criteria**:

- [ ] Back button visible at top of /arch page
- [ ] Clicking back navigates to /projects (verify in browser)
- [ ] Phase indicator shows correct phase text ("Interview", "Blueprint", "Build", "Create")
- [ ] Page layout still fills viewport (no white space gaps)
- [ ] Scrolling works in chat and artifact panels
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] No TypeScript errors in modified file

**Test Strategy**:

- Manual: Navigate to /arch, verify back button visible and functional
- Manual: Test in all 4 phases (INTERVIEW, BLUEPRINT, BUILD, CREATE)
- Manual: Verify scrolling behavior unchanged
- Unit: N/A (UI-only change)
- Integration: N/A

**Rollback**: Revert commit — no downstream dependencies

---

### Phase 2: Design System Compliance

**Goal**: All Arch components use semantic design tokens from `@agent-platform/design-tokens`, no hardcoded Tailwind palette colors

**Tasks**:

2.1. Create migration script for batch find-replace (optional, can be manual)

- Regex patterns for each color class
- Dry-run mode to verify matches

  2.2. Migrate ArchOverlay.tsx

- Line 271: `bg-purple/10` → `bg-accent/5` (in-project badge)
- Line 245: `bg-purple` → `bg-accent` (send button)
- Line 250: `text-purple-foreground` → `text-white` (button text — accent background implies white text)
- Search file for any remaining `-purple`, `-red`, `-green`, `-amber` numeric variants

  2.3. Migrate OnboardingArtifactPanel.tsx

- Line 118: `border-b-purple` → `border-b-accent` (active tab underline)
- Line 122: `bg-purple` → `bg-accent` (new tab pulse dot)
- Line 142: `border-b-purple` → `border-b-accent` (file tab active underline)
- Line 147: `bg-purple` → `bg-accent` (file tab pulse dot)
- Line 190: `bg-purple` → `bg-accent` (Continue button)
- Line 210: `bg-purple` → `bg-accent` (compiling status dot)

  2.4. Migrate ApprovalGate.tsx

- Accept button: use `bg-success`, `hover:bg-success/90`, `text-white`
- Modify button: use `bg-warning`, `hover:bg-warning/90`, `text-white`
- Reject button: use `bg-error`, `hover:bg-error/90`, `text-white`
- Remove any hardcoded `-green-500`, `-amber-500`, `-red-500`

  2.5. Migrate 5 widget components

- TextInput.tsx: Replace `border-purple` (focus state) → `border-accent`, `text-purple` → `text-accent`
- SingleSelect.tsx: Replace `bg-purple/10` (selected) → `bg-accent/10`, `text-purple` → `text-accent`
- MultiSelect.tsx: Same as SingleSelect
- Confirmation.tsx: Button states → `bg-accent`, `bg-muted`
- FileUpload.tsx: Upload button → `bg-accent`

  2.6. Migrate ResumeDialog.tsx

- Resume button: `bg-accent`, `hover:bg-accent/90`
- Start Fresh button: `bg-muted`, `hover:bg-muted/90`

  2.7. Verify no regressions

- Run: `grep -r "bg-purple-[0-9]" apps/studio/src/components/arch-v3/` → expect 0 results
- Run: `grep -r "text-red-[0-9]" apps/studio/src/components/arch-v3/` → expect 0 results
- Run: `grep -r "bg-green-[0-9]" apps/studio/src/components/arch-v3/` → expect 0 results
- Visual: Take screenshots before/after for regression check

**Files Touched**:

- `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`
- `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx`
- `apps/studio/src/components/arch-v3/widgets/TextInput.tsx`
- `apps/studio/src/components/arch-v3/widgets/SingleSelect.tsx`
- `apps/studio/src/components/arch-v3/widgets/MultiSelect.tsx`
- `apps/studio/src/components/arch-v3/widgets/FileUpload.tsx`
- `apps/studio/src/components/arch-v3/widgets/Confirmation.tsx`
- `apps/studio/src/components/arch-v3/chat/ResumeDialog.tsx`
- `apps/studio/src/components/arch-v3/chat/ApprovalGate.tsx`

**Exit Criteria**:

- [ ] `grep -r "bg-purple-[0-9]" apps/studio/src/components/arch-v3/` returns 0 results
- [ ] `grep -r "text-red-[0-9]" apps/studio/src/components/arch-v3/` returns 0 results
- [ ] `grep -r "bg-green-[0-9]" apps/studio/src/components/arch-v3/` returns 0 results
- [ ] `grep -r "text-amber-[0-9]" apps/studio/src/components/arch-v3/` returns 0 results
- [ ] Visual regression: colors identical before/after (screenshot comparison)
- [ ] Dark mode still works (if applicable)
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] All 9 files have 0 TypeScript errors

**Test Strategy**:

- Manual: Open /arch in browser, verify all colors match previous appearance
- Manual: Test in light and dark mode (if dark mode exists)
- Manual: Screenshot before/after for pixel-perfect comparison
- Automated: grep commands to verify no hardcoded colors remain
- Unit: N/A (styling only)
- Integration: N/A

**Rollback**: Revert commit — no functional changes, only color classes

---

### Phase 3: Smooth Animations

**Goal**: All layout shifts and panel appearances are smooth, 60fps, no jank

**Tasks**:

3.1. Verify framer-motion installed

- Run: `grep "framer-motion" apps/studio/package.json` → confirm v12.31.0+
- If not installed: `pnpm add framer-motion --filter=studio`

  3.2. Add ArchOverlay slide-in animation (`ArchOverlay.tsx:259-266`)

- Import `motion` from `framer-motion`
- Wrap overlay root div with `<AnimatePresence><motion.div>`
- Add props: `initial={{ x: '100%' }}`, `animate={{ x: 0 }}`, `exit={{ x: '100%' }}`
- Transition: `{{ duration: 0.2, ease: 'easeOut' }}`
- Ensure `overlayState === 'closed'` unmounts the component (AnimatePresence needs this)

  3.3. Add artifact panel tab switch animation (`OnboardingArtifactPanel.tsx:168`)

- Import `AnimatePresence`, `motion` from `framer-motion`
- Wrap `<TabContent>` in `<AnimatePresence mode="wait"><motion.div>`
- Key by `activeTab.id` so AnimatePresence detects tab changes
- Props: `initial={{ opacity: 0, x: -10 }}`, `animate={{ opacity: 1, x: 0 }}`, `exit={{ opacity: 0, x: 10 }}`
- Transition: `{{ duration: 0.15 }}`

  3.4. Add widget fade-in animation (5 widget files)

- TextInput.tsx: Wrap return value in `<motion.div>`
- SingleSelect.tsx: Wrap return value in `<motion.div>`
- MultiSelect.tsx: Wrap return value in `<motion.div>`
- Confirmation.tsx: Wrap return value in `<motion.div>`
- FileUpload.tsx: Wrap return value in `<motion.div>`
- All use: `initial={{ opacity: 0, y: 10 }}`, `animate={{ opacity: 1, y: 0 }}`, `transition={{ duration: 0.2, ease: 'easeOut' }}`

  3.5. Add ArchShell panel width animation (`ArchShell.tsx:32`)

- Import `motion`, `LayoutGroup` from `framer-motion`
- Wrap panel divs in `<LayoutGroup><div className="flex flex-1 overflow-hidden">`
- Convert fileTreePanel, artifactPanel, chatPanel wrapper divs to `motion.div`
- Add `layout` prop to each motion.div
- Add `initial={false}` to prevent initial mount animation
- Transition: `{{ duration: 0.3, ease: 'easeInOut' }}`
- Test phase transitions: INTERVIEW (no file panel) → BLUEPRINT (artifact appears) → BUILD (file panel appears)

  3.6. Performance profiling

- Open DevTools → Performance tab
- Record during overlay open, tab switch, widget appear, phase transition
- Verify: no frames >16ms (60fps), no layout thrashing
- If jank detected: add `will-change: transform` to animated elements

**Files Touched**:

- `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`
- `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx`
- `apps/studio/src/components/arch-v3/layout/ArchShell.tsx`
- `apps/studio/src/components/arch-v3/widgets/TextInput.tsx`
- `apps/studio/src/components/arch-v3/widgets/SingleSelect.tsx`
- `apps/studio/src/components/arch-v3/widgets/MultiSelect.tsx`
- `apps/studio/src/components/arch-v3/widgets/FileUpload.tsx`
- `apps/studio/src/components/arch-v3/widgets/Confirmation.tsx`

**Exit Criteria**:

- [ ] Overlay slides in from right (not instant) when opening
- [ ] Overlay slides out to right (not instant) when closing
- [ ] Artifact panel tabs fade/slide when switching (not instant)
- [ ] Widgets fade in from bottom when appearing (not instant)
- [ ] Phase transitions morph panel widths smoothly (INTERVIEW → BLUEPRINT → BUILD)
- [ ] No jank: DevTools Performance shows 60fps (no frames >16ms)
- [ ] No layout shift (CLS = 0 in Lighthouse)
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] All modified files have 0 TypeScript errors

**Test Strategy**:

- Manual: Open /arch, test all animated transitions in browser
- Manual: Profile with DevTools Performance tab, verify 60fps
- Manual: Test phase transitions (INTERVIEW → BLUEPRINT → BUILD → CREATE)
- Manual: Run Lighthouse, verify CLS = 0
- Unit: N/A (animation testing requires browser)
- Integration: N/A

**Rollback**: Revert commit — animations are additive, removing them returns to instant transitions

---

### Phase 4: Onboarding & Guidance

**Goal**: First-time users understand what to do, how to proceed, and see clear guidance

**Tasks**:

4.1. Replace welcome message with enhanced welcome screen (`page.tsx:340-350`)

- Replace existing `messages.length === 0` block
- Add glow effect behind icon: `<div className="absolute inset-0 bg-accent/10 rounded-3xl blur-xl" />`
- Add 3 guide cards in grid: Describe, Design, Deploy
- Each card: emoji icon, title, description
- Add 3 suggestion chips below cards: "Customer Support", "Appointment Booking", "Lead Qualification"
- Wire chip onClick to `handleChatBarSend` with pre-filled prompts

  4.2. Add template prompt examples

- "Build a customer support agent for e-commerce" → chip 1
- "Create an appointment booking system" → chip 2
- "Help me build a lead qualification agent" → chip 3
- Ensure `handleChatBarSend` is defined and wired (should already exist in page.tsx)

  4.3. Add empty state placeholders to artifact tabs (`OnboardingArtifactPanel.tsx:96-100`)

- Specification tab empty: "Your project details will appear here as we chat"
- Topology tab empty: "Agent architecture will be visualized here"
- Journal tab empty: "All design decisions are recorded here"
- Add to TabContent component per tab type

  4.4. Add phase progress tooltips (optional — if time permits)

- Add `title` attributes to phase dots in ArchShell or page header
- "Interview: Gather requirements", "Blueprint: Design architecture", "Build: Generate code", "Create: Deploy project"
- Animate current phase dot with pulse

  4.5. Verify onboarding flow

- New user sees welcome cards and chips
- Clicking chip sends prompt and starts conversation
- Artifact panel appears after first spec field is captured (existing behavior, verify not broken)
- Empty artifact tabs show helpful text

**Files Touched**:

- `apps/studio/src/app/arch/page.tsx` — enhanced welcome screen
- `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx` — empty state placeholders

**Exit Criteria**:

- [ ] New user sees 3-step guide cards (Describe, Design, Deploy) on first load
- [ ] 3 template chips visible below guide cards
- [ ] Clicking "Customer Support" chip sends pre-filled prompt
- [ ] Clicking "Appointment Booking" chip sends pre-filled prompt
- [ ] Clicking "Lead Qualification" chip sends pre-filled prompt
- [ ] Specification tab (empty) shows placeholder text
- [ ] Topology tab (empty) shows placeholder text
- [ ] Journal tab (empty) shows placeholder text
- [ ] Artifact panel still appears after first spec field captured (existing behavior)
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] All modified files have 0 TypeScript errors

**Test Strategy**:

- Manual: Open /arch with fresh session, verify welcome screen renders
- Manual: Click each template chip, verify prompt sent
- Manual: Verify empty artifact tabs show placeholders
- Manual: Complete interview flow, verify artifact panel appears after first question
- Unit: N/A (UI-only)
- Integration: N/A

**Rollback**: Revert commit — welcome screen is standalone, no dependencies

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

**Phase 1: Navigation**

- [x] Link component imported from next/link (already exists in Next.js)
- [x] ArrowLeft icon imported from lucide-react (package already used)
- [x] Back button links to `/projects` route (route already exists)
- [x] Phase state accessed from `phase` variable (already exists in page.tsx)
- [ ] Verify no broken imports after build

**Phase 2: Design Tokens**

- [x] Semantic token classes available in Tailwind config (already configured)
- [x] No new imports required — Tailwind classes only
- [ ] Verify no CSS purge removes semantic classes

**Phase 3: Animations**

- [x] framer-motion installed (v12.31.0 confirmed)
- [ ] Import `motion`, `AnimatePresence`, `LayoutGroup` in each file
- [ ] Verify AnimatePresence mode="wait" prevents exit/enter overlap
- [ ] Verify LayoutGroup doesn't break existing layout logic

**Phase 4: Onboarding**

- [x] ArchIcon component already imported in page.tsx
- [x] handleChatBarSend function already exists in page.tsx
- [ ] Verify template prompts match system prompt expectations
- [ ] Verify empty state text doesn't overlap with existing content

**No new routes, API endpoints, database models, or middleware.**

---

## 5. Cross-Phase Concerns

### Database Migrations

None — this is a frontend-only polish sprint.

### Feature Flags

None — changes are non-destructive, no need for feature flags.

### Configuration Changes

None — no new env vars or config keys.

### Dependencies

- framer-motion v12.31.0+ (already installed)
- No other new dependencies

### Performance Considerations

- **Animation frame budget**: 16ms per frame for 60fps
- **Mitigation**: Use `transform` and `opacity` only (GPU-accelerated), avoid animating `width`/`height` directly
- **LayoutGroup caveat**: Framer Motion's `layout` prop uses FLIP technique, which is 60fps for most cases but can struggle with >10 elements
- **Profiling required**: If jank detected, add `will-change: transform` or downgrade to CSS transitions

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] Navigation: Back button works, no layout breaks
- [ ] Design tokens: No hardcoded Tailwind palette colors remain (verified by grep)
- [ ] Animations: All transitions smooth at 60fps (verified by DevTools Performance)
- [ ] Onboarding: Welcome screen with guide cards and template chips
- [ ] No regressions in existing tests (if any exist for arch-v3 components)
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Manual browser testing in Chrome, Safari, Firefox
- [ ] Figma design brief alignment verified (colors, transitions, onboarding flow)

---

## 7. Testing Strategy

### Manual Browser Testing (Primary)

UX polish requires human verification — automated tests cannot catch visual/interaction issues.

**Test scenarios per phase**:

| Phase | Scenario                                        | Expected Result                   |
| ----- | ----------------------------------------------- | --------------------------------- |
| 1     | Click back button from /arch                    | Navigates to /projects            |
| 1     | View phase indicator during INTERVIEW           | Shows "Phase: Interview"          |
| 1     | Scroll chat messages with header present        | No overlap, scrolling works       |
| 2     | Compare screenshots before/after                | Colors identical                  |
| 2     | Toggle dark mode (if exists)                    | Semantic tokens adapt correctly   |
| 3     | Open in-project overlay                         | Slides in from right in 200ms     |
| 3     | Switch artifact tabs                            | Fades/slides in 150ms             |
| 3     | Complete phase transition (INTERVIEW→BLUEPRINT) | Smooth panel width morph in 300ms |
| 3     | Profile with DevTools Performance               | 60fps, no frames >16ms            |
| 4     | Load /arch with fresh session                   | Welcome cards visible             |
| 4     | Click "Customer Support" chip                   | Sends pre-filled prompt           |
| 4     | View empty Specification tab                    | Shows placeholder text            |

### Automated Testing (Secondary)

- **Grep validation**: Verify no hardcoded colors remain (Phase 2 exit criteria)
- **TypeScript compilation**: `pnpm build --filter=studio` must succeed
- **Lighthouse CI** (if configured): CLS = 0, no layout shift

### Cross-Browser Testing

- Chrome (primary)
- Safari (secondary)
- Firefox (secondary)
- Edge (optional)

### Performance Benchmarks

- **Frame rate**: 60fps during all animations (measure with DevTools Performance)
- **CLS**: 0 (no layout shift)
- **TTI**: No change from baseline (animations don't block interaction)

---

## 8. Risk Assessment

| Risk                                    | Likelihood | Impact | Mitigation                                                     |
| --------------------------------------- | ---------- | ------ | -------------------------------------------------------------- |
| Animation jank on low-end devices       | Medium     | High   | Profile on slow CPU throttle (6x), add `will-change` if needed |
| Design token migration breaks dark mode | Low        | Medium | Test dark mode after Phase 2, revert if broken                 |
| LayoutGroup breaks existing layout      | Low        | High   | Test all 4 phases, revert to CSS transitions if breaks         |
| framer-motion bundle size bloat         | Low        | Low    | Tree-shaking enabled, lazy-load motion components              |
| Navigation header breaks scroll         | Low        | Medium | Test on small viewports, adjust flex layout if needed          |
| Welcome cards too verbose on mobile     | Medium     | Low    | Defer mobile responsive to Phase 6 (optional)                  |

---

## 9. Open Questions

1. **Dark mode**: Does Studio have a dark mode? If yes, need to test semantic tokens in both themes.
   - _Resolution_: Test in browser, if dark mode exists, verify after Phase 2.

2. **Phase progress bar**: Does a phase progress bar already exist? If yes, should we enhance it or leave as-is?
   - _Resolution_: Phase 4 task 4.4 is optional — skip if time-constrained.

3. **Mobile responsive**: Are we targeting mobile browsers in v1.0?
   - _Resolution_: No — Phase 6 is optional, defer to v1.1.

4. **Animation preferences**: Should we respect `prefers-reduced-motion` media query?
   - _Resolution_: Yes — framer-motion respects it by default, no extra code needed.

---

## 10. Implementation Notes

### Phase Sequencing

Phases MUST be executed in order 1 → 2 → 3 → 4:

- Phase 1 (Navigation) is foundational, low-risk
- Phase 2 (Design Tokens) prepares colors for Phase 3 (uses semantic tokens in animations)
- Phase 3 (Animations) builds on stable layout from Phase 1
- Phase 4 (Onboarding) is additive on top of polished UI

### Commit Strategy

- **4 commits total** (1 per phase)
- Each commit message: `[ABLP-XXX] <type>(arch): <description>`
- Types: `feat` (Phase 1, 3, 4), `refactor` (Phase 2)
- Run `npx prettier --write <files>` before each commit (CLAUDE.md requirement)
- Run `pnpm build --filter=studio` before each commit (catch errors early)

### Browser Verification Gates

After EACH commit:

1. Open /arch in browser (not just tsc)
2. Manually test the phase's acceptance criteria
3. If any criterion fails, fix before proceeding to next phase

### Performance Profiling

Only in Phase 3:

- Open DevTools → Performance tab → Start recording
- Perform all animated actions (overlay open, tab switch, phase transition)
- Stop recording, check flame chart for frames >16ms
- If jank detected:
  - Add `will-change: transform` to animated elements
  - Or downgrade to CSS transitions (remove framer-motion)

### Rollback Strategy

Each phase is independently revertable:

- Phase 1: `git revert <commit-hash>` — navigation header removed
- Phase 2: `git revert <commit-hash>` — colors revert to hardcoded
- Phase 3: `git revert <commit-hash>` — animations removed, instant transitions return
- Phase 4: `git revert <commit-hash>` — welcome screen reverts to simple message

---

## 11. Success Metrics

| Metric                  | Baseline               | Target                 | Measurement                                  |
| ----------------------- | ---------------------- | ---------------------- | -------------------------------------------- |
| Time-to-first-message   | ~20s (user exploring)  | <5s (clear CTA)        | Time from /arch load to first message sent   |
| Navigation abandonment  | Unknown                | 0%                     | Users no longer trapped, can navigate freely |
| Perceived polish (1-10) | 6 (prototype feel)     | 9 (production feel)    | Qualitative user feedback                    |
| Animation frame rate    | N/A (instant)          | 60fps (smooth)         | DevTools Performance profiler                |
| Design token compliance | 0% (9 files hardcoded) | 100% (all semantic)    | Grep validation                              |
| User confusion          | High (no guidance)     | Low (clear onboarding) | Support ticket volume                        |

---

## 12. Post-Implementation

After all 4 phases complete:

1. **Run full manual test suite** (see Section 7)
2. **Capture before/after videos** for documentation
3. **Update `docs/arch/design/ux-polish-sprint.md`** with status: COMPLETE
4. **Log learnings** to `apps/studio/agents.md`:
   - Animation patterns that worked well
   - Design token migration gotchas
   - framer-motion best practices for this codebase
5. **Run `/compact`** to clear conversation context before next task
6. **Optional**: Create Phase 5 (Microinteractions) or Phase 6 (Responsive) tickets for future work

---

## Appendix A: File Line References

Quick reference for exact line numbers (as of 2026-04-05):

| File                                                                    | Line    | Change                                   |
| ----------------------------------------------------------------------- | ------- | ---------------------------------------- |
| `apps/studio/src/app/arch/page.tsx`                                     | 539     | Add navigation header wrapper            |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`            | 271     | `bg-purple/10` → `bg-accent/5`           |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`            | 245     | `bg-purple` → `bg-accent`                |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx`            | 259-266 | Wrap in motion.div                       |
| `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx` | 118     | `border-b-purple` → `border-b-accent`    |
| `apps/studio/src/components/arch-v3/panels/OnboardingArtifactPanel.tsx` | 168     | Wrap TabContent in AnimatePresence       |
| `apps/studio/src/components/arch-v3/layout/ArchShell.tsx`               | 32      | Wrap in LayoutGroup                      |
| `apps/studio/src/app/arch/page.tsx`                                     | 340-350 | Replace welcome message with guide cards |

---

**Status**: DRAFT — ready for audit rounds

**Next Step**: Run lld-reviewer audit (5 rounds minimum)
