# SDLC Log: Gradient Design Tokens — Feature Spec Phase

**Feature**: gradient-design-tokens
**Phase**: FEATURE-SPEC
**Date**: 2026-03-22

---

## Oracle Decisions

All 15 clarifying questions were answered by the product oracle. No AMBIGUOUS items required user escalation.

| #   | Question                       | Classification | Summary                                                                              |
| --- | ------------------------------ | -------------- | ------------------------------------------------------------------------------------ |
| 1   | What problem does this solve?  | ANSWERED       | 7 ad-hoc gradients in globals.css + 16+ inline usages with no centralized system     |
| 2   | What is out of scope?          | INFERRED       | Admin app, animated mesh gradients, chart SVG gradients, runtime/backend             |
| 3   | New capability or enhancement? | ANSWERED       | Enhancement to existing `@agent-platform/design-tokens` system                       |
| 4   | Priority/timeline driver?      | DECIDED        | Visual polish initiative; Arch AI surfaces are most urgent                           |
| 5   | Competing approaches?          | ANSWERED       | Current ad-hoc approach is the prior attempt; must consolidate                       |
| 6   | Primary personas?              | INFERRED       | Agent developers (primary), design system consumers (secondary)                      |
| 7   | Critical user journeys?        | ANSWERED       | Onboarding, Arch AI panel, deployment, empty states                                  |
| 8   | Must-have vs nice-to-have?     | DECIDED        | Must: CSS tokens + utility classes + migration. Nice: TS API, animated borders       |
| 9   | Performance requirements?      | INFERRED       | GPU-composited CSS only, no JS-driven gradients, respect reduced-motion              |
| 10  | Feature interactions?          | ANSWERED       | Theme switching, Arch AI, onboarding, skeleton loader, chart system (separate)       |
| 11  | Affected packages?             | ANSWERED       | design-tokens, tailwind-config, apps/studio                                          |
| 12  | CSS vars vs full values?       | DECIDED        | Full gradient values in CSS vars (cannot decompose like HSL), utility classes on top |
| 13  | Accessibility?                 | INFERRED       | Text contrast, reduced-motion, no gradient-only indicators                           |
| 14  | TS API?                        | DECIDED        | Yes, matching existing `getIntentStyles()` pattern                                   |
| 15  | Light theme strategy?          | ANSWERED       | Same hues, reduced opacity, tighter luminance range                                  |

## Files Created

- `docs/features/gradient-design-tokens.md` — Feature specification
- `docs/testing/gradient-design-tokens.md` — Testing guide placeholder
- `docs/sdlc-logs/gradient-design-tokens/feature-spec.log.md` — This log

## Progress

- [x] Read template and authoring guide
- [x] Searched for prior art (none found)
- [x] Read existing code (globals.css, design-tokens, tailwind-config, 16 component files)
- [x] Spawned product oracle — all 15 questions answered
- [x] Generated feature spec
- [x] Generated testing guide placeholder
- [x] Update README indexes
- [x] Audit round 1 — APPROVED with 3 MEDIUM, 4 LOW findings
- [x] Audit round 2 — APPROVED with 3 HIGH, 4 MEDIUM, 3 LOW findings
- [x] All HIGH findings resolved (WelcomePhase migration, index.css scope, API name consistency)
- [x] All MEDIUM findings resolved (migration acceptance criteria, dependency ordering, OQ-1 clarified)
- [x] LOW findings resolved (missing token in plan, README index updates step added)
- [x] Commit

## Audit Round 1 Summary

Verdict: APPROVED. Key findings:

- MEDIUM-2: FR-10 contradicted technical decisions — weakened to "should evaluate"
- MEDIUM-3: Count clarified from "7 gradients" to "6 gradients + 1 box-shadow"
- LOW-1: Shimmer reclassified from "Functional" to "Surface" category

## Audit Round 2 Summary

Verdict: APPROVED. Key findings resolved:

- H-1: Added WelcomePhase.tsx to migration table and delivery plan
- H-2: Elevated GAP-001 to HIGH, added index.css reconciliation step (4.6)
- H-3: Added `getGradientValue()` explicitly to FR-9
- M-1: Added migration completeness gate step (7.5) with grep commands
- M-3: Added dependency note at top of delivery plan
- M-4: Clarified OQ-1 as a remaining variant question (technique already decided)
- L-2: Added `--gradient-brand-fade` to delivery plan step 1.1
- L-3: Added README index update step (7.6)
