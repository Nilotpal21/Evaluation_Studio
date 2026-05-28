# SDLC Log: gradient-design-tokens — Phase 1 (Feature Spec)

**Date**: 2026-03-23
**Phase**: Feature Spec
**Artifact**: `docs/features/gradient-design-tokens.md`

## Codebase Analysis

Before writing the spec, thorough codebase analysis was performed:

### Files Analyzed

- `apps/studio/src/index.css` — Original design token file (Tailwind base layer)
- `apps/studio/src/app/globals.css` — Current design token file with `:root` variables, utility classes, and gradient definitions
- `packages/tailwind-config/base.js` — Shared Tailwind configuration (colors only, no gradients)
- `apps/studio/tailwind.config.js` — Studio-specific Tailwind config
- 15 component files with inline gradient usage (searched via grep)

### Current State

- **8 gradient definitions** in `globals.css` utility classes (all hardcoded HSL)
- **15+ inline Tailwind gradient classes** across components (`bg-gradient-to-*`)
- **0 CSS custom properties** for gradient values
- **0 Tailwind gradient utilities** in `packages/tailwind-config/base.js`
- **2 theme variants** needed (dark `:root` + `[data-theme='light']`)

### Gradient Patterns Identified

1. `.text-gradient` — 135deg accent text effect
2. `.arch-panel-bg` — 180deg panel background (dark + light overrides)
3. `.sidebar-bg` — 180deg sidebar vertical gradient
4. `.empty-state-glow::before` — Radial accent glow
5. `.skeleton` — 90deg shimmer gradient
6. `.arch-panel-glow` — Box-shadow border glow
7. Inline `from-accent to-accent-muted` — CTA buttons (onboarding, deploy, review)
8. Inline `from-background to-background` — Full-page backgrounds

## Product Oracle Decisions

| Question                                             | Classification | Decision                                                                         |
| ---------------------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| Should we create a `packages/design-tokens` package? | DECIDED        | No — follows existing architecture where all tokens live in `globals.css`        |
| Should SVG gradients in ProviderIcons be tokenized?  | DECIDED        | No — data-driven, not design system tokens                                       |
| Should we create animated gradient tokens?           | DECIDED        | No — out of scope, separate feature                                              |
| Composite tokens vs stop-only tokens?                | DECIDED        | Both — composite for ergonomics, stops exposed for override                      |
| Token naming convention?                             | DECIDED        | `--gradient-{semantic-name}` following existing `--{category}-{variant}` pattern |

## Phase Auditor Findings

### Round 1

| Severity | Finding                                                                                   | Resolution                                                 |
| -------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| INFO     | Feature scope is well-bounded to refactoring existing patterns                            | No action needed                                           |
| INFO     | Dependencies clearly identified with file paths                                           | No action needed                                           |
| LOW      | Consider mentioning the `page-comfortable`/`page-compact` density classes as non-affected | Added to out-of-scope implicitly (no gradient involvement) |

All findings resolved. No CRITICAL or HIGH issues.

## Summary

Feature spec generated with 8 functional requirements, 5 non-functional requirements, 3 user stories, and a gradient token catalog mapping 8 existing patterns to proposed tokens. Scope is tightly bounded to tokenizing existing gradients, not creating new ones.
