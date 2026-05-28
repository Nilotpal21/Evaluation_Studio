# PII Vault Boundary Contract — LLD Log

**Phase**: 4 — Low-Level Design
**Ticket**: ABLP-535
**Artifact**: `docs/specs/pii-vault-boundary-contract.lld.md`
**Commit**: `416e1ac81`

## Summary

LLD created with 5 tasks, 19 subtasks, and 21 acceptance criteria. Each task specifies exact file paths, function signatures, and verification commands.

## Key Design Decisions

1. **`renderToken()` helper extraction**: The `renderForConsumer` switch block was extracted into a private `renderToken()` to avoid duplication between the regex pass and bare-UUID restoration pass.
2. **`BARE_UUID_REGEX` as module-level const**: Safe because it's only used with `String.prototype.replace()` which always resets `lastIndex`. The existing `createTokenRegex()` creates a new regex each time (also safe).
3. **Audit emission scope**: LLD initially specified per-token audit events, then a revised note suggested per-tool-call. Implementation chose per-token (all vault tokens). This was reviewed and accepted as conservative over-reporting in Phase 5b PR review.
4. **Tool Test tokenization**: Top-level string params only (not recursive). Acceptable for developer-entered test params.
5. **`getToolPIIAccess` as indirect test path**: `normalizeToolPIIAccess` is not exported (private), so unit tests exercise it indirectly through `getToolPIIAccess`.

## Audit Rounds

8 rounds of LLD review per pipeline.md requirement (highest-risk phase):

- Rounds 1-3: Architecture compliance, pattern consistency, completeness
- Round 4: Cross-phase consistency (LLD implements HLD, covers test spec)
- Round 5: Final sweep (task independence, wiring, domain rules)
- Rounds 6-8: Iterative refinements on audit emission approach, bare-UUID regex safety, tool-test parity scope

## LLD vs Implementation Divergences

| LLD Spec                                     | Implementation                                           | Verdict                                                      |
| -------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| One audit event per tool call (revised note) | One audit event per vault token                          | ACCEPTED — conservative over-reporting, reviewed in Phase 5b |
| `i18n studio.json` — update both sections    | Both agent_detail and agent_editor sections updated      | MATCH                                                        |
| `redaction_label_hint` unchanged             | Changed `<TYPE>` → `(TYPE)` to avoid HTML interpretation | ACCEPTABLE — defensive i18n fix                              |
