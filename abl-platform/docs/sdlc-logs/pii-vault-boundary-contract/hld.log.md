# PII Vault Boundary Contract — HLD Log

**Phase**: 3 — High-Level Design
**Ticket**: ABLP-535
**Artifact**: `docs/specs/pii-vault-boundary-contract.hld.md`
**Commit**: `416e1ac81`

## Summary

HLD created covering 5 packages (compiler, shared-kernel, i18n, runtime, studio) with ASCII data-flow diagram showing the PII value lifecycle through all consumer boundaries. Key architectural decisions documented in the HLD:

1. **Secure by default**: `'tools'` consumer defaults to `'redacted'`. `'original'` is explicit opt-in.
2. **LLM forced tokenized**: No opt-out for LLM consumer — security baseline.
3. **Bare-UUID restoration is best-effort**: LLM wrapper stripping is handled; UUID truncation/reformatting is accepted degradation.
4. **Workflow engine path OUT OF SCOPE**: `restorePIITokensForTrustedInternalExecution` uses `vault.detokenize()` — intentionally different (trusted internal consumer).
5. **Pre-launch posture**: No migration tooling, no backward-compat shims.

## Audit Rounds

- Round 1: Architecture compliance — isolation, auth, stateless. PASS.
- Round 2: Pattern consistency — existing `resolveRenderMode` switch pattern maintained. PASS.
- Round 3: Completeness — all 9 FRs covered by HLD tasks. PASS.

## Task Decomposition

| Task                       | Packages      | Independent?  | Files |
| -------------------------- | ------------- | ------------- | ----- |
| T-1 Schema & Core Vault    | compiler      | Yes           | 2     |
| T-2 Trace Event Registry   | shared-kernel | Yes           | 1     |
| T-3 Runtime Tool Execution | runtime       | No (T-1, T-2) | 3     |
| T-4 Studio UI              | studio, i18n  | Yes           | 3     |
| T-5 Tests                  | runtime       | No (T-1..T-4) | 5     |
