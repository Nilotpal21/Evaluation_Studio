# SDLC Log: Conversation Behavior — Feature Spec

**Date**: 2026-04-21
**Phase**: FEATURE-SPEC
**Feature**: Conversation Behavior (sub-feature of ABL Language / Voice Capabilities / Channels)

---

## Discovery Notes

- This pass was completed directly in-thread using repository evidence rather than a separate oracle/auditor agent.
- Initial exploratory conversation-design notes were normalized into **Conversation Behavior** so the platform feature has stable terminology and a standalone contract.
- The central architectural decision was made up front: this feature must be ABL-native and must not become a second persisted DSL beside ABL.

## Key Decisions

| #   | Decision                                                                        | Rationale                                                                                                   |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| D-1 | Use sub-feature placement under `docs/features/sub-features/`                   | The work is narrower than a major feature and extends ABL/voice/channel surfaces rather than replacing them |
| D-2 | Rename the proposal to "Conversation Behavior"                                  | Better terminology for a platform feature; avoids implying a separate language or subjective quality score  |
| D-3 | Include a matching testing guide placeholder                                    | Required by the repo SDLC flow and needed as an HLD/LLD input                                               |
| D-4 | Make ABL-native authoring and ownership boundaries the core of the feature spec | This is the primary future-readiness requirement surfaced by the review                                     |

## Files Created

| File                                                       | Purpose                   |
| ---------------------------------------------------------- | ------------------------- |
| `docs/features/sub-features/conversation-behavior.md`      | Feature spec              |
| `docs/testing/sub-features/conversation-behavior.md`       | Testing guide placeholder |
| `docs/sdlc-logs/conversation-behavior/feature-spec.log.md` | This log                  |

## Open Questions Logged

1. Should phase 1 expose `style_ref`, or wait for a project brand voice system?
2. Where should pronunciation content live: localization assets, vocabulary, or a dedicated asset type?
3. Should project brand defaults participate in phase 1, or remain a reserved extension point?

## Next Phase

Continue with `/hld` using the new feature spec and testing guide as the SDLC inputs.

---

## Revision Note — 2026-04-21 (Later Pass)

- Reworked the feature spec to be self-contained and feature-first rather than commentary on upstream design material.
- Pulled the canonical `speaking` / `listening` / `interaction` content, field catalog, naming decisions, ownership matrix, and launch subset directly into the feature spec.
- Reduced external-context references so the spec can be read standalone by someone who has not seen earlier exploratory design notes.
- Simplified the open-question set to focus on forward-looking product decisions rather than external-document migration concerns.
