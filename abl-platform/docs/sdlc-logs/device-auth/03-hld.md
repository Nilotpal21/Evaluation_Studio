# SDLC Log: Device Auth -- Phase 3 (HLD)

**Date**: 2026-03-23
**Phase**: HLD
**Artifact**: `docs/specs/device-auth.hld.md`

## Summary

Generated comprehensive HLD addressing all 12 architectural concerns, 3 alternatives considered, 7 design decisions with tradeoffs, and a complete task decomposition.

## Key Design Decisions

1. **SHA-256 hashing** -- one-way hash prevents DB compromise from exposing valid codes
2. **No tenant scoping** -- CLI doesn't know tenant at initiation; resolved at token issuance
3. **In-memory rate limiter** -- simplicity over distributed correctness for low-volume feature
4. **No repository layer** -- direct Mongoose access is appropriate for 4 simple operations
5. **Dynamic imports** -- required for ESM module resolution, prevents circular dependencies

## 12 Concerns Coverage

| #   | Concern             | Status     | Key Finding                                         |
| --- | ------------------- | ---------- | --------------------------------------------------- |
| 1   | Tenant isolation    | Documented | No tenantId on device codes; resolved at token time |
| 2   | Data access pattern | Documented | No repo layer; direct model access                  |
| 3   | API contract        | Documented | Error envelope inconsistency identified             |
| 4   | Security surface    | Documented | Missing audit logging, brute-force protection       |
| 5   | Error model         | Documented | Complete error table with recovery paths            |
| 6   | Failure modes       | Documented | Rate limiter unbounded growth identified            |
| 7   | Idempotency         | Documented | TOCTOU race on consume step                         |
| 8   | Observability       | Documented | console.error instead of createLogger               |
| 9   | Performance budget  | Documented | Low-volume, no concerns                             |
| 10  | Migration path      | Documented | Redis rate limiting, scope enforcement paths        |
| 11  | Rollback plan       | Documented | Standalone feature, no cascading impact             |
| 12  | Test strategy       | Documented | 0% E2E/integration, targets defined                 |

## Alternatives Evaluated

1. **Long-lived API keys** -- rejected (already exists, no session scope control)
2. **OAuth PKCE** -- rejected (requires local HTTP server, breaks in SSH/Docker)
3. **RFC 8628 Device Auth** -- chosen (works everywhere, user-friendly, time-limited)

## Audit Round 1 (Self-Review)

- All 12 concerns addressed with code-grounded analysis
- Error model table complete with HTTP status codes and recovery paths
- API contract inconsistency flagged (error envelope not standardized)
- Multi-tenant risk documented (first membership non-deterministic)
