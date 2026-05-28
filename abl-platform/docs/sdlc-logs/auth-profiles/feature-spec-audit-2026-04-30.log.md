# SDLC Log: Auth Profiles — Feature Spec UPDATE Audit Suite (Phase 4b)

**Date**: 2026-04-30
**Phase**: Feature Spec — 5-pass audit suite
**Feature**: auth-profiles (BETA, r2 gap-closure scope)
**Branch**: `fixes/AuthProfiles`
**Spec under audit**: `docs/features/auth-profiles.md` (970 → ~1100 lines after audit fixes)

---

## Audit Summary

| Pass | Auditor                 | Verdict        | Findings (C/H/M/L)             | Status                                                                 |
| ---- | ----------------------- | -------------- | ------------------------------ | ---------------------------------------------------------------------- |
| 1    | phase-auditor (round 1) | NEEDS_REVISION | 1 / 2 / 4 / 0                  | All CRITICAL+HIGH fixed → round 2                                      |
| 2    | phase-auditor (round 2) | **APPROVED**   | 0 / 0 / 4 / 0                  | 4 medium → carried forward to HLD/LLD                                  |
| 3    | platform audit          | NEEDS_REVISION | 0 / 2 / 5 / 3                  | All HIGH + most MEDIUM fixed in spec                                   |
| 4    | industry research       | informational  | 4 GAP / 3 RISK / 6 IMPROVEMENT | 4 new GAPs (19-22) added to §16; 4 carry-forward open questions logged |
| 5    | OSS library audit       | informational  | adopt 4 / evaluate 1 / avoid 4 | OSS recommendations logged in §18                                      |

**Final verdict**: APPROVED with documented carry-forward items. The spec is ready to feed `/test-spec` (already partially updated in this session) and `/hld`.

---

## Round 1 (phase-auditor) — Findings & Fixes

### CRITICAL (fixed in round 1 → 2 transition)

- **F-1**: FR-12 used invented `connectionMode === 'tenant_shared'` value. Actual enum at `packages/shared/src/validation/auth-profile.schema.ts:292` is `['shared', 'per_user']`. **Fixed**: replaced with `connectionMode === 'shared'` + citation; also fixed E2E-r2-4 step 9 in `docs/testing/auth-profiles.md`.

### HIGH (fixed)

- **F-2**: §8 missing `Surface Semantics Matrix` and `Design-Time vs Runtime Behavior` subsections required by TEMPLATE.md when feature crosses asset boundaries. **Fixed**: added 7-row matrix (project profile / workspace profile / OAuth grant / MCP fields / HTTP tool DSL / inline tool config / workflow tool_call) plus 4 paragraphs covering control plane, data plane, name resolution, and local-only state.
- **F-3**: FR-9 cited `internal-tools.ts:170-175` — verified actual `new ToolBindingExecutor({...}).execute(...)` block spans 170-178. **Fixed**: corrected line range in FR-9 and §5 integration matrix.

### MEDIUM (4 — partial fix; remainder deferred)

- F-4 (FR density) — deferred to HLD/LLD per round-2 reviewer guidance
- F-5 (FR-14 endpoint mixing UI/API) — fixed inline note in §17 row
- F-6 (terminology consistency `connectionMode='shared'` ≠ `visibility: 'shared'`) — clarification added in FR-12; full gloss deferred to HLD
- F-7 (test file paths in §17 matrix) — fixed by adding "Planned Test File / Note" column

---

## Round 2 (phase-auditor) — APPROVED

Verified all CRITICAL + HIGH from round 1 resolved. No new CRITICAL/HIGH findings introduced. New MEDIUM carry-forward items logged for HLD/LLD:

1. **Error-code taxonomy table** — 11 new error codes (`AUTH_PROFILE_PER_USER_IN_MCP`, etc.) scattered across FR-9..FR-17; HLD must consolidate.
2. **`usageMode='user_token'` workspace disposition** — FR-13 rejects `'jit' | 'preflight'` but doesn't address `'user_token'`; LLD must clarify.
3. **FR density carry-forward** — FR-9..FR-17 are 200-400 word blocks; HLD should break into per-component sections.
4. **`connectionMode='shared'` vs `visibility: 'shared'` terminology gloss** — HLD terminology section should explicitly distinguish these.

All 4 logged as new Open Questions OQ-9..OQ-12 in spec §15.

---

## Pass 3 (Platform audit) — Findings & Fixes

### HIGH (fixed)

- **F3-3**: ST-1 contract was specified for FR-13 workspace OAuth but did NOT retrofit the existing project OAuth flow at `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/{initiate,callback}`. Project flow today carries `tenantId, userId, authProfileScope` in state but has no `csrfNonce` or same-origin cookie — same vulnerability class as workspace flow. **Fixed**: amended FR-13 explicitly mandating ST-1 retrofit on BOTH flows; updated P8 Phase 4.3 effort estimate from 1 day to 1.5 days.
- **F3-9**: FR-11 subtask 2.3 spans 4-5 packages (database + shared + shared-auth-profile + runtime + studio), violating CLAUDE.md "Commit Discipline" max-3-package limit. **Fixed**: split FR-11 into 3 sub-commits — 2.3a (database only), 2.3b (shared + shared-auth-profile), 2.3c (runtime only). Each within the 3-package cap.

### MEDIUM (5)

- **F3-1**: Clarified that existing `client-credentials-service.ts` Redis key `auth-profile:cc-token:{tenantId}:{profileId}` must adopt CK-1 `profileVersion` component to invalidate on profile mutation rather than relying on TTL alone. **Fixed**: amended FR-11.
- **F3-2**: MCP transport enum says `streamable-http` but model has `'http' | 'sse'`. **Fixed**: replaced all occurrences of `streamable-http` with `http (HTTP/streamable)` and added cite to `mcp-server-config.model.ts:57`.
- **F3-6**: Phase 0.2 wording overstated work — `'auth-profile:write'` already exists in `TENANT_ROLE_PERMISSIONS` at line 361; only missing from `WORKSPACE_PERMISSIONS` constant. **Fixed**: rephrased Phase 0.2 to state only the constant addition is needed.
- **F3-7**: OQ-8 (`PHASE1_AUTH_TYPES` deprecation) needed conversion to a concrete subtask. **Fixed**: identified the 4 non-test consumers, converted to a P8 Phase 5 subtask with explicit `@deprecated` JSDoc + migration sequence.
- **F3-8**: FR-9 wording could be misread as replacing route Express middleware. **Fixed**: explicitly clarified `createAuthProfileToolMiddleware` is a tool-level middleware injected into `ToolBindingExecutor` constructor, not Express middleware; route's `InternalServiceRequest` service-token auth preserved.

### LOW (3 — confirmation only, no fix needed)

- F3-4: `envProfileId` confirmed not in current schema — spec correctly identifies as new field
- F3-5: `profileVersion` confirmed not in current model — spec correctly identifies as new field
- F3-10: `signRequest` does not duplicate `apply-signing.ts` — distinct concerns (protocol-native signing vs addon HMAC/RSA)

---

## Pass 4 (Industry research) — Findings & Fixes

### GAPs (added to §16 as GAP-19 through GAP-26)

- **GAP-19 (HIGH)**: SSRF risk on OAuth `tokenUrl` — `z.string().url()` doesn't block metadata services / RFC 1918. Per OWASP SSRF Prevention Cheat Sheet + NIST SP 800-204 §5.2.
- **GAP-20 (HIGH)**: `redirect_uri` not in ST-1 state payload. RFC 6749 §10.6 requires verification on callback.
- **GAP-21 (MEDIUM)**: OAuth grant revocation propagation undefined. RFC 7662 introspection polling or short TTLs.
- **GAP-22 (MEDIUM)**: Provider rate limits unhandled (Microsoft Entra ~100-200/sec, AWS STS 100/sec/account).
- **GAP-23 (MEDIUM)**: `signRequest` callback returns `Headers` only — body-mutating protocols (digest, ws_security) need different shape or path.
- **GAP-24 (MEDIUM)**: No refresh jitter — thundering-herd partial mitigation. Add 0-5 s random jitter (Vault precedent).
- **GAP-25 (LOW)**: Cross-region cache consistency unspecified. Document Redis topology assumption.
- **GAP-26 (LOW)**: MCP spec compliance scoping — only `bearer` is MCP-spec-compliant; other 11 types are platform extensions.

### RISKs (mostly logged as carry-forward open questions)

- Refresh thundering-herd jitter → Open Question OQ-11
- Cross-region cache consistency → GAP-25
- Token refresh success target 99.5% below industry norm → **target raised to 99.9% with retry-with-backoff** in §14

### IMPROVEMENTs (incorporated)

- Hierarchical tenant namespacing — documented as future-path consideration (Vault namespaces)
- MCP per-request `Authorization` requirement — incorporated into FR-11 SSE vs HTTP transport distinction (SSE requires reconnect, not header hot-swap)
- `signRequest` callback shape idiomatic per AWS SDK middleware — confirmed

### Pass-4 Source Logging

12 industry references logged in §18 (RFCs 6749/7522/7616/7662, OWASP cheat sheets, NIST 800-204, CSA CCM, MCP Authorization Spec 2025-03-26, Vault, AWS SigV4).

---

## Pass 5 (OSS library audit) — Findings & Recommendations

### Adopt (no spec change needed; spec choices verified correct)

- `@aws-sdk/signature-v4`, `@aws-sdk/protocol-http` (Apache-2.0) — already in lockfile; re-export from `packages/shared-auth-profile/`
- `@hapi/hawk` (BSD-3) — canonical HAWK implementation by protocol author; only new dep needed for FR-15
- `kerberos` (Apache-2.0, mongodb-js) — only maintained Node.js Kerberos binding; ENABLE_KERBEROS gate is correct
- Plain `fetch` for Azure AD client_credentials — confirmed: matches existing SharePoint connector pattern; avoids `@azure/msal-node` 1.5 MB bundle

### Adopt custom (no OSS replacement)

- CK-1 keyed Redis token cache, ST-1 OAuth state, `signRequest` hook, RFC 7522 SAML grant helper, HTTP Digest retry-on-401

### Evaluate during HLD

- `oauth4webapi` (panva, MIT, ~15 KB) — could replace hand-rolled token-exchange POST logic in OAuth callbacks; doesn't replace ST-1 layer. Logged as OQ-12.

### Avoid

- `@azure/msal-node`, `aws4`, `digest-fetch`, `node-expose-sspi` — rationale logged in §18.

### Pass-5 Caveat

OSS data (weekly DL, stars, CVEs) couldn't be verified live due to WebSearch / Bash restrictions; recommend `npm view <pkg> version time.modified license` + `npm audit` per candidate before HLD adoption.

---

## Final Carry-Forward to HLD/LLD (12 items)

1. **Error-code taxonomy registry** (Pass-2 medium → OQ-9): consolidate 11 new error codes with HTTP status, surface, NEW vs EXISTING tag, introducing FR
2. **`usageMode='user_token'` workspace disposition** (Pass-2 medium → OQ-10)
3. **FR density** (Pass-2 medium): break FR-9..FR-17 into per-component HLD sections
4. **Terminology gloss** (Pass-2 medium → OQ-12): `connectionMode='shared'` (= tenant-shared grant) vs `visibility: 'shared'` (= UI visibility)
5. **SSRF protection** (Pass-4 GAP-19): IP/hostname blocklist for `tokenUrl` exchange
6. **`redirect_uri` in ST-1** (Pass-4 GAP-20): add `redirectUri` to state payload + verify on callback
7. **Refresh jitter** (Pass-4 GAP-24 → OQ-11): 0-5 s random jitter on 30 s pre-expiry refresh
8. **`signRequest` body mutation** (Pass-4 GAP-23): clarify body-mutating protocols use separate path
9. **Provider rate limit handling** (Pass-4 GAP-22): token-exchange rate limiter per `{tenantId, profileId}`
10. **OAuth grant revocation propagation** (Pass-4 GAP-21): RFC 7662 introspection polling or short TTL
11. **Cross-region cache consistency** (Pass-4 GAP-25): document Redis topology
12. **`oauth4webapi` library evaluation** (Pass-5 → OQ-13): adopt vs custom-keep for token-exchange POST logic

---

## Files Modified This Phase

- `docs/features/auth-profiles.md` — main feature spec (970 → ~1100 lines after audit fixes)
- `docs/testing/auth-profiles.md` — test guide (added FR-9..FR-17 coverage matrix rows + E2E-r2-1..14 + INT-r2-1..6 scenarios; F-1 fix for `connectionMode='shared'`)
- `docs/features/README.md` — index updated UPDATED 04-30
- `docs/testing/README.md` — index updated PARTIAL 04-30
- `docs/sdlc-logs/auth-profiles/feature-spec-update-2026-04-30.log.md` — Phase 1 discovery log
- `docs/sdlc-logs/auth-profiles/feature-spec-audit-2026-04-30.log.md` — this file

---

## Next Phase

`/test-spec auth-profiles` — already partially complete (FR-9..FR-17 PLANNED rows in coverage matrix and 14 E2E scenarios + 6 integration scenarios). Phase 5 (commit + log) should land next.
