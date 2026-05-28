# SDLC Log: Transcripts — Feature Spec Phase

**Feature**: Transcripts
**Phase**: Feature Spec (Phase 1 of 6)
**Date**: 2026-03-23
**Status**: COMPLETE

---

## Product Oracle Decisions

### Scope & Problem

| #   | Question                                                | Answer                                                                                                                                                                                                                                                                                                                                                                                                                   | Classification                                                                                |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 1   | What specific problem does this solve?                  | Users need to save, retrieve, export, and share conversation session transcripts for debugging, compliance, quality review, and training data extraction. Currently, the runtime has a prototype file-based implementation (`apps/runtime/src/routes/transcripts.ts`) that stores JSON files on the local filesystem — violating stateless distributed, tenant isolation, and compliance invariants.                     | ANSWERED (code evidence: `transcripts.ts` uses `fs.writeFile` to `../../output/transcripts/`) |
| 2   | What is the boundary — what is explicitly OUT of scope? | Real-time streaming transcription (voice STT) is out of scope — that is handled by `voice-pipeline.ts` and `deepgram-service.ts`. This feature is about persisting and managing completed/in-progress conversation transcripts as exportable artifacts.                                                                                                                                                                  | DECIDED                                                                                       |
| 3   | Is this new or enhancement?                             | Enhancement of existing prototype. The route file exists at `apps/runtime/src/routes/transcripts.ts` with CRUD endpoints, the `TranscriptExport` type exists in `apps/runtime/src/types/index.ts`, and unit tests exist at `apps/runtime/src/__tests__/transcript-routes.test.ts`. But the implementation is non-production: file-based storage, no auth, no tenant isolation, no project scoping, uses `console.error`. | ANSWERED                                                                                      |
| 4   | Priority/timeline driver?                               | Listed as #72 in backlog. Pipeline-engine already has `ConversationReader` that builds transcripts from MongoDB messages — the runtime prototype duplicates this in a less robust way.                                                                                                                                                                                                                                   | INFERRED                                                                                      |
| 5   | Competing approaches?                                   | Two existing transcript-building paths: (1) Runtime's file-based `transcripts.ts` routes, (2) Pipeline-engine's `ConversationReader` which reads from MongoDB + ClickHouse with encryption support. The production solution should leverage the `ConversationReader` pattern.                                                                                                                                            | ANSWERED                                                                                      |

### User Stories & Requirements

| #   | Question                        | Answer                                                                                                                                                                                                                                                                  | Classification |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Primary personas?               | Developer (debugging sessions in Studio), Operator (quality review, compliance audit), Admin (data export, retention management), End-user (requesting transcript of their own conversation via SDK/channel).                                                           | DECIDED        |
| 2   | Critical user journeys?         | (1) Dev saves a session transcript from Studio session detail page, (2) Operator exports transcripts in bulk for quality review, (3) Admin configures retention/TTL for transcript data, (4) End-user requests transcript via channel (e.g., email transcript of chat). | INFERRED       |
| 3   | Must-have vs nice-to-have?      | Must-have: MongoDB-backed CRUD, tenant+project isolation, export as JSON/text, Studio UI integration. Nice-to-have: CSV/PDF export, bulk export, scheduled archival, search/filter by date/agent/keyword.                                                               | DECIDED        |
| 4   | Performance/scale requirements? | Must handle sessions with up to 1000 messages. List endpoint must paginate. Export must stream for large transcripts to avoid memory spikes.                                                                                                                            | INFERRED       |
| 5   | Feature interactions?           | Sessions (F003), Pipeline Engine (transcript building), Archive Service (long-term storage), Compliance (PII scrubbing, encryption at rest), Contacts (linking transcript to contact).                                                                                  | ANSWERED       |

### Technical & Architecture

| #   | Question                         | Answer                                                                                                                                                                                                                                                                                                                | Classification                                                                                            |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Packages affected?               | `apps/runtime` (routes, services), `apps/studio` (UI components, API proxy), `packages/database` (new Transcript model), `packages/pipeline-engine` (ConversationReader already exists).                                                                                                                              | ANSWERED                                                                                                  |
| 2   | Data model changes?              | New `Transcript` collection in MongoDB with fields: \_id, tenantId, projectId, sessionId, name, agentName, format, messages (compressed Buffer), traceEventIds, metadata, createdBy, expiresAt. Alternatively, transcripts could be virtual (computed from session+messages on demand) rather than stored separately. | DECIDED — stored model preferred for named/annotated transcripts; on-demand generation for ad-hoc export. |
| 3   | Security/isolation implications? | Must enforce tenant isolation (tenantId in every query), project isolation (projectId scoping), user isolation (createdBy for saved transcripts). PII-bearing content must use encryption plugin. Cross-tenant access returns 404.                                                                                    | ANSWERED (platform invariants)                                                                            |
| 4   | Deployment/migration?            | New MongoDB collection, no migration of existing file-based data (prototype data is ephemeral). Feature flag to gate availability during rollout.                                                                                                                                                                     | DECIDED                                                                                                   |
| 5   | External dependencies?           | None new. Leverages existing MongoDB, encryption service, and optionally ClickHouse for trace enrichment.                                                                                                                                                                                                             | ANSWERED                                                                                                  |

---

## Audit Log

| Round | Date       | Findings                                                                                                                                                                                                                                              | Resolution                                |
| ----- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1     | 2026-03-23 | Self-audit: All 10 quality gates pass. 15 FRs (exceeds min 4), 5 user stories (exceeds min 3), 7 integration references (exceeds min 2), all 3 isolation levels addressed, delivery plan has 5 parent tasks with numbered subtasks, 5 open questions. | No changes needed.                        |
| 2     | 2026-03-23 | Cross-phase consistency check: Feature spec aligns with existing codebase (TranscriptExport type, ConversationReader pattern, session-repo pattern, encryption plugin). Testing placeholder created. README files updated.                            | Added docs/features/README.md index file. |

---

## Files Created

- `docs/features/transcripts.md` — Feature spec
- `docs/testing/transcripts.md` — Testing guide placeholder (updated by test-spec phase)
- `docs/sdlc-logs/transcripts/feature-spec.log.md` — This file
