# LLD: Gradient Design Tokens — Test Implementation

**Feature Spec**: `docs/features/gradient-design-tokens.md`
**HLD**: `docs/specs/gradient-design-tokens.hld.md`
**Test Spec**: `docs/testing/gradient-design-tokens.md`
**Status**: DONE
**Date**: 2026-03-22

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                        | Rationale                                                                                           | Alternatives Rejected                            |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| D-1 | Two phases: integration first, E2E second       | Integration tests (vitest + fs) have zero infra deps; E2E (Playwright) needs running Studio         | Single phase — riskier, harder to debug failures |
| D-2 | CSS parsing via `fs.readFileSync` + regex       | Proven pattern in `wiring.test.ts`; no DOM/browser needed                                           | PostCSS AST parser — overkill for assertions     |
| D-3 | I-6 (barrel exports) in studio integration file | Test spec places all integration tests in `gradient-tokens.test.ts`; tests the consumer perspective | In design-tokens package — doesn't test wiring   |
| D-4 | E2E uses Dev Login flow + project pages         | Gradient elements are on project pages (sidebar, ArchPanel); preview page only has `surface-page`   | Preview page only — insufficient coverage        |
| D-5 | Skeleton E2E via API route interception         | Skeleton elements flash too quickly; intercepting agent list API gives reliable visibility          | waitForSelector with short timeout — flaky       |

---

## 2. File-Level Change Map

### New Files

| File                                                | Purpose                                                    |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `apps/studio/src/__tests__/gradient-tokens.test.ts` | Integration tests I-1 through I-7 (CSS parsing + exports)  |
| `apps/studio/e2e/gradient-tokens.spec.ts`           | E2E tests E2E-1 through E2E-5 (Playwright computed styles) |

### Modified Files

| File                                      | Change Description                                    | Risk |
| ----------------------------------------- | ----------------------------------------------------- | ---- |
| `docs/testing/gradient-design-tokens.md`  | Update coverage matrix ✅, status IN PROGRESS→PARTIAL | Low  |
| `docs/features/gradient-design-tokens.md` | Update §17 test status, evaluate ALPHA→BETA           | Low  |

---

## Phase 1: Integration Tests (I-1 through I-7)

**Goal**: Create `apps/studio/src/__tests__/gradient-tokens.test.ts` with 7 integration test scenarios that verify the CSS token layer and package exports via file-system parsing.

**Tasks**:

1.1. Create `gradient-tokens.test.ts` with helper to read `globals.css` via `fs.readFileSync` using the `import.meta.dirname` pattern from `wiring.test.ts`.

1.2. Implement I-1: Parse `:root` block, extract `--gradient-*` declarations, assert all 14 expected tokens present.

1.3. Implement I-2: Parse `[data-theme='light']` block, extract `--gradient-*` declarations, assert count matches `:root` count and all token names match.

1.4. Implement I-3: Parse `@layer utilities` section, verify utility classes reference correct `var(--gradient-*)` vars. Check `.bg-gradient-brand`, `.text-gradient-brand` (with `background-clip`), `.border-gradient-brand`, `.bg-gradient-surface-panel`, `.bg-gradient-status-success`, `.gradient-glow-accent`.

1.5. Implement I-4: Within the `@layer utilities` section, grep for hardcoded `linear-gradient(` or `radial-gradient(` NOT inside `var()` calls. Assert zero matches.

1.6. Implement I-5: Use `fs` to recursively read `apps/studio/src/components/` and `apps/studio/src/app/` for `bg-gradient-to-` combined with `from-` on the same line. Exclude test files and globals.css. Assert zero matches.

1.7. Implement I-6: Import `{ getGradientStyles, getGradientValue, GRADIENT_TOKENS }` from the barrel `../../packages/design-tokens/src/index` (or `@agent-platform/design-tokens` if path alias resolves). Assert each is defined and correct type.

1.8. Implement I-7: Search `globals.css` for `prefers-reduced-motion` block containing `.skeleton` with `animation: none` override.

**Files Touched**:

- `apps/studio/src/__tests__/gradient-tokens.test.ts` — NEW (all 7 integration tests)

**Exit Criteria**:

- [ ] `pnpm test --filter=@agent-platform/studio -- --run gradient-tokens` passes with 7+ tests green
- [ ] `pnpm build --filter=@agent-platform/design-tokens` succeeds
- [ ] All 14 gradient token names verified in both `:root` and `[data-theme='light']`
- [ ] Zero hardcoded gradients in utility classes
- [ ] Zero inline Tailwind gradients in components

**Test Strategy**:

- These ARE the integration tests — they parse CSS source files and verify structure

**Rollback**: Delete `gradient-tokens.test.ts`

---

## Phase 2: E2E Tests (E2E-1 through E2E-5)

**Goal**: Create `apps/studio/e2e/gradient-tokens.spec.ts` with 5 E2E scenarios using Playwright to verify gradient tokens render correctly in a real browser.

**Tasks**:

2.1. Create `gradient-tokens.spec.ts` with a `beforeEach` that performs Dev Login (pattern from `tools.spec.ts`).

2.2. Implement E2E-1: Navigate to project dashboard, query elements with gradient classes (`.sidebar-bg` or sidebar with gradient background), assert `window.getComputedStyle(el).backgroundImage` contains `linear-gradient` (not `none`).

2.3. Implement E2E-2: Toggle theme to light via `document.documentElement.setAttribute('data-theme', 'light')`, re-query gradient elements, assert `backgroundImage` is still a gradient (with different values).

2.4. Implement E2E-3: Take screenshot in dark theme, toggle to light, take screenshot after transition, assert no white flash (compare pixel stability).

2.5. Implement E2E-4: Navigate to agent card grid, hover over a card, verify the `::before` pseudo-element or `borderImage` has gradient. Verify `borderRadius > 0` on the card.

2.6. Implement E2E-5: Use `page.emulateMedia({ reducedMotion: 'reduce' })`, intercept agent API to delay response (show skeletons), assert `.skeleton` element has `animation: none` or `animationName: none`. Then disable reduced-motion emulation and assert animation is active.

**Files Touched**:

- `apps/studio/e2e/gradient-tokens.spec.ts` — NEW (5 E2E tests)

**Exit Criteria**:

- [ ] `npx playwright test gradient-tokens` passes with 5 tests green (requires Studio running at localhost:5173)
- [ ] E2E-1 and E2E-2 verify actual computed gradient values
- [ ] E2E-5 confirms reduced-motion gate works at runtime

**Test Strategy**:

- These ARE the E2E tests — real browser, real CSS rendering, real computed styles
- Requires Studio dev server running at localhost:5173

**Rollback**: Delete `gradient-tokens.spec.ts`

---

## Phase 3: Doc Sync

**Goal**: Update test spec and feature spec to reflect actual test coverage.

**Tasks**:

3.1. Update `docs/testing/gradient-design-tokens.md` coverage matrix with ✅ for all implemented tests.

3.2. Update `docs/features/gradient-design-tokens.md` §17 test status.

3.3. Evaluate ALPHA→BETA status transition (requires 3+ E2E and 3+ integration tests passing).

**Exit Criteria**:

- [ ] Coverage matrix reflects actual test file existence
- [ ] Status fields consistent across all docs

**Rollback**: Revert doc changes

---

## 4. Wiring Checklist

- [ ] `gradient-tokens.test.ts` is in `apps/studio/src/__tests__/` (vitest auto-discovers)
- [ ] `gradient-tokens.spec.ts` is in `apps/studio/e2e/` (Playwright testDir)
- [ ] No new packages or dependencies required
- [ ] No new exports or registrations needed

## 5. Acceptance Criteria (Whole Feature)

- [ ] Integration tests I-1 through I-7 passing (7+ tests)
- [ ] E2E tests E2E-1 through E2E-5 passing (5 tests, requires Studio running)
- [ ] Unit tests still passing (15/15 in design-tokens)
- [ ] Test spec coverage matrix updated with actual ✅/❌
- [ ] Feature status evaluated for BETA promotion
- [ ] `pnpm build` succeeds for all affected packages
