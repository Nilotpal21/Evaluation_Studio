# SDLC Log: Device Auth -- Phase 1 (Feature Spec)

**Date**: 2026-03-23
**Phase**: Feature Spec
**Artifact**: `docs/features/device-auth.md`

## Summary

Updated and improved the device-auth feature spec based on deep code analysis of the actual implementation.

## Key Findings from Code Analysis

1. **GAP-006 Re-evaluation**: `req.user?.id` in device-auth routes is CORRECT per `AuthUser` interface (`{ id, email, name }`). The bug is in the route TEST which mocks `req.user = { sub: 'user-1' }` instead of `{ id: 'user-1' }`. This means the test does not catch real auth integration issues.
2. **GAP-007 (NEW)**: `pollDeviceToken` has a TOCTOU race -- the consume `updateOne({ _id })` lacks a `{ consumedAt: null }` conditional filter, allowing concurrent poll requests to both receive tokens.
3. **GAP-008 (NEW)**: In-memory rate limiter Map has no max-size or eviction policy, violating the platform invariant "Every in-memory Map needs max size, TTL, and eviction."
4. **GAP-009 (NEW)**: No audit logging for device auth events, despite the platform having a comprehensive audit logging system (36+ event types).
5. **GAP-010 (NEW)**: Deny action does not update the DB record -- denial is only communicated via response, not tracked.

## Changes Made

- Expanded FRs from 8 to 12 (added FR-9 through FR-12)
- Upgraded GAP-003 severity from Low to Medium (console.error violates core invariant)
- Corrected GAP-006 description to reflect the actual bug (test mock, not route code)
- Added 4 new GAPs (GAP-007 through GAP-010)
- Added user story for operator (auto-cleanup)
- Added NEXT_PUBLIC_API_URL to environment variables
- Added runtime configuration section
- Expanded testing matrix with integration test scenarios
- Corrected device code size description (32-byte = 64 hex chars, not "64-byte")

## Audit Round 1 (Self-Review)

- CRITICAL: None
- HIGH: GAP-007 (TOCTOU race) identified and documented
- MEDIUM: 4 gaps added, all documented with clear descriptions
- Decision: Feature spec is grounded in verified code, all claims cross-referenced
