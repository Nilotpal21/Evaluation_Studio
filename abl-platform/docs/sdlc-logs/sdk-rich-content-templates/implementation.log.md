# SDLC Log: SDK Rich Content Templates — Implementation Phase

**Feature**: sdk-rich-content-templates
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-03-24-sdk-rich-content-templates-impl-plan.md`
**Date Started**: 2026-03-25
**Date Completed**: 2026-03-25 (base rollout) / 2026-04-16 (parity remediation slices 1-4 committed; slice 5 complete in current worktree)

---

## Preflight

- [x] LLD file paths verified
- [x] Function signatures current
- [x] No conflicting recent changes
- Discrepancies: none

## Phase Execution

### LLD Phase 1: Registry Infrastructure + isSafeUrl Extraction

- **Status**: DONE
- **Commit**: `0b43f886e`
- **Exit Criteria**: all met
- **Deviations**: none
- **Files Changed**: 5 (registry.ts, types.ts, isSafeUrl.ts, template-registry.test.ts, template-safe-url.test.ts)

### LLD Phase 2: Template Types, Renderers, and Tests

- **Status**: DONE
- **Commit**: `827fab608`
- **Exit Criteria**: all met
- **Deviations**: none
- **Files Changed**: 18 (13 renderer files, types, utils/strings.ts, chart-colors.ts, tests)

### LLD Phase 3: Backend Schema and Interpolation

- **Status**: DONE
- **Commit**: `1968b845b`
- **Exit Criteria**: all met
- **Deviations**: none
- **Files Changed**: 6 (compiler rich-content schema, runtime value-resolution, tests)

### LLD Phase 4: Studio Catalog and Web-SDK Rename

- **Status**: DONE
- **Commit**: `5c1787124`
- **Exit Criteria**: all met (except Studio component tests from Task 4.11 — deferred)
- **Deviations**: Studio component tests (template-catalog-page.test.tsx, template-insert-panel.test.tsx, template-preview.test.tsx) not created — deferred to follow-up
- **Files Changed**: 12 (TemplateCatalogPage.tsx, TemplateInsertPanel.tsx, TemplateMockProvider.tsx, TemplateDSLView.tsx, i18n keys, catalog data)

### LLD Phase 5: Documentation Updates

- **Status**: DONE
- **Commit**: `48962456b`
- **Exit Criteria**: all met
- **Deviations**: none
- **Files Changed**: 2 (LLD references updated to @agent-platform/web-sdk)

## Wiring Verification

- [x] Template renderers self-register via side-effect imports in index.ts
- [x] RichContent React dispatcher wired to defaultRegistry
- [x] rich-renderer.ts DOM dispatcher wired to defaultRegistry
- [x] Studio catalog entries wired to TemplateCatalogPage
- [x] TemplateInsertPanel wired to SlidePanel
- [x] i18n keys added to en/studio.json under "templates" namespace
- [x] Core types barrel-exported from packages/core/src/types/index.ts
- Missing wiring found: none

## Review Rounds

| Round | Focus                     | Verdict                | Critical                             | High                                         | Medium                              | Low |
| ----- | ------------------------- | ---------------------- | ------------------------------------ | -------------------------------------------- | ----------------------------------- | --- |
| 1     | UX/UI audit               | NEEDS_REVISION → fixed | 1 (TemplateInsertPanel → SlidePanel) | 2                                            | 1                                   | 0   |
| 2     | Completeness + E2E wiring | NEEDS_REVISION → fixed | 0                                    | 2 (i18n catalog, core barrel exports)        | 2                                   | 0   |
| 3     | HLD compliance + security | NEEDS_REVISION → fixed | 0                                    | 2 (table interpolation, error boundaries)    | 3                                   | 0   |
| 4     | Production readiness      | NEEDS_REVISION → fixed | 0                                    | 3 (feedback cap, form a11y, data point caps) | 2                                   | 0   |
| 5     | Final acceptance          | APPROVED               | 0                                    | 0                                            | 1 (Studio component tests deferred) | 0   |

### Round 1 Fixes (commit `2f1d0c6dc`)

- Rewrote TemplateInsertPanel to use SlidePanel instead of raw AnimatePresence/motion.div
- Replaced Tailwind color classes with semantic design tokens in TemplateMockProvider
- Replaced emoji with Lucide icons (Paperclip, ThumbsUp, ThumbsDown, Star, Play, Music)

### Round 2 Fixes (commit `91262d4d3`)

- Added i18n keys for all 15 template types (name + description) in studio.json
- Wired catalog entries to use `t(`type\_${entry.type}\_name`)` dynamic keys
- Added barrel re-exports for 14 AST types in packages/core/src/types/index.ts

### Round 3 Fixes (commit `c639a7dea`)

- Fixed table row interpolation: iterate entries, only interpolate string values, pass through numerics
- Added ChartErrorBoundary wrapping React.Suspense for chart lazy-loading
- Added try/catch around renderer dispatch in registry.match(), RichContent.tsx, rich-renderer.ts
- Added getString() i18n for 17 aria-label keys across all renderers

### Round 4 Fixes (commit `49eb3ce13`)

- Added MAX_ALLOWED=20 cap on feedback scale items
- Added MAX_DATA_POINTS=100 cap on chart data in both React and DOM renderers
- Added htmlFor/id linkage on form labels in both React and DOM paths
- Extracted shared DEFAULT_COLORS to chart-colors.ts to eliminate duplication
- Fixed clipboard handling in TemplateDSLView (cleanup timer on unmount)

### Deferred Findings

- Broader browser/widget scenario coverage for KPI, media, forms, charts, and quick replies still needs dedicated regressions beyond the current fallback + ActionSet lane
- Richer parser/compiler authoring support beyond `FORMATS:`, `CAROUSEL:`, and the current `ACTIONS:` subset still needs follow-on work
- Studio preview still uses a simplified mock-provider approximation instead of the live runtime renderer for every payload type

## Acceptance Criteria

- [x] All LLD phases complete (5/5 base rollout) and the parity-remediation follow-on slices are complete in the current worktree
- [x] Rollout tests still pass (115/115) and the parity-remediation follow-on adds 30 targeted tests/regressions
- [x] Studio component tests from LLD Task 4.11 now exist and pass
- [x] The `/rich-template` command dispatch path now has dedicated automated coverage
- [x] Isolated browser E2E regressions now cover the runtime → transport → SDK widget fallback path plus ActionSet button/select round-trips
- [ ] Broader browser/widget scenario coverage still needs follow-on work
- [ ] Richer parser/compiler authoring support still needs follow-on work
- [x] No regressions (pnpm build passes across 5 packages)
- [x] All 12 template types flow through compiler → runtime → web-sdk
- [x] i18n support via getString()/setStrings() in web-sdk, next-intl in Studio
- [x] Security: isSafeUrl validation, XSS-safe rendering, defensive error boundaries

## Test Coverage Summary

| Layer             | Coverage                                                                                       | Status |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------ |
| Base rollout      | 115 dedicated rollout tests across web-sdk, compiler, and runtime                              | ✅     |
| Web SDK follow-on | +7 parity regressions (`template-renderers`, `rich-renderer*`, React)                          | ✅     |
| Runtime follow-on | +5 parity regressions (`outcome`, `ws-sdk-handler`, `chat-routes`)                             | ✅     |
| Studio follow-on  | +15 component/command tests (`template-catalog*`, `template-preview`, ABL editor command flow) | ✅     |
| Browser follow-on | +3 isolated widget regressions (`apps/studio/e2e/sdk-widget.spec.ts`)                          | ✅     |
| **Total delta**   | **+30 parity-remediation tests/regressions on top of the 115 rollout**                         | **✅** |

## Post-Implementation Remediation (2026-04-16)

### Preflight

- [x] Existing feature/test/HLD/LLD artifacts re-read from disk
- [x] Runtime, web-sdk, and Studio target files verified at current `HEAD`
- [x] Recent local changes reviewed before editing; unrelated runtime worktree changes were left intact
- Discrepancies: unrelated runtime edits existed in the worktree, so parity-remediation changes were kept tightly scoped to the rich-content files and verified with targeted builds/tests

### Remediation Slice 1: Web SDK parity closure

- **Status**: DONE
- **Commit**: `8b5c22828`
- **Exit Criteria**: met
- **Files Changed**: `templates/support.ts`, `templates/utils/structured-preview.ts`, `renderers/channel-fallback.ts`, `templates/index.ts`, `index.ts`, `templates/utils/strings.ts`, `ui/rich-renderer.ts`, `renderers/actions.ts`, `renderers/form.ts`, `react/components/MessageList.tsx`, web-sdk regression tests

### Remediation Slice 2: Studio parity disclosure

- **Status**: DONE
- **Commit**: `8b5c22828`
- **Exit Criteria**: met
- **Files Changed**: `apps/studio/src/lib/template-catalog.ts`, `TemplatePreview.tsx`, `TemplateMockProvider.tsx`, `TemplateCatalogPage.tsx`, `packages/i18n/locales/en/studio.json`

### Remediation Slice 3: Runtime/channel normalization

- **Status**: DONE
- **Commit**: `aead716f6`
- **Exit Criteria**: met
- **Files Changed**: `apps/runtime/src/services/channel/outcome.ts`, `apps/runtime/src/services/channel/constants.ts`, `apps/runtime/src/services/channel/__tests__/outcome.test.ts`, `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`, `apps/runtime/src/__tests__/sessions/chat-routes.test.ts`

### Remediation Slice 4: Studio component coverage + browser regression

- **Status**: DONE
- **Commit**: `aead716f6`
- **Exit Criteria**: met
- **Files Changed**: `apps/studio/src/__tests__/template-catalog.test.ts`, `template-catalog-page.test.tsx`, `template-insert-panel.test.tsx`, `template-preview.test.tsx`, `apps/studio/e2e/sdk-widget.spec.ts`, `apps/studio/e2e/helpers/sdk-browser-e2e.ts`, `apps/studio/e2e/helpers/sdk-browser-stack.ts`

### Remediation Slice 5: Studio authoring disclosure + action browser coverage

- **Status**: DONE (local, uncommitted)
- **Commit**: none yet
- **Exit Criteria**: met
- **Files Changed**: `apps/studio/src/lib/template-catalog.ts`, `apps/studio/src/components/templates/TemplateInsertPanel.tsx`, `apps/studio/src/components/templates/TemplateCatalogPage.tsx`, `packages/i18n/locales/en/studio.json`, `apps/studio/src/__tests__/template-catalog.test.ts`, `apps/studio/src/__tests__/template-catalog-page.test.tsx`, `apps/studio/src/__tests__/template-insert-panel.test.tsx`, `apps/studio/src/__tests__/abl-editor-rich-template-command.test.tsx`, `apps/studio/e2e/sdk-widget.spec.ts`, `apps/studio/e2e/helpers/sdk-browser-e2e.ts`, `apps/studio/src/lib/ensure-db.ts`, `apps/studio/src/__tests__/lib-sso.test.ts`, `packages/web-sdk/src/ui/rich-renderer.ts`, `packages/web-sdk/src/__tests__/rich-renderer-dom.test.ts`

### Verification

- `pnpm build --filter=@agent-platform/runtime` ✅
- `pnpm build --filter=@agent-platform/web-sdk` ✅
- `pnpm build --filter=@agent-platform/studio` ✅
- `pnpm exec vitest run src/services/channel/__tests__/outcome.test.ts src/__tests__/channels/ws-sdk-handler.test.ts` (in `apps/runtime`) ✅
- `pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/sessions/chat-routes.test.ts` (in `apps/runtime`) ✅
- `pnpm exec vitest run src/__tests__/template-renderers.test.ts src/__tests__/react-components.test.tsx` (in `packages/web-sdk`) ✅
- `pnpm exec vitest run src/__tests__/template-catalog.test.ts src/__tests__/template-catalog-page.test.tsx src/__tests__/template-insert-panel.test.tsx src/__tests__/template-preview.test.tsx` (in `apps/studio`) ✅
- `SDK_BROWSER_E2E_ISOLATED=true SDK_BROWSER_E2E_STRICT=true pnpm exec playwright test e2e/sdk-widget.spec.ts --config=e2e-playwright.config.ts --grep "channel-native rich content fallback"` (in `apps/studio`) ✅
- `pnpm build --filter=@agent-platform/web-sdk` ✅
- `pnpm build --filter=@agent-platform/studio` ✅
- `pnpm exec vitest run src/__tests__/rich-renderer-dom.test.ts` (in `packages/web-sdk`) ✅
- `pnpm exec vitest run src/__tests__/lib-sso.test.ts src/__tests__/abl-editor-rich-template-command.test.tsx src/__tests__/template-catalog.test.ts src/__tests__/template-catalog-page.test.tsx src/__tests__/template-insert-panel.test.tsx src/__tests__/template-preview.test.tsx` (in `apps/studio`) ✅
- `SDK_BROWSER_E2E_ISOLATED=true SDK_BROWSER_E2E_STRICT=true pnpm exec playwright test e2e/sdk-widget.spec.ts --config=e2e-playwright.config.ts` (in `apps/studio`) ✅

## Learnings

- **SlidePanel reuse**: Studio's SlidePanel provides focus trap, Escape, aria-modal out of the box — always prefer it over raw AnimatePresence for slide-over panels
- **Semantic tokens**: Use `text-success`, `text-error`, `bg-accent` — never raw Tailwind colors like `text-green-500`
- **getString() pattern**: web-sdk i18n uses a simple `Record<string, string>` with `getString(key)` / `setStrings(overrides)` — lightweight and framework-agnostic
- **Error boundary for lazy loading**: Chart renderer needs class-based ErrorBoundary wrapping Suspense to handle network failures gracefully
- **Defensive dispatch**: Wrap both extract() and render()/renderDOM() in try/catch so one failing renderer doesn't crash the entire rich content display
- **Pre-existing test issue**: web-sdk DOM tests fail when run from repo root due to happy-dom environment not being picked up — must run from `packages/web-sdk/` directory
- **Assistant action rendering must stay single-path**: `MessageList` should hand assistant `actions` and `richContent + actions` messages to `RichContent`, not render a second `ActionHandler`, or the React path will drift from the registry and duplicate controls.
- **Support metadata needs to be surfaced, not just stored**: once Studio derives support modes from `RICH_CONTENT_SUPPORT_SPECS`, the catalog UI should expose those badges or authors cannot tell whether a preview is native, fallback, or limited.
- **Runtime normalization belongs in the shared outcome seam**: `buildExecutionOutcome()` is the right place to synthesize fallback text for web-facing surfaces, because both websocket and HTTP chat handlers consume it.
- **Keep structured preview extraction aligned across runtime and SDK**: the runtime summary extractor in `apps/runtime/src/services/channel/outcome.ts` should stay behaviorally aligned with `packages/web-sdk/src/templates/utils/structured-preview.ts` or fallback text will drift across surfaces.
- **Isolated widget browser runs need extra runtime wiring**: the Studio Playwright stack needs `RUNTIME_PUBLIC_BASE_URL`, a valid `ENCRYPTION_MASTER_KEY`, and `ALLOW_INMEMORY_AUTH_GATE_STATE_STORE=true` when Redis is disabled, or auth preflight blocks the widget before `ON_START`.
- **Current ABL rich-content authoring is narrower than catalog preview support**: slash-insertable DSL support currently maps to `FORMATS:`, `CAROUSEL:`, and the current `ACTIONS:` subset, so Studio should disclose `supported` / `partial` / `preview_only` authoring modes separately from web preview support.
- **Isolated Studio startup must reattach the DEK facade/resolver after `initDEKFacade()`**: `apps/studio/src/lib/ensure-db.ts` needs to call `setEncryptionFacade(dek.facade)` and `setGlobalKMSResolver(dek.resolver)` in the same module context used by encrypted models, or isolated `dev-login` flows fail with "encrypted fields require the DEK facade."
- **Legacy DOM widget rendering must preserve assistant prompt text for non-text structured payloads**: when `actions` or channel-fallback renderers match, `renderRichMessage()` still needs to emit the plain-text `message.content` block unless markdown/html already own the text body.
