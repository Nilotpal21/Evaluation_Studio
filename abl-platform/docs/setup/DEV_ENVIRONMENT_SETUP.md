# Development Environment Setup & Cleanup

Instructions for setting up or recovering a local dev environment. Use this as a prompt for Claude Code or follow manually.

## Prerequisites

- Node.js >= 21
- pnpm (`npm i -g pnpm`)
- Docker (for infrastructure services)
- Anthropic API key

## Quick Setup (Fresh Clone)

```bash
# 1. Install dependencies
pnpm install

# 2. Create .env files
#    Runtime and Studio MUST share the same DATABASE_URL, JWT_SECRET, and ENCRYPTION_MASTER_KEY

# Generate shared secrets
JWT_SECRET=$(openssl rand -base64 64)
ENCRYPTION_KEY=$(openssl rand -hex 32)
DB_PATH="file:$(pwd)/apps/data/agent-platform.db"

# Runtime .env
cat > apps/runtime/.env << EOF
NODE_ENV=development
PORT=3112
HOST=0.0.0.0
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
DATABASE_URL=${DB_PATH}
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_MASTER_KEY=${ENCRYPTION_KEY}
ANTHROPIC_API_KEY=<your-key-here>
ANTHROPIC_DEFAULT_MODEL=claude-haiku-4-5-20251001
ANTHROPIC_MAX_TOKENS=4096
RATE_LIMIT_ENABLED=false
FEATURE_VOICE_ENABLED=false
FEATURE_STREAMING_ENABLED=true
FEATURE_MULTI_AGENT=true
FEATURE_DEBUG_TRACES=true
EOF

# Studio .env
cat > apps/studio/.env << EOF
NODE_ENV=development
PORT=5173
NEXT_PUBLIC_RUNTIME_URL=http://localhost:3112
NEXT_PUBLIC_APP_URL=http://localhost:5173
DATABASE_URL=${DB_PATH}
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_MASTER_KEY=${ENCRYPTION_KEY}
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d
NEXTAUTH_SECRET=$(openssl rand -base64 32)
NEXTAUTH_URL=http://localhost:5173
ANTHROPIC_API_KEY=<your-key-here>
RATE_LIMIT_ENABLED=false
EOF

# Database package .env (ensures prisma commands target the shared DB)
cat > packages/database/.env << EOF
DATABASE_URL=${DB_PATH}
EOF

# 3. Push schema and seed
cd packages/database
npx prisma db push
npx tsx seed.ts
cd ../..

# 4. Start the platform (Docker infra + app services)
./apx up

# Or start individual services manually:
# pnpm --filter runtime dev   # Terminal 1 — http://localhost:3112
# pnpm --filter studio dev    # Terminal 2 — http://localhost:5173
```

## Cleanup: Migrating From Legacy Setup

If you had a previous version with the old auth system (Organization model, `pk_demo_preview`, legacy `?apiKey=` WebSocket flow), run through this checklist.

### 1. Remove Stale Database Files

The old setup may have created multiple SQLite databases. Only one should exist.

```bash
# Remove any stale default DBs
rm -f packages/database/prisma/dev.db
rm -f apps/runtime/data/runtime.db
rm -f apps/studio/data/studio.db

# The shared DB lives here:
ls -la apps/data/agent-platform.db
```

### 2. Reset and Reseed the Database

The schema changed significantly (Organization → Tenant, added TenantMember, RoleDefinition, ResourcePermission, SDKChannel, Deployment, etc.). Force-reset is the cleanest path.

```bash
cd packages/database

# Force-reset drops all tables and recreates from schema
npx prisma db push --force-reset

# Seed creates: dev user, tenant, roles, example projects with agents
npx tsx seed.ts

cd ../..
```

After seeding you should have:

- User: `dev@kore.ai` (id: `user-dev-001`)
- Tenant: `Dev Workspace` (id: `tenant-dev-001`)
- TenantMember: dev user as OWNER of dev tenant
- 4 admin users as TenantMembers with tiered roles:
  - `superadmin@platform.internal` — OWNER
  - `admin@platform.internal` — ADMIN
  - `operator@platform.internal` — OPERATOR
  - `viewer@platform.internal` — VIEWER
- 5 system RoleDefinitions (OWNER, ADMIN, OPERATOR, MEMBER, VIEWER)
- 6 example projects with agents loaded from `examples/`

> **Note:** The admin users are created by the main seed script (`packages/database/seed.ts`) as TenantMembers, so they work immediately with the admin dashboard's dev-login without needing to run the separate `scripts/seed-admin-users.ts` script.

### 3. Ensure Consistent DATABASE_URL

All three locations MUST point to the same absolute path:

| File                     | Should contain                                                  |
| ------------------------ | --------------------------------------------------------------- |
| `apps/runtime/.env`      | `DATABASE_URL=file:<absolute-path>/apps/data/agent-platform.db` |
| `apps/studio/.env`       | `DATABASE_URL=file:<absolute-path>/apps/data/agent-platform.db` |
| `packages/database/.env` | `DATABASE_URL=file:<absolute-path>/apps/data/agent-platform.db` |

**Why**: Without `packages/database/.env`, running `prisma db push` from the database package directory creates/updates a default `prisma/dev.db` instead of the shared database. This is the most common cause of "tenantId column missing" errors.

### 4. Ensure Matching JWT_SECRET

Runtime and Studio MUST use the same `JWT_SECRET`. If they differ, tokens issued by Studio's dev-login won't validate in Runtime.

```bash
# Check they match
grep JWT_SECRET apps/runtime/.env
grep JWT_SECRET apps/studio/.env
# These should be identical
```

### 5. Remove Legacy Files

These files were removed in the SDK auth refactor and should not exist:

```bash
rm -f apps/runtime/src/lib/preview-token.ts
rm -f apps/studio/src/lib/preview-token.ts
rm -f apps/runtime/test-pipeline-integrity.cjs
rm -f apps/runtime/test-constraint-compilation.cjs
rm -f apps/runtime/test-sdk-e2e.cjs
rm -f docs/runtime-executor-review.md
rm -rf "sessions spec view/"
```

### 6. Verify the Setup

```bash
# Start runtime
pnpm --filter runtime dev

# In another terminal, run health check
curl http://localhost:3112/health
# Expected: {"status":"healthy","database":"connected",...}

# Test dev-login (via studio)
pnpm --filter studio dev
curl -X POST http://localhost:5173/api/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev@kore.ai","name":"Developer"}'
# Expected: {"user":{"id":"user-dev-001",...},"accessToken":"...","tenantId":"tenant-dev-001","role":"OWNER"}

# Test sessions API with the token
TOKEN=<accessToken from above>
curl http://localhost:3112/api/sessions -H "Authorization: Bearer $TOKEN"
# Expected: {"success":true,"total":0,"sessions":[]}

# Run tests
pnpm --filter runtime exec vitest run
# Expected: 470+ tests pass (version-service tests may fail due to pre-existing mock issues)
```

## Architecture: Three Auth Flows

The platform uses three distinct authentication flows. Clients must use the correct one.

| Flow                  | Who Uses It               | How It Works                                                                                                                                         |
| --------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User JWT**          | Studio UI, admin API      | `POST /api/auth/dev-login` → JWT with `tokenClass: 'user'`, `tenantId`, `role` → pass as `Authorization: Bearer <jwt>`                               |
| **SDK Session Token** | SDK widget, preview pages | `POST /api/v1/sdk/init` with `X-Public-Key: pk_*` header → JWT with `type: 'sdk_session'` → connect WS with `Sec-WebSocket-Protocol: sdk-auth,<jwt>` |
| **API Key**           | External API consumers    | Pass `Authorization: Bearer abl_*` → SHA-256 hash lookup in DB → tenant context resolved                                                             |

### SDK WebSocket Connection (Current)

```
Client                          Runtime
  |                                |
  |  POST /api/v1/sdk/init         |
  |  X-Public-Key: pk_xxx          |
  |------------------------------->|
  |  { token, tenantId, ... }      |
  |<-------------------------------|
  |                                |
  |  WS /ws/sdk + sdk-auth protocol|
  |------------------------------->|
  |  { type: "session_start" }     |
  |<-------------------------------|
```

The legacy `?apiKey=pk_xxx&projectId=xxx` WebSocket flow has been removed. All SDK connections now require a session token from `/api/v1/sdk/init` and must present it via `Sec-WebSocket-Protocol`.

### Preview Pages

- `/preview/[projectId]` — Calls `POST /api/sdk/preview-token` (studio route) to get an SDK session JWT, then connects via `Sec-WebSocket-Protocol`
- `/preview#share_token=xxx` (share link) — Exchanges the fragment token via `POST /api/sdk/share/exchange`, receives an SDK session JWT, then connects via `Sec-WebSocket-Protocol`

## Troubleshooting

### "User not found" from sessions API

**Cause**: JWT `sub` claim doesn't match any user ID in the database.
**Fix**: Re-seed the database (`cd packages/database && npx tsx seed.ts`). Dev-login creates JWT with `sub: user-dev-001` which must exist in the User table.

### "column tenantId does not exist"

**Cause**: Database schema is out of date — likely `prisma db push` was run without `DATABASE_URL` set, updating the wrong DB file.
**Fix**:

1. Ensure `packages/database/.env` exists with correct `DATABASE_URL`
2. Run `cd packages/database && npx prisma db push --force-reset && npx tsx seed.ts`

### "ReadOnlyClient Write operation rejected"

**Cause**: Runtime's Prisma client restricts writes to a whitelist. A model is missing from `WRITABLE_MODELS` in `apps/runtime/src/db/index.ts`.
**Fix**: Add the model name to the `WRITABLE_MODELS` array.

### SDK init returns 500 "Internal server error"

**Cause**: Usually the `PublicApiKey` or `SDKChannel` model is not in `WRITABLE_MODELS`.
**Fix**: Verify `PublicApiKey`, `SDKChannel`, and `AuditLog` are in `WRITABLE_MODELS` in `apps/runtime/src/db/index.ts`.

### WebSocket closes with 4001 "Missing token"

**Cause**: Client is using the legacy `?apiKey=` flow which has been removed.
**Fix**: Use `POST /api/v1/sdk/init` to get a session token first, then connect with `Sec-WebSocket-Protocol: sdk-auth,<jwt>`.

### WebSocket closes with 4003 "Tenant mismatch"

**Cause**: The SDK session token's `tenantId` doesn't match the project's `tenantId` in the database.
**Fix**: Ensure the public API key belongs to the same tenant as the project.

### WebSocket closes with 4029 "Too many connections"

**Cause**: IP-based rate limit (30 connections/minute) exceeded.
**Fix**: Wait 60 seconds for the window to reset.
