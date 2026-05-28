# HLD: Gradient Design Tokens

**Feature**: Gradient Design Tokens (#75)
**Status**: PLANNED
**Author**: SDLC Pipeline
**Created**: 2026-03-23
**Last Updated**: 2026-03-23
**Feature Spec**: `docs/features/gradient-design-tokens.md`
**Test Spec**: `docs/testing/gradient-design-tokens.md`

---

## 1. Overview

This design introduces a gradient token layer into the existing CSS custom property design system in `apps/studio/src/app/globals.css` and extends the shared Tailwind configuration in `packages/tailwind-config/base.js`. The goal is to replace 8 hardcoded gradient patterns with semantic, themeable, composable tokens — achieving visual consistency across the Studio UI while maintaining zero-regression visual fidelity.

## 2. Architecture

### 2.1 Current State

```
┌─────────────────────────────────────────────────────┐
│ globals.css (:root)                                  │
│  Color tokens: --background, --accent, --success ... │
│  (NO gradient tokens)                                │
└──────────┬──────────────────────────────────────────┘
           │
     ┌─────┴─────────────────────┐
     │                           │
┌────▼──────────┐    ┌──────────▼───────────┐
│ globals.css   │    │ Component files       │
│ Utility CSS   │    │ (inline className)    │
│               │    │                       │
│ .text-gradient│    │ bg-gradient-to-r      │
│ .arch-panel-bg│    │ from-accent           │
│ .sidebar-bg   │    │ to-accent-muted       │
│ .skeleton     │    │ from-background       │
│ .empty-state  │    │ to-background         │
│ (hardcoded)   │    │ (Tailwind built-ins)  │
└───────────────┘    └───────────────────────┘
```

**Problem**: Gradient definitions are duplicated, inconsistent, and not theme-aware at the token level.

### 2.2 Target State

```
┌──────────────────────────────────────────────────────────────┐
│ globals.css (:root)                                           │
│  Color tokens: --background, --accent, --success ...          │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ GRADIENT TOKENS (new section)                         │    │
│  │  Stops: --gradient-stop-panel-start, -mid, -end       │    │
│  │  Stops: --gradient-stop-accent-start, -end            │    │
│  │  Composites: --gradient-panel, --gradient-sidebar,    │    │
│  │   --gradient-text-accent, --gradient-glow-radial,     │    │
│  │   --gradient-skeleton, --gradient-accent-cta,         │    │
│  │   --gradient-page-bg, --gradient-border-glow          │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│ globals.css ([data-theme='light'])                            │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ GRADIENT TOKEN OVERRIDES                              │    │
│  │  (same tokens, light-appropriate values)              │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────┬──────────────────────────────────────────────────┘
           │
     ┌─────┴─────────────────────────────────────────┐
     │                                               │
┌────▼──────────────┐    ┌──────────────────────────▼───┐
│ globals.css       │    │ tailwind-config/base.js       │
│ Utility CSS       │    │ (new backgroundImage entries) │
│                   │    │                               │
│ .text-gradient    │    │ gradient-panel: var(...)       │
│   → var(--g-text) │    │ gradient-sidebar: var(...)     │
│ .arch-panel-bg    │    │ gradient-text-accent: var(...) │
│   → var(--g-panel)│    │ gradient-accent-cta: var(...)  │
│ .sidebar-bg       │    │ gradient-page-bg: var(...)     │
│   → var(--g-side) │    └──────────┬──────────────────┘
│ .skeleton         │               │
│   → var(--g-skel) │    ┌──────────▼──────────────────┐
│ .empty-state      │    │ Component files              │
│   → var(--g-glow) │    │ (semantic Tailwind classes)  │
└───────────────────┘    │                              │
                         │ bg-gradient-page-bg           │
                         │ bg-gradient-accent-cta        │
                         │ (token-backed)                │
                         └──────────────────────────────┘
```

### 2.3 Data Flow

1. **Token definition**: CSS custom properties in `:root` and `[data-theme='light']` in `globals.css`
2. **Token consumption (CSS utilities)**: Existing utility classes in `globals.css` `@layer utilities` reference `var(--gradient-*)` instead of hardcoded values
3. **Token consumption (Tailwind)**: `packages/tailwind-config/base.js` adds `backgroundImage` entries that reference `var(--gradient-*)`, enabling classes like `bg-gradient-panel`
4. **Theme switching**: Browser resolves CSS custom properties based on `[data-theme]` attribute on `<html>` — zero JS involvement

## 3. Token Design

### 3.1 Gradient Color Stop Tokens

These are the atomic building blocks — individual HSL color values used as gradient stops.

```css
:root {
  /* Panel gradient stops (vertical panel backgrounds) */
  --gradient-stop-panel-start: var(--background-elevated);
  --gradient-stop-panel-mid: 220 4% 10%;
  --gradient-stop-panel-end: var(--background-elevated);

  /* Sidebar gradient stops */
  --gradient-stop-sidebar-start: 220 3% 8%;
  --gradient-stop-sidebar-mid: var(--background-subtle);
  --gradient-stop-sidebar-end: var(--background-subtle);

  /* Accent gradient stops (text, CTAs) */
  --gradient-stop-accent-start: var(--accent);
  --gradient-stop-accent-end: 220 5% 75%;

  /* Skeleton shimmer stops */
  --gradient-stop-skeleton-start: var(--background-muted);
  --gradient-stop-skeleton-mid: var(--background-elevated);
  --gradient-stop-skeleton-end: var(--background-muted);

  /* Radial glow stops */
  --gradient-stop-glow-center: var(--accent);
  --gradient-stop-glow-opacity: 0.07;
}
```

### 3.2 Composite Gradient Tokens

These are the semantic, ready-to-use gradient values.

```css
:root {
  /* Panel background — vertical fade through mid-tone */
  --gradient-panel: linear-gradient(
    180deg,
    hsl(var(--gradient-stop-panel-start)) 0%,
    hsl(var(--gradient-stop-panel-mid)) 50%,
    hsl(var(--gradient-stop-panel-end)) 100%
  );

  /* Sidebar — vertical fade */
  --gradient-sidebar: linear-gradient(
    180deg,
    hsl(var(--gradient-stop-sidebar-start)) 0%,
    hsl(var(--gradient-stop-sidebar-mid)) 30%,
    hsl(var(--gradient-stop-sidebar-end)) 100%
  );

  /* Text accent — diagonal for text gradient effect */
  --gradient-text-accent: linear-gradient(
    135deg,
    hsl(var(--gradient-stop-accent-start)) 0%,
    hsl(var(--gradient-stop-accent-end)) 100%
  );

  /* Skeleton shimmer — horizontal for animation */
  --gradient-skeleton: linear-gradient(
    90deg,
    hsl(var(--gradient-stop-skeleton-start)) 0%,
    hsl(var(--gradient-stop-skeleton-mid)) 50%,
    hsl(var(--gradient-stop-skeleton-end)) 100%
  );

  /* Radial glow — empty states, decorative */
  --gradient-glow-radial: radial-gradient(
    circle at center,
    hsl(var(--gradient-stop-glow-center) / var(--gradient-stop-glow-opacity)) 0%,
    transparent 70%
  );

  /* Accent CTA — horizontal accent gradient */
  --gradient-accent-cta: linear-gradient(
    to right,
    hsl(var(--accent)) 0%,
    hsl(var(--accent-muted)) 100%
  );

  /* Page background — subtle diagonal */
  --gradient-page-bg: linear-gradient(
    to bottom right,
    hsl(var(--background)) 0%,
    hsl(var(--background)) 50%,
    hsl(var(--background-subtle)) 100%
  );
}
```

### 3.3 Light Theme Overrides

```css
[data-theme='light'] {
  /* Panel gradient — lighter mid-tone */
  --gradient-stop-panel-mid: 220 4% 98%;

  /* Sidebar — pure white fade */
  --gradient-stop-sidebar-start: 0 0% 100%;
  --gradient-stop-sidebar-mid: 0 0% 100%;
  --gradient-stop-sidebar-end: 0 0% 100%;

  /* Accent text — darker for light backgrounds */
  --gradient-stop-accent-end: 220 5% 35%;

  /* Radial glow — more subtle */
  --gradient-stop-glow-opacity: 0.04;
}
```

## 4. Tailwind Integration

### 4.1 Configuration Extension

In `packages/tailwind-config/base.js`:

```js
export default {
  theme: {
    extend: {
      // ... existing colors ...
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
};
```

### 4.2 Usage Examples

```tsx
// Before (inline Tailwind gradients):
<div className="bg-gradient-to-br from-background via-background to-background-subtle">

// After (semantic token):
<div className="bg-gradient-page-bg">

// Before (CSS utility class):
<span className="text-gradient">

// After (unchanged — .text-gradient now backed by token internally):
<span className="text-gradient">
```

## 5. Twelve Architectural Concerns

### 5.1 Performance

- **Zero runtime JS**: All tokens are CSS custom properties resolved by the browser's style engine
- **No additional HTTP requests**: Tokens are in the same CSS file already loaded
- **CSS bundle size**: Net-neutral — tokens replace hardcoded values. Stop tokens add ~400 bytes, but removed hardcoded values reclaim equivalent space
- **No layout thrash**: Gradient changes via theme toggle are handled by CSS transitions already in place (`.theme-transition`)

### 5.2 Security

- **No security implications**: This is a CSS-only change with no user input, no data handling, no API surface
- **No XSS risk**: CSS custom properties cannot execute JavaScript

### 5.3 Scalability

- **Adding new gradients**: Define stops in `:root`, create composite token, add light override, add Tailwind entry. ~5 lines per gradient.
- **Cross-app reuse**: `packages/tailwind-config/base.js` is shared across apps. Any app importing the preset gets gradient utilities.

### 5.4 Reliability

- **Backward compatibility**: All existing CSS class names are preserved. They are refactored internally but their API (class name → visual output) is unchanged.
- **Fallback behavior**: If a CSS custom property is undefined, the browser ignores the entire `var()` expression. This is a hard failure, but since tokens are defined in the same file that consumes them, this risk is near-zero.

### 5.5 Observability

- **Not applicable**: CSS tokens are not runtime-observable. Developer tooling (browser DevTools) already shows computed CSS variable values.
- **Build-time verification**: The integration tests verify tokens are present in built CSS output.

### 5.6 Data Model

- **No data model changes**: This feature is entirely in the CSS/Tailwind configuration layer. No database, no API, no state.

### 5.7 API Design

- **CSS API**: Token names follow `--gradient-{semantic-name}` convention
- **Tailwind API**: Class names follow `bg-gradient-{semantic-name}` convention
- **Both are additive**: New tokens/classes are added; existing ones are preserved

### 5.8 Error Handling

- **Invalid token reference**: Browser silently ignores, element gets no gradient. This is the standard CSS behavior and acceptable for a design system.
- **Missing light override**: Gradient defaults to dark-theme value. Integration tests verify completeness.

### 5.9 Testing Strategy

- **42 tests** across unit (8), integration (19), and E2E (15)
- **Visual regression**: Playwright screenshot comparison with 1% diff threshold
- **Build verification**: Token presence in production CSS bundle
- See `docs/testing/gradient-design-tokens.md` for full test spec

### 5.10 Migration / Backward Compatibility

- **No migration needed**: Existing class names (`.text-gradient`, `.arch-panel-bg`, `.sidebar-bg`, `.empty-state-glow`, `.skeleton`) continue to work identically
- **Component refactoring**: Optional — components can switch from inline Tailwind gradients to semantic classes at their own pace (FR-7 is SHOULD, not MUST)
- **Zero breaking changes**: NFR-5 mandates this

### 5.11 Deployment

- **No deployment changes**: This is a CSS change bundled into the existing Studio build
- **No feature flags needed**: Changes are visual-regression-free by design
- **Rollback**: Standard git revert — tokens are removed, hardcoded values restored

### 5.12 Compliance / Accessibility

- **WCAG AA contrast**: Gradient text must maintain >= 4.5:1 contrast ratio. E2E tests verify this.
- **No new motion**: No animated gradients introduced (out of scope)
- **prefers-reduced-motion**: Not affected — gradient tokens are static; existing animations (skeleton shimmer) are unchanged

## 6. Alternatives Considered

### 6.1 Separate `packages/design-tokens` Package

**Approach**: Create a standalone package that exports tokens as JSON/TS objects, then generates CSS from them.

**Pros**: Type-safe token access, cross-platform (React Native, Figma), single source of truth.

**Cons**: Adds build complexity, requires CSS generation step, overkill for 8 gradient tokens when all existing tokens are in `globals.css`.

**Decision**: Rejected. Follow existing architecture. If the token count grows significantly, this can be revisited.

### 6.2 Tailwind Plugin Instead of `backgroundImage` Extension

**Approach**: Write a custom Tailwind plugin that auto-generates gradient utility classes from CSS custom property names.

**Pros**: More dynamic, auto-discovers new tokens.

**Cons**: Plugin API complexity, harder to debug, no meaningful benefit for a fixed set of 8 tokens.

**Decision**: Rejected. Simple `backgroundImage` extension is sufficient and transparent.

### 6.3 CSS `@property` for Animated Gradients

**Approach**: Use CSS `@property` to register gradient stops as animatable custom properties, enabling smooth gradient transitions.

**Pros**: Enables animated gradient effects (e.g., hover color shifts).

**Cons**: Limited browser support (no Firefox < 128), adds complexity, animated gradients are explicitly out of scope.

**Decision**: Rejected for now. Can be layered on top of the token system later as a separate feature.

### 6.4 Token-Only (No Tailwind Integration)

**Approach**: Define CSS custom properties but do not add Tailwind `backgroundImage` entries. Components use `style={{ background: 'var(--gradient-panel)' }}`.

**Pros**: Simpler change, no Tailwind config modification.

**Cons**: Loses Tailwind's JIT benefits (purging, responsive modifiers, arbitrary variants). Forces inline `style` attributes, which are less ergonomic and harder to maintain.

**Decision**: Rejected. Tailwind integration is essential for developer experience.

## 7. Affected Files

| File                                                       | Change Type | Description                                                                                              |
| ---------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/app/globals.css`                          | MODIFY      | Add gradient token section to `:root` and `[data-theme='light']`; refactor utility classes to use tokens |
| `packages/tailwind-config/base.js`                         | MODIFY      | Add `backgroundImage` entries for gradient tokens                                                        |
| `apps/studio/src/index.css`                                | MODIFY      | Refactor `.text-gradient` to use token (if still present)                                                |
| `apps/studio/src/components/onboarding/ArchOnboarding.tsx` | MODIFY      | Replace inline gradient classes with semantic utility                                                    |
| `apps/studio/src/components/onboarding/RevealPhase.tsx`    | MODIFY      | Replace inline gradient classes with semantic utility                                                    |
| `apps/studio/src/components/onboarding/ReviewPhase.tsx`    | MODIFY      | Replace inline gradient classes with semantic utility                                                    |
| `apps/studio/src/components/deploy/DeployPanel.tsx`        | MODIFY      | Replace inline gradient classes with semantic utility                                                    |
| `apps/studio/src/components/admin/BillingPage.tsx`         | MODIFY      | Replace inline gradient classes with semantic utility                                                    |
| `apps/studio/src/components/search-ai/ChunkExplorer.tsx`   | MODIFY      | Replace inline gradient classes with semantic utility                                                    |
| `apps/studio/src/app/preview/page.tsx`                     | MODIFY      | Replace inline gradient classes with semantic utility                                                    |
| `apps/studio/src/app/preview/[projectId]/page.tsx`         | MODIFY      | Replace inline gradient classes with semantic utility                                                    |

## 8. Risk Assessment

| Risk                                              | Likelihood | Impact | Mitigation                                              |
| ------------------------------------------------- | ---------- | ------ | ------------------------------------------------------- |
| Visual regression from token refactor             | LOW        | HIGH   | Screenshot-based E2E tests with 1% diff threshold       |
| Tailwind JIT fails to generate gradient classes   | LOW        | MEDIUM | Build verification integration test (IT-11)             |
| Light-theme gradients don't match pre-refactor    | MEDIUM     | MEDIUM | Explicit light-theme E2E tests (E2E-2, E2E-4, E2E-6)    |
| CSS variable resolution order issues              | LOW        | LOW    | Variables defined before consumption in same file       |
| Breaking existing `.text-gradient` class behavior | LOW        | HIGH   | Backward compatibility test (IT Integration Scenario 7) |
