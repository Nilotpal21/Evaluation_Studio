# Database Schema: MongoDB + ClickHouse

## Overview

Target database schema for the abl-platform. All data lives in either **MongoDB** (metadata & control plane) or **ClickHouse** (high-volume operational).

## Common Fields: Encryption Infrastructure (BaseDocument)

All MongoDB collections inherit the following encryption infrastructure fields from the `BaseDocument` pattern. These fields support field-level encryption and **must be preserved**:

```javascript
{
  ire: String | null,              // encrypted data payload
  iv: String | null,               // initialization vector
  cek: String | null,              // content encryption key
  fieldsToEncrypt: [String] | null // list of field names that are encrypted
}
```

These fields are not shown in individual collection schemas to avoid repetition, but are present on every document that requires field-level encryption.

## MongoDB (Metadata & Control Plane — ~1M writes/day)

| Collection                                | Schema                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [users](./mongo-users.md)                 | users, refresh_tokens, email_verification_tokens, password_reset_tokens                                      |
| [organizations](./mongo-organizations.md) | organizations, org_members, tenant_transfers                                                                 |
| [tenants](./mongo-tenants.md)             | tenants, tenant_members, workspace_invitations                                                               |
| [projects](./mongo-projects.md)           | projects, project_agents, agent_versions, project_members, model_configs, agent_model_configs, service_nodes |
| [rbac](./mongo-rbac.md)                   | role_definitions, resource_permissions, resource_types                                                       |
| [contacts](./mongo-contacts.md)           | contacts                                                                                                     |
| [conversations](./mongo-conversations.md) | conversations                                                                                                |
| [workflows](./mongo-workflows.md)         | workflows                                                                                                    |
| [api-keys](./mongo-api-keys.md)           | api_keys, public_api_keys, sdk_channels                                                                      |
| [llm-config](./mongo-llm-config.md)       | llm_credentials, tenant_models, tenant_service_instances                                                     |
| [security](./mongo-security.md)           | tool_secrets, end_user_oauth_tokens, org_proxy_configs, key_versions                                         |
| [compliance](./mongo-compliance.md)       | deletion_requests, archive_manifests                                                                         |
| [billing](./mongo-billing.md)             | subscriptions, usage_periods                                                                                 |
| [knowledge](./mongo-knowledge.md)         | knowledge_bases, resource_groups, facts                                                                      |
| [sdk](./mongo-sdk.md)                     | widget_configs, debug_tokens, device_auth_requests                                                           |
| [audit](./mongo-audit.md)                 | audit_logs                                                                                                   |
| [deployments](./mongo-deployments.md)     | deployments                                                                                                  |

## ClickHouse (High-Volume Operational — 330M writes/day)

ClickHouse table schemas (DDL, design decisions, query patterns) are consolidated in [DATA_ARCHITECTURE.md](../DATA_ARCHITECTURE.md), Section 5.

| Table        | DATA_ARCHITECTURE.md Section       |
| ------------ | ---------------------------------- |
| traces       | Section 5.1                        |
| messages     | Section 5.2                        |
| llm_metrics  | Section 5.3 (+ materialized views) |
| logs         | Section 5.4                        |
| audit_events | Section 5.5                        |

## Migration Status

All data now routes through MongoDB + ClickHouse when `DB_BACKEND=mongo` (production default):

1. **✅ Phase 1** — ClickHouse tables (messages, llm_metrics, traces, logs, audit_events) — implemented
2. **✅ Phase 2** — MongoDB collections for operational data (conversations, contacts, workflows) — implemented
3. **✅ Phase 3** — MongoDB collections for control plane (users, orgs, tenants, projects, RBAC) — implemented
4. **🔲 Phase 4** — Remove Prisma/SQLite legacy code (Prisma path preserved for local dev fallback only)
