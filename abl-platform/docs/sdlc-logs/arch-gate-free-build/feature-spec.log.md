# Feature Spec Log: Arch Gate-Free Build

**Feature**: Gate-Free Build Phase — Arch AI v0.3 Redesign
**Slug**: `arch-gate-free-build`
**Date**: 2026-04-10
**Ticket**: ABLP-162

## Revision History

| Date       | Rev | Scope                                                                                                                                                                                                                |
| ---------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-10 | R1  | Initial spec — BUILD-only gate removal                                                                                                                                                                               |
| 2026-04-10 | R2  | Expanded to all phases — topology_approval + ask_user                                                                                                                                                                |
| 2026-04-10 | R3  | Deep review fixes — proceed_to_next_phase tool, widget mutex, isolation                                                                                                                                              |
| 2026-04-10 | R4  | **Codex review resolution** — backend phases unchanged, durable buildProgress model, deterministic buttons, toolDsls write path gap, GATE_PENDING cleanup on load, implementation target corrected to /arch/page.tsx |

## Key Architectural Decisions (R4)

1. **Backend phases stay**: `INTERVIEW | BLUEPRINT | BUILD | CREATE` unchanged. Only UI stages collapse.
2. **Buttons use deterministic `continue`/`create`**: `proceed_to_next_phase` tool is ONLY for typed NL intent.
3. **Widget server contract unchanged**: `pendingInteraction`, `tool_answer`, freeform bypass all preserved.
4. **Durable `buildProgress` replaces gate-era fields**: Not just deletion — replacement with stage + per-agent/tool statuses.
5. **Tool gen stays as second BUILD stage**: Not same LLM turn — token budget risk.
6. **GATE_PENDING cleanup on load**: Not just on session create.
7. **Implementation target**: `/arch/page.tsx` + `useArchChat`, not `ArchOnboarding`.

## Oracle Decisions (R1, partially superseded)

All questions answered inline (agent API unavailable; answers derived from codebase exploration). Q2 and Q5 were superseded by the scope expansion in R2.

### Scope & Problem

| #   | Question                               | Classification | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | What specific problem does this solve? | ANSWERED       | The BUILD phase gate system (agent_review, tool_generation, quality_floor) has 5 documented failure modes: approvedAgents DTO mapping gaps causing infinite loops, GATE_PENDING state races causing stuck sessions, buildSubPhase stuck in TOOLS, tool extraction failures emitting empty gates, and quality_floor blocking at CREATE. Users experience stuck sessions requiring force-archive. Code evidence: session-service.ts:122-127 comment documents the loop bug; session-service.ts:228-309 forceArchiveStuck exists as recovery. |
| Q2  | What is explicitly OUT of scope?       | **SUPERSEDED** | R1 kept BLUEPRINT topology_approval gate. R2 expanded scope to remove ALL gates. R4 clarified: gate UX removed, but backend checkpoint preserved as durable `topologyApproved` flag set during `continue`/`proceed_to_next_phase` handling.                                                                                                                                                                                                                                                                                                |
| Q3  | New capability or enhancement?         | INFERRED       | Enhancement to existing arch-ai-assistant feature. Sub-feature spec under docs/features/sub-features/.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Q4  | Priority/timeline driver?              | DECIDED        | Unblocking the onboarding experience. P0 reliability bugs causing stuck sessions.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q5  | Competing approaches?                  | **SUPERSEDED** | R1 chose "remove gates entirely." R4 refined: remove gates as UX/session-state concept, but preserve durable backend checkpoints (topologyApproved, buildProgress). Not a raw deletion — a replacement with better primitives.                                                                                                                                                                                                                                                                                                             |

### User Stories & Requirements

| #   | Question                   | Classification | Answer                                                                                                                                                                                                                                                                                         |
| --- | -------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q6  | Primary personas?          | INFERRED       | Both new users (onboarding — the primary flow) and returning users (session resume). New users are the primary persona since BUILD is part of the project creation wizard.                                                                                                                     |
| Q7  | Critical journeys?         | INFERRED       | Happy: welcome → discover → build (auto-gen) → create. Edge: (1) compile error during generation → auto-fix + narrate, (2) user requests modification mid-build via chat, (3) session resume after browser close during BUILD, (4) user clicks "Adjust Topology" to backtrack BUILD→BLUEPRINT. |
| Q8  | Must-have vs nice-to-have? | DECIDED        | Must-have: gate elimination, auto-generation, chat narration, simplified onboarding phases, two-column progress card. Nice-to-have: template picker on welcome (new visual feature, not a blocker), topology node animation (polish), edge draw animation (polish).                            |
| Q9  | Performance requirements?  | INFERRED       | No hard SLA. Current parallel generation generates 4-8 agents in ~15-30 seconds. The redesign should not regress this. Tool config generation adds ~5-10 seconds. Total BUILD phase should complete in under 60 seconds for typical topologies (4-6 agents).                                   |
| Q10 | Integration surface?       | **SUPERSEDED** | R1 said topology_approval kept unchanged. R4: topology gate UX removed, backend checkpoint preserved. Implementation target corrected from ArchOnboarding to `/arch/page.tsx` + `useArchChat`.                                                                                                 |

### Technical & Architecture

| #   | Question                | Classification | Answer                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q11 | Packages affected?      | ANSWERED       | `packages/arch-ai` (types, coordinator, prompts, session, streaming), `apps/studio` (types, store, components, hooks, route handler). 2 packages total. Still accurate.                                                                                                                                                |
| Q12 | Data model changes?     | **SUPERSEDED** | R1: just delete fields. R4: replace with durable `BuildProgress` model (stage, agentStatuses, toolStatuses). Old fields become dead data. See spec AD-4.                                                                                                                                                               |
| Q13 | Security implications?  | **SUPERSEDED** | R1: "topology_approval preserved." R4: topology gate UX removed, but `topologyApproved` flag preserved as durable backend checkpoint. FR-15 adds governance rules for auto-generated tool configs.                                                                                                                     |
| Q14 | Backward compatibility? | **SUPERSEDED** | R1: relied on `forceArchiveStuck` on session create only. R4: cleanup runs on `GET /sessions/current` AND `POST /message` (FR-14). `GATE_PENDING` kept in `RESUMABLE_STATES` for one release cycle. Old `gate_response` from stale clients will fail at schema validation (schema entry removed), not at gate handler. |
| Q15 | Deployment strategy?    | DECIDED        | Hard cutover (unchanged). `GATE_PENDING` cleanup on load is the compat strategy. No feature flag.                                                                                                                                                                                                                      |

## Files Created / Updated

- `docs/features/sub-features/arch-gate-free-build.md` — R4 rewrite
- `docs/testing/sub-features/arch-gate-free-build.md` — R4 rewrite
- `docs/sdlc-logs/arch-gate-free-build/feature-spec.log.md` (this file)
- `docs/sdlc-logs/arch-gate-free-build/deep-review.md` — internal review (pre-R4)
- `docs/sdlc-logs/arch-gate-free-build/isolation-api-review.md` — tenant/user isolation audit
- `docs/arch/reviews/2026-04-10-codex-gate-less-build-review.md` — external Codex review
