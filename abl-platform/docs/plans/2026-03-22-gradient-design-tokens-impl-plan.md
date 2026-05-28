# LLD: Gradient Design Tokens Implementation Plan

**Feature**: gradient-design-tokens
**HLD**: `docs/specs/gradient-design-tokens.hld.md`
**Feature Spec**: `docs/features/gradient-design-tokens.md`
**Test Spec**: `docs/testing/gradient-design-tokens.md`
**Date**: 2026-03-22
**Status**: DONE

---

## File-Level Change Map

### New Files

| File                                                     | Purpose                                           |
| -------------------------------------------------------- | ------------------------------------------------- |
| `packages/design-tokens/src/gradients.ts`                | Gradient token types, registry, API functions     |
| `packages/design-tokens/src/__tests__/gradients.test.ts` | Unit tests for gradient TypeScript API (U-1..U-7) |
| `packages/design-tokens/vitest.config.ts`                | Vitest config for the design-tokens package       |

### Modified Files

| File                                                          | Changes                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/design-tokens/src/index.ts`                         | Re-export gradient types, functions, and constants                                        |
| `packages/design-tokens/package.json`                         | Add vitest devDependency for unit tests                                                   |
| `apps/studio/src/app/globals.css`                             | Add `--gradient-*` CSS custom properties, utility classes, migrate existing gradient defs |
| `apps/studio/src/index.css`                                   | Remove diverged `.text-gradient` and `.skeleton` definitions (GAP-001 reconciliation)     |
| `apps/studio/src/components/onboarding/RevealPhase.tsx`       | Replace inline Tailwind gradient with `.bg-gradient-brand`                                |
| `apps/studio/src/components/onboarding/ReviewPhase.tsx`       | Replace inline Tailwind gradient with `.bg-gradient-brand`                                |
| `apps/studio/src/components/onboarding/ArchOnboarding.tsx`    | Replace inline Tailwind gradient with `.bg-gradient-surface-page`                         |
| `apps/studio/src/components/onboarding/WelcomePhase.tsx`      | Verify `.empty-state-glow` alias works with tokenized version                             |
| `apps/studio/src/components/arch/ArchPanel.tsx`               | Replace `.text-gradient` with `.text-gradient-brand`, verify `.arch-panel-bg` alias       |
| `apps/studio/src/components/deploy/DeployPanel.tsx`           | Replace inline Tailwind gradient with `.bg-gradient-surface-accent`                       |
| `apps/studio/src/components/admin/BillingPage.tsx`            | Replace inline Tailwind gradient with `.bg-gradient-surface-accent`                       |
| `apps/studio/src/components/search-ai/ChunkExplorer.tsx`      | Replace inline Tailwind gradient with `.bg-gradient-brand-fade`                           |
| `apps/studio/src/components/ui/EmptyState.tsx`                | Verify `.empty-state-glow` alias works with tokenized version                             |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx`    | Replace `.sidebar-bg` with `.bg-gradient-surface-sidebar`                                 |
| `apps/studio/src/components/navigation/AdminSidebar.tsx`      | Replace `.sidebar-bg` with `.bg-gradient-surface-sidebar`                                 |
| `apps/studio/src/components/agent-editor/AgentEditorMenu.tsx` | Replace `.sidebar-bg` with `.bg-gradient-surface-sidebar`                                 |
| `apps/studio/src/app/preview/page.tsx`                        | Replace inline Tailwind gradient with `.bg-gradient-surface-page`                         |
| `apps/studio/src/app/preview/[projectId]/page.tsx`            | Replace inline Tailwind gradient with `.bg-gradient-surface-page`                         |

---

## Phase 1: CSS Token Definitions (globals.css)

**Goal**: Define all gradient CSS custom properties and utility classes in `globals.css`.

**Rationale**: CSS custom properties are the foundation layer. All utility classes and the TypeScript API reference these tokens. Defining them first ensures the rest of the system has a stable base.

### Task 1.1: Add gradient CSS custom properties to `:root`

**File**: `apps/studio/src/app/globals.css`
**Location**: Inside the existing `@layer base { :root { ... } }` block, after the chart color definitions (after line ~182 in globals.css).

Add a new section header and 14 gradient custom properties:

```css
/* -------------------------------------------------------------------------
   GRADIENT TOKENS - Semantic gradient system
   Categories: Brand, Surface, Status, Glow, Utility
   Each token stores a full gradient value; theme overrides in [data-theme='light'].
   ------------------------------------------------------------------------- */

/* Brand / AI Signature — purple-to-cyan identity gradients */
--gradient-brand: linear-gradient(135deg, hsl(var(--purple)) 0%, hsl(var(--info)) 100%);
--gradient-brand-subtle: linear-gradient(
  135deg,
  hsl(var(--purple) / 0.15) 0%,
  hsl(var(--info) / 0.1) 100%
);
--gradient-brand-text: linear-gradient(135deg, hsl(var(--accent)) 0%, hsl(220 5% 75%) 100%);
--gradient-brand-fade: linear-gradient(
  180deg,
  hsl(var(--purple) / 0.4) 0%,
  hsl(var(--purple) / 0.2) 40%,
  transparent 100%
);

/* Surface / Depth — monochrome ambient washes */
--gradient-surface-panel: linear-gradient(
  180deg,
  hsl(var(--background-elevated)) 0%,
  hsl(220 4% 10%) 50%,
  hsl(var(--background-elevated)) 100%
);
--gradient-surface-sidebar: linear-gradient(
  180deg,
  hsl(220 3% 8%) 0%,
  hsl(var(--background-subtle)) 30%,
  hsl(var(--background-subtle)) 100%
);
--gradient-surface-page: linear-gradient(
  150deg,
  hsl(var(--background)) 0%,
  hsl(var(--background-subtle)) 100%
);
--gradient-surface-accent: linear-gradient(
  135deg,
  hsl(var(--accent) / 0.1) 0%,
  hsl(var(--accent) / 0.05) 100%
);

/* Status / Energy — semantic color pairs */
--gradient-status-success: linear-gradient(135deg, hsl(var(--success)) 0%, hsl(166 72% 50%) 100%);
--gradient-status-warning: linear-gradient(135deg, hsl(var(--warning)) 0%, hsl(25 95% 53%) 100%);
--gradient-status-error: linear-gradient(135deg, hsl(var(--error)) 0%, hsl(350 89% 60%) 100%);

/* Glow / Decorative — radial accent effects */
--gradient-glow-accent: radial-gradient(
  circle at center,
  hsl(var(--accent) / 0.07) 0%,
  transparent 70%
);
--gradient-glow-ambient: radial-gradient(
  ellipse at 50% 50%,
  hsl(var(--purple) / 0.04) 0%,
  hsl(var(--info) / 0.02) 40%,
  transparent 70%
);

/* Utility */
--gradient-shimmer: linear-gradient(
  90deg,
  hsl(var(--background-muted)) 0%,
  hsl(var(--background-elevated)) 50%,
  hsl(var(--background-muted)) 100%
);
```

**Key decisions**:

- `--gradient-brand-text` preserves the exact current `.text-gradient` gradient values (`hsl(var(--accent))` to `hsl(220 5% 75%)`) to avoid visual regression.
- `--gradient-surface-panel` preserves the exact current `.arch-panel-bg` gradient values.
- `--gradient-surface-sidebar` preserves the exact current `.sidebar-bg` gradient values.
- `--gradient-glow-accent` preserves the exact current `.empty-state-glow::before` radial gradient value.
- `--gradient-shimmer` preserves the exact current `.skeleton` gradient value.
- `--gradient-brand-fade` matches the existing `ChunkExplorer.tsx` gradient pattern (`from-accent/40 via-accent/20 to-transparent`) but uses purple instead of accent for brand consistency.

### Task 1.2: Add `[data-theme='light']` overrides for ALL gradient tokens

**File**: `apps/studio/src/app/globals.css`
**Location**: Inside the existing `@layer base` block, within the `[data-theme='light']` selector (after the chart colors at line ~287), BEFORE the individual class overrides at line ~289.

Add a gradient overrides section inside `[data-theme='light']`:

```css
/* Gradient token overrides — light theme */
--gradient-brand: linear-gradient(135deg, hsl(var(--purple)) 0%, hsl(var(--info)) 100%);
--gradient-brand-subtle: linear-gradient(
  135deg,
  hsl(var(--purple) / 0.08) 0%,
  hsl(var(--info) / 0.05) 100%
);
--gradient-brand-text: linear-gradient(135deg, hsl(var(--accent)) 0%, hsl(220 5% 40%) 100%);
--gradient-brand-fade: linear-gradient(
  180deg,
  hsl(var(--purple) / 0.15) 0%,
  hsl(var(--purple) / 0.08) 40%,
  transparent 100%
);
--gradient-surface-panel: linear-gradient(
  180deg,
  hsl(var(--background-elevated)) 0%,
  hsl(220 4% 98%) 50%,
  hsl(var(--background-elevated)) 100%
);
--gradient-surface-sidebar: linear-gradient(
  180deg,
  hsl(0 0% 100%) 0%,
  hsl(0 0% 100%) 30%,
  hsl(0 0% 100%) 100%
);
--gradient-surface-page: linear-gradient(
  150deg,
  hsl(var(--background)) 0%,
  hsl(var(--background-subtle)) 100%
);
--gradient-surface-accent: linear-gradient(
  135deg,
  hsl(var(--accent) / 0.06) 0%,
  hsl(var(--accent) / 0.02) 100%
);
--gradient-status-success: linear-gradient(135deg, hsl(var(--success)) 0%, hsl(166 72% 42%) 100%);
--gradient-status-warning: linear-gradient(135deg, hsl(var(--warning)) 0%, hsl(25 95% 45%) 100%);
--gradient-status-error: linear-gradient(135deg, hsl(var(--error)) 0%, hsl(350 89% 52%) 100%);
--gradient-glow-accent: radial-gradient(
  circle at center,
  hsl(var(--accent) / 0.04) 0%,
  transparent 70%
);
--gradient-glow-ambient: radial-gradient(
  ellipse at 50% 50%,
  hsl(var(--purple) / 0.02) 0%,
  hsl(var(--info) / 0.01) 40%,
  transparent 70%
);
--gradient-shimmer: linear-gradient(
  90deg,
  hsl(var(--background-muted)) 0%,
  hsl(var(--background-elevated)) 50%,
  hsl(var(--background-muted)) 100%
);
```

**Key decisions**:

- `--gradient-brand-text` light override uses `hsl(220 5% 40%)` as the lighter stop (darker against white backgrounds) to maintain WCAG AA contrast (4.5:1+). The current `.text-gradient` has NO light-theme override (GAP-003) -- this fixes it.
- `--gradient-surface-panel` light override preserves the exact current `[data-theme='light'] .arch-panel-bg` value.
- `--gradient-surface-sidebar` light override preserves the exact current `[data-theme='light'] .sidebar-bg` value.
- `--gradient-glow-accent` light override preserves the exact current `[data-theme='light'] .empty-state-glow::before` value.
- `--gradient-brand-subtle` light override uses reduced opacity (0.08/0.05) vs dark (0.15/0.1) for subtlety on white.
- `--gradient-shimmer` reuses the same formula -- the underlying color tokens already differ between themes, so the gradient naturally adapts.

### Task 1.3: Add CSS utility classes in `@layer utilities`

**File**: `apps/studio/src/app/globals.css`
**Location**: Inside the first `@layer utilities` block, after the `.glass` utility (after line ~497), before the existing `.text-gradient` definition.

Add gradient utility classes:

```css
/* -------------------------------------------------------------------------
   GRADIENT UTILITIES — semantic gradient classes backed by --gradient-* tokens
   ------------------------------------------------------------------------- */

/* Background gradient utilities */
.bg-gradient-brand {
  background: var(--gradient-brand);
}
.bg-gradient-brand-subtle {
  background: var(--gradient-brand-subtle);
}
.bg-gradient-brand-fade {
  background: var(--gradient-brand-fade);
}
.bg-gradient-surface-panel {
  background: var(--gradient-surface-panel);
}
.bg-gradient-surface-sidebar {
  background: var(--gradient-surface-sidebar);
}
.bg-gradient-surface-page {
  background: var(--gradient-surface-page);
}
.bg-gradient-surface-accent {
  background: var(--gradient-surface-accent);
}
.bg-gradient-status-success {
  background: var(--gradient-status-success);
}
.bg-gradient-status-warning {
  background: var(--gradient-status-warning);
}
.bg-gradient-status-error {
  background: var(--gradient-status-error);
}
.bg-gradient-shimmer {
  background: var(--gradient-shimmer);
}

/* Text gradient utility — text with gradient fill */
.text-gradient-brand {
  background: var(--gradient-brand-text);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Gradient border utility — uses ::before pseudo-element for border-radius compat */
.border-gradient-brand {
  position: relative;
  border: none;
}
.border-gradient-brand::before {
  content: '';
  position: absolute;
  inset: 0;
  padding: 1px;
  border-radius: inherit;
  background: var(--gradient-brand);
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
  z-index: 0;
}

/* Glow utilities — radial accent effects via ::before */
.gradient-glow-accent {
  position: relative;
}
.gradient-glow-accent::before {
  content: '';
  position: absolute;
  inset: -12px;
  background: var(--gradient-glow-accent);
  pointer-events: none;
  z-index: 0;
  border-radius: 50%;
}
.gradient-glow-accent > * {
  position: relative;
  z-index: 1;
}

.gradient-glow-ambient {
  position: relative;
}
.gradient-glow-ambient::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--gradient-glow-ambient);
  pointer-events: none;
  z-index: 0;
}
```

**Important constraint documented**: `.border-gradient-brand` consumes `::before`. Elements already using `::before` (e.g., `.empty-state-glow`, `.bg-noise`) cannot also use `.border-gradient-brand`. Apply gradient border to a wrapper element instead.

### Task 1.4: Add deprecation aliases

**File**: `apps/studio/src/app/globals.css`
**Location**: Replace the existing `.text-gradient`, `.arch-panel-bg`, `.sidebar-bg`, and `.empty-state-glow` definitions in `@layer utilities` with token-backed aliases.

The existing definitions at lines ~500-561 will be rewritten to reference the new CSS custom properties instead of hardcoded gradient values:

```css
/* Deprecation aliases — remove after v1 migration cycle.
   Old class names preserved for backwards compatibility. */

/* .text-gradient → use .text-gradient-brand */
.text-gradient {
  background: var(--gradient-brand-text);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* .arch-panel-bg → use .bg-gradient-surface-panel */
.arch-panel-bg {
  background: var(--gradient-surface-panel);
}

/* .sidebar-bg → use .bg-gradient-surface-sidebar */
.sidebar-bg {
  background: var(--gradient-surface-sidebar);
}

/* .empty-state-glow → use .gradient-glow-accent */
.empty-state-glow {
  position: relative;
}
.empty-state-glow::before {
  content: '';
  position: absolute;
  inset: -12px;
  background: var(--gradient-glow-accent);
  pointer-events: none;
  z-index: 0;
  border-radius: 50%;
}
.empty-state-glow > * {
  position: relative;
  z-index: 1;
}
```

### Task 1.5: Remove redundant light-theme class overrides

**File**: `apps/studio/src/app/globals.css`
**Location**: Remove the individual light-theme class overrides at lines ~293-308:

```css
/* REMOVE these — theme differentiation now lives in the --gradient-* token definitions */
[data-theme='light'] .arch-panel-bg { ... }
[data-theme='light'] .sidebar-bg { ... }
[data-theme='light'] .empty-state-glow::before { ... }
```

These are no longer needed because the `.arch-panel-bg`, `.sidebar-bg`, and `.empty-state-glow::before` aliases now reference `var(--gradient-surface-panel)`, `var(--gradient-surface-sidebar)`, and `var(--gradient-glow-accent)` respectively. The CSS custom properties themselves already have `[data-theme='light']` overrides (Task 1.2), so the theming is handled at the token layer.

Keep `[data-theme='light'] .bg-noise::before` and `[data-theme='light'] .table-header-glass` -- these are unrelated to gradients.

### Task 1.6: Gate `.skeleton` animation with `prefers-reduced-motion`

**File**: `apps/studio/src/app/globals.css`
**Location**: After the `.skeleton` and `.skeleton-pulse` definitions (after line ~635), add:

```css
@media (prefers-reduced-motion: reduce) {
  .skeleton {
    animation: none;
  }
  .skeleton-pulse {
    animation: none;
  }
}
```

Also update the `.skeleton` definition to reference the shimmer token:

```css
.skeleton {
  background: var(--gradient-shimmer);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
  border-radius: var(--radius-md);
}
```

### Exit Criteria

- [ ] `grep -c '\-\-gradient-' apps/studio/src/app/globals.css` >= 14 (in `:root`)
- [ ] Count of `--gradient-*` definitions in `[data-theme='light']` == count in `:root` (14)
- [ ] `pnpm build --filter=@agent-platform/studio` passes
- [ ] `[data-theme='light'] .arch-panel-bg`, `[data-theme='light'] .sidebar-bg`, `[data-theme='light'] .empty-state-glow::before` blocks removed
- [ ] `@media (prefers-reduced-motion: reduce)` block exists covering `.skeleton` and `.skeleton-pulse`

---

## Phase 2: TypeScript API (packages/design-tokens)

**Goal**: Create the typed gradient token API in `packages/design-tokens/src/gradients.ts` following the established `intents.ts` pattern.

### Task 2.1: Create `packages/design-tokens/src/gradients.ts`

**File**: `packages/design-tokens/src/gradients.ts` (NEW)

The module structure mirrors `intents.ts`:

1. **Type definitions** at the top
2. **Registry constant** as single source of truth
3. **Public API functions** at the bottom

```typescript
/**
 * Gradient Token System
 *
 * Typed gradient tokens that mirror the CSS custom properties defined in
 * globals.css. Provides class name lookups and CSS variable references for
 * programmatic/canvas use.
 *
 * Architecture:
 *   GradientToken → GradientTokenEntry → class names / CSS var references
 *
 * Usage:
 *   import { getGradientStyles, getGradientValue } from '@agent-platform/design-tokens';
 *   const styles = getGradientStyles('brand');
 *   <div className={styles.bg}>...</div>
 *
 *   const canvasStyle = { background: getGradientValue('glow-ambient') };
 */

// =============================================================================
// GRADIENT TOKEN — the core type
// =============================================================================

/**
 * The four semantic gradient categories.
 */
export type GradientCategory = 'brand' | 'surface' | 'status' | 'glow' | 'utility';

/**
 * All gradient token names. Each maps to a CSS custom property
 * `--gradient-<token>` defined in globals.css.
 */
export type GradientToken =
  | 'brand'
  | 'brand-subtle'
  | 'brand-text'
  | 'brand-fade'
  | 'surface-panel'
  | 'surface-sidebar'
  | 'surface-page'
  | 'surface-accent'
  | 'status-success'
  | 'status-warning'
  | 'status-error'
  | 'glow-accent'
  | 'glow-ambient'
  | 'shimmer';

// =============================================================================
// GRADIENT STYLES — the class name sets
// =============================================================================

/**
 * Style information for a gradient token.
 * Provides class names for background, text, and border applications,
 * plus the raw CSS variable reference for inline styles.
 */
export interface GradientStyles {
  /** Background gradient class: `bg-gradient-brand`, `bg-gradient-surface-panel`, etc. */
  bg: string;
  /** Text gradient class (background-clip: text). Only meaningful for brand tokens. */
  text: string;
  /** Border gradient class (pseudo-element technique). Only meaningful for brand tokens. */
  border: string;
  /** CSS variable reference: `var(--gradient-brand)` — for inline styles / canvas use */
  cssVar: string;
}

/**
 * Registry entry for a single gradient token.
 */
interface GradientTokenEntry {
  /** CSS custom property name: `--gradient-brand` */
  cssVar: string;
  /** Primary CSS class name: `bg-gradient-brand` */
  className: string;
  /** Gradient category for filtering/grouping */
  category: GradientCategory;
}

// =============================================================================
// GRADIENT TOKEN REGISTRY — single source of truth
// =============================================================================

/**
 * Complete registry of all gradient tokens.
 * Keys are GradientToken names, values contain the CSS variable name,
 * primary class name, and category.
 */
export const GRADIENT_TOKENS: Record<GradientToken, GradientTokenEntry> = {
  brand: {
    cssVar: '--gradient-brand',
    className: 'bg-gradient-brand',
    category: 'brand',
  },
  'brand-subtle': {
    cssVar: '--gradient-brand-subtle',
    className: 'bg-gradient-brand-subtle',
    category: 'brand',
  },
  'brand-text': {
    cssVar: '--gradient-brand-text',
    className: 'text-gradient-brand',
    category: 'brand',
  },
  'brand-fade': {
    cssVar: '--gradient-brand-fade',
    className: 'bg-gradient-brand-fade',
    category: 'brand',
  },
  'surface-panel': {
    cssVar: '--gradient-surface-panel',
    className: 'bg-gradient-surface-panel',
    category: 'surface',
  },
  'surface-sidebar': {
    cssVar: '--gradient-surface-sidebar',
    className: 'bg-gradient-surface-sidebar',
    category: 'surface',
  },
  'surface-page': {
    cssVar: '--gradient-surface-page',
    className: 'bg-gradient-surface-page',
    category: 'surface',
  },
  'surface-accent': {
    cssVar: '--gradient-surface-accent',
    className: 'bg-gradient-surface-accent',
    category: 'surface',
  },
  'status-success': {
    cssVar: '--gradient-status-success',
    className: 'bg-gradient-status-success',
    category: 'status',
  },
  'status-warning': {
    cssVar: '--gradient-status-warning',
    className: 'bg-gradient-status-warning',
    category: 'status',
  },
  'status-error': {
    cssVar: '--gradient-status-error',
    className: 'bg-gradient-status-error',
    category: 'status',
  },
  'glow-accent': {
    cssVar: '--gradient-glow-accent',
    className: 'gradient-glow-accent',
    category: 'glow',
  },
  'glow-ambient': {
    cssVar: '--gradient-glow-ambient',
    className: 'gradient-glow-ambient',
    category: 'glow',
  },
  shimmer: {
    cssVar: '--gradient-shimmer',
    className: 'bg-gradient-shimmer',
    category: 'utility',
  },
};

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Get the full GradientStyles for a gradient token.
 *
 * Returns class names for bg, text, and border applications,
 * plus the CSS variable reference for inline styles.
 *
 * @example
 *   const styles = getGradientStyles('brand');
 *   <button className={styles.bg}>Deploy</button>
 *   <h2 className={styles.text}>Arch AI</h2>
 */
export function getGradientStyles(token: GradientToken): GradientStyles | undefined {
  const entry = GRADIENT_TOKENS[token];
  if (!entry) return undefined;

  return {
    bg: `bg-gradient-${token}`,
    text: `text-gradient-${token}`,
    border: `border-gradient-${token}`,
    cssVar: `var(${entry.cssVar})`,
  };
}

/**
 * Get the CSS variable reference for a gradient token.
 * Returns a `var(--gradient-<token>)` string suitable for inline styles.
 *
 * @example
 *   const canvasStyle = { background: getGradientValue('glow-ambient') };
 */
export function getGradientValue(token: GradientToken): string | undefined {
  const entry = GRADIENT_TOKENS[token];
  if (!entry) return undefined;

  return `var(${entry.cssVar})`;
}
```

**Key design decisions**:

- **`getGradientStyles` returns `undefined` for invalid tokens** rather than throwing. This matches the behavior pattern in `intents.ts` where `getIntentStyles` does a direct lookup (`INTENT_STYLES[intent]`) that returns `undefined` for unknown keys at runtime, even though TypeScript constrains the input type.
- **`GradientStyles` includes `bg`, `text`, `border`, and `cssVar`**. The `text` and `border` class names follow a consistent naming convention (`text-gradient-<token>`, `border-gradient-<token>`) even though only the `brand` token currently has CSS rules for text and border. This provides forward compatibility if text/border variants are added for other tokens.
- **`GradientCategory` includes `'utility'`** for the shimmer token, which does not fit the other four categories semantically.

### Task 2.2: Update `packages/design-tokens/src/index.ts` to re-export gradient API

**File**: `packages/design-tokens/src/index.ts`

Add after the overlay exports:

```typescript
// Gradient tokens
export type { GradientToken, GradientCategory, GradientStyles } from './gradients';
export { getGradientStyles, getGradientValue, GRADIENT_TOKENS } from './gradients';
```

### Task 2.3: Add vitest configuration

**File**: `packages/design-tokens/vitest.config.ts` (NEW)

The design-tokens package has no existing test infrastructure. Add a minimal vitest config:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

Also update `packages/design-tokens/package.json` to add vitest as a devDependency and a test script:

```json
{
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^1.0.0"
  }
}
```

### Task 2.4: Write unit tests

**File**: `packages/design-tokens/src/__tests__/gradients.test.ts` (NEW)

Implements test scenarios U-1 through U-7 from the test spec:

```typescript
import { describe, it, expect } from 'vitest';
import {
  GRADIENT_TOKENS,
  getGradientStyles,
  getGradientValue,
  type GradientToken,
} from '../gradients';

describe('Gradient Design Tokens', () => {
  // U-1: GradientToken type includes all expected token names
  it('U-1: GRADIENT_TOKENS contains all 14 expected token names', () => {
    const expectedTokens: GradientToken[] = [
      'brand',
      'brand-subtle',
      'brand-text',
      'brand-fade',
      'surface-panel',
      'surface-sidebar',
      'surface-page',
      'surface-accent',
      'status-success',
      'status-warning',
      'status-error',
      'glow-accent',
      'glow-ambient',
      'shimmer',
    ];

    const actualTokens = Object.keys(GRADIENT_TOKENS);
    expect(actualTokens).toHaveLength(expectedTokens.length);
    for (const token of expectedTokens) {
      expect(GRADIENT_TOKENS).toHaveProperty(token);
    }
  });

  // U-2: getGradientStyles() returns valid GradientStyles
  it('U-2: getGradientStyles("brand") returns bg, text, border, cssVar', () => {
    const styles = getGradientStyles('brand');
    expect(styles).toBeDefined();
    expect(styles!.bg).toBe('bg-gradient-brand');
    expect(styles!.text).toBe('text-gradient-brand');
    expect(styles!.border).toBe('border-gradient-brand');
    expect(styles!.cssVar).toBe('var(--gradient-brand)');
  });

  // U-3: GRADIENT_TOKENS has cssVar and className for every token
  it('U-3: every token entry has cssVar and className', () => {
    for (const [key, entry] of Object.entries(GRADIENT_TOKENS)) {
      expect(entry.cssVar).toBeDefined();
      expect(typeof entry.cssVar).toBe('string');
      expect(entry.cssVar.length).toBeGreaterThan(0);

      expect(entry.className).toBeDefined();
      expect(typeof entry.className).toBe('string');
      expect(entry.className.length).toBeGreaterThan(0);
    }
  });

  // U-4: getGradientValue() returns var(--gradient-<token>) format
  it.each([
    ['brand', 'var(--gradient-brand)'],
    ['surface-panel', 'var(--gradient-surface-panel)'],
    ['status-success', 'var(--gradient-status-success)'],
    ['glow-accent', 'var(--gradient-glow-accent)'],
    ['shimmer', 'var(--gradient-shimmer)'],
  ] as [GradientToken, string][])('U-4: getGradientValue("%s") returns "%s"', (token, expected) => {
    expect(getGradientValue(token)).toBe(expected);
  });

  // U-5: All tokens have cssVar starting with --gradient-
  it('U-5: all token cssVar values start with --gradient-', () => {
    for (const entry of Object.values(GRADIENT_TOKENS)) {
      expect(entry.cssVar).toMatch(/^--gradient-/);
    }
  });

  // U-6: getGradientStyles() handles invalid token names gracefully
  it('U-6: getGradientStyles with invalid token returns undefined', () => {
    const result = getGradientStyles('nonexistent-token' as GradientToken);
    expect(result).toBeUndefined();
  });

  it('U-6: getGradientValue with invalid token returns undefined', () => {
    const result = getGradientValue('nonexistent-token' as GradientToken);
    expect(result).toBeUndefined();
  });

  // U-7: Token categories each have expected members
  it('U-7: brand category has >= 2 tokens', () => {
    const brandTokens = Object.entries(GRADIENT_TOKENS).filter(
      ([, entry]) => entry.category === 'brand',
    );
    expect(brandTokens.length).toBeGreaterThanOrEqual(2);
  });

  it('U-7: surface category has >= 2 tokens', () => {
    const surfaceTokens = Object.entries(GRADIENT_TOKENS).filter(
      ([, entry]) => entry.category === 'surface',
    );
    expect(surfaceTokens.length).toBeGreaterThanOrEqual(2);
  });

  it('U-7: status category has >= 3 tokens', () => {
    const statusTokens = Object.entries(GRADIENT_TOKENS).filter(
      ([, entry]) => entry.category === 'status',
    );
    expect(statusTokens.length).toBeGreaterThanOrEqual(3);
  });

  it('U-7: glow category has >= 1 token', () => {
    const glowTokens = Object.entries(GRADIENT_TOKENS).filter(
      ([, entry]) => entry.category === 'glow',
    );
    expect(glowTokens.length).toBeGreaterThanOrEqual(1);
  });
});
```

### Exit Criteria

- [ ] `pnpm build --filter=@agent-platform/design-tokens` passes
- [ ] `pnpm test --filter=@agent-platform/design-tokens` passes (all 12 test cases green)
- [ ] `tsc --noEmit` passes on design-tokens package (no type errors)
- [ ] `packages/design-tokens/src/index.ts` re-exports `GradientToken`, `GradientCategory`, `GradientStyles`, `getGradientStyles`, `getGradientValue`, `GRADIENT_TOKENS`

---

## Phase 3: Migrate Existing Ad-hoc Gradients (globals.css + index.css)

**Goal**: Replace all ad-hoc gradient definitions with token references and reconcile the `index.css` divergence.

### Task 3.1: Update existing utility classes to reference tokens

This task is partially completed by Task 1.4 (deprecation aliases). The following existing definitions in globals.css are rewritten:

| Existing Class              | Line(s)  | Old Value                                        | New Value                         |
| --------------------------- | -------- | ------------------------------------------------ | --------------------------------- |
| `.text-gradient`            | ~500-505 | `linear-gradient(135deg, hsl(var(--accent))...`  | `var(--gradient-brand-text)`      |
| `.arch-panel-bg`            | ~526-533 | `linear-gradient(180deg, hsl(var(--bg-elev))...` | `var(--gradient-surface-panel)`   |
| `.sidebar-bg`               | ~536-543 | `linear-gradient(180deg, hsl(220 3% 8%)...`      | `var(--gradient-surface-sidebar)` |
| `.empty-state-glow::before` | ~549-557 | `radial-gradient(circle at center, ...)`         | `var(--gradient-glow-accent)`     |
| `.skeleton`                 | ~625-635 | `linear-gradient(90deg, hsl(var(--bg-muted))...` | `var(--gradient-shimmer)`         |

The `.arch-panel-glow` at line ~1086 is kept as-is because it uses `box-shadow`, not a gradient.

### Task 3.2: Remove redundant light-theme class overrides

Remove from globals.css (inside `@layer base`, after the `[data-theme='light']` variable block):

- `[data-theme='light'] .arch-panel-bg { ... }` (lines ~293-300)
- `[data-theme='light'] .sidebar-bg { ... }` (lines ~302-304)
- `[data-theme='light'] .empty-state-glow::before { ... }` (lines ~306-308)

These are redundant because the aliases now reference CSS custom properties that already have `[data-theme='light']` overrides.

### Task 3.3: Reconcile `apps/studio/src/index.css` (GAP-001)

**File**: `apps/studio/src/index.css`

The `index.css` file is a diverged copy of the original design system. It contains its own `.text-gradient` and `.skeleton` definitions that differ from `globals.css`. After the gradient token migration:

1. **Determine if `index.css` is still imported**: Search the codebase for imports of `index.css`. If it is imported alongside `globals.css` by Studio's entry point, the duplicate definitions create CSS specificity conflicts.

2. **If imported**: Remove the `.text-gradient` definition from `index.css` (it is now in `globals.css` via token reference). Remove the `.skeleton` definition from `index.css` (same). Keep all other definitions in `index.css` that are not duplicated in `globals.css`.

3. **If NOT imported**: Mark `index.css` for deprecation. Add a comment at the top: `/* DEPRECATED: This file is superseded by globals.css. Schedule for removal. */`

**Specific changes to `index.css`**:

- Remove the `.text-gradient { ... }` block (lines ~354-360 in index.css)
- Remove the `.skeleton { ... }` block (lines ~386-396 in index.css)
- If no other unique classes remain in the `@layer utilities` block, consider removing the entire utilities block

### Exit Criteria

- [ ] `pnpm build --filter=@agent-platform/studio` passes
- [ ] Existing gradient visuals are unchanged (manual visual check in dark + light themes)
- [ ] grep for hardcoded `linear-gradient` in the `@layer utilities` section of `globals.css` returns 0 results (all utility class bodies use `var(--gradient-*)`, NOT hardcoded gradient values)
- [ ] No `[data-theme='light'] .arch-panel-bg`, `.sidebar-bg`, or `.empty-state-glow::before` class overrides remain
- [ ] `index.css` no longer contains `.text-gradient` or `.skeleton` definitions

---

## Phase 4: Migrate Inline Tailwind Gradients in Components

**Goal**: Replace all inline `bg-gradient-to-*` / `from-*` patterns in Studio components with centralized gradient utility classes.

**IMPORTANT**: Before modifying each component file, READ the file first to verify the exact class strings and element structure. Do not assume the feature spec's class strings are exact -- they may have been updated since the spec was written.

### Task 4.1: Onboarding components

**File**: `apps/studio/src/components/onboarding/RevealPhase.tsx`

- Search for `bg-gradient-to-r from-accent to-accent-muted` and `bg-gradient-to-br from-accent to-accent-muted`
- Replace with `bg-gradient-brand`
- Verify surrounding classes (padding, text color, rounded corners) are preserved

**File**: `apps/studio/src/components/onboarding/ReviewPhase.tsx`

- Search for `bg-gradient-to-r from-accent to-accent-muted`
- Replace with `bg-gradient-brand`

**File**: `apps/studio/src/components/onboarding/ArchOnboarding.tsx`

- Search for `bg-gradient-to-br from-background via-background to-background-subtle`
- Replace with `bg-gradient-surface-page`

**File**: `apps/studio/src/components/onboarding/WelcomePhase.tsx`

- Verify it uses `.empty-state-glow` (which is now an alias for the tokenized version)
- No class name change needed unless switching to the new canonical name `.gradient-glow-accent`

### Task 4.2: Arch AI

**File**: `apps/studio/src/components/arch/ArchPanel.tsx`

- Replace `.text-gradient` with `.text-gradient-brand`
- `.arch-panel-bg` is already an alias -- optionally replace with `.bg-gradient-surface-panel` (recommended for clarity, but not blocking)

### Task 4.3: Deploy/Billing

**File**: `apps/studio/src/components/deploy/DeployPanel.tsx`

- Search for `bg-gradient-to-r from-accent/10 to-accent/5`
- Replace with `bg-gradient-surface-accent`

**File**: `apps/studio/src/components/admin/BillingPage.tsx`

- Search for `bg-gradient-to-br from-accent/5 to-transparent`
- Replace with `bg-gradient-surface-accent`

### Task 4.4: Navigation

**File**: `apps/studio/src/components/navigation/ProjectSidebar.tsx`

- Replace `.sidebar-bg` with `.bg-gradient-surface-sidebar`

**File**: `apps/studio/src/components/navigation/AdminSidebar.tsx`

- Replace `.sidebar-bg` with `.bg-gradient-surface-sidebar`

**File**: `apps/studio/src/components/agent-editor/AgentEditorMenu.tsx`

- Replace `.sidebar-bg` with `.bg-gradient-surface-sidebar`

### Task 4.5: Preview pages

**File**: `apps/studio/src/app/preview/page.tsx`

- Search for `bg-gradient-to-br from-background to-background`
- Replace with `bg-gradient-surface-page`
- Note: The existing gradient is effectively a no-op (same color on both ends). The token version adds a subtle background-to-subtle transition, which is an intentional improvement.

**File**: `apps/studio/src/app/preview/[projectId]/page.tsx`

- Same pattern as above

### Task 4.6: Other

**File**: `apps/studio/src/components/search-ai/ChunkExplorer.tsx`

- Search for `bg-gradient-to-b from-accent/40 via-accent/20 to-transparent`
- Replace with `bg-gradient-brand-fade`

**File**: `apps/studio/src/components/ui/EmptyState.tsx`

- Verify it uses `.empty-state-glow` (alias works)
- No change needed unless switching to canonical `.gradient-glow-accent`

### Exit Criteria

- [ ] `pnpm build --filter=@agent-platform/studio` passes
- [ ] grep for `bg-gradient-to-` with `from-` in `apps/studio/src/components/` returns 0 results
- [ ] grep for `bg-gradient-to-` with `from-` in `apps/studio/src/app/` returns 0 results (excluding `globals.css` and `index.css`)
- [ ] All 14 component locations from the feature spec's Components to Migrate table have been verified

---

## Phase 5: Apply Net-New Gradient Tokens

**Goal**: Add gradient treatments to locations that currently have no gradient, using the newly defined tokens.

**Note**: This phase introduces visible design changes. Each change should be reviewed visually in both dark and light themes before committing.

### Task 5.1: Agent card hover border

- **Find**: The agent card component (search for the component rendered in the agent list/grid on the project dashboard).
- **Change**: Add `.border-gradient-brand` to the card's hover state. This can be done via conditional class application:
  ```tsx
  className={cn('...existing classes...', isHovered && 'border-gradient-brand')}
  ```
- **Constraint**: The agent card likely uses `::before` for something. Verify no conflict before applying. If conflict exists, wrap the card content in a container and apply the gradient border to the outer wrapper.
- **Verify**: Hover over cards in both themes. The gradient border should appear smoothly and respect `border-radius`.

### Task 5.2: Topology canvas ambient glow

- **Find**: `apps/studio/src/components/topology/TopologyCanvas.tsx`
- **Change**: Add `.gradient-glow-ambient` to the canvas container or a background layer element.
- **Effect**: Subtle purple/cyan radial glow on the canvas background, giving it an "AI workspace" feel.
- **Verify**: The glow should be barely perceptible -- it is ambient, not attention-grabbing.

### Task 5.3: Sidebar active indicator

- **Find**: The active nav item styling in `ProjectSidebar.tsx` and `AdminSidebar.tsx`.
- **Change**: Replace flat background highlight with a subtle gradient accent. Use `bg-gradient-brand-subtle` on the active item instead of a solid `bg-accent-subtle`.
- **Verify**: Active item should have a faint purple-to-cyan wash. Non-active items remain flat.

### Task 5.4: Deploy success banner

- **Find**: The deploy success state in `DeployPanel.tsx` or a deployment status component.
- **Change**: Add `.bg-gradient-status-success` to the success banner/notification.
- **Verify**: Success banner should show a green-to-teal gradient, more energetic than flat green.

### Exit Criteria

- [ ] `pnpm build --filter=@agent-platform/studio` passes
- [ ] Visual verification: agent card hover shows gradient border in dark and light themes
- [ ] Visual verification: topology canvas has subtle ambient glow
- [ ] Visual verification: sidebar active indicator uses gradient accent
- [ ] Visual verification: deploy success banner uses status gradient

---

## Wiring Checklist

This checklist verifies all integration points are connected:

- [ ] **TypeScript exports**: `packages/design-tokens/src/gradients.ts` exports `GradientToken`, `GradientStyles`, `GradientCategory`, `getGradientStyles`, `getGradientValue`, `GRADIENT_TOKENS`
- [ ] **Barrel re-export**: `packages/design-tokens/src/index.ts` re-exports ALL gradient API symbols (types and runtime values)
- [ ] **CSS token definitions**: ALL 14 `--gradient-*` custom properties defined in both `:root` and `[data-theme='light']` blocks inside `@layer base` in `globals.css`
- [ ] **CSS utility classes**: ALL gradient utility classes (`.bg-gradient-*`, `.text-gradient-brand`, `.border-gradient-brand`, `.gradient-glow-*`) defined in `@layer utilities` in `globals.css`
- [ ] **Utility classes reference vars**: ALL utility class bodies use `var(--gradient-*)` (not hardcoded gradient values)
- [ ] **Deprecation aliases**: Old class names (`.text-gradient`, `.arch-panel-bg`, `.sidebar-bg`, `.empty-state-glow`) rewritten to reference tokens
- [ ] **Light theme class overrides removed**: `[data-theme='light'] .arch-panel-bg`, `.sidebar-bg`, `.empty-state-glow::before` blocks deleted
- [ ] **index.css reconciled**: GAP-001 resolved -- `.text-gradient` and `.skeleton` removed from `index.css`
- [ ] **prefers-reduced-motion**: `@media (prefers-reduced-motion: reduce)` block gates `.skeleton` and `.skeleton-pulse` animation
- [ ] **Skeleton tokenized**: `.skeleton` background uses `var(--gradient-shimmer)` instead of hardcoded gradient
- [ ] **Component migrations**: All 14 component locations from the feature spec migrated (zero inline `bg-gradient-to-*` with `from-`)
- [ ] **Unit tests passing**: `packages/design-tokens/src/__tests__/gradients.test.ts` -- all U-1 through U-7 test scenarios green
- [ ] **Build passing**: `pnpm build --filter=@agent-platform/design-tokens` and `pnpm build --filter=@agent-platform/studio` both succeed

---

## Acceptance Criteria

All of the following must be true before the feature can be considered ALPHA:

- [ ] All 5 phases complete with their individual exit criteria met
- [ ] Unit tests for TypeScript API passing (12 test cases in `gradients.test.ts`)
- [ ] `pnpm build` passes for all affected packages (`@agent-platform/design-tokens`, `@agent-platform/studio`)
- [ ] Zero hardcoded `linear-gradient` or `radial-gradient` in `globals.css` utility classes (outside token definitions in `@layer base`)
- [ ] Zero inline `bg-gradient-to-*` with `from-` in Studio components and app pages
- [ ] 14 gradient CSS custom properties defined in `:root`
- [ ] 100% light-theme override coverage (14/14 tokens have `[data-theme='light']` overrides)
- [ ] `prefers-reduced-motion` gates all animated gradients (`.skeleton`, `.skeleton-pulse`)
- [ ] GAP-001 resolved (index.css divergence)
- [ ] GAP-002 resolved (skeleton reduced-motion gate)
- [ ] GAP-003 resolved (text gradient light-theme contrast)

---

## Risk Mitigations

| Risk                                                   | Phase | Mitigation                                                                                                                                                                        |
| ------------------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visual regression during migration                     | 3, 4  | Preserve exact current gradient values in token definitions. Deprecation aliases ensure old class names continue to work. Side-by-side visual comparison in both themes.          |
| Text gradient contrast drop in light theme (GAP-003)   | 1     | Light-theme `--gradient-brand-text` uses `hsl(220 5% 40%)` as lighter stop -- manually verify 4.5:1 contrast ratio against white (`hsl(0 0% 100%)`) background before committing. |
| `::before` pseudo-element conflict on gradient borders | 5     | Audit target elements for existing `::before` usage before applying `.border-gradient-brand`. Use wrapper elements for conflicts.                                                 |
| `index.css` removal breaks something                   | 3     | Grep for `index.css` imports before removing content. Test build after changes. Keep file but remove only duplicate gradient classes -- do not delete the file.                   |
| Skeleton shimmer broken by token indirection           | 3     | `--gradient-shimmer` uses exact same gradient values as current hardcoded `.skeleton`. `background-size` and `animation` are kept in the `.skeleton` rule, not in the token.      |

---

## Dependency Graph

```
Phase 1 (CSS tokens)
  |
  +---> Phase 2 (TypeScript API) [independent of Phase 1, can be parallel]
  |       |
  |       +---> Phase 2.4 (unit tests depend on 2.1)
  |
  +---> Phase 3 (migrate existing gradients, depends on Phase 1 token defs)
  |       |
  |       +---> Phase 3.3 (index.css reconciliation, depends on 3.1)
  |
  +---> Phase 4 (migrate component inline gradients, depends on Phase 1 utility classes)
          |
          +---> Phase 5 (net-new tokens, depends on Phase 1 utility classes)
```

**Parallelization**: Phases 1 and 2 can run in parallel since they modify different files (globals.css vs. design-tokens TypeScript). Phase 3 depends on Phase 1 completing (utility classes must be token-backed before removing light-theme class overrides). Phase 4 can start after Phase 1 utility classes are defined. Phase 5 is last since it introduces new visual changes.

**Recommended execution order**: 1 -> 2 (parallel) -> 3 -> 4 -> 5
