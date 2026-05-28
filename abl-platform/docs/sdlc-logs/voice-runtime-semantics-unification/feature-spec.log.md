# SDLC Log: Voice Runtime Semantics Unification — Feature Spec

**Date**: 2026-04-22
**Phase**: FEATURE-SPEC
**Feature**: Voice Runtime Semantics Unification (sub-feature of Voice Capabilities / Channels)

---

## Discovery Notes

- This pass was completed directly in-thread using repository evidence rather than a separate oracle/auditor agent.
- The key discovery was structural, not cosmetic: pipeline voice already uses canonical runtime turn execution, while realtime voice still rebuilds prompt/tool semantics locally.
- The feature was scoped as a runtime semantics problem, not a new authoring DSL problem.

## Key Decisions

| #   | Decision                                                                          | Rationale                                                                                                     |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| D-1 | Place the work in `docs/features/sub-features/`                                   | It is narrower than a major feature and extends existing voice/channel surfaces                               |
| D-2 | Use "Voice Runtime Semantics Unification" as the feature name                     | Names the actual gap: semantic drift across voice families                                                    |
| D-3 | Make "normalize events, resolve prompt profile, unify semantics" the core framing | Avoids the incorrect assumption that realtime and pipeline voice should share raw events or identical prompts |
| D-4 | Keep pipeline voice as the baseline contract                                      | The repo already shows pipeline paths using canonical runtime execution                                       |

## Files Created

| File                                                                     | Purpose      |
| ------------------------------------------------------------------------ | ------------ |
| `docs/features/sub-features/voice-runtime-semantics-unification.md`      | Feature spec |
| `docs/sdlc-logs/voice-runtime-semantics-unification/feature-spec.log.md` | This log     |

## Open Questions Logged

1. Should immutable providers stay explicit partials or get a dedicated alternate semantic lane?
2. Where should provider capability profiles live long-term: shared provider package, runtime policy layer, or both?
3. How much provider-specific prompt specialization is acceptable before semantic drift returns?

## Next Phase

Continue with the test spec, HLD, and LLD using the feature spec as the reference contract.
