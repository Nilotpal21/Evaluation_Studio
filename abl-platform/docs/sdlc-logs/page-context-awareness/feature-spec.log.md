# SDLC Log: Page Context Awareness — Feature Spec

**Phase**: Feature Spec (Phase 1)
**Date**: 2026-04-05
**Status**: COMPLETE

## Oracle Decisions

All questions answered internally — no AMBIGUOUS items escalated.

| Classification | Key Decisions                                                                         |
| -------------- | ------------------------------------------------------------------------------------- |
| ANSWERED       | NavigationStore has typed `NavigationArea` and `ProjectPage` at `navigation-store.ts` |
| ANSWERED       | `useArchChat.send()` accepts text + files, needs `pageContext` addition               |
| ANSWERED       | `MessageRequest` in `@agent-platform/arch-ai` needs `pageContext` field               |
| ANSWERED       | `composeSystemPrompt()` is the injection point for context                            |
| DECIDED        | Context sent on every message (simpler than change-detection)                         |
| DECIDED        | Token budget of ~2K tokens, metadata-only (no full ABL content)                       |
| DECIDED        | Specialist uses context silently — no "I see you're on..." preamble                   |
| DECIDED        | No sensitive data: API keys, credentials, conversation content excluded               |

## Files Created

- `docs/features/page-context-awareness.md` — Feature spec (18/18 sections)
- `docs/testing/page-context-awareness.md` — Testing guide placeholder
- `docs/sdlc-logs/page-context-awareness/feature-spec.log.md` — This log

## Audit Results

- Round 1: All quality gates PASS. 5 user stories, 8 FRs, 5 integrations, isolation addressed.
- Round 2: Cross-phase consistency verified against navigation-store.ts types and useArchChat.ts signatures.

## Next Phase

Run `/test-spec page-context-awareness`
