# `@agent-platform/arch-ai` — Arch AI engine

**Branch baseline:** `f02bac5cb` (design-spec commit)
**Created:** 2026-04-18
**Status:** Active package. The legacy `packages/arch-ai` package was archived outside the repo on 2026-04-20.

## Intent

This package is the active Arch AI engine + transport package for the repo. The legacy `packages/arch-ai/` tree has been archived outside the monorepo after the migration.

Why parallel instead of in-place:

- The previous in-place attempt (on `arch/communicationrewamp`) accumulated 60+ commits that partially converged but left the UI racing with the event stream. The engine work was correct; the integration with the existing v1 UI was fundamentally incompatible.
- A parallel package let the current implementation be designed cleanly without retrofit pressure, and kept the earlier path untouched until parity was proven.

## What's copied in (seed artifacts)

The files here were **lifted forward** from `origin/arch/communicationrewamp`. Some comments still mention legacy `packages/arch-ai/` source paths because they document origin, not live dependencies.

| Area          | Files                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine core   | `src/engine/` — outbox, buffered-services, turn-engine, turn-buffer, turn-context, tool-invoker, llm-client, coordinator-bridge, queue, error-classifier, hard-limits |
| Session       | `src/session/` — fan-out-publisher, session-lock, session-reconciler                                                                                                  |
| Types         | `src/types/` — turn-events, message-request, session-v2                                                                                                               |
| Tool registry | `src/tools/v2/registry.ts`, `src/tools/adapters/classification.ts`                                                                                                    |

## What's NOT copied

- The archived v1 package modules (`coordinator/`, `prompts/`, `knowledge/`, `audit/`, `generation/`, `executor/`, `diagnostics/`, `journal/`, `planning/`, `streaming/`, `spec-document/`). Any useful reference now comes from the external archive, not from an in-repo dependency.
- Tool adapter registrations (`src/tools/adapters/register-v1-tools.ts`) — carry v1 logic coupling. v4 plan designs its tool surface from scratch.
- Unit tests for engine files — recopy after v4 plan settles the module boundaries.

## Companion reading

- `docs/arch/v2-feature-audit.md` — file-by-file v1 → v2 treatment decisions (kept/rewired/replaced)
- `docs/arch/v2-rewamp-status.md` — Phase 0-6 checkpoint (what worked, what didn't)
- `docs/superpowers/specs/2026-04-18-arch-ai-engine-rewire-design.md` — engine design
- `docs/superpowers/specs/2026-04-18-arch-v2-ui-isolation-design.md` — UI isolation design
- `docs/arch/research/2026-04-18-ui-architecture-redesign/` — plugin-shell research (11 files, earlier session)
- Archived implementation: `origin/arch/communicationrewamp` (60+ commits, earlier engine fully landed but UI mismatch unresolved)

## Next step

Extend this package directly. Do not reintroduce new dependencies on the archived legacy package.
