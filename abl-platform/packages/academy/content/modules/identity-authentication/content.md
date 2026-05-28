# Identity & Authentication

> **Estimated time**: 30 minutes | **Prerequisites**: Platform Concepts, Workspace & Team

## Learning Objectives

After completing this module, you will be able to:

- Explain the three-tier identity model (T0/T1/T2) and how sessions are promoted between tiers
- Configure tool gating by identity tier, including tools without identityTierRequired
- Describe how cross-tenant access is handled (404 responses, not 403)
- Configure Force SSO with the Owner fallback exception
- Apply the principle of least privilege when scoping API keys

## Security as a Structural Property

Security in the Agent Platform is not a feature you enable -- it is a structural property of the system. Every query, every session, and every piece of data is scoped to its owner. This module covers how the platform authenticates users, verifies identities within agent conversations, and enforces isolation between tenants and projects.

## Tenant Isolation

A tenant is your organizational boundary. All resources -- projects, agents, sessions, credentials, and data -- belong to a tenant. The platform enforces isolation at every layer.

What this means in practice:

- Every data query includes the tenant identifier as a filter condition. There is no API path or query that can access another tenant's data.
- LLM credentials, API keys, and tool bindings are tenant-scoped. Your API keys never touch another tenant's workloads.

> **Key Concept**: Cross-tenant access attempts return a "not found" response (HTTP 404) rather than "access denied" (HTTP 403). This is deliberate: it prevents information leakage. An attacker cannot even confirm whether a resource exists in another tenant. The same approach applies to insufficient permissions within a tenant -- if you lack access to a project, you get 404, not 403. This design eliminates resource enumeration attacks.

This isolation is enforced at the data layer, not the application layer. Database queries themselves are scoped, meaning even a bug in business logic cannot bypass isolation boundaries.

## Project-Based Resource Scoping

Within a tenant, **projects** provide a second level of isolation. Each project has its own:

- Agent definitions and session data
- Knowledge bases and LLM configuration
- Tool bindings and environment variables

A session in one project cannot access data from another project, even within the same tenant. Design your project boundaries to match trust boundaries. For example:

- A **customer support** project with triage, billing, and technical agents
- A **sales** project with product recommendation and checkout agents
- An **internal operations** project with HR and IT helpdesk agents

## The Identity Tier Model

Every end-user session has an identity tier that represents the level of trust established:

| Tier   | Name       | Description                                                                                   | How Established                                             |
| ------ | ---------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **T0** | Anonymous  | No identity information. Unknown visitor.                                                     | Default state for new sessions                              |
| **T1** | Recognized | Weak identity signal (cookie, caller ID, provider assertion). Not cryptographically verified. | Cookie match, caller ID, provider assertion                 |
| **T2** | Verified   | Cryptographic identity proof. High confidence.                                                | HMAC signature, OTP code, OAuth with PKCE, email magic link |

Identity tiers are strictly upward: a session can be promoted from T0 to T1, T0 to T2, or T1 to T2. Downgrades are never allowed within a session.

### Verification Methods

The platform supports six verification methods:

| Method                 | Tier Granted | Flow        | Description                                                                    |
| ---------------------- | ------------ | ----------- | ------------------------------------------------------------------------------ |
| **HMAC**               | T2           | Single-step | Backend signs user identity with shared secret. No user interaction needed.    |
| **OTP**                | T2           | Two-step    | Platform generates 6-digit code, delivered via email/SMS, user submits code.   |
| **OAuth**              | T2           | Two-step    | User authenticates with third-party provider using PKCE.                       |
| **Email magic link**   | T2           | Two-step    | Unique token sent via email, clicking the link completes verification.         |
| **Provider assertion** | T1           | Single-step | Channel provider asserts identity (weaker, grants T1 only).                    |
| **Webhook challenge**  | T1           | Two-step    | Platform sends challenge to backend webhook. Server-to-server proof grants T1. |

> **Key Concept**: OTP is the standard method for promoting a user from T1 (Recognized) to T2 (Verified). When a recognized user (identified by cookie or caller ID) needs to access a sensitive tool, the agent can trigger an OTP flow. The platform generates a 6-digit code, your application delivers it via email or SMS, and the user submits it to complete verification. This two-step process provides cryptographic proof of identity.

### OTP Security Details

- Each verification attempt has a maximum of 5 retries to prevent brute-force attacks
- OTP codes expire after 10 minutes
- Codes are never stored in plaintext -- they are HMAC-SHA256 hashed before storage
- Verification uses timing-safe comparison to prevent timing attacks
- Attempts are stored in Redis with TTL-based auto-expiry

## Tool Gating by Identity Tier

You can require a minimum identity tier on individual tools. This is how you protect sensitive operations while keeping general tools accessible.

```yaml
tools:
  - name: check-balance
    identityTierRequired: 2
    config:
      endpoint: '{{env.BANKING_API_URL}}/balance'

  - name: store-locator
    # No identityTierRequired -- accessible to anonymous users (T0)
    config:
      endpoint: '{{env.STORES_API_URL}}/locations'
```

> **Key Concept**: Tools without `identityTierRequired` set are accessible to all users, regardless of identity tier. This is the default behavior. A store locator, FAQ search, or general information tool does not need identity verification. Only add `identityTierRequired` when the tool accesses sensitive or personal data. This follows the principle of minimal friction -- do not force users to verify their identity unless the operation truly requires it.

When an anonymous user (T0) tries to call `check-balance` (which requires T2), the tool middleware returns:

```json
{
  "error": {
    "code": "IDENTITY_TIER_INSUFFICIENT",
    "message": "Identity tier 2 required, current tier is 0",
    "required_tier": 2,
    "current_tier": 0
  }
}
```

The agent can use this error to prompt the user through a verification flow before retrying.

### Tier Gating Values

| Value | Meaning                                                                     |
| ----- | --------------------------------------------------------------------------- |
| `0`   | No restriction -- any user can call the tool                                |
| `1`   | Recognized -- at least T1 required (channel artifact or provider assertion) |
| `2`   | Verified -- at least T2 required (HMAC, OTP, OAuth, or email link)          |

## SSO Configuration

SSO lets your team authenticate through your organization's identity provider instead of managing separate Agent Platform passwords.

### Supported Protocols

- **SAML 2.0** -- For Okta, Azure AD, OneLogin, PingIdentity
- **OpenID Connect (OIDC)** -- For Azure AD, Auth0, Google Workspace

### Force SSO

Once SSO is configured and your domain is verified, you can require all workspace members to authenticate through SSO.

> **Key Concept**: When Force SSO is enabled, all workspace members with a verified domain email must authenticate through SSO. Password-based login is disabled for those users. However, the workspace **Owner always retains password-based login as a fallback**, regardless of the Force SSO setting. This prevents a lockout scenario where an IdP outage could make the workspace completely inaccessible. Members with email addresses outside your verified domain are also unaffected.

The Force SSO configuration flow:

1. Configure SSO (SAML 2.0 or OIDC)
2. Verify your email domain via DNS TXT record
3. Toggle **Force SSO** to enabled
4. Confirm the change

### Domain Verification

Before enforcing SSO, you must verify ownership of your email domain:

1. Enter your domain (e.g., `yourcompany.com`) in SSO settings
2. Add the provided TXT record to your domain's DNS
3. Click **Verify domain**
4. Verification typically completes within minutes, though DNS propagation can take up to 48 hours

## API Key Authentication

API keys are the primary way to authenticate external applications that interact with your deployed agents.

### How API Key Validation Works

When your application sends a request with an API key:

1. **Hashing** -- The key is hashed and looked up in the database. The original key is never stored.
2. **Activation check** -- Revoked keys are rejected immediately.
3. **Project scope verification** -- Each key is tied to a specific project. A key for Project A cannot access Project B.
4. **Origin validation** -- If allowed origins are configured, the `Origin` header is checked against the allowlist.

### API Key Permissions

| Permission | What It Allows                                    |
| ---------- | ------------------------------------------------- |
| **Chat**   | Send messages to agents and receive responses     |
| **Read**   | Access session history, analytics, agent metadata |
| **Admin**  | Manage agents, configurations, deployments        |

> **Key Concept**: Follow the principle of least privilege when scoping API keys. A web chat widget only needs **Chat** permission -- it should not have Read or Admin access. A monitoring dashboard needs **Read** but not Chat or Admin. A CI/CD pipeline deploying agents needs **Admin** but probably not Chat. Each key should have the minimum permissions required for its specific use case. This limits the blast radius if a key is compromised.

### Public API Keys for Widgets

Widget configuration endpoints accept public API keys via the `X-API-Key` header. These keys start with `pk_` and are safe to expose in client-side code:

```bash
curl -H "X-API-Key: pk_your-public-key" \
  https://api.ablplatform.com/api/v1/sdk/config/PROJECT_ID
```

Public keys are project-scoped with limited permissions for SDK usage. Always configure allowed origins to prevent unauthorized use.

## Multi-Factor Authentication

MFA adds a second layer by requiring a time-based one-time password (TOTP) in addition to the primary authentication method.

### Enabling MFA

1. Go to profile settings
2. Click **Enable MFA**
3. Scan the QR code with an authenticator app
4. Enter the 6-digit confirmation code
5. Save the recovery codes in a secure location

### MFA Enforcement

Workspace Owners and Admins can require MFA for the entire workspace with a configurable grace period (7, 14, or 30 days) for existing members to set up MFA. Members who do not comply within the grace period are locked out.

## Session Security

Conversation sessions are protected with:

- **Project and tenant scoping** -- Sessions belong to a specific project within a specific tenant
- **Encryption at rest** -- All session data is encrypted
- **Configurable timeouts** -- Idle timeout and absolute timeout
- **Explicit termination** -- Sessions can be ended programmatically

## Design Implications for Your Agents

These security boundaries affect how you design your agent system:

1. **Agents within a project share context.** A supervisor can hand off to any agent in the same project. Design project boundaries to match trust boundaries.
2. **Cross-project communication requires explicit integration.** Use tool-based integrations if agents in different projects need to collaborate.
3. **Secrets belong in environment variables, not ABL.** Never hardcode API keys or tokens in agent definitions. Use `{{secret.KEY}}` placeholders.
4. **Tool bindings handle auth.** Configure authentication at the tool binding level so credentials are managed centrally and rotated without changing agent definitions.

## Key Takeaways

- Tools without `identityTierRequired` are accessible to all users -- only gate tools that handle sensitive data
- OTP verification promotes users from T1 (Recognized) to T2 (Verified) through a two-step code delivery flow
- Cross-tenant access returns 404 (not 403) to prevent information leakage and resource enumeration
- Force SSO requires all verified-domain members to use SSO, but the Owner always retains password fallback access
- Apply least privilege to API key scoping -- a Chat widget needs only Chat permission, not Read or Admin

## What's Next

Continue to [Encryption & KMS](../encryption-kms/content.md) for a deep dive into how the platform protects data at rest, or explore [Safety & Compliance](../safety-compliance/content.md) for content safety and guardrail configuration.
