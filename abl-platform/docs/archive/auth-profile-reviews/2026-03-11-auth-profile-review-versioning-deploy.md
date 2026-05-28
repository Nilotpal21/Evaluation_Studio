# Auth Profile Review: Versioning, Deployment & Lifecycle Impact

> **Reviewer focus:** How Auth Profile interacts with agent/workflow versioning, the deployment pipeline, rolling upgrades, and environment promotion.

---

## 1. How Agents and Workflows Are Versioned Today

### Agent Versioning

- **Model:** `AgentVersion` (`packages/database/src/models/agent-version.model.ts`)
- **Fields:** `agentId`, `version` (semver string), `status` (draft/testing/staged/active/deprecated), `dslContent`, `irContent`, `sourceHash`, `toolSnapshot`
- **Lifecycle:** draft -> testing -> staged -> active -> deprecated
- **Key insight:** Each version stores both raw DSL and compiled IR as frozen snapshots. The `irContent` is a serialized `CompilationOutput` containing the full agent IR.

### Tool Snapshots

- Agent versions include a `toolSnapshot` array that captures tool definitions (name, projectToolId, sourceHash, toolType, dslContent) at version-creation time.
- This means **tool DSL is snapshotted**, but tool _credentials_ and _auth configuration_ are NOT snapshotted. The IR stores `{{secrets.X}}` and `{{env.X}}` template placeholders that are resolved at runtime.

### Workflow Versioning

- **Model:** `WorkflowVersion` (`packages/database/src/models/workflow-version.model.ts`)
- **Fields:** `workflowId`, `version`, `tenantId`, `projectId`, `definition` (Mixed), `sourceHash`, `status`
- Same lifecycle as agent versions.

### Project Settings Versioning

- **Model:** `ProjectSettingsVersion` stores enableThinking, thinkingBudget, etc.
- Deployments can pin a `settingsVersionId` for deterministic behavior.

---

## 2. Deployment Model

### Deployment Record

- **Model:** `Deployment` (`packages/database/src/models/deployment.model.ts`)
- **Key fields:**
  - `agentVersionManifest`: `Record<string, string>` mapping agent names to version strings
  - `workflowVersionManifest`: `Record<string, string>` mapping workflow names to versions
  - `entryAgentName`: which agent handles incoming requests
  - `environment`: `dev | staging | production`
  - `compilationHash`: cached hash of compiled IR
  - `modelOverrides`: per-agent model configuration overrides
  - `settingsVersionId`: pinned project settings
  - `promotedFromDeploymentId`: tracks promotion chain
  - `status`: `active | draining | retired`

### Deployment Creation Flow (`apps/runtime/src/routes/deployments.ts`)

1. Validate agent version manifest (all agents/versions must exist)
2. Auto-version support: `"auto"` creates a version from working copy DSL
3. Parse `irContent` from each `AgentVersion` record
4. Resolve `{{config.KEY}}` placeholders at deployment time via `resolveConfigVariables()`
5. Check for missing `{{env.KEY}}` references (warnings, not blocking)
6. Cache compiled IR via `sessionService.cacheCompilationOutput()`
7. Drain previous active deployment in same environment
8. Create new `Deployment` record
9. Auto-follow: update channels scoped to this environment

### Runtime Resolution (`apps/runtime/src/services/deployment-resolver.ts`)

Three resolution strategies in priority order:

1. **By deploymentId** -> load Deployment -> load AgentVersion IR -> serve
2. **By environment** -> find active Deployment for env -> delegate to strategy 1
3. **Working copy** -> compile DSL fresh (dev/debug only)

### What Is Snapshotted vs. Referenced Live

| Artifact                 | Snapshotted at Version/Deploy Time        | Referenced Live at Runtime                          |
| ------------------------ | ----------------------------------------- | --------------------------------------------------- |
| Agent DSL                | Yes (AgentVersion.dslContent)             | No                                                  |
| Compiled IR              | Yes (AgentVersion.irContent)              | No (cached, loaded from DB on miss)                 |
| Tool DSL                 | Yes (toolSnapshot)                        | No                                                  |
| Tool credentials/secrets | No                                        | Yes ({{secrets.X}} resolved at runtime)             |
| LLM model selection      | No (modelOverrides pinned per deployment) | Yes (model resolution chain)                        |
| LLM credentials          | No                                        | Yes (credentialId -> LLMCredential, decrypted live) |
| Environment variables    | No                                        | Yes ({{env.X}} resolved at runtime)                 |
| Config variables         | Baked into IR at deploy time              | No                                                  |
| Project settings         | Pinned via settingsVersionId              | Falls back to live if no pin                        |

---

## 3. Auth Profile Impact on Versioning and Deployment

### 3.1 Credentials Are Already Live-Referenced (Good News)

The current architecture already treats credentials as live-referenced, not snapshotted:

- `TenantModel.connections[].credentialId` points to `LLMCredential` records
- `{{secrets.X}}` in IR are resolved at runtime by `RuntimeSecretsProvider`
- `ToolSecret` records are queried live per-request
- `ChannelConnection.encryptedCredentials` are decrypted live

**This means Auth Profile can replace these live references transparently.** When a tool references `auth: my-profile` and it compiles to IR, the IR should store a reference (profile name or ID) that is resolved at runtime, not baked into the snapshot. This aligns with existing patterns.

### 3.2 DSL Name-to-ID Resolution Timing

The design doc says:

> Compiler resolves `auth: "name"` to `authProfileId` at compilation/deployment.

**Finding: This is partially correct but needs nuance.**

- **At compile time:** The compiler should validate that the named Auth Profile exists and record the reference in the IR (e.g., `authProfileId` or `authProfileName`).
- **At runtime:** The actual credential decryption must happen live, not baked into the IR. The IR should NOT contain decrypted secrets.

**Recommendation:** The IR should store `authProfileId` (resolved at compile/deploy time) rather than the name string. This avoids runtime name-resolution queries and provides a stable reference even if the profile is renamed. However, the IR must NOT store the decrypted secrets from the profile.

**Risk:** If the IR stores `authProfileId` and the Auth Profile is deleted between deploy and runtime, the agent fails. The design doc already covers this (Section 10: "Auth profile 'X' not found. Reconfigure authentication."), which is the correct behavior. This matches the existing pattern where a deleted `LLMCredential` would also cause runtime failure.

### 3.3 Auth Profile Rotation and Deployed Agents

**Question:** If an Auth Profile's API key is rotated, should deployed agents pick up the change?

**Answer: Yes, automatically.** Because credentials are live-referenced (not snapshotted), a rotated Auth Profile will be read fresh on the next request. The `rotationPolicy`, `previousEncryptedSecrets`, and `rotationGracePeriodMs` fields in the design doc support graceful rotation.

This is the correct behavior and matches how `LLMCredential` rotation works today: update the credential record, and all deployed agents pick it up immediately without redeployment.

### 3.4 Tool Snapshot Gap

Currently, `AgentVersion.toolSnapshot` captures tool DSL but not auth configuration. With Auth Profile:

- Tool snapshots should additionally record `authProfileId` (not secrets) for audit trail
- This enables answering "which Auth Profile was this version deployed with?"
- The actual credential values should never be in the snapshot

**Recommendation:** Extend `toolSnapshot` to include `authProfileId` and `authProfileName` fields for traceability.

---

## 4. Version Compatibility and Schema Evolution

### 4.1 Should Auth Profiles Themselves Be Versioned?

**Recommendation: No.** Auth Profiles are operational infrastructure, not application logic. They are analogous to environment variables and LLM credentials, which are also not versioned. Versioning would add complexity without clear benefit because:

- Credential rotation should be immediate (not deployment-gated)
- OAuth token refresh is continuous and automatic
- The auth type and configuration rarely change; when they do, it is an infrastructure change, not an application change

However, the `_v` field (optimistic concurrency) and `updatedAt` timestamp provide sufficient change tracking. The audit trail plugin provides full history if needed.

### 4.2 Backward Compatibility of AuthProfile Schema

Since Auth Profile uses a discriminated union (`authType` field) with `config` and `encryptedSecrets` as opaque blobs:

- **Adding new auth types:** Old code ignores unknown `authType` values. New types won't be selected by old consumers because consumers specify which types they support.
- **Adding new config fields:** The `config: Record<string, unknown>` and `encryptedSecrets: string` (encrypted JSON) are schema-flexible. New fields in these blobs are ignored by old code.
- **Adding new addon layers:** The optional `signing?`, `jwtWrapping?`, etc. fields are ignored by code that doesn't know about them.

**Risk:** If a deployed agent references an Auth Profile with a new `authType` that the runtime doesn't understand, it will fail. This is mitigated by deploy-time validation: the compiler/deployment route should validate that the runtime supports the referenced auth type.

### 4.3 Deleted Auth Profile Handling

Current behavior when dependencies are deleted:

- Missing `LLMCredential` -> model resolution falls back through the 5-level chain
- Missing `ToolSecret` -> `RuntimeSecretsProvider` returns undefined with warning
- Missing `EnvironmentVariable` -> template stays unresolved

Auth Profile should follow the `ToolSecret` pattern: explicit error ("Auth profile not found"), not silent fallback. The design doc's Section 10 correctly specifies this behavior.

---

## 5. Rolling Deployment Risks

### 5.1 Dual-Read During Migration

During rolling deployment, old pods read `LLMCredential` / `ToolSecret` while new pods read `AuthProfile`. This is the critical migration window.

**Current credential resolution paths:**

1. `TenantModel.connections[].credentialId` -> `LLMCredential` (for LLM calls)
2. `ToolSecret` (for `{{secrets.X}}` in tool auth)
3. `ChannelConnection.encryptedCredentials` (inline encrypted blob)
4. `ConnectorConfig.oauthTokenId` -> `EndUserOAuthToken` (for OAuth connectors)

**Migration safety strategy:**

| Step                  | Old Pods            | New Pods                                         | Database State        |
| --------------------- | ------------------- | ------------------------------------------------ | --------------------- |
| Pre-migration         | Read `credentialId` | N/A                                              | Only old fields       |
| Phase 1: Write both   | Read `credentialId` | Read `authProfileId`, fallback to `credentialId` | Both fields populated |
| Phase 2: All new pods | N/A                 | Read `authProfileId`, fallback to `credentialId` | Both fields populated |
| Phase 3: Cleanup      | N/A                 | Read `authProfileId` only                        | Remove old fields     |

### 5.2 Database Backward Compatibility

**Can old code ignore new `authProfileId` fields?** Yes. MongoDB is schema-flexible. Adding `authProfileId` to `TenantModel.connections[]`, `ConnectorConfig`, `ChannelConnection`, etc. is additive. Old code that reads `credentialId` will continue to work because that field is still present.

**Can new code fall back to old `credentialId` fields?** Yes, this is the recommended approach for Phase 1-2:

```typescript
// New code pattern during migration
const credential = entity.authProfileId
  ? await authProfileService.resolve({ authProfileId: entity.authProfileId, tenantId })
  : await legacyCredentialService.resolve({ credentialId: entity.credentialId, tenantId });
```

### 5.3 Specific Risks

1. **LLM resolution chain** (`model-resolution.ts`): The 5-level resolution chain ends at `findCredentialById(credentialId)`. The new code must add an `authProfileId` path at the same level. Since the resolution chain is linear and tenant-scoped, adding a branch is safe.

2. **Connection resolver** (`connection-resolver.ts`): Currently reads `encryptedCredentials` inline. Migration means the resolver must check `authProfileId` first, then fall back to `encryptedCredentials`.

3. **Secrets provider** (`secrets-provider.ts`): The `{{secrets.X}}` template resolution chain queries `ToolSecret`. With Auth Profile, the DSL changes from `{{secrets.KEY}}` to `auth: profile-name`, so the template system is bypassed entirely. Old agents using `{{secrets.X}}` continue to work (ToolSecret still queried); new agents use `auth:` syntax.

4. **Guardrail pipeline** (`guardrails/pipeline-factory.ts`): Currently uses `credentialId` on `TenantGuardrailProviderConfig`. Same dual-read pattern applies.

### 5.4 Zero-Downtime Migration Sequence

1. Deploy Auth Profile MongoDB collection and indexes (no app changes)
2. Deploy API CRUD routes for Auth Profile (additive, no breaking changes)
3. Deploy migration script: for each `LLMCredential`, create equivalent `AuthProfile`; for each consumer, set `authProfileId` alongside existing `credentialId`
4. Deploy runtime with dual-read logic (prefer `authProfileId`, fallback to `credentialId`)
5. Validate in staging with both paths exercised
6. Full rollout
7. (Later) Remove legacy `credentialId` references and old models

---

## 6. Environment Promotion (dev -> staging -> production)

### 6.1 How Promotion Works Today

The `POST /:deploymentId/promote` endpoint (`apps/runtime/src/routes/deployments.ts`):

- Clones a deployment from source environment to target environment
- Copies `agentVersionManifest`, `workflowVersionManifest`, `entryAgentName`, `compilationHash`, `settingsVersionId`
- Merges `modelOverrides` (source + request overrides layered on top)
- Sets `promotedFromDeploymentId` for traceability
- Drains the current active deployment in the target environment

**What is NOT promoted:**

- Environment variables (`{{env.X}}`) are per-environment by design
- LLM credentials are tenant-scoped (same across environments)
- Tool secrets have an `environment` field (per-environment)

### 6.2 Are Auth Profiles Environment-Specific?

**Current design:** Auth Profiles are scoped by `tenantId` + `projectId` (optional). There is no `environment` field.

**Analysis of existing patterns:**

| Entity                      | Environment-Specific?     | Notes                         |
| --------------------------- | ------------------------- | ----------------------------- |
| `EnvironmentVariable`       | Yes (`environment` field) | Different API keys per env    |
| `ToolSecret`                | Yes (`environment` field) | Different secrets per env     |
| `LLMCredential`             | No                        | Same across environments      |
| `TenantModel`               | No                        | Same model config across envs |
| `Deployment.modelOverrides` | Yes (per deployment)      | Override model at deploy time |

**Finding: Auth Profile's lack of environment scoping is a gap for some use cases.**

Consider: A tool that calls a third-party API might need different API keys for staging vs. production. Today, this is handled by `ToolSecret` with `environment` scoping or `EnvironmentVariable`. If Auth Profile replaces `ToolSecret`, the environment scoping is lost.

**Recommendation:** Auth Profile should support optional environment-specific overrides. Two approaches:

1. **Environment field on Auth Profile** (simple but creates N copies per profile):

   ```
   { name: "stripe-api", environment: "production", authType: "api_key", ... }
   { name: "stripe-api", environment: "staging", authType: "api_key", ... }
   ```

2. **Resolution priority with environment matching** (more elegant): Runtime resolves Auth Profile by checking project-level + environment first, then project-level (any env), then tenant-level. This aligns with the existing 4-level resolution priority in the design doc.

   The unique constraint `{ tenantId, projectId, name }` would need to become `{ tenantId, projectId, name, environment }` to support this.

**Impact on promotion:** If Auth Profiles are environment-specific, promotion does not need to copy Auth Profiles (they already exist per-environment). If they are NOT environment-specific, promotion is simpler (same profile used everywhere) but less flexible.

### 6.3 Promotion Safety

The current promotion endpoint clones the deployment record without touching credentials. Since Auth Profiles are live-referenced (not embedded in the deployment record), promotion naturally works:

- Agent version manifest is cloned (same IR, same `authProfileId` references in IR)
- At runtime in the target environment, the same `authProfileId` is resolved from the same Auth Profile collection
- If environment-specific Auth Profiles exist, the resolution chain picks the right one

**Risk:** If a profile exists in dev but not in production, the promoted deployment will fail at runtime. This should be validated at promotion time: the promote endpoint should check that all Auth Profiles referenced by the agent versions exist in the target environment.

---

## 7. Summary of Recommendations

### Must-Have for Auth Profile Design

1. **IR stores `authProfileId`, not decrypted secrets.** Credentials are resolved live at runtime. This aligns with existing patterns.

2. **Dual-read migration path.** New code must fall back to `credentialId` when `authProfileId` is absent. This enables zero-downtime rolling deployments.

3. **Environment scoping.** Add optional `environment` field (nullable, default null = all environments) to Auth Profile. Update unique constraint to `{ tenantId, projectId, name, environment }`. Resolution: environment-specific > any-environment > tenant-level.

4. **Promotion validation.** The promote endpoint should verify all Auth Profiles referenced by agent versions exist and are active in the target environment. Return warnings for missing profiles.

### Should-Have

5. **Tool snapshot enrichment.** Extend `AgentVersion.toolSnapshot` to include `authProfileId` and `authProfileName` for audit trail.

6. **Deploy-time auth type validation.** When creating a deployment, validate that the runtime supports all `authType` values referenced by the agents' Auth Profiles.

7. **Deletion protection for deployed agents.** Before deleting an Auth Profile, check if any active deployments reference it (via agent version IR). Block deletion or warn.

### Nice-to-Have

8. **Auth Profile health in deployment detail.** The `GET /:deploymentId` endpoint could include Auth Profile health status (active/expired/revoked) for operational visibility.

9. **Promotion diff.** Show which Auth Profiles differ between source and target environments during promotion review.

### Explicitly Not Needed

10. **Auth Profile versioning.** Auth Profiles are operational infrastructure. Credential rotation should be immediate, not deployment-gated. The `_v` field and audit trail provide sufficient change tracking.

---

## 8. File References

Key files analyzed:

- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/deployment.model.ts` - Deployment record schema
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/agent-version.model.ts` - Agent version with toolSnapshot
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/workflow-version.model.ts` - Workflow version schema
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/llm-credential.model.ts` - Current LLM credential (to be replaced)
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/tool-secret.model.ts` - Current tool secret with environment scoping
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/environment-variable.model.ts` - Environment-scoped variables
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/tenant-model.model.ts` - Tenant model with credentialId connections
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/connector-config.model.ts` - Connector with oauthTokenId
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/routes/deployments.ts` - Deployment create/promote/retire routes
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/deployment-resolver.ts` - Runtime deployment resolution
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/llm/model-resolution.ts` - 5-level LLM model resolution
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/repos/llm-resolution-repo.ts` - LLM credential queries
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/secrets-provider.ts` - Runtime secrets resolution
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/channels/connection-resolver.ts` - Channel credential resolution
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/version-service.ts` - Agent version creation with tool snapshots
- `/Users/prasannaarikala/projects/agent-platform/packages/compiler/src/platform/ir/schema.ts` - IR schema with auth types
