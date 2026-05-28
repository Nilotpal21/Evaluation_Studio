# LLD Log — AWS Bedrock Provider Integration (ABLP-674)

**Phase**: LLD
**Date**: 2026-04-28
**Artifact**: `docs/plans/2026-04-28-aws-bedrock-provider-impl-plan.md`
**Commit**: `e604d5915`

---

## Oracle Decisions

| #       | Question                                     | Classification      | Decision                                                                                                                                               |
| ------- | -------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase A | Factory implementation approach              | DECIDED             | Static import for `createAmazonBedrock`; module-level await for `_fromNodeProviderChain` (matches existing `ai/test` pattern)                          |
| Phase B | `buildProviderCacheKey()` signature          | DECIDED             | 5 params: `(providerType, apiKeyHash, effectiveUrl, modelId, authConfig?)`; pure function in `provider-cache.ts`                                       |
| Phase B | `parseJsonField` return type                 | DECIDED             | `(val: unknown): any` — input narrowed from `any` to `unknown`, return type preserved as `any` to avoid 4+ call-site breakage in `model-resolution.ts` |
| Phase C | `authConfig` extraction in model-resolver.ts | DECIDED             | Read `credential.authConfig` directly after decryption (post-find hook), then `parseJsonField()` — matches `model-resolution.ts:1522` pattern          |
| Phase D | i18n for IAM role strings                    | DECIDED (D-5, D-5a) | Hardcoded English — consistent with existing Bedrock label pattern. Post-impl-sync removes `packages/i18n` from feature spec §7, §10, §13 and HLD §4.  |
| Phase D | Cancel button reset consolidation            | DECIDED             | Consolidate inline Cancel onClick to call `reset()` — prevents `newCredBedrockMode` state drift on reopened dialog                                     |

## Audit Rounds

### Round 1 (lld-reviewer) — NEEDS_CHANGES → FIXED

CRITICAL:

- `buildProviderCacheKey()` appended `::` trailing fields to Azure keys — fixed: conditional append only when `region || amb` is truthy

HIGH:

- `ValidationException` fell through to generic handler, leaking model IDs/regions in user-visible messages — fixed: added explicit handler mapping to sanitized string

MEDIUM:

- Phase D commit table listed `packages/i18n` (contradicting Decision D-5) — fixed: removed
- Phase A.5 placement said "between litellm and default" but `mock` sits between them — fixed: "after 'mock' case, before default:"

### Round 2 (lld-reviewer) — NEEDS_CHANGES → FIXED

MEDIUM:

- `parseJsonField(val: unknown): unknown` would break 4+ typed call sites in `model-resolution.ts` — fixed: return type changed to `any`

LOW:

- Cache key ordering: new formula puts `authSuffix` before `apiSuffix` (original was reversed) — acknowledged as intentional ordering change in LLD prose; zero runtime impact (process-local ephemeral cache)

### Round 3 (lld-reviewer) — APPROVED with MEDIUM fix

MEDIUM:

- Playwright exit criterion had silent-skip escape hatch — tightened to "5/5 pass or explicit `test.skip()` calls"

### Round 4 (phase-auditor) — APPROVED with HIGH fixes

HIGH:

- i18n deviation not documented — fixed: added Decision D-5a with explicit deviation note and post-impl-sync action
- FR-4 acceptance criterion falsely claimed E2E-1 verifies streaming — fixed: split into FR-4a (tool calling, covered by E2E-5) and FR-4b (streaming, deferred to post-BETA per test spec §11 Q2)

### Round 5 (lld-reviewer) — APPROVED with MEDIUM fix

MEDIUM:

- Cancel button inline onClick doesn't go through `reset()` → `newCredBedrockMode` not reset — fixed: added Phase D task D.7 to consolidate Cancel handler through `reset()`

## Phase Summary

| Phase | Package(s)   | Key Changes                                                                                                        |
| ----- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| A     | packages/llm | `case 'bedrock'`, `BedrockAuthConfig`, both credential paths, 6 unit tests                                         |
| B     | apps/runtime | `buildProviderCacheKey()`, `classify-llm-error.ts` Bedrock patterns, `utils.ts`, `session-llm-client.ts` cache key |
| C     | apps/runtime | `model-resolver.ts` authConfig passthrough (6th arg fix)                                                           |
| D     | apps/studio  | IAM role toggle UI, Cancel handler consolidation                                                                   |
| E     | apps/runtime | nock dep, MANAGED_ENV_KEYS, route schema, 6+6+5 test files                                                         |
| F     | docs         | `docs/guides/llm-providers/aws-bedrock.md`                                                                         |

## Post-impl-sync Actions

1. Feature spec: correct provider cache TTL references (5s → 30 min) at lines 296, 312, 322
2. Feature spec: remove `packages/i18n` from §7, §10, §13
3. HLD: update `parseJsonField` interface signature from `unknown` → `any` return type
4. HLD: remove `packages/i18n` from §4 Component Diagram
