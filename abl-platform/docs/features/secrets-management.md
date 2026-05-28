# Feature: Secrets Management

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `enterprise`, `governance`, `security`
**Package(s)**: `packages/shared` (secrets engine), `packages/database` (secret models), `apps/runtime` (secret provider, rotation workers), `apps/studio` (secret management UI), `apps/admin` (platform-wide secret policy)
**Owner(s)**: Platform team
**Testing Guide**: [../testing/secrets-management.md](../testing/secrets-management.md)
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform handles a proliferating volume of application secrets: LLM API keys, OAuth client secrets, database connection strings, webhook signing keys, MCP server credentials, channel connection tokens, and third-party integration credentials. Today these secrets are scattered across multiple storage mechanisms:

- **Environment variables** (`environment_variables` collection) store `{{env.KEY}}` values with encrypted values but lack lifecycle management (rotation, expiration, revocation, versioning).
- **Auth profiles** centralize credential management for 17 auth types but are scoped to service-to-service authentication, not general-purpose application secrets.
- **LLM credentials**, **tool secrets**, **channel connections**, and **MCP server configs** each store their own encrypted secrets in dedicated Mongoose models with no unified access policy, rotation automation, or cross-cutting audit trail.
- **Encryption at rest** provides AES-256-GCM at the field level but addresses _how_ secrets are stored, not _how_ they are managed through their lifecycle.

This fragmentation creates five critical enterprise gaps:

1. **No rotation automation** -- operators must manually update secrets across all consumer references, risking downtime during the transition window.
2. **No expiration enforcement** -- secrets live indefinitely with no alerting on stale or compromised credentials.
3. **No centralized access policy** -- there is no RBAC-aware, auditable gate that controls which agents, services, or users can read which secrets.
4. **No external secret store integration** -- enterprises with existing HashiCorp Vault, AWS Secrets Manager, Azure Key Vault, or GCP Secret Manager deployments cannot use them as the source of truth; the platform maintains its own copy with no sync mechanism.
5. **No dynamic/ephemeral secrets** -- every secret is long-lived and static, expanding the blast radius of any credential leak.

Industry data underscores the urgency: credential abuse is the initial attack vector in 22% of breaches (IBM 2025), and 23.8 million secrets were leaked on public GitHub in 2024 (GitGuardian State of Secrets Sprawl 2025). OWASP's Secrets Management Cheat Sheet mandates centralized storage, automated rotation, least-privilege access, and comprehensive audit logging -- all of which the platform currently lacks as a unified capability.

### Goal Statement

Provide a comprehensive, tenant-isolated secrets management system that covers the full lifecycle of application secrets -- creation, storage, versioning, rotation (manual and automated), expiration, revocation, access control, audit logging, and external store synchronization -- while integrating cleanly with the platform's existing encryption-at-rest, KMS, auth-profiles, environment-variables, and audit-logging features.

### Summary

Secrets Management introduces a centralized `Secret` resource with a formal lifecycle (ACTIVE, ROTATING, EXPIRED, REVOKED, DESTROYED) that serves as the single source of truth for all application secrets on the platform. The feature consists of six layers:

1. **Secret Store** -- A MongoDB-backed, tenant-isolated collection for secret metadata, encrypted values (leveraging existing AES-256-GCM encryption-at-rest), version history, access policies, and rotation schedules.
2. **Secret Provider** -- A runtime resolution layer that resolves `{{secret.PATH}}` references from DSL, tools, and connectors, checking access policies and emitting audit events on every read.
3. **Rotation Engine** -- BullMQ-based workers that execute scheduled and on-demand rotations using a dual-credential (old+new) zero-downtime pattern with verification and rollback.
4. **External Sync** -- An External Secrets Operator-inspired synchronization layer that keeps platform secrets in sync with external stores (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault, GCP Secret Manager) bidirectionally.
5. **Dynamic Secrets** -- On-demand, short-lived credential generation for supported backends (databases, cloud IAM, API tokens) with automatic revocation on lease expiry.
6. **Secret Scanning** -- Pre-commit hooks and CI pipeline integration using Gitleaks/GitGuardian patterns to detect and block secret leaks in DSL files, agent configs, and platform code.

---

## 2. Scope

### Goals

- Centralized secret lifecycle management: create, version, rotate, expire, revoke, destroy
- Tenant-isolated secret storage with project-level and environment-level scoping
- Automated zero-downtime rotation with dual-credential pattern and verification
- External secret store integration (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault, GCP Secret Manager)
- Dynamic/ephemeral secret generation for supported backends (database credentials, API tokens)
- RBAC-based secret access policies with least-privilege enforcement
- DSL integration via `{{secret.PATH}}` syntax for agent and tool configurations
- Comprehensive audit logging for every secret access, mutation, and rotation event
- Secret versioning with rollback capability
- Secret expiration alerting and enforcement
- Break-glass emergency access with elevated audit logging
- Secret scanning and leak prevention in DSL files, configs, and CI/CD pipelines
- Migration path from existing environment variables and auth profile secrets to the unified secret store

### Non-Goals (Out of Scope)

- Replacing the existing encryption-at-rest mechanism -- secrets management _consumes_ encryption-at-rest, it does not replace it
- Replacing auth profiles for protocol-level authentication (OAuth flows, mTLS handshakes) -- auth profiles remain the protocol handler, secrets management stores the underlying credentials
- Client-side (browser) secret management -- all secret operations are server-side
- Hardware Security Module (HSM) direct integration -- HSM access is via the existing KMS feature
- Per-tenant configurable encryption algorithms -- AES-256-GCM remains the only supported algorithm
- Secret management for end-user passwords or session tokens -- those are handled by the auth/session subsystems
- Full certificate authority (CA) functionality -- only certificate storage and rotation, not issuance

---

## 3. User Stories

1. As a **platform operator**, I want to define rotation schedules for all secrets so that credentials are automatically rotated before they become stale, reducing breach risk without manual intervention.
2. As a **security engineer**, I want every secret access logged with actor, timestamp, IP, and purpose so that I can detect unauthorized access patterns and satisfy SOC2 audit requirements.
3. As a **developer**, I want to reference secrets in agent DSL via `{{secret.llm/openai-key}}` so that I never hardcode credentials and can switch environments without code changes.
4. As a **tenant admin**, I want to grant specific projects read-only access to specific secrets so that the blast radius of a compromised project is limited to only the secrets it needs.
5. As a **compliance officer**, I want to see a dashboard of all secrets, their ages, rotation status, and access history so that I can demonstrate compliance during audits and identify secrets that have not been rotated within policy windows.
6. As an **enterprise customer**, I want to sync secrets from my existing HashiCorp Vault deployment so that the platform uses my organization's centralized secret store as the source of truth.
7. As a **DevOps engineer**, I want dynamic database credentials that are generated on-demand with a 1-hour TTL so that long-lived database passwords are eliminated from the system entirely.
8. As a **platform operator**, I want break-glass emergency access to revoke a compromised secret immediately across all consumers so that incident response time is measured in seconds, not hours.
9. As a **security engineer**, I want secret scanning in CI/CD pipelines that blocks deployments containing hardcoded secrets so that credential leaks are caught before they reach production.
10. As a **developer**, I want secret versions with rollback so that a bad rotation can be reversed without downtime.
11. As a **tenant admin**, I want secret expiration alerts 30, 7, and 1 day before a secret expires so that I can proactively rotate credentials before service disruption.
12. As a **compliance officer**, I want secrets destroyed (crypto-shredded) after revocation so that a revoked secret cannot be recovered even by database administrators.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide CRUD operations for secrets scoped to `(tenantId, projectId, environment, path)` with encrypted value storage using tenant-scoped AES-256-GCM via the existing encryption-at-rest infrastructure.
2. **FR-2**: The system must enforce secret access policies: each secret has an access control list (ACL) specifying which projects, agents, services, and users can read it, with deny-by-default semantics.
3. **FR-3**: The system must maintain a version history for each secret, storing up to N previous versions (configurable, default 10) with metadata (rotatedBy, rotatedAt, reason, source) and supporting rollback to any previous version.
4. **FR-4**: The system must support automated rotation schedules with configurable intervals (default 90 days), grace periods (default 24 hours during which both old and new values are valid), and pre/post-rotation hooks for verification.
5. **FR-5**: The system must implement zero-downtime rotation using the dual-credential pattern: generate new secret, verify new secret works (via configurable health check), activate new secret, keep old secret valid during grace period, then deactivate old secret.
6. **FR-6**: The system must support manual rotation triggered by API call or Studio UI, immediately creating a new version and entering the grace period.
7. **FR-7**: The system must enforce secret expiration: secrets with an `expiresAt` timestamp transition to EXPIRED status automatically, and consumers attempting to read an expired secret receive an error with a clear message.
8. **FR-8**: The system must support secret revocation: a revoked secret immediately becomes unreadable by all consumers, with an optional cascade that also revokes all dependent secrets (e.g., revoking an OAuth client secret also revokes all derived access tokens).
9. **FR-9**: The system must emit audit events for every secret operation: create, read, update, delete, rotate, revoke, expire, destroy, access-denied, break-glass-access. Events are written to the existing audit logging infrastructure (ClickHouse primary, MongoDB fallback).
10. **FR-10**: The system must support external secret store synchronization via provider adapters for HashiCorp Vault, AWS Secrets Manager, Azure Key Vault, and GCP Secret Manager, with configurable sync direction (pull, push, bidirectional) and interval.
11. **FR-11**: The system must support dynamic secret generation for configured backends (e.g., MongoDB, PostgreSQL, Redis) that creates short-lived credentials with automatic revocation on lease expiry.
12. **FR-12**: The system must resolve `{{secret.PATH}}` references in agent DSL, tool configurations, and connector settings at runtime, replacing them with the current active version's decrypted value after verifying access policy.
13. **FR-13**: The system must provide break-glass emergency access: authorized operators can bypass normal access policies with elevated audit logging (separate audit category, immediate Slack/webhook alert).
14. **FR-14**: The system must support secret types: `static` (user-provided value), `generated` (platform-generated with configurable entropy/format), `dynamic` (on-demand from backend), and `synced` (from external store).
15. **FR-15**: The system must support secret metadata: tags, description, owner, team, linked consumers (agents/tools/connectors that reference the secret), and custom key-value annotations.
16. **FR-16**: The system must support secret sharing across projects within the same tenant via explicit cross-project grants, with the granting project retaining ownership and revocation authority.
17. **FR-17**: The system must provide a migration utility that converts existing environment variable secrets (`isSecret: true`) and auth profile secrets into the unified secret store with backward-compatible `{{env.KEY}}` resolution.
18. **FR-18**: The system must block secret values from appearing in API responses, logs, traces, or error messages. Secret values are always masked (`***`) in non-decryption contexts, and ciphertext is never exposed.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                  |
| -------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Secrets are project-scoped, environment-aware, and included in deployment snapshots    |
| Agent lifecycle            | PRIMARY      | Agents reference secrets via `{{secret.PATH}}` resolved at execution time              |
| Customer experience        | NONE         | Backend-only feature; end users do not interact with secrets directly                  |
| Integrations / channels    | PRIMARY      | Connectors, channels, MCP servers, and tools consume secrets for external service auth |
| Observability / tracing    | SECONDARY    | Secret access events are emitted to audit logging; no direct trace pipeline impact     |
| Governance / controls      | PRIMARY      | RBAC access policies, rotation enforcement, expiration alerting, compliance dashboards |
| Enterprise / compliance    | PRIMARY      | External vault integration, dynamic secrets, break-glass, secret scanning, audit trail |
| Admin / operator workflows | PRIMARY      | Platform-wide secret policy management, rotation schedules, compliance dashboards      |

### Related Feature Integration Matrix

| Related Feature       | Relationship Type | Why It Matters                                                                                                            | Key Touchpoints                                                 | Current State |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------- |
| KMS                   | depends on        | Secrets management uses KMS for key encryption keys that protect secret values; KMS provides the key hierarchy            | `TenantKMSConfig`, `EncryptionService`, `wrapKey`/`unwrapKey`   | STABLE        |
| Encryption at Rest    | depends on        | Secret values are encrypted at rest using tenant-scoped AES-256-GCM via the Mongoose encryption plugin                    | `encryptionPlugin`, `EncryptionService.encryptForTenant`        | BETA          |
| Auth Profiles         | extends           | Auth profiles manage protocol-level auth (OAuth, mTLS); secrets management stores the underlying credentials they consume | `AuthProfile.encryptedSecrets`, secret-backed auth profile refs | STABLE        |
| Environment Variables | extends           | Existing `{{env.KEY}}` secrets migrate to the unified store; backward-compatible resolution maintained                    | `SecretsProvider` resolution chain, migration utility           | ALPHA         |
| Audit Logging         | emits into        | Every secret operation emits structured audit events to ClickHouse/MongoDB                                                | `AuditEventType.SECRET_*`, `audit-helpers.ts`                   | BETA          |
| Model Hub             | configured by     | LLM credentials (API keys, endpoints) are stored as secrets and resolved at model invocation time                         | `LLMCredential.encryptedApiKey` -> `{{secret.llm/openai-key}}`  | STABLE        |
| Connectors            | configured by     | Connector OAuth secrets, API keys, and access tokens are stored and rotated via secrets management                        | `ConnectorConfig.authProfileId` -> secret-backed auth profile   | STABLE        |
| MCP Support           | configured by     | MCP server environment variables and auth configs reference secrets for credential injection                              | `MCPServerConfig.encryptedEnv` -> `{{secret.mcp/server-creds}}` | STABLE        |
| Channels              | configured by     | Channel connection credentials (Twilio, WhatsApp, etc.) are stored as platform secrets with rotation support              | `ChannelConnection.encryptedCredentials`                        | STABLE        |
| Deployments           | shares data with  | Deployment snapshots include resolved secret references (not values) for reproducibility; runtime resolves at execution   | `snapshot-service.ts`, deployment variable snapshot             | STABLE        |
| Webhooks              | configured by     | Webhook signing secrets are stored and rotated via secrets management                                                     | `WebhookSubscription.encryptedSecret`                           | STABLE        |
| Tool Invocations      | configured by     | Tool secrets (`ToolSecret` model) are stored and resolved via the unified secret store                                    | `ToolSecret.encryptedValue` -> `{{secret.tools/api-key}}`       | STABLE        |

---

## 6. Design Considerations (Optional)

### Studio UI

- **Secrets Manager page** (`/projects/:id/settings/secrets`) -- table view of all secrets for the project with columns: name, path, type, status, last rotated, expires, consumers, tags.
- **Secret detail drawer** -- version history timeline, access policy editor, rotation schedule config, linked consumers, audit log excerpt.
- **Secret creation wizard** -- type selector (static/generated/dynamic/synced), value input (masked), metadata, access policy, rotation schedule, expiration.
- **Rotation status indicators** -- green (healthy, recently rotated), yellow (approaching expiration), red (expired/revoked), blue (currently rotating).
- **Break-glass modal** -- confirmation dialog with reason field, immediately visible in audit trail.
- **Migration wizard** -- identifies existing env var secrets and auth profile secrets eligible for migration, previews changes, executes with rollback.

### Admin Portal

- **Platform secret policy page** -- global rotation interval defaults, maximum secret age, required secret types per compliance level.
- **Cross-tenant secret health dashboard** -- aggregated metrics on secret age distribution, rotation compliance, expiration risk, access anomalies.
- **External store connection management** -- configure Vault/AWS/Azure/GCP connections at the platform level, assignable to tenants.

---

## 7. Technical Considerations (Optional)

- **Backward compatibility**: The existing `SecretsProvider` resolution chain (cache -> env-var store -> config-var store -> tool secrets -> IR credentials) is extended to check the new unified secret store first, falling through to legacy stores for unmigrated secrets. The `{{env.KEY}}` syntax continues to work; `{{secret.PATH}}` is the new canonical form.
- **Dual-credential rotation**: During rotation, both the current and previous secret values are valid. The `SecretVersion` model tracks `status: 'active' | 'grace' | 'inactive'`. The rotation engine uses BullMQ delayed jobs for grace period expiration.
- **External sync architecture**: Modeled after the External Secrets Operator (ESO) pattern -- a `SecretStoreConfig` resource defines the connection to an external store, and `ExternalSecret` resources define the sync mapping. A BullMQ worker polls external stores at the configured interval and reconciles changes.
- **Dynamic secrets**: Implemented via provider-specific lease managers (e.g., `MongoDBDynamicSecretProvider` creates temporary users with `createUser` and revokes them on lease expiry). Each dynamic secret provider implements a `DynamicSecretProvider` interface with `generate()`, `revoke()`, and `healthCheck()` methods.
- **Secret scanning**: A pre-commit hook (`tools/secret-scan.sh`) wraps Gitleaks with platform-specific patterns (ABL DSL secrets, env var values). CI integration via a BullMQ job that scans deployment artifacts before promotion.
- **Performance**: Secret reads are cached in a per-pod LRU cache (max 5,000 entries, 5-minute TTL) with cache invalidation via Redis pub/sub on secret mutations. Dynamic secrets are not cached (they are inherently short-lived).
- **Migration strategy**: A three-phase migration: (1) introduce the new secret store alongside existing stores, (2) provide a migration utility that copies secrets with dual-write, (3) deprecate direct env-var/auth-profile secret access in favor of `{{secret.PATH}}` references.

---

## 8. How to Consume

### Studio UI

- **Secrets Manager page**: Navigate to Project Settings > Secrets to manage all secrets for the project.
- **Secret creation**: Click "Create Secret" to launch the creation wizard with type, value, metadata, access policy, and rotation schedule.
- **Rotation management**: Each secret shows its rotation status and schedule; click "Rotate Now" for manual rotation.
- **Break-glass access**: Operators with `secret:break-glass` permission can access revoked/expired secrets via the emergency access modal.

### API (Runtime)

| Method | Path                                                     | Purpose                                           |
| ------ | -------------------------------------------------------- | ------------------------------------------------- |
| POST   | `/api/projects/:projectId/secrets`                       | Create a new secret                               |
| GET    | `/api/projects/:projectId/secrets`                       | List secrets (metadata only, no values)           |
| GET    | `/api/projects/:projectId/secrets/:secretId`             | Get secret metadata (no value)                    |
| GET    | `/api/projects/:projectId/secrets/:secretId/value`       | Get decrypted secret value (requires read policy) |
| PUT    | `/api/projects/:projectId/secrets/:secretId`             | Update secret metadata                            |
| PUT    | `/api/projects/:projectId/secrets/:secretId/value`       | Update secret value (creates new version)         |
| DELETE | `/api/projects/:projectId/secrets/:secretId`             | Soft-delete (mark DESTROYED)                      |
| POST   | `/api/projects/:projectId/secrets/:secretId/rotate`      | Trigger manual rotation                           |
| POST   | `/api/projects/:projectId/secrets/:secretId/revoke`      | Revoke secret immediately                         |
| GET    | `/api/projects/:projectId/secrets/:secretId/versions`    | List version history                              |
| POST   | `/api/projects/:projectId/secrets/:secretId/rollback`    | Rollback to a previous version                    |
| GET    | `/api/projects/:projectId/secrets/:secretId/audit`       | Get audit trail for this secret                   |
| POST   | `/api/projects/:projectId/secrets/:secretId/break-glass` | Emergency access (elevated audit)                 |
| GET    | `/api/projects/:projectId/secrets/resolve`               | Resolve `{{secret.PATH}}` references (batch)      |
| POST   | `/api/projects/:projectId/secrets/scan`                  | Scan DSL/config content for leaked secrets        |
| POST   | `/api/projects/:projectId/secrets/migrate`               | Migrate env vars / auth profile secrets           |

### API (Studio)

| Method | Path                                           | Purpose                             |
| ------ | ---------------------------------------------- | ----------------------------------- |
| GET    | `/api/projects/[id]/secrets`                   | List secrets for Studio UI          |
| POST   | `/api/projects/[id]/secrets`                   | Create secret via Studio            |
| PUT    | `/api/projects/[id]/secrets/[secretId]`        | Update secret via Studio            |
| DELETE | `/api/projects/[id]/secrets/[secretId]`        | Delete secret via Studio            |
| POST   | `/api/projects/[id]/secrets/[secretId]/rotate` | Trigger rotation via Studio         |
| GET    | `/api/projects/[id]/secrets/health`            | Secret health summary for dashboard |
| POST   | `/api/projects/[id]/secrets/migrate`           | Launch migration wizard             |

### Admin Portal

| Method | Path                                      | Purpose                                |
| ------ | ----------------------------------------- | -------------------------------------- |
| GET    | `/api/admin/secrets/policies`             | Get platform-wide secret policies      |
| PUT    | `/api/admin/secrets/policies`             | Update platform-wide secret policies   |
| GET    | `/api/admin/secrets/health`               | Cross-tenant secret health dashboard   |
| GET    | `/api/admin/secrets/stores`               | List configured external secret stores |
| POST   | `/api/admin/secrets/stores`               | Configure a new external secret store  |
| PUT    | `/api/admin/secrets/stores/:storeId`      | Update external store configuration    |
| DELETE | `/api/admin/secrets/stores/:storeId`      | Remove external store configuration    |
| POST   | `/api/admin/secrets/stores/:storeId/test` | Test external store connectivity       |

### Channel / SDK / Voice / A2A / MCP Integration

Not directly channel-aware. All channel and integration surfaces consume secrets indirectly via the runtime resolution layer. When an agent references `{{secret.PATH}}`, the runtime resolves and injects the value before the channel/SDK/A2A/MCP handler processes the request. MCP servers receive injected secret values as environment variables at startup.

---

## 9. Data Model

### Collections / Tables

```text
Collection: secrets
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - environment: string | null ('dev' | 'staging' | 'production' | null for base)
  - path: string (required, unique within scope — e.g., "llm/openai-key", "db/postgres-password")
  - name: string (human-readable display name)
  - description: string (optional)
  - type: enum ('static' | 'generated' | 'dynamic' | 'synced')
  - status: enum ('active' | 'rotating' | 'expired' | 'revoked' | 'destroyed')
  - encryptedValue: string (AES-256-GCM ciphertext via encryption plugin)
  - currentVersionId: string (ref to secret_versions._id)
  - rotationSchedule: {
      enabled: boolean,
      intervalDays: number (default: 90),
      gracePeriodHours: number (default: 24),
      lastRotatedAt: Date,
      nextRotationAt: Date,
      rotationProviderId: string | null (for auto-rotation via external provider),
      verificationEndpoint: string | null (URL to call to verify new secret works),
      verificationMethod: enum ('GET' | 'POST' | 'HEAD')
    }
  - expiresAt: Date | null
  - accessPolicy: {
      defaultAccess: enum ('deny' | 'read'),
      grants: [{
        granteeType: enum ('project' | 'agent' | 'service' | 'user' | 'role'),
        granteeId: string,
        permissions: enum[] ('read' | 'rotate' | 'admin'),
        expiresAt: Date | null
      }]
    }
  - externalSync: {
      enabled: boolean,
      storeConfigId: string (ref to external_secret_stores._id),
      externalPath: string (path in external store),
      syncDirection: enum ('pull' | 'push' | 'bidirectional'),
      lastSyncedAt: Date,
      syncStatus: enum ('synced' | 'pending' | 'error')
    } | null
  - dynamicConfig: {
      providerId: string,
      leaseTtlSeconds: number (default: 3600),
      maxLeases: number (default: 10),
      backendConfig: object (provider-specific)
    } | null
  - tags: string[]
  - linkedConsumers: [{ consumerType: string, consumerId: string, reference: string }]
  - createdBy: string (userId)
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, environment: 1, path: 1 } (unique)
  - { tenantId: 1, status: 1 }
  - { tenantId: 1, expiresAt: 1 } (for expiration worker)
  - { tenantId: 1, "rotationSchedule.nextRotationAt": 1 } (for rotation worker)
  - { tenantId: 1, tags: 1 }
```

```text
Collection: secret_versions
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - secretId: string (required, ref to secrets._id)
  - version: number (auto-increment per secret)
  - encryptedValue: string (AES-256-GCM ciphertext)
  - status: enum ('active' | 'grace' | 'inactive' | 'destroyed')
  - createdBy: string (userId or 'system:rotation-engine')
  - createdAt: Date
  - activatedAt: Date
  - deactivatedAt: Date | null
  - reason: string (e.g., 'scheduled-rotation', 'manual-rotation', 'compromise-response')
  - source: enum ('manual' | 'scheduled' | 'external-sync' | 'dynamic' | 'rollback')
Indexes:
  - { secretId: 1, version: -1 } (unique, latest-first)
  - { secretId: 1, status: 1 }
  - { tenantId: 1, status: 1, deactivatedAt: 1 } (for cleanup worker)
```

```text
Collection: external_secret_stores
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - name: string
  - providerType: enum ('hashicorp-vault' | 'aws-secrets-manager' | 'azure-keyvault' | 'gcp-secret-manager')
  - connectionConfig: {
      // HashiCorp Vault
      vaultAddr: string,
      authMethod: enum ('kubernetes' | 'approle' | 'token' | 'iam'),
      namespace: string | null,
      encryptedToken: string | null,
      encryptedRoleId: string | null,
      encryptedSecretId: string | null,
      caCertificate: string | null,
      // AWS Secrets Manager
      region: string,
      encryptedAccessKeyId: string | null,
      encryptedSecretAccessKey: string | null,
      roleArn: string | null,
      // Azure Key Vault
      vaultUrl: string,
      encryptedClientId: string | null,
      encryptedClientSecret: string | null,
      tenantId: string (Azure AD tenant),
      // GCP Secret Manager
      projectId: string,
      encryptedServiceAccountKey: string | null
    }
  - syncIntervalSeconds: number (default: 300)
  - status: enum ('active' | 'error' | 'disabled')
  - lastHealthCheckAt: Date
  - lastHealthCheckStatus: enum ('healthy' | 'unhealthy' | 'unknown')
  - createdBy: string
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, name: 1 } (unique)
  - { tenantId: 1, status: 1 }
```

```text
Collection: secret_access_log (ClickHouse table, high-volume)
Fields:
  - id: string (uuidv7)
  - tenantId: string
  - projectId: string
  - secretId: string
  - secretPath: string
  - actorId: string
  - actorType: enum ('user' | 'agent' | 'service' | 'system')
  - action: enum ('read' | 'create' | 'update' | 'delete' | 'rotate' | 'revoke' | 'expire' | 'destroy' | 'break-glass' | 'access-denied' | 'sync')
  - ipAddress: string
  - userAgent: string
  - traceId: string
  - timestamp: DateTime
  - metadata: string (encrypted JSON — consumer context, reason, etc.)
Indexes:
  - { tenantId, timestamp } (partition key)
  - { tenantId, secretId, timestamp }
  - { tenantId, actorId, timestamp }
  - { tenantId, action, timestamp }
TTL: 365 days (configurable per tenant, minimum 90 days for SOC2)
```

```text
Collection: secret_leases (for dynamic secrets)
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - secretId: string (ref to secrets._id, where type = 'dynamic')
  - encryptedCredentials: string (AES-256-GCM ciphertext — the generated credentials)
  - consumerId: string (agent/service that requested the lease)
  - consumerType: enum ('agent' | 'service' | 'user')
  - leaseTtlSeconds: number
  - expiresAt: Date
  - status: enum ('active' | 'expired' | 'revoked')
  - createdAt: Date
  - revokedAt: Date | null
  - revokedBy: string | null
Indexes:
  - { tenantId: 1, secretId: 1, status: 1 }
  - { expiresAt: 1 } (TTL index for auto-cleanup)
  - { tenantId: 1, consumerId: 1, status: 1 }
```

### Key Relationships

- `secrets` -> `secret_versions` (1:N) -- each secret has an ordered list of versions; `currentVersionId` points to the active one.
- `secrets` -> `external_secret_stores` (N:1 via `externalSync.storeConfigId`) -- synced secrets reference their external store.
- `secrets` -> `secret_leases` (1:N for dynamic secrets) -- each dynamic secret can have multiple active leases.
- `secrets` -> `secret_access_log` (1:N, ClickHouse) -- every access is logged.
- `secrets` -> `environment_variables` (migration path) -- env vars with `isSecret: true` can be migrated to the unified store.
- `secrets` -> `auth_profiles` (extends) -- auth profiles can reference secrets by path instead of storing encrypted values directly.
- `secrets` -> KMS key hierarchy -- secret encryption uses the same tenant-scoped key derivation as encryption-at-rest.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                     | Purpose                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/shared/src/secrets/secret-engine.ts`           | Core `SecretService` — CRUD, versioning, access policy checks    |
| `packages/shared/src/secrets/types.ts`                   | Type definitions: `Secret`, `SecretVersion`, `AccessPolicy`, etc |
| `packages/shared/src/secrets/rotation-engine.ts`         | Dual-credential rotation logic with verification and rollback    |
| `packages/shared/src/secrets/dynamic-secret-provider.ts` | Interface and registry for dynamic secret backends               |
| `packages/shared/src/secrets/external-sync.ts`           | External store sync reconciliation logic                         |
| `packages/shared/src/secrets/secret-resolver.ts`         | `{{secret.PATH}}` reference resolution for DSL and configs       |
| `packages/shared/src/secrets/access-policy.ts`           | RBAC policy evaluation for secret access                         |
| `packages/shared/src/secrets/secret-scanner.ts`          | Pattern-based secret leak detection in DSL and configs           |

### Routes / Handlers

| File                                                     | Purpose                                                  |
| -------------------------------------------------------- | -------------------------------------------------------- |
| `apps/runtime/src/routes/secrets.ts`                     | Secret CRUD, rotation, revocation, version, audit routes |
| `apps/runtime/src/routes/secret-stores.ts`               | External secret store management routes                  |
| `apps/studio/src/app/api/projects/[id]/secrets/route.ts` | Studio secret management API                             |
| `apps/admin/src/routes/secret-policies.ts`               | Admin platform-wide secret policy routes                 |

### UI Components

| File                                                          | Purpose                                           |
| ------------------------------------------------------------- | ------------------------------------------------- |
| `apps/studio/src/components/secrets/SecretsManager.tsx`       | Main secrets table view with filtering and status |
| `apps/studio/src/components/secrets/SecretDetailDrawer.tsx`   | Secret detail: versions, policy, rotation, audit  |
| `apps/studio/src/components/secrets/SecretCreationWizard.tsx` | Multi-step secret creation flow                   |
| `apps/studio/src/components/secrets/RotationStatusBadge.tsx`  | Visual rotation health indicator                  |
| `apps/studio/src/components/secrets/MigrationWizard.tsx`      | Env var / auth profile secret migration tool      |

### Jobs / Workers / Background Processes

| File                                                      | Purpose                                                  |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `apps/runtime/src/workers/secret-rotation-worker.ts`      | BullMQ worker for scheduled rotation execution           |
| `apps/runtime/src/workers/secret-expiration-worker.ts`    | BullMQ worker for secret expiration enforcement          |
| `apps/runtime/src/workers/external-secret-sync-worker.ts` | BullMQ worker for external store synchronization         |
| `apps/runtime/src/workers/dynamic-secret-lease-worker.ts` | BullMQ worker for lease expiry and credential revocation |
| `apps/runtime/src/workers/secret-scan-worker.ts`          | BullMQ worker for CI/CD secret scanning                  |

### Tests

| File                                                            | Type | Coverage Focus                                   |
| --------------------------------------------------------------- | ---- | ------------------------------------------------ |
| `packages/shared/src/__tests__/secrets/secret-engine.test.ts`   | unit | CRUD, versioning, access policy enforcement      |
| `packages/shared/src/__tests__/secrets/rotation-engine.test.ts` | unit | Dual-credential rotation, verification, rollback |
| `packages/shared/src/__tests__/secrets/dynamic-secrets.test.ts` | unit | Dynamic secret generation and lease management   |
| `packages/shared/src/__tests__/secrets/external-sync.test.ts`   | unit | External store sync reconciliation               |
| `packages/shared/src/__tests__/secrets/secret-resolver.test.ts` | unit | `{{secret.PATH}}` reference resolution           |
| `packages/shared/src/__tests__/secrets/access-policy.test.ts`   | unit | RBAC policy evaluation                           |
| `packages/shared/src/__tests__/secrets/secret-scanner.test.ts`  | unit | Secret leak detection patterns                   |
| `apps/runtime/src/__tests__/secrets/secrets-api.e2e.test.ts`    | e2e  | Full HTTP API secret lifecycle                   |
| `apps/runtime/src/__tests__/secrets/rotation-api.e2e.test.ts`   | e2e  | Rotation via API with verification               |
| `apps/runtime/src/__tests__/secrets/external-sync.e2e.test.ts`  | e2e  | External store sync end-to-end                   |
| `apps/runtime/src/__tests__/secrets/access-audit.e2e.test.ts`   | e2e  | Access logging and audit trail verification      |
| `apps/runtime/src/__tests__/secrets/break-glass.e2e.test.ts`    | e2e  | Emergency access with elevated audit             |

---

## 11. Configuration

### Environment Variables

| Variable                             | Default          | Description                                                   |
| ------------------------------------ | ---------------- | ------------------------------------------------------------- |
| `SECRETS_MANAGEMENT_ENABLED`         | `false`          | Feature flag to enable secrets management (gradual rollout)   |
| `SECRETS_CACHE_MAX_SIZE`             | `5000`           | Maximum entries in the per-pod secret value cache             |
| `SECRETS_CACHE_TTL_MS`               | `300000` (5 min) | TTL for cached secret values                                  |
| `SECRETS_DEFAULT_ROTATION_DAYS`      | `90`             | Default rotation interval for new secrets                     |
| `SECRETS_DEFAULT_GRACE_PERIOD_HOURS` | `24`             | Default grace period during rotation (both old and new valid) |
| `SECRETS_MAX_VERSIONS`               | `10`             | Maximum version history per secret                            |
| `SECRETS_DYNAMIC_DEFAULT_LEASE_TTL`  | `3600` (1 hour)  | Default lease TTL for dynamic secrets                         |
| `SECRETS_SCAN_ENABLED`               | `true`           | Enable secret scanning in CI/CD pipeline                      |
| `SECRETS_EXTERNAL_SYNC_INTERVAL`     | `300` (5 min)    | Default sync interval for external stores (seconds)           |
| `SECRETS_BREAK_GLASS_WEBHOOK_URL`    | (none)           | Webhook URL for break-glass access alerts                     |
| `SECRETS_BREAK_GLASS_SLACK_CHANNEL`  | (none)           | Slack channel for break-glass access alerts                   |
| `SECRETS_ACCESS_LOG_RETENTION_DAYS`  | `365`            | Retention period for secret access logs in ClickHouse         |
| `VAULT_ADDR`                         | (none)           | HashiCorp Vault address for platform-level vault integration  |
| `VAULT_AUTH_METHOD`                  | `kubernetes`     | Vault authentication method (kubernetes, approle, token)      |
| `VAULT_NAMESPACE`                    | (none)           | Vault namespace for enterprise namespaced deployments         |

### Runtime Configuration

- `SecretPolicyConfig.maxSecretAge`: Maximum allowed age for any secret before forced rotation (default: 365 days)
- `SecretPolicyConfig.requiredRotationInterval`: Minimum rotation frequency enforced platform-wide (default: 90 days)
- `SecretPolicyConfig.allowedSecretTypes`: Which secret types are enabled per tenant (`['static', 'generated', 'dynamic', 'synced']`)
- `SecretPolicyConfig.expirationAlertDays`: Days before expiration to send alerts (`[30, 7, 1]`)
- `SecretPolicyConfig.breakGlassApprovers`: List of user roles that can approve break-glass access
- Per-tenant external store configurations stored in `external_secret_stores` collection.
- Per-project secret policies via `ProjectSecretPolicy` model (override tenant defaults).

### DSL / Agent IR / Schema

```yaml
# Agent DSL — secret references
AGENT: CustomerSupport
  TOOLS:
    - name: crm-lookup
      config:
        api_key: "{{secret.integrations/crm-api-key}}"
        endpoint: "{{secret.integrations/crm-endpoint}}"
  MODEL:
    provider: openai
    credentials: "{{secret.llm/openai-key}}"

# Environment-scoped secrets resolve based on deployment environment
# e.g., {{secret.db/postgres-password}} resolves to the 'production' version
# when the agent is deployed to the production environment
```

```typescript
// Compiled IR includes secret references (not values)
interface SecretReference {
  type: 'secret';
  path: string; // e.g., "integrations/crm-api-key"
  version?: number; // optional pin to specific version
  required: boolean;
}
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Every secret query includes `tenantId` in the filter. Cross-tenant secret access returns 404 (not 403). Secret encryption uses tenant-scoped key derivation, making cross-tenant decryption impossible. |
| Project isolation | Secrets are scoped to `(tenantId, projectId)`. Cross-project access is denied by default; explicit cross-project grants are the only exception, and they are logged.                                    |
| User isolation    | Secret creation records `createdBy`. Access policies control which users can read which secrets. Personal secrets (scope: `user`) are visible only to the creator.                                      |

### Security & Compliance

- **Encryption**: All secret values encrypted at rest using AES-256-GCM with tenant-scoped key derivation (PBKDF2/HKDF) via the existing encryption-at-rest infrastructure.
- **Access control**: Every secret read requires passing an RBAC access policy check. Default deny — explicit grants required.
- **Audit**: Every secret operation logged to ClickHouse with actor, timestamp, IP, trace ID, and encrypted metadata. SOC2 requires 1-year retention (minimum); PCI DSS requires 3 years for key-related operations.
- **Secret masking**: Secret values never appear in API responses (except the explicit `/value` endpoint), logs, traces, error messages, or ciphertext form. Mongoose `toJSON` transform strips encrypted fields.
- **Break-glass**: Emergency access bypasses normal policies but triggers immediate alerts (webhook + Slack) and logs to a separate audit category with mandatory reason field.
- **Secret scanning**: Gitleaks patterns detect 150+ secret types in DSL files, agent configs, and deployment artifacts. CI pipeline blocks deployments with detected secrets.
- **Dynamic secrets**: Short-lived credentials (default 1-hour TTL) reduce blast radius. Automatic revocation on lease expiry.
- **Zero-trust**: No implicit trust — every secret access is verified against access policies regardless of the requester's network location or previous access history.
- **Compliance mapping**: SOC2 CC6.1 (logical access), CC6.7 (restriction of information), GDPR Art. 32 (security of processing), HIPAA 164.312(a)(1) (access control), PCI DSS 3.6 (key management).

### Performance & Scalability

- Per-pod LRU cache (max 5,000 entries, 5-min TTL) for secret values reduces database reads to ~1 per 5 minutes per secret per pod.
- Cache invalidation via Redis pub/sub ensures pods see mutations within seconds.
- Secret resolution adds ~1-5ms per `{{secret.PATH}}` reference (cache hit) or ~10-50ms (cache miss, DB read + decrypt).
- External sync workers are rate-limited to prevent overwhelming external stores (default: 10 requests/second per store).
- Dynamic secret generation adds ~50-200ms latency (backend-dependent) — acceptable because it replaces manual credential provisioning.
- BullMQ workers for rotation/expiration/sync are horizontally scalable via Redis-backed queues.
- ClickHouse access log table partitioned by month for query performance on high-volume tenants.

### Reliability & Failure Modes

- **Secret store unavailable**: Falls back to cached values (stale-while-revalidate pattern). If cache is empty, returns error with clear message. Never blocks agent execution if the secret was previously cached.
- **Rotation failure**: If verification of the new secret fails, the rotation engine rolls back: deactivates the new version, reactivates the previous version, logs the failure, and schedules a retry.
- **External sync failure**: Sync errors are logged and retried with exponential backoff (max 5 retries). The secret retains its last known value. Status field shows `error` in Studio UI.
- **Dynamic secret backend failure**: Lease creation fails gracefully with an error returned to the consumer. Existing active leases are not affected.
- **Cache inconsistency**: Redis pub/sub invalidation ensures eventual consistency within seconds. The 5-minute TTL provides a hard upper bound on staleness.
- **Break-glass during outage**: Break-glass access works even when external sync is down, as it reads from the local secret store.
- **Vault seal/unseal**: If the external Vault is sealed, sync pauses and retries. Local secrets remain accessible.

### Observability

- **Metrics** (Prometheus):
  - `secret_read_total{tenant, project, cache_hit}` -- secret read operations with cache hit/miss
  - `secret_rotation_total{tenant, project, status}` -- rotation operations (success/failure/rollback)
  - `secret_expiration_total{tenant, project}` -- expiration events
  - `secret_access_denied_total{tenant, project}` -- access policy denials
  - `secret_external_sync_total{tenant, store, status}` -- external sync operations
  - `secret_lease_active{tenant, project}` -- current active dynamic secret leases
  - `secret_age_seconds{tenant, project}` -- histogram of secret ages (for staleness detection)
- **Alerts**:
  - Secret approaching expiration (30, 7, 1 day thresholds)
  - Rotation failure (immediate)
  - External sync error (after 3 consecutive failures)
  - Unusual access pattern (> 100 reads per minute for a single secret)
  - Break-glass access (immediate)
  - Secret age exceeding policy maximum
- **Logs**: `[secrets]` log prefix for all secret operations via `createLogger('secrets')`. Sensitive values are never logged.
- **Dashboards**: Grafana dashboard with secret health overview, rotation compliance, access patterns, and cache performance.

### Data Lifecycle

- **Secret versions**: Inactive versions retained for `SECRETS_MAX_VERSIONS` (default 10) entries per secret. Older versions are crypto-shredded (encryption salt deleted).
- **Access logs**: Retained in ClickHouse for `SECRETS_ACCESS_LOG_RETENTION_DAYS` (default 365 days). Partitioned by month for efficient pruning.
- **Dynamic secret leases**: Auto-deleted via TTL index after `expiresAt`. Revoked credentials are cleaned up immediately.
- **Destroyed secrets**: Soft-deleted initially (status: `destroyed`), then hard-deleted after 30 days (configurable). All versions crypto-shredded.
- **External store configs**: Retained as long as the tenant exists. Credentials within the config are encrypted and follow the same rotation policies.
- **Migration records**: Maintained for audit trail. Original env var / auth profile records are preserved (not deleted) during migration, marked with `migratedToSecretId` reference.

---

## 13. Delivery Plan / Work Breakdown

### Phase 1: Core Secret Store (Sprints 1-2)

1. Secret data model and database schema
   1.1 Create `secrets` and `secret_versions` Mongoose models with encryption plugin
   1.2 Create indexes and validation schemas (Zod)
   1.3 Add to Dockerfile package.json sync
2. Secret CRUD API
   2.1 Implement Runtime routes: create, list, get, update, delete
   2.2 Implement value read endpoint with access policy check
   2.3 Implement version listing and rollback endpoints
3. Access policy engine
   3.1 Implement RBAC policy evaluation (`access-policy.ts`)
   3.2 Wire policy checks into all read/write operations
   3.3 Implement default-deny semantics with explicit grants
4. Secret value caching
   4.1 Per-pod LRU cache with TTL
   4.2 Redis pub/sub cache invalidation on mutations
5. Audit logging integration
   5.1 Add `SECRET_*` event types to `AuditEventType` union
   5.2 Implement fire-and-forget audit emission for all secret operations
   5.3 Create ClickHouse `secret_access_log` table
6. Studio UI: basic secrets manager
   6.1 Secrets table with filtering, status badges
   6.2 Secret creation form (static and generated types)
   6.3 Secret detail drawer with version history

### Phase 2: Rotation & Expiration (Sprints 3-4)

7. Rotation engine
   7.1 Dual-credential rotation logic with verification
   7.2 BullMQ rotation worker with scheduled and on-demand triggers
   7.3 Grace period management (delayed job for deactivation)
   7.4 Rollback on verification failure
8. Expiration enforcement
   8.1 BullMQ expiration worker scanning for approaching/past expiresAt
   8.2 Expiration alert notifications (webhook, Slack, in-app)
   8.3 Automatic status transition to EXPIRED
9. DSL integration
   9.1 Implement `{{secret.PATH}}` syntax in compiler/parser
   9.2 Implement `SecretResolver` for runtime resolution
   9.3 Wire into existing `SecretsProvider` resolution chain
   9.4 Deployment snapshot integration (resolve references, not values)
10. Studio UI: rotation management
    10.1 Rotation schedule configuration in secret detail
    10.2 Rotation status badges and timeline visualization
    10.3 Manual rotation trigger from UI

### Phase 3: External Stores & Dynamic Secrets (Sprints 5-7)

11. External secret store framework
    11.1 `ExternalSecretStoreProvider` interface
    11.2 HashiCorp Vault provider (KV v2, Kubernetes auth)
    11.3 AWS Secrets Manager provider (IAM role-based)
    11.4 Azure Key Vault provider (managed identity)
    11.5 GCP Secret Manager provider (service account)
12. External sync worker
    12.1 BullMQ worker for polling external stores
    12.2 Reconciliation logic (create/update/delete sync)
    12.3 Bidirectional sync support
    12.4 Conflict resolution (external wins by default, configurable)
13. Dynamic secrets
    13.1 `DynamicSecretProvider` interface
    13.2 MongoDB dynamic user provider
    13.3 PostgreSQL dynamic user provider
    13.4 Lease management (create, renew, revoke)
    13.5 BullMQ lease expiration worker
14. Admin portal
    14.1 Platform secret policy management
    14.2 External store connection management
    14.3 Cross-tenant secret health dashboard

### Phase 4: Advanced Features (Sprints 8-9)

15. Break-glass emergency access
    15.1 Break-glass API endpoint with elevated audit
    15.2 Immediate webhook/Slack notification
    15.3 Approval workflow (optional, configurable)
    15.4 Studio UI break-glass modal
16. Secret scanning
    16.1 Gitleaks integration with platform-specific patterns
    16.2 Pre-commit hook (`tools/secret-scan.sh`)
    16.3 CI/CD pipeline scanning worker
    16.4 DSL content scanning before deployment
17. Migration utility
    17.1 Environment variable secret migration
    17.2 Auth profile secret migration
    17.3 Backward-compatible resolution (dual-read)
    17.4 Studio migration wizard UI
18. Cross-project secret sharing
    18.1 Cross-project grant API
    18.2 Grant management UI in Studio
    18.3 Audit logging for cross-project access

---

## 14. Success Metrics

| Metric                            | Baseline            | Target            | How Measured                                                    |
| --------------------------------- | ------------------- | ----------------- | --------------------------------------------------------------- |
| Secret rotation compliance rate   | 0% (no automation)  | > 95%             | % of secrets rotated within their configured interval           |
| Mean time to rotate (MTTR)        | Hours (manual)      | < 60 seconds      | Time from rotation trigger to new secret active                 |
| Secret age distribution           | Unbounded           | P95 < 90 days     | Histogram of secret ages across all tenants                     |
| Secret access audit coverage      | Partial (per-model) | 100%              | % of secret reads with corresponding audit log entry            |
| External store sync latency       | N/A                 | < 30 seconds      | Time from external store update to platform secret updated      |
| Dynamic secret lease utilization  | N/A                 | > 80%             | % of dynamic secret-eligible backends using dynamic credentials |
| Secret scanning detection rate    | 0% (no scanning)    | > 99%             | % of known secret patterns detected in DSL/config scans         |
| Mean time to revoke (MTTR-revoke) | Hours (manual)      | < 5 seconds       | Time from revocation trigger to all consumers blocked           |
| Secret-related security incidents | Unknown             | 0                 | # of incidents caused by leaked, stale, or unrotated secrets    |
| Migration adoption rate           | 0%                  | > 80% in 6 months | % of existing env var secrets migrated to unified store         |

---

## 15. Open Questions

1. **Vault vs. platform as source of truth**: For enterprises with existing Vault deployments, should the platform ever be authoritative, or should it always defer to the external store? The current design supports both via configurable sync direction, but the default needs stakeholder input.
2. **Dynamic secret backend scope**: Which backends should be supported in Phase 3? MongoDB and PostgreSQL are proposed; should Redis, Elasticsearch, and cloud IAM (AWS STS, Azure AD, GCP IAM) be included?
3. **Break-glass approval workflow**: Should break-glass access be immediate (with post-facto audit) or require real-time approval from a second operator? Immediate is faster for incident response; approval adds security but risks delays.
4. **Secret sharing across tenants**: The current design limits sharing to within a tenant (cross-project). Should platform-level "global secrets" (e.g., shared API keys for platform services) be supported for multi-tenant SaaS deployments?
5. **Migration timeline**: How aggressively should existing env var secrets be migrated? Should Phase 4 include a deprecation timeline for direct `{{env.KEY}}` secret storage, or should both systems coexist indefinitely?
6. **Secret versioning vs. KMS key versioning**: The platform already has `key_versions` in KMS. Should secret versioning reuse the KMS version model, or is the separate `secret_versions` collection justified by different lifecycle semantics?
7. **Compliance tier differentiation**: Should secrets have compliance tier labels (standard, PCI-DSS, HIPAA, FIPS) that affect retention, rotation frequency, and audit depth? The KMS feature already has `complianceLevel`.
8. **Dynamic secret cost**: Dynamic secrets require per-backend provider implementations. Should the platform provide a generic "script-based" dynamic provider that runs a user-supplied script (e.g., a shell command or HTTP call) to generate/revoke credentials?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                      | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No unified secret lifecycle today -- secrets scattered across env vars, auth profiles, LLM credentials, tool secrets, channel connections, MCP configs           | High     | Open   |
| GAP-002 | No automated rotation -- all secret rotation is manual, creating windows of vulnerability and operational burden                                                 | High     | Open   |
| GAP-003 | No external secret store integration -- enterprises cannot use their existing Vault/AWS/Azure/GCP secret stores as source of truth                               | High     | Open   |
| GAP-004 | No dynamic/ephemeral secrets -- all credentials are long-lived, expanding blast radius of any leak                                                               | Medium   | Open   |
| GAP-005 | No secret access policies -- any authenticated user within a project can read any secret in that project; no fine-grained RBAC for secret access                 | High     | Open   |
| GAP-006 | No secret expiration enforcement -- secrets live indefinitely with no alerting or automatic revocation                                                           | Medium   | Open   |
| GAP-007 | No secret scanning -- hardcoded secrets in DSL files and configs are not detected; 70% of leaked secrets remain active for 2+ years (GitGuardian 2025)           | Medium   | Open   |
| GAP-008 | No break-glass emergency access -- incident response requires manual database updates to revoke compromised secrets                                              | Medium   | Open   |
| GAP-009 | Inconsistent secret resolution -- different consumers (env vars, auth profiles, tool secrets) use different resolution mechanisms with no unified provider chain | Medium   | Open   |
| GAP-010 | No cross-project secret sharing -- projects cannot safely reference secrets from other projects within the same tenant                                           | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                  | Coverage Type | Status     | Test File / Note                                   |
| --- | ----------------------------------------- | ------------- | ---------- | -------------------------------------------------- |
| 1   | Secret CRUD via HTTP API                  | e2e           | NOT TESTED | `secrets-api.e2e.test.ts`                          |
| 2   | Secret value encryption roundtrip         | unit          | NOT TESTED | `secret-engine.test.ts`                            |
| 3   | Tenant isolation (cross-tenant 404)       | e2e           | NOT TESTED | `secrets-api.e2e.test.ts`                          |
| 4   | Project isolation (cross-project 404)     | e2e           | NOT TESTED | `secrets-api.e2e.test.ts`                          |
| 5   | Access policy enforcement                 | unit + e2e    | NOT TESTED | `access-policy.test.ts`, `secrets-api.e2e.test.ts` |
| 6   | Secret rotation (scheduled)               | integration   | NOT TESTED | `rotation-engine.test.ts`                          |
| 7   | Secret rotation (manual via API)          | e2e           | NOT TESTED | `rotation-api.e2e.test.ts`                         |
| 8   | Rotation rollback on verification failure | unit          | NOT TESTED | `rotation-engine.test.ts`                          |
| 9   | Secret expiration enforcement             | integration   | NOT TESTED | `secret-expiration-worker.test.ts`                 |
| 10  | External store sync (Vault)               | e2e           | NOT TESTED | `external-sync.e2e.test.ts`                        |
| 11  | Dynamic secret lease lifecycle            | integration   | NOT TESTED | `dynamic-secrets.test.ts`                          |
| 12  | `{{secret.PATH}}` resolution in DSL       | unit + e2e    | NOT TESTED | `secret-resolver.test.ts`                          |
| 13  | Audit logging for secret access           | e2e           | NOT TESTED | `access-audit.e2e.test.ts`                         |
| 14  | Break-glass emergency access              | e2e           | NOT TESTED | `break-glass.e2e.test.ts`                          |
| 15  | Secret scanning detection                 | unit          | NOT TESTED | `secret-scanner.test.ts`                           |
| 16  | Cache invalidation via Redis pub/sub      | integration   | NOT TESTED | `secret-cache.integration.test.ts`                 |
| 17  | Migration from env vars to secret store   | integration   | NOT TESTED | `secret-migration.integration.test.ts`             |
| 18  | Cross-project secret sharing              | e2e           | NOT TESTED | `secrets-api.e2e.test.ts`                          |
| 19  | Secret value never in logs/traces/errors  | unit          | NOT TESTED | `secret-masking.test.ts`                           |
| 20  | Version history and rollback              | e2e           | NOT TESTED | `secrets-api.e2e.test.ts`                          |

### Testing Notes

All test scenarios are planned. No tests exist yet as the feature is in PLANNED status. The test strategy prioritizes E2E tests that exercise the full HTTP API path with real encryption, real MongoDB, and real Redis -- no mocking of codebase components. External secret stores (Vault, AWS, Azure, GCP) will use containerized test instances (e.g., HashiCorp Vault dev server) for integration tests.

> Full testing details: [../testing/secrets-management.md](../testing/secrets-management.md)

---

## 18. References

- OWASP Secrets Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- OWASP Key Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html
- HashiCorp Vault Secrets Operator: https://developer.hashicorp.com/vault/docs/deploy/kubernetes/vso
- External Secrets Operator: https://external-secrets.io/latest/provider/hashicorp-vault/
- GitGuardian State of Secrets Sprawl 2025: https://blog.gitguardian.com/secret-scanning-tools/
- Infisical Secrets Management Best Practices: https://infisical.com/blog/secrets-management-best-practices
- Doppler Zero Downtime Rotation Guide: https://www.doppler.com/blog/10-step-secrets-rotation-guide
- HashiCorp Vault Dynamic Secrets for AI Agents: https://developer.hashicorp.com/validated-patterns/vault/ai-agent-identity-with-hashicorp-vault
- Design docs: `docs/specs/secrets-management.hld.md` (planned)
- Related feature docs: [encryption-at-rest](./encryption-at-rest.md), [auth-profiles](./auth-profiles.md), [environment-variables](./environment-variables.md), [audit-logging](./audit-logging.md)
