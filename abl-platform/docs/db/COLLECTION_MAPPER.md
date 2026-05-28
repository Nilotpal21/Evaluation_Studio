# Collection Mapper: koreserver → abl-platform

This document maps collections from koreserver (Mongoose/MongoDB) to abl-platform (Prisma → MongoDB/ClickHouse).

## Quick Reference

| koreserver Collection | abl-platform Collection                   | Database   | Relevance            |
| --------------------- | ----------------------------------------- | ---------- | -------------------- |
| `Users`               | `users`                                   | MongoDB    | ✅ High              |
| `Accounts`            | `organizations`                           | MongoDB    | ✅ High              |
| `Organizations`       | `tenants`                                 | MongoDB    | ✅ High              |
| `BotSession`          | `sessions`                                | MongoDB    | ✅ High              |
| `Message`             | `messages`                                | ClickHouse | ✅ High              |
| `ApiKey`              | `api_keys`                                | MongoDB    | ✅ High              |
| `auditlogs`           | `audit_logs` (control-plane)              | MongoDB    | ✅ High              |
| —                     | `audit_events` (runtime)                  | ClickHouse | ✅ High              |
| `llmconfiguration`    | `llm_credentials` + `tenant_models`       | MongoDB    | ✅ High              |
| `Roles`               | `role_definitions`                        | MongoDB    | ✅ High              |
| `Permissions`         | `resource_permissions` + `resource_types` | MongoDB    | ✅ High              |
| `subscription`        | `subscriptions`                           | MongoDB    | ✅ High              |
| `BillingEvents`       | `usage_periods`                           | MongoDB    | ⚠️ Medium            |
| `widgetThemes`        | `widget_configs`                          | MongoDB    | ⚠️ Medium            |
| `toollibraries`       | `service_nodes`                           | MongoDB    | ⚠️ Medium            |
| `Authorizations`      | `end_user_oauth_tokens`                   | MongoDB    | ⚠️ Medium            |
| `WorkflowAssignment`  | `workflows`                               | MongoDB    | ⚠️ Medium            |
| `Contacts`            | —                                         | —          | ❌ Different concept |

---

## Detailed Mappings

### 1. Users & Authentication

| koreserver                      | abl-platform                | Notes                                                                                                                                        |
| ------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Users`                         | `users`                     | koreserver has embedded `personalDetails`, `accountDetails`, `loginInfo`, `thresholdEvent`; abl-platform embeds `mfa` with `recoveryCodes[]` |
| `Users.accountDetails.password` | `users.passwordHash`        | Field naming difference                                                                                                                      |
| `Users.personalDetails.email`   | `users.email`               | Nested vs flat                                                                                                                               |
| —                               | `refresh_tokens`            | koreserver uses different session management                                                                                                 |
| —                               | `email_verification_tokens` | koreserver handles differently                                                                                                               |
| —                               | `password_reset_tokens`     | koreserver handles differently                                                                                                               |

**Key Differences:**

- koreserver `Users` is deeply nested (personalDetails, accountDetails, etc.)
- abl-platform `users` is flatter with embedded `mfa` subdocument

---

### 2. Organizations & Tenants

| koreserver                 | abl-platform                     | Notes                                       |
| -------------------------- | -------------------------------- | ------------------------------------------- |
| `Accounts`                 | `organizations`                  | Top-level account = abl organization        |
| `Accounts.accountId`       | `organizations._id`              | —                                           |
| `Accounts.billingInfo`     | `organizations.billingConfig`    | Similar structure                           |
| `Accounts.domainInfo`      | `organizations.domainMappings[]` | abl embeds as array                         |
| `Accounts.securityProfile` | `organizations.ssoConfigs[]`     | abl embeds SSO config                       |
| `Organizations`            | `tenants`                        | koreserver "org" = abl "tenant" (workspace) |
| `Organizations.orgId`      | `tenants._id`                    | —                                           |
| `Organizations.accountId`  | `tenants.organizationId`         | Parent reference                            |
| —                          | `org_members`                    | abl has explicit membership model           |
| —                          | `tenant_members`                 | abl has explicit membership model           |
| —                          | `tenant_transfers`               | abl-specific feature                        |
| —                          | `workspace_invitations`          | abl-specific feature                        |

**Key Differences:**

- koreserver hierarchy: Account → Organization → Bot
- abl-platform hierarchy: Organization → Tenant → Project → Agent

---

### 3. Sessions & Messages

| koreserver           | abl-platform         | Database   | Notes                                      |
| -------------------- | -------------------- | ---------- | ------------------------------------------ |
| `BotSession`         | `sessions`           | MongoDB    | Conversation metadata                      |
| `BotSession.sId`     | `sessions._id`       | —          | streamId → session id                      |
| `BotSession.uId`     | `sessions.contactId` | —          | userId = contact                           |
| `BotSession.oId`     | `sessions.tenantId`  | —          | orgId = tenant                             |
| `BotSession.cT`      | `sessions.channel`   | —          | channelType                                |
| `Message`            | `messages`           | ClickHouse | High-volume message storage                |
| `Message.type`       | `messages.role`      | —          | 'incoming'/'outgoing' → 'user'/'assistant' |
| `Message.content`    | `messages.content`   | —          | Same concept                               |
| `Message.components` | `messages.metadata`  | —          | Embedded vs JSON                           |

**Key Differences:**

- koreserver stores messages in MongoDB with encryption support
- abl-platform stores messages in ClickHouse for high-volume analytics
- koreserver `Message` has `components[]` array for rich content; abl uses `metadata` JSON

---

### 4. API Keys

| koreserver      | abl-platform                                | Notes                                            |
| --------------- | ------------------------------------------- | ------------------------------------------------ |
| `ApiKey`        | `api_keys`                                  | Server-side API keys                             |
| `ApiKey.apiKey` | `api_keys.keyHash`                          | koreserver stores plain, abl stores hash         |
| `ApiKey.botId`  | `api_keys.tenantId` + `api_keys.projectIds` | Scoped differently                               |
| `ApiKey.state`  | `api_keys.isActive` + `api_keys.expiresAt`  | Status handling                                  |
| —               | `public_api_keys`                           | abl-specific: client-side keys with `pk_` prefix |
| —               | `sdk_channels`                              | abl-specific: SDK channel configuration          |

**Key Differences:**

- abl-platform has separate public vs private API keys
- abl-platform supports scoped permissions and environments

---

### 5. Audit Logging

| koreserver                  | abl-platform   | Database   | Notes                        |
| --------------------------- | -------------- | ---------- | ---------------------------- |
| `auditlogs`                 | `audit_logs`   | MongoDB    | Control-plane events         |
| `auditlogs` (strict: false) | `audit_events` | ClickHouse | Runtime events (high-volume) |

**Key Differences:**

- koreserver uses schemaless (`strict: false`) for audit logs
- abl-platform splits audit into:
  - MongoDB `audit_logs`: control-plane events (login, config change, RBAC)
  - ClickHouse `audit_events`: runtime events (tool calls, guardrail blocks)

---

### 6. LLM Configuration

| koreserver                               | abl-platform                      | Notes                                    |
| ---------------------------------------- | --------------------------------- | ---------------------------------------- |
| `llmconfiguration`                       | `llm_credentials`                 | Encrypted API keys                       |
| `llmconfiguration.integrations[]`        | `tenant_models`                   | Model definitions                        |
| `llmconfiguration.integrations[].apikey` | `llm_credentials.encryptedApiKey` | —                                        |
| `llmconfiguration.featureList`           | `tenant_models.supports*` flags   | Feature capabilities                     |
| `llmconfiguration.guardrailsList`        | (in agent DSL)                    | abl handles at agent level               |
| —                                        | `tenant_service_instances`        | abl-specific: external service instances |

**Key Differences:**

- koreserver has single `llmconfiguration` document with `integrations[]` array
- abl-platform separates credentials from model configuration
- abl-platform embeds `connections[]` in `tenant_models`

---

### 7. RBAC (Roles & Permissions)

| koreserver              | abl-platform                              | Notes                       |
| ----------------------- | ----------------------------------------- | --------------------------- |
| `Roles`                 | `role_definitions`                        | Role definitions            |
| `Roles.permissions[]`   | `role_definitions.permissions`            | Array in both               |
| `Roles.mapping.users[]` | `org_members` / `tenant_members`          | abl has explicit membership |
| `Permissions`           | `resource_types` + `resource_permissions` | Permission catalog          |
| `Permissions.category`  | `resource_types.operations[]`             | abl normalizes differently  |

**Key Differences:**

- koreserver stores role→user mappings in `Roles.mapping`
- abl-platform uses separate membership collections (`org_members`, `tenant_members`, `project_members`)
- abl-platform has `resource_types` with embedded `operations[]`

---

### 8. Billing & Subscriptions

| koreserver                     | abl-platform                    | Notes                          |
| ------------------------------ | ------------------------------- | ------------------------------ |
| `subscription`                 | `subscriptions`                 | Subscription records           |
| `subscription.accountId`       | `subscriptions.organizationId`  | —                              |
| `subscription.planId`          | `subscriptions.planTier`        | —                              |
| `subscription.status`          | `subscriptions.status`          | Same concept                   |
| `subscription.billingSessions` | `subscriptions.orgLimits`       | abl uses JSON for limits       |
| `BillingEvents`                | `usage_periods`                 | Usage tracking                 |
| `BillingEvents.jobdata`        | `usage_periods.tenantBreakdown` | Nested usage details           |
| —                              | `subscriptions.tenantQuotas[]`  | abl embeds hierarchical quotas |

**Key Differences:**

- abl-platform embeds `tenantQuotas[]` with `projectQuotas[]` for hierarchical billing
- koreserver has separate Invoice model; abl handles externally

---

### 9. SDK & Widgets

| koreserver              | abl-platform                    | Notes                          |
| ----------------------- | ------------------------------- | ------------------------------ |
| `widgetThemes`          | `widget_configs`                | Chat widget configuration      |
| `widgetThemes.streamId` | `widget_configs.projectId`      | —                              |
| `widgetThemes.*Color`   | `widget_configs.theme` (Object) | abl uses nested theme object   |
| —                       | `debug_tokens`                  | abl-specific: SDK debugging    |
| —                       | `device_auth_requests`          | abl-specific: device auth flow |

**Key Differences:**

- koreserver has flat color fields; abl nests in `theme` object
- abl-platform has additional SDK infrastructure (debug tokens, device auth)

---

### 10. Tools & Services

| koreserver                     | abl-platform                 | Notes                             |
| ------------------------------ | ---------------------------- | --------------------------------- |
| `toollibraries`                | `service_nodes`              | External service/tool definitions |
| `toollibraries.tool_name`      | `service_nodes.name`         | —                                 |
| `toollibraries.params[]`       | `service_nodes.inputSchema`  | abl uses JSON schema              |
| `toollibraries.tool_actions[]` | `service_nodes.outputSchema` | —                                 |
| —                              | `tool_secrets`               | abl-specific: per-tool secrets    |

**Key Differences:**

- abl-platform uses JSON Schema for input/output definitions
- abl-platform has dedicated secrets management (`tool_secrets`)

---

### 11. Workflows

| koreserver           | abl-platform | Notes             |
| -------------------- | ------------ | ----------------- |
| `WorkflowAssignment` | `workflows`  | Different concept |

**Key Differences:**

- koreserver `WorkflowAssignment` is about assigning resources to teams/users
- abl-platform `workflows` defines workflow steps, triggers, escalation rules
- Not a direct mapping; different architectural patterns

---

### 12. OAuth & Security

| koreserver                | abl-platform                     | Notes                                 |
| ------------------------- | -------------------------------- | ------------------------------------- |
| `Authorizations`          | `end_user_oauth_tokens`          | OAuth tokens                          |
| `Authorizations.clientId` | `end_user_oauth_tokens.provider` | —                                     |
| `Authorizations.issuedTo` | `end_user_oauth_tokens.userId`   | —                                     |
| —                         | `org_proxy_configs`              | abl-specific: proxy configuration     |
| —                         | `key_versions`                   | abl-specific: encryption key rotation |

---

## Collections NOT Mapped (koreserver-specific)

These koreserver collections have no direct equivalent in abl-platform:

| koreserver Collection       | Reason                                                                           |
| --------------------------- | -------------------------------------------------------------------------------- |
| `Contacts`                  | koreserver Contacts = user favorites/blocked; abl Contact = external customer    |
| `Widget`                    | koreserver Widget = dashboard analytics widget; abl widget_configs = chat widget |
| `BTAction`, `BTAlert`, etc. | Bot Task specific features                                                       |
| `Connectors`                | Channel connectors (handled differently in abl)                                  |
| `FormInstance`              | Form-based interactions                                                          |
| `KGPaths`                   | Knowledge Graph paths                                                            |
| `Custom*`                   | Custom templates/fields                                                          |

---

## Collections NOT Mapped (abl-platform-specific)

These abl-platform collections have no direct equivalent in koreserver:

| abl-platform Collection | Purpose                        |
| ----------------------- | ------------------------------ |
| `projects`              | Project container for agents   |
| `project_agents`        | Agent definitions              |
| `agent_versions`        | Versioned agent compilations   |
| `model_configs`         | Project-level model config     |
| `agent_model_configs`   | Agent-specific model overrides |
| `knowledge_bases`       | RAG knowledge sources          |
| `resource_groups`       | Resource grouping              |
| `facts`                 | Dynamic facts with TTL         |
| `deployments`           | Deployment manifests           |
| `deletion_requests`     | GDPR deletion tracking         |
| `archive_manifests`     | Data archival tracking         |

---

## Database Split Summary

| Data Type             | koreserver | abl-platform   |
| --------------------- | ---------- | -------------- |
| User/Org metadata     | MongoDB    | MongoDB        |
| Session metadata      | MongoDB    | MongoDB        |
| Messages              | MongoDB    | **ClickHouse** |
| Metrics               | MongoDB    | **ClickHouse** |
| Traces                | —          | **ClickHouse** |
| Logs                  | stdout     | **ClickHouse** |
| Audit (runtime)       | MongoDB    | **ClickHouse** |
| Audit (control-plane) | MongoDB    | MongoDB        |

---

## Next Steps

After reviewing this mapper:

1. **Field Comparison**: Compare individual fields between mapped collections
2. **Migration Scripts**: Create ETL scripts for data migration
3. **Schema Validation**: Ensure data compatibility
4. **API Compatibility**: Map API endpoints between systems
