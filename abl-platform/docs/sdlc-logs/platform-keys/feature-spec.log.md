# SDLC Log: Platform Keys Feature Spec

**Feature**: Platform Keys Management UI
**Phase**: Feature Spec (Phase 1 of SDLC)
**Date**: 2026-04-11
**Branch**: `KI081/feat/workflows-node-changes`

## Oracle Decisions

All 15 clarifying questions were answered by the product oracle. No AMBIGUOUS items escalated.

### Key Decisions

| #    | Decision                                                    | Classification | Rationale                                                           |
| ---- | ----------------------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| D-1  | Predefined scope list (`workflow:execute`, `workflow:read`) | DECIDED        | Free-text scopes error-prone; extensible by adding to list          |
| D-2  | Project-scoped (filter by current projectId)                | DECIDED        | Matches ApiKey model, SDK keys pattern, isolation invariant         |
| D-3  | No "Used by" reverse trigger lookup in v1                   | DECIDED        | Cross-collection complexity; trigger panel already shows key status |
| D-4  | Allow editing name and scopes only; not projectIds          | DECIDED        | Security-sensitive; matches Stripe/GitHub patterns                  |
| D-5  | Warning dialog on revoke, no auto-pause of triggers         | DECIDED        | Cascading side effects risky; trigger panel detects revoked keys    |
| D-6  | Pre-select current project, allow multi-project selection   | DECIDED        | Model supports array; reduces friction                              |
| D-7  | `plt-<uuidv7>` for clientId, `abl_` prefix for raw key      | DECIDED        | Distinguishes UI-created from auto-generated keys                   |
| D-8  | Reuse `requireSdkProjectAccess` auth pattern                | DECIDED        | Proven pattern, no new infra needed                                 |
| D-9  | Default environments to `[]`, no UI exposure                | DECIDED        | No consumer yet; avoids premature complexity                        |
| D-10 | Unpaginated list with 100-item safety cap                   | DECIDED        | Low cardinality; matches SDK keys pattern                           |

### Answered (from code/specs)

- Q1: Purely Studio UI + API routes (ANSWERED)
- Q3: Support TTL/expiration in create flow (ANSWERED)
- Q6: Primary personas: Studio user + external developer (ANSWERED)
- Q15: Follow `withOpenAPI` + Zod schema pattern (ANSWERED)

## Audit Results

### Round 1 — APPROVED

- **HIGH**: FR-03 missing expired key filter → Fixed: added `$or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]`
- **MEDIUM**: Missing compound index for list query → Added GAP-006
- **MEDIUM**: Test scenario 9 had no matching FR → Resolved by FR-03 fix

### Round 2 — APPROVED (Final)

- No CRITICAL or HIGH findings
- **MEDIUM**: AVAILABLE_SCOPES hardcoded in UI (acceptable, Open Question #2 captures)
- **MEDIUM**: Cross-project returns empty list vs 404 (defensible design choice, documented)
- All R1 fixes verified

## Test Spec Phase (2026-04-11)

### Oracle Decisions (Test Spec)

All 15 clarifying questions answered. Key findings:

- Test harness exists: `startStudioApiHarness()` with MongoMemoryServer
- Zero mocks needed (entire feature is Studio API to MongoDB)
- SDK keys serialization test and preview-share E2E test as pattern references
- 100-item cap tested at integration level only (bulk insert)

### Audit Results (Test Spec)

**Round 1 — APPROVED**

- **HIGH**: FR-09 multi-project missing coverage -> Fixed: added E2E-10 and INT-10
- **MEDIUM**: Data seeding exception note -> Fixed: explicit exception documented

**Round 2 — APPROVED (Final)**

- No CRITICAL or HIGH findings
- **MEDIUM**: Feature spec Section 17 file paths differ (deferred to post-impl-sync)
- **MEDIUM**: UI-only FRs need Playwright decision (captured in open questions)

## Files Created

- `docs/features/sub-features/platform-keys.md`
- `docs/testing/sub-features/platform-keys.md`
- `docs/sdlc-logs/platform-keys/feature-spec.log.md`

## Index Files Updated

- `docs/features/sub-features/README.md`
- `docs/features/README.md`
- `docs/testing/sub-features/README.md`
- `docs/testing/README.md`
