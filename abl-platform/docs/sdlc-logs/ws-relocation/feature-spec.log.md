# SDLC Log: ws-relocation — Feature Spec Phase

**Date**: 2026-04-13
**Feature**: WebSocket Relocation (App-Level → Chat-Tab-Level)
**Phase**: Feature Spec (Phase 1)

---

## Oracle Decisions

Product-oracle agent unavailable (model config issue). Clarifying questions self-answered from codebase evidence gathered during deep research session.

### Scope & Problem

| #   | Question                       | Answer                                                                                                                                                        | Classification | Evidence                                                                                                                                              |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What problem does this solve?  | Studio opens WS on login regardless of need. Proxy kills idle connections every ~56s, causing infinite reconnect cycles (6+ connections in DevTools).         | ANSWERED       | `WebSocketContext.tsx:728-803` (connection effect), `heartbeat.ts` (protocol-level only), user screenshot showing 6 connections on agents-dev.kore.ai |
| Q2  | What is out of scope?          | Adding missing message handlers (session_ended, execution_queued, etc.), message queueing for disconnected send(), exponential backoff, sessionId validation. | DECIDED        | Design doc §7.2 lists 9 unhandled types as pre-existing gaps                                                                                          |
| Q3  | New capability or enhancement? | Enhancement — restructuring existing WebSocket infrastructure, no new user-facing features.                                                                   | ANSWERED       | All components and WS protocol remain unchanged                                                                                                       |
| Q4  | Priority/timeline driver?      | User-reported bug — multiple WS connections visible in production (agents-dev.kore.ai).                                                                       | ANSWERED       | User reported with screenshot in this conversation                                                                                                    |
| Q5  | Competing approaches?          | Alternative: keep app-level WS but add keepalive only. Rejected because it doesn't solve wasted resources on non-chat pages.                                  | DECIDED        | Design doc §4.5 shows keepalive alone fixes proxy but not resource waste                                                                              |

### User Stories & Requirements

| #   | Question                        | Answer                                                                                                                                                        | Classification | Evidence                                                                  |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------- |
| Q6  | Primary personas?               | Studio developers (build/test agents), Studio operators (monitor sessions).                                                                                   | ANSWERED       | Consumer inventory shows all WS usage is in agent chat/test/debug flows   |
| Q7  | Critical user journeys?         | Login → browse projects (no WS), open agent chat (WS connects), chat with agent, navigate away (WS closes), return to chat (WS reconnects + resumes session). | ANSWERED       | `AppShell.tsx:586` routing, `WebSocketContext.tsx:762-765` session resume |
| Q8  | Must-have vs nice-to-have?      | Must: WS scoped to chat, app-level keepalive ping/pong, App.tsx decoupling. Nice: CommandPalette cleanup, dead code removal.                                  | DECIDED        | Design doc §12 implementation order                                       |
| Q9  | Performance/scale requirements? | Connection setup overhead is ~5-50ms (tenant resolution). No new perf concerns — connections are less frequent with this change.                              | INFERRED       | `handler.ts:1371` tenant resolution is cached per-user                    |
| Q10 | Existing feature interactions?  | Auth (token refresh), session management (resume/detach), observatory (trace events), batch consent, agent transfer.                                          | ANSWERED       | `handleMessage` switch writes to 3 stores, all within chat tree           |

### Technical & Architecture

| #   | Question                         | Answer                                                                                                                                      | Classification | Evidence                                                            |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| Q11 | Packages/services affected?      | `apps/studio/` (WebSocketContext, App, page, AppShell, CommandPalette, types), `apps/runtime/` (handler.ts, types).                         | ANSWERED       | Design doc §9 file change matrix                                    |
| Q12 | Data model changes?              | None. Only TypeScript type unions updated (add `ping` to ClientMessage, `pong` to ServerMessage).                                           | ANSWERED       | Design doc §8                                                       |
| Q13 | Security/isolation implications? | None. Auth mechanism unchanged (subprotocol JWT). Tenant isolation unchanged.                                                               | ANSWERED       | `handler.ts:1051-1088` auth flow unchanged                          |
| Q14 | Deployment/migration strategy?   | Steps 1-2 (keepalive) can ship independently. Steps 3-5 (relocation) ship together. No migration needed — purely client-side restructuring. | DECIDED        | Design doc §12                                                      |
| Q15 | External dependencies?           | Infrastructure proxy configuration (out of our control). The keepalive fix works regardless of proxy config.                                | ANSWERED       | Proxy idle timeout is the root cause but we fix it application-side |

## Audit Results

### Round 1 (Self-Audit — phase-auditor agent unavailable due to model config)

| #   | Check                                | Result                      |
| --- | ------------------------------------ | --------------------------- |
| 1   | All 18 TEMPLATE.md sections present  | PASS                        |
| 2   | Minimum 3 user stories               | PASS (5)                    |
| 3   | Minimum 4 functional requirements    | PASS (10)                   |
| 4   | Integration matrix >= 2 features     | PASS (4)                    |
| 5   | Isolation: tenant + project + user   | PASS                        |
| 6   | Delivery plan with numbered subtasks | PASS (6 tasks, 21 subtasks) |
| 7   | Open questions >= 1                  | PASS (3)                    |
| 8   | Testable FR statements               | PASS                        |
| 9   | Code-grounded claims                 | PASS                        |
| 10  | Testing describes real interactions  | PASS                        |

**Findings resolved:**

- MEDIUM-1: Clarified E2E scenario descriptions (removed "Manual + e2e" ambiguity)
- MEDIUM-2: Changed `(new)` to `(planned)` for test files that don't exist yet

**Result: APPROVED**

### Round 2 (Fresh-Eyes Pass)

| #   | Check                                  | Result |
| --- | -------------------------------------- | ------ |
| 1   | Feature spec ↔ Testing guide alignment | PASS   |
| 2   | E2E scenarios match spec               | PASS   |
| 3   | Design doc ↔ spec consistency          | PASS   |
| 4   | SDLC log reflects actual decisions     | PASS   |
| 5   | No placeholders or TBD                 | PASS   |
| 6   | No contradictions                      | PASS   |

**Result: APPROVED**

---

## Files Created

- `docs/features/sub-features/ws-relocation.md`
- `docs/testing/sub-features/ws-relocation.md`
- `docs/sdlc-logs/ws-relocation/feature-spec.log.md` (this file)

## Index Files Updated

- `docs/features/README.md` — added ws-relocation to sub-features table
- `docs/features/sub-features/README.md` — added ws-relocation entry
- `docs/testing/README.md` — added ws-relocation testing entry
- `docs/testing/sub-features/README.md` — added ws-relocation entry
