# Feature: Arch Intelligent File Processing

**Doc Type**: SUB-FEATURE
**Parent Feature**: [B03 Multimodality Support](../arch-multimodality.md)
**Status**: PLANNED
**Feature Area(s)**: `agent lifecycle`, `customer experience`
**Package(s)**: `arch-ai`
**Owner(s)**: `Arch team`
**Testing Guide**: `../../testing/sub-features/arch-intelligent-file-processing.md`
**Last Updated**: 2026-04-12

---

## 1. Introduction / Overview

### Problem Statement

B03 multimodality (BETA) solves the transport problem: files can be uploaded, stored, referenced in context, and rendered in the UI. However, the system has zero intelligence for processing those files. No prompt tells the LLM to acknowledge, extract from, or act on uploaded files. When a user drops an OpenAPI spec, requirements PDF, or screenshot into the chat, the file content is silently injected as raw text in the system prompt via `buildFilePreamble()` with no processing guidance. The LLM doesn't know it should extract agents, tools, constraints, or requirements from the file. It doesn't acknowledge the file. It doesn't skip redundant questions. It treats the file as invisible context.

Modern AI tools (v0.dev, Lovable, Claude Code) auto-detect file types and act on them — a screenshot becomes code, a CSV becomes a dashboard, a PRD becomes architecture. Arch does none of this.

### Goal Statement

Add prompt-driven intelligence so that when a user uploads files at any point in any phase (Interview, Blueprint, Build, In-Project), Arch acknowledges the file, extracts relevant structured data, shows the user what it found, identifies gaps, and continues the conversation intelligently — skipping questions already answered by the file and adapting behavior per file type and current phase.

### Summary

This sub-feature adds comprehensive File Processing Protocol instructions to the base prompt and all phase prompts, enhances the `buildFilePreamble()` output with file category annotations and phase-aware instruction blocks, and exports the existing `classifyFileType()` function for use in the preamble builder. No new UI components, no new SSE events, no schema changes — v1 is entirely prompt-driven with lightweight server-side classification hints.

---

## 2. Scope

### Goals

- Comprehensive prompt instructions telling the LLM how to handle uploaded files across all phases
- File acknowledgment: every uploaded file is explicitly acknowledged by name and detected type
- Proactive extraction: LLM extracts structured data (agents, tools, rules, constraints, channels) from spec files without being asked
- Phase-aware behavior: different extraction depth per phase (Interview extracts to spec, Blueprint to topology, Build to agent code)
- Gap identification: LLM identifies what's missing from files and asks only about gaps
- File category annotations in the system prompt preamble so the LLM knows what type of file it's processing
- Contextual merge: files uploaded mid-conversation merge naturally into the current phase/topic
- User data precedence: when file data conflicts with user-stated preferences, user wins with discrepancy noted

### Non-Goals (Out of Scope)

- New UI components or artifact tabs for extracted knowledge (v1.1)
- New SSE event emission for `file_processed` / `file_error` (v1.1 — events are defined but dormant)
- Database schema changes (category derived lazily from mediaType, not persisted)
- Auto-compile of uploaded ABL YAML (v1.1)
- Auto-import of OpenAPI tools into project (S2-F12, v1.1)
- CREATE phase file instructions — CREATE is coordinator-driven (summary + project creation), not specialist-driven; files are already fully processed by Interview/Blueprint/Build before CREATE
- Persistent knowledge base across sessions (v2)
- Smart file routing to different specialists based on file type (v2)
- Audio/video file support (B52)
- Per-file upload progress UI (separate enhancement)

---

## 3. User Stories

1. As a **solution designer**, I want to drop my API spec and requirements doc at the start of a project so that Arch extracts agents, tools, and constraints automatically and I don't have to answer questions the files already cover.
2. As a **solution designer**, I want Arch to acknowledge every file I upload by name and type so that I know it was received and processed.
3. As a **solution designer**, I want Arch to show me a structured summary of what it extracted from my files so that I can verify and correct before it proceeds.
4. As a **solution designer**, I want to paste a screenshot of my current architecture during the Blueprint phase so that Arch aligns its topology design with my existing system.
5. As a **solution designer**, I want to upload a reference agent YAML during the Build phase so that Arch uses it as a template pattern for generating new agents.
6. As a **solution designer**, I want Arch to tell me what's missing from my uploaded files so that I know exactly what additional information it needs.
7. As a **solution designer**, I want file uploads mid-conversation to merge naturally without breaking the current topic so that I can share context at any time.

---

## 4. Functional Requirements

1. **FR-1**: The system must include a File Processing Protocol in the base prompt (`base.ts`) that instructs the LLM to: (a) always acknowledge uploaded files by name and type, (b) extract proactively without waiting to be asked, (c) show a structured extraction summary, (d) identify gaps, (e) merge file context naturally, (f) never ignore files.
2. **FR-2**: The system must include phase-specific file handling instructions in each phase prompt (Interview, Blueprint, Build, In-Project) that adapt extraction depth and behavior to the current phase.
3. **FR-3**: The Interview phase prompt must instruct the LLM to extract requirements, agents, tools, constraints, channels, and compliance data from uploaded files and pre-populate the specification via `update_specification` (available only in INTERVIEW phase per `PHASE_TOOL_MAP`), skipping interview questions already answered by the file.
4. **FR-4**: The Blueprint phase prompt must instruct the LLM to use uploaded architecture diagrams and API specs to inform topology design, aligning the generated topology with file content.
5. **FR-5**: The Build phase prompt must instruct the LLM to validate uploaded ABL YAML structure, extract tool definitions from OpenAPI specs, and reference uploaded code patterns when generating agents.
6. **FR-6**: The In-Project phase prompt must instruct the LLM to analyze uploaded files in context of the current specialist and topic, including screenshots for diagnostics and spec updates for diffing against project state.
7. **FR-7**: The `buildFilePreamble()` function must annotate each file header with its category (derived from `classifyFileType()`) so the LLM knows what type of file it's processing (e.g., `[File: api.yaml (openapi | YAML | 45.2KB | ~12,340 tokens)]`).
8. **FR-8**: The `buildFilePreamble()` function must append a phase-aware `[File Processing]` instruction block after the file content that tells the LLM what to do based on the current phase and the file categories present.
9. **FR-9**: The `buildFilePreamble()` function must accept the current phase as a parameter so it can generate phase-specific instruction blocks.
10. **FR-10**: The `classifyFileType()` function in `file-store-service.ts` must be exported so it can be used by `buildFilePreamble()` without duplication.
11. **FR-11**: The File Processing Protocol must include a conflict-resolution instruction that tells the LLM to prefer user-stated data over file-extracted data and note the discrepancy (testable: verify the instruction text exists in the base prompt).
12. **FR-12**: Files uploaded before this change (without category annotation) must still produce valid preamble output — the system must handle missing category gracefully by defaulting to the file extension.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                   |
| -------------------------- | ------------ | ------------------------------------------------------- |
| Project lifecycle          | NONE         | No changes to project creation or lifecycle             |
| Agent lifecycle            | PRIMARY      | File intelligence directly affects agent design quality |
| Customer experience        | PRIMARY      | Core UX improvement — files are intelligently processed |
| Integrations / channels    | NONE         | Arch-specific, not channel-facing                       |
| Observability / tracing    | NONE         | No new events or traces for v1                          |
| Governance / controls      | NONE         | No new security surface — prompt-only changes           |
| Enterprise / compliance    | NONE         | No new data handling — files already in context         |
| Admin / operator workflows | NONE         | No admin-facing changes                                 |

### Related Feature Integration Matrix

| Related Feature              | Relationship Type | Why It Matters                                                         | Key Touchpoints                                      | Current State |
| ---------------------------- | ----------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- | ------------- |
| B03 Multimodality (parent)   | extends           | This sub-feature adds intelligence on top of B03 plumbing              | `buildFilePreamble()`, `classifyFileType()`, prompts | BETA          |
| Interview Phase (S1)         | shares data with  | File extraction pre-populates specification via `update_specification` | `interview.ts`, widget flow                          | Implemented   |
| Blueprint Phase (S2)         | shares data with  | File content informs topology-first generation                         | `blueprint.ts`, `generate_topology`                  | Implemented   |
| Build Phase (S3)             | shares data with  | Uploaded YAML/specs inform agent code generation                       | `build.ts`, `generate_agent`                         | Implemented   |
| B02 Page Context             | shares data with  | Both inject context into system prompt; patterns shared                | System prompt composition in `prompts/index.ts`      | Implemented   |
| B05 Live Thinking Visibility | shares data with  | Activity SSE events share protocol; file processing could emit         | SSE schema                                           | Implemented   |

---

## 6. Design Considerations

This feature is purely behavioral — no new UI surfaces, no new components. The UX improvement is in how the LLM responds when files are present. The solution designer sees:

- Files acknowledged explicitly in chat responses
- Structured extraction summaries inline in chat
- Fewer redundant interview questions when specs are uploaded
- Architecture alignment when diagrams are shared during Blueprint
- Reference pattern awareness when YAML is shared during Build

Design spec: `docs/superpowers/specs/2026-04-09-arch-intelligent-file-processing-design.md`
GPT-5.4 review: `docs/arch/review/2026-04-09-gpt-5.4-intelligent-file-processing-review.md`

---

## 7. Technical Considerations

### Prompt-First Architecture

All intelligence is in prompt instructions. No server-side parsing, no content extraction, no heavy processing. The LLM is the parser — it reads the file content from the system prompt preamble and follows the instructions to extract, acknowledge, and act on it.

### File Category Derivation (Lazy, Not Persisted)

The existing `classifyFileType()` in `file-store-service.ts` maps `mediaType` to categories deterministically. Rather than persisting `category` in the DB model, `buildFilePreamble()` calls `classifyFileType()` at preamble-build time. This avoids schema changes and backward-compatibility concerns.

### Phase Parameter for buildFilePreamble()

The function's signature changes from `(activeFiles, capabilities)` to `(activeFiles, options)` where `options` extends `ContextCapabilities` with `phase`. Both call sites in `message/route.ts` are internal and updated together.

### Backward Compatibility

Files uploaded before this change will not have category annotations. `buildFilePreamble()` falls back to extension-based labels (existing behavior) when `classifyFileType()` returns `'unknown'`. No migration needed.

---

## 8. How to Consume

### Studio UI

No new UI surfaces. The intelligence manifests in how the LLM responds in the existing chat interface — both the `/arch` onboarding page and the in-project `ArchOverlay`. Users interact with the same file upload mechanisms (drag-drop, paste, file picker) that already exist.

### API (Runtime)

N/A — this feature is Arch-specific, not Runtime-facing.

### API (Studio)

No new API routes. The existing `POST /api/arch-ai/message` route already injects file preamble into the system prompt. The enhancement is in the preamble content and prompt instructions.

### Admin Portal

N/A

### Channel / SDK / Voice / A2A / MCP Integration

N/A — Arch-specific, not channel-facing.

---

## 9. Data Model

### Collections / Tables

No schema changes. The existing `arch_session_files` collection remains unchanged.

The `classifyFileType()` function (currently module-private in `file-store-service.ts`) is exported but the data model is not modified. Category is computed lazily at preamble-build time from the stored `mediaType` field.

### Key Relationships

Same as parent feature B03 — files are session-scoped, referenced by `blobId` in messages, and cascade-deleted on session archival.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                      | Purpose                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/arch-ai/src/prompts/base.ts`                    | Add File Processing Protocol to base prompt                |
| `packages/arch-ai/src/prompts/phases/interview.ts`        | Add File-Assisted Interview instructions                   |
| `packages/arch-ai/src/prompts/phases/blueprint.ts`        | Add File-Assisted Blueprint instructions                   |
| `packages/arch-ai/src/prompts/phases/build.ts`            | Add File-Assisted Build instructions                       |
| `packages/arch-ai/src/prompts/phases/in-project.ts`       | Add File-Assisted In-Project instructions                  |
| `packages/arch-ai/src/executor/content-block-resolver.ts` | Enhance `buildFilePreamble()` with category + phase params |
| `packages/arch-ai/src/session/file-store-service.ts`      | Export `classifyFileType()` for use in preamble builder    |

### Routes / Handlers

| File                                               | Purpose                                                  |
| -------------------------------------------------- | -------------------------------------------------------- |
| `apps/studio/src/app/api/arch-ai/message/route.ts` | Pass `phase` to `buildFilePreamble()` at both call sites |

### UI Components

N/A — no UI changes for v1.

### Tests

| File                                                                   | Type | Coverage Focus                        |
| ---------------------------------------------------------------------- | ---- | ------------------------------------- |
| `packages/arch-ai/src/__tests__/build-file-preamble.test.ts`           | unit | Preamble output with category + phase |
| `packages/arch-ai/src/__tests__/classify-file-type.test.ts`            | unit | Category classification per mediaType |
| `packages/arch-ai/src/__tests__/file-preamble-backward-compat.test.ts` | unit | Preamble with files missing category  |

---

## 11. Configuration

### Environment Variables

N/A — no new environment variables.

### Runtime Configuration

N/A — no new feature flags or runtime config.

### DSL / Agent IR / Schema

N/A — this feature affects prompt behavior, not the DSL or IR.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Project isolation | N/A — files are session-scoped, not project-scoped. No cross-project access.                                 |
| Tenant isolation  | Inherited from B03: every `FileStoreService` query includes `tenantId`. No new data paths introduced.        |
| User isolation    | Inherited from B03: files are scoped to session, which is scoped to (tenantId, userId). No new access paths. |

### Security & Compliance

No new security surface. The intelligence layer adds prompt text — it does not introduce new data flows, new endpoints, or new parsing. File content is already present in the system prompt via B03 plumbing. Tenant isolation is enforced at the `FileStoreService` query level (verified: tenantId in all queries). The `classifyFileType()` function uses `mediaType` strings, not content inspection — no new attack vector.

### Performance & Scalability

No measurable performance impact. The `classifyFileType()` function is a synchronous string comparison on `mediaType` — sub-microsecond. The prompt additions increase system prompt length by ~500-800 tokens (File Processing Protocol + phase instructions), well within the existing `PREAMBLE_CONTEXT_FRACTION = 0.5` budget. LLM response times may increase slightly due to larger system prompts, but this is bounded by the existing context window management.

### Reliability & Failure Modes

Prompt-only changes have no failure modes beyond the existing LLM invocation. If `classifyFileType()` returns `'unknown'`, the preamble falls back to extension-based labeling (existing behavior). If `buildFilePreamble()` receives files without a phase parameter, it falls back to generic instructions.

### Observability

No new trace events, metrics, or logs for v1. The existing B03 logging in `buildFilePreamble()` (eviction counts, file names) remains unchanged.

### Data Lifecycle

No changes — files remain session-scoped with 30-day TTL and cascade delete on archival (inherited from B03).

---

## 13. Delivery Plan / Work Breakdown

1. **Export `classifyFileType()` and enhance `buildFilePreamble()`**
   1.1. Export `classifyFileType()` from `file-store-service.ts`
   1.2. Add `phase` parameter to `buildFilePreamble()` signature (extend `ContextCapabilities` → `FilePreambleOptions`)
   1.3. Add category annotation to file headers in preamble output
   1.4. Add phase-aware `[File Processing]` instruction block after file content
   1.5. Update both call sites in `message/route.ts` to pass `phase`
   1.6. Add unit tests for preamble output with category + phase
   1.7. Add unit tests for backward compatibility (files without category)
   **Exit criteria:** All preamble unit tests pass. Backward compat test passes. `pnpm build --filter=@agent-platform/arch-ai` succeeds. Both route call sites compile with new signature.

2. **Add File Processing Protocol to prompts**
   2.1. Add File Processing Protocol section to `base.ts`
   2.2. Add File-Assisted Interview instructions to `interview.ts`
   2.3. Add File-Assisted Blueprint instructions to `blueprint.ts`
   2.4. Add File-Assisted Build instructions to `build.ts`
   2.5. Add File-Assisted In-Project instructions to `in-project.ts`
   **Exit criteria:** Prompt diffs reviewed. Base prompt contains File Processing Protocol section. Each phase prompt contains file-handling block. `pnpm build --filter=@agent-platform/arch-ai` succeeds.

3. **Integration testing and validation**
   3.1. Test file upload → extraction flow in Interview phase (OpenAPI spec)
   3.2. Test file upload → extraction flow in Interview phase (requirements PDF)
   3.3. Test mid-conversation file upload in Blueprint phase (architecture diagram)
   3.4. Test file upload in Build phase (reference YAML)
   3.5. Test backward compatibility with existing sessions (no category on old files)
   **Exit criteria:** Manual validation checklist completed for at least 2 file types per phase. Backward compat verified with existing session data. No regressions in existing B03 tests.

---

## 14. Success Metrics

| Metric                                   | Baseline                | Target                   | How Measured                                      |
| ---------------------------------------- | ----------------------- | ------------------------ | ------------------------------------------------- |
| File acknowledgment rate                 | 0% (LLM ignores files)  | 100% (every file named)  | Manual review of chat logs with file uploads      |
| Interview questions skipped (with specs) | 0 (all questions asked) | 50%+ questions skipped   | Count questions asked vs spec fields pre-filled   |
| Extraction accuracy                      | N/A                     | 80%+ correct extractions | Manual review of extracted vs actual file content |
| Conversation flow interruption           | N/A                     | 0 flow breaks            | Manual testing of mid-conversation uploads        |

---

## 15. Open Questions

1. Should the `[File Processing]` instruction block have a token budget independent of the file content budget, or share the existing `PREAMBLE_CONTEXT_FRACTION`?
2. How should the LLM handle extremely large files where the content is truncated at 50K chars — should it note that extraction may be incomplete?
3. Should the category classification be extended to content-sniffing in v1.1 (e.g., read first 2KB to distinguish OpenAPI from generic YAML), or remain MIME-type-only?
4. How do we measure extraction quality at scale — manual review or automated comparison against test fixtures?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                             | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | SVG sanitization via DOMPurify not yet implemented (pre-existing B03 gap)                                                                                                                               | Medium   | Open   |
| GAP-002 | `file_processed` SSE events defined but never emitted — no structured extraction feedback to UI                                                                                                         | Medium   | Open   |
| GAP-003 | Image sub-classification (screenshot vs diagram) relies entirely on LLM vision, no server hints                                                                                                         | Low      | Open   |
| GAP-004 | No artifact tab for extracted knowledge in v1 — extraction only visible in chat text                                                                                                                    | Low      | Open   |
| GAP-005 | Upload progress UI not wired — `ChatInputBar` accepts prop but neither page passes it                                                                                                                   | Low      | Open   |
| GAP-006 | `classifyFileType()` maps all JSON/YAML to `openapi` without content inspection — non-OpenAPI YAML/JSON files will be mislabeled in preamble headers. Addressed in v1.1 via content-sniffing (see OQ-3) | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                  | Coverage Type | Status     | Test File / Note                             |
| --- | --------------------------------------------------------- | ------------- | ---------- | -------------------------------------------- |
| 1   | `classifyFileType` returns correct category per MIME      | unit          | NOT TESTED | `classify-file-type.test.ts`                 |
| 2   | `buildFilePreamble` with phase produces instruction block | unit          | NOT TESTED | `build-file-preamble.test.ts`                |
| 3   | `buildFilePreamble` with old files (no category) works    | unit          | NOT TESTED | `file-preamble-backward-compat.test.ts`      |
| 4   | Preamble category annotation matches classifyFileType     | unit          | NOT TESTED | `build-file-preamble.test.ts`                |
| 5   | File upload → LLM acknowledges file by name               | e2e           | NOT TESTED | Manual or E2E with chat log assertion        |
| 6   | OpenAPI spec upload → tools extracted in Interview        | e2e           | NOT TESTED | Manual testing with sample OpenAPI spec      |
| 7   | Mid-conversation file upload doesn't break flow           | e2e           | NOT TESTED | Manual testing in Blueprint phase            |
| 8   | Interview with specs → fewer questions asked              | e2e           | NOT TESTED | Manual comparison: with file vs without file |
| 9   | Route passes phase to buildFilePreamble correctly         | integration   | NOT TESTED | Verify both ONBOARDING and IN_PROJECT paths  |

### Testing Notes

Unit tests cover the `classifyFileType` export and `buildFilePreamble` enhancements. E2E testing requires manual validation because the LLM's extraction behavior is non-deterministic — we can verify that the prompt instructs extraction, but the quality of extraction depends on the model. Integration tests verify the wiring between the route handler and the enhanced preamble builder.

**Coverage Expectations:** This feature is primarily prompt-driven, so unit coverage applies only to the two modified functions: `classifyFileType()` (100% branch coverage for all MIME type mappings) and `buildFilePreamble()` (100% coverage for phase parameter handling, category annotation, instruction block generation, and backward compat). Prompt text changes are verified by asserting the instruction block presence in preamble output. LLM behavioral validation is manual.

> Full testing details: `../../testing/sub-features/arch-intelligent-file-processing.md`

---

## 18. References

- Design spec: `docs/superpowers/specs/2026-04-09-arch-intelligent-file-processing-design.md` (on `features/arch-ai` branch)
- GPT-5.4 review: `docs/arch/review/2026-04-09-gpt-5.4-intelligent-file-processing-review.md` (on `features/arch-ai` branch)
- Parent feature spec: `docs/features/arch-multimodality.md`
- Parent HLD: `docs/specs/arch-multimodality.hld.md`
- Backlog: `docs/arch/backlogs/B03-file-upload-enhancement.md`
- Prompts architecture: `packages/arch-ai/src/prompts/index.ts` (Contract 9)
- File preamble builder: `packages/arch-ai/src/executor/content-block-resolver.ts`
- File store service: `packages/arch-ai/src/session/file-store-service.ts`
