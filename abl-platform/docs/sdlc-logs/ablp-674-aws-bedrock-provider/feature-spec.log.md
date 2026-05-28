# Feature Spec Log — AWS Bedrock Provider Integration (ABLP-674)

**Phase**: Feature Spec
**Date**: 2026-04-28
**Artifact**: `docs/features/sub-features/aws-bedrock-provider.md`

---

## Oracle Decisions

| #   | Question                                             | Classification | Decision                                                                                                                                                         |
| --- | ---------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-2 | SearchAI pipeline authConfig passthrough in scope?   | DECIDED        | Yes — `model-resolver.ts:142` is a 1-line fix; leaving it out creates silent runtime failure for pipeline Bedrock models                                         |
| D-3 | Ambient credential approach for IRSA                 | DECIDED        | Use `credentialProvider` + `fromNodeProviderChain()` — `aws4fetch` (used by `@ai-sdk/amazon-bedrock`) cannot resolve IRSA web identity tokens via env vars alone |
| D-4 | Provider cache key for Bedrock                       | DECIDED        | Extend `authSuffix` in `session-llm-client.ts` to include `region` + `useAmbientCredentials`                                                                     |
| D-6 | `encryptedApiKey` for ambient mode                   | DECIDED        | Sentinel placeholder `"__iam_role__"` — avoids schema change cascade through encryption plugin, resolution guards, and cache key logic                           |
| D-7 | `@aws-sdk/credential-providers` dependency           | DECIDED        | Add in Phase 2 — mandatory for IRSA/ECS Task Role/Instance Profile resolution                                                                                    |
| D-9 | `useAmbientCredentials` explicit flag vs auto-detect | DECIDED        | Explicit flag — auto-detect creates silent privilege escalation risk in multi-tenant deployments                                                                 |

## Oracle Escalations Resolved by User

| #   | Question                              | User Decision                |
| --- | ------------------------------------- | ---------------------------- |
| A-1 | Phase 1 only vs Phase 1+2 in ABLP-674 | Both Phase 1 + 2 in ABLP-674 |

## SDK Research Findings

- `@ai-sdk/amazon-bedrock@^4.0.0` is the correct version (4.x shares `@ai-sdk/provider@3.0.8` with project's `@ai-sdk/anthropic@3.0.47`; 3.x depends on `@ai-sdk/anthropic@2.0.x` which conflicts)
- SDK export: `createAmazonBedrock` with options `{ region, accessKeyId, secretAccessKey, sessionToken, credentialProvider }`
- `credentialProvider: () => PromiseLike<{ accessKeyId, secretAccessKey, sessionToken? }>` is the IRSA extension point
- `aws4fetch` (used internally by the SDK) cannot resolve IRSA web identity tokens — `fromNodeProviderChain()` from `@aws-sdk/credential-providers` is required for full credential chain support

## Files Created

- `docs/features/sub-features/aws-bedrock-provider.md` — feature spec
- `docs/testing/sub-features/aws-bedrock-provider.md` — testing guide placeholder
- `docs/sdlc-logs/ablp-674-aws-bedrock-provider/feature-spec.log.md` — this log

## Audit Round 1 — NEEDS_REVISION

Findings addressed:

- CRITICAL: Section 12 project isolation rewritten — TenantModel is tenant-scoped (no projectId); project access via RBAC at route layer
- HIGH: FR-7 updated with useResponsesApi=undefined 5th arg requirement
- HIGH: Section 7 SearchAI gap corrected from "1-line" to "3-5 lines + import" with accurate fix description
- HIGH: Phase D delivery tasks expanded with authConfig extraction subtask (4.2)
- HIGH: credentialProvider type verification source clarified (npm view, not locally installed)
- MEDIUM: E2E forward note added to testing notes
- MEDIUM: Local filesystem path removed from Section 18

## Audit Round 2 — APPROVED

Remaining HIGH findings fixed before commit:

- HIGH: docs/testing/README.md entry added (row 17a)
- HIGH: User-scoped Bedrock credentials addressed in Section 12 (out of scope for ABLP-674, dialog creates tenant-scoped only)

MEDIUM findings addressed:

- MEDIUM: REQ-3/REQ-4 references replaced with plain English
- MEDIUM: sanitizeError attribution updated to mention both runtime classifier and Studio display layer
- MEDIUM: Tool calling test scenario added (row 16 in Section 17 coverage matrix)
- MEDIUM: AWS_REGION env var precedence test scenario added (row 5a)
