# Feature Spec Audit: SDK Rich Content Templates (Round 2 of 2)

**Phase**: FEATURE-SPEC
**Artifact**: `docs/features/sub-features/sdk-rich-content-templates.md`
**Reviewer**: LLD Reviewer Agent (architecture review)
**Date**: 2026-03-24
**Round**: 2 of 2
**Verdict**: **APPROVED** (with 3 medium findings to address during HLD/LLD)

---

## Round 1 Remediation Status

All 8 required changes from Round 1 have been addressed:

| R1 Issue                            | Status | Verification                                                                                         |
| ----------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| C1 (React component path)           | FIXED  | Line 216 now marks `RichContent.tsx` as **NEW** and distinguishes it from existing `RichMessage.tsx` |
| C2/C3 (New vs existing files)       | FIXED  | Line 192 adds explanation; all tables use **NEW** / MODIFY markers                                   |
| C4 (interpolateRichContent task)    | FIXED  | Delivery task 2.2 (line 324) explicitly covers updating `interpolateRichContent`                     |
| H1 (display\_\* meta-tools)         | FIXED  | Moved to Non-Goals (lines 59-60) with clear justification                                            |
| H2 (DSL syntax blocks)              | FIXED  | Moved to Non-Goals (line 61); FR-10 repurposed to `RichContentIR` schema extension                   |
| H3 (Top-level indexes)              | FIXED  | Entry present in `docs/features/README.md` line 135 and `docs/testing/README.md` line 111            |
| H4 (RichContentIR delivery task)    | FIXED  | Delivery task 2.1 (line 323)                                                                         |
| M1 (Hooks violations clarification) | FIXED  | Lines 136, 335 clarify violations are on feature branch                                              |

Additionally resolved from R1:

- M3 (Success metrics): Line 374 adds a behavioral metric ("Template render errors (prod): 0 after 1 week")
- M5 (isSafeUrl placement): Open Question 1 (line 380) now resolved

---

## Cross-Phase Consistency Audit

### 1. FR-to-Delivery Plan Coverage (PASS)

Every FR now has one or more delivery tasks:

| FR                                | Delivery Task(s)                       | Status  |
| --------------------------------- | -------------------------------------- | ------- |
| FR-1 (Registry 50-cap)            | 1.1 (cherry-pick), 6.7 (overflow test) | Covered |
| FR-2 (TemplateRenderer interface) | 1.1                                    | Covered |
| FR-3 (Registry match ordering)    | 1.1                                    | Covered |
| FR-4 (RichContent 12 fields)      | 1.2, 1.3                               | Covered |
| FR-5 (isSafeUrl validation)       | 3.1-3.6                                | Covered |
| FR-6 (Chart lazy-load)            | 1.3, 6.1                               | Covered |
| FR-7 (Form submit)                | 1.3                                    | Covered |
| FR-8 (Studio catalog)             | 1.4                                    | Covered |
| FR-9 (/template slash command)    | 1.4                                    | Covered |
| FR-10 (RichContentIR extension)   | 2.1                                    | Covered |
| FR-11 (interpolateRichContent)    | 2.2                                    | Covered |
| FR-12 (i18n)                      | 5.1-5.4                                | Covered |
| FR-13 (React hooks)               | 4.1-4.3                                | Covered |

### 2. User Story-to-FR Coverage (PASS)

| User Story                                     | Covering FRs                        | Status  |
| ---------------------------------------------- | ----------------------------------- | ------- |
| US-1 (End user sees structured data)           | FR-1, FR-2, FR-3, FR-4, FR-6, FR-13 | Covered |
| US-2 (End user clicks quick replies)           | FR-4, FR-7                          | Covered |
| US-3 (End user views media)                    | FR-4, FR-5                          | Covered |
| US-4 (Developer browses catalog)               | FR-8                                | Covered |
| US-5 (Developer inserts via /template)         | FR-9                                | Covered |
| US-6 (SDK maintainer wants pluggable registry) | FR-1, FR-2, FR-3                    | Covered |

The previous US-6/US-7 (meta-tools) was correctly removed along with moving `display_*` to Non-Goals. Story count reduced from 7 to 6 -- appropriate and consistent.

### 3. Testing Guide-to-FR Alignment (FINDING: M1 below)

The testing guide's coverage matrix has a stale FR-10 description that does not match the current feature spec. See M1 below.

### 4. Non-Goal Boundaries (PASS)

All 7 non-goals are clearly justified and correctly scoped:

| Non-Goal                           | Boundary Clear? | Notes                                                |
| ---------------------------------- | --------------- | ---------------------------------------------------- |
| Channel adapters (Slack, WhatsApp) | YES             | GAP-001 provides traceability                        |
| Receipt/Invoice Card               | YES             | Deprioritized from initial release                   |
| Customer template registration API | YES             | `register()` exists but docs deferred                |
| Template analytics                 | YES             | Clean scope cut                                      |
| `display_audio` meta-tool          | YES             | Audio is client-side only                            |
| `display_*` meta-tool interception | YES             | Requires runtime pipeline changes; R1 H1 remediation |
| DSL syntax blocks                  | YES             | Requires parser/compiler changes; R1 H2 remediation  |

### 5. Ungrounded Claims (FINDING: M2, M3 below)

---

## Findings

### M1. Testing guide FR-10 description is stale

**Severity**: MEDIUM
**Section**: Testing guide coverage matrix, line 29
**Finding**: The testing guide (at `docs/testing/sub-features/sdk-rich-content-templates.md`) coverage matrix row for FR-10 reads: "DSL compiler template blocks". In the feature spec, FR-10 was repurposed during R1 remediation to: "The `RichContentIR` schema in `packages/compiler/src/platform/ir/schema.ts` must be extended with 12 new fields mirroring the SDK `RichContent` type." The testing guide was not updated to match.
**Impact**: Downstream HLD/LLD will generate test tasks against the wrong FR-10 description.
**Fix**: Update the testing guide FR-10 row to: "RichContentIR schema extension (12 new fields)" and change its coverage status from `N` to `P` (since the schema types will be validated by the existing type shape tests).

### M2. Testing guide integration scenario 2 references deferred DSL blocks

**Severity**: MEDIUM
**Section**: Testing guide, Integration Test Scenarios, item 2
**Finding**: Integration test scenario 2 reads: "Compile a DSL file with `KPI:` and `TABLE:` blocks, verify the IR contains `rich_content.kpi` and `rich_content.table`..." DSL syntax blocks (`KPI:`, `TABLE:`) were explicitly deferred to Non-Goals in the feature spec (line 61). This integration test scenario is untestable within the current scope.
**Impact**: If carried forward to HLD/LLD, this scenario will be assigned as a delivery task that cannot be implemented, wasting effort.
**Fix**: Replace integration scenario 2 with a test that verifies the `RichContentIR` pass-through works when fields are populated programmatically (e.g., via runtime), not via DSL compilation. For example: "Create a `RichContentIR` object with `kpi` and `table` fields, pass through `interpolateRichContent`, verify fields are present in output."

### M3. Delivery task 5.3 references non-existent `StringsProvider` pattern

**Severity**: MEDIUM
**Section**: 13 (Delivery Plan), task 5.3
**Finding**: Task 5.3 states "Make web-sdk renderer strings configurable via `StringsProvider`". No `StringsProvider` abstraction exists anywhere in `packages/web-sdk/`. The web-sdk has no i18n or string provider infrastructure today. This delivery task references a pattern that needs to be created from scratch, but presents it as if wiring into an existing system.
**Impact**: During HLD/LLD, this task may be underestimated. The implementer needs to design a `StringsProvider` (context-based string injection), not just "wire" it.
**Fix**: Rephrase task 5.3 to: "Design and implement a `StringsProvider` context in web-sdk for configurable user-visible strings in template renderers (no external i18n dependency)." The HLD should specify the `StringsProvider` interface design.

---

## Verified

- [x] **All R1 findings addressed** -- all 8 required changes verified against the updated spec and indexes
- [x] **FR-to-Delivery Plan coverage** -- all 13 FRs have mapped delivery tasks
- [x] **User Story-to-FR coverage** -- all 6 user stories have mapped FRs
- [x] **Non-goal boundaries clear and justified** -- 7 non-goals with rationale, meta-tools and DSL blocks cleanly deferred
- [x] **Template compliance** -- all 18 TEMPLATE.md sections present and substantive
- [x] **Top-level indexes updated** -- `docs/features/README.md`, `docs/testing/README.md`, sub-feature indexes all have entries
- [x] **File path accuracy** -- existing files verified against codebase (`types.ts`, `rich-renderer.ts`, `value-resolution.ts`, `schema.ts`); new files clearly marked
- [x] **No CRITICAL or HIGH issues remain** -- R1 CRITICAL/HIGH findings all resolved
- [x] **Status appropriate** -- ALPHA for unimplemented feature with identified gaps is correct per AUTHORING_GUIDE.md
- [x] **Success metrics include behavioral target** -- "Template render errors (prod): 0 after 1 week" added
- [x] **Gaps/Known Issues aligned with non-goals** -- GAP-001 (channel adapters) traces to non-goal; GAP-002 traces to non-goal

---

## Structural Quality Notes (for HLD/LLD awareness)

1. **New `components/` subdirectory**: The planned `packages/web-sdk/src/react/components/RichContent.tsx` introduces a `components/` subdirectory under `react/`. The existing React files (`RichMessage.tsx`, `AgentProvider.tsx`, `index.ts`) are flat in `packages/web-sdk/src/react/`. The HLD should decide whether to restructure existing files into the new `components/` subdirectory for consistency, or keep the new file at the flat level.

2. **`isSafeUrl` export scope**: Open Question 1 was resolved (export from `rich-renderer.ts`), but during HLD, consider whether moving `isSafeUrl` to a dedicated utility file (e.g., `packages/web-sdk/src/utils/url-safety.ts`) would be cleaner than exporting from the renderer file, since 6+ template renderers will import it.

3. **`interpolateRichContent` refactoring opportunity**: Delivery task 2.2 adds 12 new field pass-throughs to a function that currently enumerates fields explicitly (7 today, becoming 19). The HLD should consider whether to refactor to an iterative approach (`Object.entries(rc).reduce(...)`) to prevent future field-addition bugs, or keep the explicit enumeration for clarity.

4. **Carousel and actions already use `richContent.*` and `actions.*` on the wire**: The 12 new fields (like `quick_replies`, `form`) partially overlap in intent with the existing `ActionSet` system (buttons, selects, inputs). The HLD should clarify whether `quick_replies` buttons are distinct from `ActionSet` buttons, and how form inputs relate to existing `ActionElement` inputs.

---

## Readiness Assessment

The spec is ready for HLD/LLD generation. The 3 medium findings are all fixable during HLD planning and do not block the design phase. Specifically:

- **M1 and M2** are testing guide sync issues that should be fixed before the test spec is finalized but do not affect the feature spec itself.
- **M3** is an estimation/scoping clarification that the HLD will naturally address when designing the i18n approach for web-sdk.

---

**VERDICT: APPROVED**

The feature spec is well-structured, cross-phase consistent (with minor testing guide drift), has clear non-goal boundaries, and all R1 remediation items verified. Recommended to proceed to HLD generation with attention to the 3 medium findings and the 4 structural notes above.
