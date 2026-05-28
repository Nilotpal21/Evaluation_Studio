# SDLC Log: Platform Keys HLD

**Feature**: Platform Keys Management UI
**Phase**: HLD (Phase 3 of SDLC)
**Date**: 2026-04-11
**Branch**: `KI081/feat/workflows-node-changes`

## Oracle Decisions

All 15 clarifying questions were answered by the product oracle. No AMBIGUOUS items escalated.

### Key Decisions

| #   | Question                                  | Classification | Answer Summary                                                                                           |
| --- | ----------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| Q1  | Architecture pattern for /api/keys        | ANSWERED       | Follow exact same pattern as /api/sdk/keys: withOpenAPI + Zod + requireAuth + requireSdkProjectAccess    |
| Q2  | Data flow for key creation                | ANSWERED       | Synchronous: UI → POST /api/keys → Zod → auth → generate key → Mongoose → MongoDB. No events/queues.     |
| Q3  | Expected scale                            | ANSWERED       | Low cardinality (tens per project). 100-item cap. No pagination needed.                                  |
| Q4  | Existing tabbed settings patterns         | ANSWERED       | Existing Tabs component with WAI-ARIA, Framer Motion. FR-01 prescribes its usage.                        |
| Q5  | Deployment topology                       | ANSWERED       | Purely Studio app (Next.js). No runtime or admin changes.                                                |
| Q6  | Package dependencies                      | ANSWERED       | @agent-platform/database, @agent-platform/openapi, @/lib/auth, @/lib/sdk-project-access, Node crypto     |
| Q7  | New external dependencies                 | ANSWERED       | None. Zero new npm packages or third-party integrations.                                                 |
| Q8  | API contract with WebhookKeyCreationModal | ANSWERED       | Must adapt to new response shape: prefix (not keyPrefix), scopes (not permissions). Body changes too.    |
| Q9  | Breaking changes to existing APIs         | ANSWERED       | None. /api/sdk/keys stays completely unchanged. New /api/keys route added alongside.                     |
| Q10 | resolveApiKey compatibility               | ANSWERED       | Already fully supports ApiKey documents. Zero runtime changes needed.                                    |
| Q11 | Biggest technical risk                    | INFERRED       | WebhookKeyCreationModal migration (FR-15): API contract change + callback chain to WorkflowTriggersTab   |
| Q12 | Existing data migration needs             | INFERRED       | No migration. Existing auto-created ApiKey docs (wf-trigger-\*) will appear in list. By design.          |
| Q13 | Rollback strategy                         | DECIDED        | Delete new files + git revert modifications. Created ApiKey docs stay valid for runtime. Low risk.       |
| Q14 | Feature flags                             | DECIDED        | Not required. Studio-only, additive, low-risk. Incremental delivery plan provides natural phase gates.   |
| Q15 | Blast radius of ApiKeysTab refactoring    | INFERRED       | Confined to Settings > API Keys page. SDK keys API unaffected. Runtime unaffected. No cross-page impact. |

## Audit Results

### Round 1 — NEEDS_REVISION

- **CRITICAL**: Prefix length mismatch — HLD specified 12 chars, but runtime `auth.ts:159` uses `rawKey.substring(0, 8)` with exact match at `auth-repo.ts:107`. Fixed to 8 chars throughout.
- **HIGH**: Error table listed 403, but `requireSdkProjectAccess` returns 404 for access failures (platform invariant). Removed 403, added clarification note.
- **HIGH**: DELETE revoke used unconditional `$set: { revokedAt }`, overwriting timestamp on repeated calls. Fixed: added `revokedAt: null` guard in query filter.
- **MEDIUM**: Open Question #3 (prefix length) was a correctness bug, not an open question. Moved to Resolved Decisions with runtime code evidence.
- **MEDIUM**: WebhookKeyCreationModal transition path incomplete. Added details about existing `pk_` keys and `resolveApiKey` fallback.
- **MEDIUM**: Test spec HLD reference was stale. Updated.

### Round 2 — APPROVED

- **HIGH**: Feature spec and test spec still reference "first 12 chars" for prefix (cross-doc inconsistency). Added "Pre-LLD Corrections Required" section.
- **HIGH**: Test spec INT-4 expects 200 on second DELETE, but HLD designs 404 (revokedAt null guard). Documented in Pre-LLD Corrections.
- **MEDIUM**: Component diagram simplified Tabs usage. Noted as diagram simplification.
- **MEDIUM**: Inconsistent projectId delivery across endpoints. Added rationale note.

### Round 3 — APPROVED (Final)

- No new findings. All round 1-2 fixes verified.
- Gate condition: 3 pre-LLD corrections to feature spec and test spec must be applied before LLD.

## Files Created

- `docs/specs/platform-keys.hld.md`
- `docs/sdlc-logs/platform-keys/hld.log.md`

## Files Updated

- `docs/testing/sub-features/platform-keys.md` (HLD reference)
