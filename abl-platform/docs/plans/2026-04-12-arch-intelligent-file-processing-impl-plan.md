# LLD: Arch Intelligent File Processing

**Feature Spec**: `docs/features/sub-features/arch-intelligent-file-processing.md`
**HLD**: `docs/specs/arch-intelligent-file-processing.hld.md`
**Test Spec**: `docs/testing/sub-features/arch-intelligent-file-processing.md`
**Status**: DRAFT
**Date**: 2026-04-12

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                        | Rationale                                                                                                                                                                                                                                                                                                                                                | Alternatives Rejected                                                                 |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| D-1 | Server code first, then prompts                                                 | Prompt text references category format which must be locked before prompts can reference it                                                                                                                                                                                                                                                              | Prompts first (can't test alignment), all-at-once (too large a commit)                |
| D-2 | `Map<string, (categories: Set<string>) => string>` for phase instruction blocks | Map of functions — each takes the set of file categories present and returns instruction text with category-specific hints. Cleaner than switch, testable, gracefully skips missing keys (CREATE/ONBOARDING). Functions needed because instruction text varies by which categories are present (e.g., openapi + image → different hints than csv alone). | Switch statement (verbose), static string map (can't vary by categories present)      |
| D-3 | Keep `isImageMediaType()` alongside `classifyFileType()`                        | Eviction concern (display) vs intelligence concern (category); additive per CLAUDE.md; avoids coupling                                                                                                                                                                                                                                                   | Replace isImageMediaType (couples eviction to classification, violates additive-only) |
| D-4 | Literal strings in prompt files                                                 | All 5 existing prompt files use static exported constants; dynamic context belongs in preamble (Layer 6)                                                                                                                                                                                                                                                 | Template literals with interpolation (breaks established pattern)                     |
| D-5 | Use `ArchPhase \| ArchMode` type                                                | Reuses existing types from `types/session.ts`; `phase?` is optional for backward compat                                                                                                                                                                                                                                                                  | `ArchPhase \| 'IN_PROJECT'` (ad-hoc literal, HLD R1 finding), `string` (too loose)    |
| D-6 | Copy `makeFile()` helper to new test files                                      | Test spec defines separate test files; self-contained tests; don't modify working B03 test file                                                                                                                                                                                                                                                          | Shared test utility module (over-engineering for 3 test files)                        |

### Key Interfaces & Types

```typescript
// content-block-resolver.ts — NEW type
import type { ArchPhase, ArchMode } from '../types/session.js';

export interface FilePreambleOptions extends ContextCapabilities {
  /** Current phase or mode — drives phase-specific instruction block.
   *  ONBOARDING: pass session.metadata.phase (ArchPhase).
   *  IN_PROJECT: pass 'IN_PROJECT' literal (ArchMode). */
  phase?: ArchPhase | ArchMode;
}
```

```typescript
// file-store-service.ts — EXPORTED (was module-private)
export function classifyFileType(mediaType: string): string;
// Returns: 'image' | 'pdf' | 'csv' | 'docx' | 'openapi' | 'code' | 'unknown'
```

### Module Boundaries

| Module                               | Responsibility                                     | Depends On                                         |
| ------------------------------------ | -------------------------------------------------- | -------------------------------------------------- |
| `prompts/base.ts`                    | File Processing Protocol (Layer 1)                 | None                                               |
| `prompts/phases/*.ts`                | Phase-specific file instructions (Layer 5)         | None                                               |
| `executor/content-block-resolver.ts` | Category annotations + instruction block (Layer 6) | `session/file-store-service.ts` (classifyFileType) |
| `session/file-store-service.ts`      | File classification (export only)                  | None (pure function)                               |
| `message/route.ts`                   | Pass phase to buildFilePreamble                    | `content-block-resolver.ts` (FilePreambleOptions)  |

---

## 2. File-Level Change Map

### New Files

| File                                                               | Purpose                                                                     | LOC Estimate |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------ |
| `packages/arch-ai/src/__tests__/classify-file-type.test.ts`        | UT-3, UT-4, UT-8, UT-12: exhaustive classification tests                    | ~60          |
| `packages/arch-ai/src/__tests__/build-file-preamble-phase.test.ts` | UT-5 through UT-11, INT-1 through INT-5: preamble with phase/category tests | ~200         |
| `packages/arch-ai/src/__tests__/prompt-file-protocol.test.ts`      | UT-1, UT-2, UT-9: prompt content assertion tests                            | ~80          |

### Modified Files

| File                                                      | Change Description                                                                                                                              | Risk                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `packages/arch-ai/src/session/file-store-service.ts`      | Add `export` to `classifyFileType` function (L104)                                                                                              | Low — one keyword               |
| `packages/arch-ai/src/executor/content-block-resolver.ts` | Add `FilePreambleOptions` type, add `classifyFileType` import, enhance `buildFilePreamble()` header annotations + instruction block (~40 lines) | Med — function signature change |
| `apps/studio/src/app/api/arch-ai/message/route.ts`        | Add `phase` to buildFilePreamble options at 2 call sites (~L3199, ~L4785)                                                                       | Low — 2 line changes            |
| `packages/arch-ai/src/prompts/base.ts`                    | Append File Processing Protocol section (~40 lines) to BASE_PROMPT                                                                              | Low — additive text             |
| `packages/arch-ai/src/prompts/phases/interview.ts`        | Append File-Assisted Interview section (~15 lines)                                                                                              | Low — additive text             |
| `packages/arch-ai/src/prompts/phases/blueprint.ts`        | Append File-Assisted Blueprint section (~10 lines)                                                                                              | Low — additive text             |
| `packages/arch-ai/src/prompts/phases/build.ts`            | Append File-Assisted Build section (~10 lines)                                                                                                  | Low — additive text             |
| `packages/arch-ai/src/prompts/phases/in-project.ts`       | Append File-Assisted In-Project section (~10 lines)                                                                                             | Low — additive text             |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Server-Side Enhancement (classifyFileType + buildFilePreamble)

**Goal**: Export `classifyFileType`, enhance `buildFilePreamble()` with category annotations and phase-aware instruction block, update route call sites.

**Tasks**:

1.1. **Export classifyFileType** — In `file-store-service.ts` L104, change `function classifyFileType` to `export function classifyFileType`. Update `session/index.ts` barrel export if needed.

1.2. **Add FilePreambleOptions type** — In `content-block-resolver.ts`, add the `FilePreambleOptions` interface extending `ContextCapabilities` with optional `phase?: ArchPhase | ArchMode`. Import `ArchPhase`, `ArchMode` from `'../types/session.js'`. Change `buildFilePreamble` parameter type from `ContextCapabilities` to `FilePreambleOptions`.

1.3. **Add PHASE_INSTRUCTIONS map** — In `content-block-resolver.ts`, add a module-level `const PHASE_INSTRUCTIONS: Map<string, (categories: Set<string>) => string>` that maps each phase to a function producing the instruction text. Keys: `'INTERVIEW'`, `'BLUEPRINT'`, `'BUILD'`, `'IN_PROJECT'`. Values: functions that take the set of categories present and return instruction text with category-specific hints. Omit `'CREATE'` and `'ONBOARDING'` (no file instructions needed).

1.4. **Enhance buildFilePreamble header annotations** — In the file-rendering loop (currently L301-315), import and call `classifyFileType(file.mediaType)` for each file. Change header format from `[File: name (EXT, size)]` to `[File: name (category | EXT | size | ~tokens)]`. For images, change from `[Image: name (WxH, mediaType)]` to `[Image: name (image | WxH | mediaType | ~tokens)]`. When `classifyFileType` returns `'unknown'`, fall back to extension-only label (existing behavior, FR-12).

1.5. **Append phase-aware instruction block** — After the `[/Session Files]` closing tag (L318), if `options.phase` is provided and `PHASE_INSTRUCTIONS` has an entry for it: compute `categories = new Set(remainingFiles.map(f => classifyFileType(f.mediaType)))`, call the instruction function, and append `\n\n[File Processing — Phase: ${phase}]\n${instructionText}\n[/File Processing]`.

1.6. **Update route call sites** — In `route.ts`:

- ONBOARDING path (~L4785): add `phase: phase` (using the existing `const phase = session.metadata.phase` at L4178) to the `buildFilePreamble` options.
- IN_PROJECT path (~L3199): add `phase: 'IN_PROJECT'` to the options.

  1.7. **Run prettier + build + existing tests** — `npx prettier --write <files>`, `pnpm build --filter=@agent-platform/arch-ai`, `pnpm test --filter=@agent-platform/arch-ai` (verify 13 existing B03 tests still pass).

**Files Touched**:

- `packages/arch-ai/src/session/file-store-service.ts` — export classifyFileType
- `packages/arch-ai/src/executor/content-block-resolver.ts` — FilePreambleOptions, PHASE_INSTRUCTIONS, enhanced buildFilePreamble
- `apps/studio/src/app/api/arch-ai/message/route.ts` — pass phase at 2 call sites

**Exit Criteria**:

- [ ] `classifyFileType` is importable from `'../session/file-store-service.js'` in content-block-resolver.ts
- [ ] `buildFilePreamble()` with `phase: 'INTERVIEW'` + YAML file produces preamble containing `(openapi | YAML |` in header and `[File Processing — Phase: INTERVIEW]` block
- [ ] `buildFilePreamble()` without `phase` produces preamble matching pre-feature format (no instruction block)
- [ ] `buildFilePreamble()` with file having `mediaType: 'application/octet-stream'` uses extension-based label (FR-12)
- [ ] Evicted files do not appear in `[File Processing]` instruction block
- [ ] `buildFilePreamble()` file headers include token estimate (e.g., `~12,340 tokens`) using existing `metadata.tokenEstimate` (which already accounts for vision token costs for images)
- [ ] `pnpm build --filter=@agent-platform/arch-ai` succeeds with 0 errors
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds (route.ts compiles)
- [ ] All 13 existing B03 preamble/resolver tests pass (no regressions)

**Test Strategy**:

- Unit: UT-5, UT-6, UT-7, UT-10, UT-11 (preamble phase behavior)
- Unit: UT-3, UT-4, UT-8, UT-12 (classifyFileType)
- Integration: INT-1 through INT-5 (category annotation + phase instruction + eviction + cross-phase)

**Rollback**: Revert the 3 file changes. `classifyFileType` becomes module-private again, `buildFilePreamble` returns to old signature, route call sites drop `phase`. All existing behavior restored.

---

### Phase 2: Prompt Intelligence (File Processing Protocol + Phase Instructions)

**Goal**: Add the File Processing Protocol to the base prompt and phase-specific file handling instructions to all 4 phase prompts.

**Tasks**:

2.1. **Add File Processing Protocol to base.ts** — Append a `## File Processing Protocol` section to `BASE_PROMPT` with the 6 protocol rules: (a) always acknowledge, (b) extract proactively, (c) show extraction summary, (d) identify gaps, (e) merge naturally, (f) never ignore. Include the category-to-extraction mapping and conflict resolution instruction (FR-11: user data wins). Keep the protocol conditional: "When files are attached to a message or present in session context:" so it's a no-op without files.

2.2. **Add File-Assisted Interview to interview.ts** — Append a `## File-Assisted Interview` section to `INTERVIEW_PHASE_PROMPT`. Key instructions: extract all relevant info before asking questions, pre-populate specification via `update_specification`, only ask about gaps, show "Knowledge Extracted" summary.

2.3. **Add File-Assisted Blueprint to blueprint.ts** — Append a `## File-Assisted Blueprint` section. Key instructions: describe architecture diagrams and align topology, extract endpoints from API specs for tool assignments, cross-reference requirements docs.

2.4. **Add File-Assisted Build to build.ts** — Append a `## File-Assisted Build` section to `BUILD_PHASE_PROMPT`. Key instructions: validate ABL YAML structure, extract tool definitions from OpenAPI, reference code patterns.

2.5. **Add File-Assisted In-Project to in-project.ts** — Append a `## File-Assisted In-Project` section. Key instructions: analyze in context of current specialist, screenshots for diagnostics, spec updates as diffs.

2.6. **Run prettier + build** — `npx prettier --write <files>`, `pnpm build --filter=@agent-platform/arch-ai`.

**Files Touched**:

- `packages/arch-ai/src/prompts/base.ts` — +~40 lines
- `packages/arch-ai/src/prompts/phases/interview.ts` — +~15 lines
- `packages/arch-ai/src/prompts/phases/blueprint.ts` — +~10 lines
- `packages/arch-ai/src/prompts/phases/build.ts` — +~10 lines
- `packages/arch-ai/src/prompts/phases/in-project.ts` — +~10 lines

**Exit Criteria**:

- [ ] `BASE_PROMPT` contains "File Processing Protocol" heading
- [ ] `BASE_PROMPT` contains all 6 protocol rules (acknowledge, extract, show, gaps, merge, never ignore)
- [ ] `BASE_PROMPT` contains conflict resolution instruction (user data wins)
- [ ] `INTERVIEW_PHASE_PROMPT` contains "File-Assisted Interview" section mentioning `update_specification`
- [ ] `BLUEPRINT_PHASE_PROMPT` contains "File-Assisted Blueprint" section mentioning topology
- [ ] `BUILD_PHASE_PROMPT` contains "File-Assisted Build" section mentioning ABL validation
- [ ] `IN_PROJECT_PHASE_PROMPT` contains "File-Assisted In-Project" section
- [ ] `pnpm build --filter=@agent-platform/arch-ai` succeeds
- [ ] All existing tests pass — specifically verify `prompts.test.ts` and any prompt-related tests still pass after content additions

**Test Strategy**:

- Unit: UT-1 (base prompt protocol), UT-2 (phase prompt blocks), UT-9 (conflict resolution)

**Rollback**: Revert the 5 prompt file changes. Category annotations and instruction blocks from Phase 1 remain in the preamble but are benign context the LLM ignores without protocol instructions.

---

### Phase 3: Unit Tests + Integration Tests

**Goal**: Add comprehensive test coverage for classification, preamble enhancement, and prompt content.

**Tasks**:

3.1. **Create `classify-file-type.test.ts`** — Test `classifyFileType()` exhaustively: all MIME types from UT-3, UT-4, UT-8, UT-12. Include edge cases: `application/octet-stream` → `'unknown'`, `text/html` → `'code'`, `image/svg+xml` → `'image'`. Verify function is importable (UT-8).

3.2. **Create `build-file-preamble-phase.test.ts`** — Test `buildFilePreamble()` with:

- Phase parameter producing instruction block (UT-5, UT-6, UT-7)
- Category annotation in headers (INT-1)
- Phase-specific keywords per FR (INT-2: INTERVIEW mentions `update_specification`, BLUEPRINT mentions topology, BUILD mentions ABL, IN_PROJECT mentions contextual)
- No instruction block without phase (INT-3)
- Evicted files excluded from instruction block (INT-4)
- Cross-phase file persistence (INT-5)
- Backward compat: `'unknown'` category uses extension label (UT-10, UT-11)
- Include `makeFile()` helper (copy pattern from B03 tests)

  3.3. **Create `prompt-file-protocol.test.ts`** — Test prompt content assertions:

- `BASE_PROMPT` contains File Processing Protocol (UT-1)
- Each phase prompt contains file-assisted section (UT-2)
- `BASE_PROMPT` contains conflict resolution instruction (UT-9)

  3.4. **Run full test suite** — `pnpm build --filter=@agent-platform/arch-ai && pnpm test --filter=@agent-platform/arch-ai`. Verify all new tests pass + all existing tests pass.

**Files Touched**:

- `packages/arch-ai/src/__tests__/classify-file-type.test.ts` — NEW (~60 lines)
- `packages/arch-ai/src/__tests__/build-file-preamble-phase.test.ts` — NEW (~200 lines)
- `packages/arch-ai/src/__tests__/prompt-file-protocol.test.ts` — NEW (~80 lines)

**Exit Criteria**:

- [ ] All UT-1 through UT-12 tests pass
- [ ] All INT-1 through INT-5 tests pass
- [ ] All 13 existing B03 tests still pass (no regressions)
- [ ] `pnpm build --filter=@agent-platform/arch-ai` succeeds
- [ ] Test count: ~29 new tests + 13 existing = ~42 total in arch-ai

**Test Strategy**: This IS the test phase — all unit and integration scenarios from test spec implemented here.

**E2E tests (deferred)**: The test spec defines 7 E2E scenarios (E2E-1 through E2E-7) requiring MongoMemoryServer + mock LLM server infrastructure. These are deferred to a separate task after ALPHA validation because: (1) E2E infrastructure setup is a significant effort independent of this feature's code, (2) the unit + integration tests cover all code paths deterministically, (3) the mock LLM server pattern from `arch-ai-multimodality.e2e.test.ts` can be reused but requires its own session. E2E scenarios will be tracked via the test spec coverage matrix and implemented before BETA promotion.

**Rollback**: Delete the 3 test files. No impact on production code.

---

## 4. Wiring Checklist

- [ ] `classifyFileType` exported from `file-store-service.ts` (was module-private)
- [ ] `classifyFileType` importable in `content-block-resolver.ts` via direct import `'../session/file-store-service.js'` (internal function, not re-exported through barrel — barrel export optional)
- [ ] `FilePreambleOptions` exported from `content-block-resolver.ts`
- [ ] `FilePreambleOptions` re-exported from `packages/arch-ai/src/executor/index.ts` (confirmed: `ContextCapabilities` is already re-exported at L20)
- [ ] Route ONBOARDING path passes `phase: session.metadata.phase` to `buildFilePreamble`
- [ ] Route IN_PROJECT path passes `phase: 'IN_PROJECT'` to `buildFilePreamble`
- [ ] `PHASE_INSTRUCTIONS` map handles `'INTERVIEW'`, `'BLUEPRINT'`, `'BUILD'`, `'IN_PROJECT'`
- [ ] `PHASE_INSTRUCTIONS` map gracefully skips `'CREATE'` and `'ONBOARDING'` (no entry = no block)
- [ ] File Processing Protocol in `BASE_PROMPT` is conditional ("When files are attached...")

---

## 5. Cross-Phase Concerns

### Database Migrations

None. No schema changes.

### Feature Flags

None. Changes are purely behavioral (prompt text + classification hints). Rollback via git revert.

### Configuration Changes

None. No new environment variables, runtime config, or feature flags.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 3 implementation phases complete with exit criteria met
- [ ] All 12 unit tests pass (UT-1 through UT-12)
- [ ] All 5 integration tests pass (INT-1 through INT-5)
- [ ] All 13 existing B03 tests pass (no regressions)
- [ ] `pnpm build --filter=@agent-platform/arch-ai` succeeds
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds
- [ ] Manual validation: upload OpenAPI spec at Interview start → LLM acknowledges and extracts
- [ ] Manual validation: upload file mid-conversation → conversation flow not broken
- [ ] Feature spec updated with implementation file paths (post-impl-sync)
- [ ] Testing matrix updated with actual coverage

---

## 7. Open Questions

1. ~~Should `PHASE_INSTRUCTIONS` map values be static strings or functions?~~ **RESOLVED**: Functions taking `categories: Set<string>` — instruction text must vary by which file categories are present (see D-2, Task 1.3, Task 1.5).
2. Should the `[File Processing]` block use a different wrapper than `[...]` to avoid confusion with `[Session Files]`? Alternatives: `--- File Processing ---`, `## File Processing`, `<file-processing>`.
3. ~~How should the instruction block handle BUILD → CREATE transition?~~ **RESOLVED by design**: CREATE has no `PHASE_INSTRUCTIONS` entry, so the instruction block naturally disappears when phase transitions. This is correct — CREATE is coordinator-driven, files are already processed.
