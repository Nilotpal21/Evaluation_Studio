# Test Specification: AWS Bedrock Provider Integration

**Feature Spec**: [`docs/features/sub-features/aws-bedrock-provider.md`](../../features/sub-features/aws-bedrock-provider.md)
**HLD**: [`docs/specs/aws-bedrock-provider.hld.md`](../../specs/aws-bedrock-provider.hld.md)
**LLD**: [`docs/plans/2026-04-28-aws-bedrock-provider-impl-plan.md`](../../plans/2026-04-28-aws-bedrock-provider-impl-plan.md)
**Status**: BETA
**Jira**: ABLP-674
**Last Updated**: 2026-04-28

---

## 1. Current State

Bedrock provider integration is implemented (ALPHA). `case 'bedrock'` exists in `provider-factory.ts`, `@ai-sdk/amazon-bedrock` and `@aws-sdk/credential-providers` are installed, `buildProviderCacheKey()` encodes region + credential mode, `model-resolver.ts` passes `authConfig`, and `classify-llm-error.ts` handles Bedrock error patterns. Test files: `provider-factory.test.ts` (6 unit, all passing), `bedrock-integration.test.ts` (8 tests: 7 passing + 1 `it.todo` for INT-1), `bedrock-e2e.test.ts` (5 tests: all 5 passing — E2E-1 and E2E-3 are now real tests using `startRuntimeServerHarness` + nock), `classify-llm-error.test.ts` (24 tests, all passing — includes 2 regression guards for non-Bedrock 404 mis-classification). Playwright PLY-1 through PLY-5 are `test.fixme` stubs. `ModelsPage.tsx` now has the IAM role toggle (parity with `AddConnectionDialog.tsx`).

### Implementation Prerequisites (must land before tests can pass)

The following gaps must be resolved as part of the LLD / early implementation before the test scenarios below can run:

| #   | Gap                                                                                                                                                                  | Required For                                                 | Status                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| P-1 | Add `nock@^14` to `apps/runtime/package.json` devDependencies                                                                                                        | All automated E2E + integration tests that mock Bedrock HTTP | DONE                                                                             |
| P-2 | Extend `MANAGED_ENV_KEYS` in `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts` with `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`             | E2E tests that inject AWS env vars into the harness          | DONE                                                                             |
| P-3 | Extend `provisionTenantModel` helper (or add new seeding helper) to accept `authConfig` in the `connection` object; update the provisioning route schema accordingly | E2E tests that seed Bedrock credentials via HTTP API         | DONE                                                                             |
| P-4 | Implement `case 'bedrock'` in `provider-factory.ts` (Phases A+B)                                                                                                     | All test scenarios                                           | DONE                                                                             |
| P-5 | Fix `authSuffix` in `session-llm-client.ts` (Phase C)                                                                                                                | INT-3, INT-4                                                 | DONE                                                                             |
| P-6 | Fix `model-resolver.ts` authConfig passthrough (Phase D)                                                                                                             | INT-5, INT-6                                                 | DONE                                                                             |
| P-7 | Add Studio UI IAM role toggle (Phase E)                                                                                                                              | PLY-1 through PLY-5                                          | DONE (UI implemented; Playwright tests are test.fixme stubs pending live Studio) |

---

## 2. Coverage Matrix

| FR    | Description                                                           | Unit | Integration | E2E (Auto) | E2E (Studio) | Manual | Status                                                                                                                       |
| ----- | --------------------------------------------------------------------- | ---- | ----------- | ---------- | ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | Bedrock execution with explicit AWS credentials                       | ✓    | ✓           | ✓          |              | ✓      | PASSING — E2E-1 full chat roundtrip                                                                                          |
| FR-2  | Bedrock execution with IAM role / IRSA ambient credentials            | ✓    | ✓           | ✓          |              | ✓      | PARTIAL — unit passing; E2E ambient chat roundtrip pending (ambient E2E requires real IRSA or env-var simulation in harness) |
| FR-3  | Studio UI credential mode toggle renders and submits correctly        |      |             |            | ✓            | ✓      | PENDING — PLY test.fixme stubs                                                                                               |
| FR-4a | Tool calling parity (structured tool_use ↔ tool result round-trip)    |      | ✓           | ✓          |              |        | NOT TESTED                                                                                                                   |
| FR-4b | Streaming responses parity (converse-stream eventstream format)       |      |             |            |              | ✓      | DEFERRED — requires eventstream mock                                                                                         |
| FR-5  | Provider-specific error messages (no OpenAI fallback)                 | ✓    | ✓           | ✓          |              |        | PASSING — unit (4 Bedrock patterns + regression guards), integration (INT-6), E2E-3                                          |
| FR-6  | Provider cache key differentiation by region + credential mode        |      | ✓           |            |              |        | PASSING — integration tests                                                                                                  |
| FR-7  | SearchAI pipeline model-resolver passes authConfig                    |      | ✓           |            |              |        | PASSING — integration test                                                                                                   |
| FR-8  | Region defaults to AWS_REGION env var then us-east-1                  | ✓    |             |            |              |        | PASSING — unit test                                                                                                          |
| FR-8a | AWS_REGION env var precedence (middle-path: authConfig.region absent) | ✓    |             |            |              |        | PASSING — unit test                                                                                                          |

---

## 3. E2E Test Scenarios (Automated)

**Infrastructure**: `startRuntimeServerHarness()` + `bootstrapProject()` + `nock@^14` for Bedrock HTTP interception.

**Bedrock HTTP interception approach**: `@ai-sdk/amazon-bedrock` uses `aws4fetch` (a standalone `fetch()`-based AWS Signature V4 signer). `nock@^14` patches Node's global `fetch`, which intercepts these calls. The Bedrock Converse API endpoint pattern is:

- Non-streaming: `POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse`
- Streaming: `POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse-stream`

**Minimal nock Bedrock converse response**:

```json
{
  "output": { "message": { "role": "assistant", "content": [{ "text": "Hello from Bedrock." }] } },
  "usage": { "inputTokens": 8, "outputTokens": 6 },
  "stopReason": "end_turn"
}
```

**Credential seeding**: All E2E tests use a new `provisionBedrockCredential(harness, adminToken, { region, mode, accessKeyId?, secretAccessKey? })` helper (to be implemented in `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts`). This helper calls `POST /api/platform/admin/tenant-models` with the extended `connection.authConfig` field (prerequisite P-3).

---

### E2E-1: Explicit-credentials Bedrock connection — chat returns response

- **File**: `apps/runtime/src/__tests__/bedrock-e2e.test.ts`
- **FR**: FR-1, FR-5
- **Auth Context**: tenant admin (`bootstrapProject`), project-scoped session
- **Preconditions**:
  1. Runtime server started (`startRuntimeServerHarness`)
  2. Tenant + project bootstrapped (`bootstrapProject`)
  3. `nock('https://bedrock-runtime.us-east-1.amazonaws.com').post('/model/anthropic.claude-sonnet-4-6-v1:0/converse').reply(200, <canned response>)`
- **Steps**:
  1. `POST /api/platform/admin/tenant-models` → provision Bedrock TenantModel + explicit credential (`authConfig: { region: 'us-east-1', accessKeyId: 'AKIATEST', secretAccessKey: 'secret' }`)
  2. `POST /api/projects/:projectId/agents` → create agent using the Bedrock model
  3. `POST /api/sessions` → create session with the agent
  4. `POST /api/sessions/:sessionId/chat` with `{ messages: [{ role: 'user', content: 'Say hello' }] }`
  5. Assert response: `200`, `body.text` is truthy
- **Expected Result**: `200` response with non-empty `text` field. Response does not contain "OpenAI API error". nock interceptor was called exactly once.
- **Isolation Check**: Repeat step 4 with a token from a different tenant → `404`
- **Teardown**: `nock.cleanAll()`

---

### E2E-2: Ambient (IAM role) connection — no AWS keys in DB, chat succeeds

- **File**: `apps/runtime/src/__tests__/bedrock-e2e.test.ts`
- **FR**: FR-2
- **Auth Context**: tenant admin, project-scoped session
- **Preconditions**:
  1. Runtime server started
  2. `nock('https://bedrock-runtime.us-west-2.amazonaws.com').post('/model/anthropic.claude-sonnet-4-6-v1:0/converse').reply(200, <canned response>)`
  3. AWS env vars injected via harness `envOverrides: { AWS_REGION: 'us-west-2', AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'fakesecret' }` (simulates ambient pod environment; requires P-2)
- **Steps**:
  1. `POST /api/platform/admin/tenant-models` → provision Bedrock TenantModel with ambient credential (`apiKey: '__iam_role__'`, `authConfig: { region: 'us-west-2', useAmbientCredentials: true }`)
  2. `GET /api/platform/admin/tenant-credentials/:credentialId` → retrieve the stored credential
  3. Assert API response body: `authConfig.useAmbientCredentials === true`, `authConfig.region === 'us-west-2'`, response `authConfig` object has no `accessKeyId` or `secretAccessKey` fields. (Decryption-at-rest verification — confirming the sentinel `"__iam_role__"` is stored in `encryptedApiKey` — is covered by INT-1 in the integration test file where direct DB inspection is permitted.)
  4. Create agent + session + send chat message (same as E2E-1 steps 2-4)
  5. Assert: `200` response with non-empty `text`
- **Expected Result**: Chat succeeds. API credential response contains no AWS key fields. nock interceptor was called.
- **Isolation Check**: Cross-tenant access to the credential → `404`

---

### E2E-3: Bedrock error surfaces as provider-specific message

- **File**: `apps/runtime/src/__tests__/bedrock-e2e.test.ts`
- **FR**: FR-5
- **Auth Context**: tenant admin, project-scoped session
- **Preconditions**:
  1. Runtime server started
  2. `nock('https://bedrock-runtime.us-east-1.amazonaws.com').post('/model/anthropic.claude-sonnet-4-6-v1:0/converse').reply(401, { message: 'The security token included in the request is invalid.' })`
- **Steps**:
  1. Provision Bedrock TenantModel + explicit credential (same as E2E-1 step 1)
  2. Create agent + session
  3. `POST /api/sessions/:sessionId/chat` with a user message
  4. Capture the error response
- **Expected Result**: Response is an error (non-200 or error body). Error message does NOT contain "OpenAI API error". Error message DOES contain "Bedrock" or "AWS" or a provider-specific indicator. nock interceptor was called.
- **Notes**: The exact error surfacing path depends on the runtime error classifier implementation (Phase A). The test validates FR-5 end-to-end.

---

### E2E-4: Cross-tenant Bedrock credential isolation

- **File**: `apps/runtime/src/__tests__/bedrock-e2e.test.ts`
- **FR**: FR-1 (isolation variant)
- **Auth Context**: Two separate tenants (Tenant A, Tenant B)
- **Preconditions**:
  1. Runtime server started
  2. `bootstrapProject()` called twice for two distinct tenants
  3. nock intercepts Bedrock for Tenant A's region
- **Steps**:
  1. Tenant A: Provision Bedrock TenantModel + explicit credential → get `credentialId`
  2. Tenant B: Attempt `GET /api/platform/admin/tenant-credentials/<credentialId from step 1>` using Tenant B's token
  3. Tenant B: Attempt to create a session using a model wired to Tenant A's credential
- **Expected Result**: All cross-tenant requests return `404`. The credential's `tenantId` field prevents access.
- **Isolation Check**: This IS the isolation test. Response must be `404`, not `403` (no existence leak per CLAUDE.md).

---

### E2E-5: Tool calling with Bedrock model returns structured tool result

- **File**: `apps/runtime/src/__tests__/bedrock-e2e.test.ts`
- **FR**: FR-4a
- **Auth Context**: tenant admin, project-scoped session
- **Preconditions**:
  1. Runtime server started
  2. nock intercepts `POST /model/anthropic.claude-sonnet-4-6-v1:0/converse` and returns a tool_use response:
     ```json
     {
       "output": {
         "message": {
           "role": "assistant",
           "content": [
             {
               "toolUse": {
                 "toolUseId": "tool-1",
                 "name": "get_weather",
                 "input": { "location": "Seattle" }
               }
             }
           ]
         }
       },
       "usage": { "inputTokens": 15, "outputTokens": 8 },
       "stopReason": "tool_use"
     }
     ```
  3. Second nock interceptor for the follow-up converse call (after tool execution) returns normal text response
- **Steps**:
  1. Provision Bedrock TenantModel + explicit credential (us-east-1)
  2. Create agent with a `get_weather` tool definition (`parameters: { location: { type: 'string' } }`)
  3. Create session + send chat message: "What's the weather in Seattle?"
  4. Assert `200` response. Retrieve trace events via `GET /api/projects/:projectId/sessions/:sessionId/traces`; assert one event has `eventType` indicating a tool call, `name: 'get_weather'`, `input: { location: 'Seattle' }`. Response body from the chat endpoint contains the tool result rendered as text.
- **Expected Result**: Tool calling flows through the Bedrock provider without error. The AI SDK translates Bedrock's `toolUse` content block into a Vercel AI SDK tool call correctly. Trace events are visible via HTTP API (no direct DB access).

---

### E2E-6: Same model, different regions — correct regional endpoint called

- **File**: `apps/runtime/src/__tests__/bedrock-e2e.test.ts`
- **FR**: FR-6, FR-8
- **Auth Context**: tenant admin, two separate sessions
- **Preconditions**:
  1. Runtime server started
  2. Two nock interceptors:
     - `nock('https://bedrock-runtime.us-east-1.amazonaws.com').post('/model/anthropic.claude-sonnet-4-6-v1:0/converse').reply(200, { ...text: 'region:us-east-1'... })`
     - `nock('https://bedrock-runtime.us-west-2.amazonaws.com').post('/model/anthropic.claude-sonnet-4-6-v1:0/converse').reply(200, { ...text: 'region:us-west-2'... })`
- **Steps**:
  1. Provision Bedrock TenantModel with explicit credential A (`region: 'us-east-1'`)
  2. Provision same TenantModel with explicit credential B (`region: 'us-west-2'`)
  3. Create agent A wired to credential A; create agent B wired to credential B
  4. Send chat via session using agent A → assert response uses us-east-1 nock interceptor (nock count: `us-east-1` = 1, `us-west-2` = 0)
  5. Send chat via session using agent B → assert response uses us-west-2 nock interceptor (both counts = 1)
- **Expected Result**: Each session routes to the correct regional Bedrock endpoint. Neither nock interceptor is called for the wrong region.

---

## 4. Integration Test Scenarios

**Infrastructure**: MongoMemoryServer (via `setupTestMongo()` from `apps/runtime/src/__tests__/helpers/setup-mongo.ts`), tenant encryption initialized (`initializeRuntimeTestEncryption()`), direct `LLMCredential.create()` + `TenantModel` seeding. No mocking of `ModelResolutionService`, `SessionLLMClient`, or `createVercelProvider`. Only external Bedrock HTTP is intercepted via nock.

---

### INT-1: ModelResolutionService.resolve() returns Bedrock authConfig fields

- **File**: `apps/runtime/src/__tests__/bedrock-integration.test.ts`
- **Boundary**: `ModelResolutionService` → MongoDB (LLMCredential decryption)
- **Setup**:
  1. Start MongoMemoryServer + init encryption with test master key
  2. Create `LLMCredential` via `LLMCredential.create({ tenantId, authType: 'aws_iam', encryptedApiKey: 'AKIATEST', authConfig: { region: 'us-east-1', accessKeyId: 'AKIATEST', secretAccessKey: 'secretvalue' }, ... })`
  3. Create `TenantModel` linked to above credential via `TenantModelConnection`
- **Steps**:
  1. Instantiate real `ModelResolutionService`
  2. Call `resolve({ tenantId, projectId, userId, modelId, agentIR })`
- **Expected Result**: Resolved object has `provider === 'bedrock'`, `authConfig.accessKeyId === 'AKIATEST'`, `authConfig.secretAccessKey === 'secretvalue'`, `authConfig.region === 'us-east-1'`. `apiKey` is the decrypted `encryptedApiKey`.
- **Failure Mode**: If `LLMCredential` is missing, `resolve()` throws `CredentialNotFoundError`; if decryption fails, throws `DecryptionError`.

---

### INT-2: Bedrock explicit-credentials LanguageModel executes a real HTTP call to the Bedrock API

- **File**: `apps/runtime/src/__tests__/bedrock-integration.test.ts`
- **Boundary**: `createVercelProvider('bedrock', ...)` → `@ai-sdk/amazon-bedrock` SDK → nock-intercepted Bedrock HTTP
- **Setup**:
  1. `nock('https://bedrock-runtime.us-east-1.amazonaws.com').post('/model/anthropic.claude-sonnet-4-6-v1:0/converse').reply(200, <canned Bedrock converse response>)`
- **Steps**:
  1. Call `createVercelProvider('bedrock', 'AKIATEST', undefined, 'anthropic.claude-sonnet-4-6-v1:0', undefined, { region: 'us-east-1', accessKeyId: 'AKIATEST', secretAccessKey: 'secretvalue' })` → get `languageModel`
  2. Call `generateText({ model: languageModel, messages: [{ role: 'user', content: 'Say hi' }] })`
- **Expected Result**: `generateText()` resolves without error. `result.text` is non-empty. The nock interceptor for `us-east-1` was called exactly once. The Bedrock request includes an `Authorization` header with `AWS4-HMAC-SHA256` signature (AWS SigV4 — indicating the SDK signed the request with the provided keys).
- **Failure Mode**: If `accessKeyId` is present but `secretAccessKey` is absent, the factory throws before the SDK call; nock interceptor is never reached.

---

### INT-3: Provider cache key differentiates by region — two Bedrock connections, same model

- **File**: `apps/runtime/src/__tests__/bedrock-integration.test.ts`
- **Boundary**: `buildProviderCacheKey()` pure function in `provider-cache.ts` (LLD Phase C must extract this function as an exported pure function)
- **Setup**:
  1. MongoMemoryServer + encryption + two seeded Bedrock `LLMCredential` records: same `modelId`, same `apiKey`, but `authConfig.region` differs (`us-east-1` vs `us-west-2`)
  2. Resolve both credentials via real `ModelResolutionService` to get the resolved `authConfig` objects
- **Steps**:
  1. Call `buildProviderCacheKey('bedrock', hashedApiKey, undefined, 'anthropic.claude-sonnet-4-6-v1:0', resolvedAuthConfigA)` → `keyA`
  2. Call `buildProviderCacheKey('bedrock', hashedApiKey, undefined, 'anthropic.claude-sonnet-4-6-v1:0', resolvedAuthConfigB)` → `keyB`
  3. Assert `keyA !== keyB`
  4. Call `clearProviderCache()`; trigger two real chat calls (nock intercepts both regions); assert `getCachedProvider(keyA)` and `getCachedProvider(keyB)` are distinct non-null instances
- **Expected Result**: Keys differ (`region` is encoded in the `authSuffix`). Both cache entries populated after the chat calls. Provider instances are distinct objects.
- **Failure Mode** (pre-fix): Without the Phase C `authSuffix` extension, `keyA === keyB` → this assertion fails immediately. The pure function test is the regression guard.
- **LLD Requirement**: Phase C must export `buildProviderCacheKey()` from `provider-cache.ts`. Per CLAUDE.md "fix the code, not the test" principle: extracting a testable pure function is the architecturally correct design, not a test workaround.

---

### INT-4: Provider cache key differentiates explicit vs ambient mode in the same region

- **File**: `apps/runtime/src/__tests__/bedrock-integration.test.ts`
- **Boundary**: `buildProviderCacheKey()` pure function in `provider-cache.ts`
- **Setup**: Two resolved authConfig objects for the same `modelId` + `region: 'us-east-1'`: one explicit (`{ accessKeyId: 'AKIA...', secretAccessKey: '...', region: 'us-east-1' }`), one ambient (`{ useAmbientCredentials: true, region: 'us-east-1' }`)
- **Steps**:
  1. `buildProviderCacheKey('bedrock', hashedApiKeyExplicit, undefined, modelId, explicitAuthConfig)` → `keyExplicit`
  2. `buildProviderCacheKey('bedrock', hashedApiKeySentinel, undefined, modelId, ambientAuthConfig)` → `keyAmbient`
  3. Assert `keyExplicit !== keyAmbient`
- **Expected Result**: The sentinel `"__iam_role__"` in `apiKey` hash combined with `useAmbientCredentials: true` in `authSuffix` produces a different key from the explicit credential path. No cache collision possible between explicit and ambient mode for the same model+region.
- **LLD Requirement**: Same as INT-3 — `buildProviderCacheKey()` must be an exported pure function.

---

### INT-5: resolvePipelineModel() with Bedrock TenantModel passes authConfig to provider factory

- **File**: `apps/runtime/src/__tests__/bedrock-integration.test.ts`
- **Boundary**: `model-resolver.ts: resolvePipelineModel()` → `createVercelProvider()`
- **Setup**:
  1. MongoMemoryServer + encryption
  2. Seed Bedrock `TenantModel` + `LLMCredential` with `authConfig: { region: 'us-west-2', accessKeyId: 'AKIATEST', secretAccessKey: 'secretvalue' }`
- **Steps**:
  1. Call `resolvePipelineModel({ modelSource: 'tenant', tenantModelId: '<id>' }, { tenantId: '<id>' })`
- **Expected Result**: Returns a non-null `LanguageModel` (indicating `createVercelProvider('bedrock', ...)` was called successfully with the full `authConfig`). If `authConfig` was not passed, the factory would throw a "missing credentials" error, which would propagate out and fail this test.
- **Failure Mode**: Pre-fix (Phase D not applied) → `createVercelProvider('bedrock', apiKey, url, modelId)` called without `authConfig` → factory throws "no credentials provided" error.

---

### INT-6: resolvePipelineModel() Bedrock error is provider-specific (not OpenAI fallback)

- **File**: `apps/runtime/src/__tests__/bedrock-integration.test.ts`
- **Boundary**: `model-resolver.ts` → `createVercelProvider()` → nock-mocked Bedrock HTTP
- **Setup**:
  1. Same as INT-5 setup
  2. nock intercepts the Bedrock converse endpoint and returns `401`
- **Steps**:
  1. Resolve pipeline model → get `LanguageModel`
  2. Attempt a `generateText()` call using the returned model
  3. Capture the thrown error
- **Expected Result**: Error message contains "Bedrock" or "AWS". Does not contain "OpenAI API error". `@ai-sdk/amazon-bedrock` throws a provider-specific error on `401`.

---

## 5. Unit Test Scenarios

**File**: `packages/llm/src/__tests__/provider-factory.test.ts`

Tests `createVercelProvider('bedrock', ...)` as a pure black-box function. No mocking of `@ai-sdk/amazon-bedrock` — SDK object construction is synchronous and makes no network calls.

---

### UT-1: Explicit credentials — returns LanguageModel

- **Input**: `providerType='bedrock'`, `apiKey='AKIATEST'`, `baseUrl=undefined`, `modelId='anthropic.claude-sonnet-4-6-v1:0'`, `useResponsesApi=undefined`, `authConfig={ region: 'us-west-2', accessKeyId: 'AKIATEST', secretAccessKey: 'secretvalue' }`
- **Expected**: Returns a non-null object with a `modelId` property. No error thrown. The object is a valid Vercel AI SDK `LanguageModel`.

---

### UT-2: Ambient credentials — returns LanguageModel without stored keys

- **Input**: `apiKey='__iam_role__'`, `authConfig={ region: 'us-east-1', useAmbientCredentials: true }`
- **Setup**: Set `process.env.AWS_ACCESS_KEY_ID = 'AKIATEST'` and `process.env.AWS_SECRET_ACCESS_KEY = 'fakesecret'` before the call (simulates ambient pod environment; restore after)
- **Expected**: Returns a non-null `LanguageModel` object. No error thrown. `credentialProvider` callback is wired (not null).

---

### UT-3: Region defaults to us-east-1 when authConfig has no region and no AWS_REGION env

- **Input**: `authConfig={ useAmbientCredentials: true }` (no `region` key), `process.env.AWS_REGION` unset
- **Expected**: Provider created without throwing. Region used internally is `'us-east-1'`. (Verify indirectly: no error, and `modelId` property is present on the returned object.)

---

### UT-4: AWS_REGION env var used as region fallback when authConfig.region absent

- **Input**: `authConfig={ useAmbientCredentials: true }` (no `region` key)
- **Setup**: `process.env.AWS_REGION = 'ap-southeast-1'` before call; restore after
- **Expected**: Provider created without throwing. (The region is consumed internally by `createAmazonBedrock`; this test validates that the factory correctly reads `process.env.AWS_REGION` before defaulting to `'us-east-1'`.)

---

### UT-5: Incomplete explicit credentials — throws with "secretAccessKey" in message

- **Input**: `authConfig={ region: 'us-east-1', accessKeyId: 'AKIATEST' }` (missing `secretAccessKey`), `apiKey='AKIATEST'`
- **Expected**: Throws an `Error`. `error.message` contains the string `"secretAccessKey"` (case-insensitive). This validates the factory's pre-flight validation catches the incomplete credential before the SDK is ever called.

---

### UT-6: No credentials, no ambient flag — throws descriptive error

- **Input**: `authConfig={}` (or `authConfig=undefined`), `apiKey='some-key'`
- **Expected**: Throws an `Error`. `error.message` does NOT contain "OpenAI". `error.message` contains a descriptive phrase identifying the Bedrock provider and the missing credential context (e.g., "bedrock", "credentials").

---

## 6. Studio E2E Test Scenarios (Playwright)

**File**: `apps/studio/e2e/bedrock-connection-dialog.spec.ts`

Tests the Studio `AddConnectionDialog` credential mode toggle (FR-3). Uses the existing Playwright infrastructure at `apps/studio/e2e/helpers/`.

**Auth Context for all PLY scenarios**: Logged-in tenant admin (established in `beforeAll` via the shared login fixture). All PLY scenarios inherit this context unless stated otherwise.

---

### PLY-1: Credential mode radio toggle renders for Bedrock provider

- **Auth Context**: Tenant admin (fresh login)
- **Steps**:
  1. Log in as tenant admin
  2. Navigate to Admin → Models → select a Bedrock TenantModel
  3. Click "Add Connection"
- **Expected**: Dialog renders with a credential mode radio group. Two options visible: "Explicit AWS Credentials" and "Use Platform IAM Role". Default selection is "Explicit AWS Credentials".

---

### PLY-2: IAM role mode hides key fields, shows only region

- **Auth Context**: Tenant admin (shared fixture)
- **Steps**:
  1. Open Add Connection dialog for a Bedrock model (as in PLY-1)
  2. Select "Use Platform IAM Role"
- **Expected**: "Access Key ID", "Secret Access Key", and "Session Token" input fields are hidden. "AWS Region" input field remains visible. Help text is visible: mentions "IRSA" or "IAM role" and `bedrock:InvokeModel` permission.

---

### PLY-3: Explicit mode shows all four credential fields

- **Auth Context**: Tenant admin (shared fixture)
- **Steps**:
  1. Open Add Connection dialog
  2. Select "Explicit AWS Credentials" (or verify it is already selected)
- **Expected**: All four fields visible: "AWS Region", "Access Key ID", "Secret Access Key", "Session Token". No IAM role help text visible.

---

### PLY-4: IAM role submission stores sentinel apiKey and useAmbientCredentials flag

- **Auth Context**: Tenant admin (shared fixture)
- **Steps**:
  1. Open Add Connection dialog
  2. Select "Use Platform IAM Role"
  3. Set Region = "us-west-2"
  4. Click Save
  5. Verify via `GET /api/platform/admin/tenant-credentials/:id`
- **Expected**: API response body has `authConfig.useAmbientCredentials === true`, `authConfig.region === 'us-west-2'`, no `accessKeyId` or `secretAccessKey` fields in `authConfig`. (Sentinel `"__iam_role__"` storage verification is in the integration tests, not the Playwright E2E.)

---

### PLY-5: Incomplete explicit credentials — form validation blocks submission

- **Auth Context**: Tenant admin (shared fixture)
- **Steps**:
  1. Open Add Connection dialog
  2. Select "Explicit AWS Credentials"
  3. Fill in only "Access Key ID" (leave "Secret Access Key" empty)
  4. Click Save
- **Expected**: Form submission is blocked. A validation error message appears referencing the missing "Secret Access Key" field. No HTTP request is made to the credentials endpoint.

---

## 7. Security & Isolation Tests

### E2E isolation checks (`bedrock-e2e.test.ts`)

- [x] Cross-tenant Bedrock credential access returns `404` (not `403`) — covered by E2E-4
- [x] Missing `Authorization` header on `/api/sessions/:sessionId/chat` returns `401` — verify with a request omitting the header entirely
- [x] Expired / invalid JWT on session endpoints returns `401`
- [x] Credential injection attack: a tenant that sends `authConfig.useAmbientCredentials: true` in a forged request body to the credential creation endpoint must be rejected unless the tenant is explicitly allowed ambient mode (the provisioning route validates the `authType` and `authConfig` shape via Zod schema)
- [x] Cross-project access: `TenantModel`/`LLMCredential` are tenant-scoped (no `projectId` field); RBAC is enforced at the route layer via `requireProjectPermission`; an authenticated user from the same tenant but not a member of the project returns `403` on `/api/projects/:projectId/agents` creation

### Integration checks (`bedrock-integration.test.ts`)

- [x] `authConfig.secretAccessKey` and `authConfig.accessKeyId` are encrypted at rest: after `LLMCredential.create({ authConfig: { accessKeyId: 'AKIA...', secretAccessKey: '...' } })`, fetch the raw MongoDB document via a direct Mongoose query (bypassing the `encryptionPlugin` post-find hook) and assert that the stored `authConfig` value is a ciphertext blob (not a plain JSON object containing the key strings)
- [x] Sentinel `"__iam_role__"` in `encryptedApiKey` is stored encrypted: for an ambient-mode credential, the raw MongoDB document must show an encrypted blob in `encryptedApiKey`, not the literal string `"__iam_role__"`

---

## 8. Performance & Load Tests

Not in scope for ABLP-674 (ALPHA promotion). Post-BETA:

- Verify Bedrock `credentialProvider` callback caching behavior under concurrent requests (latency regression check)
- Verify provider cache TTL (30 minutes, configurable via `LLM_PROVIDER_CACHE_TTL_SECONDS`) correctly evicts and recreates provider instances under rotation scenarios

---

## 9. Test Infrastructure

### Required Services

| Service                | Purpose                                 | Provided By                                |
| ---------------------- | --------------------------------------- | ------------------------------------------ |
| MongoMemoryServer      | In-memory MongoDB for integration tests | `mongodb-memory-server` (existing dep)     |
| Runtime Express server | Real HTTP server for E2E tests          | `startRuntimeServerHarness()`              |
| `nock@^14`             | Bedrock HTTP interception               | Add to `apps/runtime/package.json` devDeps |
| `playwright`           | Studio UI E2E tests                     | Existing in `apps/studio/package.json`     |

### Data Seeding

**Integration tests**: Use Mongoose `LLMCredential.create({ tenantId, authType: 'aws_iam', encryptedApiKey, authConfig, ... })` directly. The `initializeRuntimeTestEncryption()` call in the harness initializes the encryption plugin so documents are correctly encrypted/decrypted.

**E2E tests**: Use `provisionBedrockCredential(harness, adminToken, opts)` helper (to be created; calls the extended provisioning route). For ambient mode, the raw `LLMCredential` document must have no `accessKeyId`/`secretAccessKey` in `authConfig`.

### Environment Variables

| Variable                | Value in Tests          | Purpose                                 |
| ----------------------- | ----------------------- | --------------------------------------- |
| `AWS_REGION`            | `'us-east-1'` (default) | Region fallback for UT-4                |
| `AWS_ACCESS_KEY_ID`     | `'AKIATEST'` (fake)     | Ambient creds simulation in UT-2, E2E-2 |
| `AWS_SECRET_ACCESS_KEY` | `'fakesecret'` (fake)   | Ambient creds simulation                |

Add `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` to `MANAGED_ENV_KEYS` in `runtime-api-harness.ts` so the harness snapshot/restore mechanism handles cleanup (prerequisite P-2).

### nock Setup Pattern

```typescript
import nock from 'nock';

beforeEach(() => {
  nock.cleanAll();
});
afterAll(() => {
  nock.restore();
});

// Per-test: intercept Bedrock converse endpoint
nock('https://bedrock-runtime.us-east-1.amazonaws.com')
  .post('/model/anthropic.claude-sonnet-4-6-v1:0/converse')
  .reply(200, {
    output: { message: { role: 'assistant', content: [{ text: 'Hello from Bedrock.' }] } },
    usage: { inputTokens: 8, outputTokens: 6 },
    stopReason: 'end_turn',
  });
```

---

## 10. Test File Mapping

| Test File                                                | Type             | Covers                                                                                                                                                | Status                            |
| -------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `packages/llm/src/__tests__/provider-factory.test.ts`    | unit             | FR-1 (factory), FR-2 (factory), FR-5 (error paths), FR-8, FR-8a — UT-1 through UT-6                                                                   | 6/6 PASSING                       |
| `apps/runtime/src/__tests__/bedrock-integration.test.ts` | integration      | FR-1, FR-2, FR-5, FR-6, FR-7 — INT-2 through INT-6                                                                                                    | 7/8 PASSING (1 it.todo for INT-1) |
| `apps/runtime/src/__tests__/bedrock-e2e.test.ts`         | e2e (auto)       | FR-1, FR-5 — E2E-1 (full chat roundtrip via /api/v1/chat/agent + nock), E2E-3 (error path), provisioning, cross-tenant isolation, connection endpoint | 5/5 PASSING                       |
| `apps/runtime/src/__tests__/classify-llm-error.test.ts`  | unit             | FR-5 — Bedrock error classification patterns + regression guards for non-Bedrock 404 mis-classification                                               | 24/24 PASSING                     |
| `apps/studio/e2e/bedrock-connection-dialog.spec.ts`      | e2e (Playwright) | FR-3 — PLY-1 through PLY-5                                                                                                                            | 5 test.fixme stubs                |

---

## 11. Open Testing Questions

1. **nock + aws4fetch compatibility**: RESOLVED — `nock@^14` patches the global `fetch` and correctly intercepts `aws4fetch` calls. Verified by E2E-1 `scope.isDone() === true` assertion: the nock interceptor at `/model/anthropic.claude-sonnet-4-6-v1%3A0/converse` is reliably hit by the runtime's Bedrock inference path.

2. **Bedrock streaming in automated E2E**: Streaming uses `POST /model/{modelId}/converse-stream` which returns `application/vnd.amazon.eventstream` binary format. Mocking this format with nock requires constructing the correct eventstream binary payload. The E2E streaming scenario (E2E-1 step 4) should initially test the non-streaming path and add a streaming variant once the eventstream mock helper is established.

3. **provisionTenantModel helper extension scope**: The oracle confirmed that `provisionTenantModel` and the provisioning route schema must be extended to accept `authConfig` (prerequisite P-3). The LLD should define whether this is a standalone helper or a route-level change, and whether it affects other non-Bedrock providers.

4. **Cache key extraction (RESOLVED — LLD action)**: INT-3 and INT-4 require `buildProviderCacheKey()` to be exported as a pure function from `provider-cache.ts`. LLD Phase C must include this extraction as a subtask. Per CLAUDE.md "fix the code, not the test," this is architecturally correct: the key-building logic is independent of the cache state and is more testable as a pure function.

5. **Ambient mode E2E on non-AWS infrastructure**: E2E-2 injects fake AWS credentials via env vars to simulate ambient pod environment. Confirm that `fromNodeProviderChain()` picks up `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars (in addition to IRSA token files) so that the test runs on any machine, not just EKS.

---

## 12. Manual Testing Checklist (Staging)

For BETA promotion, the following manual tests must be completed on a real AWS-connected staging environment:

| #   | Scenario                                                                                                        | Environment                 | Status     |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------- |
| M-1 | Explicit credentials connection → streaming agent response in Studio                                            | Any env with real AWS creds | NOT TESTED |
| M-2 | IRSA ambient connection on EKS → agent executes, CloudTrail shows IAM role attribution                          | EKS cluster with IRSA       | NOT TESTED |
| M-3 | Wrong region (`ap-southeast-99`) → Bedrock-specific error in Studio UI, no "OpenAI API error"                   | Any env                     | NOT TESTED |
| M-4 | SearchAI pipeline with Bedrock classifier → classification succeeds, authConfig forwarded                       | SearchAI-enabled env        | NOT TESTED |
| M-5 | Tool calling with Bedrock Claude model → tool executed, response streamed back                                  | Any env with real AWS creds | NOT TESTED |
| M-6 | Credential rotation (update keys in Studio) → new keys take effect within one cache TTL window (30 min default) | Any env                     | NOT TESTED |
