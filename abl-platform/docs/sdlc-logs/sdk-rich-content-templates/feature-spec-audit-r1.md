# Feature Spec Audit: SDK Rich Content Templates (Round 1 of 2)

**Phase**: FEATURE-SPEC
**Artifact**: `docs/features/sub-features/sdk-rich-content-templates.md`
**Reviewer**: LLD Reviewer Agent (architecture review)
**Date**: 2026-03-24
**Verdict**: **NEEDS_REVISION**

---

## Audit Summary

The feature spec is well-structured, covers all 18 TEMPLATE.md sections, and demonstrates strong domain understanding. However, there are several issues with code evidence accuracy, index registration, and a gap in how runtime value resolution will handle 12 new fields. The spec also incorrectly names several file paths that do not exist on the current branch.

---

## CRITICAL Issues

### C1. Incorrect React component file path

**Severity**: CRITICAL
**Section**: 10 (Key Implementation Files), 13 (Delivery Plan task 3.1-3.3)
**Finding**: The spec references `packages/web-sdk/src/react/components/RichContent.tsx` throughout. This file does not exist. The actual React component is at `packages/web-sdk/src/react/RichMessage.tsx` and is named `RichMessage`, not `RichContent`.
**Impact**: Delivery plan tasks 3.1-3.3 describe fixing hooks violations in a file that does not exist at the stated path. Implementers will not find the file.
**Fix**: Replace all references to `packages/web-sdk/src/react/components/RichContent.tsx` with `packages/web-sdk/src/react/RichMessage.tsx`. Verify whether the hooks violations described (try/catch `useChat()`, conditional hooks) apply to the _current_ `RichMessage.tsx` or to code that exists only on the feature branch. If the latter, state that explicitly.

### C2. `templates/` directory does not exist on develop

**Severity**: CRITICAL
**Section**: 10 (Key Implementation Files)
**Finding**: The following paths are listed as implementation files but none exist on the current `develop` branch:

- `packages/web-sdk/src/templates/registry.ts`
- `packages/web-sdk/src/templates/types.ts`
- `packages/web-sdk/src/templates/index.ts`
- `packages/web-sdk/src/templates/renderers/*.ts`

No `packages/web-sdk/src/templates/` directory exists at all.
**Impact**: These are new files to be created. The spec should explicitly mark them as **new files** (not existing files) to avoid confusion during implementation.
**Fix**: Add a note in section 10 that these files are new (created during implementation). Alternatively, add a "New vs Existing" column to the implementation files tables.

### C3. Studio template components do not exist

**Severity**: CRITICAL
**Section**: 10 (Key Implementation Files)
**Finding**: None of these files exist on `develop`:

- `apps/studio/src/components/templates/TemplateCatalogPage.tsx`
- `apps/studio/src/components/templates/TemplateInsertPanel.tsx`
- `apps/studio/src/components/templates/TemplateJsonEditor.tsx`
- `apps/studio/src/components/templates/TemplateDSLView.tsx`
- `apps/studio/src/components/templates/TemplatePreview.tsx`
- `apps/studio/src/components/templates/TemplateMockProvider.tsx`
- `apps/studio/src/data/template-catalog.ts`

**Impact**: Same as C2 -- these are all new files. The spec should distinguish new files from existing files.
**Fix**: Mark all Studio template files as new. Given this is a cherry-pick delivery plan, clarify that these files come from the feature branch.

### C4. `interpolateRichContent` must be updated for 12 new fields

**Severity**: CRITICAL
**Section**: FR-11, section 7 (Technical Considerations)
**Finding**: FR-11 states "Runtime value resolution must pass through all new richContent fields from the compiled IR to the wire format without transformation." The actual `interpolateRichContent` function at `apps/runtime/src/services/execution/value-resolution.ts:110-123` explicitly enumerates only the existing 7 fields (markdown, adaptive_card, html, slack, ag_ui, whatsapp, carousel). Adding 12 new fields to `RichContentIR` without updating this function means template interpolation will silently drop all new fields.
**Impact**: At runtime, DSL-authored templates with `{{variable}}` placeholders in new rich content fields (kpi, table, chart, etc.) will not be interpolated. The fields will be silently omitted from the output.
**Fix**: Add a delivery task to update `interpolateRichContent` in `value-resolution.ts` to handle the 12 new fields. Alternatively, refactor the function to use a generic approach (iterate over all `RichContentIR` keys) rather than enumerating fields. This is a backend change that must be called out in the delivery plan.

---

## HIGH Issues

### H1. `display_*` meta-tool interception does not exist in runtime

**Severity**: HIGH
**Section**: 8 (How to Consume), User Story 6
**Finding**: The spec states "Runtime meta-tool interception: when an agent calls a tool with `display_*` prefix (e.g., `display_kpi`), runtime maps the tool output to the corresponding `richContent` field." A search of the entire `apps/runtime/src/` directory finds zero references to `display_kpi`, `display_table`, or any `display_*` meta-tool pattern. This mechanism does not exist today.
**Impact**: User Story 6 ("I want my agents to call `display_kpi()` or `display_table()` meta-tools") has no implementation path described in the delivery plan. The delivery plan focuses on cherry-picking and fixing existing code, not building new runtime interception.
**Fix**: Either (a) add a delivery task for implementing `display_*` meta-tool interception in the runtime execution pipeline, or (b) move this capability to Non-Goals/Out of Scope with a note that it is deferred.

### H2. DSL template blocks do not exist in parser

**Severity**: HIGH
**Section**: FR-10, section 11 (Configuration - DSL)
**Finding**: The spec describes new DSL syntax blocks (`QUICK_REPLIES:`, `KPI:`, `TABLE:`, `IMAGE:`, etc.) and references `packages/core/src/parser/agent-based-parser.ts` as the implementation file. The parser's section validator (line 456) lists all known sections and does not include any template block names. The compiler at `packages/compiler/src/platform/ir/compiler.ts` also has no reference to these blocks.
**Impact**: FR-10 is unimplemented and the delivery plan has no task to add parser/compiler support for these DSL blocks.
**Fix**: Either (a) add delivery tasks for parser recognition of template blocks and compiler emission of `rich_content.*` IR fields, or (b) defer DSL template blocks to a future phase and remove FR-10 / the DSL Configuration section.

### H3. Feature not registered in top-level indexes

**Severity**: HIGH
**Section**: Authoring Guide compliance
**Finding**: Per the Authoring Guide section 4, new sub-features must be added to:

1. `docs/features/README.md` (Focused Sub-Feature Modules table) -- **MISSING**
2. `docs/testing/README.md` -- **MISSING**
3. `docs/features/sub-features/README.md` -- Present
4. `docs/testing/sub-features/README.md` -- Present

**Fix**: Add entries to `docs/features/README.md` and `docs/testing/README.md` for this sub-feature.

### H4. `RichContentIR` schema needs 12 new fields

**Severity**: HIGH
**Section**: FR-4, section 10 (Key Implementation Files)
**Finding**: The current `RichContentIR` at `packages/compiler/src/platform/ir/schema.ts:34-42` has only 7 fields (markdown, adaptive_card, html, slack, ag_ui, whatsapp, carousel). FR-4 requires extending `RichContent` with 12 new fields, but the delivery plan has no explicit task to update `RichContentIR` in the compiler IR schema. The IR schema must mirror the SDK types.
**Fix**: Add a delivery task to extend `RichContentIR` in `packages/compiler/src/platform/ir/schema.ts` with the 12 new field types, or confirm this comes from the cherry-picked feature branch commits.

---

## MEDIUM Issues

### M1. `useChat()` hooks violation claim is ungrounded on develop

**Severity**: MEDIUM
**Section**: 13 (Delivery Plan, task 3.1)
**Finding**: Task 3.1 states "Fix `RichContent.tsx` -- replace try/catch `useChat()` with direct `useContext()`." The actual `RichMessage.tsx` on `develop` does NOT use `useChat()` at all -- it receives `chat` as a prop. The hooks violation may exist on the feature branch, but the spec does not clarify this.
**Fix**: Clarify that the hooks violations exist on the feature branch code (to be cherry-picked), not on the current `develop` branch. Reference the feature branch file path if different.

### M2. No integration or E2E test scenarios in delivery plan

**Severity**: MEDIUM
**Section**: 13 (Delivery Plan), 17 (Testing)
**Finding**: The delivery plan task 6 ("Verify and test") only mentions running existing tests, build, and prettier. The testing section lists 17 unit test files but all are "NOT TESTED" status. The testing guide lists E2E and integration scenarios, but the delivery plan has no task to write them.
**Impact**: All 17 tests are claimed to exist on the feature branch but none are verified on develop. There is no explicit task to write the missing coverage identified in the testing guide (isSafeUrl integration, MAX_RENDERERS overflow, chart import failure).
**Fix**: Add delivery tasks for writing the missing test scenarios identified in the testing notes (section 17 bottom).

### M3. Success metrics lack runtime/behavioral targets

**Severity**: MEDIUM
**Section**: 14 (Success Metrics)
**Finding**: All 6 metrics are static/structural (file counts, bundle size, dependency count). None measure runtime behavior such as: template render latency, user interaction rate with new templates, or error rate in template rendering.
**Fix**: Add at least one behavioral metric, e.g., "Template render errors in production: 0 after 1 week" or "Template render time P99 < 50ms."

### M4. Spec claims "no new trace events" but should consider observability

**Severity**: MEDIUM
**Section**: 12 (Non-Functional Concerns - Observability)
**Finding**: The spec states "No new trace events or metrics" and defers observability to future template analytics. However, template rendering errors (chart lazy-load failure, malformed data) are silent client-side failures with no visibility. At minimum, the SDK should emit error events when template rendering fails.
**Fix**: Consider adding a `templateRenderError` event to the SDK event system, or document why client-side errors are acceptable without observability.

### M5. Open Question 1 about `isSafeUrl` placement should be resolved

**Severity**: MEDIUM
**Section**: 15 (Open Questions)
**Finding**: Open Question 1 asks whether `isSafeUrl` should be in a shared package or stay in web-sdk. Since the delivery plan already includes using it in both web-sdk renderers and potentially Studio, and the function is currently a private function (not even exported), this question is load-bearing for implementation.
**Fix**: Resolve this before implementation. Recommendation: export from web-sdk since Studio components in the catalog import web-sdk directly (per Design Considerations). No shared package needed.

---

## Template Compliance Checklist

| #   | TEMPLATE.md Section                         | Present | Notes                                                                                                        |
| --- | ------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Introduction / Overview                     | Yes     | Problem statement, goal, summary all present                                                                 |
| 2   | Scope (Goals + Non-Goals)                   | Yes     | 11 goals, 6 non-goals                                                                                        |
| 3   | User Stories                                | Yes     | 7 stories (exceeds minimum of 3)                                                                             |
| 4   | Functional Requirements                     | Yes     | 13 FRs (exceeds minimum of 4)                                                                                |
| 5   | Feature Classification & Integration Matrix | Yes     | 4 related features (exceeds minimum of 2)                                                                    |
| 6   | Design Considerations                       | Yes     | 5 considerations                                                                                             |
| 7   | Technical Considerations                    | Yes     | 4 considerations                                                                                             |
| 8   | How to Consume                              | Yes     | Studio UI, Runtime, Studio API, Admin, Channel/SDK sections                                                  |
| 9   | Data Model                                  | Yes     | N/A with justification (no new collections)                                                                  |
| 10  | Key Implementation Files                    | Partial | Files listed but many do not exist (see C2, C3); no new vs existing distinction                              |
| 11  | Configuration                               | Yes     | N/A for env vars; DSL section present but unimplemented (see H2)                                             |
| 12  | Non-Functional Concerns                     | Partial | Isolation is N/A with justification; security, performance, reliability present; observability weak (see M4) |
| 13  | Delivery Plan                               | Partial | Parent tasks with subtasks present; missing runtime tasks (see C4, H1, H2)                                   |
| 14  | Success Metrics                             | Partial | 6 metrics but all structural (see M3)                                                                        |
| 15  | Open Questions                              | Yes     | 3 questions (exceeds minimum of 1)                                                                           |
| 16  | Gaps, Known Issues                          | Yes     | 6 gaps with severity and status                                                                              |
| 17  | Testing & Validation                        | Yes     | 17 scenarios, testing notes, linked testing guide                                                            |
| 18  | References                                  | Yes     | Design specs, parent feature, related feature                                                                |

---

## Authoring Guide Compliance

| Check                          | Status  | Notes                                                                          |
| ------------------------------ | ------- | ------------------------------------------------------------------------------ |
| Correct doc type and placement | PASS    | SUB-FEATURE in `sub-features/`                                                 |
| Grounded in code evidence      | FAIL    | Multiple file paths reference non-existent files without marking them as new   |
| Unknowns marked explicitly     | PASS    | Open Questions and Gaps sections well-populated                                |
| Matching testing guide exists  | PASS    | `docs/testing/sub-features/sdk-rich-content-templates.md` exists               |
| Discovery indexes updated      | PARTIAL | Sub-feature indexes updated; top-level README.md and testing/README.md missing |
| Requirements testable          | PASS    | FRs are concrete and measurable                                                |

---

## Cross-Phase Consistency

| Check                               | Status  | Notes                                                                      |
| ----------------------------------- | ------- | -------------------------------------------------------------------------- |
| All FRs have delivery plan coverage | FAIL    | FR-10 (DSL blocks), FR-11 (value resolution) have no delivery tasks        |
| All user stories have FR coverage   | FAIL    | US-6 (meta-tools) has no delivery task or FR for runtime implementation    |
| Testing covers all FRs              | PARTIAL | FR-5, FR-10, FR-11, FR-12, FR-13 marked "N" (not covered) in testing guide |
| Gaps align with non-goals           | PASS    | GAP-001 (channel adapters) matches non-goal                                |
| Status consistent with content      | PASS    | ALPHA status appropriate for unimplemented feature                         |

---

## Required Changes Before Round 2

1. **[C1]** Fix React component file path from `RichContent.tsx` to `RichMessage.tsx`
2. **[C2, C3]** Distinguish new files from existing files in section 10 tables
3. **[C4]** Add delivery task to update `interpolateRichContent` in `value-resolution.ts`
4. **[H1]** Either add delivery task for `display_*` meta-tool interception or move to non-goals
5. **[H2]** Either add delivery tasks for DSL parser/compiler template blocks or defer FR-10
6. **[H3]** Add entries to `docs/features/README.md` and `docs/testing/README.md`
7. **[H4]** Add delivery task for extending `RichContentIR` in compiler IR schema
8. **[M1]** Clarify that hooks violations are on the feature branch, not develop

---

## Verified

- [x] All 18 TEMPLATE.md sections addressed
- [x] 7 user stories (minimum 3 met)
- [x] 13 functional requirements (minimum 4 met)
- [x] 4 related features in integration matrix (minimum 2 met)
- [x] Non-functional concerns address tenant/project/user isolation (N/A with justification)
- [x] Delivery plan has parent tasks with numbered subtasks
- [x] Open questions section has 3 items (minimum 1 met)
- [x] Testing guide exists and is cross-linked
- [x] Sub-feature indexes updated
- [ ] Top-level indexes updated (MISSING)
- [ ] All file paths verified against codebase (FAILED -- 9+ non-existent paths)
- [ ] Cross-phase consistency (FAILED -- delivery plan gaps for FR-10, FR-11, US-6)
