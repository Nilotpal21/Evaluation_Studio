# Encryption & Key Management

> **Estimated time**: 30 minutes | **Prerequisites**: Identity & Authentication, Platform Concepts

## Learning Objectives

After completing this module, you will be able to:

- Explain the DEK/KEK relationship in envelope encryption and why it matters
- Describe how DEKs are scoped by tenantId, projectId, and environment
- Trace the 5-level KMS inheritance chain from platform default to project+environment override
- Explain how crypto-shredding enables data deletion by destroying encryption keys
- Identify the two triggers for automatic DEK rotation (time-based and usage count)

## Why Envelope Encryption?

Encrypting data directly with a master key has a fundamental problem: if you need to rotate the key, you must decrypt and re-encrypt every piece of data. For a platform with millions of encrypted records across hundreds of tenants, this is impractical.

Envelope encryption solves this by introducing two layers of keys. Understanding this architecture is essential for anyone working with the Agent Platform's security model.

## The DEK/KEK Relationship

The Agent Platform uses a two-layer envelope encryption scheme based on NIST SP 800-57 key hierarchy principles.

> **Key Concept**: In envelope encryption, a **Data Encryption Key (DEK)** encrypts your actual data, and a **Key Encryption Key (KEK)** encrypts (wraps) the DEK. The KEK is managed by your KMS provider and never leaves the KMS. This separation means the KMS only performs a small number of wrap/unwrap operations (one per DEK), while the vast majority of cryptographic operations happen locally with the DEK using AES-256-GCM. This design is both secure and performant.

Here is the encryption flow:

1. The DEK Manager acquires the active DEK for the scope (tenant, project, environment).
2. If no active DEK exists, the KMS provider generates a new one, returning both the plaintext DEK and the wrapped (encrypted) DEK.
3. The plaintext DEK encrypts the data using AES-256-GCM with a random 96-bit initialization vector (IV).
4. The DEK identifier is embedded in the ciphertext header so decryption can locate the correct key.
5. The wrapped DEK is stored in the DEK registry (MongoDB). The plaintext DEK is cached in memory and zero-filled on eviction.

And the decryption flow:

1. The DEK identifier is extracted from the ciphertext header.
2. The DEK Manager checks its in-memory cache. On a cache miss, it loads the wrapped DEK from the registry and calls the KMS provider to unwrap it.
3. The plaintext DEK decrypts the data.

### What Gets Encrypted

| Data Type          | Encryption Method                                             |
| ------------------ | ------------------------------------------------------------- |
| Data in transit    | TLS encryption for all communication                          |
| Data at rest       | Two-layer envelope encryption (DEK + KEK)                     |
| Credential storage | AES-256-GCM via Mongoose encryption plugin, per-tenant        |
| Session state      | Tenant-scoped DEKs encrypt conversation history and variables |
| Analytics data     | Field-level encryption interceptors for ClickHouse            |
| Queue payloads     | Encrypted before enqueuing in Redis (BullMQ jobs)             |

## Per-Scope DEK Isolation

Not all data in the platform is encrypted with the same key. DEKs are scoped to ensure that a compromise in one area does not affect others.

> **Key Concept**: Each unique combination of **(tenantId, projectId, environment)** gets its own independent DEK. This three-dimensional scoping means a compromised DEK in one project's staging environment does not affect other projects or production data. The dimensions serve distinct isolation purposes:

| Scope Dimension | Purpose                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **tenantId**    | Enforces workspace isolation -- one tenant's DEK cannot decrypt another tenant's data              |
| **projectId**   | Isolates encryption within a project. Use `_tenant` for workspace-scoped models                    |
| **environment** | Separates development, staging, and production keys. Use `_shared` for environment-agnostic models |

For example, consider a platform with two tenants, each with two projects across three environments. That is 2 x 2 x 3 = 12 independent DEKs, each capable of encrypting only the data in its specific scope.

This granularity has practical benefits:

- **Blast radius containment** -- A compromised key affects only one project in one environment for one tenant
- **Independent rotation** -- You can rotate production keys without touching development keys
- **Compliance segmentation** -- Apply different KMS providers to different scopes (e.g., HSM-backed keys for production only)

## The 5-Level KMS Inheritance Chain

KMS configuration follows a hierarchical inheritance model. Each level can override the one above it. The platform resolves the most specific match for a given scope.

> **Key Concept**: The 5-level KMS inheritance chain resolves KMS providers from most specific to least specific: (1) Project + Environment, (2) Project default, (3) Tenant + Environment, (4) Tenant default, (5) Platform default. This lets you set a sensible default and override only where needed.

| Priority    | Level                 | API Path                                                        | Description                                        |
| ----------- | --------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| 1 (highest) | Project + Environment | `PUT /kms/config/projects/:projectId/environments/:environment` | KMS for a specific project and environment         |
| 2           | Project default       | `PUT /kms/config/projects/:projectId`                           | KMS for all environments in a project              |
| 3           | Tenant + Environment  | `PUT /kms/config` (with `environments` array)                   | KMS for a specific environment across all projects |
| 4           | Tenant default        | `PUT /kms/config` (with `defaultProvider`)                      | Default KMS for the tenant                         |
| 5 (lowest)  | Platform default      | --                                                              | Local provider with platform master key            |

### Practical Example

Your organization uses AWS KMS for most workloads but needs Azure Managed HSM for a high-security financial project in production:

1. Set the tenant default to AWS KMS (level 4)
2. Override the financial project's production environment with Azure Managed HSM (level 1)

Result: All projects use AWS KMS. The financial project's staging and development environments also use AWS KMS. Only the financial project's production environment uses Azure Managed HSM -- the most specific override wins.

### Supported KMS Providers

| Provider              | Key Protection                    | Best For                                  |
| --------------------- | --------------------------------- | ----------------------------------------- |
| **Local**             | Software (PBKDF2 from master key) | Development and testing                   |
| **AWS KMS**           | Software or HSM (via CloudHSM)    | AWS deployments                           |
| **Azure Key Vault**   | Software                          | Azure deployments                         |
| **Azure Managed HSM** | FIPS 140-3 Level 3 HSM            | High-security compliance                  |
| **GCP Cloud KMS**     | Software or HSM                   | GCP deployments                           |
| **External (BYOP)**   | Custom                            | Organizations with own KMS infrastructure |

The local provider is the default when no KMS is configured. It runs entirely in-process with no external dependencies, making it suitable for development but not for compliance requirements (PCI DSS, FIPS 140-3).

## DEK Rotation

DEK rotation ensures that compromised key material has a bounded blast radius. The platform supports both automatic and manual rotation.

### Automatic Rotation: Two Triggers

> **Key Concept**: DEKs rotate automatically based on two independent triggers -- whichever fires first causes rotation. **Time-based expiry** is controlled by `dekEpochIntervalHours` (default: 24 hours, minimum: 12 hours). **Usage ceiling** is controlled by `dekMaxUsageCount` (default: 2^30, approximately 1 billion operations). When either threshold is reached, the current DEK transitions to `decrypt_only` status and a new DEK is generated for subsequent encryptions.

```jsonc
{
  "dekEpochIntervalHours": 24, // Time-based trigger
  "dekMaxUsageCount": 1073741824, // Usage-based trigger (~1 billion)
  "kekRotationPeriodDays": 365, // KEK rotation (annual)
}
```

When a DEK rotates:

1. The old DEK's status changes from `active` to `decrypt_only`. It can still decrypt existing data but is not used for new encryptions.
2. A new DEK is generated for the scope using the configured KMS provider.
3. Existing ciphertext remains readable because each ciphertext embeds the DEK identifier that encrypted it.

The dual-trigger design serves different risk models:

- **Time-based** limits the window during which a compromised key is useful
- **Usage-based** limits the amount of data encrypted under a single key, reducing the statistical exposure for cryptanalysis

### Manual Rotation

Force-rotate DEKs immediately for incident response or compliance requirements:

```bash
# Rotate all DEKs for a tenant
curl -X POST https://runtime.example.com/api/tenants/{tenantId}/kms/keys/rotate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "manual-rotation" }'

# Rotate DEKs for a specific project and environment
curl -X POST https://runtime.example.com/api/tenants/{tenantId}/kms/keys/rotate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "key-compromise",
    "projectId": "proj-123",
    "environment": "production"
  }'
```

Valid rotation reasons: `manual-rotation`, `kek-age-exceeded`, `key-compromise`.

After rotation, a background re-encryption job can be enqueued to re-encrypt existing data under the new DEK:

```jsonc
{
  "reencryption": {
    "enabled": true,
    "concurrency": 1,
    "batchSize": 50,
    "maxRetries": 3,
  },
}
```

### DEK Lifecycle

The DEK lifecycle follows NIST SP 800-57:

| Status         | Behavior                                                |
| -------------- | ------------------------------------------------------- |
| `active`       | Used for new encryptions and decryptions                |
| `decrypt_only` | Rotated -- can decrypt but no new encryptions           |
| `destroyed`    | Wrapped DEK zeroed -- data is permanently unrecoverable |

## Crypto-Shredding

> **Key Concept**: Crypto-shredding permanently destroys all data encrypted by a DEK by destroying the key itself. Without the DEK, the ciphertext is unrecoverable -- you do not need to locate and delete individual records. This is particularly powerful for tenant deletion: destroy all DEKs for a tenant and every piece of their data becomes permanently unreadable, regardless of where it is stored (active database, backups, cold storage, analytics).

Use cases for crypto-shredding:

| Scenario                        | What Happens                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tenant deletion**             | Destroy all tenant DEKs. All data across all projects and environments becomes permanently unreadable.                                           |
| **Right to erasure (GDPR)**     | For contact-level crypto-shredding, the platform derives per-contact encryption keys. Destroying the contact's key renders their PII unreadable. |
| **Environment decommissioning** | Destroy DEKs for a specific environment to ensure no data from that environment can be recovered.                                                |

This approach is faster and more reliable than traditional deletion, which requires finding and removing every record, every backup copy, and every derived dataset. With crypto-shredding, you destroy one key and the problem is solved.

## DEK Cache and Cross-Pod Consistency

In a distributed deployment, multiple pods need coordinated access to DEKs. Unwrapped DEK material is cached in an in-process LRU cache (100 entries, 5-minute TTL) to avoid repeated KMS calls on the hot path.

When DEKs rotate:

1. The local pod's cache is evicted immediately
2. A Redis pub/sub message is broadcast on channel `kms:dek:invalidate` to notify other pods
3. Other pods evict the tenant's cached DEKs on receipt
4. If Redis is unavailable, caches expire naturally via TTL (eventual consistency within 5 minutes)

Key material (plaintext DEK bytes) is zero-filled when evicted from cache or on process shutdown, preventing memory scraping attacks.

## Compliance Levels

Configure the compliance level to enforce stricter key management practices:

| Level        | Description                                                                        |
| ------------ | ---------------------------------------------------------------------------------- |
| `standard`   | Default -- software-protected keys, configurable rotation                          |
| `pci-dss`    | PCI DSS -- requires cloud KMS provider, enforced rotation schedule                 |
| `hipaa`      | HIPAA -- requires cloud KMS provider, audit logging mandatory                      |
| `fips-140-3` | FIPS 140-3 Level 3 -- requires HSM-backed keys (Azure Managed HSM or AWS CloudHSM) |

## Failure Policy

Control how the platform behaves when the KMS provider is unreachable:

- **`fail-closed`** (default) -- Encryption and decryption operations fail. Data is not served unencrypted. Recommended for production.
- **`graceful-degradation`** -- Operations fall back to the platform's local provider. Data remains encrypted but at a lower protection level.

## Key Takeaways

- The DEK/KEK relationship separates data encryption from key protection: DEKs encrypt data locally (fast), KEKs protect DEKs in the KMS (secure)
- DEKs are scoped by the combination of tenantId + projectId + environment, ensuring blast-radius containment
- The 5-level inheritance chain (Project+Env > Project > Tenant+Env > Tenant > Platform) lets you set defaults and override where needed
- Crypto-shredding permanently destroys data by destroying the encryption key, without needing to find and delete individual records
- Automatic DEK rotation fires on two independent triggers: time-based expiry (default 24 hours) and usage count (default ~1 billion operations)

## What's Next

Explore [Safety & Compliance](../safety-compliance/content.md) for content safety controls, or revisit [Identity & Authentication](../identity-authentication/content.md) for the full authentication model that works alongside encryption.
