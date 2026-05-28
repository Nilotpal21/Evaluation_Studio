# agents.md — packages / llm

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-04-28 — ABLP-674 AWS Bedrock Provider Integration (feature-spec phase)

**Category**: architecture

**Learning**: `@ai-sdk/amazon-bedrock@^4.0.0` is correct (NOT `^3.0.x`). The 4.x branch shares `@ai-sdk/provider@3.0.8` with `@ai-sdk/anthropic@^3.0.47`; 3.x conflicts. Verify via `npm view @ai-sdk/<provider>@<version> dependencies` before adding any new AI SDK provider.
**Files**: `packages/llm/package.json`
**Impact**: When adding future AI SDK providers, check `@ai-sdk/provider` version matches the rest of the project.

**Category**: gotcha

**Learning**: `@ai-sdk/amazon-bedrock` uses `aws4fetch` internally — omitting explicit keys only falls back to `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars. It CANNOT resolve IRSA web identity tokens. For IRSA support, the `credentialProvider` callback option + `fromNodeProviderChain()` from `@aws-sdk/credential-providers` is mandatory.
**Files**: `packages/llm/src/provider-factory.ts`, `packages/llm/package.json`
**Impact**: Any future ambient-credential AWS service integration needs the same `credentialProvider` pattern.

**Category**: gotcha

**Learning**: The provider cache key in `session-llm-client.ts:840-843` only encodes Azure-specific `authConfig` fields. For any new provider with connection-specific routing (region, endpoint, datacenter), extend `authSuffix` — otherwise different connections to the same model ID will collide in the cache.
**Files**: `apps/runtime/src/services/llm/session-llm-client.ts` (downstream consumer of this package)
**Impact**: New providers with `authConfig` routing fields must audit the cache key construction.

## 2026-04-28 — ABLP-674 AWS Bedrock Provider Integration (HLD phase)

**Category**: architecture

**Learning**: `@aws-sdk/credential-providers@^3.998.0` is the correct version — matches the highest existing `@aws-sdk/*` pin in `apps/runtime/package.json` (`@aws-sdk/client-lambda@^3.998.0`). All AWS SDK v3 packages share the same `@smithy/*` core; matching the minor version prevents Smithy core duplication in the pnpm lockfile. This package should be added to `packages/llm/package.json` (not `apps/runtime`), since the credential resolution logic is inside `provider-factory.ts`.
**Files**: `packages/llm/package.json`, `apps/runtime/package.json`
**Impact**: Future AWS SDK v3 package additions should match the existing `^3.998.0` minor pin.

**Category**: gotcha

**Learning**: The provider cache TTL is **30 minutes** (configurable via `LLM_PROVIDER_CACHE_TTL_SECONDS`, default 1800s) — NOT 5 seconds as the feature spec claims. The spec was wrong. For IRSA credential rotation, the AWS SDK's internal expiry-based refresh handles this transparently within the provider instance lifetime. The 30-minute TTL is safe. For stricter security windows, set `LLM_PROVIDER_CACHE_TTL_SECONDS=300` in the deployment Helm values.
**Files**: `apps/runtime/src/services/llm/provider-cache.ts:18`, `apps/runtime/src/config/index.ts:191`
**Impact**: Feature specs and ops guides for all providers should reference 30-min TTL (or the env var). Never assume 5-second TTL.

**Category**: architecture

**Learning**: `classify-llm-error.ts` (`apps/runtime/src/services/llm/classify-llm-error.ts`) is the single LLM error classification file and must be extended for any new provider. For Bedrock, it needs: `AccessDeniedException` (403), `ValidationException` (400), `ThrottlingException` (429), `ResourceNotFoundException` (404), `ServiceUnavailableException` (503). The pattern is: match by AWS error code string in the error body, map to provider-specific user-visible message that does not leak region/model/credentials.
**Files**: `apps/runtime/src/services/llm/classify-llm-error.ts`
**Impact**: Every new LLM provider integration must include classify-llm-error.ts additions. Check this file before claiming "provider-specific error messages" are complete.

## 2026-04-28 — ABLP-674 AWS Bedrock Provider Integration (Phase A implementation)

**Category**: pattern

**Learning**: The `createAmazonBedrock` factory from `@ai-sdk/amazon-bedrock@4.0.96` accepts `AmazonBedrockProviderSettings` with these key fields: `region`, `accessKeyId`, `secretAccessKey`, `sessionToken`, `credentialProvider`, `apiKey`, `baseURL`. The `credentialProvider` type is `() => PromiseLike<{accessKeyId: string, secretAccessKey: string, sessionToken?: string}>`. Model creation (`providerFactory(modelId)`) is synchronous — credentials only resolve on actual `generateText`/`streamText` calls.
**Files**: `packages/llm/src/provider-factory.ts`, `node_modules/@ai-sdk/amazon-bedrock/dist/index.d.ts`
**Impact**: Tests can assert model object creation without needing real AWS credentials or network access.

**Category**: testing

**Learning**: This package had no test infrastructure before this change. Added `vitest.config.ts` (copied pattern from `packages/a2a/`), `"test": "vitest run --passWithNoTests"` script, and `vitest@^4.1.4` devDependency. Test files go in `src/__tests__/`. The `tsconfig.json` already excludes `**/*.test.ts` from build output.
**Files**: `packages/llm/vitest.config.ts`, `packages/llm/package.json`
**Impact**: Future tests can be added to `src/__tests__/` and will run via `pnpm test --filter=@agent-platform/llm`.

**Category**: gotcha

**Learning**: The SDK supports a third auth path via `apiKey` (Bearer token, env var `AWS_BEARER_TOKEN_BEDROCK`). Phase A does not implement this. Future phases should add it if Bedrock Gateway / API key auth is needed.
**Files**: `packages/llm/src/provider-factory.ts`
**Impact**: If a customer uses Bedrock API key auth instead of IAM, a new code path is needed.
