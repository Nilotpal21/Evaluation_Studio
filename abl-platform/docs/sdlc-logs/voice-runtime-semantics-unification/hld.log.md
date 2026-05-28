# SDLC Log: Voice Runtime Semantics Unification — HLD

**Date**: 2026-04-22
**Phase**: HLD
**Feature**: Voice Runtime Semantics Unification

---

## Discovery Notes

- This HLD was generated directly from repository evidence plus the new feature/test specs without a separate oracle/auditor agent.
- The primary architectural decision is to separate provider event normalization, prompt profile resolution, and semantic turn execution into explicit layers.
- The HLD rejects both extremes: provider-specific patchwork and a forced one-stack-fits-all pipeline rewrite.

## Key Decisions

| #   | Decision                                                                          | Rationale                                                      |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| D-1 | Recommend a canonical semantic layer with normalized events and capability gating | Preserves provider differences without forking DSL semantics   |
| D-2 | Keep prompts mode-specific (`pipeline` vs `realtime`)                             | Realtime latency and provider grammar need different packaging |
| D-3 | Introduce explicit rollout modes `off` / `shadow` / `enforce`                     | Needed for safe parity validation and rollback                 |
| D-4 | Treat immutable providers as first-class partials until proven otherwise          | Safer than silently pretending full parity exists              |

## Files Created

| File                                                            | Purpose           |
| --------------------------------------------------------------- | ----------------- |
| `docs/specs/voice-runtime-semantics-unification.hld.md`         | High-Level Design |
| `docs/sdlc-logs/voice-runtime-semantics-unification/hld.log.md` | This log          |

## Carry-Forward Questions

1. Should immutable providers get a dedicated semantic lane later?
2. Should capability metadata be static, discovered, or hybrid?
3. Should bridge adapters emit normalized events directly or through runtime wrappers first?

## Next Phase

Continue with the LLD to turn the architecture into independently deployable implementation slices.
