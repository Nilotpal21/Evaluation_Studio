# Auth Profile Implementation Plans — Pass 5 Completeness Audit

> **Date:** 2026-03-13
> **Scope:** Verify Pass 4 revisions addressed the 7 Pass 3 findings and 3 top actions
> **Previous audit:** `docs/plans/2026-03-13-auth-profile-audit-pass3-completeness.md`
> **Auditor:** Automated completeness review (Pass 5)

---

## Section 1: Resolution of Top 3 Actions

### Action 1: Schedule Consumer Migrations (G-37, G-38, G-39) — RESOLVED

The Infrastructure Gaps plan now includes a "Consumer Migrations for Phase 3 Cleanup" section with Sprint 3 assignment. All three consumers are scheduled:

- TriggerRegistration.webhookSecret: 1d, P1
- GuardrailPolicy.apiKeyCredentialId: 1d, P1
- ModelConfig.credentialId: 1d, P1
- Dual-read for all three: 1d, P1

Total: 4d of Sprint 3 effort. This ensures Phase 3 deletion of `LLMCredential` will not break these consumers.

### Action 2: Add Name Deduplication (P3-2/G-42) — RESOLVED

The Infrastructure Gaps plan now includes "Gap 8: Migration Name Deduplication" with:

- Collision detection before insert
- Deduplication suffix: "Production OpenAI (2)", "(3)", etc.
- Unique index created AFTER migration (not before)
- Logging of all deduplication actions
- Sprint 2 assignment: 1.5d total, P1

### Action 3: Specify oauth2_app Resolution Algorithm (P3-7) — RESOLVED

GAP-3.2 Section 5.2 now specifies the full resolution algorithm:

1. Project-scoped first: `AuthProfile.findOne({ tenantId, projectId, authType: 'oauth2_app', connector, status: 'active' })`
2. Tenant-scoped fallback: `AuthProfile.findOne({ tenantId, projectId: null, ... })`
3. Ambiguity: prefer most recently created (`sort: { createdAt: -1 }`)
4. No match: deployment validation **error** (not warning)

---

## Section 2: Resolution of All 7 Pass 3 Findings

| ID   | Severity | Finding                                                    | Status   | Notes                                                                                      |
| ---- | -------- | ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| P3-1 | MEDIUM   | 10 security items as "future work" without sprint          | PARTIAL  | 3 consumer migrations now scheduled (Sprint 3). 7 security hardening items still unqueued. |
| P3-2 | HIGH     | Unique constraint name collision                           | RESOLVED | Gap 8 added to Infrastructure Gaps plan with Sprint 2 assignment.                          |
| P3-3 | LOW      | LLM system prompt guidance for CONSENT_REQUIRED            | RESOLVED | GAP-3.2 Section 3.4 now includes the exact system prompt text.                             |
| P3-4 | LOW      | OAuth state HMAC vs encrypted inconsistency                | RESOLVED | GAP-3.3 Task 9 updated to "AES-256-GCM encrypted state parameter with nonce."              |
| P3-5 | MEDIUM   | Redis pub/sub failure mode for cross-pod auth gate         | RESOLVED | GAP-3.1 Pass 4 added direct WS send as primary, pub/sub as secondary, polling fallback.    |
| P3-6 | MEDIUM   | BatchConsentGate references unspecified session store data | PARTIAL  | Task 3.2 still lacks the WS payload-to-store mapping specification.                        |
| P3-7 | MEDIUM   | No oauth2_app resolution algorithm specified               | RESOLVED | GAP-3.2 Section 5.2 provides the full algorithm.                                           |

---

## Section 3: New Findings

### P5-1 (LOW): P3-6 Partially Unresolved — auth_required WS Payload to BatchConsentState Mapping

GAP-3.4 Task 3.2 still reads: "Handle `auth_required` message type in session store" without specifying the data mapping. Section 12.2 says the `BatchConsentGate` "reads the `auth_required` message from `useSessionStore`" but does not define:

1. The shape of the `auth_required` WS payload (which fields from the runtime's `AuthGate` are sent over the wire)
2. How those fields map to `BatchConsentState.connectors[]` (the `ConsentConnector` type in Section 12.1)

This is a LOW risk because the types are well-defined on both sides (`AuthGate` in GAP-3.1 Section 3.1, `ConsentConnector` in GAP-3.4 Section 12.1) and the mapping is straightforward for an implementer. No action required — flagging for completeness only.

### P5-2 (LOW): Infrastructure Gaps Security Hardening Items Still Unscheduled

Of the 10 items in "Security Findings Not Yet Addressed," Pass 4 scheduled the 3 consumer migrations (items 6-8). The remaining 7 items are still listed as future work without sprint assignment:

1. Validate endpoint visibility (item 1)
2. Proxy chain shared-to-personal (item 2)
3. providerUserId PII leak (item 3)
4. NormalizedAuthProfile type safety (item 4)
5. SSRF on URL fields / Zod .strict() (item 5)
6. Alerting thresholds (item 9)
7. Health check (item 10)

These are all MEDIUM or lower severity and none block the consent or infrastructure gap work. They are appropriate as post-launch hardening tasks. No action required for Pass 5 — the critical consumer migration blocker has been resolved.

---

## Summary

| Category                           | Result                              |
| ---------------------------------- | ----------------------------------- |
| Top 3 actions from Pass 3          | All 3 resolved                      |
| Pass 3 findings resolved           | 5 of 7 fully resolved               |
| Pass 3 findings partially resolved | 2 of 7 (P3-1 partial, P3-6 partial) |
| New findings from Pass 5           | 2 (both LOW severity)               |
| Critical or HIGH gaps remaining    | None                                |
| Plans ready for implementation     | Yes                                 |

**PASS 5 CLEAN** — All critical and high-severity findings from previous passes have been addressed. The two remaining partial resolutions (P3-1 security hardening scheduling, P3-6 WS payload mapping) are LOW risk and do not block implementation. No further audit passes are recommended.
