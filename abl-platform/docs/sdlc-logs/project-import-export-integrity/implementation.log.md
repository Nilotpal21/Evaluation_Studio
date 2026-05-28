# SDLC Log: Project Import/Export Integrity — Implementation

**Feature**: `project-import-export-integrity`
**Parent Feature**: `project-import-export`
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-03-27-project-import-export-integrity-plan.md`
**Date Started**: 2026-03-27
**Date Completed**: IN PROGRESS

---

## Preflight

- [x] Existing feature spec located: `docs/features/project-import-export.md`
- [x] Existing test spec located: `docs/testing/project-import-export.md`
- [x] Existing HLD located: `docs/specs/project-import-export.hld.md`
- [x] Focused supporting design located: `docs/superpowers/specs/2026-03-27-import-preview-diagnostics-design.md`
- [x] Current branch checked with `git status`
- [x] Recent commits checked with `git log --oneline -5`
- [x] Dirty tree detected; unrelated untracked files will be left untouched

## Scope

- End-to-end integrity fixes spanning `packages/project-io` and Studio import/export surfaces
- In-scope for this implementation slice:
  - truthful preview/apply warnings
  - legacy tool-file normalization
  - canonical standalone tool export
  - entry-agent alias resolution on apply
  - honest best-effort agent export fallback
- Out of scope for this slice:
  - full recovery-artifact export/import
  - explicit agent rename transaction
  - post-implementation doc sync across all parent SDLC artifacts

## Notes

- The current V2 export path has no serializer hook, so honest `.agent.yaml` output requires wiring compile/serialize support through `exportProjectV2`.
- The current preview/apply contract still overloads `valid` and hides tool parse failures; this is the primary user-facing gap for Phase 1.

## Implemented

- Added shared import issue metadata in `packages/project-io`:
  - blocking vs non-blocking issue classification
  - entry-agent resolution metadata
  - preview acknowledgement flags/counts
- Added imported agent identity resolution so preview/apply now reconcile:
  - manifest key
  - file path stem
  - declared DSL/YAML header name
  - resolved `entryAgentName`
- Made tool import tolerant of legacy standalone tool DSL:
  - legacy one-tool `.tools.abl` files are normalized to canonical `TOOLS:` format for parsing
  - preview surfaces normalization and parse fidelity warnings
  - tool removals are suppressed when tool parsing is incomplete
- Made Studio preview truthful:
  - compiler diagnostics are now merged into preview issues for both `.agent.abl` and `.agent.yaml`
  - preview returns a `previewDigest` for explicit warn-and-proceed apply
- Made Studio apply consistent with preview:
  - blocking issues reject apply
  - non-blocking issues require `previewDigest + acknowledgedIssueIds`
  - apply writes the resolved imported entry agent, not the raw manifest alias
- Made V2 export honest and best-effort:
  - standalone tools are exported as canonical `TOOLS:` files
  - agents are materialized to strict YAML when parseable without parse errors
  - agents fall back to `.agent.abl` when strict YAML is unavailable
  - manifest agent/tool paths now come from actual emitted files
  - manifest `dsl_format` is summarized honestly as `yaml`, `legacy`, or `mixed`

## Verification

- `pnpm --filter=@agent-platform/project-io build`
- `pnpm --filter=@agent-platform/studio build`
- `pnpm --filter=@agent-platform/project-io test -- --run core-assembler tool-extractor project-importer-v2 manifest-v2 export-utils`
- `pnpm --filter=@agent-platform/studio exec vitest run --config vitest.node.config.ts src/__tests__/project-import-preview-contract.test.ts`
- Follow-up regression coverage added after audit:
  - direct unit tests for `tool-file-format`, `agent-identity-resolver`, and `agent-export-materializer`
  - additional preview digest, manifest honesty, and import dry-run regression tests

## Remaining Gaps

- Export recovery artifacts for truly un-serializable tool payloads are still out of scope in this slice; current behavior is best-effort canonicalization plus warnings.
- Explicit rename enforcement in Studio agent save/edit routes is still design-only and was not implemented in this patch.
