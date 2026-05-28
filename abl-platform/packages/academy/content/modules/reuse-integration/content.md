# Reuse & Integration

> **Estimated time**: 35 minutes | **Prerequisites**: Agent building basics, deployment concepts

## Learning Objectives

After completing this module, you will be able to:

- Create, publish, and import reusable agent modules across projects
- Understand the immutability guarantee and security model of published releases
- Use the Agent Platform API with proper authentication, pagination, and error handling
- Implement rate limit handling with exponential backoff
- Work with environment selectors for automatic dependency resolution on deployment

## Reusable Modules: Share Agent Logic Across Projects

Enterprise teams building multi-agent applications often need the same capabilities -- identity verification, payment processing, FAQ handling -- in several projects. Without a sharing mechanism, you copy ABL definitions between projects and those copies inevitably diverge.

Agent Platform's module system solves this: publish a tested, versioned snapshot of agent logic that consumers pin to a specific release.

### The Module Lifecycle

The complete lifecycle flows through these stages:

1. **Create** a module project (any project can become a module)
2. **Build** agents and tools as normal
3. **Publish** an immutable, versioned release
4. **Promote** the release through environments (dev, staging, production)
5. **Import** the module into consumer projects with an alias
6. **Deploy** consumer projects with frozen module snapshots

### Creating a Module Project

Enable module mode on any existing project:

```bash
curl -X POST /api/projects/:projectId/module \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"enabled": true, "moduleVisibility": "tenant"}'
```

Visibility options:

- `private` -- only the project owner can see it
- `tenant` -- all projects within the same tenant can browse and import

### Building Module Content

Build agents and tools exactly as you would in a standard project. The key difference is using **config templating** for environment-specific values:

```abl
AGENT billing_lookup
  DESCRIPTION: "Looks up billing information for a customer account"
  TOOLS:
    - get_account_balance
  INSTRUCTIONS: |
    Use {{config.CURRENCY_FORMAT}} for all monetary values.

TOOLS:
  get_account_balance(account_id: string) -> {balance: number, currency: string}
    description: "Retrieve current account balance"
    type: http
    endpoint: "{{config.BILLING_API_URL}}/accounts/{account_id}/balance"
    auth: auth_profile_ref(billing_api_auth)
```

Use `{{config.KEY}}` for non-sensitive values, `{{secrets.KEY}}` for credentials, and `auth_profile_ref()` for authentication profiles. Never hardcode credentials -- the publish safety validator blocks them.

### Publishing a Release

```bash
curl -X POST /api/projects/:projectId/module/releases \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "version": "1.0.0",
    "releaseNotes": "Initial release with billing agents",
    "promoteToEnvironment": "dev"
  }'
```

The publish pipeline validates agents exist, compiles ABL to IR, strips project-specific identifiers, runs safety validation, extracts the module contract, and computes a SHA-256 hash.

### The Immutability Guarantee

> **Key Concept**: Once a release is published, it is **immutable**. The artifact (DSL source, compiled IR), the contract, and the source hash cannot be modified. Identical source content always produces the same deterministic hash. A release can be archived (hidden from the catalog) but never deleted while referenced by consumers. This guarantee means that when a consumer pins to version `1.0.0`, they will always get exactly the same code -- no surprise changes.

This immutability is what makes modules safe for production use. You can confidently deploy knowing that the billing module version `1.0.0` you tested in staging is byte-for-byte identical to what runs in production.

### The LITERAL_AUTH_VALUE Safety Violation

The publish pipeline includes a safety validator that specifically checks for security issues:

> **Key Concept**: If the publish safety validator detects a **`LITERAL_AUTH_VALUE`** -- a non-templated auth value in an HTTP tool -- the publish is **rejected** with a `BUILD_ERROR`. The error message will read: `[LITERAL_AUTH_VALUE] tool:get_account_balance: HTTP tool has a non-templated auth value. Use auth_profile_ref or {{env.*}}/{{config.*}} templating instead.` This prevents secrets from being baked into published modules that could be shared across teams. Always use `auth_profile_ref()` or template variables for authentication.

### Importing a Module: The Double Underscore Convention

Consumer projects import modules from the tenant-scoped catalog. Each import requires an **alias** that determines how the module's symbols appear:

```bash
curl -X POST /api/projects/:consumerProjectId/module-dependencies \
  -d '{
    "moduleProjectId": "01J...",
    "selector": {"type": "version", "value": "1.0.0"},
    "alias": "billing",
    "configOverrides": {"CURRENCY_FORMAT": "USD"}
  }'
```

> **Key Concept**: When you import a module with alias `billing`, all agent and tool names are automatically prefixed with `billing__` (**alias + double underscore**). A module agent named `billing_lookup` becomes `billing__billing_lookup` in the consumer project. This deep name rewriting updates all references -- agent metadata, tool names, handoff targets, delegate targets, routing rules, behavior profiles, and hook call targets. You reference imported agents by their mounted names in routing and handoffs.

| Module Symbol         | Mounted Name in Consumer       |
| --------------------- | ------------------------------ |
| `billing_lookup`      | `billing__billing_lookup`      |
| `get_account_balance` | `billing__get_account_balance` |

Alias rules: lowercase, starts with a letter, 2-25 characters, no double underscores, no reserved prefixes (`system_`, `internal_`, `test_`).

### Environment Selectors: Auto-Resolution on Deployment

When importing a module, you choose a **selector** that determines which release the dependency tracks:

| Selector Type | Value          | Behavior                                               |
| ------------- | -------------- | ------------------------------------------------------ |
| `version`     | `"1.0.0"`      | Pin to an exact release version                        |
| `environment` | `"production"` | Track whatever release is promoted to that environment |

> **Key Concept**: With an **environment selector** (e.g., `"type": "environment", "value": "production"`), the dependency automatically resolves to whichever release is currently promoted to that environment. When you deploy the consumer project, the system looks up the current environment pointer and freezes that release into the deployment snapshot. This means promoting a new module release to `production` automatically updates all consumer projects using the environment selector -- on their next deployment. Version selectors are safer for production stability; environment selectors are convenient during active development.

### Deployment with Modules

When you create a deployment for a consumer project with module dependencies, the system builds a **frozen deployment module snapshot**:

1. Resolves each dependency selector to a concrete release ID
2. Validates all required auth profiles exist
3. Deep-clones and rewrites all IR with alias prefixes
4. Serializes, compresses (gzip), and stores the snapshot
5. Computes a deterministic SHA-256 hash

After deployment, editing agents in the source module has zero effect on existing consumer deployments. Changes only take effect when the consumer imports a new release and redeploys.

### Promoting Releases Through Environments

```
1.0.0 --> promote --> dev
1.0.0 --> promote --> staging
1.0.0 --> promote --> production

1.1.0 --> promote --> dev       (staging and production still on 1.0.0)
```

Consumers pinned to a specific version are unaffected by promotions. Consumers tracking an environment pointer pick up the new release on their next deployment.

## The Agent Platform API

The platform exposes a RESTful API for managing agents, sessions, deployments, and more. Understanding its conventions is essential for any integration.

### Authentication Methods

Every authenticated endpoint requires one of these credential types:

| Method            | Header                             | Use Case                                    |
| ----------------- | ---------------------------------- | ------------------------------------------- |
| JWT Bearer token  | `Authorization: Bearer eyJ...`     | After user login                            |
| API key           | `Authorization: Bearer abl_sk-...` | Long-lived programmatic access              |
| SDK session token | `X-SDK-Token: sdk_token_value`     | Embedded widget sessions                    |
| Public API key    | `X-API-Key: pk_...`                | Widget configuration (safe for client-side) |

```bash
curl -H "Authorization: Bearer abl_sk-your-api-key" \
  https://api.ablplatform.com/api/v1/chat/agent
```

### Request and Response Format

All requests use `application/json` (UTF-8, max 1 MB body). Successful responses follow this structure:

```json
{
  "success": true,
  "data": { ... }
}
```

Error responses include structured error codes:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Agent not found: my-agent"
  }
}
```

### Rate Limiting and Exponential Backoff

The platform enforces per-tenant rate limits. When exceeded, you receive a `429 Too Many Requests` response:

```json
{
  "error": "Session message rate limit exceeded",
  "retryAfterMs": 2000
}
```

Rate limit headers tell you where you stand:

| Header                  | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `X-RateLimit-Remaining` | Requests remaining in the current window       |
| `X-RateLimit-Reset`     | Unix timestamp when the window resets          |
| `Retry-After`           | Seconds until you can retry (on 429 responses) |

> **Key Concept**: When you receive a **429 rate limit response**, implement **exponential backoff**: wait the `retryAfterMs` duration, then double the wait time on each subsequent retry. This is a best practice not just for 429 responses but also for 503 (Service Unavailable) responses. Hammering the API with immediate retries only makes the situation worse and may result in longer rate-limiting periods.

A simple backoff pattern:

1. First retry: wait `retryAfterMs` (e.g., 2 seconds)
2. Second retry: wait 4 seconds
3. Third retry: wait 8 seconds
4. Cap at a maximum wait (e.g., 60 seconds)

### Pagination

List endpoints support offset-based pagination:

```bash
# Fetch page 2 (items 51-100)
curl "/api/projects/proj_abc/sessions?limit=50&offset=50" \
  -H "Authorization: Bearer abl_sk-your-api-key"
```

The response includes a `pagination` object with `total`, `limit`, and `offset` to determine if more pages exist.

### Streaming with Server-Sent Events

Streaming endpoints use SSE (Server-Sent Events) for real-time responses:

```
event: text_delta
data: {"delta":"Hello"}

event: usage
data: {"inputTokens":52,"outputTokens":14}

event: complete
data: {"inputTokens":52,"outputTokens":14,"totalTokens":66,"latencyMs":1200}
```

SSE connections send heartbeat comments every 15 seconds to keep connections alive through proxies.

### Key API Scopes

| Scope           | Base Path                   | Example                      |
| --------------- | --------------------------- | ---------------------------- |
| Global (v1)     | `/api/v1/`                  | `/api/v1/chat/agent`         |
| Project-scoped  | `/api/projects/:projectId/` | `/api/projects/abc/sessions` |
| Agent discovery | `/api/agents/`              | `/api/agents/my-agent`       |

### Error Codes Reference

| Code                  | HTTP Status | Resolution                                 |
| --------------------- | ----------- | ------------------------------------------ |
| `BAD_REQUEST`         | 400         | Check request body against endpoint schema |
| `UNAUTHORIZED`        | 401         | Verify token or API key is valid           |
| `FORBIDDEN`           | 403         | Check credentials have required scope      |
| `NOT_FOUND`           | 404         | Confirm resource ID and access             |
| `RATE_LIMIT_EXCEEDED` | 429         | Wait and retry with exponential backoff    |
| `INTERNAL_ERROR`      | 500         | Retry after brief delay                    |

Cross-tenant access returns `404` (not `403`) to avoid revealing resource existence -- a deliberate privacy design choice.

## Module Best Practices

### Granularity

One domain, one module. A billing module, an identity verification module, and a FAQ module should be separate. Avoid a single "shared utilities" module.

### Versioning Strategy

- **Pin to versions** for production stability (`"type": "version", "value": "1.0.0"`)
- **Use environment selectors** during active development
- Follow semver: major for breaking changes, minor for additions, patch for fixes

### Security

- Secrets never leave the module (publish validator rejects inline credentials)
- Config overrides cannot set secret keys
- Imported agents run within consumer boundaries (tenant, audit, retention scope)
- Cross-tenant isolation is strictly enforced

### Current Limitations

- No transitive dependencies (modules cannot import other modules)
- No semver ranges (`^1.0.0` not supported)
- Maximum 5 module dependencies per consumer project
- No cross-tenant sharing

## Key Takeaways

- Imported modules use the **double underscore** (`alias__name`) naming convention for all mounted symbols, with deep rewriting across all references
- Published releases have an **immutability guarantee** -- the artifact, contract, and hash cannot be modified after publishing
- The **`LITERAL_AUTH_VALUE`** safety violation blocks publishing modules with hardcoded credentials; always use `auth_profile_ref()` or template variables
- Handle **429 rate limit** responses with **exponential backoff**, using the `retryAfterMs` field as the initial wait time
- **Environment selectors** auto-resolve to the currently promoted release on deployment, while version selectors provide pinned stability

## What's Next

Explore the **Production Deployment** module for environment management and channel configuration. See the **Studio Mastery** module for the visual module management workflow.
