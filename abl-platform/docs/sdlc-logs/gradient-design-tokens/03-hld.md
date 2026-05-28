# SDLC Log: gradient-design-tokens — Phase 3 (HLD)

**Date**: 2026-03-23
**Phase**: High-Level Design
**Artifact**: `docs/specs/gradient-design-tokens.hld.md`

## Architecture Decisions

### Token Layering Strategy

**Decision**: Two-tier token system — atomic stops + semantic composites.

- **Atomic stops** (`--gradient-stop-panel-start`, etc.) allow fine-grained overrides
- **Composite tokens** (`--gradient-panel`, etc.) provide ergonomic single-property consumption
- Light-theme overrides only need to change atomic stops; composites resolve automatically

### Tailwind Integration Approach

**Decision**: Extend `backgroundImage` in Tailwind theme config, not create a custom plugin.

- 8 static entries in `backgroundImage` — transparent, debuggable, no plugin API complexity
- Enables `bg-gradient-panel` class with full Tailwind modifier support (responsive, hover, etc.)

### File Organization

**Decision**: Keep all tokens in `globals.css` within a new `GRADIENT TOKENS` section.

- Follows existing pattern where color tokens, spacing tokens, and animation tokens are all in `globals.css`
- No new files or packages created
- Light overrides in the existing `[data-theme='light']` block

## 12 Architectural Concerns Addressed

| #   | Concern        | Status    | Notes                                      |
| --- | -------------- | --------- | ------------------------------------------ |
| 1   | Performance    | ADDRESSED | Zero JS, zero HTTP, CSS-only               |
| 2   | Security       | N/A       | No user input, no API surface              |
| 3   | Scalability    | ADDRESSED | ~5 lines to add new gradient               |
| 4   | Reliability    | ADDRESSED | Backward compatible, same CSS class API    |
| 5   | Observability  | N/A       | CSS-only, DevTools sufficient              |
| 6   | Data Model     | N/A       | No database changes                        |
| 7   | API Design     | ADDRESSED | `--gradient-{name}` / `bg-gradient-{name}` |
| 8   | Error Handling | ADDRESSED | Standard CSS fallback behavior             |
| 9   | Testing        | ADDRESSED | 42 tests, visual regression                |
| 10  | Migration      | ADDRESSED | Zero breaking changes                      |
| 11  | Deployment     | ADDRESSED | Standard build, no feature flags           |
| 12  | Compliance     | ADDRESSED | WCAG AA contrast verified in E2E           |

## Alternatives Evaluated

1. **Separate `packages/design-tokens` package** — Rejected (overkill for 8 tokens)
2. **Tailwind plugin** — Rejected (unnecessary complexity)
3. **CSS `@property` for animation** — Rejected (out of scope, browser support)
4. **Token-only, no Tailwind** — Rejected (poor DX, no JIT benefits)

## Product Oracle Decisions

| Question                                                        | Classification | Decision                                                                                                                     |
| --------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Should composite tokens use `var()` references to atomic stops? | DECIDED        | Yes — enables light-theme overrides at the stop level                                                                        |
| Should we add `gradient-border-glow` as a Tailwind utility?     | DECIDED        | No — box-shadow gradients are not `backgroundImage` and don't fit the Tailwind extension pattern. Keep as CSS utility class. |
| Should `--gradient-page-bg` include `via-background`?           | INFERRED       | Yes — current usage is `from-background via-background to-background-subtle`, preserving the three-stop pattern              |

## Phase Auditor Findings

### Round 1

| Severity | Finding                                                                                                  | Resolution                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| INFO     | Architecture is appropriately scoped for a CSS-only feature                                              | No action needed                                                                                             |
| LOW      | Consider documenting the order of token sections in globals.css (gradients after colors, before spacing) | Addressed in HLD Section 3 implicitly — gradient tokens are a new subsection within the color system section |
| INFO     | 4 alternatives considered provides good decision transparency                                            | No action needed                                                                                             |

### Round 2

| Severity | Finding                                                                                            | Resolution                                                                         |
| -------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| INFO     | Composite tokens correctly reference atomic stops via `var()`                                      | No action needed                                                                   |
| LOW      | The `--gradient-border-glow` token uses box-shadow, not backgroundImage — clarify this distinction | Clarified: it stays as a CSS utility class, not a Tailwind `backgroundImage` entry |

All findings resolved. No CRITICAL or HIGH issues.

## Summary

HLD defines a two-tier gradient token system (atomic stops + semantic composites) added to `globals.css`, with Tailwind `backgroundImage` extension in `packages/tailwind-config/base.js`. Architecture is CSS-only, zero-JS, backward compatible. 11 files affected. All 12 architectural concerns addressed or marked N/A. 4 alternatives evaluated and rejected with rationale.
