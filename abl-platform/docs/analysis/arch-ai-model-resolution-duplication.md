# Arch AI Model Resolution — Duplication Analysis

**Date:** 2026-04-30
**Scope:** `apps/studio/src/lib/arch-llm.ts` vs runtime's shared model resolution stack
**Trigger:** "The AI model encountered an unexpected error" — same model works in runtime but not in Arch AI

---

## 1. Problem Statement

Arch AI maintains a **standalone 1,242-line model resolution module** (`apps/studio/src/lib/arch-llm.ts`) that reimplements credential decryption, provider creation, TenantModel connection selection, auth profile resolution, and Vercel AI SDK model construction — all capabilities that the runtime already provides through shared packages (`@agent-platform/llm`, `@agent-platform/database`, `@agent-platform/shared-auth-profile`) and its `ModelResolutionService`.

This parallel implementation has **diverged in at least 8 behavioral ways** from the runtime's resolution path, causing models that work correctly in runtime to fail silently in Arch AI. The generic fallback error message ("The AI model encountered an unexpected error. Please try again.") provides no diagnostic information because the turn engine discards the raw provider error before classification.

---

## 2. Identified Gaps

### Gap 1: `useResponsesApi` Hardcoded to `false`

|            | Runtime                                                  | Arch AI                                     |
| ---------- | -------------------------------------------------------- | ------------------------------------------- |
| **Source** | `TenantModel.useResponsesApi` from DB                    | Hardcoded `false` at `arch-llm.ts:1208`     |
| **Effect** | OpenAI models use `providerFactory(modelId)` when `true` | Always uses `providerFactory.chat(modelId)` |

**Impact:** OpenAI models that require or are configured for the Responses API will fail in Arch AI. The provider rejects the request, but the error doesn't match any known HTTP status pattern, so it falls into `MODEL_PROVIDER_UNKNOWN`.

**Files:**

- `apps/studio/src/lib/arch-llm.ts:1202-1208` — `resolveArchVercelModel` passes `false`
- `packages/llm/src/provider-factory.ts:96-102` — The `useResponsesApi` switch
- `apps/runtime/src/services/llm/session-llm-client.ts:269,631,804` — Runtime reads from config

### Gap 2: Missing `authConfig` Parameter

|                                 | Runtime                                                             | Arch AI                         |
| ------------------------------- | ------------------------------------------------------------------- | ------------------------------- |
| **`createVercelProvider` call** | 6 args including `authConfig`                                       | 5 args — no `authConfig`        |
| **Azure support**               | `resourceName`, `apiVersion`, `deploymentId` from authConfig        | No Azure-specific config passed |
| **Bedrock support**             | `region`, `accessKeyId`, `secretAccessKey`, `useAmbientCredentials` | No Bedrock config passed        |

**Impact:** Azure and Bedrock models cannot work in Arch AI. The provider factory throws when required config fields are missing, producing the generic "unexpected error."

**Files:**

- `apps/studio/src/lib/arch-llm.ts:1202` — 5-arg call to `createVercelProvider`
- `packages/llm/src/provider-factory.ts:119-327` — Azure/Bedrock cases require `authConfig`
- `apps/runtime/src/services/llm/session-llm-client.ts:876,1133` — Runtime passes `authConfig`

### Gap 3: Weaker Provider Inference

|                            | Runtime                                                                                                       | Arch AI                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Recognized providers**   | 19 patterns (anthropic, openai, google, cohere, mistral, deepseek, xai, perplexity, meta, nvidia, qwen, etc.) | 3 patterns (claude→anthropic, gpt/o1/o3→openai, gemini/google→google) |
| **Unknown model handling** | Returns `null` + logs warning                                                                                 | Returns `null` → defaults to `'anthropic'`                            |

**Impact:** Models from any provider not in the 3-pattern list (Cohere, Mistral, DeepSeek, xAI, etc.) are silently misrouted to Anthropic, causing authentication failures.

**Files:**

- `apps/studio/src/lib/arch-llm.ts:155-163` — 3-pattern inference
- `apps/runtime/src/services/llm/model-resolution.ts:212-241` — 19-pattern inference
- `apps/studio/src/lib/arch-llm.ts:167` — Silent fallback to `'anthropic'`

### Gap 4: No Tenant Credential Policy Enforcement

Runtime enforces `TenantLLMPolicy` rules (`user_first`, `user_only`, `org_first`, `org_only`) that control which credential source is used. Arch AI has zero awareness of this policy — it directly queries `LLMCredential` and `AuthProfile` without checking tenant-level authorization rules.

**Impact:** Arch AI may use credentials that the tenant's policy forbids, or fail to find credentials that the policy would have resolved through a different path.

**Files:**

- `apps/runtime/src/services/llm/model-resolution.ts:533-553,693-698` — Policy cache + enforcement
- `apps/studio/src/lib/arch-llm.ts` — No mention of `TenantLLMPolicy`

### Gap 5: No Budget Enforcement

Runtime calls `checkAndRecordBudget()` before every LLM call, reserving estimated tokens and reconciling actual usage afterward. Arch AI has no budget awareness.

**Impact:** Arch AI LLM calls are invisible to the tenant's budget tracking. Tenants with exhausted budgets can still make Arch AI calls, and cost attribution is incomplete.

**Files:**

- `apps/runtime/src/services/llm/budget-enforcement.ts:67` — Budget check
- `apps/runtime/src/services/llm/model-resolution.ts` — `budgetReservation` in `ResolvedModel`
- `apps/studio/src/lib/arch-llm.ts` — No budget code

### Gap 6: No Resolution Caching

Runtime maintains a `metadataCache` + `credentialCache` with TTL, eviction, max-size bounds, and singleflight dedup for concurrent cold starts. Arch AI re-resolves from MongoDB on every single turn.

**Impact:** Every Arch AI message triggers 1-3 DB queries (ArchWorkspaceConfig + TenantModel + LLMCredential) that could be cached. Under load, this creates unnecessary DB pressure and adds ~50-100ms latency per turn.

**Files:**

- `apps/runtime/src/services/llm/model-resolution.ts:391-412` — Cache infrastructure
- `apps/studio/src/lib/arch-llm.ts:961` — Raw `findOne` on every resolution

### Gap 7: Separate Legacy Model ID Map

`LEGACY_MODEL_MAP` at `arch-llm.ts:63-70` maps deprecated model IDs to current ones. This map only exists in Arch AI — runtime has no equivalent. The two systems will handle deprecated model IDs differently, and this map can only be updated by editing `arch-llm.ts` directly.

**Files:**

- `apps/studio/src/lib/arch-llm.ts:63-73` — Arch-only legacy map
- No corresponding map in `packages/compiler/src/platform/llm/model-registry.ts` or runtime

### Gap 8: Duplicate `jsonSchemaToZod` Implementation

The same recursive JSON Schema → Zod converter exists in three places:

1. `packages/llm/src/tool-adapters.ts:169` — **shared, exported**
2. `apps/studio/src/lib/arch-llm.ts:773` — private copy
3. `apps/runtime/src/services/llm/vercel-ai-adapters.ts:169` — private copy

**Impact:** Bug fixes or new schema type support (e.g., `oneOf`, `allOf`) must be applied to all three copies independently.

---

## 3. Root Cause

The Arch AI feature was built with its own LLM resolution stack rather than consuming the runtime's shared infrastructure. The likely reasons:

1. **Different config model** — Arch AI uses `ArchWorkspaceConfig` (tenant-level, one model for all operations) rather than runtime's project→agent→operation hierarchy. This is a legitimate domain difference in _configuration source_, but not in _credential resolution, provider creation, or decryption_.

2. **Studio runs in Next.js** — The Studio app is a Next.js server, not the Express runtime. The `ModelResolutionService` class is tightly coupled to the runtime's config system (`isConfigLoaded`, `getConfig`), repo layer (`llm-resolution-repo.ts`), and startup lifecycle. It couldn't be imported directly into Studio without refactoring.

3. **Evolutionary divergence** — The runtime's model resolution has been actively maintained (budget enforcement, credential policies, useResponsesApi, authConfig for Azure/Bedrock, 19-provider inference), while `arch-llm.ts` was written at a point in time and not kept in sync with these additions.

The core mistake is that **credential decryption, provider construction, and Vercel model creation** were conflated with **config source resolution**. The config source (where to look up which model to use) is legitimately different between Arch AI and runtime. But once you have a `{ provider, modelId, apiKey, baseUrl, authConfig, useResponsesApi }` tuple, the downstream path should be identical.

---

## 4. Proposed Solution

### 4.1 Extract a Shared LLM Client Factory (New: `packages/llm-resolution`)

Create a new shared package that encapsulates the **provider-agnostic credential-to-model pipeline** — everything downstream of "I know which model and credential to use."

**What moves into the shared package:**

| Capability                         | Current location                                      | Shared package export                                      |
| ---------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| Vercel model creation              | `@agent-platform/llm` `createVercelProvider()`        | Already shared — no change                                 |
| Provider inference from model ID   | `model-resolution.ts:212-241`                         | `inferProviderFromModelId()`                               |
| Legacy model ID normalization      | `arch-llm.ts:63-73`                                   | `normalizeModelId()` with a single canonical map           |
| JSON Schema → Zod                  | `packages/llm/src/tool-adapters.ts:169`               | `jsonSchemaToZod()` (already exported, just delete copies) |
| TenantModel credential decryption  | `arch-llm.ts:418-506`, `model-resolution.ts:1500+`    | `decryptTenantModelCredential(tenantModel, tenantId)`      |
| Auth profile credential resolution | `arch-llm.ts:205-268`, `auth-profile-resolver.ts:82+` | `resolveAuthProfileCredential(tenantId, authProfileId)`    |
| Active connection selection        | `arch-llm.ts:194-203`, `model-resolution.ts`          | `selectActiveConnection(connections)`                      |

**What stays in each consumer:**

| Consumer                             | Responsibility                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime `ModelResolutionService`** | 5-level resolution chain (deployment → agent IR → agent DB → project → tenant), per-operation model splitting, budget enforcement, credential policy, caching with TTL/eviction                                 |
| **Arch AI config resolver**          | Read `ArchWorkspaceConfig`, determine requested source (model_hub / direct_api_key / platform / auth_profile / auto), auto-fallback chain. Call shared package for credential decryption and model construction |

**Reasoning:** This splits the problem at the right seam. The _config lookup strategy_ (where to find which model to use) is genuinely different between runtime and Arch AI. The _credential handling and model construction_ (given a TenantModel ID, produce a usable LanguageModel) is identical and should have a single implementation.

### 4.2 Refactor `arch-llm.ts` to Consume Shared Package

After extraction, `arch-llm.ts` shrinks from ~1,242 lines to ~300-400 lines:

- **Keep:** `ArchWorkspaceConfig` lookup, resolution ordering (tenantModelId → authProfileId → platformCredits → directKey → auto), `ArchEffectiveResolution` type, the `resolveArchEffectiveResolution()` orchestrator
- **Delete:** `inferProviderFromModelId`, `normalizeProvider`, `isUsableSecret`, `selectActiveConnection`, `resolveArchAuthProfileCredentialTarget`, `attemptTenantModelTarget`, `attemptSpecificTenantModel`, `attemptAutoTenantModel`, `attemptAuthProfileTarget`, `attemptDirectApiKeyTarget`, `createArchProvider`, `createArchLLMClient`, `jsonSchemaToZod`, `convertToolsForVercel`, `LEGACY_MODEL_MAP`, `normalizeModelId`
- **Replace with:** Calls to the shared package functions

### 4.3 Fix the Immediate Error Visibility Gap

Independent of the refactor, add raw error logging before classification in the turn engine. Currently at `turn-engine.ts:1308`, `classifyModelError(err)` is called but `err` is never logged — the actual provider error (wrong model ID, missing auth, schema rejection) is silently discarded.

```
// Before classification, log the raw error for diagnostics
log.error('LLM stream error (pre-classification)', {
  error: err instanceof Error ? err.message : String(err),
  name: err instanceof Error ? err.name : undefined,
  status: (err as any)?.status,
  code: (err as any)?.code,
});
const classified = classifyModelError(err);
```

This is a 5-line fix that immediately unblocks debugging of the current "unexpected error" without waiting for the full refactor.

### 4.4 Pass Missing Parameters Through Existing Path

As a near-term fix (before the full shared package extraction), update `resolveArchVercelModel` to:

1. **Read `useResponsesApi`** from `TenantModel` when resolving via model_hub, instead of hardcoding `false`
2. **Read `authConfig`** from `TenantModel` or `LLMCredential` and pass it as the 6th arg to `createVercelProvider`
3. **Use runtime's `inferProviderFromModelId`** (import from `@agent-platform/llm` or copy the full 19-pattern version)

---

## 5. Impact Areas

### 5.1 Direct Bug Fixes (User-Facing)

| Issue                                                          | Users Affected                                              | Fix                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| OpenAI models failing in Arch AI when Responses API is enabled | Any tenant using OpenAI models with `useResponsesApi: true` | Read from TenantModel instead of hardcoding `false` |
| Azure/Bedrock models failing in Arch AI                        | Any tenant using Azure or Bedrock providers                 | Pass `authConfig` through to `createVercelProvider` |
| Non-standard provider models misrouted to Anthropic            | Any tenant using Cohere, Mistral, DeepSeek, xAI, etc.       | Use full 19-pattern provider inference              |
| Opaque "unexpected error" blocking diagnosis                   | All Arch AI users experiencing LLM failures                 | Log raw error before classification                 |

### 5.2 Compliance & Security

| Issue                             | Risk                                         | Fix                               |
| --------------------------------- | -------------------------------------------- | --------------------------------- |
| Tenant credential policy bypassed | Arch AI may use forbidden credential sources | Integrate `TenantLLMPolicy` check |
| No budget enforcement             | Cost attribution gap, budget overruns        | Add budget check/reservation      |

### 5.3 Operational

| Issue                      | Effect                                                                                                               | Fix                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| No resolution caching      | 1-3 extra DB queries per Arch AI turn                                                                                | Add TTL cache or reuse shared cache    |
| Duplicate code maintenance | Any runtime model resolution improvement (new provider, security fix, etc.) must be manually ported to `arch-llm.ts` | Single shared implementation           |
| Divergent legacy model map | Model deprecations handled inconsistently                                                                            | Single canonical map in shared package |

### 5.4 Files Requiring Changes

**Phase 1 — Immediate Fixes (unblocks debugging + fixes known broken paths):**

- `packages/arch-ai/src/engine/turn-engine.ts` — Add raw error logging at lines 960, 1308
- `apps/studio/src/lib/arch-llm.ts` — Read `useResponsesApi` from TenantModel, pass `authConfig`, expand provider inference

**Phase 2 — Shared Package Extraction:**

- New: `packages/llm-resolution/` — Shared credential + model construction
- Refactor: `apps/studio/src/lib/arch-llm.ts` — Consume shared package (~900 lines deleted)
- Refactor: `apps/runtime/src/services/llm/model-resolution.ts` — Consume shared package for credential/provider helpers
- Refactor: `apps/runtime/src/services/auth-profile-resolver.ts` — Move shared parts to package
- Delete: `apps/studio/src/lib/arch-llm.ts:773-813` — Remove duplicate `jsonSchemaToZod`
- Delete: `apps/runtime/src/services/llm/vercel-ai-adapters.ts:169+` — Remove duplicate `jsonSchemaToZod`

**Phase 3 — Policy & Budget Parity:**

- `apps/studio/src/lib/arch-llm.ts` — Integrate `TenantLLMPolicy` check
- `apps/studio/src/lib/arch-ai/engine-factory.ts` — Add budget reservation before LLM calls
- `packages/llm-resolution/` — Expose policy + budget helpers

---

## 6. Recommendation

**Start with Phase 1.** The raw error logging fix (5 lines) and the `useResponsesApi` / `authConfig` / provider inference fixes (~50 lines) immediately resolve the user-facing bug and unblock diagnosis of future issues. This can ship in a single PR.

Phase 2 (shared package extraction) should follow as a planned refactor. It prevents the divergence from recurring and eliminates ~900 lines of duplicated code. Phase 3 (policy + budget) can be prioritized based on whether tenants are actively using credential policies or budget limits with Arch AI.
