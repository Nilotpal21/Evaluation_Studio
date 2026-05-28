# Auth Profile Impact on Import, Export, Cloning & Portability

> **Review of:** `docs/plans/2026-03-11-auth-profile-design.md`
> **Date:** 2026-03-11
> **Scope:** How Auth Profile affects agent/project export, import, cloning, cross-tenant movement, templates, and disaster recovery.

---

## 1. Current State of Export/Import

### 1.1 Export System

The platform has a mature, layered export system with two versions:

- **v1 (legacy):** Exports agents + tools + optional deployments as a file map (JSON). Route: `GET /api/projects/:id/export`. Uses `exportProject()` from `@agent-platform/project-io/export`.
- **v2 (layered):** Supports 8 discrete layers: `core`, `connections`, `guardrails`, `workflows`, `evals`, `search`, `channels`, `vocabulary`. Each layer has a dedicated assembler class. Route uses `exportProjectV2()`.
- **Bundle export:** `GET /api/projects/:id/bundle` produces a ZIP archive with `manifest.json` + agent YAML files.
- **Async export:** `POST /api/projects/:id/export/async` queues large exports via BullMQ.

**Key files:**

- `/apps/studio/src/app/api/projects/[id]/export/route.ts`
- `/packages/project-io/src/export/project-exporter.ts`
- `/packages/project-io/src/export/layer-assemblers/connections-assembler.ts`
- `/packages/project-io/src/export/manifest-generator.ts`
- `/packages/project-io/src/export/env-var-scanner.ts`

### 1.2 Import System

- **Preview:** `POST /api/projects/:id/import/preview` validates files and generates a diff report without applying.
- **Apply (v1):** `POST /api/projects/:id/import/apply` creates/updates/deletes agents with batch rollback on failure.
- **Apply (v2, staged):** `POST /api/projects/:id/import/apply?staged=true` uses `StagedImporter` with activation/rollback per layer.
- **Post-import doctor:** `GET /api/projects/:id/import/doctor` scans for missing env vars, connectors needing credentials, MCP servers needing auth, and unconfigured guardrail providers.

**Key files:**

- `/apps/studio/src/app/api/projects/[id]/import/preview/route.ts`
- `/apps/studio/src/app/api/projects/[id]/import/apply/route.ts`
- `/apps/studio/src/app/api/projects/[id]/import/doctor/route.ts`
- `/packages/project-io/src/import/post-import-validator.ts`

### 1.3 What Gets Exported Today

| Content           | v1       | v2                      | Includes Secrets?                                                                                           |
| ----------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Agent DSL         | Yes      | Yes (core layer)        | No (DSL has `{{secrets.KEY}}` refs)                                                                         |
| Tool DSL          | Yes      | Yes (core layer)        | No                                                                                                          |
| Connections       | No       | Yes (connections layer) | **No** — `ConnectionsAssembler` strips `encryptedCredentials`, `encryptionKeyVersion`, `oauth2RefreshToken` |
| Connector configs | No       | Yes (connections layer) | **No** — strips `oauthTokenId`, `syncState`, `errorState`                                                   |
| Guardrails        | No       | Yes                     | No                                                                                                          |
| Workflows         | No       | Yes                     | No                                                                                                          |
| Deployments       | Optional | Optional                | No (config overrides only)                                                                                  |

### 1.4 How Credentials Are Handled During Export

The `ConnectionsAssembler` explicitly strips secret fields via `stripInternalFields()`:

```typescript
const CONNECTION_SECRET_KEYS = [
  'encryptedCredentials',
  'encryptionKeyVersion',
  'oauth2RefreshToken',
];
```

The `env-var-scanner.ts` extracts `{{env.KEY}}` and `{{secrets.KEY}}` references from DSL content and records them in the v2 manifest under `metadata.required_env_vars`.

### 1.5 How Import Handles Missing Credentials

The post-import validator (`PostImportReport`) reports:

- `provisioning_required.env_vars` — env vars referenced in DSL but not defined
- `provisioning_required.connectors_needing_credentials` — connectors without encrypted credentials
- `provisioning_required.mcp_servers_needing_auth` — MCP servers missing auth config

Status is `action_required` if any provisioning is missing. This is read-only reporting — import does not auto-create credentials.

### 1.6 Tool Export/Import and Duplication

- **Tool export:** `GET /api/projects/:id/tools/:toolId/export` strips `id` and `projectId`, returns sanitized JSON.
- **Tool import:** `POST /api/projects/:id/tools/import` accepts the export JSON, validates name/type/DSL, checks SSRF for HTTP tools. Does not handle any credential references.
- **Tool duplicate:** `POST /api/projects/:id/tools/:toolId/duplicate` copies within the same project, generates unique name. No credential copying.

### 1.7 Pipeline Cloning

`POST /api/pipelines/:pipelineId/clone` copies pipeline definition (trigger, steps, input schema) within the same tenant/project. Does not copy any credential or auth references — the cloned pipeline inherits the project context.

### 1.8 No Project-Level Clone or Template System

There is **no project clone endpoint** and **no marketplace/template system**. The closest equivalent is export + import into a new project. The `sdk/share` route generates preview tokens but does not export project content.

---

## 2. Impact Analysis: Auth Profile on Export/Import

### 2.1 What Changes in the Export Format

With Auth Profile, the following new data types must be considered for export:

| Entity                              | Current Export Behavior                   | Auth Profile Impact                                                                                |
| ----------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Agent DSL `auth: profile-name`      | DSL exported as-is with `{{secrets.KEY}}` | DSL now contains `auth: my-profile-name` string references. These are **name-based** and portable. |
| Connection's `encryptedCredentials` | Stripped by `ConnectionsAssembler`        | Replaced by `authProfileId` — also stripped, but the **reference** should be exported as metadata. |
| `ConnectorConfig.authProfileId`     | Not yet present                           | New field — export should include the profile name (not ID), auth type, and non-secret config.     |
| `MCPServerConfig.authProfileId`     | Not yet present                           | Same treatment.                                                                                    |
| `ChannelConnection.authProfileId`   | Not yet present                           | Same treatment.                                                                                    |

### 2.2 Critical Gap: Auth Profile Metadata Not in Export

**Finding:** The current export system does not have an "auth profiles" layer or assembler. The v2 manifest's `metadata` block has `required_env_vars`, `required_connectors`, and `required_mcp_servers`, but **no `required_auth_profiles`** field.

**Recommendation: Add an `auth_profiles` layer to the export system.**

The exported auth profile data should include:

```json
{
  "auth_profiles": [
    {
      "name": "production-openai",
      "authType": "api_key",
      "config": {
        "headerName": "Authorization",
        "prefix": "Bearer",
        "placement": "header"
      },
      "scope": "tenant",
      "visibility": "shared",
      "category": "llm",
      "connector": null,
      "tags": ["production"],
      "addons": {
        "signing": null,
        "jwtWrapping": null,
        "webhookVerification": null,
        "certificatePinning": null,
        "proxy": null
      }
    }
  ]
}
```

**Secrets must NEVER be exported.** The `encryptedSecrets`, `previousEncryptedSecrets`, `encryptionKeyVersion`, and OAuth tokens are excluded.

### 2.3 DSL Auth References: Name-Based Portability

The design doc specifies DSL uses `auth: my-profile-name` string references:

```yaml
TOOLS:
  - openai.chat:
      auth: production-openai
```

**This is the correct design for portability.** Name-based references survive export/import because:

1. The DSL text is exported verbatim.
2. On import, the name resolves against the target project's Auth Profiles.
3. If the profile doesn't exist, the post-import doctor can report it.

However, the design doc also states the compiler resolves `auth: "name"` to `authProfileId` at compilation/deployment. This means:

- **Export should contain raw DSL (with name references), not compiled IR.** This is already the case.
- **The name uniqueness constraint `{ tenantId, projectId, name }` ensures the reference is unambiguous within a scope.**

### 2.4 Connection Mode Portability (`shared` vs `per_user`)

The DSL `connection: shared` and `connection: per_user` are text-level declarations. They export correctly as part of the DSL content.

**Import implications by connection mode:**

| Mode                   | Import Behavior                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection: shared`   | Requires a shared `oauth2_token` Auth Profile to exist in the target project. Import doctor should flag if missing.                                                       |
| `connection: per_user` | No provisioning needed at import time — tokens are created at runtime when end users authorize. The `oauth2_app` Auth Profile (Layer 1) must exist in the target project. |

**Gap:** The import doctor does not currently distinguish between `shared` (needs a pre-existing token) and `per_user` (needs only the app credentials). The doctor should report:

- "This agent requires a shared Gmail connection. Create an Auth Profile of type `oauth2_token` for Gmail."
- "This agent requires per-user Gmail authorization. Ensure an `oauth2_app` Auth Profile for Gmail exists."

### 2.5 V2 Manifest Enhancement

The `ProjectManifestV2.metadata` should gain a new field:

```typescript
metadata: {
  entity_counts: Record<string, number>;
  required_env_vars: string[];
  required_connectors: string[];
  required_mcp_servers: string[];
  // NEW
  required_auth_profiles: Array<{
    name: string;
    authType: string;
    connector?: string;
    connectionMode?: 'shared' | 'per_user';
    referencedBy: string[]; // agent/tool names
  }>;
};
```

This enables the import wizard to present a mapping table.

---

## 3. Import Wizard: Auth Profile Mapping

### 3.1 Current Import Flow

1. User uploads files (JSON file map).
2. Preview endpoint validates and shows diff.
3. User confirms, apply endpoint executes.
4. Post-import doctor reports missing provisioning.

### 3.2 Proposed Import Flow with Auth Profiles

1. User uploads files.
2. **Preview endpoint extracts auth profile requirements** from:
   - `auth:` references in agent/tool DSL
   - `authProfileId` references in connection JSON files
   - Manifest `required_auth_profiles` metadata
3. **Import preview response includes an `auth_mapping` section:**

```json
{
  "preview": {
    "auth_mapping": {
      "required": [
        {
          "name": "production-openai",
          "authType": "api_key",
          "connector": null,
          "status": "missing",
          "candidates": []
        },
        {
          "name": "gmail-app",
          "authType": "oauth2_app",
          "connector": "gmail",
          "status": "found",
          "candidates": [{ "id": "ap-xxx", "name": "Gmail OAuth App", "authType": "oauth2_app" }]
        }
      ]
    }
  }
}
```

4. **UI presents a mapping table:**

| Required Auth Profile | Type       | Status                   | Action                             |
| --------------------- | ---------- | ------------------------ | ---------------------------------- |
| production-openai     | api_key    | Missing                  | [Create New] / [Select Existing v] |
| gmail-app             | oauth2_app | Found: "Gmail OAuth App" | [Use This] / [Select Different v]  |

5. User resolves mappings. Import apply sends the mapping:

```json
{
  "files": { ... },
  "authProfileMapping": {
    "production-openai": "ap-new-id-or-create",
    "gmail-app": "ap-xxx"
  }
}
```

6. Apply endpoint uses the mapping to update DSL references or connection records.

### 3.3 Name Collision Handling

When importing into a project that already has an Auth Profile with the same name but different config:

| Scenario                                   | Behavior                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Same name, same authType, same config      | Auto-map (use existing)                                                                                       |
| Same name, same authType, different config | Warn user: "Auth Profile 'X' exists but has different configuration. Use existing or create as 'X-imported'?" |
| Same name, different authType              | Error: "Auth Profile 'X' exists as api_key but import requires oauth2_app. Rename or remap."                  |

---

## 4. Cross-Project and Cross-Tenant Movement

### 4.1 Cross-Project Movement (Same Tenant)

**Current state:** No explicit "move agent between projects" feature. The pattern is export + import.

**Auth Profile impact:**

- Tenant-scoped Auth Profiles (`scope: 'tenant'`) are shared across projects. An agent referencing `auth: production-openai` (tenant-scoped) will resolve correctly after import to a different project in the same tenant.
- Project-scoped Auth Profiles (`scope: 'project'`) must be re-created in the target project. The post-import doctor should detect this.

**Recommendation:** When moving agents within the same tenant, the import preview should check if referenced Auth Profiles exist at the tenant level. If they do, no action is needed. Only project-scoped profiles need creation.

### 4.2 Cross-Tenant Movement

**Current state:** No cross-tenant agent transfer. Export/import is the only mechanism.

**Auth Profile impact is significant:**

1. **All `authProfileId` references become invalid** — IDs are tenant-scoped.
2. **Auth Profile names may not exist** in the target tenant.
3. **OAuth app credentials are different** — each tenant has its own OAuth apps.
4. **Encryption keys are per-tenant** — `encryptJsonForTenant(data, tenantId)` derives keys from `masterKey + tenantId`. Secrets cannot be decrypted in a different tenant context even if the master key is the same.

**Recommendation:** Cross-tenant import must:

1. Strip all `authProfileId` values from imported connection records.
2. Present the auth mapping wizard (section 3.2 above).
3. Never attempt to copy encrypted secrets across tenants.

### 4.3 Agent Transfer (IVR/Voice Context)

The `agent-transfer` routes (`/api/projects/:id/agent-transfer/settings`, `/sessions`) are for **live call transfer between agents during a voice session**, not for project-level agent movement. They proxy to the runtime service and do not involve Auth Profile at all.

**No impact on Auth Profile portability.**

---

## 5. DSL Portability Analysis

### 5.1 Name-Based References (Correct Choice)

The design specifies `auth: my-profile-name` in DSL. This is the right choice over ID-based references because:

1. **Human-readable:** Developers can understand what auth is used.
2. **Portable:** Names are meaningful across contexts; IDs are opaque.
3. **Git-friendly:** Name changes are visible in diffs.

### 5.2 Resolution Ambiguity

The name uniqueness constraint is `{ tenantId, projectId, name }`. This means:

- A tenant-level profile named "openai" and a project-level profile named "openai" can coexist.
- Resolution priority (from the design doc): project-level > tenant-level.

**Risk:** An exported agent referencing `auth: openai` may resolve to a different profile in the target project if both tenant and project levels have "openai".

**Recommendation:** The manifest should record the **scope** of each referenced auth profile:

```yaml
required_auth_profiles:
  - name: openai
    scope: tenant # or project
    authType: api_key
```

This helps the import wizard distinguish between "this agent expects a tenant-level profile" vs "this agent expects a project-level override."

### 5.3 Env Var and Secret Reference Migration

Currently, DSL uses `{{secrets.KEY}}` for inline secrets. The design doc says Auth Profile replaces `ToolSecret`, changing DSL from `{{secrets.KEY}}` to `auth: my-profile-name`.

**Migration impact on existing exports:**

- Old exports with `{{secrets.KEY}}` will still import correctly (backward compat).
- New exports with `auth: profile-name` require Auth Profile infrastructure.
- The env-var scanner (`scanProjectEnvVars`) should be extended to also scan for `auth:` references.

---

## 6. Template and Marketplace Implications

### 6.1 Current State

There is no template or marketplace system. The closest equivalents are:

- **Export/import:** Manual file-based sharing.
- **SDK share:** Generates a preview token for a running project (not a template).
- **Seed data:** `POST /api/seed-data` for dev bootstrapping.

### 6.2 Future Template System Considerations

If a template/marketplace is built, Auth Profile creates specific requirements:

1. **Templates must declare auth requirements** in a standard format (the `required_auth_profiles` manifest field).
2. **Template instantiation = import + auth mapping wizard.** The user creates or links Auth Profiles during template setup.
3. **Template categories should align with Auth Profile categories** (`llm`, `connector`, `tool`, `channel`, `infrastructure`).
4. **Shareable templates must never include secrets.** The current `ConnectionsAssembler` pattern of stripping secrets is correct and should be the model for all template packaging.

### 6.3 OAuth App Templates

For `oauth2_app` profiles, templates could include:

- The OAuth provider name (e.g., "Google", "Slack")
- Required scopes
- Setup guide URL (from the design doc's Nango integration)
- Authorization URL, token URL (non-secret config)

But NOT `clientId`/`clientSecret`. The setup wizard guides the user to create their own OAuth app.

---

## 7. Backup and Disaster Recovery

### 7.1 Encryption Architecture

The platform uses AES-256-GCM encryption with tenant-scoped key derivation:

```typescript
// From packages/shared/src/encryption/engine.ts
encryptJsonForTenant<T>(data: T, tenantId: string): string
decryptJsonForTenant<T>(encrypted: string, tenantId: string): T
```

Key derivation uses `masterKey + tenantId` as input to PBKDF2 or HKDF, producing a per-tenant encryption key. The master key is set via `ENCRYPTION_MASTER_KEY` environment variable.

### 7.2 Auth Profile Backup Implications

| Scenario                                      | Impact                                                              | Mitigation                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Database backup/restore (same master key)** | Auth Profiles with `encryptedSecrets` restore correctly. No issues. | Standard MongoDB backup/restore.                                                                                                                                                               |
| **Master key rotation**                       | All `encryptedSecrets` become undecryptable.                        | Must re-encrypt all Auth Profiles during key rotation. The `encryptionKeyVersion` field supports this — implement a migration script that decrypts with old key and re-encrypts with new key.  |
| **Master key lost**                           | All encrypted secrets are permanently lost.                         | Master key must be stored in HSM/Vault with redundancy. Auth Profiles with `status: 'invalid'` should trigger re-provisioning flows.                                                           |
| **Cross-environment restore** (dev → staging) | If master keys differ, secrets are undecryptable.                   | Either use same master key across environments (not recommended for prod) or accept that secrets need re-provisioning. Auth Profile metadata (name, type, config) is unencrypted and survives. |
| **Tenant migration**                          | `tenantId` changes key derivation salt. Secrets cannot decrypt.     | Must decrypt with source tenant context and re-encrypt with target tenant context during migration.                                                                                            |

### 7.3 Auth Profile `encryptionKeyVersion` Field

The design includes `encryptionKeyVersion` on each Auth Profile. This is essential for:

1. **Rolling key rotation:** New profiles use version N+1, old profiles still decrypt with version N until migrated.
2. **Backup restoration:** If restoring from a backup taken before key rotation, the version field indicates which key to use.
3. **Audit:** Track when secrets were last re-encrypted.

**Recommendation:** Add a bulk re-encryption endpoint:

```
POST /api/admin/auth-profiles/re-encrypt
Body: { fromKeyVersion: 1, toKeyVersion: 2 }
```

This should process in batches with progress reporting, as large tenants may have thousands of Auth Profiles.

### 7.4 Rotation Policy and Backup

The design includes `rotationPolicy`, `previousEncryptedSecrets`, and `rotationGracePeriodMs`. During backup/restore:

- If restored to a point during a rotation grace period, both current and previous secrets must be valid.
- The `rotationGracePeriodMs` should be relative to `updatedAt`, not an absolute timestamp, to survive time-shifted restores.

---

## 8. Specific Code Changes Required

### 8.1 Export Side

| File                                                                              | Change                                                                                                                                              |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/project-io/src/types.ts`                                                | Add `required_auth_profiles` to `ProjectManifestV2.metadata`. Add `LayerName` value `'auth_profiles'` (or keep as metadata-only, not a full layer). |
| `packages/project-io/src/export/env-var-scanner.ts`                               | Add `extractAuthProfileReferences(dslContent): string[]` to scan for `auth: profile-name` in DSL.                                                   |
| `packages/project-io/src/export/manifest-generator.ts`                            | Populate `required_auth_profiles` in `generateManifestV2()`.                                                                                        |
| `packages/project-io/src/export/layer-assemblers/connections-assembler.ts`        | Export `authProfileId` as `authProfileName` (resolve ID to name before export). Strip the ID itself.                                                |
| New: `packages/project-io/src/export/layer-assemblers/auth-profiles-assembler.ts` | (Optional) Full assembler that exports Auth Profile metadata without secrets.                                                                       |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`                           | Pass auth profile data to `exportProjectV2()`.                                                                                                      |

### 8.2 Import Side

| File                                                            | Change                                                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/project-io/src/import/post-import-validator.ts`       | Add `getProjectAuthProfiles()` to `PostImportDbAdapter`. Check referenced auth profiles exist. Distinguish `shared` vs `per_user` requirements. |
| `packages/project-io/src/import/project-importer.ts`            | Extract `auth:` references from imported DSL. Include in validation results.                                                                    |
| `apps/studio/src/app/api/projects/[id]/import/preview/route.ts` | Return `auth_mapping` in preview response with candidates from existing Auth Profiles.                                                          |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`   | Accept `authProfileMapping` in request body. Remap `authProfileId` in imported connection records.                                              |
| `apps/studio/src/app/api/projects/[id]/import/doctor/route.ts`  | Check auth profiles in doctor report.                                                                                                           |

### 8.3 Manifest v2 Schema

Add to `ProjectManifestV2.metadata`:

```typescript
required_auth_profiles: Array<{
  name: string;
  authType: string;
  scope: 'tenant' | 'project';
  connector?: string;
  category?: string;
  connectionMode?: 'shared' | 'per_user';
  config: Record<string, unknown>; // non-secret config only
  addons?: {
    signing?: boolean;
    jwtWrapping?: boolean;
    webhookVerification?: boolean;
    certificatePinning?: boolean;
    proxy?: boolean;
  };
  referencedBy: string[]; // agent/tool names
}>;
```

---

## 9. Risk Assessment

| Risk                                                                     | Severity   | Likelihood                          | Mitigation                                                                |
| ------------------------------------------------------------------------ | ---------- | ----------------------------------- | ------------------------------------------------------------------------- |
| Exported agents fail silently after import due to missing Auth Profile   | **High**   | High (no current tooling to detect) | Extend post-import doctor. Add auth profile requirements to manifest.     |
| Cross-tenant import loses all auth — user doesn't know what to recreate  | **High**   | High                                | Auth mapping wizard with clear requirements list.                         |
| Name collision during import (same name, different config)               | **Medium** | Medium                              | Detect and present rename/remap options.                                  |
| Template sharing exposes OAuth app credentials                           | **High**   | Low (currently stripped)            | Maintain strict secret stripping. Audit all export paths.                 |
| Master key rotation breaks restored backups                              | **High**   | Low                                 | Implement versioned re-encryption. Store key versions in backup metadata. |
| DSL `auth: name` resolves to wrong profile due to tenant/project overlap | **Medium** | Low                                 | Record scope in manifest. Validate during import.                         |

---

## 10. Summary of Recommendations

1. **Add `required_auth_profiles` to the v2 export manifest** — extract `auth:` references from DSL, resolve to profile metadata, include non-secret config.

2. **Build an import auth mapping wizard** — preview endpoint returns required auth profiles with match candidates; apply endpoint accepts the mapping.

3. **Extend the post-import doctor** — check auth profiles exist and have valid credentials, distinguish `shared` (needs token) vs `per_user` (needs app credentials).

4. **Export connections with `authProfileName` instead of `authProfileId`** — name-based references survive cross-project and cross-tenant import.

5. **Never export encrypted secrets** — maintain the current `ConnectionsAssembler` pattern of stripping sensitive fields. Auth Profile metadata (type, config, addons) is sufficient.

6. **Implement bulk re-encryption** for master key rotation and tenant migration scenarios.

7. **Record auth profile scope in the manifest** to avoid ambiguity between tenant-level and project-level profiles during import.

8. **Design for future templates/marketplace** — the `required_auth_profiles` manifest format becomes the standard for declaring what auth a template needs.
