# Enterprise Configuration & Admin Dashboard

Complete guide to the enterprise configuration management system, admin dashboard, and deployment setup.

---

## Table of Contents

1. [Quick Start — Accessing the Admin UI](#quick-start)
2. [Architecture Overview](#architecture)
3. [Admin Dashboard Screens](#screens)
4. [Authentication & RBAC](#authentication)
5. [Configuration System Design](#config-system)
6. [Vault Provider Architecture](#vault-providers)
7. [Development Setup](#dev-setup)
8. [Production Setup](#prod-setup)
9. [Seed Scripts](#seed-scripts)
10. [API Reference](#api-reference)

---

## <a name="quick-start"></a>1. Quick Start — Accessing the Admin UI

### Prerequisites

You need **three services** running:

| Service    | Port | Purpose                                |
| ---------- | ---- | -------------------------------------- |
| Studio API | 5173 | Issues JWT tokens (dev-login endpoint) |
| Runtime    | 3112 | Agent execution engine                 |
| Admin      | 3003 | Config/secrets management dashboard    |

### Step 1: Start the services

```bash
# Terminal 1 — Studio (issues JWT tokens)
pnpm --filter @agent-platform/studio run dev

# Terminal 2 — Runtime
pnpm --filter @agent-platform/runtime run dev

# Terminal 3 — Admin Dashboard
pnpm --filter @agent-platform/admin run dev
```

### Step 2: Get a JWT token

The admin dashboard requires a JWT token with a `role` claim. In dev mode, use the Studio dev-login endpoint:

```bash
# Login as a user (creates user if not exists)
curl -s http://localhost:5173/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "name": "Admin"}' \
  | jq .accessToken -r
```

**Important:** The token must contain a `role` claim (OWNER, ADMIN, OPERATOR, or VIEWER). This happens automatically — the main seed script (`packages/database/seed.ts`) creates 4 admin users as TenantMembers with tiered roles. No separate seed step is required.

If the user has **no TenantMember record** (or has role `MEMBER`), the token won't have an admin-eligible role and the admin middleware will reject it with `403 Insufficient permissions`.

### Step 3: Access the dashboard

**Option A — Browser with cookie:**

```bash
# Set the session cookie and open the dashboard
TOKEN=$(curl -s http://localhost:5173/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email": "superadmin@platform.internal"}' \
  | jq .accessToken -r)

# Use the token in browser DevTools console:
# document.cookie = "admin-session=" + TOKEN
```

Then navigate to `http://localhost:3003`

**Option B — API with Bearer token:**

```bash
TOKEN="your-access-token-here"

# Health check (no auth required)
curl http://localhost:3003/api/health

# Get config (requires auth)
curl http://localhost:3003/api/config?env=dev \
  -H "Authorization: Bearer $TOKEN"

# Update a config value
curl -X PUT http://localhost:3003/api/config \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path": "llm.defaultModel", "value": "claude-sonnet-4-5-20250929", "environment": "dev"}'
```

### Step 4: Login as an admin user

The main seed script (`packages/database/seed.ts`) automatically creates 4 admin users as TenantMembers:

| Email                          | Role     |
| ------------------------------ | -------- |
| `superadmin@platform.internal` | OWNER    |
| `admin@platform.internal`      | ADMIN    |
| `operator@platform.internal`   | OPERATOR |
| `viewer@platform.internal`     | VIEWER   |

Navigate to `http://localhost:3003/login` and login with any of these emails.

Alternatively, via curl:

```bash
curl -s http://localhost:5173/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email": "superadmin@platform.internal"}'
```

> **Optional:** For full MFA setup (TOTP secrets, recovery codes) and Organization-level roles, run the separate admin seed script:
>
> ```bash
> pnpm tsx scripts/seed-admin-users.ts --env dev
> ```

---

## <a name="architecture"></a>2. Architecture Overview

```
                    ┌──────────────────────────────────────────┐
                    │         Admin Dashboard (Next.js)        │
                    │              Port 3003                   │
                    │                                          │
                    │  ┌──────────┐ ┌────────┐ ┌───────────┐  │
                    │  │  Config  │ │Secrets │ │ Audit Log │  │
                    │  │  Editor  │ │Manager │ │  Viewer   │  │
                    │  └────┬─────┘ └───┬────┘ └─────┬─────┘  │
                    │       │           │             │        │
                    │  ┌────┴───────────┴─────────────┴────┐   │
                    │  │        API Routes (/api/*)         │   │
                    │  │   Role Guard · Audit Logger · MFA  │   │
                    │  └────────────────┬──────────────────┘   │
                    │                   │                      │
                    │  ┌────────────────┴──────────────────┐   │
                    │  │         JWT Middleware             │   │
                    │  │  Token verify · Role check ·       │   │
                    │  │  Session timeout · Idle timeout    │   │
                    │  └────────────────┬──────────────────┘   │
                    └───────────────────┼──────────────────────┘
                                        │
                    ┌───────────────────┼──────────────────────┐
                    │    @agent-platform/config                │
                    │                                          │
                    │  ┌─────────────┐  ┌──────────────────┐   │
                    │  │ Zod Schemas │  │  Env Mapping     │   │
                    │  │ (18 modules)│  │  (100+ vars)     │   │
                    │  └──────┬──────┘  └───────┬──────────┘   │
                    │         │                 │              │
                    │  ┌──────┴─────────────────┴──────────┐   │
                    │  │        Config Loader               │   │
                    │  │  Load → Map → Validate → Seal     │   │
                    │  └─────────────────┬─────────────────┘   │
                    │                    │                      │
                    │  ┌─────────────────┴─────────────────┐   │
                    │  │       Vault Providers              │   │
                    │  │  Env · File · AWS · HashiCorp ·    │   │
                    │  │  K8s · Azure · Composite           │   │
                    │  └───────────────────────────────────┘   │
                    └──────────────────────────────────────────┘
                                        │
                    ┌───────────────────┼──────────────────────┐
                    │    Secret Backends                       │
                    │                                          │
                    │  DEV:    process.env (flat env vars)     │
                    │  K8S:    Mounted K8s Secrets + ESO       │
                    │  AWS:    AWS Secrets Manager              │
                    │  VAULT:  HashiCorp Vault KV v2           │
                    └──────────────────────────────────────────┘
```

### Data Flow — Config Read

1. **`mapEnvToConfig(process.env, BASE_ENV_MAPPING)`** transforms flat env vars (`JWT_SECRET`, `DATABASE_URL`) into a nested config object (`{ jwt: { secret: "..." }, database: { url: "..." } }`)
2. **Vault overrides** from admin PUT operations are loaded from hierarchical paths (e.g., `/agent-platform/dev/llm/defaultModel`)
3. Overrides are **merged on top** of the env-derived config
4. Sensitive fields (containing "secret", "key", "password", "token") are **auto-masked** in API responses

### Data Flow — Config Write

1. Admin sends `PUT /api/config` with `{ path, value, environment }`
2. Value is **validated** against `BaseAppConfigSchema` (Zod)
3. Written to **vault** at hierarchical key `/agent-platform/{env}/{path}`
4. **Also written to `process.env`** via reverse mapping for immediate effect in dev mode
5. **Audit log entry** created with actor, action, target, IP

---

## <a name="screens"></a>3. Admin Dashboard Screens

### 3.1 Dashboard Home (`/`)

Three-card overview linking to the main sections:

| Card          | Description                                       | Link       |
| ------------- | ------------------------------------------------- | ---------- |
| Configuration | View and manage configuration across environments | `/config`  |
| Secrets       | Manage secrets, rotation, and access              | `/secrets` |
| Audit Log     | View all admin actions and changes                | `/audit`   |

### 3.2 Configuration (`/config` and `/config/[env]`)

**Environment tabs**: DEV | STAGING | PROD

Each environment shows configuration sections in expandable tables:

| Section       | Fields                                         | Editable         |
| ------------- | ---------------------------------------------- | ---------------- |
| Server        | port, host, logLevel                           | Yes              |
| Database      | url (masked), poolSize                         | poolSize only    |
| JWT           | secret (masked), accessExpiry, refreshExpiry   | Expiry only      |
| LLM           | provider, defaultModel, maxTokens, temperature | Yes              |
| CORS          | origins, credentials                           | Yes              |
| Rate Limiting | windowMs, maxRequests                          | Yes              |
| Observability | enabled, traceSamplingRate, loggingLevel       | Yes              |
| Redis         | enabled, url (masked), tls                     | enabled/tls only |

**Actions:**

- **Edit** button per key — inline editing with PUT to `/api/config`
- **Compare** button — opens diff view against another environment
- **Promote** button (dev/staging only) — promotes config to next environment
- **Region selector** (prod only) — switches between us-east-1, eu-west-1, ap-southeast-1

### 3.3 Config Diff (`/config/diff`)

Side-by-side environment comparison:

- Select left and right environments from dropdowns
- Color-coded differences (red = missing, yellow = different, green = same)

### 3.4 Secrets (`/secrets`)

**Scope tabs**: shared | infra | runtime | studio

Table with columns: Secret Name, Value (masked), Last Rotated, Actions

| Action       | Required Role | Extra                                              |
| ------------ | ------------- | -------------------------------------------------- |
| Reveal (MFA) | ADMIN+        | Requires TOTP code, rate-limited to 10/hour        |
| Rotate       | OPERATOR+     | OPERATOR: auto-generate only. ADMIN+: custom value |

### 3.5 Rotation History (`/secrets/rotation`)

Table showing all rotation events: Timestamp, Secret, Actor, Method, Status

### 3.6 Audit Log (`/audit`)

Full audit trail with filters:

- **Actor filter** — text search by user ID
- **Action filter** — dropdown (config_view, config_edit, secret_list, secret_reveal, secret_rotate)
- **Date filter** — date picker
- **Export CSV** — download filtered results

Action badges are color-coded:

- Gray: config_view, secret_list
- Blue: config_edit
- Red: secret_reveal
- Orange: secret_rotate

---

## <a name="authentication"></a>4. Authentication & RBAC

### JWT Token Flow

```
Studio dev-login    ──→  JWT with {sub, email, type, role, orgId}
        │
        ▼
Admin Middleware     ──→  Verify JWT · Check role · Check timeouts
        │
        ▼
API Route Handlers  ──→  getAuthContext() reads x-admin-* headers
        │
        ▼
Role Guard          ──→  requireRole(auth, 'OPERATOR') → 403 or allow
```

### Token Requirements

The JWT payload **must** contain:

- `sub` — user ID
- `email` — user email
- `type: "access"` — rejects `mfa_pending` and `refresh` tokens
- `role` — one of: `OWNER`, `ADMIN`, `OPERATOR`, `VIEWER`

### Session Management

| Parameter       | Value                                                 |
| --------------- | ----------------------------------------------------- |
| Max session age | 8 hours (from `iat`)                                  |
| Idle timeout    | 30 minutes (tracked via `admin-last-activity` cookie) |
| Cookie flags    | `httpOnly`, `secure` (prod only), `sameSite: strict`  |

### Role Hierarchy & Permissions

```
VIEWER (0) < OPERATOR (1) < ADMIN (2) < OWNER (3)
```

| Operation                     | VIEWER | OPERATOR | ADMIN | OWNER |
| ----------------------------- | ------ | -------- | ----- | ----- |
| View config                   | Yes    | Yes      | Yes   | Yes   |
| Edit config (non-prod)        | -      | Yes      | Yes   | Yes   |
| Edit config (prod)            | -      | -        | Yes   | Yes   |
| View secrets (names only)     | Yes    | -        | -     | -     |
| View secrets (masked values)  | -      | Yes      | Yes   | Yes   |
| Reveal secret (+ MFA)         | -      | -        | Yes   | Yes   |
| Create secret                 | -      | -        | Yes   | Yes   |
| Rotate secret (auto-generate) | -      | Yes      | Yes   | Yes   |
| Rotate secret (custom value)  | -      | -        | Yes   | Yes   |
| View audit log                | Yes    | Yes      | Yes   | Yes   |
| Validate config               | Yes    | Yes      | Yes   | Yes   |
| Diff environments             | Yes    | Yes      | Yes   | Yes   |

### MFA (Multi-Factor Authentication)

Required for **secret reveal** operations:

- TOTP (Time-based One-Time Password) using HMAC-SHA1
- 6-digit codes, 30-second time step, 1-step window tolerance
- **Per-user secrets** stored in `UserMFA` table (fallback: `ADMIN_MFA_SECRET` env var)
- **Replay protection** — each counter can only be used once
- **Rate limiting** — max 10 reveals per hour per user

---

## <a name="config-system"></a>5. Configuration System Design

### Schema Architecture

The config system uses **composable Zod schemas**:

```
BaseAppConfigSchema (packages/config/src/schemas/base-app.schema.ts)
├── ServerSchema        — port, host, apiUrl, frontendUrl, logLevel
├── DatabaseSchema      — url, poolSize
├── JWTSchema           — secret (32+ chars), accessExpiry, refreshExpiry
├── LLMSchema           — provider, models, temperature, maxTokens, API keys
├── OAuthSchema         — Google clientId/clientSecret
├── EncryptionSchema    — masterKey (64-char hex for AES-256)
├── RateLimitSchema     — authWindowMs, authMax, apiWindowMs, apiMax
├── CORSSchema          — origins, credentials, methods, headers
├── RedisSchema         — url, enabled, tls, cluster
├── SchedulerSchema     — retentionCron, gdprCheckCron, enabled
├── ArchiveSchema       — provider (s3/local), bucket, encryption
├── ObservabilitySchema — OTEL endpoint, sampling, logging, alerting
├── SecuritySchema      — PII detection/redaction, rate limiting
├── RegionSchema        — AWS region, isPrimary, dataResidency
└── VoiceSchema         — Twilio, Deepgram, ElevenLabs credentials
```

Apps **extend** the base schema:

```typescript
// apps/runtime/src/config/index.ts
const RuntimeConfigSchema = composeConfigSchema({
  voice: VoiceConfigSchema,
  websocket: WebSocketConfigSchema,
  checkpoint: CheckpointConfigSchema,
  features: FeatureFlagsSchema,
});
```

### Env Mapping

`BASE_ENV_MAPPING` declaratively maps 100+ flat env vars to nested config paths:

```typescript
// packages/config/src/env-mapping.ts
{
  'NODE_ENV':           'env',
  'DATABASE_URL':       'database.url',
  'JWT_SECRET':         'jwt.secret',
  'ANTHROPIC_API_KEY':  'llm.anthropicApiKey',
  'LLM_PROVIDER':       'llm.provider',
  'CORS_ORIGINS':       'cors.origins',    // comma-separated → array
  'REDIS_ENABLED':      'redis.enabled',   // 'true'/'false' → boolean
  // ... 100+ more
}
```

Type coercion is automatic:

- `'true'` / `'false'` → boolean
- Comma-separated strings → array
- Everything else → string

### Config Loader Pipeline

```
Source (Vault) → mapEnvToConfig → Zod Validate → Production Checks → Seal → Metadata
```

1. **Source**: Vault provider reads all config from backend
2. **Map**: `mapEnvToConfig()` converts flat vars to nested object
3. **Validate**: Zod schema validates types and defaults
4. **Check**: Production validation warns about insecure defaults
5. **Seal**: `deepFreeze()` (prod) or Proxy (dev) prevents mutation
6. **Metadata**: Records loadedAt, environment, vaultType, warnings

### Config Immutability

- **Production**: `Object.freeze()` recursively — throws on mutation
- **Development**: Proxy wrapper — throws descriptive error messages pointing to the exact config path

---

## <a name="vault-providers"></a>6. Vault Provider Architecture

```typescript
interface VaultProvider {
  readonly name: string;
  initialize(): Promise<void>;
  get(key: string): Promise<string | undefined>;
  getAll(prefix?: string): Promise<Record<string, string>>;
  isAvailable(): boolean;
  close(): Promise<void>;
  watch?(callback: (changedKeys: string[]) => void): void;
  set?(key: string, value: string): Promise<void>; // optional write
  delete?(key: string): Promise<void>; // optional delete
}
```

### Provider Implementations

| Provider                   | Backend                    | When Used                   | Writable  |
| -------------------------- | -------------------------- | --------------------------- | --------- |
| **EnvProvider**            | `process.env`              | Always (fallback)           | Yes       |
| **FileProvider**           | Encrypted file via `conf`  | Local dev with persistence  | Yes       |
| **AWSSecretsProvider**     | AWS Secrets Manager        | AWS/ECS/EKS deployments     | Yes       |
| **HashiCorpVaultProvider** | Vault KV v2 API            | HashiCorp Vault deployments | Yes       |
| **K8sSecretProvider**      | Mounted K8s Secret volumes | Kubernetes deployments      | No        |
| **AzureKeyVaultProvider**  | Azure Key Vault            | Azure deployments           | Stub      |
| **CompositeVaultProvider** | Priority chain of above    | Production (multi-backend)  | Delegates |

### Secret Key Hierarchy

```
/agent-platform/{environment}/{scope}/{secret-name}

Examples:
  /agent-platform/dev/shared/JWT_SECRET
  /agent-platform/prod/runtime/ANTHROPIC_API_KEY
  /agent-platform/staging/infra/DATABASE_URL
  /agent-platform/prod/studio/NEXTAUTH_SECRET
```

**Scopes:**

- `shared` — Used by multiple services (JWT_SECRET, ENCRYPTION_MASTER_KEY)
- `infra` — Infrastructure (DATABASE_URL, REDIS_URL)
- `runtime` — Runtime service only (LLM API keys, voice credentials)
- `studio` — Studio service only (NEXTAUTH_SECRET, OAuth, S3, Stripe)
- `admin` — Admin dashboard only (ADMIN_SESSION_SECRET)

---

## <a name="dev-setup"></a>7. Development Setup

### Prerequisites

- Node.js 20+
- pnpm 8.15+
- SQLite (included, no setup needed)

### Step-by-step

```bash
# 1. Clone and install
git clone <repo-url>
cd agent-dsl
pnpm install

# 2. Set up the database
pnpm --filter @agent-platform/database run db:push

# 3. Create admin .env (if not exists)
cat > apps/admin/.env << 'EOF'
NODE_ENV=development
PORT=3003
WATCHPACK_POLLING=true
DATABASE_URL=file:./../../apps/data/agent-platform.db
JWT_SECRET=<copy from apps/studio/.env — MUST match>
ADMIN_SESSION_SECRET=dev-admin-session-secret-change-in-production
EOF
```

**Critical:** The `JWT_SECRET` in the admin `.env` **must match** the Studio `.env` — the admin validates tokens issued by Studio.

```bash
# 4. Seed the database (creates dev user, tenant, admin users, roles, example projects)
cd packages/database
npx prisma db push
npx tsx seed.ts
cd ../..

# Optional: For MFA setup (TOTP + recovery codes) and Organization-level roles:
# pnpm tsx scripts/seed-admin-users.ts --env dev
# Save the TOTP secrets printed — you need them for MFA operations

# 5. Start all three services (separate terminals)
pnpm --filter @agent-platform/studio run dev    # Port 5173
pnpm --filter @agent-platform/runtime run dev   # Port 3112
pnpm --filter @agent-platform/admin run dev     # Port 3003

# 6. Get a token
TOKEN=$(curl -s http://localhost:5173/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email": "superadmin@platform.internal"}' \
  | jq .accessToken -r)

# 7. Test the admin API
curl http://localhost:3003/api/config?env=dev \
  -H "Authorization: Bearer $TOKEN" | jq .

# 8. Or set the cookie in your browser and navigate to http://localhost:3003
```

### Environment Variables

| Variable               | Required | Description                                  |
| ---------------------- | -------- | -------------------------------------------- |
| `NODE_ENV`             | Yes      | `development`                                |
| `PORT`                 | Yes      | `3003`                                       |
| `DATABASE_URL`         | Yes      | Path to shared SQLite database               |
| `JWT_SECRET`           | Yes      | Must match Studio/Runtime JWT secret         |
| `ADMIN_SESSION_SECRET` | No       | Session encryption key                       |
| `WATCHPACK_POLLING`    | No       | Set `true` on macOS to prevent EMFILE errors |
| `ARGOCD_URL`           | No       | Link to ArgoCD in sidebar footer             |
| `ADMIN_MFA_SECRET`     | No       | Fallback shared MFA secret (prefer per-user) |

---

## <a name="prod-setup"></a>8. Production Setup

### Docker Build

```bash
# Build the admin Docker image
docker build -t agent-platform-admin -f apps/admin/Dockerfile .

# Run with env vars
docker run -p 3003:3003 \
  -e NODE_ENV=production \
  -e JWT_SECRET="$JWT_SECRET" \
  -e DATABASE_URL="postgresql://..." \
  -e ADMIN_SESSION_SECRET="$(openssl rand -hex 32)" \
  agent-platform-admin
```

The Dockerfile uses multi-stage build:

- **Builder**: Node 20 Alpine, pnpm install, Next.js build
- **Runtime**: Node 20 Alpine, standalone output, non-root user (uid 1001), healthcheck on `/api/health`

### Kubernetes (Helm)

```bash
# Deploy with Helm
helm upgrade --install agent-platform deploy/helm/agent-platform \
  -f deploy/helm/agent-platform/values-prod-us-east-1.yaml \
  --namespace agent-platform

# Or for dev
helm upgrade --install agent-platform deploy/helm/agent-platform \
  -f deploy/helm/agent-platform/values-dev.yaml \
  --namespace agent-platform-dev
```

### Secret Seeding for Production

```bash
# 1. Seed auto-generated secrets (JWT, encryption keys, etc.)
pnpm tsx scripts/seed-secrets.ts --env prod --region us-east-1

# 2. Provide manual secrets (API keys you already have)
pnpm tsx scripts/seed-secrets.ts --env prod --region us-east-1 \
  --manual-values secrets-prod.json

# 3. Validate no gaps between ESO templates and manifest
pnpm tsx scripts/validate-secrets-completeness.ts
```

The `secrets-manifest.json` declares all required secrets:

| Scope   | Secrets                                                                                  | Generator          |
| ------- | ---------------------------------------------------------------------------------------- | ------------------ |
| shared  | JWT_SECRET, JWT_SECRET_PREVIOUS, ENCRYPTION_MASTER_KEY, ANTHROPIC_API_KEY                | random:64 / manual |
| infra   | DATABASE_URL, REDIS_URL                                                                  | manual             |
| runtime | OPENAI*API_KEY, GOOGLE_AI_KEY, TWILIO*\_, DEEPGRAM\_\_, ELEVENLABS\_\*, INTERNAL_API_KEY | manual             |
| studio  | NEXTAUTH*SECRET, GOOGLE_OAUTH*\_, S3\_\_, STRIPE\_\*                                     | random:64 / manual |
| admin   | ADMIN_SESSION_SECRET                                                                     | random:32          |

### Production Checklist

- [ ] `JWT_SECRET` is 64+ chars, unique per environment
- [ ] `ENCRYPTION_MASTER_KEY` is 64-char hex
- [ ] `DATABASE_URL` points to PostgreSQL (not SQLite)
- [ ] `REDIS_ENABLED=true` with TLS
- [ ] `CORS_ORIGINS` is restricted (not `*`)
- [ ] `NODE_ENV=production`
- [ ] All secrets seeded in AWS Secrets Manager
- [ ] ESO ExternalSecret CRDs deployed for secret sync
- [ ] Admin users seeded with per-user MFA secrets
- [ ] OTEL enabled with appropriate sampling rate (0.1 for prod)
- [ ] Ingress TLS configured

### Helm Values (Production)

Key overrides in `values-prod-us-east-1.yaml`:

```yaml
global:
  region: us-east-1
secrets:
  enabled: true
  aws:
    region: us-east-1
ingress:
  admin: admin.us.agent-platform.internal # Internal only
  runtime: api.us.agent-platform.example.com
  studio: studio.us.agent-platform.example.com
  tls:
    secretName: agent-platform-prod-us-east-1-tls
```

The admin dashboard should be on an **internal** hostname — it's not public-facing.

---

## <a name="seed-scripts"></a>9. Seed Scripts

### `scripts/seed-admin-users.ts`

Bootstraps admin users with tiered access:

```bash
pnpm tsx scripts/seed-admin-users.ts [--env dev] [--org-name "Name"] [--dry-run]
```

Creates:

| Email                          | Role     | Access                               |
| ------------------------------ | -------- | ------------------------------------ |
| `superadmin@platform.internal` | OWNER    | Full access + MFA                    |
| `admin@platform.internal`      | ADMIN    | Full config/secret management        |
| `operator@platform.internal`   | OPERATOR | View all, edit non-prod, auto-rotate |
| `viewer@platform.internal`     | VIEWER   | Read-only                            |

Also creates:

- Organization with ENTERPRISE plan
- Per-user TOTP secrets (printed once — save them!)
- 8 recovery codes per user (scrypt-hashed)
- OrgMember records linking users to org

### `scripts/seed-secrets.ts`

Seeds secrets into AWS Secrets Manager:

```bash
pnpm tsx scripts/seed-secrets.ts --env prod [--region us-east-1] [--dry-run]
```

### `scripts/validate-secrets-completeness.ts`

Cross-references ESO templates against the manifest:

```bash
pnpm tsx scripts/validate-secrets-completeness.ts [--check-live]
```

---

## <a name="api-reference"></a>10. API Reference

### Health

```
GET /api/health              (public, no auth)
→ { status: "ok", service: "admin" }
```

### Configuration

```
GET /api/config?env=dev      (VIEWER+)
→ { environment, config: { server: {...}, database: {...}, ... } }

PUT /api/config              (OPERATOR+, OPERATOR: non-prod only)
← { path: "llm.defaultModel", value: "gpt-4", environment: "dev" }
→ { success: true, path, environment }

POST /api/config/validate    (VIEWER+)
← { config: {...} }
→ { valid: true, errors: [], warnings: [] }

POST /api/config/diff        (VIEWER+)
← { left: {...}, right: {...}, leftLabel?: "dev", rightLabel?: "staging" }
→ { diffs: [...] }
```

### Secrets

```
GET /api/secrets?scope=shared&env=dev    (VIEWER+)
→ { secrets: { KEY: "kjhW****aEfh" } }
  (VIEWER sees '*' only, OPERATOR+ sees masked values)

POST /api/secrets                         (ADMIN+)
← { name: "NEW_KEY", value: "...", scope: "shared", environment: "dev" }
→ { success: true }

POST /api/secrets/reveal                  (ADMIN+ with MFA)
← { name: "JWT_SECRET", scope: "shared", environment: "dev", mfaToken: "123456" }
→ { name, value: "actual-unmasked-value" }

GET /api/secrets/rotation                 (VIEWER+)
→ { entries: [...last 50 rotation events] }

POST /api/secrets/rotation                (OPERATOR+)
← { name: "API_KEY", scope: "shared", environment: "dev", newValue?: "..." }
→ { success: true }
  (OPERATOR: newValue omitted → auto-generates 32-byte hex)
  (ADMIN+: can provide custom newValue)
```

### Audit

```
GET /api/audit?actor=&action=&from=&to=&limit=50    (VIEWER+)
→ { entries: [...], filters: {...}, count: N }
```

### Audit Actions Tracked

| Action          | Triggered By               |
| --------------- | -------------------------- |
| `config_view`   | GET /api/config            |
| `config_edit`   | PUT /api/config            |
| `secret_list`   | GET /api/secrets           |
| `secret_reveal` | POST /api/secrets/reveal   |
| `secret_rotate` | POST /api/secrets/rotation |
| `secret_create` | POST /api/secrets          |
