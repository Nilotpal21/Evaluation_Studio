# Feature Test Guide: Model Hub

**Feature**: Model catalog, tenant model provisioning, project/agent overrides, credential resolution, and capability-aware model selection
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/model-hub.md](../features/model-hub.md)
**First tested**: 2026-03-18
**Last updated**: 2026-04-15
**Overall status**: BETA

---

## Current State (as of 2026-04-15)

Model hub coverage is strong across runtime route tests, model-resolution analyzers, compiler registry tests, and authorization checks. Budget enforcement, cache invalidation (with HMAC), health check services, provider cache eviction, and model resolution versioning all have dedicated test suites. Three runtime E2E suites cover provisioning, tenant isolation, and override workflows via HTTP API with real servers. A Playwright E2E suite covers model guardrails in the browser. Cross-project isolation and credential chain analysis have been added since the initial spec. The main remaining gaps are full browser-level admin/studio provisioning E2E flows across all provider variants and live provision-to-execution confirmation. Note: Studio `model-management.test.tsx` and `api-model-routes.test.ts` referenced in earlier versions no longer exist on the develop branch.

### Quick Health Dashboard

| Area                      | Status  | Last Verified | Notes                                                                   |
| ------------------------- | ------- | ------------- | ----------------------------------------------------------------------- |
| Model catalog             | PASS    | 2026-04-15    | Catalog and capabilities fully tested                                   |
| Tenant model CRUD         | PASS    | 2026-04-15    | Route and repo coverage exists                                          |
| Project LLM config        | PASS    | 2026-04-15    | Project override routes tested                                          |
| Agent model override      | PASS    | 2026-04-15    | Agent route authz tested                                                |
| Model resolution analysis | PASS    | 2026-04-15    | Analyzer and comprehensive tests exist                                  |
| Credential encryption     | PASS    | 2026-04-15    | Encryption plugin tested via credential model                           |
| Tenant isolation          | PASS    | 2026-04-15    | Repo isolation, authz tests, E2E isolation suite                        |
| Platform admin models     | PASS    | 2026-04-15    | Authz tests for cross-tenant management                                 |
| Browser/admin management  | PARTIAL | 2026-04-15    | Playwright model-guardrails E2E exists; no full all-up provisioning E2E |
| Budget enforcement        | PASS    | 2026-04-15    | 17 unit tests: limits, passthrough, Redis fail                          |
| Cache invalidation        | PASS    | 2026-04-15    | 13 unit tests: pub/sub, HMAC, degradation                               |
| Health check service      | PASS    | 2026-04-15    | 6 unit tests: cycle, status, feature flag                               |
| Resolution versioning     | PASS    | 2026-04-15    | Cache versioning contract test                                          |
| Credential ownership      | PASS    | 2026-04-15    | Tenant model credential ownership route test                            |
| Cross-project isolation   | PASS    | 2026-04-15    | Cross-project model config isolation                                    |
| Credential chain analysis | PASS    | 2026-04-15    | Credential chain analyzer diagnostics                                   |
| Provider cache eviction   | PASS    | 2026-04-15    | Scoped eviction and global clear                                        |
| Provisioning E2E          | PASS    | 2026-04-15    | Full provisioning flow via HTTP API                                     |
| Override E2E              | PASS    | 2026-04-15    | Project/agent override layering via HTTP API                            |
| Model guardrails E2E      | PASS    | 2026-04-15    | Playwright browser E2E for model guardrails                             |

---

## Coverage Matrix

| FR    | Description                                   | Unit | Integration | E2E | Manual | Status  |
| ----- | --------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Public model catalog with capability metadata | Y    | Y           | N   | N      | Covered |
| FR-2  | Tenant model CRUD + encrypted credentials     | Y    | Y           | Y   | N      | Covered |
| FR-3  | 5-level model resolution chain                | N    | Y           | N   | N      | Covered |
| FR-4  | Project operation-tier overrides              | N    | Y           | Y   | N      | Covered |
| FR-5  | Per-agent model configuration overrides       | N    | Y           | Y   | N      | Covered |
| FR-6  | Capability-aware model selection              | Y    | Y           | N   | N      | Covered |
| FR-7  | Tenant LLM policy enforcement                 | Y    | N           | N   | N      | Partial |
| FR-8  | Per-call LLM usage metrics                    | N    | Y           | N   | N      | Partial |
| FR-9  | Diagnostic model resolution analysis          | N    | Y           | N   | N      | Covered |
| FR-10 | Provider factory (15 types -> Vercel AI SDK)  | N    | Y           | N   | N      | Covered |

---

## E2E Test Scenarios (MANDATORY)

### E2E-1: Full Model Provisioning to Execution Journey

**Preconditions**: Clean tenant with no models provisioned. `ENCRYPTION_MASTER_KEY` set.

**Steps**:

1. `POST /api/tenants/:tenantId/models` -- Create a tenant model with provider `anthropic`, tier `balanced`, capabilities.
2. `POST /api/tenants/:tenantId/models/:id/connections` -- Add a connection with encrypted credential.
3. `GET /api/tenants/:tenantId/models/:id` -- Verify model and connection are returned with health status `unchecked`.
4. `PUT /api/projects/:projectId/llm-config` -- Set project operation-tier overrides mapping `reasoning` to `balanced`.
5. `PUT /api/projects/:projectId/agents/:agentName/model-config` -- Set agent override with temperature 0.3.
6. Execute an agent session via WebSocket -- Verify the resolved model uses the provisioned tenant model with agent-level temperature override.
7. `GET /api/tenants/:tenantId/models` -- Verify usage metrics were recorded.

**Expected Result**: Model resolution uses the full chain: agent DB override for temperature, project DB for tier mapping, tenant model for the actual provider/credential. Usage metrics record the call.

**Auth Context**: Tenant ADMIN for provisioning, project MEMBER for agent config, authenticated user for execution.

**Isolation Check**: Attempting to access tenant model from a different tenant ID returns 404.

### E2E-2: Cross-Tenant Model Isolation

**Preconditions**: Two tenants (A and B) each with provisioned models.

**Steps**:

1. `POST /api/tenants/:tenantA/models` -- Provision model for tenant A.
2. `GET /api/tenants/:tenantB/models/:tenantAModelId` -- Attempt to read tenant A's model with tenant B's auth.
3. `PUT /api/tenants/:tenantB/models/:tenantAModelId` -- Attempt to update tenant A's model with tenant B's auth.
4. `DELETE /api/tenants/:tenantB/models/:tenantAModelId` -- Attempt to delete tenant A's model with tenant B's auth.
5. `GET /api/tenants/:tenantA/models` -- Verify tenant A's model is unaffected.

**Expected Result**: All cross-tenant access attempts return 404 (not 403). Tenant A's model remains intact.

**Auth Context**: Tenant A ADMIN for provisioning, Tenant B ADMIN for cross-tenant attempts.

**Isolation Check**: Core test purpose is isolation verification.

### E2E-3: Model Catalog Discovery and Capability Resolution

**Preconditions**: Runtime server started with built-in catalog loaded.

**Steps**:

1. `GET /api/model-catalog` -- List all catalog models, verify 147+ entries returned.
2. `GET /api/model-catalog?provider=anthropic` -- Filter by provider, verify only Anthropic models returned.
3. `GET /api/model-catalog/:modelId` -- Get specific model (e.g., `anthropic/claude-sonnet-4-20250514`), verify capabilities structure.
4. `GET /api/model-capabilities/:modelId` -- Get hyperparameters and capability metadata for the model.
5. Verify capability response includes modalities (input/output), features (streaming, tools, vision, reasoning), limits (contextWindow, maxOutputTokens), and parameter support matrix.

**Expected Result**: Catalog returns structured model entries with complete capability metadata. Hyperparameter definitions include type, range, defaults for dynamic UI rendering.

**Auth Context**: Any authenticated user.

**Isolation Check**: Catalog is public within authenticated scope -- no tenant-specific filtering on catalog reads.

### E2E-4: Project Operation-Tier Override Layering

**Preconditions**: Tenant with two models provisioned: one `fast` tier, one `powerful` tier. Project exists.

**Steps**:

1. `POST /api/tenants/:tenantId/models` -- Create fast-tier model (e.g., GPT-4o-mini).
2. `POST /api/tenants/:tenantId/models` -- Create powerful-tier model (e.g., Claude Sonnet).
3. `PUT /api/projects/:projectId/llm-config` -- Set `{ operationTierOverrides: { reasoning: "powerful", extraction: "fast" } }`.
4. `GET /api/projects/:projectId/llm-config` -- Verify overrides are persisted.
5. Execute agent with `reasoning` operation -- Verify Claude Sonnet is resolved.
6. Execute agent with `extraction` operation -- Verify GPT-4o-mini is resolved.

**Expected Result**: Different operations resolve to different models based on tier mapping. Resolution diagnostics show the correct tier was selected at each level.

**Auth Context**: Tenant ADMIN for model provisioning, project OWNER for LLM config, authenticated user for execution.

**Isolation Check**: A different project attempting to read this project's LLM config returns 404.

### E2E-5: Agent Model Override with Full Parameter Control

**Preconditions**: Tenant with provisioned model. Project with default LLM config.

**Steps**:

1. `PUT /api/projects/:projectId/agents/:agentName/model-config` -- Set overrides: `{ defaultModel: "anthropic/claude-sonnet-4-20250514", temperature: 0.2, maxTokens: 2048, hyperParameters: { topP: 0.9 }, useStreaming: true }`.
2. `GET /api/projects/:projectId/agents/:agentName/model-config` -- Verify all override fields are persisted.
3. Execute agent session -- Verify resolved model uses agent-level overrides for model, temperature, maxTokens, and streaming.
4. `PUT /api/projects/:projectId/agents/:agentName/model-config` -- Update to `{ defaultModel: null }` to clear model override.
5. Execute agent session -- Verify model falls through to project/tenant level.

**Expected Result**: Agent overrides take precedence at Level 2 of the resolution chain. Clearing the override causes fallthrough to lower levels.

**Auth Context**: Project MEMBER with `model_config:write` for config, authenticated user for execution.

**Isolation Check**: A different agent name in the same project does not inherit this agent's overrides.

### E2E-6: Gateway Discovery with SSRF Protection

**Preconditions**: LiteLLM gateway running at a known URL. Admin credentials.

**Steps**:

1. `POST /api/model-catalog/gateway-discovery` with `{ gatewayUrl: "https://valid-litellm-proxy.example.com" }` -- Verify models are discovered and returned.
2. `POST /api/model-catalog/gateway-discovery` with `{ gatewayUrl: "http://127.0.0.1:8080" }` -- Verify SSRF protection blocks the request.
3. `POST /api/model-catalog/gateway-discovery` with `{ gatewayUrl: "http://169.254.169.254/latest/meta-data" }` -- Verify AWS metadata endpoint is blocked.
4. `POST /api/model-catalog/gateway-discovery` with `{ gatewayUrl: "http://metadata.google.internal" }` -- Verify GCP metadata endpoint is blocked.

**Expected Result**: Valid external URLs proceed with discovery. Internal IPs, loopback, and cloud metadata endpoints are blocked with appropriate error messages.

**Auth Context**: Tenant ADMIN with `credential:write` permission.

**Isolation Check**: Non-admin users receive 403 for gateway discovery.

### E2E-7: Credential Lifecycle and Provider Cache Invalidation

**Preconditions**: Tenant with a provisioned model and active connection.

**Steps**:

1. `POST /api/tenants/:tenantId/models/:id/connections` -- Add connection with credential A.
2. Execute agent session -- Verify resolution uses credential A.
3. `PUT /api/tenants/:tenantId/models/:id/connections/:connId` -- Update connection to credential B.
4. Execute agent session -- Verify resolution now uses credential B (cache invalidated).
5. `DELETE /api/tenants/:tenantId/models/:id/connections/:connId` -- Remove the connection.
6. Execute agent session -- Verify resolution fails or falls through to a different path.

**Expected Result**: Credential changes are reflected in subsequent resolution calls. Provider cache is invalidated when connections change.

**Auth Context**: Tenant ADMIN for connection management, authenticated user for execution.

**Isolation Check**: Connection changes for one model do not affect other models in the same tenant.

---

## Integration Test Scenarios (MANDATORY)

### INT-1: Model Resolution Chain -- 5-Level Cascade

**Boundary**: `ModelResolutionService` -> `llm-resolution-repo` -> MongoDB

**Setup**: MongoDB with test data at each resolution level.

**Steps**:

1. Seed agent model config (Level 2), project model config (Level 3), and tenant model (Level 4) for the same agent.
2. Call `ModelResolutionService.resolve()` with full context -- verify Level 2 (agent DB) takes priority.
3. Remove agent model config -- call resolve again, verify Level 3 (project DB) takes priority.
4. Remove project model config -- call resolve again, verify Level 4 (tenant model) is used.
5. Remove tenant model -- call resolve again, verify resolution throws (Level 5: FAIL).

**Expected Result**: Resolution walks levels in order and returns the first match. Absence of higher-priority levels causes correct fallthrough.

**Failure Mode**: If MongoDB is unreachable, resolution throws with a clear error code rather than returning undefined.

### INT-2: Tenant Model Repository Isolation

**Boundary**: `tenant-model-repo` -> MongoDB with `tenantIsolationPlugin`

**Setup**: Two tenants with models in the same MongoDB collection.

**Steps**:

1. Create models for tenant A and tenant B.
2. Query with tenant A's context -- verify only tenant A's models are returned.
3. Attempt `findOne({ _id: tenantBModelId })` with tenant A's context -- verify null (not found).
4. Attempt `updateOne({ _id: tenantBModelId })` with tenant A's context -- verify 0 documents modified.
5. Verify tenant B's model is unaffected by tenant A's operations.

**Expected Result**: `tenantIsolationPlugin` enforces tenant scoping on all query operations.

**Failure Mode**: Plugin throws if tenantId is missing from query context.

### INT-3: Credential Encryption Round-Trip

**Boundary**: `llm-credential.model` -> `encryptionPlugin` -> `EncryptionService`

**Setup**: MongoDB with `ENCRYPTION_MASTER_KEY` configured.

**Steps**:

1. Create an LLM credential with plaintext API key and endpoint.
2. Read the raw MongoDB document -- verify `encryptedApiKey` is not the original plaintext.
3. Read the credential through Mongoose -- verify the API key is decrypted back to the original.
4. Update the credential with a new API key -- verify the encrypted value changes.
5. Verify the audit trail plugin recorded the create and update operations.

**Expected Result**: API keys are encrypted at rest via AES-256-GCM. Decryption through the model layer returns the original value.

**Failure Mode**: Missing `ENCRYPTION_MASTER_KEY` causes credential operations to fail with a clear error.

### INT-4: Provider Factory -- Multi-Provider Mapping

**Boundary**: `createVercelProvider()` -> Vercel AI SDK factories

**Setup**: Unit-level test with mock API keys.

**Steps**:

1. Call `createVercelProvider('anthropic', apiKey, undefined, 'anthropic/claude-sonnet-4-20250514')` -- verify returns a valid LanguageModel.
2. Call `createVercelProvider('openai', apiKey, undefined, 'openai/gpt-4o')` -- verify Responses API auto-detection uses `modelSupportsResponsesApi()`.
3. Call `createVercelProvider('azure', apiKey, undefined, 'azure/deployment-name', undefined, { resourceName: 'myresource', apiVersion: '2024-10-21' })` -- verify Azure-specific URL construction.
4. Call `createVercelProvider('groq', apiKey, undefined, 'groq/llama-3.3-70b')` -- verify OpenAI-compatible factory with Groq base URL.
5. Call `createVercelProvider('unknown_provider', apiKey, 'https://custom.api.com', 'custom/model')` -- verify fallback to OpenAI-compatible with custom base URL.

**Expected Result**: Each provider type creates the correct SDK factory with proper configuration.

**Failure Mode**: Invalid provider type falls through to OpenAI-compatible default rather than throwing.

### INT-5: Model Catalog -- Hybrid Sources

**Boundary**: `ModelCatalogService` -> `MODEL_REGISTRY` + LiteLLM data + gateway discovery

**Setup**: Runtime with built-in catalog loaded.

**Steps**:

1. Call `getModelCatalog()` -- verify 147+ entries from built-in registry are returned.
2. Filter by provider `anthropic` -- verify only Anthropic models.
3. Get specific model details -- verify capabilities include `supportsTools`, `supportsVision`, `supportsStreaming`, `contextWindow`.
4. Verify pricing data is present where available (inputCostPer1k, outputCostPer1k).
5. Verify model sources are correctly tagged (`litellm_data`, `platform`, `gateway`).

**Expected Result**: Hybrid catalog merges multiple sources with correct source tags and complete capability data.

**Failure Mode**: Missing LiteLLM data file degrades gracefully (built-in catalog still works).

### INT-6: Diagnostic Analyzer -- Resolution Chain Walk

**Boundary**: `ModelResolutionAnalyzer` -> `AgentModelConfig` + `ModelConfig` + `TenantModel`

**Setup**: MongoDB with partial configuration (agent config present, no tenant model).

**Steps**:

1. Call `analyze()` with an agent name that has agent-level config but no credential path.
2. Verify findings include `NO_CREDENTIAL` with severity `error`.
3. Call `analyze()` with an agent name that has a complete resolution path.
4. Verify findings include `MODEL_RESOLVED` with severity `info` and evidence showing which level matched.
5. Call `analyze()` with no agent name -- verify graceful `NO_AGENT_NAME` info finding.

**Expected Result**: Analyzer produces structured findings with severity, code, detail, suggestion, and evidence for each chain step.

**Failure Mode**: Database errors are caught and reported as findings rather than uncaught exceptions.

### INT-7: Platform Admin Cross-Tenant Model Management

**Boundary**: Platform admin routes -> `tenant-model-repo` -> MongoDB

**Setup**: Platform admin credentials. Multiple tenants with models.

**Steps**:

1. `GET /api/platform-admin/tenant-models` with platform admin auth -- verify returns models across tenants.
2. Verify response includes tenantId field for each model.
3. Attempt the same endpoint with regular tenant admin auth -- verify 403.
4. Verify platform admin cannot modify a tenant model (read-only cross-tenant access).

**Expected Result**: Platform admin has read access across tenants for monitoring. Regular admins cannot access this endpoint.

**Failure Mode**: Missing platform admin role returns 403 with appropriate error.

---

## Security & Isolation Tests

- [x] Cross-tenant access returns 404 (`auth/tenant-models-authz.test.ts`, `tenant-model-repo-isolation.test.ts`)
- [x] Cross-project access returns 404 (`cross-project-isolation.test.ts`, project LLM config and agent model config routes)
- [x] Missing auth returns 401 (all model hub routes use `authMiddleware`)
- [x] Insufficient permissions returns 403 (`auth/agent-model-config-authz.test.ts`)
- [x] Input validation rejects malformed data (`tenant-models.test.ts`)
- [x] SSRF protection blocks internal IPs (`model-catalog.test.ts`)
- [x] Security-sensitive headers blocked on connections
- [x] Tenant LLM policy enforcement: provider allowlist enforced in ModelResolutionService, budget enforcement with unit tests
- [x] Credential ownership validated on tenant model routes (`tenant-model-credential-ownership-route.test.ts`)
- [ ] Cross-user credential isolation (user-scoped credentials not accessible by other users in same tenant)

---

## Performance & Load Tests

- [ ] Provider cache hit rate under concurrent sessions (target: >90% after warmup)
- [ ] Resolution latency with full 5-level chain (target: <50ms p99)
- [ ] Catalog listing performance with 147+ models (target: <100ms)
- [ ] Credential decryption overhead per resolution (target: <5ms)

---

## Unit Test Scenarios

### UNIT-1: Model Registry Entry Validation

**Module**: `packages/compiler/src/platform/llm/model-registry.ts`
**Input**: `MODEL_REGISTRY` constant
**Expected Output**: All 147 entries have valid provider, modelId, capabilities, and hyperParameter definitions. No duplicate modelIds.

### UNIT-2: Model Capability Derivation

**Module**: `packages/compiler/src/platform/llm/model-capabilities.ts`
**Input**: A model ID from the registry (e.g., `claude-sonnet-4-20250514`)
**Expected Output**: Structured `ModelCapabilities` object with modalities, features, limits, and parameter support matching the registry entry.

### UNIT-3: Provider Inference from Model ID

**Module**: `apps/runtime/src/services/llm/model-resolution.ts` -- `inferProviderFromModelId()`
**Input**: Various model ID formats (`anthropic/claude-3-sonnet`, `claude-3-sonnet`, `gpt-4o`, `gemini-2.0-flash`)
**Expected Output**: Correct provider inference (`anthropic`, `anthropic`, `openai`, `google` respectively).

### UNIT-4: SSRF URL Validation

**Module**: `apps/runtime/src/services/llm/model-catalog.ts` -- `isAllowedGatewayUrl()`
**Input**: Various URLs including localhost, private IPs (10.x, 172.16-31.x, 192.168.x), metadata endpoints, valid external URLs.
**Expected Output**: Internal/private URLs return false, valid external HTTPS URLs return true.

### UNIT-5: Session LLM Client Timeout Configuration

**Module**: `apps/runtime/src/services/llm/session-llm-client.ts`
**Input**: `LLM_CALL_TIMEOUT_MS` environment variable.
**Expected Output**: AbortSignal timeout matches configured value (default 120000ms).

---

## Test Infrastructure

### Required Services

- **MongoDB**: Required for all integration tests. Tests use `@agent-platform/database` connection utilities.
- **Runtime Express Server**: Started on random port (`{ port: 0 }`) for route tests with full middleware chain.
- **ENCRYPTION_MASTER_KEY**: Required env var for credential encryption tests (64-char hex string).

### Data Seeding Strategy

- Tenant models, credentials, and policies seeded via `POST` endpoints in E2E tests.
- Direct model creation via Mongoose in integration tests (acceptable for service-boundary tests).
- Built-in catalog requires no seeding (loaded from `MODEL_REGISTRY` constant).

### Environment Variables

| Variable                | Required For     | Value                     |
| ----------------------- | ---------------- | ------------------------- |
| `ENCRYPTION_MASTER_KEY` | Credential tests | 64-char hex string        |
| `MONGODB_URI`           | All integration  | MongoMemoryServer or real |
| `LLM_CALL_TIMEOUT_MS`   | Timeout tests    | Default: 120000           |

### CI Configuration

- Runtime tests: `pnpm --filter runtime test -- model`
- Compiler tests: `pnpm --filter @abl/compiler test -- llm`
- Studio tests: `pnpm --filter studio test -- configure-model`

---

## Test File Mapping

| Test File                                                                            | Type        | Covers                 |
| ------------------------------------------------------------------------------------ | ----------- | ---------------------- |
| `apps/runtime/src/__tests__/model-catalog.test.ts`                                   | integration | FR-1, FR-6             |
| `apps/runtime/src/__tests__/tenant-model-routes.test.ts`                             | integration | FR-2                   |
| `apps/runtime/src/__tests__/tenant-models.test.ts`                                   | integration | FR-2                   |
| `apps/runtime/src/__tests__/auth/tenant-models-authz.test.ts`                        | integration | FR-2 (isolation)       |
| `apps/runtime/src/__tests__/tenant-model-repo-isolation.test.ts`                     | integration | FR-2 (isolation)       |
| `apps/runtime/src/__tests__/tenant-model-credential-ownership-route.test.ts`         | integration | FR-2 (credentials)     |
| `apps/runtime/src/__tests__/model-resolution-comprehensive.test.ts`                  | integration | FR-3                   |
| `apps/runtime/src/__tests__/model-resolution-versioning.test.ts`                     | integration | FR-3 (versioning)      |
| `apps/runtime/src/__tests__/model-resolution-analyzer.test.ts`                       | integration | FR-9                   |
| `apps/runtime/src/__tests__/auth/agent-model-config-authz.test.ts`                   | integration | FR-5                   |
| `apps/runtime/src/__tests__/auth/platform-admin-models-authz.test.ts`                | integration | FR-2 (admin)           |
| `apps/runtime/src/__tests__/auth/tenant-service-instances-authz.test.ts`             | integration | FR-2 (services)        |
| `apps/runtime/src/__tests__/llm-wiring.test.ts`                                      | integration | FR-10                  |
| `apps/runtime/src/__tests__/llm-services.test.ts`                                    | integration | FR-10                  |
| `apps/runtime/src/__tests__/llm-integration.test.ts`                                 | integration | FR-3, FR-10            |
| `apps/runtime/src/__tests__/settings-resolution.test.ts`                             | integration | FR-3, FR-4             |
| `apps/runtime/src/__tests__/auth/auth-profile/model-resolution-auth-profile.test.ts` | integration | FR-3                   |
| `apps/runtime/src/__tests__/streaming-guardrails-model-tier.test.ts`                 | integration | FR-4 (tier)            |
| `apps/runtime/src/__tests__/cross-project-isolation.test.ts`                         | integration | FR-4, FR-5 (isolation) |
| `apps/runtime/src/__tests__/credential-chain-analyzer.test.ts`                       | integration | FR-9 (credentials)     |
| `apps/runtime/src/__tests__/diagnostic-engine.test.ts`                               | integration | FR-9                   |
| `apps/runtime/src/__tests__/sessions/session-llm-client-timeout.test.ts`             | unit        | FR-10                  |
| `packages/compiler/src/__tests__/llm/model-registry.test.ts`                         | unit        | FR-1, FR-6             |
| `packages/compiler/src/platform/llm/__tests__/model-registry.test.ts`                | unit        | FR-1, FR-6             |
| `apps/runtime/src/__tests__/llm-budget-enforcement.test.ts`                          | unit        | FR-7                   |
| `apps/runtime/src/__tests__/model-cache-invalidation.test.ts`                        | unit        | FR-2 (cache)           |
| `apps/runtime/src/__tests__/model-health-service.test.ts`                            | unit        | FR-2 (health)          |
| `apps/runtime/src/__tests__/provider-cache-eviction.test.ts`                         | unit        | FR-2 (cache)           |
| `apps/studio/src/__tests__/arch-ai/configure-model-helpers.test.ts`                  | unit        | FR-6 (UI helpers)      |
| `apps/runtime/src/__tests__/model-hub-provisioning.e2e.test.ts`                      | e2e         | FR-2, FR-3             |
| `apps/runtime/src/__tests__/model-hub-isolation.e2e.test.ts`                         | e2e         | FR-2 (isolation)       |
| `apps/runtime/src/__tests__/model-hub-overrides.e2e.test.ts`                         | e2e         | FR-4, FR-5             |
| `apps/studio/e2e/model-guardrails-e2e.spec.ts`                                       | e2e         | FR-7 (browser)         |

---

## Open Testing Questions

1. Should E2E tests use a real LLM provider (with test API keys) or mock the LLM response layer while testing the resolution chain? (Using real providers risks flaky tests from rate limits.)
2. ~~How should cross-pod provider cache invalidation be tested in CI?~~ ANSWERED: In-process transport that simulates pub/sub without Redis. See `model-cache-invalidation.test.ts`.
3. Should credential rotation E2E tests verify the full encryption/decryption round-trip or trust the encryption plugin unit tests?

---

## Known Gaps

- Full browser/admin provisioning E2E covering tenant provisioning, project overrides, and agent overrides in one sequence.
- ~~Tenant LLM policy enforcement testing~~ CLOSED -- budget enforcement unit tests (17 tests), provider allowlist already enforced in resolve().
- ~~Cross-pod provider cache invalidation~~ CLOSED -- 13 unit tests with in-process transport, HMAC round-trip verification.
- ~~Cross-project isolation~~ CLOSED -- `cross-project-isolation.test.ts` verifies model config isolation across projects.
- ~~Credential ownership validation~~ CLOSED -- `tenant-model-credential-ownership-route.test.ts` covers ownership checks.
- ~~Model resolution versioning~~ CLOSED -- `model-resolution-versioning.test.ts` verifies cache versioning contract.
- ~~Studio model management UI tests~~ REMOVED -- `model-management.test.tsx` and `api-model-routes.test.ts` no longer exist on develop. `configure-model-helpers.test.ts` covers studio model helper functions.
- Automated cost/token alerting validation.
- User-scoped credential isolation (user A cannot access user B's credentials in same tenant).
- Provision -> override -> execute live run E2E (end-to-end with real LLM call).
- Integration test verifying budget drift correction end-to-end (recordActualUsage post-call path).

---

## Suggested Commands

```bash
pnpm --filter runtime test -- model
pnpm --filter @abl/compiler test -- llm
pnpm --filter studio test -- model-management
```

---

## References

- Related feature doc: [docs/features/model-hub.md](../features/model-hub.md)
- HLD: [docs/specs/model-hub.hld.md](../specs/model-hub.hld.md) (planned)
- LLD: [docs/plans/2026-03-22-model-hub-impl-plan.md](../plans/2026-03-22-model-hub-impl-plan.md) (planned)
