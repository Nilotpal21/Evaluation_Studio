# Feature Spec: Gradient Design Tokens

**Feature ID**: #75
**Status**: PLANNED
**Author**: SDLC Pipeline
**Created**: 2026-03-23
**Last Updated**: 2026-03-23

---

## Problem Statement

The Studio application uses gradients extensively across the UI — for panel backgrounds (`.arch-panel-bg`, `.sidebar-bg`), text effects (`.text-gradient`), decorative glows (`.empty-state-glow`), loading states (`.skeleton`), and inline Tailwind utilities (`bg-gradient-to-*`). However, all gradient definitions are **hardcoded** directly in `globals.css` utility classes or inline in component className strings. There are no CSS custom properties for gradient color stops, directions, or composite gradients.

This creates several problems:

1. **Inconsistency**: The same gradient concept (e.g., "accent gradient") is defined differently in `.text-gradient` (135deg, accent to 220 5% 75%), in `.arch-panel-bg` (180deg, elevated to 220 4% 10% to elevated), and inline Tailwind classes (`from-accent to-accent-muted`). Three different accent gradients, none canonical.
2. **Theme brittleness**: Dark/light theme overrides must duplicate entire gradient rules (e.g., `[data-theme='light'] .arch-panel-bg` redefines the full gradient). Changing a gradient requires editing multiple locations.
3. **No reuse via Tailwind**: The `packages/tailwind-config/base.js` has zero gradient-related configuration. Components cannot compose gradients via Tailwind classes backed by design tokens.
4. **Maintenance burden**: Adding a new gradient pattern means copying HSL values from `:root`, writing a new CSS class, adding a light-theme override, and hoping it matches the system's visual language. Nothing enforces consistency.
5. **No gradient catalog**: Developers have no reference for which gradients exist or when to use each one, leading to ad-hoc gradient creation.

## Scope

### In Scope

- **Define gradient CSS custom properties** in `:root` (dark) and `[data-theme='light']` blocks within `globals.css`
- **Create semantic gradient tokens** for common patterns: panel backgrounds, text gradients, decorative glows, skeleton shimmers, hero/CTA accents, and border glows
- **Extend Tailwind configuration** in `packages/tailwind-config/base.js` to expose gradient tokens as Tailwind utilities (e.g., `bg-gradient-panel`, `text-gradient-accent`)
- **Refactor existing gradient usage** in `globals.css` utility classes to consume the new tokens instead of hardcoded values
- **Refactor inline Tailwind gradient classes** in components to use the new semantic gradient utilities
- **Document the gradient token catalog** with usage guidelines (which gradient for which context)

### Out of Scope

- Animated gradient effects (e.g., animated meshes, moving color stops) — these require JS runtime and are a separate feature
- SVG gradient definitions in component code (e.g., `ProviderIcons.tsx`, `shared.tsx` chart gradients) — these are data-driven and domain-specific, not design tokens
- Creating a standalone `packages/design-tokens` package — tokens remain in `globals.css` and `tailwind-config`, following the existing architecture
- Gradient editor or visual tooling in Studio
- Brand-new gradient patterns not already present in the codebase — this feature tokenizes what exists, not invents new ones

## Requirements

### Functional Requirements

| ID   | Requirement                                                                                                                         | Priority |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-1 | Define CSS custom properties for gradient color stops (start, mid, end HSL values) in `:root`                                       | MUST     |
| FR-2 | Define CSS custom properties for gradient directions (panel-vertical, diagonal, radial-center)                                      | MUST     |
| FR-3 | Define semantic gradient composite tokens (e.g., `--gradient-panel`, `--gradient-text-accent`, `--gradient-skeleton`)               | MUST     |
| FR-4 | Provide light-theme overrides for all gradient tokens in `[data-theme='light']`                                                     | MUST     |
| FR-5 | Extend `packages/tailwind-config/base.js` with gradient-related backgroundImage utilities                                           | MUST     |
| FR-6 | Refactor `.text-gradient`, `.arch-panel-bg`, `.sidebar-bg`, `.empty-state-glow`, `.skeleton` in `globals.css` to consume new tokens | MUST     |
| FR-7 | Refactor inline Tailwind gradient classes in components to use semantic gradient utilities where applicable                         | SHOULD   |
| FR-8 | All existing visual appearances must remain identical after refactor (visual regression-free)                                       | MUST     |

### Non-Functional Requirements

| ID    | Requirement                                                                                                                  | Priority |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| NFR-1 | Zero runtime JS — all tokens are CSS custom properties resolved by the browser                                               | MUST     |
| NFR-2 | No increase in CSS bundle size beyond 500 bytes (tokens replace hardcoded values)                                            | SHOULD   |
| NFR-3 | Compatible with Tailwind v3 JIT mode via `packages/tailwind-config`                                                          | MUST     |
| NFR-4 | Tokens must follow existing naming convention: `--{category}-{variant}` (e.g., `--gradient-panel`, `--gradient-text-accent`) | MUST     |
| NFR-5 | No breaking changes to existing component className APIs                                                                     | MUST     |

## User Stories

### US-1: Developer Applying a Gradient

**As a** Studio developer,
**I want to** apply the standard panel background gradient using a single Tailwind class (e.g., `bg-gradient-panel`),
**So that** I don't need to remember hardcoded HSL values or copy gradient definitions from other components.

**Acceptance Criteria:**

- A Tailwind class `bg-gradient-panel` applies the same gradient as the current `.arch-panel-bg` class
- The gradient automatically adapts to light/dark theme
- No inline `style` or custom CSS needed

### US-2: Developer Creating a Themed Gradient

**As a** Studio developer,
**I want to** override gradient color stops by changing CSS custom properties,
**So that** if the design system's accent gradient changes, all consumers update automatically.

**Acceptance Criteria:**

- Changing `--gradient-stop-accent-start` in `:root` updates `.text-gradient`, onboarding CTA buttons, and any component using the accent gradient
- Light-theme overrides are isolated to `[data-theme='light']` and do not leak

### US-3: Designer Auditing Gradient Consistency

**As a** design system maintainer,
**I want to** see all gradient tokens defined in one section of `globals.css`,
**So that** I can audit the system's gradient palette without searching across 15+ files.

**Acceptance Criteria:**

- All gradient token definitions are in a single `GRADIENT TOKENS` section in `globals.css`
- Each token has a comment describing its use case
- No hardcoded gradient values remain in utility classes (they all reference tokens)

## Gradient Token Catalog

Based on codebase analysis, the following gradient patterns exist and should be tokenized:

| Token Name               | Current Source                         | Type          | Usage                            |
| ------------------------ | -------------------------------------- | ------------- | -------------------------------- |
| `--gradient-panel`       | `.arch-panel-bg`                       | linear 180deg | Arch AI panel background         |
| `--gradient-sidebar`     | `.sidebar-bg`                          | linear 180deg | Sidebar vertical gradient        |
| `--gradient-text-accent` | `.text-gradient`                       | linear 135deg | Gradient text effect (accent)    |
| `--gradient-glow-radial` | `.empty-state-glow::before`            | radial        | Empty state decorative glow      |
| `--gradient-skeleton`    | `.skeleton`                            | linear 90deg  | Skeleton loader shimmer          |
| `--gradient-accent-cta`  | inline `from-accent to-accent-muted`   | linear to-r   | CTA buttons (onboarding, deploy) |
| `--gradient-page-bg`     | inline `from-background to-background` | linear to-br  | Full-page backgrounds            |
| `--gradient-border-glow` | `.arch-panel-glow`                     | box-shadow    | Panel border glow (AI context)   |

## Dependencies

- `apps/studio/src/app/globals.css` — primary token definition file
- `packages/tailwind-config/base.js` — Tailwind utility configuration
- `apps/studio/tailwind.config.js` — Studio-specific Tailwind overrides
- Components consuming inline gradients: `ArchOnboarding.tsx`, `RevealPhase.tsx`, `ReviewPhase.tsx`, `DeployPanel.tsx`, `BillingPage.tsx`, `ChunkExplorer.tsx`, `preview/page.tsx`, `preview/[projectId]/page.tsx`

## Risks & Mitigations

| Risk                                                        | Impact | Mitigation                                                                  |
| ----------------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| Visual regression from refactoring                          | HIGH   | Side-by-side screenshot comparison before/after for each affected component |
| Tailwind JIT not generating gradient utilities              | MEDIUM | Verify via `pnpm build --filter=studio` that classes are present in output  |
| CSS specificity conflicts with existing utility classes     | LOW    | New tokens are consumed inside existing utility classes, not replacing them |
| Light-theme gradient tokens not matching current appearance | MEDIUM | Test both themes explicitly in visual regression checks                     |

## Decision Log

| Decision                                                                   | Classification | Rationale                                                                                                                                      |
| -------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep tokens in `globals.css` rather than creating `packages/design-tokens` | DECIDED        | Follows existing architecture; all color tokens are already in `globals.css`. A separate package adds complexity with no immediate benefit.    |
| Use CSS custom properties for composite gradients, not just color stops    | DECIDED        | Allows `background: var(--gradient-panel)` which is more ergonomic than assembling from parts. Individual stops are also exposed for override. |
| Expose via Tailwind `backgroundImage` extension, not custom plugin         | DECIDED        | Simpler, no plugin API complexity, matches Tailwind v3 patterns.                                                                               |
| Tokenize only existing patterns, not create new ones                       | DECIDED        | This is a refactoring feature. New gradient patterns belong in their own feature tickets.                                                      |
| SVG gradients in ProviderIcons and chart components are out of scope       | DECIDED        | These are data-driven (different per provider/series), not design system tokens.                                                               |
