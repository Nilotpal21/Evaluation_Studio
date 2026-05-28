# Test Spec: Gradient Design Tokens

**Feature**: Gradient Design Tokens (#75)
**Status**: PLANNED
**Created**: 2026-03-23
**Last Updated**: 2026-03-23

---

## Current State

| Metric          | Value       |
| --------------- | ----------- |
| E2E Tests       | 0           |
| Integration     | 0           |
| Unit Tests      | 0           |
| Visual Regress. | 0           |
| Overall Health  | NOT STARTED |

## Health Dashboard

| Area                  | Status | Coverage |
| --------------------- | ------ | -------- |
| CSS Token Definitions | NONE   | 0%       |
| Tailwind Utility Gen  | NONE   | 0%       |
| Dark Theme Gradients  | NONE   | 0%       |
| Light Theme Gradients | NONE   | 0%       |
| Component Refactor    | NONE   | 0%       |
| Visual Regression     | NONE   | 0%       |

## Test Coverage Map

### 1. CSS Custom Property Tests (Unit)

These verify that gradient tokens are correctly defined and resolve to valid CSS values.

| Test Case                                                                      | Priority | Status  |
| ------------------------------------------------------------------------------ | -------- | ------- |
| UT-1: `:root` defines all 8 gradient composite tokens                          | P0       | PLANNED |
| UT-2: `:root` defines gradient color stop variables for each semantic gradient | P0       | PLANNED |
| UT-3: `[data-theme='light']` overrides all gradient composite tokens           | P0       | PLANNED |
| UT-4: Gradient tokens reference existing color tokens (not hardcoded HSL)      | P1       | PLANNED |
| UT-5: No orphaned gradient tokens (every defined token is consumed)            | P2       | PLANNED |

### 2. Tailwind Configuration Tests (Unit)

These verify that `packages/tailwind-config/base.js` correctly exposes gradient utilities.

| Test Case                                                               | Priority | Status  |
| ----------------------------------------------------------------------- | -------- | ------- |
| UT-6: `backgroundImage` config includes all gradient token references   | P0       | PLANNED |
| UT-7: Gradient utility class names follow `gradient-{semantic}` pattern | P1       | PLANNED |
| UT-8: Config is valid Tailwind v3 syntax (no runtime errors on build)   | P0       | PLANNED |

### 3. CSS Utility Class Refactor Tests (Integration)

These verify that existing utility classes in `globals.css` now consume tokens instead of hardcoded values.

| Test Case                                                                           | Priority | Status  |
| ----------------------------------------------------------------------------------- | -------- | ------- |
| IT-1: `.text-gradient` uses `var(--gradient-text-accent)` or references token stops | P0       | PLANNED |
| IT-2: `.arch-panel-bg` uses `var(--gradient-panel)`                                 | P0       | PLANNED |
| IT-3: `.sidebar-bg` uses `var(--gradient-sidebar)`                                  | P0       | PLANNED |
| IT-4: `.empty-state-glow::before` uses `var(--gradient-glow-radial)`                | P0       | PLANNED |
| IT-5: `.skeleton` shimmer gradient uses token stops                                 | P0       | PLANNED |
| IT-6: Light theme `.arch-panel-bg` override uses light gradient token               | P0       | PLANNED |
| IT-7: Light theme `.sidebar-bg` override uses light gradient token                  | P0       | PLANNED |
| IT-8: Light theme `.empty-state-glow::before` uses light gradient token             | P1       | PLANNED |

### 4. Build Verification Tests (Integration)

These verify that the Studio build succeeds and generates the expected CSS output.

| Test Case                                                          | Priority | Status  |
| ------------------------------------------------------------------ | -------- | ------- |
| IT-9: `pnpm build --filter=studio` completes without errors        | P0       | PLANNED |
| IT-10: Built CSS bundle contains gradient token custom properties  | P0       | PLANNED |
| IT-11: Built CSS bundle contains Tailwind gradient utility classes | P0       | PLANNED |
| IT-12: CSS bundle size delta is < 500 bytes compared to baseline   | P1       | PLANNED |
| IT-13: `tsc --noEmit` passes for all affected packages             | P0       | PLANNED |

### 5. Component Refactor Tests (Integration)

These verify that components using inline gradients are refactored to use semantic utilities.

| Test Case                                                                                                         | Priority | Status  |
| ----------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| IT-14: `ArchOnboarding.tsx` uses `bg-gradient-page-bg` instead of inline `from-background`                        | P1       | PLANNED |
| IT-15: `RevealPhase.tsx` CTA buttons use `bg-gradient-accent-cta` instead of inline `from-accent to-accent-muted` | P1       | PLANNED |
| IT-16: `ReviewPhase.tsx` CTA button uses semantic gradient utility                                                | P1       | PLANNED |
| IT-17: `DeployPanel.tsx` header uses semantic gradient utility                                                    | P1       | PLANNED |
| IT-18: `preview/page.tsx` full-page backgrounds use `bg-gradient-page-bg`                                         | P1       | PLANNED |
| IT-19: `preview/[projectId]/page.tsx` full-page backgrounds use `bg-gradient-page-bg`                             | P1       | PLANNED |

### 6. Visual Regression Tests (E2E)

These verify that the visual output is identical before and after the refactor. Tested via browser automation (Playwright).

| Test Case                                                                       | Priority | Status  |
| ------------------------------------------------------------------------------- | -------- | ------- |
| E2E-1: Arch panel background gradient matches baseline screenshot (dark theme)  | P0       | PLANNED |
| E2E-2: Arch panel background gradient matches baseline screenshot (light theme) | P0       | PLANNED |
| E2E-3: Sidebar gradient matches baseline screenshot (dark theme)                | P0       | PLANNED |
| E2E-4: Sidebar gradient matches baseline screenshot (light theme)               | P0       | PLANNED |
| E2E-5: `.text-gradient` renders identically to baseline (dark theme)            | P0       | PLANNED |
| E2E-6: `.text-gradient` renders identically to baseline (light theme)           | P0       | PLANNED |
| E2E-7: Skeleton loader shimmer effect matches baseline                          | P1       | PLANNED |
| E2E-8: Empty state glow matches baseline (dark theme)                           | P1       | PLANNED |
| E2E-9: Onboarding CTA button gradient matches baseline                          | P1       | PLANNED |
| E2E-10: Preview page background gradient matches baseline                       | P1       | PLANNED |

### 7. Theme Switching Tests (E2E)

These verify that gradients transition correctly when the theme changes.

| Test Case                                                               | Priority | Status  |
| ----------------------------------------------------------------------- | -------- | ------- |
| E2E-11: Switching from dark to light theme updates all gradient tokens  | P0       | PLANNED |
| E2E-12: Switching from light to dark theme restores all gradient tokens | P0       | PLANNED |
| E2E-13: Theme transition does not cause visual flash/FOUC on gradients  | P1       | PLANNED |

### 8. Accessibility Tests (E2E)

| Test Case                                                                          | Priority | Status  |
| ---------------------------------------------------------------------------------- | -------- | ------- |
| E2E-14: Gradient text maintains sufficient contrast ratio (WCAG AA) in dark theme  | P0       | PLANNED |
| E2E-15: Gradient text maintains sufficient contrast ratio (WCAG AA) in light theme | P0       | PLANNED |

## E2E Test Scenarios (Mandatory 5+)

All E2E tests use Playwright against a running Studio instance. No mocks, no direct CSS parsing in Node.

### E2E Scenario 1: Dark Theme Panel Gradients

**Setup**: Start Studio on a random port. Navigate to a page with the Arch panel visible.
**Steps**:

1. Open the Arch AI panel
2. Capture screenshot of the panel background area
3. Compare pixel-level against baseline screenshot (max 1% diff threshold)
   **Assertions**: Panel background gradient is visually identical to pre-refactor baseline.
   **Teardown**: Close browser.

### E2E Scenario 2: Light Theme Panel Gradients

**Setup**: Start Studio on a random port. Set theme to light via UI toggle.
**Steps**:

1. Toggle theme to light mode
2. Open the Arch AI panel
3. Capture screenshot of the panel background area
4. Compare against light-theme baseline screenshot
   **Assertions**: Light-theme gradient is visually identical to pre-refactor baseline.
   **Teardown**: Close browser.

### E2E Scenario 3: Gradient Text Rendering

**Setup**: Start Studio. Navigate to a page that uses `.text-gradient` class.
**Steps**:

1. Locate the gradient text element
2. Verify element has `background-clip: text` computed style
3. Capture screenshot of the text area
4. Compare against baseline
   **Assertions**: Gradient text is visually identical. Background-clip is applied.

### E2E Scenario 4: Theme Switch Gradient Transition

**Setup**: Start Studio in dark mode.
**Steps**:

1. Capture all gradient-containing elements in dark mode
2. Toggle to light mode
3. Wait for theme transition to complete (300ms per `.theme-transition`)
4. Capture all gradient-containing elements in light mode
5. Toggle back to dark mode
6. Capture again
   **Assertions**: Dark screenshots match each other. Light screenshots match light baselines. No intermediate broken states.

### E2E Scenario 5: Skeleton Loader Gradient

**Setup**: Start Studio. Navigate to a page that triggers a loading state (e.g., slow data fetch).
**Steps**:

1. Trigger a loading state
2. Verify `.skeleton` elements are present in DOM
3. Verify skeleton has `background-size: 200% 100%` computed style (shimmer)
4. Capture screenshot during loading
   **Assertions**: Skeleton shimmer gradient is visible and matches baseline.

### E2E Scenario 6: Build Output Verification

**Setup**: Run `pnpm build --filter=studio`.
**Steps**:

1. Verify build completes with exit code 0
2. Search built CSS output for `--gradient-panel`
3. Search built CSS output for `--gradient-text-accent`
4. Verify gradient Tailwind utilities are present in output
   **Assertions**: All gradient tokens are present in production CSS bundle.

### E2E Scenario 7: Accessibility — Gradient Text Contrast

**Setup**: Start Studio. Navigate to gradient text.
**Steps**:

1. Use Playwright `evaluate` to compute the effective text color vs background
2. Calculate contrast ratio
3. Verify >= 4.5:1 for normal text, >= 3:1 for large text (WCAG AA)
   **Assertions**: Gradient text passes WCAG AA contrast requirements.

## Integration Test Scenarios (Mandatory 5+)

### Integration Scenario 1: CSS Token Resolution Chain

**Test**: Parse `globals.css` after build and verify that gradient composite tokens resolve to valid CSS gradient functions.
**Method**: Read the built CSS, extract `--gradient-panel` value, verify it contains `linear-gradient(`.
**Assertions**: All 8 composite tokens resolve to valid gradient syntax.

### Integration Scenario 2: Tailwind Config Generates Utilities

**Test**: Import `packages/tailwind-config/base.js` and verify `theme.extend.backgroundImage` includes gradient entries.
**Method**: Dynamic import of the config, inspect the object structure.
**Assertions**: Config has entries for `gradient-panel`, `gradient-sidebar`, `gradient-text-accent`, etc.

### Integration Scenario 3: Token-to-Utility Wiring

**Test**: Verify that the Tailwind utilities reference the correct CSS custom properties.
**Method**: Build Studio CSS, grep for `.bg-gradient-panel` class, verify it contains `var(--gradient-panel)`.
**Assertions**: Each Tailwind gradient utility correctly references its corresponding CSS token.

### Integration Scenario 4: Light Theme Token Completeness

**Test**: For every gradient token defined in `:root`, verify a corresponding override exists in `[data-theme='light']`.
**Method**: Parse CSS, extract `:root` gradient tokens, verify each has a `[data-theme='light']` counterpart.
**Assertions**: No gradient token is missing its light-theme override.

### Integration Scenario 5: No Hardcoded Gradients in Utility Classes

**Test**: After refactor, verify that utility classes (`.text-gradient`, `.arch-panel-bg`, `.sidebar-bg`, `.empty-state-glow`, `.skeleton`) contain `var(--gradient-*)` references and no raw HSL gradient values.
**Method**: Regex scan of utility class definitions in globals.css.
**Assertions**: Zero hardcoded gradient HSL values in tokenized utility classes.

### Integration Scenario 6: CSS Bundle Size Delta

**Test**: Compare CSS bundle size before and after the refactor.
**Method**: Build Studio before changes (baseline), build after changes, compare file sizes.
**Assertions**: Delta is < 500 bytes (NFR-2).

### Integration Scenario 7: Component className Backward Compatibility

**Test**: Verify all existing gradient CSS class names (`.text-gradient`, `.arch-panel-bg`, `.sidebar-bg`, `.empty-state-glow`, `.skeleton`) still exist and are functional.
**Method**: Search built CSS for each class name.
**Assertions**: All original class names are still present — no breaking changes (NFR-5).

## Iteration Log

_No iterations yet. Feature is PLANNED._
