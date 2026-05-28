# SDLC Log: SDK Rich Content Templates — Feature Spec

**Phase**: FEATURE-SPEC
**Date**: 2026-03-24
**Artifact**: `docs/features/sub-features/sdk-rich-content-templates.md`

---

## Oracle Decisions

All 15 clarifying questions were answered by the product oracle. No AMBIGUOUS items required user input.

| #   | Question                  | Classification | Decision                                                                    |
| --- | ------------------------- | -------------- | --------------------------------------------------------------------------- |
| Q1  | Problem statement         | ANSWERED       | Feature-parity gap: 3 template types vs 12-15 industry standard             |
| Q2  | Scope boundary            | ANSWERED       | Cherry-pick only additive template code; auth/WS/session changes excluded   |
| Q3  | New vs enhancement        | ANSWERED       | Both: Phase 0 refactors existing, Phases 1-2 add new                        |
| Q4  | Timeline driver           | INFERRED       | BETA→GA feature-parity; implemented 2026-03-20 as sprint deliverable        |
| Q5  | Competing approaches      | ANSWERED       | Message Templates is distinct (text fragments vs visual rendering)          |
| Q6  | Personas                  | ANSWERED       | End users, agent developers, SDK maintainers, Studio operators              |
| Q7  | User journeys             | ANSWERED       | 4 journeys: runtime render, DSL authoring, catalog browse, /template insert |
| Q8  | Must-have vs nice-to-have | ANSWERED       | Tier 1 must-have, Tier 2 nice-to-have                                       |
| Q9  | Performance               | ANSWERED       | ~13-20KB, zero deps, chart lazy-loaded                                      |
| Q10 | Feature interactions      | ANSWERED       | Extends SDK RichContent, shares data with Message Templates                 |
| Q11 | Packages affected         | ANSWERED       | web-sdk (primary), studio, compiler, core, runtime                          |
| Q12 | Data models               | ANSWERED       | RichContent interface extension only, no new DB collections                 |
| Q13 | Security                  | ANSWERED       | isSafeUrl not used by new renderers (XSS), React hooks violations           |
| Q14 | Deployment                | ANSWERED       | Fully backwards-compatible, no migrations                                   |
| Q15 | External deps             | ANSWERED       | Zero — hand-rolled SVG for charts                                           |

## Files Created

- `docs/features/sub-features/sdk-rich-content-templates.md` — Feature spec
- `docs/testing/sub-features/sdk-rich-content-templates.md` — Testing guide placeholder
- `docs/sdlc-logs/sdk-rich-content-templates/feature-spec.log.md` — This log

## Open Questions

1. Should `isSafeUrl` be extracted to a shared package?
2. Should template catalog include a "Custom" category placeholder?
3. Should `TemplateContext.theme` be wired now or deferred?
