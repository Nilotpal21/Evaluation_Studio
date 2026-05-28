# SDLC Log: External Agent Registry — Test Spec

**Phase**: TEST-SPEC
**Artifact**: `docs/testing/external-agent-registry.md`
**Feature Spec**: `docs/features/external-agent-registry.md`
**Date**: 2026-04-28
**Status**: APPROVED (3 audit rounds)

---

## Oracle Decisions

Questions were answered from feature spec, codebase reading, and existing test patterns. No AMBIGUOUS items required user escalation.

| #   | Question                                 | Classification | Decision                                                                                                                                                                |
| --- | ---------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which FRs are highest risk?              | ANSWERED       | FR-6 (runtime auth injection) and FR-5 (credential masking) — both require end-to-end validation of encrypted storage and decryption in the hot path                    |
| 2   | E2E test infrastructure pattern          | ANSWERED       | `startRuntimeServerHarness()` + `bootstrapProject()` from `channel-e2e-bootstrap.ts` — canonical pattern in `prompt-library-rbac.e2e.test.ts`                           |
| 3   | How to stub remote A2A agents in tests?  | DECIDED        | Check existing `mock-a2a-remote-agent.ts` for extension; create `a2a-stub-server.ts` only if insufficient. Serves `/.well-known/agent-card.json` + records auth headers |
| 4   | SSRF bypass for in-process stubs         | ANSWERED       | `SsrfEndpointValidator.validate()` accepts `allowPrivate: boolean` — harness needs `{ allowPrivateEndpoints: true }` option; no env var needed                          |
| 5   | Protocol enum in test data               | ANSWERED       | `'a2a' \| 'rest'` only — matches IR schema `RemoteAgentLocation.protocol` at `packages/compiler/src/platform/ir/schema.ts:591`                                          |
| 6   | INT-6 seeding approach                   | DECIDED        | Use HTTP POST API to seed ExternalAgentConfig (not direct Mongoose insert) — per CLAUDE.md E2E Test Standards                                                           |
| 7   | Cascade delete gap                       | INFERRED       | `deleteProject()` in `cascade-delete.ts` does NOT include `MCPServerConfig` or future `ExternalAgentConfig` — tracked as Open Question #2                               |
| 8   | DI approach for resolveRemoteFromHandoff | DECIDED        | LLD should enforce injectable `lookupExternalAgent` function parameter — makes UT-3 testable without mocks                                                              |
| 9   | Studio proxy test file                   | DECIDED        | Add `apps/studio/src/__tests__/external-agents-api.test.ts` to test file mapping for FR-7 proxy coverage                                                                |

---

## Audit Rounds

### Round 1

**Verdict**: NEEDS_REVISION

**Findings fixed**:

- [TS-4] CRITICAL: INT-6 seeded data via direct Mongoose model insert → rewrote to use `startRuntimeServerHarness()` + HTTP POST API
- [TS-4/H1] HIGH: INT-7 step 7 used `ExternalAgentConfig.countDocuments()` direct DB assertion → replaced with `GET /api/projects/${projectIdB}/external-agents` API assertion
- [TS-8/H2] HIGH: `SSRF_ALLOWED_HOSTS` env var was fabricated (does not exist in codebase) → replaced with `allowPrivate: boolean` parameter mechanism via harness option
- [TS-9/H3] HIGH: `bootstrapProject` import source undocumented → added import note pointing to `channel-e2e-bootstrap.js`
- [TS-10/H4] HIGH: Studio proxy test file missing from mapping → added `apps/studio/src/__tests__/external-agents-api.test.ts`
- [TS-6/M1] MEDIUM: E2E-8 auth context incomplete → added "project owner token from `bootstrapProject`"
- [TS-10/M2] MEDIUM: Existing `mock-a2a-remote-agent.ts` not referenced → added reference with evaluate-before-create guidance

### Round 2

**Verdict**: APPROVED

**Findings fixed**:

- [XP-4/H1] HIGH (feature spec): `SSRF_ALLOWED_HOSTS` still present in feature spec Section 11 → removed; now only lists `RUNTIME_ENCRYPTION_KEY`
- [XP-1/M3] MEDIUM: Feature spec Section 10 test file paths diverged (wrong naming convention) → updated to match test spec paths
- [TS-8/M1] MEDIUM: INT-4 missing harness config note → added "Harness started WITHOUT `allowPrivateEndpoints`"
- [TS-8/M2] MEDIUM: INT-8 data seeding context missing → added note referencing INT-6 harness + HTTP-seeded data

### Round 3

**Verdict**: APPROVED (final)

**Findings** (all LOW/MEDIUM — no blockers):

- [TS-9/M1] LOW: canonical import example reference — informational, not blocking
- [TS-9/M2] MEDIUM (feature spec only): Section 17 test filenames used hyphen suffix → fixed to dot-separated `.e2e.test.ts`
- [TS-4/L1] LOW: INT-4 step 6 parenthetical about card fetch failure — informational

---

## Files Created/Modified

| File                                       | Action                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `docs/testing/external-agent-registry.md`  | CREATED — full test spec (8 E2E, 8 INT, 3 UT groups)                             |
| `docs/features/external-agent-registry.md` | UPDATED — Section 10 file paths, Section 11 env vars, Section 17 test references |
| `docs/testing/README.md`                   | UPDATED — added entry for external-agent-registry                                |

---

## Key Decisions for LLD/Implement

1. **`allowPrivateEndpoints` harness option**: `startRuntimeServerHarness()` needs a new option that passes `allowPrivate: true` to `SsrfEndpointValidator`. INT-4 must run in a separate describe block without this option.
2. **DI for `resolveRemoteFromHandoff()`**: LLD must enforce an injectable repo parameter to make UT-3 testable without mocks.
3. **`mock-a2a-remote-agent.ts` extension**: Evaluate whether existing helper can serve `/.well-known/agent-card.json` before creating `a2a-stub-server.ts`.
4. **Cascade delete**: Only add `ExternalAgentConfig` to `deleteProject()` in Phase 1. Fix for `MCPServerConfig` is separate work (Open Question #2 deferred).
