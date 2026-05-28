# Studio -> DB -> DSL -> Runtime Multidimensional Coverage Audit

Date: 2026-05-05

Scope: end-to-end contract propagation for authored runtime behavior across Studio visual editing, DSL/YAML authoring, compiler lowering, runtime execution, channel delivery, persistence, and readback/rehydration.

Canonical intent: this is the bounded coverage-model artifact for Studio -> DB -> DSL/YAML -> compiler -> runtime -> delivery/persistence/readback. The earlier expanded-matrix and propagation-audit docs remain useful evidence sources, but future findings should be registered here as concrete matrix cells.

This audit extends the earlier propagation and expanded-matrix documents into a more explicit coverage inventory. The point is not just to track fields and layers. The point is to track the combinations where bugs keep hiding:

- shortcut paths
- fallback/default paths
- hook/init/resume lanes
- structured payload variants of text paths
- visual-editor mutation behavior instead of only read/load behavior

Related artifacts:

- [2026-05-05-studio-db-dsl-runtime-expanded-contract-matrix.md](/Users/prasannaarikala/projects/f-2/abl-platform/docs/audit/2026-05-05-studio-db-dsl-runtime-expanded-contract-matrix.md)
- [2026-05-05-studio-db-dsl-runtime-propagation-audit.md](/Users/prasannaarikala/projects/f-2/abl-platform/docs/audits/2026-05-05-studio-db-dsl-runtime-propagation-audit.md)

## Why This Audit Exists

The first generation of audit matrices mostly tracked:

- fields
- layers
- happy-path propagation

That was not enough. The repeated “3-5 more findings” pattern came from missing dimensions, not from lack of effort. The coverage model now explicitly tracks:

1. Execution lane
2. Payload shape
3. Authoring surface
4. Mutation type
5. Runtime boundary
6. Control-flow mode

## Status Legend

| Status           | Meaning                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`           | The exact seam has been code-inspected and is covered by a deterministic regression, or by a nearby regression that clearly locks the same helper contract. |
| `FAIL`           | Confirmed defect in the current tree.                                                                                                                       |
| `PARTIAL`        | Some variants or lanes pass, but at least one sibling path is still lossy or unverified.                                                                    |
| `INSPECTED_ONLY` | The path looks correct from source inspection, but does not yet have a deterministic lock test.                                                             |
| `NOT_COVERED`    | The seam exists, but this audit has not yet proven it.                                                                                                      |
| `N/A`            | Contract intentionally does not apply to that seam.                                                                                                         |

## Coverage Model

The old audit shape was mostly:

- field
- layer
- happy path

This artifact uses a stricter model:

- rows = contract items or compact contract families
- columns = seam stages
- per-cell tags = lane, payload shape, authoring surface, mutation type, runtime boundary, control-flow mode
- per-cell proof = deterministic test, inspection-only, or not yet covered

That makes a finding like "structured payload disappears" specific enough to act on:

- contract: `rich_content` + `voice_config` + `actions`
- seam: `runtime executor`
- lane: `auto-advance`
- flow mode: `navigation shortcut`
- boundary: `stream to client` + `assistant history`
- status: `FAIL` or `PASS`

Instead of being hidden inside a broad bucket like "runtime execution."

## Dimensions

### Execution Lane

| ID   | Lane                    |
| ---- | ----------------------- |
| `L1` | init-time               |
| `L2` | normal turn             |
| `L3` | auto-advance            |
| `L4` | terminal step           |
| `L5` | retry/fallback          |
| `L6` | handoff/delegate return |
| `L7` | async resume            |
| `L8` | hook-triggered          |
| `L9` | background persistence  |

### Payload Shape

| ID   | Shape                                  |
| ---- | -------------------------------------- |
| `P1` | plain text                             |
| `P2` | rich content                           |
| `P3` | voice config                           |
| `P4` | actions                                |
| `P5` | metadata/content envelope              |
| `P6` | localized/template-derived             |
| `P7` | tokenized history vs redacted delivery |

### Authoring Surface

| ID   | Surface                             |
| ---- | ----------------------------------- |
| `A1` | Studio visual editor                |
| `A2` | Studio DSL editor                   |
| `A3` | YAML import / parse                 |
| `A4` | import/export / project-io          |
| `A5` | saved IR reload / read-only display |

### Mutation Type

| ID   | Mutation                   |
| ---- | -------------------------- |
| `M1` | create                     |
| `M2` | edit existing              |
| `M3` | partial edit               |
| `M4` | add/remove item            |
| `M5` | reorder / replace          |
| `M6` | no-op save                 |
| `M7` | toggle feature on/off      |
| `M8` | fallback/default injection |

### Runtime Boundary

| ID   | Boundary            |
| ---- | ------------------- |
| `B1` | stream to client    |
| `B2` | assistant history   |
| `B3` | DB persistence      |
| `B4` | trace emission      |
| `B5` | session rehydration |
| `B6` | read APIs           |
| `B7` | channel adaptation  |

### Control-Flow Mode

| ID    | Mode                    |
| ----- | ----------------------- |
| `F1`  | mainline                |
| `F2`  | branch match            |
| `F3`  | ELSE / fallback         |
| `F4`  | guardrail violation     |
| `F5`  | constraint violation    |
| `F6`  | tool error              |
| `F7`  | completion path         |
| `F8`  | navigation shortcut     |
| `F9`  | fail-open / fail-closed |
| `F10` | hook side effect        |

## Contract Items

These are the row families this audit tracks.

| ID     | Contract Item                 | Notes                                                     |
| ------ | ----------------------------- | --------------------------------------------------------- |
| `C-01` | `respond`                     | Plain authored message text                               |
| `C-02` | `rich_content`                | Structured rendered payload                               |
| `C-03` | `voice_config`                | Voice delivery payload                                    |
| `C-04` | `actions`                     | Interactive action payload                                |
| `C-05` | `store`                       | Completion/memory persistence directive                   |
| `C-06` | `default_handler`             | `ON_ERROR.DEFAULT` semantics and lowering                 |
| `C-07` | `call_spec.with/as`           | Tool invocation argument/result propagation               |
| `C-08` | `delegate/handoff/escalate`   | Cross-thread / cross-agent transitions                    |
| `C-09` | PII registry / policy context | Project-scoped recognizers, render policy, vault behavior |

## Seam Columns

This audit treats these as the primary seam columns:

| ID   | Seam                   |
| ---- | ---------------------- |
| `S1` | authoring surface      |
| `S2` | parser / import path   |
| `S3` | compiler lowering      |
| `S4` | runtime executor seam  |
| `S5` | channel delivery       |
| `S6` | persistence            |
| `S7` | readback / rehydration |

## Matrix Template

Use this shape for every new discovery or revalidation:

| Field                             | Meaning                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| `Cell ID`                         | Stable identifier for the matrix cell                                |
| `Contract`                        | One field or a tightly coupled field family                          |
| `Seam`                            | One of `S1`-`S7`                                                     |
| `Status`                          | `PASS`, `FAIL`, `PARTIAL`, `INSPECTED_ONLY`, `NOT_COVERED`, or `N/A` |
| `Verified by deterministic test?` | `Yes` or `No`                                                        |
| `Lane`                            | One or more of `L1`-`L9`                                             |
| `Payload`                         | One or more of `P1`-`P7`                                             |
| `Authoring`                       | One or more of `A1`-`A5`                                             |
| `Mutation`                        | One or more of `M1`-`M8`                                             |
| `Boundary`                        | One or more of `B1`-`B7`                                             |
| `Flow Mode`                       | One or more of `F1`-`F10`                                            |
| `Evidence / Note`                 | Exact code seam, test, or reason the status is assigned              |

Required rule: every new finding should land as a new matrix cell or an update to an existing cell before implementation starts.

## Coverage Inventory

Each row below is a concrete cell or compact cluster of closely related cells.

| Cell ID         | Contract                                                     | Seam                                                      | Status         | Verified by deterministic test? | Lane       | Payload          | Authoring | Mutation      | Boundary         | Flow Mode  | Evidence / Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------ | --------------------------------------------------------- | -------------- | ------------------------------- | ---------- | ---------------- | --------- | ------------- | ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SDR-MULTI-001` | `respond` + `rich_content` + `voice_config` + `actions`      | `S4` runtime executor                                     | `PASS`         | Yes                             | `L8`       | `P2/P3/P4`       | `A2`      | `M1/M2`       | `B1/B2`          | `F10`      | `before_agent`, `before_turn`, and `after_turn` hook-emitted structured payloads now propagate into returned execution results. Locked in [hooks-lifecycle.e2e.test.ts](/Users/prasannaarikala/projects/f-2/abl-platform/apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts) and implemented in [runtime-executor.ts](/Users/prasannaarikala/projects/f-2/abl-platform/apps/runtime/src/services/runtime-executor.ts) and [reasoning-executor.ts](/Users/prasannaarikala/projects/f-2/abl-platform/apps/runtime/src/services/execution/reasoning-executor.ts). |
| `SDR-MULTI-002` | `respond` + `rich_content` + `voice_config` + `actions`      | `S4` runtime executor                                     | `PASS`         | Yes                             | `L2/L3`    | `P2/P3/P4/P7`    | `A2`      | `M1/M2`       | `B1/B2`          | `F2`       | Standard `ON_INPUT` branch application path preserves structured payloads across auto-advance. Locked in [flow-authored-output-pii.test.ts](/Users/prasannaarikala/projects/f-2/abl-platform/apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts).                                                                                                                                                                                                                                                                                               |
| `SDR-MULTI-003` | `respond` + `rich_content` + `voice_config` + `actions`      | `S4` runtime executor                                     | `PASS`         | Yes                             | `L2/L3`    | `P2/P3/P4/P7`    | `A2`      | `M1/M2`       | `B1/B2`          | `F8`       | The navigation-command fast path in [flow-step-executor.ts](/Users/prasannaarikala/projects/f-2/abl-platform/apps/runtime/src/services/execution/flow-step-executor.ts) now reuses `applyOnInputBranchResult(...)` instead of text-only emission, so structured payloads survive this shortcut lane too. Locked by the navigation-specific regression in [flow-authored-output-pii.test.ts](/Users/prasannaarikala/projects/f-2/abl-platform/apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts).                                               |
| `SDR-MULTI-004` | `default_handler` + `rich_content`                           | `S3` compiler lowering                                    | `PASS`         | Yes                             | `L5`       | `P2/P6`          | `A2/A3`   | `M8`          | `B1/B2`          | `F3`       | `ON_ERROR.default_handler` now receives template-format lowering via `resolveFormats(...)` in [compiler.ts](/Users/prasannaarikala/projects/f-2/abl-platform/packages/compiler/src/platform/ir/compiler.ts). Verified by the targeted compiler test in [template-resolution.test.ts](/Users/prasannaarikala/projects/f-2/abl-platform/packages/compiler/src/__tests__/template-resolution.test.ts).                                                                                                                                                                |
| `SDR-MULTI-005` | `respond` + `rich_content` + `voice_config` + `actions`      | `S4` runtime executor                                     | `PASS`         | Yes                             | `L2/L3`    | `P2/P3/P4/P7`    | `A2/A3`   | `M1/M2`       | `B1/B2`          | `F2`       | `ON_RESULT`, `ON_SUCCESS`, and `ON_FAILURE` structured branch payload compilation/runtime wiring already has parity tests in compiler/runtime suites. This audit pass did not add a new test, but the prior regression family still covers the common authored-output seam.                                                                                                                                                                                                                                                                                        |
| `SDR-MULTI-006` | `default_handler`                                            | `S1` authoring surface                                    | `PASS`         | Yes                             | `L5`       | `P1`             | `A1`      | `M4/M8`       | `B1/B2`          | `F3`       | Studio now preserves `ON_ERROR.DEFAULT` shape instead of duplicating or dropping it. That slice shipped earlier in commit `553b082c5` and is locked by Studio/compiler tests.                                                                                                                                                                                                                                                                                                                                                                                      |
| `SDR-MULTI-007` | `rich_content` + `voice_config` + `actions`                  | `S1` authoring surface                                    | `PARTIAL_SAFE` | No                              | `L2/L3`    | `P2/P3/P4`       | `A1`      | `M2/M3/M4`    | `B1/B2`          | `F7`       | Completion visual editing is still not a fully expressive creation UI, but Slice 6 added mutation locks proving visible-field edits preserve hidden structured siblings, remove operations are intentional deletion, and serializer diffs retain structured-only payloads plus `store`.                                                                                                                                                                                                                                                                            |
| `SDR-MULTI-008` | `rich_content` + `voice_config` + `actions` + retry metadata | `S1` authoring surface                                    | `PARTIAL_SAFE` | No                              | `L5`       | `P2/P3/P4`       | `A1`      | `M2/M3/M4/M8` | `B1/B2`          | `F6/F3`    | Error-handling visual editing remains a subset UI, but Slice 6 added mutation locks proving visible-field edits preserve hidden structured, retry, and sibling metadata while remove operations intentionally delete only the selected handler.                                                                                                                                                                                                                                                                                                                    |
| `SDR-MULTI-009` | `store`                                                      | `S1` authoring surface                                    | `PARTIAL`      | No                              | `L4`       | `P5`             | `A1`      | `M2/M3`       | `B3/B6`          | `F7`       | Completion `store` is supported by the IR and runtime contract, but Studio visual authoring parity for it is still incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SDR-MULTI-010` | `call_spec.with/as`                                          | `S2/S3` parser + compiler                                 | `PASS`         | Yes                             | `L2`       | `P5`             | `A2/A3`   | `M1/M2`       | `B1/B2`          | `F2`       | Recent parser/compiler work preserved structured branch payloads and tool invocation metadata across `ON_INPUT`, `ON_RESULT`, hook, and lifecycle compilation paths. Existing parity tests cover this family.                                                                                                                                                                                                                                                                                                                                                      |
| `SDR-MULTI-011` | `delegate/handoff/escalate`                                  | `S4/S5/S6/S7` runtime + delivery + persistence + readback | `PARTIAL`      | Yes, in slices                  | `L6/L7`    | `P1/P2/P3/P4/P5` | `A2`      | `M1/M8`       | `B1/B2/B3/B6/B7` | `F7/F9`    | Many helper-owned transition seams have been hardened already, but this family remains broad and still deserves a dedicated helper inventory. Some thread-return and channel-dispatcher follow-up work remains in adjacent audits.                                                                                                                                                                                                                                                                                                                                 |
| `SDR-MULTI-012` | PII registry / policy context                                | `S4/S5/S6/S7` runtime + delivery + persistence + readback | `PARTIAL`      | Yes, in slices                  | `L1-L9`    | `P1-P7`          | `A1-A5`   | `M1-M8`       | `B1-B7`          | `F1-F10`   | Main runtime/chat/trace/persistence propagation is much stronger now, but some remaining non-mainline seams still need the same project-scoped recognizer policy proof. This item should continue to be tracked as a cross-cutting family, not as a single row to “finish once.”                                                                                                                                                                                                                                                                                   |
| `SDR-MULTI-013` | `respond` + `rich_content` + `voice_config` + `actions`      | `S5/S6/S7` delivery + persistence + readback              | `PASS`         | Yes                             | `L1/L9`    | `P2/P3/P4/P5/P7` | `A2`      | `M1/M2`       | `B3/B5/B6/B7`    | `F10/F8`   | Structured-only and text-plus-structured `ON_START` payloads now produce protected delivery plus tokenized conversation-history content envelopes. Locked in [flow-authored-output-pii.test.ts](/Users/prasannaarikala/projects/f-2/abl-platform/apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts); direct readback merge parity is covered by `SDR-MULTI-008` session readback tests.                                                                                                                                                        |
| `SDR-MULTI-014` | `respond` + `rich_content` + `voice_config` + `actions`      | `S5/S6/S7` delivery + persistence + readback              | `PASS`         | Yes                             | `L2/L3`    | `P2/P3/P4/P5/P7` | `A2`      | `M1/M2`       | `B3/B5/B6/B7`    | `F2/F8`    | Auto-advanced `ON_INPUT`, navigation shortcut, and `ON_RESULT` structured-only branches now append protected content envelopes to assistant history while preserving redacted runtime delivery. Locked in [flow-authored-output-pii.test.ts](/Users/prasannaarikala/projects/f-2/abl-platform/apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts).                                                                                                                                                                                              |
| `SDR-MULTI-015` | `respond` + `rich_content` + `voice_config` + `actions`      | `S4/S5/S6` runtime + delivery + persistence               | `PARTIAL`      | Yes                             | `L5/L6/L7` | `P2/P3/P4/P5`    | `A2`      | `M8`          | `B1/B3/B7`       | `F3/F6/F9` | Slice 11 locks `ON_ERROR DEFAULT THEN: CONTINUE`, ELSE fallback structured-only branches, and complete-transition child return envelopes in [flow-authored-output-pii.test.ts](/Users/prasannaarikala/projects/f-2/abl-platform/apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts). Remaining non-continue error-handler actions, constraint/fail-open/fail-closed fallbacks, and action-handler delegate/return variants stay as narrower follow-up seams.                                                                                    |

## Current Read On The Previously Reported Cells

This section translates the older findings into current audit status.

| Older Finding                                                      | Current Status | Notes                                                                                                             |
| ------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ON_INPUT` navigation fast path drops structured payloads          | `PASS`         | Fixed in the current tree and now locked by a navigation-specific runtime regression.                             |
| `before_agent` / `before_turn` hook structured responses discarded | `PASS`         | Fixed in commit `514e3775e`; covered by hook lifecycle E2E regressions.                                           |
| `ON_ERROR.default_handler` skips template-format lowering          | `PASS`         | Already fixed in the current tree; verified by compiler template-resolution regression.                           |
| Completion visual editor false parity                              | `PARTIAL`      | Needs narrower mutation-path proof; not currently treated as a live confirmed high-severity silent-loss bug.      |
| Error-handling visual editor false parity                          | `PARTIAL`      | Same as completion; still a product gap, but not yet re-proven as a broad silent-loss defect in the current tree. |

## Bounded Backlog

These are the highest-signal open cells after the latest revalidation:

| Priority | Cell ID         | Why it still matters                                                                                     |
| -------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `P1`     | `SDR-MULTI-015` | Remaining non-continue fallback/helper seams are historically where “new” runtime gaps keep reappearing. |
| `P2`     | `SDR-MULTI-007` | Completion visual editing still needs a mutation-path audit, not just read/load confirmation.            |
| `P2`     | `SDR-MULTI-008` | Error-handling visual editing needs the same mutation-focused proof.                                     |

## How To Use This Audit

Every future discovery should be recorded as a concrete cell in this inventory, not just as a prose finding.

Required fields for any new cell:

1. Contract item
2. Seam column
3. Lane
4. Payload shape
5. Authoring surface
6. Mutation type
7. Boundary
8. Control-flow mode
9. Status
10. Whether there is a deterministic lock test

That forces a more honest answer to “have we already audited this?” The answer becomes:

- yes, and it is `PASS`
- yes, but only `INSPECTED_ONLY`
- yes, but a sibling lane is still `PARTIAL`
- no, this cell is `NOT_COVERED`

## Recommended Next Audit Passes

Highest-yield next cells:

1. `SDR-MULTI-015`
   remaining non-continue fallback/helper seam inventory

2. `SDR-MULTI-007` + `SDR-MULTI-008`
   Studio mutation-focused audit for completion and error-handling visual editing

## Verification Notes

This artifact incorporates the latest targeted revalidation available in the current tree, including:

- hook structured-return runtime regressions
- navigation-command `ON_INPUT` structured payload runtime regression
- compiler `default_handler` template-resolution regression

Where a row is still `PARTIAL`, `INSPECTED_ONLY`, or `NOT_COVERED`, that status is intentional. It means the coverage model is now explicit about uncertainty instead of flattening it into “already reviewed.”
