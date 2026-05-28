# LLD + Implementation Plan: Gradient Design Tokens

**Feature**: Gradient Design Tokens (#75)
**Status**: PLANNED
**Author**: SDLC Pipeline
**Created**: 2026-03-23
**Last Updated**: 2026-03-23
**Feature Spec**: `docs/features/gradient-design-tokens.md`
**Test Spec**: `docs/testing/gradient-design-tokens.md`
**HLD**: `docs/specs/gradient-design-tokens.hld.md`

---

## Phase 1: Define Gradient Tokens in globals.css

**Goal**: Add gradient CSS custom properties to `:root` (dark) and `[data-theme='light']` blocks.

### 1.1 Add Gradient Token Section to `:root`

**File**: `apps/studio/src/app/globals.css`
**Location**: After the `ANIMATION TIMING` section (after line ~157), before the `shadcn/ui compatibility aliases` section (before line ~159).

Add the following new section:

```css
/* -------------------------------------------------------------------------
   GRADIENT TOKENS - Semantic gradient definitions
   Atomic stops for fine-grained override, composites for direct use.
   ------------------------------------------------------------------------- */

/* Panel gradient stops (Arch AI panel, vertical backgrounds) */
--gradient-stop-panel-start: var(--background-elevated);
--gradient-stop-panel-mid: 220 4% 10%;
--gradient-stop-panel-end: var(--background-elevated);

/* Sidebar gradient stops */
--gradient-stop-sidebar-start: 220 3% 8%;
--gradient-stop-sidebar-mid: var(--background-subtle);
--gradient-stop-sidebar-end: var(--background-subtle);

/* Accent gradient stops (text gradients, CTA buttons) */
--gradient-stop-accent-start: var(--accent);
--gradient-stop-accent-end: 220 5% 75%;

/* Skeleton shimmer stops */
--gradient-stop-skeleton-start: var(--background-muted);
--gradient-stop-skeleton-mid: var(--background-elevated);
--gradient-stop-skeleton-end: var(--background-muted);

/* Radial glow opacity */
--gradient-glow-opacity: 0.07;

/* Composite gradient tokens */
--gradient-panel: linear-gradient(
  180deg,
  hsl(var(--gradient-stop-panel-start)) 0%,
  hsl(var(--gradient-stop-panel-mid)) 50%,
  hsl(var(--gradient-stop-panel-end)) 100%
);

--gradient-sidebar: linear-gradient(
  180deg,
  hsl(var(--gradient-stop-sidebar-start)) 0%,
  hsl(var(--gradient-stop-sidebar-mid)) 30%,
  hsl(var(--gradient-stop-sidebar-end)) 100%
);

--gradient-text-accent: linear-gradient(
  135deg,
  hsl(var(--gradient-stop-accent-start)) 0%,
  hsl(var(--gradient-stop-accent-end)) 100%
);

--gradient-skeleton: linear-gradient(
  90deg,
  hsl(var(--gradient-stop-skeleton-start)) 0%,
  hsl(var(--gradient-stop-skeleton-mid)) 50%,
  hsl(var(--gradient-stop-skeleton-end)) 100%
);

--gradient-glow-radial: radial-gradient(
  circle at center,
  hsl(var(--accent) / var(--gradient-glow-opacity)) 0%,
  transparent 70%
);

--gradient-accent-cta: linear-gradient(to right, hsl(var(--accent)), hsl(var(--accent-muted)));

--gradient-page-bg: linear-gradient(
  to bottom right,
  hsl(var(--background)),
  hsl(var(--background)),
  hsl(var(--background-subtle))
);
```

### 1.2 Add Light Theme Gradient Overrides

**File**: `apps/studio/src/app/globals.css`
**Location**: Inside the `[data-theme='light']` block (after the existing light overrides, before the closing `}`).

Add the following overrides:

```css
/* Gradient token overrides — light theme */
--gradient-stop-panel-mid: 220 4% 98%;
--gradient-stop-sidebar-start: 0 0% 100%;
--gradient-stop-sidebar-mid: 0 0% 100%;
--gradient-stop-sidebar-end: 0 0% 100%;
--gradient-stop-accent-end: 220 5% 35%;
--gradient-glow-opacity: 0.04;
```

### 1.3 Exit Criteria

- [ ] All 7 composite gradient tokens defined in `:root`
- [ ] All atomic stop tokens defined in `:root`
- [ ] Light-theme overrides for all stop tokens that differ between themes
- [ ] CSS file parses without errors (verify with `pnpm build --filter=studio`)
- [ ] No visual changes (tokens are defined but not yet consumed)

---

## Phase 2: Refactor globals.css Utility Classes

**Goal**: Update existing utility classes in `globals.css` to consume the new gradient tokens instead of hardcoded values.

### 2.1 Refactor `.arch-panel-bg`

**File**: `apps/studio/src/app/globals.css` (line ~636)

**Before**:

```css
.arch-panel-bg {
  background: linear-gradient(
    180deg,
    hsl(var(--background-elevated)) 0%,
    hsl(220 4% 10%) 50%,
    hsl(var(--background-elevated)) 100%
  );
}
```

**After**:

```css
.arch-panel-bg {
  background: var(--gradient-panel);
}
```

Also remove the light-theme override at line ~291:

**Before**:

```css
[data-theme='light'] .arch-panel-bg {
  background: linear-gradient(
    180deg,
    hsl(var(--background-elevated)) 0%,
    hsl(220 4% 98%) 50%,
    hsl(var(--background-elevated)) 100%
  );
}
```

**After**: Remove entirely — the token itself handles theming via the overridden stop values.

### 2.2 Refactor `.sidebar-bg`

**File**: `apps/studio/src/app/globals.css` (line ~646)

**Before**:

```css
.sidebar-bg {
  background: linear-gradient(
    180deg,
    hsl(220 3% 8%) 0%,
    hsl(var(--background-subtle)) 30%,
    hsl(var(--background-subtle)) 100%
  );
}
```

**After**:

```css
.sidebar-bg {
  background: var(--gradient-sidebar);
}
```

Also remove the light-theme override at line ~301:

**Before**:

```css
[data-theme='light'] .sidebar-bg {
  background: linear-gradient(180deg, hsl(0 0% 100%) 0%, hsl(0 0% 100%) 30%, hsl(0 0% 100%) 100%);
}
```

**After**: Remove entirely — handled by token theming.

### 2.3 Refactor `.text-gradient`

**File**: `apps/studio/src/app/globals.css` (line ~610)

**Before**:

```css
.text-gradient {
  background: linear-gradient(135deg, hsl(var(--accent)) 0%, hsl(220 5% 75%) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

**After**:

```css
.text-gradient {
  background: var(--gradient-text-accent);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

### 2.4 Refactor `.empty-state-glow::before`

**File**: `apps/studio/src/app/globals.css` (line ~660)

**Before**:

```css
.empty-state-glow::before {
  content: '';
  position: absolute;
  inset: -12px;
  background: radial-gradient(circle at center, hsl(var(--accent) / 0.07) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
  border-radius: 50%;
}
```

**After**:

```css
.empty-state-glow::before {
  content: '';
  position: absolute;
  inset: -12px;
  background: var(--gradient-glow-radial);
  pointer-events: none;
  z-index: 0;
  border-radius: 50%;
}
```

Also remove the light-theme override at line ~304:

**Before**:

```css
[data-theme='light'] .empty-state-glow::before {
  background: radial-gradient(circle at center, hsl(var(--accent) / 0.04) 0%, transparent 70%);
}
```

**After**: Remove entirely — handled by `--gradient-glow-opacity` override.

### 2.5 Refactor `.skeleton`

**File**: `apps/studio/src/app/globals.css` (line ~731)

**Before**:

```css
.skeleton {
  background: linear-gradient(
    90deg,
    hsl(var(--background-muted)) 0%,
    hsl(var(--background-elevated)) 50%,
    hsl(var(--background-muted)) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
  border-radius: var(--radius-md);
}
```

**After**:

```css
.skeleton {
  background: var(--gradient-skeleton);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
  border-radius: var(--radius-md);
}
```

### 2.6 Refactor `.text-gradient` in `index.css`

**File**: `apps/studio/src/index.css` (line ~355)

**Before**:

```css
.text-gradient {
  background: linear-gradient(135deg, hsl(var(--accent)) 0%, hsl(220 5% 75%) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

**After**:

```css
.text-gradient {
  background: var(--gradient-text-accent);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

### 2.7 Refactor `.skeleton` in `index.css`

**File**: `apps/studio/src/index.css` (line ~387)

Check if `index.css` has a skeleton definition. If it duplicates `globals.css`, refactor it the same way.

### 2.8 Exit Criteria

- [ ] `.arch-panel-bg` uses `var(--gradient-panel)` and light override is removed
- [ ] `.sidebar-bg` uses `var(--gradient-sidebar)` and light override is removed
- [ ] `.text-gradient` uses `var(--gradient-text-accent)` (both files)
- [ ] `.empty-state-glow::before` uses `var(--gradient-glow-radial)` and light override is removed
- [ ] `.skeleton` uses `var(--gradient-skeleton)` (both files if applicable)
- [ ] `pnpm build --filter=studio` succeeds
- [ ] Visual appearance in browser is identical (manual spot check: dark + light)

---

## Phase 3: Extend Tailwind Configuration

**Goal**: Add `backgroundImage` entries to `packages/tailwind-config/base.js` so components can use `bg-gradient-*` classes.

### 3.1 Add backgroundImage to Tailwind Config

**File**: `packages/tailwind-config/base.js`

**Before** (line ~70):

```js
    },
  },
  plugins: [],
};
```

**After**:

```js
      backgroundImage: {
        'gradient-panel': 'var(--gradient-panel)',
        'gradient-sidebar': 'var(--gradient-sidebar)',
        'gradient-text-accent': 'var(--gradient-text-accent)',
        'gradient-skeleton': 'var(--gradient-skeleton)',
        'gradient-glow-radial': 'var(--gradient-glow-radial)',
        'gradient-accent-cta': 'var(--gradient-accent-cta)',
        'gradient-page-bg': 'var(--gradient-page-bg)',
      },
    },
  },
  plugins: [],
};
```

### 3.2 Exit Criteria

- [ ] `packages/tailwind-config/base.js` has 7 `backgroundImage` entries
- [ ] `pnpm build --filter=studio` succeeds (Tailwind JIT generates classes)
- [ ] Class `bg-gradient-panel` appears in built CSS output (verify by searching build artifacts)
- [ ] No TypeScript errors (`tsc --noEmit` for affected packages)

---

## Phase 4: Refactor Component Inline Gradients

**Goal**: Replace inline Tailwind gradient classes in components with the new semantic gradient utilities.

### 4.1 Component Refactoring Map

| Component                                 | Current Classes                                                         | New Class                | Notes                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| `ArchOnboarding.tsx`                      | `bg-gradient-to-br from-background via-background to-background-subtle` | `bg-gradient-page-bg`    | Onboarding full-page background                       |
| `RevealPhase.tsx` (CTA button, line ~372) | `bg-gradient-to-r from-accent to-accent-muted`                          | `bg-gradient-accent-cta` | CTA pill button                                       |
| `RevealPhase.tsx` (icon bg, line ~320)    | `bg-gradient-to-br from-accent to-accent-muted`                         | `bg-gradient-accent-cta` | Icon background (direction differs — verify visually) |
| `RevealPhase.tsx` (main CTA, line ~408)   | `bg-gradient-to-r from-accent to-accent-muted`                          | `bg-gradient-accent-cta` | Main CTA button                                       |
| `ReviewPhase.tsx` (CTA, line ~775)        | `bg-gradient-to-r from-accent to-accent-muted`                          | `bg-gradient-accent-cta` | Review submit button                                  |
| `DeployPanel.tsx` (header, line ~143)     | `bg-gradient-to-r from-accent/10 to-accent/5`                           | Keep as-is               | Low-opacity variant, doesn't match any token          |
| `BillingPage.tsx` (card, line ~396)       | `bg-gradient-to-br from-accent/5 to-transparent`                        | Keep as-is               | Low-opacity decorative, doesn't match any token       |
| `ChunkExplorer.tsx` (line, line ~329)     | `bg-gradient-to-b from-accent/40 via-accent/20 to-transparent`          | Keep as-is               | Unique vertical line gradient                         |
| `preview/page.tsx` (backgrounds)          | `bg-gradient-to-br from-background to-background`                       | `bg-gradient-page-bg`    | Multiple instances (lines ~606, 617, 635, 665, 1184)  |
| `preview/[projectId]/page.tsx`            | `bg-gradient-to-br from-background to-background`                       | `bg-gradient-page-bg`    | Multiple instances (lines ~229, 237, 251)             |

**Important**: Components using low-opacity variants (`from-accent/10`, `from-accent/5`, `from-accent/40`) should NOT be refactored — they use Tailwind's opacity modifier which the tokens don't replicate. Only refactor exact matches.

### 4.2 Exit Criteria

- [ ] All CTA buttons (`RevealPhase.tsx`, `ReviewPhase.tsx`) use `bg-gradient-accent-cta`
- [ ] `ArchOnboarding.tsx` uses `bg-gradient-page-bg`
- [ ] `preview/page.tsx` and `preview/[projectId]/page.tsx` use `bg-gradient-page-bg`
- [ ] Components with opacity-variant gradients are left unchanged
- [ ] `pnpm build --filter=studio` succeeds
- [ ] `tsc --noEmit` passes
- [ ] Visual appearance unchanged (manual spot check)

---

## Phase 5: Build Verification and Cleanup

**Goal**: Verify the full build, clean up any duplicate definitions, and validate visual regression.

### 5.1 Build Verification Steps

1. Run `pnpm build --filter=studio` — must succeed with zero errors
2. Run `tsc --noEmit` for studio and tailwind-config packages
3. Search built CSS for all 7 composite tokens: `--gradient-panel`, `--gradient-sidebar`, `--gradient-text-accent`, `--gradient-skeleton`, `--gradient-glow-radial`, `--gradient-accent-cta`, `--gradient-page-bg`
4. Search built CSS for Tailwind utilities: `bg-gradient-panel`, `bg-gradient-accent-cta`, `bg-gradient-page-bg`
5. Verify no duplicate `.text-gradient` or `.skeleton` definitions between `index.css` and `globals.css`

### 5.2 Cleanup Tasks

- Remove any orphaned light-theme gradient overrides that are now handled by token theming
- Ensure `index.css` and `globals.css` don't duplicate the same utility classes with different gradient values
- Verify `.arch-panel-glow` (box-shadow gradient) is still functional (not tokenized, just verified)

### 5.3 Exit Criteria

- [ ] `pnpm build --filter=studio` succeeds
- [ ] `tsc --noEmit` passes for all affected packages
- [ ] Built CSS contains all 7 gradient tokens
- [ ] Built CSS contains Tailwind gradient utilities
- [ ] No duplicate utility class definitions
- [ ] No orphaned light-theme overrides
- [ ] All existing CSS class names still present in output

---

## Wiring Checklist

| #   | Wiring Point                                          | Status  | Verified By          |
| --- | ----------------------------------------------------- | ------- | -------------------- |
| 1   | Gradient stop tokens defined in `:root`               | PLANNED | Phase 1 build        |
| 2   | Composite gradient tokens defined in `:root`          | PLANNED | Phase 1 build        |
| 3   | Light-theme overrides for gradient stops              | PLANNED | Phase 1 build        |
| 4   | `.arch-panel-bg` consumes `--gradient-panel`          | PLANNED | Phase 2 visual check |
| 5   | `.sidebar-bg` consumes `--gradient-sidebar`           | PLANNED | Phase 2 visual check |
| 6   | `.text-gradient` consumes `--gradient-text-accent`    | PLANNED | Phase 2 visual check |
| 7   | `.empty-state-glow` consumes `--gradient-glow-radial` | PLANNED | Phase 2 visual check |
| 8   | `.skeleton` consumes `--gradient-skeleton`            | PLANNED | Phase 2 visual check |
| 9   | Tailwind `backgroundImage` has 7 entries              | PLANNED | Phase 3 build        |
| 10  | Component CTA buttons use `bg-gradient-accent-cta`    | PLANNED | Phase 4 visual check |
| 11  | Page backgrounds use `bg-gradient-page-bg`            | PLANNED | Phase 4 visual check |
| 12  | Light-theme `.arch-panel-bg` override removed         | PLANNED | Phase 2 CSS check    |
| 13  | Light-theme `.sidebar-bg` override removed            | PLANNED | Phase 2 CSS check    |
| 14  | Light-theme `.empty-state-glow` override removed      | PLANNED | Phase 2 CSS check    |
| 15  | Built CSS contains all token definitions              | PLANNED | Phase 5 build check  |
| 16  | No duplicate utility definitions across CSS files     | PLANNED | Phase 5 cleanup      |

## Risk Log

| Risk                                                                                     | Phase     | Mitigation                                                                                | Owner       |
| ---------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------- | ----------- |
| `.skeleton` `background-size` property may be overridden by composite token              | Phase 2   | Verify `background-size: 200% 100%` is set after `background: var(--gradient-skeleton)`   | Implementer |
| `RevealPhase.tsx` icon uses `bg-gradient-to-br` (diagonal) but token is `to right`       | Phase 4   | Keep icon gradient as-is (different direction) or verify visual acceptable                | Implementer |
| `index.css` may have stale gradient definitions if `globals.css` is the canonical source | Phase 2/5 | Check if `index.css` is still loaded; remove duplicates if not needed                     | Implementer |
| Tailwind JIT may not process `var()` in `backgroundImage` values                         | Phase 3   | Test immediately after adding config; Tailwind v3 supports `var()` in static theme values | Implementer |

## Dependencies Between Phases

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
(tokens)    (CSS utils) (Tailwind)  (components) (verify)
```

Each phase depends on the previous. Phase 3 (Tailwind) could theoretically run in parallel with Phase 2 (CSS utils), but sequential execution is safer for visual regression checking.

## Estimated Effort

| Phase                         | Complexity | Estimated Time |
| ----------------------------- | ---------- | -------------- |
| Phase 1: Token Definitions    | LOW        | 15 min         |
| Phase 2: CSS Utility Refactor | MEDIUM     | 30 min         |
| Phase 3: Tailwind Config      | LOW        | 10 min         |
| Phase 4: Component Refactor   | MEDIUM     | 30 min         |
| Phase 5: Build & Cleanup      | LOW        | 15 min         |
| **Total**                     | **MEDIUM** | **~1.5 hours** |
