# KB Navigation Redesign — Pending Work

**Branch:** feat/kb-nav-redesign
**Last updated:** 2026-03-19

## Completed

- 4-tab KB navigation redesign (Home, Content, Intelligence, Settings)
- UX enterprise review: 42 bugs found and fixed
- Gap analysis: 13 issues found and fixed
- Test failures: 69 failures fixed (all passing)
- i18n sweep: 29 TSX files converted, 554 keys added to studio.json
- All `window.confirm`/`window.alert` replaced with ConfirmDialog/toast
- All module-level constants with English labels moved to `useMemo([t])`
- All hardcoded `'en-US'` locale references fixed to `undefined`

## Remaining Work

### P4: Enterprise UX Polish (out of scope for current PR)

These items were identified during the UX enterprise review but deferred as
lower priority. They improve accessibility and visual consistency but don't
affect functionality.

| Item                          | Files                                                          | Description                                                                                |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| WCAG contrast ratios          | Multiple components using `text-muted` on light bg             | Some muted text on light backgrounds may not meet WCAG AA 4.5:1 contrast ratio             |
| Focus-visible rings           | All interactive components                                     | Add `focus-visible:ring-2 focus-visible:ring-primary` to buttons, links, and form controls |
| Color-blind safe indicators   | `FeatureCard.tsx`, `SyncProgress.tsx`, status badges           | Add icons/patterns alongside color to convey status (not just red/green/yellow)            |
| SiteSelector design tokens    | `SiteSelector.tsx`                                             | Replace inline Tailwind colors with design system tokens for theme consistency             |
| Currency locale formatting    | `FeatureCard.tsx`, `ReindexConfirmDialog.tsx`                  | Use `Intl.NumberFormat` for cost display instead of string interpolation with `$`          |
| Shared `useStageTypeLabels()` | `PipelineCanvas.tsx`, `FlowDetail.tsx`, `StageConfigPanel.tsx` | Extract duplicated `stageTypeLabels` useMemo into a shared hook (refactor, not i18n)       |

### Pre-merge Checklist

- [ ] Run full test suite: `pnpm build && pnpm test`
- [ ] Verify no regressions in KB navigation flow (manual)
- [ ] Verify i18n keys render correctly (spot-check 5-10 screens)
- [ ] Squash or organize commits for clean PR history
- [ ] Push branch and create PR against `develop`
