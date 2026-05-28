# PII Vault Boundary Contract — Test Spec Log

**Phase**: 2 — Test Specification
**Ticket**: ABLP-535
**Artifact**: `docs/testing/sub-features/pii-vault-boundary-contract.md`
**Commit**: `416e1ac81`

## Summary

Test specification created with 22 scenarios across 3 tiers (9 unit, 6 integration, 6 E2E). Exceeds the minimum 5+5 requirement. Key design decisions:

1. **No `vi.mock` of platform components** — all tests use real function composition or HTTP-only E2E.
2. **Audit event testing at prerequisite level** — scenarios 10/11 verify that `restorePIITokensForToolExecution` returns plaintext and `vault.listTokens()` is available for hashing. Full trace event interception deferred to future stateful-LLM E2E infrastructure.
3. **RBAC tested at E2E level** — the `pii-patterns` route RBAC middleware has heavy dependency tree; integration-level import test replaced with HTTP E2E tests (E2E-6a/6b).

## Audit Rounds

- Round 1: Phase-auditor verified coverage matrix completeness (all 9 FRs covered).
- Round 2: Product-oracle confirmed the E2E-1/2/3 stateful-LLM gap is acceptable at integration level.

## Decisions

| Decision                                | Rationale                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Test audit events at prereq level       | Full trace event interception requires mock LLM that echoes tokenized PII back as tool args — complex E2E harness not yet available |
| RBAC at E2E not integration             | `requirePiiPatternProjectPermission` middleware imports the full RBAC module with heavy deps; HTTP-only E2E is more reliable        |
| 21 scenarios (not 14 from feature spec) | Additional edge cases: empty vault, non-string primitives, nested objects, defensive copies                                         |
