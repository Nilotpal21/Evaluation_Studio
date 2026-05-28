# SDLC Log: ABLP-535 PII Boundary Hardening - Post-Implementation Sync

**Feature**: `ablp-535-pii-boundary-hardening`
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-27

## Summary

Synced PII documentation after the ABLP-535 implementation commits and the product decision to skip legacy-session backfill.

## Documents Updated

- `docs/plans/2026-04-27-ablp-535-pii-boundary-hardening-plan.md`: marked forward-looking implementation complete and Phase 6 legacy backfill intentionally out of scope.
- `docs/sdlc-logs/ablp-535-pii-boundary-hardening/implementation.log.md`: recorded the no-backfill product decision and corrected remaining-scope notes.
- `docs/features/pii-detection.md`: added Runtime read-boundary protection, exact audited reveal, durable `PIITokenVault`, Studio reveal UX, and accepted legacy non-migration limitation.
- `docs/testing/pii-detection.md`: added ABLP-535 Runtime/Studio coverage, exact reveal authorization tests, durable vault tests, and accepted non-gap for legacy backfill.
- `docs/specs/pii-detection.hld.md`: added the admin reveal path and migration stance.
- `docs/testing/README.md`: updated PII Detection status date.

## Coverage Delta

| Area                     | Before                                                 | After                                                                             |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Historical read boundary | Existing PII docs did not mention ABLP-535 route locks | Documented Runtime session/message/trace route coverage                           |
| Admin reveal             | Not represented in PII feature docs                    | Documented exact permission, audited Runtime endpoint, Studio proxy, Studio modal |
| Durable reveal vault     | Not represented in PII feature docs                    | Documented `PIITokenVault`, encrypted originals, TTL, cascade/erasure behavior    |
| Legacy backfill          | Planned follow-on in ABLP-535 plan                     | Intentionally excluded by product decision                                        |

## Remaining Gaps

- PII pattern CRUD still lacks a real-server E2E test with full auth middleware.
- Registry bypass and broader PII recognizer limitations remain open in the parent PII feature.

## Deviation From Plan

Phase 6 historical backfill was removed from ABLP-535 scope. Legacy sessions without durable token-vault provenance are treated as unavailable/non-revealable rather than migrated.
