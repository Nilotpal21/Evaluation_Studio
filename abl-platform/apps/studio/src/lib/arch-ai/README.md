# `apps/studio/src/lib/arch-ai/` — Studio wiring for the Arch AI engine

**Branch baseline:** `f02bac5cb` (design-spec commit)
**Created:** 2026-04-18
**Status:** Production Studio path for `/arch`. Legacy Studio arch-ai surface was archived and removed on 2026-04-20.

## Intent

Studio-side wiring for the active Arch AI engine (`packages/arch-ai`). This directory now owns the `/arch` implementation, shared BUILD/UI state, and the active route surface under `apps/studio/src/app/api/arch-ai/`.

## What's copied in

| File                     | Original path on `arch/communicationrewamp`                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `engine-factory.ts`      | `apps/studio/src/lib/arch-ai-v2/engine-factory.ts` — service-bag DI, buffered proxies, LLM-client wrapper, fan-out wiring     |
| `message-handler.ts`     | `apps/studio/src/lib/arch-ai-v2/message-handler.ts` — POST `/api/arch-ai/message` handler with queue + dispatch + CREATE flow |
| `ui/store.ts`            | Zustand store (single source of truth for event-driven state)                                                                 |
| `ui/event-dispatcher.ts` | Pure fn mapping TurnEvent → store mutation (9 tests, no mocks)                                                                |
| `ui/hook.ts`             | `useArchChatController` lifecycle — POST body parse + EventSource + `(turnId, seq)` dedup                                     |
| `ui/event-parser.ts`     | SSE frame → typed TurnEvent                                                                                                   |
| `ui/session-api.ts`      | POST/GET helpers (message, current session, cancel)                                                                           |
| `ui/types.ts`            | Re-exports v1 shared types + internal types                                                                                   |

These files started as copied-forward seed artifacts. The imports and service wiring have since been migrated to `packages/arch-ai` and the local `arch-ai` helpers in this folder.

## What's NOT copied

- The legacy `apps/studio/src/lib/arch-ai/` implementation tree. That code is now archived outside the repo.
- The legacy `apps/studio/src/components/arch/` production tree. The active component surface lives under `apps/studio/src/lib/arch-ai/components/arch/`.
- The legacy `/api/arch-ai/**` Studio route tree. The active route surface is `/api/arch-ai/**`.

## Next step

See `packages/arch-ai/README.md` for package-level engine details. Studio work here should extend the current Arch path directly rather than adding new legacy compatibility layers.
