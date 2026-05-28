# SDLC Log: Voice Runtime Semantics Unification — LLD

**Date**: 2026-04-22
**Phase**: LLD
**Feature**: Voice Runtime Semantics Unification

---

## Discovery Notes

- The safest implementation order is contract -> normalization -> prompt convergence -> coordinator baseline -> realtime adoption -> bridge rollout.
- Existing pipeline voice behavior is strong enough to serve as the migration anchor; the plan intentionally avoids rewriting that path first.
- Rollout safety depends on shadow-mode divergence evidence before any family enters enforce mode.

## Key Decisions

| #   | Decision                                                                | Rationale                                                           |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D-1 | Phase 1 defines capability and parity metadata before behavior changes  | Makes drift visible before any runtime cutover                      |
| D-2 | Provider normalization remains backward-compatible during migration     | Avoids breaking current realtime callbacks while new semantics land |
| D-3 | Realtime prompt/tool convergence happens before coordinator enforcement | Prevents the coordinator from inheriting ad hoc prompt drift        |
| D-4 | Families move to enforce one at a time                                  | Limits blast radius and makes rollback practical                    |

## Files Created

| File                                                                     | Purpose                          |
| ------------------------------------------------------------------------ | -------------------------------- |
| `docs/plans/2026-04-22-voice-runtime-semantics-unification-impl-plan.md` | LLD + phased implementation plan |
| `docs/sdlc-logs/voice-runtime-semantics-unification/lld.log.md`          | This log                         |

## Remaining Open Questions

1. What divergence threshold is acceptable in shadow mode before enforce?
2. Which bridge family should be the first explicit-partial rollout target?
3. How long should compatibility hooks stay after the final family reaches enforce?

## Next Phase

Run `/implement voice-runtime-semantics-unification` once the SDLC docs are reviewed and accepted.
