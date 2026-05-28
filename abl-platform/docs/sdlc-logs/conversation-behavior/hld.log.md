# SDLC Log: Conversation Behavior — HLD

**Date**: 2026-04-21
**Phase**: HLD
**Feature**: Conversation Behavior

---

## Discovery Notes

- This HLD was generated from the new feature spec and test guide without using a separate oracle/auditor agent.
- The design centers on one recommended option: an ABL-native `CONVERSATION:` authoring block that lowers into canonical compiler/runtime owners.

## Key Decisions

| #   | Decision                                                               | Rationale                                                                         |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| D-1 | Recommend ABL-native authoring over a standalone DSL                   | Preserves one language and avoids source-of-truth overlap                         |
| D-2 | Resolve per-turn behavior through a runtime merge step                 | Keeps behavior explainable and allows capability gating beyond prompt text        |
| D-3 | Keep acoustic voice ownership separate from Conversation Behavior      | Reduces overlap with existing `VOICE:` / `EXECUTION.voice` seams                  |
| D-4 | Reuse project localization assets for locale-sensitive phrase behavior | Avoids inline duplication and respects existing localization ownership boundaries |

## Files Created

| File                                              | Purpose           |
| ------------------------------------------------- | ----------------- |
| `docs/specs/conversation-behavior.hld.md`         | High-Level Design |
| `docs/sdlc-logs/conversation-behavior/hld.log.md` | This log          |

## Carry-Forward Questions

1. Brand voice dependency timing for `style_ref`
2. Pronunciation asset ownership
3. Phase-1 scope for step-level overrides

## Next Phase

Continue with `/lld` to convert the HLD into a phased implementation plan.

---

## Revision Note — 2026-04-21 (Later Pass)

- Reworked the HLD so it explains the feature architecture directly instead of framing it as a reaction to earlier exploratory material.
- Kept the architecture centered on ABL-native `CONVERSATION:` authoring, runtime resolution, asset references, and channel-family capability gating.
- Aligned alternatives, dependencies, and open questions with the rewritten self-contained feature spec.
