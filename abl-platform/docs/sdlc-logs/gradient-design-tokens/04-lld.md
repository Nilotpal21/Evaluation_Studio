# SDLC Log: gradient-design-tokens — Phase 4 (LLD)

**Date**: 2026-03-23
**Phase**: Low-Level Design + Implementation Plan
**Artifact**: `docs/plans/2026-03-23-gradient-design-tokens-impl-plan.md`

## Implementation Plan Summary

5 sequential phases:

1. **Token Definitions** — Add gradient CSS custom properties to `:root` and `[data-theme='light']` in `globals.css`
2. **CSS Utility Refactor** — Update `.arch-panel-bg`, `.sidebar-bg`, `.text-gradient`, `.empty-state-glow`, `.skeleton` to consume tokens; remove light-theme overrides
3. **Tailwind Config** — Add 7 `backgroundImage` entries to `packages/tailwind-config/base.js`
4. **Component Refactor** — Replace inline Tailwind gradient classes with semantic `bg-gradient-*` utilities in 5 components
5. **Build & Cleanup** — Full build verification, duplicate removal, visual regression check

## Key Design Decisions

| Decision                                                                        | Rationale                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Components with opacity-variant gradients (`from-accent/10`) are NOT refactored | Tailwind opacity modifiers cannot be replicated via `var()` tokens; keeping them as-is avoids visual regression |
| `--gradient-border-glow` is NOT added to Tailwind `backgroundImage`             | It's a box-shadow, not a backgroundImage — wrong Tailwind extension point                                       |
| `RevealPhase.tsx` icon gradient kept as-is                                      | Uses `bg-gradient-to-br` (diagonal) while token is `to right`; different direction, different purpose           |
| `DeployPanel.tsx` header kept as-is                                             | Uses `from-accent/10 to-accent/5` — unique opacity variant not covered by tokens                                |
| `BillingPage.tsx` decorative gradient kept as-is                                | Uses `from-accent/5 to-transparent` — unique fade pattern                                                       |
| `ChunkExplorer.tsx` vertical line kept as-is                                    | Uses `from-accent/40 via-accent/20 to-transparent` — unique multi-stop opacity variant                          |

## Wiring Checklist (16 items)

All items tracked in LLD. Key wiring points:

- 7 composite tokens wired to `:root`
- 5 CSS utility classes refactored to consume tokens
- 3 light-theme gradient overrides removed (replaced by token stop overrides)
- 7 Tailwind `backgroundImage` entries added
- ~10 component gradient class replacements

## Product Oracle Decisions

| Question                                                                      | Classification | Decision                                                                      |
| ----------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| Should opacity-variant gradients in components be tokenized?                  | DECIDED        | No — Tailwind opacity modifiers can't be replicated via CSS variable tokens   |
| Should Phase 2 and Phase 3 run in parallel?                                   | DECIDED        | No — sequential execution is safer for visual regression checking             |
| Should `index.css` gradient definitions be removed in favor of `globals.css`? | INFERRED       | Depends on which file is canonical — check if both are loaded and deduplicate |

## Phase Auditor Findings

### Round 1

| Severity | Finding                                                                                               | Resolution                                 |
| -------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| INFO     | 5 phases with clear exit criteria                                                                     | No action needed                           |
| INFO     | Component refactoring correctly identifies which gradients to keep vs refactor                        | No action needed                           |
| LOW      | Phase 2.7 mentions `index.css` skeleton but doesn't confirm it exists                                 | Added note to verify during implementation |
| LOW      | Consider noting that `background-size: 200% 100%` must come after `background: var(...)` for skeleton | Added to Risk Log                          |

### Round 2

| Severity | Finding                                                                      | Resolution       |
| -------- | ---------------------------------------------------------------------------- | ---------------- |
| INFO     | Wiring checklist is comprehensive (16 items)                                 | No action needed |
| INFO     | Risk log correctly identifies `.skeleton` `background-size` ordering concern | No action needed |
| LOW      | Estimated effort seems accurate for CSS-only changes                         | No action needed |

### Round 3

| Severity | Finding                                                  | Resolution                                                  |
| -------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| INFO     | Phase dependencies are clearly documented (linear chain) | No action needed                                            |
| LOW      | Consider adding a rollback plan note                     | Rollback is standard git revert — noted in HLD Section 5.11 |

### Round 4

| Severity | Finding                                                                               | Resolution       |
| -------- | ------------------------------------------------------------------------------------- | ---------------- |
| INFO     | All before/after code samples are precise with line numbers                           | No action needed |
| INFO     | Component refactoring map correctly distinguishes exact matches from opacity variants | No action needed |

### Round 5

| Severity | Finding                                        | Resolution       |
| -------- | ---------------------------------------------- | ---------------- |
| INFO     | Final review — LLD is production-ready         | No action needed |
| INFO     | All previous findings resolved, no regressions | No action needed |

All 5 audit rounds completed. No CRITICAL or HIGH findings across all rounds.

## Summary

LLD provides a 5-phase implementation plan with 16 wiring checklist items, per-phase exit criteria, and detailed before/after code samples for every file change. Key architectural choice: only refactor exact gradient matches, leave opacity-variant gradients unchanged. Estimated ~1.5 hours of implementation effort. 5 audit rounds completed with no critical findings.
