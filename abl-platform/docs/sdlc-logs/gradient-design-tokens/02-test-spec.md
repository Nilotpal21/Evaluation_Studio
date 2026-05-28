# SDLC Log: gradient-design-tokens — Phase 2 (Test Spec)

**Date**: 2026-03-23
**Phase**: Test Spec
**Artifact**: `docs/testing/gradient-design-tokens.md`

## Coverage Summary

| Category            | Test Count | P0     | P1     | P2    |
| ------------------- | ---------- | ------ | ------ | ----- |
| Unit (CSS Tokens)   | 5          | 3      | 1      | 1     |
| Unit (TW Config)    | 3          | 2      | 1      | 0     |
| Integration (CSS)   | 8          | 6      | 2      | 0     |
| Integration (Build) | 5          | 3      | 2      | 0     |
| Integration (Comp.) | 6          | 0      | 6      | 0     |
| E2E (Visual)        | 10         | 6      | 4      | 0     |
| E2E (Theme)         | 3          | 2      | 1      | 0     |
| E2E (A11y)          | 2          | 2      | 0      | 0     |
| **Total**           | **42**     | **24** | **17** | **1** |

## E2E Scenarios (7)

1. Dark Theme Panel Gradients — Playwright screenshot comparison
2. Light Theme Panel Gradients — Theme toggle + screenshot comparison
3. Gradient Text Rendering — Background-clip verification + visual match
4. Theme Switch Transition — Dark→Light→Dark round-trip, no FOUC
5. Skeleton Loader Gradient — Loading state shimmer verification
6. Build Output Verification — Token presence in production CSS
7. Accessibility Contrast — WCAG AA ratio check for gradient text

## Integration Scenarios (7)

1. CSS Token Resolution Chain — Composite tokens resolve to valid gradient syntax
2. Tailwind Config Generates Utilities — backgroundImage entries present
3. Token-to-Utility Wiring — Tailwind classes reference correct CSS vars
4. Light Theme Token Completeness — Every `:root` token has light override
5. No Hardcoded Gradients — Utility classes use `var()` not raw HSL
6. CSS Bundle Size Delta — < 500 bytes increase
7. Component className Backward Compatibility — Original class names preserved

## Product Oracle Decisions

| Question                                                    | Classification | Decision                                                                |
| ----------------------------------------------------------- | -------------- | ----------------------------------------------------------------------- |
| Should E2E tests use real browser rendering or CSS parsing? | DECIDED        | Real browser (Playwright) — E2E must exercise real system per CLAUDE.md |
| What pixel diff threshold for visual regression?            | DECIDED        | 1% — accounts for anti-aliasing differences across platforms            |
| Should integration tests parse raw CSS or built output?     | DECIDED        | Built output — tests what users actually receive                        |
| Are SVG gradient tests needed?                              | DECIDED        | No — SVG gradients are out of scope per feature spec                    |

## Phase Auditor Findings

### Round 1

| Severity | Finding                                                                   | Resolution                                  |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| INFO     | 42 total tests provides comprehensive coverage for a CSS-only feature     | No action needed                            |
| INFO     | 7 E2E scenarios exceeds minimum of 5                                      | No action needed                            |
| INFO     | 7 integration scenarios exceeds minimum of 5                              | No action needed                            |
| LOW      | Consider adding a test for CSS variable fallback behavior (invalid token) | Deferred — edge case, not a regression risk |

All findings resolved. No CRITICAL or HIGH issues.

## Summary

Test spec covers 42 test cases across unit, integration, and E2E categories. 24 are P0. The spec mandates 7 E2E scenarios (Playwright-based visual regression) and 7 integration scenarios (build output verification). All tests follow CLAUDE.md E2E standards: real browser, no mocks, HTTP API only.
