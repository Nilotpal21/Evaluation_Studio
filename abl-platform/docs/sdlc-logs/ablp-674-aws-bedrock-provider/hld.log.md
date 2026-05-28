# HLD Log — AWS Bedrock Provider Integration (ABLP-674)

**Phase**: HLD
**Date**: 2026-04-28
**Artifact**: `docs/specs/aws-bedrock-provider.hld.md`
**Commit**: `becc8aaaf`

---

## Oracle Decisions

| #   | Question                                                                    | Classification | Decision                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Actual provider cache TTL (feature spec says "5 seconds", code says 30 min) | ANSWERED       | 30 minutes (`DEFAULT_PROVIDER_CACHE_TTL_MS = 30 * 60 * 1000`, `config/index.ts:191` default 1800s). Feature spec lines 296, 312, 322 are wrong. HLD uses 30 min throughout. Feature spec corrected in post-impl-sync.                                      |
| Q2  | Does `fromNodeProviderChain()` re-resolve credentials on every call?        | INFERRED       | Two caching layers: (1) 30-min provider cache for LanguageModel instance; (2) AWS SDK internal expiry-based refresh for credentials. SDK handles rotation transparently. 30-min cache is safe for IRSA. Verify against installed SDK types in LLD Phase A. |
| Q3  | AddConnectionDialog.tsx exact Bedrock state variable names                  | ANSWERED       | `newCredAwsRegion` (default 'us-east-1'), `newCredAwsAccessKeyId`, `newCredAwsSecretKey`, `newCredAwsSessionToken`. Lines 129-132.                                                                                                                         |
| Q4  | AddConnectionDialog reset() function                                        | ANSWERED       | Exists at line 163. Resets all 20 form state vars including the 4 AWS fields. New `newCredBedrockMode` must be added with default `'explicit'`.                                                                                                            |
| Q5  | Any vendor-specific SDK calls in runtime execution path?                    | ANSWERED       | None — all 15 providers (19 case labels) in `provider-factory.ts` use Vercel AI SDK. Direct SDK usage only in non-runtime tooling (nl-parser, helix).                                                                                                      |
| Q6  | `@aws-sdk/credential-providers` version                                     | DECIDED        | `^3.998.0` — matches highest existing `@aws-sdk/*` pin (`@aws-sdk/client-lambda@^3.998.0` in `apps/runtime`).                                                                                                                                              |
| Q7  | `parseJsonField()` location                                                 | DECIDED        | Private function in `model-resolution.ts:282`. Extract to `apps/runtime/src/services/llm/utils.ts` for shared use (avoids duplication in `model-resolver.ts`).                                                                                             |
| Q8  | `model-resolver.ts` LLMCredential decryption                                | ANSWERED       | No `.lean()` used (comment at line 99-101). `encryptionPlugin` post-find hook fires and decrypts `authConfig`. Read `credential.authConfig` directly then apply `parseJsonField()`. Same pattern as `model-resolution.ts:331`.                             |

## Architecture Decisions

| Decision                             | Rationale                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Option A: Vercel AI SDK native       | Consistent with all 15 existing providers; SDK provides streaming, tool calling, IRSA extension point. Options B (direct HTTP) and C (LiteLLM proxy) both rejected. |
| 30-minute provider cache TTL         | Default and configured value is 30 min. AWS SDK handles IRSA refresh internally. No platform change needed.                                                         |
| `buildProviderCacheKey()` extraction | Phase C must export this as a pure function from `provider-cache.ts` for testability (per CLAUDE.md).                                                               |
| `parseJsonField()` to `utils.ts`     | Avoid duplication between `model-resolution.ts` and `model-resolver.ts`.                                                                                            |
| `classify-llm-error.ts` extension    | Must add Bedrock-specific error code handling in Phase A. File confirmed to have no Bedrock handling today.                                                         |

## Audit Rounds

### Round 1 — APPROVED (3 MEDIUM findings fixed)

- Named `classify-llm-error.ts` in Error Model concern
- Fixed "15 provider cases" → "15 providers (19 case labels)"
- Fixed self-referential Q2 Open Question pointer

### Round 2 — APPROVED (1 MEDIUM finding addressed)

- Added FR-to-design-decision traceability table to §2

### Round 3 — APPROVED (1 optional MEDIUM)

- FR-3 traceability anchor refined: removed "§8 Encryption", replaced with "§5 Concern #3 (API Contract)"

## Feature Spec Corrections (deferred to post-impl-sync)

| #   | Location              | Issue                                  | Correct Value                                                |
| --- | --------------------- | -------------------------------------- | ------------------------------------------------------------ |
| C-1 | Feature spec line 296 | "Short provider cache TTL (5 seconds)" | 30 minutes (1800s default, `LLM_PROVIDER_CACHE_TTL_SECONDS`) |
| C-2 | Feature spec line 312 | "5s ensures IRSA credential rotation"  | IRSA rotation handled by AWS SDK internally                  |
| C-3 | Feature spec line 322 | "Short provider cache TTL (5s)"        | 30 minutes                                                   |
