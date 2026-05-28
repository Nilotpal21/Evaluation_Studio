# HLD: Arch Intelligent File Processing

**Feature Spec**: `docs/features/sub-features/arch-intelligent-file-processing.md`
**Test Spec**: `docs/testing/sub-features/arch-intelligent-file-processing.md`
**Parent HLD**: `docs/specs/arch-multimodality.hld.md`
**Status**: DRAFT
**Author**: Arch team
**Date**: 2026-04-12

---

## 1. Problem Statement

B03 Multimodality (BETA) solved the transport problem — files can be uploaded, stored, and injected as raw text into the system prompt. However, no prompt tells the LLM what to do with them. When a user uploads an OpenAPI spec, requirements PDF, or screenshot, the file is silently present in context but the LLM doesn't acknowledge it, extract from it, or adapt its behavior. Users who upload specs at project start still get all the same interview questions. Files uploaded mid-conversation have no effect on the ongoing discussion.

This feature adds prompt-driven intelligence so the LLM acknowledges files, extracts structured data per phase, shows what it found, and continues intelligently.

---

## 2. Alternatives Considered

### Option A: Prompt-Only (No Server Changes)

- **Description**: Add file handling instructions to all prompt files (base, interview, blueprint, build, in-project). No changes to `buildFilePreamble()` or any server code. The LLM infers file type from content and extension in the existing `[File: name (EXT, size)]` header.
- **Pros**: Zero risk of breaking existing behavior. Simplest implementation (~160 lines of prompt text).
- **Cons**: LLM has no category hint — must infer `openapi` vs `yaml config` vs `abl agent` from raw content every turn. No phase-specific instruction block means the LLM must remember which phase it's in and apply the right extraction rules. Inconsistent behavior likely.
- **Effort**: S

### Option B: Prompt-First + Light Server Hints (Recommended)

- **Description**: Add prompt instructions (same as Option A) PLUS enhance `buildFilePreamble()` with category annotations derived from `classifyFileType()` and a phase-aware `[File Processing]` instruction block. Export `classifyFileType()` for cross-module use. Pass `phase` to `buildFilePreamble()`.
- **Pros**: LLM gets explicit category + phase guidance at the point where it reads files. Consistent behavior across turns. Backward-compatible (phase is optional, category falls back to extension). Builds on existing classification logic.
- **Cons**: Slightly more code (~75 lines beyond prompts). Changes `buildFilePreamble()` signature (backward-compatible extension).
- **Effort**: S-M

### Option C: Heavy Server-Side Extraction

- **Description**: Server parses files before the LLM sees them. OpenAPI → extract all endpoints/schemas into a structured JSON summary. YAML → attempt ABL compile. PDF → text extraction + summarization. Results passed to LLM as pre-processed data.
- **Pros**: Deterministic extraction — doesn't depend on LLM interpretation. Could produce structured `ExtractedKnowledge` artifact data.
- **Cons**: Significant code complexity. Each file type needs a parser with security hardening. YAML/JSON parsing introduces prototype pollution and injection risks. PDF parsing requires heavy dependencies. Every parser is an attack surface. Maintenance burden grows with each supported format.
- **Effort**: L

### Recommendation: Option B

**Rationale**: Option B provides the LLM with enough context (category + phase instructions) to extract intelligently while keeping the server lightweight and secure. The LLM is a better general-purpose "parser" than any set of server-side extractors — it reads content, understands structure, and adapts. Option A is too minimal (no category hints means inconsistent extraction). Option C introduces security and maintenance costs disproportionate to the value at this stage. Option B can be upgraded to C later for specific high-value file types (e.g., OpenAPI auto-import) without disrupting the prompt-based foundation.

---

## 3. Architecture

### System Context Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    Studio Frontend                        │
│  ChatInputBar → uploadFiles() → POST /api/arch-ai/files  │
│                → send()       → POST /api/arch-ai/message │
└──────────────────────┬───────────────────┬───────────────┘
                       │                   │
                       ▼                   ▼
┌──────────────────────────────────────────────────────────┐
│              Studio API Route (message/route.ts)          │
│                                                           │
│  1. Load session (phase, mode, messages)                  │
│  2. Compose system prompt (base+specialist+knowledge+     │
│     page context+phase prompt)                            │
│  3. Build file preamble ← getActiveFiles()                │
│     ├─ classifyFileType(mediaType) → category             │
│     ├─ Annotate headers: [File: name (category|EXT|size)] │
│     └─ Append [File Processing — Phase: X] block          │
│  4. systemPrompt += preamble                              │
│  5. streamChat(systemPrompt, messages) → LLM              │
└──────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│                    LLM Provider                           │
│  Reads: base prompt (File Processing Protocol)            │
│       + phase prompt (file-assisted instructions)         │
│       + [Session Files] with category annotations         │
│       + [File Processing] instruction block                │
│  Responds: acknowledges files, extracts, shows summary,   │
│            calls update_specification, identifies gaps     │
└──────────────────────────────────────────────────────────┘
```

### Component Diagram

```
packages/arch-ai/
├── prompts/
│   ├── base.ts              ← Add File Processing Protocol (~40 lines)
│   └── phases/
│       ├── interview.ts     ← Add File-Assisted Interview (~15 lines)
│       ├── blueprint.ts     ← Add File-Assisted Blueprint (~10 lines)
│       ├── build.ts         ← Add File-Assisted Build (~10 lines)
│       └── in-project.ts   ← Add File-Assisted In-Project (~10 lines)
├── executor/
│   └── content-block-resolver.ts
│       ├── SessionFileRecord   ← No change
│       ├── ContextCapabilities ← No change
│       ├── FilePreambleOptions ← NEW: extends ContextCapabilities + phase
│       └── buildFilePreamble() ← Enhanced: category annotations + instruction block
└── session/
    └── file-store-service.ts
        └── classifyFileType() ← Export (was module-private)

apps/studio/src/app/api/arch-ai/
└── message/route.ts
    ├── IN_PROJECT path (~L3199)  ← Pass phase: 'IN_PROJECT'
    └── ONBOARDING path (~L4785)  ← Pass phase: session.metadata.phase
```

### Data Flow (Dual Composition Paths)

The route handler has two distinct code paths for composing system prompts with file preamble:

**ONBOARDING path** (`route.ts` ~L4779-4805):

```
const phase = session.metadata.phase;       // ArchPhase: INTERVIEW|BLUEPRINT|BUILD|CREATE
let systemPrompt = composeSystemPrompt(specialist, phase, pageContext, userMessage);
// composeSystemPrompt → base + specialist + knowledge + pageContext + phase prompt
const { preamble } = buildFilePreamble(files, { ...caps, phase });
systemPrompt = `${systemPrompt}\n\n${preamble}`;
```

**IN_PROJECT path** (`route.ts` ~L3193-3218):

```
let systemPrompt = composeInProjectPrompt(specialist, pageContext, userText);
// composeInProjectPrompt → base + specialist + knowledge + pageContext + IN_PROJECT prompt
const { preamble } = buildFilePreamble(files, { ...caps, phase: 'IN_PROJECT' });
// NOTE: 'IN_PROJECT' is passed as a literal — session.metadata.phase is vestigial here
systemPrompt = `${systemPrompt}\n\n${preamble}`;
```

The key difference: ONBOARDING uses `session.metadata.phase` (which transitions INTERVIEW → BLUEPRINT → BUILD → CREATE). IN_PROJECT uses the literal `'IN_PROJECT'` because it has no sequential phases — the content router selects the specialist, not the phase.

**Common steps across both paths:**

1. **User uploads file**: `POST /api/arch-ai/files` → `FileStoreService.store()` → calls `classifyFileType(mediaType)` internally for processing timeout → stores file in `arch_session_files` collection with `blobId`
2. **User sends message with fileRefs**: `POST /api/arch-ai/message` with `{ text, fileRefs: [{ blobId }] }`
3. **Route handler composes system prompt**: via path-specific composition function (see above)
4. **Route handler builds file preamble**: `fileStoreService.getActiveFiles(ctx, session.id)` → maps to `SessionFileRecord[]` → `buildFilePreamble(files, { contextWindow: 200_000, supportsVision: true, provider, phase })`
5. **buildFilePreamble() enhanced logic**:
   - Compute token budget: `contextWindow * 0.5 = 100,000 tokens`
   - Evict oldest files if over budget (images first, then text)
   - For each remaining file: call `classifyFileType(file.mediaType)` → get category
   - Build `[Session Files]` block with annotated headers: `[File: name (category | EXT | size | ~tokens)]`
   - Build `[File Processing — Phase: X]` instruction block based on phase + categories present
   - Return `{ preamble, evictedFiles }`
6. **Preamble appended**: `systemPrompt = systemPrompt + '\n\n' + preamble`
7. **LLM call**: Provider receives system prompt with file content + category hints + phase instructions
8. **LLM response**: Acknowledges files, extracts per protocol, calls tools, streams response via SSE

### Prompt Layer Ordering

```
┌─────────────────────────────────────────────┐
│ Layer 1: BASE_PROMPT                         │
│   Core rules + File Processing Protocol (NEW)│
├─────────────────────────────────────────────┤
│ Layer 2: Specialist Prompt                   │
│   e.g., onboarding, multi-agent-architect    │
├─────────────────────────────────────────────┤
│ Layer 3: Knowledge Cards (L0 + L2)           │
│   Platform limits, intent-triggered          │
├─────────────────────────────────────────────┤
│ Layer 4: Page Context                        │
│   Current page, entity, metadata             │
├─────────────────────────────────────────────┤
│ Layer 5: Phase Prompt                        │
│   File-Assisted Interview/Blueprint/etc (NEW)│
├─────────────────────────────────────────────┤
│ Layer 6: File Preamble (appended by route)   │
│   [Session Files] + category headers (NEW)   │
│   [File Processing — Phase: X] block (NEW)   │
└─────────────────────────────────────────────┘
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Inherited from B03. `FileStoreService.getActiveFiles()` always includes `tenantId` in the query. No new data paths — file preamble is built from the same tenant-scoped query results. `classifyFileType()` operates on MIME type strings, not persisted data.                                                                                                                                                              |
| 2   | **Data Access Pattern** | No new data access. `buildFilePreamble()` is a pure synchronous function receiving in-memory `SessionFileRecord[]`. `classifyFileType()` is a pure function on a string. No database calls, no caching, no repository layer changes.                                                                                                                                                                                        |
| 3   | **API Contract**        | No HTTP API changes. The `POST /api/arch-ai/message` request/response shape is unchanged. The `buildFilePreamble()` function signature changes from `(files, capabilities: ContextCapabilities)` to `(files, options: FilePreambleOptions)` — see section 6 for the `FilePreambleOptions` type definition. This is backward-compatible since `phase` is optional.                                                           |
| 4   | **Security Surface**    | No new attack surface. The intelligence layer adds prompt text — no new data flows, endpoints, or parsing. `classifyFileType()` reads `mediaType` strings (already validated by `FileStoreService.store()` via magic byte verification). File content is already present in the system prompt via B03 plumbing. Content sniffing is not used — classification is MIME-type-only, avoiding any content-based attack vectors. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | `classifyFileType()` cannot fail — it's a deterministic string comparison that returns `'unknown'` as the default case. `buildFilePreamble()` is already wrapped in try-catch at both call sites (`route.ts` ~L3221 and ~L4807) — any exception results in the preamble being skipped and a warning logged. Users see the same behavior as before (file content without intelligence).                                                                                                                                                                                          |
| 6   | **Failure Modes** | The only degraded mode is "no file intelligence" — if `buildFilePreamble()` fails or `classifyFileType()` is not available, the system falls back to the pre-feature behavior (raw file content in preamble, no category annotations, no instruction block). This is the explicit backward-compatibility guarantee (FR-12). Prompt regression (LLM behaving differently with new instructions even when no files are present) is the highest risk — mitigated by keeping the File Processing Protocol conditional ("When files are attached...") so it's a no-op without files. |
| 7   | **Idempotency**   | N/A — no write operations. `buildFilePreamble()` is a pure function producing the same output for the same inputs. Retrying a message with the same files produces the same preamble.                                                                                                                                                                                                                                                                                                                                                                                           |
| 8   | **Observability** | No new trace events, metrics, or logs for v1. The existing B03 logging in `buildFilePreamble()` (eviction counts, file names at L320-328) remains unchanged. The instruction block content is visible in the system prompt captured by the mock LLM server in E2E tests. In production, the system prompt is not logged (security — may contain file content), but the category and phase can be logged at the preamble build point if needed in v1.1.                                                                                                                          |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | **Fixed overhead**: ~500-800 tokens added to base prompt (File Processing Protocol) + ~100-200 tokens per phase prompt (file-assisted instructions). These are outside the preamble budget and increase the fixed system prompt from ~5K to ~6K tokens — negligible vs 200K context window. **Preamble overhead**: ~200 tokens for the `[File Processing]` instruction block per request with files. This is inside the 100K token preamble budget (PREAMBLE_CONTEXT_FRACTION = 0.5) — 0.2% of budget. **classifyFileType()**: synchronous string comparison, sub-microsecond per file. No measurable latency impact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | **Migration Path**     | No migration needed. No schema changes. No data format changes. Category is computed lazily from existing `mediaType` field. Files uploaded before this change are handled by FR-12 — `classifyFileType()` returns their category based on stored `mediaType`, and `buildFilePreamble()` falls back to extension-based labels when category is `'unknown'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 11  | **Rollback Plan**      | Two-phase rollback enabled by the delivery plan structure. **Prompt-only revert**: revert the 5 prompt file changes (base.ts + 4 phase files). Category annotations and instruction blocks remain in the preamble but are benign context the LLM ignores without protocol instructions. **Full revert**: revert all changes (prompts + buildFilePreamble + classifyFileType export + route call site updates). Returns to pre-feature behavior. Both rollbacks are clean git reverts — no data cleanup needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 12  | **Test Strategy**      | **Unit tests** (12 scenarios): Assert prompt text contains expected sections (File Processing Protocol, phase-specific blocks, conflict resolution). Assert `classifyFileType` returns correct categories. Assert `buildFilePreamble` produces category annotations, phase-aware instruction blocks, handles `'unknown'` gracefully, excludes evicted files from instruction block. **Integration tests** (5 scenarios): Verify `buildFilePreamble()` ↔ `classifyFileType()` integration — category annotations appear in preamble, instruction blocks vary by phase, backward compat without phase, eviction interaction, cross-phase file persistence. **E2E tests** (7 scenarios): Real HTTP API calls via `POST /api/arch-ai/message` with file uploads, intercepting system prompt via mock LLM server to verify category annotations, instruction blocks, and phase-specific content. No mocking of platform components — only the LLM provider is mocked (external third-party). **Manual validation** (4 scenarios): LLM extraction quality (non-deterministic) verified manually with real file uploads across Interview, Blueprint, Build phases. |

---

## 5. Data Model

### New Collections/Tables

None.

### Modified Collections/Tables

None. The `arch_session_files` collection schema is unchanged. Category is computed lazily from the existing `mediaType` field by `classifyFileType()` at preamble-build time.

### Key Relationships

Same as B03 — files are session-scoped, referenced by `blobId` in `StoredMessage.content` (as `ArchContentBlock[]`), and cascade-deleted on session archival.

---

## 6. API Design

### New Endpoints

None.

### Modified Endpoints

None. `POST /api/arch-ai/message` behavior changes only in the system prompt content sent to the LLM — the HTTP request/response contract is unchanged.

### Internal Interface Changes

```typescript
import type { ArchPhase, ArchMode } from '../types/session.js';

// NEW type in content-block-resolver.ts
export interface FilePreambleOptions extends ContextCapabilities {
  /** Current phase or mode — used to generate phase-specific instruction block.
   *  ONBOARDING path passes session.metadata.phase (ArchPhase).
   *  IN_PROJECT path passes 'IN_PROJECT' (from ArchMode). */
  phase?: ArchPhase | ArchMode;
}

// CHANGED signature
export function buildFilePreamble(
  activeFiles: SessionFileRecord[],
  options: FilePreambleOptions, // was: capabilities: ContextCapabilities
): FilePreambleResult;

// EXPORTED from file-store-service.ts (was module-private)
export function classifyFileType(mediaType: string): string;
```

### Error Responses

No new error responses. The feature does not introduce new failure modes visible to the client.

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: No new audit events. File uploads are already logged by B03.
- **Rate Limiting**: N/A — no new endpoints or increased call volume.
- **Caching**: N/A — `buildFilePreamble()` is called once per request, no caching needed. `classifyFileType()` is sub-microsecond, no caching justified.
- **Encryption**: N/A — file content in the system prompt is transmitted to the LLM provider via HTTPS (existing). No new at-rest or in-transit concerns.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                      | Type                                                                         | Risk                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| B03 Multimodality (BETA)                        | Parent feature — file upload, storage, content blocks, `buildFilePreamble()` | Low — B03 is stable and well-tested                                                           |
| `classifyFileType()` in `file-store-service.ts` | Internal function, same package                                              | Low — pure function, deterministic                                                            |
| LLM provider vision support                     | External — Claude, GPT, etc.                                                 | Low — images already handled by B03; this feature adds instructions, not new image processing |

### Downstream (depends on this feature)

| Consumer                                 | Impact                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| v1.1 ExtractedKnowledge artifact tab     | Will consume structured extraction data; this feature validates extraction quality via prompts first          |
| v1.1 `file_processed` SSE event emission | Will add category to the SSE event payload; this feature establishes the category classification              |
| v1.1 Content-sniffing classification     | Will extend `classifyFileType()` to read first 2KB; this feature exports the function, enabling the extension |

---

## 9. Open Questions & Decisions Needed

1. **Instruction block token budget**: Should the `[File Processing]` instruction block have its own budget separate from file content, or share `PREAMBLE_CONTEXT_FRACTION`? Current design shares the budget since the block is ~200 tokens vs 100K budget.
2. **Prompt regression monitoring**: How do we detect if the File Processing Protocol causes behavioral changes when no files are present? Manual testing covers file scenarios but not regression on non-file conversations.
3. **classifyFileType accuracy**: Should v1.1 content-sniffing check only the first line (cheap) or first 2KB (more accurate)? And should this be a separate function or an enhancement to `classifyFileType()`?

---

## 10. References

- Feature spec: `docs/features/sub-features/arch-intelligent-file-processing.md`
- Test spec: `docs/testing/sub-features/arch-intelligent-file-processing.md`
- Parent HLD: `docs/specs/arch-multimodality.hld.md`
- Parent feature spec: `docs/features/arch-multimodality.md`
- Design spec: `docs/superpowers/specs/2026-04-09-arch-intelligent-file-processing-design.md` (on `features/arch-ai` branch)
- GPT-5.4 review: `docs/arch/review/2026-04-09-gpt-5.4-intelligent-file-processing-review.md` (on `features/arch-ai` branch)
- Prompt composition: `packages/arch-ai/src/prompts/index.ts`
- File preamble builder: `packages/arch-ai/src/executor/content-block-resolver.ts`
- File store service: `packages/arch-ai/src/session/file-store-service.ts`
