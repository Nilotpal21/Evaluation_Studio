# Field Comparison: koreserver → abl-platform

This document provides detailed field-by-field comparison between koreserver (Mongoose) and abl-platform (Prisma → MongoDB/ClickHouse) schemas.

---

## 1. Users

### koreserver `Users` → abl-platform `users`

| koreserver Field                  | abl-platform Field                      | Match | Notes                                                            |
| --------------------------------- | --------------------------------------- | ----- | ---------------------------------------------------------------- |
| `_id`                             | `_id`                                   | ✅    | Both use String ID                                               |
| `personalInfo.emailId[]`          | `email`                                 | ⚠️    | koreserver: array; abl: single string                            |
| `personalInfo.firstName`          | `name`                                  | ⚠️    | abl combines into single `name` field                            |
| `personalInfo.lastName`           | —                                       | ❌    | Not in abl (combined in `name`)                                  |
| `personalInfo.fullName`           | `name`                                  | ⚠️    | Mapping candidate                                                |
| `personalInfo.displayName`        | `name`                                  | ⚠️    | Mapping candidate                                                |
| `accountInfo.profImage`           | `avatarUrl`                             | ✅    | Same concept                                                     |
| `accountInfo.password`            | `passwordHash`                          | ✅    | Same concept (assumed hashed)                                    |
| `accountInfo.activationStatus`    | `emailVerified`                         | ⚠️    | Different representation                                         |
| `accountInfo.accountType`         | `authProvider`                          | ⚠️    | koreserver: 'kore'/'facebook'; abl: 'google'/'email'/'microsoft' |
| `accountInfo.createdOn`           | `createdAt`                             | ✅    | Same concept                                                     |
| `loginInfo.lastSuccessLogin`      | `lastLoginAt`                           | ✅    | Same concept                                                     |
| `accountInfo.orgID`               | —                                       | ❌    | abl uses membership model instead                                |
| `associatedOrgIds[]`              | —                                       | ❌    | abl uses `org_members` / `tenant_members`                        |
| `thresholdEvent.authentication.*` | `mfa.failedAttempts`, `mfa.lockedUntil` | ⚠️    | Similar lockout concept                                          |
| —                                 | `googleId`                              | ❌    | New in abl (OAuth)                                               |
| —                                 | `mfa.encryptedSecret`                   | ❌    | New in abl (TOTP)                                                |
| —                                 | `mfa.recoveryCodes[]`                   | ❌    | New in abl                                                       |
| `settings.*`                      | —                                       | ❌    | koreserver has extensive settings; abl is simpler                |
| `shareProfile.*`                  | —                                       | ❌    | koreserver-specific                                              |
| `roles[]`                         | —                                       | ❌    | abl uses membership model                                        |
| `groups[]`                        | —                                       | ❌    | koreserver-specific                                              |

### Key Differences

- **koreserver** has deeply nested structure (`personalInfo`, `accountInfo`, `settings`)
- **abl-platform** has flat structure with embedded `mfa` subdocument
- **koreserver** stores org membership in user; **abl** uses separate membership collections
- **koreserver** supports multiple email identities; **abl** has single email

---

## 2. Organizations / Accounts

### koreserver `Accounts` → abl-platform `organizations`

| koreserver Field         | abl-platform Field                   | Match | Notes                                   |
| ------------------------ | ------------------------------------ | ----- | --------------------------------------- |
| `_id`                    | `_id`                                | ✅    | —                                       |
| `accountName`            | `name`                               | ✅    | Same concept                            |
| —                        | `slug`                               | ❌    | New in abl (URL-friendly identifier)    |
| `createdBy`              | `ownerId`                            | ✅    | Similar concept                         |
| `billing.address`        | `billingConfig`                      | ⚠️    | abl stores as JSON object               |
| `contact.emailId`        | `billingEmail`                       | ✅    | Similar concept                         |
| `domainInfo[]`           | `domainMappings[]`                   | ✅    | Both embed domain verification          |
| `domainInfo[].dName`     | `domainMappings[].domain`            | ✅    | —                                       |
| `domainInfo[].vStatus`   | `domainMappings[].verified`          | ⚠️    | koreserver: enum; abl: boolean          |
| `domainInfo[].token`     | `domainMappings[].verificationToken` | ✅    | —                                       |
| `domainInfo[].verfiedOn` | `domainMappings[].verifiedAt`        | ✅    | —                                       |
| `ssoEnabled`             | `ssoConfigs[].isActive`              | ⚠️    | abl embeds full SSO config              |
| —                        | `ssoConfigs[].protocol`              | ❌    | New in abl ('saml'/'oidc')              |
| —                        | `ssoConfigs[].encryptedConfig`       | ❌    | New in abl                              |
| —                        | `ssoConfigs[].forceSso`              | ❌    | New in abl                              |
| `status`                 | —                                    | ❌    | abl has no org status                   |
| `createdOn`              | `createdAt`                          | ✅    | —                                       |
| `modifiedOn`             | `updatedAt`                          | ✅    | —                                       |
| `billing.payment[]`      | —                                    | ❌    | abl handles billing separately          |
| `associatedAccounts[]`   | —                                    | ❌    | koreserver-specific (account hierarchy) |
| `parentAccounts[]`       | —                                    | ❌    | koreserver-specific                     |
| `childAccounts[]`        | —                                    | ❌    | koreserver-specific                     |
| `defaultUserPermissions` | —                                    | ❌    | abl uses RBAC model                     |
| `tfa`                    | —                                    | ❌    | abl handles MFA at user level           |
| —                        | `compliance[]`                       | ❌    | New in abl                              |
| —                        | `settings`                           | ❌    | New in abl (JSON object)                |

### Key Differences

- **koreserver** `Accounts` handles billing inline; **abl** separates to `subscriptions`
- **koreserver** has account hierarchy (parent/child); **abl** is flat
- **abl** has explicit `slug` for URL routing
- **abl** embeds full SSO configuration; **koreserver** just has `ssoEnabled` flag

---

## 3. Tenants (Workspaces)

### koreserver `Organizations` → abl-platform `tenants`

| koreserver Field   | abl-platform Field             | Match | Notes                             |
| ------------------ | ------------------------------ | ----- | --------------------------------- |
| `_id`              | `_id`                          | ✅    | —                                 |
| `oName`            | `name`                         | ✅    | —                                 |
| —                  | `slug`                         | ❌    | New in abl                        |
| —                  | `organizationId`               | ❌    | New in abl (parent org reference) |
| `cB` (createdBy)   | `ownerId`                      | ✅    | —                                 |
| —                  | `retentionDays`                | ❌    | New in abl                        |
| `pS` (policyset)   | `settings`                     | ⚠️    | Different structure               |
| `status`           | `status`                       | ✅    | —                                 |
| `cOn` (createdOn)  | `createdAt`                    | ✅    | —                                 |
| `mOn` (modifiedOn) | `updatedAt`                    | ✅    | —                                 |
| `sP.pwdPolicy`     | —                              | ❌    | koreserver-specific               |
| `ldap`             | —                              | ❌    | koreserver-specific               |
| `teamsettings`     | —                              | ❌    | koreserver-specific               |
| `networkZones[]`   | —                              | ❌    | koreserver-specific               |
| `geolocations[]`   | —                              | ❌    | koreserver-specific               |
| —                  | `llmPolicy.*`                  | ❌    | New in abl                        |
| —                  | `llmPolicy.allowedProviders[]` | ❌    | New in abl                        |
| —                  | `llmPolicy.monthlyTokenBudget` | ❌    | New in abl                        |
| —                  | `llmPolicy.dailyTokenBudget`   | ❌    | New in abl                        |
| —                  | `llmPolicy.defaultModel`       | ❌    | New in abl                        |

### Key Differences

- **koreserver** `Organizations` is a sub-unit of `Accounts`
- **abl** `tenants` has embedded LLM policy for AI governance
- **koreserver** has extensive security/network settings
- **abl** has simpler tenant model focused on AI agent workspaces

---

## 4. Sessions

### koreserver `BotSession` → abl-platform `sessions`

| koreserver Field            | abl-platform Field | Match | Notes                                     |
| --------------------------- | ------------------ | ----- | ----------------------------------------- |
| `_id`                       | `_id`              | ✅    | —                                         |
| `sId` (streamId)            | —                  | ❌    | koreserver-specific (bot reference)       |
| `uId` (userId)              | `contactId`        | ⚠️    | Different naming                          |
| `oId` (orgId)               | `tenantId`         | ⚠️    | Different naming                          |
| `cT` (channelType)          | `channel`          | ✅    | —                                         |
| `sST` (sessionStartTime)    | `startedAt`        | ✅    | —                                         |
| `lAT` (lastActivityTime)    | `lastActivityAt`   | ✅    | —                                         |
| `sCT` (sessionCloseTime)    | `endedAt`          | ✅    | —                                         |
| `iV` (isValid)              | `status`           | ⚠️    | Different representation                  |
| `cL` (channelClient)        | `channel`          | ⚠️    | Combined in abl                           |
| `duration`                  | `callDuration`     | ✅    | Same concept                              |
| `meta`                      | `metadata`         | ✅    | Both use flexible object                  |
| `labels`                    | `tags[]`           | ⚠️    | Similar concept                           |
| `conversationId`            | `_id`              | ⚠️    | koreserver has separate field             |
| `iT` (interactionType)      | `channel`          | ⚠️    | abl uses channel instead                  |
| `regionId`                  | `region`           | ✅    | —                                         |
| `SA`                        | —                  | ❌    | koreserver SmartAssist-specific           |
| `bT` (botType)              | —                  | ❌    | koreserver-specific                       |
| `dChId` (deliveryChannelId) | `deploymentId`     | ⚠️    | Similar concept                           |
| —                           | `currentAgent`     | ❌    | New in abl (agent name)                   |
| —                           | `agentVersion`     | ❌    | New in abl                                |
| —                           | `environment`      | ❌    | New in abl ('dev'/'staging'/'production') |
| —                           | `entryAgentName`   | ❌    | New in abl                                |
| —                           | `workflowId`       | ❌    | New in abl                                |
| —                           | `workflowStepId`   | ❌    | New in abl                                |
| —                           | `parentId`         | ❌    | New in abl (nested sessions)              |
| —                           | `disposition`      | ❌    | New in abl                                |
| —                           | `dispositionCode`  | ❌    | New in abl                                |
| —                           | `context`          | ❌    | New in abl (JSON object)                  |
| —                           | `channelHistory[]` | ❌    | New in abl                                |
| —                           | `projectId`        | ❌    | New in abl                                |
| —                           | `messageCount`     | ❌    | New in abl (denormalized)                 |
| —                           | `tokenCount`       | ❌    | New in abl (denormalized)                 |
| —                           | `estimatedCost`    | ❌    | New in abl (denormalized)                 |
| —                           | `errorCount`       | ❌    | New in abl (denormalized)                 |
| —                           | `handoffCount`     | ❌    | New in abl (denormalized)                 |
| —                           | `billingPeriod`    | ❌    | New in abl                                |
| —                           | `isTest`           | ❌    | New in abl                                |

### Key Differences

- **koreserver** uses abbreviated field names (`sId`, `uId`, `oId`, `cT`)
- **abl** has descriptive field names (`sessionId`, `contactId`, `tenantId`, `channel`)
- **abl** tracks agent execution context (`currentAgent`, `agentVersion`, `environment`)
- **abl** has denormalized counters for analytics
- **abl** supports nested sessions via `parentId`
- **abl** has workflow integration (`workflowId`, `workflowStepId`)

---

## 5. Messages

### koreserver `Messages` → abl-platform `messages` (ClickHouse)

| koreserver Field             | abl-platform Field | Match | Notes                                           |
| ---------------------------- | ------------------ | ----- | ----------------------------------------------- |
| `_id`                        | `message_id`       | ✅    | —                                               |
| `from`                       | —                  | ❌    | abl uses `role` instead                         |
| `author`                     | —                  | ❌    | koreserver-specific                             |
| `to[]`                       | —                  | ❌    | koreserver-specific (recipients)                |
| `dO` (documentOwner)         | —                  | ❌    | koreserver-specific                             |
| `comps[].body`               | `content`          | ⚠️    | koreserver has components array                 |
| `comps[].cT` (componentType) | `role`             | ⚠️    | Different concept                               |
| —                            | `session_id`       | ❌    | New in abl (links to session)                   |
| —                            | `tenant_id`        | ❌    | New in abl                                      |
| —                            | `role`             | ❌    | New in abl ('user'/'assistant'/'system'/'tool') |
| —                            | `channel`          | ❌    | New in abl                                      |
| —                            | `trace_id`         | ❌    | New in abl                                      |
| —                            | `has_pii`          | ❌    | New in abl (PII detection)                      |
| —                            | `scrubbed`         | ❌    | New in abl (PII scrubbing)                      |
| `meta`                       | `metadata`         | ✅    | —                                               |
| `sO` (sentOn)                | `timestamp`        | ✅    | —                                               |
| `e` (encrypted)              | —                  | ❌    | koreserver has E2E encryption                   |
| `s[]` (signatures)           | —                  | ❌    | koreserver-specific                             |
| `cek` (contentEncryptionKey) | —                  | ❌    | koreserver-specific                             |
| `tId` (threadId)             | —                  | ❌    | koreserver-specific                             |
| `p[]` (policies)             | —                  | ❌    | koreserver-specific                             |
| `meta.rr[]` (readReceipts)   | —                  | ❌    | koreserver-specific                             |
| `compCnts` (componentCounts) | —                  | ❌    | koreserver-specific                             |

### Key Differences

- **koreserver** `Messages` is complex with encryption, signatures, policies, components
- **abl** `messages` is simple, optimized for ClickHouse analytics
- **koreserver** supports E2E encryption; **abl** stores plaintext (relies on at-rest encryption)
- **koreserver** has message components (text, audio, video, etc.); **abl** has single content field
- **abl** adds PII detection/scrubbing flags
- **abl** stores in **ClickHouse** for high-volume analytics (300M/day)

---

## 6. API Keys

### koreserver `ApiKey` → abl-platform `api_keys`

| koreserver Field      | abl-platform Field                     | Match | Notes                                      |
| --------------------- | -------------------------------------- | ----- | ------------------------------------------ |
| `_id`                 | `_id`                                  | ✅    | —                                          |
| `botId`               | `tenantId` + `projectIds[]`            | ⚠️    | abl scopes to tenant+projects              |
| `apiKey`              | `keyHash`                              | ⚠️    | koreserver stores plain; abl stores hash   |
| —                     | `prefix`                               | ❌    | New in abl (key prefix for identification) |
| —                     | `clientId`                             | ❌    | New in abl                                 |
| —                     | `name`                                 | ❌    | New in abl (human-readable name)           |
| —                     | `scopes[]`                             | ❌    | New in abl (permission scopes)             |
| —                     | `environments[]`                       | ❌    | New in abl (dev/staging/prod)              |
| `state`               | `isActive` + `expiresAt` + `revokedAt` | ⚠️    | abl has richer state                       |
| —                     | `lastUsedAt`                           | ❌    | New in abl                                 |
| —                     | `createdBy`                            | ❌    | New in abl                                 |
| —                     | `createdAt`                            | ❌    | New in abl                                 |
| `translationEngineId` | —                                      | ❌    | koreserver-specific                        |

### Key Differences

- **abl** has more sophisticated API key model with scopes, environments, expiration
- **abl** stores key hash (not plain key) for security
- **abl** has prefix for key identification without exposing full key
- **abl** separates public API keys (`pk_*`) for client-side use

---

## 7. Roles

### koreserver `Roles` → abl-platform `role_definitions`

| koreserver Field   | abl-platform Field | Match | Notes                                        |
| ------------------ | ------------------ | ----- | -------------------------------------------- |
| `_id`              | `_id`              | ✅    | —                                            |
| `orgId`            | `tenantId`         | ✅    | Same concept                                 |
| `role`             | `name`             | ✅    | —                                            |
| `rDesc`            | `description`      | ✅    | —                                            |
| `isASystemRole`    | `isSystem`         | ✅    | —                                            |
| `permissions`      | `permissions[]`    | ✅    | Both store permissions                       |
| `roleType`         | —                  | ❌    | koreserver-specific (system/admin/bot/agent) |
| `category`         | —                  | ❌    | koreserver-specific                          |
| `rStatus`          | —                  | ❌    | koreserver-specific                          |
| `mapping.users[]`  | —                  | ❌    | abl uses separate membership collections     |
| `mapping.groups[]` | —                  | ❌    | abl uses separate membership collections     |
| `mapping.bots[]`   | —                  | ❌    | koreserver-specific                          |
| `createdDate`      | `createdAt`        | ✅    | —                                            |
| `modifiedDate`     | `updatedAt`        | ✅    | —                                            |
| `createdBy`        | `createdBy`        | ✅    | —                                            |
| —                  | `parentRoleId`     | ❌    | New in abl (role inheritance)                |

### Key Differences

- **koreserver** embeds user/group mappings in role; **abl** uses separate membership collections
- **abl** supports role inheritance via `parentRoleId`
- **abl** has simpler permission model (JSON array)
- **koreserver** has role categories and types

---

## 8. LLM Configuration

### koreserver `llmconfiguration` → abl-platform `llm_credentials` + `tenant_models`

| koreserver Field        | abl-platform Collection | Field                 | Match | Notes                                    |
| ----------------------- | ----------------------- | --------------------- | ----- | ---------------------------------------- |
| `_id`                   | `llm_credentials`       | `_id`                 | ✅    | —                                        |
| `sId` (streamId)        | `llm_credentials`       | `tenantId`            | ⚠️    | Different scope                          |
| `uId` (createdBy)       | `llm_credentials`       | `userId`              | ✅    | —                                        |
| `integrations.*`        | `tenant_models`         | `*`                   | ⚠️    | Separated into model configs             |
| `integrations.*.apikey` | `llm_credentials`       | `encryptedApiKey`     | ✅    | —                                        |
| `cek`                   | `llm_credentials`       | `encryptedApiKey`     | ⚠️    | Different encryption approach            |
| `featureList[]`         | `tenant_models`         | `supports*` flags     | ⚠️    | abl has boolean flags                    |
| `featureList[].name`    | `tenant_models`         | `supportsTools`, etc. | ⚠️    | Mapped to capability flags               |
| `guardrailsList`        | —                       | —                     | ❌    | abl handles at agent DSL level           |
| `llmpii_patterns[]`     | —                       | —                     | ❌    | koreserver-specific PII patterns         |
| `state`                 | `llm_credentials`       | `isActive`            | ⚠️    | —                                        |
| `modifiedOn`            | `llm_credentials`       | `updatedAt`           | ✅    | —                                        |
| —                       | `tenant_models`         | `displayName`         | ❌    | New in abl                               |
| —                       | `tenant_models`         | `integrationType`     | ❌    | New in abl ('easy'/'api')                |
| —                       | `tenant_models`         | `modelId`             | ❌    | New in abl                               |
| —                       | `tenant_models`         | `provider`            | ❌    | New in abl                               |
| —                       | `tenant_models`         | `endpointUrl`         | ❌    | New in abl                               |
| —                       | `tenant_models`         | `requestTemplate`     | ❌    | New in abl (custom API)                  |
| —                       | `tenant_models`         | `responseMapping`     | ❌    | New in abl (custom API)                  |
| —                       | `tenant_models`         | `temperature`         | ❌    | New in abl                               |
| —                       | `tenant_models`         | `maxTokens`           | ❌    | New in abl                               |
| —                       | `tenant_models`         | `tier`                | ❌    | New in abl ('fast'/'balanced'/'quality') |
| —                       | `tenant_models`         | `connections[]`       | ❌    | New in abl (embedded)                    |

### Key Differences

- **koreserver** has single `llmconfiguration` document per bot
- **abl** separates credentials (`llm_credentials`) from model config (`tenant_models`)
- **abl** supports multiple model configurations per tenant
- **abl** has model tiers (fast/balanced/quality) for routing
- **abl** embeds connections in `tenant_models` for failover
- **koreserver** has PII patterns inline; **abl** handles at agent level

---

## 9. Subscriptions / Billing

### koreserver `subscription` → abl-platform `subscriptions`

| koreserver Field      | abl-platform Field               | Match | Notes                                     |
| --------------------- | -------------------------------- | ----- | ----------------------------------------- |
| `_id`                 | `_id`                            | ✅    | —                                         |
| `accountId`           | `organizationId`                 | ✅    | —                                         |
| —                     | `tenantId`                       | ❌    | New in abl (tenant-level subscription)    |
| `planId`              | `planTier`                       | ⚠️    | Different naming                          |
| `status`              | `status`                         | ✅    | —                                         |
| `startDate`           | `billingStartDate`               | ✅    | —                                         |
| `endDate`             | `billingEndDate`                 | ✅    | —                                         |
| `billingPeriodUnit`   | `billingCycle`                   | ✅    | —                                         |
| `billingSessions`     | `orgLimits`                      | ⚠️    | abl uses JSON object                      |
| `creditsAllowed`      | `orgLimits.tokenBudget`          | ⚠️    | Nested in abl                             |
| `planAmount`          | —                                | ❌    | koreserver-specific                       |
| `billingEmailAddress` | —                                | ❌    | abl stores in `organizations`             |
| `source`              | —                                | ❌    | koreserver-specific                       |
| —                     | `trialEndsAt`                    | ❌    | New in abl                                |
| —                     | `canceledAt`                     | ❌    | New in abl                                |
| —                     | `externalBillingId`              | ❌    | New in abl (Stripe integration)           |
| —                     | `externalCustomerId`             | ❌    | New in abl                                |
| —                     | `entitlements[]`                 | ❌    | New in abl                                |
| —                     | `tenantQuotas[]`                 | ❌    | New in abl (embedded hierarchical quotas) |
| —                     | `tenantQuotas[].projectQuotas[]` | ❌    | New in abl (2-level quota hierarchy)      |

### Key Differences

- **abl** has hierarchical quota system (org → tenant → project)
- **abl** embeds `tenantQuotas[]` and `projectQuotas[]` for quota allocation
- **abl** supports external billing integration (Stripe)
- **abl** has feature entitlements array
- **koreserver** handles quotas differently (separate from subscription)

---

## Summary: Field Coverage

| Collection             | koreserver Fields | abl-platform Fields | Overlap |
| ---------------------- | ----------------- | ------------------- | ------- |
| Users                  | ~50+              | ~15                 | ~30%    |
| Organizations/Accounts | ~40+              | ~15                 | ~25%    |
| Tenants                | ~30+              | ~15                 | ~20%    |
| Sessions               | ~25               | ~35                 | ~40%    |
| Messages               | ~30+              | ~12                 | ~20%    |
| API Keys               | ~5                | ~15                 | ~30%    |
| Roles                  | ~20               | ~10                 | ~50%    |
| LLM Config             | ~15               | ~40 (split)         | ~30%    |
| Subscriptions          | ~20               | ~20                 | ~40%    |

### Overall Assessment

1. **Low Overlap (~20-30%)**: Users, Messages, Organizations
   - Significantly different schemas; requires transformation logic

2. **Medium Overlap (~30-50%)**: Sessions, API Keys, Roles, LLM Config, Subscriptions
   - Core concepts similar; field mapping possible with transformations

3. **Migration Considerations**:
   - **koreserver** uses abbreviated field names; **abl** uses descriptive names
   - **koreserver** has deeply nested structures; **abl** prefers flatter schemas
   - **abl** separates concerns (credentials vs config, metadata vs high-volume data)
   - **abl** uses ClickHouse for analytics data; requires different write patterns
   - Both systems need custom transformation layer for migration
