# SDLC Log: Kore Adapter — Test Spec Phase

**Date**: 2026-03-30
**Phase**: Test Spec (Phase 2 of SDLC pipeline)
**Skill**: `/test-spec kore-adapter`

---

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. Zero AMBIGUOUS — no user escalation.

### Key Decisions

| #   | Decision                                                              | Classification |
| --- | --------------------------------------------------------------------- | -------------- |
| D-1 | Mock SmartAssist via DI constructor injection, not vi.mock()          | DECIDED        |
| D-2 | Use DI callback capture for orgId persistence instead of real MongoDB | DECIDED        |
| D-3 | Exclude throughput/load testing; focus on concurrency correctness     | DECIDED        |
| D-4 | Dedicated regression test for GAP-008 singleton stale orgId           | DECIDED        |

### Priority FRs for Coverage

- FR-7 (HIGH): Lazy orgId resolution — was NOT TESTED, now has planned unit + integration coverage
- FR-12/FR-22 (MEDIUM): Webhook HMAC + tenant isolation — now has E2E + integration coverage
- FR-16/FR-17 (MEDIUM): ABL tools — now has planned integration coverage

## Files Created/Modified

| File                                           | Action    | Purpose                                                     |
| ---------------------------------------------- | --------- | ----------------------------------------------------------- |
| `docs/testing/sub-features/kore-adapter.md`    | Rewritten | Full test spec with 7 E2E, 13 integration, 6 unit scenarios |
| `docs/sdlc-logs/kore-adapter/test-spec.log.md` | Created   | This log file                                               |

## Audit Rounds

### Round 1: NEEDS_REVISION (2 CRITICAL, 4 HIGH)

- CRITICAL: E2E scenarios called adapter methods directly instead of HTTP API
- CRITICAL: FR-2, FR-9, FR-20, FR-21 had zero integration/E2E coverage
- HIGH: INT-3 (event mapping) was pure function — reclassified to unit
- HIGH: E2E-5/E2E-7 were store-level tests — reclassified to integration
- HIGH: Security section had unchecked items
- HIGH: FR-11 coverage matrix inaccuracy

**Fixes applied:**

- Replaced all adapter-direct E2E scenarios with HTTP-based scenarios using real Express servers
- Added INT-3 (credential resolution covering FR-2, FR-9, FR-20, FR-21)
- Moved E2E-5/E2E-7 → INT-8/INT-9
- Added INT-10 (ABL tools), INT-11-13 (precheck, orgId, singleton isolation)
- Fixed coverage matrix, security section, answered open question #1

### Round 2: NEEDS_REVISION (1 CRITICAL, 3 HIGH)

- CRITICAL: E2E-1/3/4/6 still called adapter.execute() directly
- HIGH: Only 3 of 7 E2E scenarios were real HTTP
- HIGH: FR-7 coverage matrix still showed NOT TESTED despite planned scenarios
- HIGH: FR-18 return path had no pipeline-level test

**Fixes applied:**

- Replaced E2E-1 with HTTP webhook inbound scenario
- Replaced E2E-3 with HTTP webhook post-agent return scenario (FR-18)
- Replaced E2E-4 with HTTP session management endpoints scenario
- Replaced E2E-6 with HTTP boot guard 503 scenario
- Moved precheck/orgId/singleton scenarios to INT-11/12/13
- Updated coverage matrix for FR-7, FR-12, FR-14, FR-15

## Final Counts

- **E2E scenarios**: 7 (all HTTP-based with real Express servers)
- **Integration scenarios**: 13 (all with real service boundaries)
- **Unit scenarios**: 6
- **Planned test files**: 6 new files
- **FR coverage**: All 22 FRs have at least unit + integration (most have E2E)

## Next Phase

Run `/hld kore-adapter` to generate the High-Level Design.
