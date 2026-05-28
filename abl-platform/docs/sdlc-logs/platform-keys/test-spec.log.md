# Test Spec Log: Platform Keys

**Date**: 2026-04-12
**Phase**: TEST-SPEC
**Artifact**: `docs/testing/sub-features/platform-keys.md`

## Oracle Decisions

All 15 clarifying questions answered by product-oracle (ANSWERED/INFERRED/DECIDED — zero AMBIGUOUS).

### Key Decisions

1. **Highest risk FRs**: FR-19/FR-20 (ceiling check) — privilege escalation is the critical security boundary
2. **5 role combinations for ceiling tests**: VIEWER+agents.write→403, OPERATOR+workflows.execute→200, MEMBER+workflows.execute→403, ADMIN+analytics.read→403, OWNER+all→200
3. **Backwards compatibility**: 3 expansion cases — dot-separated (registry), colon-separated (passthrough), unknown (empty + warning)
4. **No external dependencies to mock**: Pure MongoMemoryServer + in-memory constants
5. **Cross-system E2E**: Key created in Studio, used as Bearer token at runtime HTTP endpoint

## Audit Results

### Round 1: NEEDS_REVISION

- HIGH: E2E-14/E2E-15 had direct DB access and wrong resolveApiKey signature
- HIGH: E2E-14 called resolveApiKey directly instead of via HTTP
- MEDIUM: Harness extension section missing role setup docs
- MEDIUM: Terminology fix (invitations API, not member API)
- All fixed before round 2

### Round 2: APPROVED

- MEDIUM (non-blocking): E2E-15 creation-time backwards compat assumption → added as open question #6
- MEDIUM (non-blocking): Dev-login rate limiter gotcha → added as open question #7

## Files Created/Modified

- `docs/testing/sub-features/platform-keys.md` — Full test spec (overwrite of placeholder)
- `docs/testing/README.md` — Removed orphan merge conflict marker
- `docs/sdlc-logs/platform-keys/test-spec.log.md` — This file

## Coverage Summary

| Type        | Phase 1 (DONE) | Phase 2 (PLANNED) | Total |
| ----------- | -------------- | ----------------- | ----- |
| E2E         | 10             | 6                 | 16    |
| Integration | 10             | 6                 | 16    |
| Unit        | 4              | 4                 | 8     |
| Security    | 6              | 5                 | 11    |

## Next Phase

HLD already exists at `docs/specs/platform-keys.hld.md`. Proceed to `/lld platform-keys`.
