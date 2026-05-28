# SDLC Log: Conversation Behavior — LLD

**Date**: 2026-04-21
**Phase**: LLD
**Feature**: Conversation Behavior

---

## Discovery Notes

- The implementation plan is phased to keep the feature deployable in slices: ownership/parity, parser/compiler, runtime resolution, Studio/project-I/O, then diagnostics and hardening.
- Existing behavior-profile, interaction-context, localization, and Studio serializer seams are treated as the implementation foundation rather than building a separate stack.

## Key Decisions

| #   | Decision                                                                       | Rationale                                                                                              |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| D-1 | Phase 1 starts with ownership + current voice/profile parity gaps              | The feature needs a stable base before adding new syntax                                               |
| D-2 | Add dedicated resolver modules instead of pushing all meaning into prompt text | Runtime gating and observability require a first-class resolved object                                 |
| D-3 | Keep project-I/O and Studio round-trip as a dedicated phase                    | Prevents the common failure mode where new syntax compiles but does not persist or rehydrate correctly |
| D-4 | Gate advanced fields explicitly instead of overloading phase 1                 | Keeps the launch subset testable while preserving a stable long-term model                             |

## Files Created

| File                                                       | Purpose                   |
| ---------------------------------------------------------- | ------------------------- |
| `docs/plans/2026-04-21-conversation-behavior-impl-plan.md` | LLD + implementation plan |
| `docs/sdlc-logs/conversation-behavior/lld.log.md`          | This log                  |

## Remaining Open Questions

1. Brand voice dependency timing
2. Pronunciation asset ownership
3. Whether step-level `CONVERSATION:` overrides are phase-1 or later

## Next Phase

Run `/implement conversation-behavior` once the docs are reviewed and accepted.

---

## Revision Note — 2026-04-21 (Later Pass)

- Reworked the LLD to align with the self-contained feature spec and updated HLD.
- Removed dependence on external-draft framing and focused implementation phases on contract definition, parser/compiler lowering, runtime resolution, Studio/project-I/O, and hardening.
- Updated the phased plan so advanced-field gating, asset references, and runtime diagnostics are explicit parts of the implementation sequence.
