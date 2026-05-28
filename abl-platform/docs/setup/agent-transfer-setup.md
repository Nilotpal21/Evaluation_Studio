# Agent Transfer Setup Guide

This guide covers the minimum setup required to enable Agent Transfer locally in ABL Platform.

It is split into two provider paths because the boot model differs:

- **SmartAssist**: runtime-level adapter, initialized from env at runtime boot
- **Five9**: connection-backed adapter, initialized lazily from the selected project connection

## 1. What Must Exist Before You Start

- Runtime must be running and reachable from Studio.
- Redis must be available because agent transfer uses the Redis-backed transfer session store.
- Tenant encryption must be ready because transfer session fields are encrypted before being stored.
- Studio and Runtime must both be running on your local environment.

The agent transfer subsystem is enabled by default unless `AGENT_TRANSFER_ENABLED` explicitly disables it. See [apps/runtime/src/config/agent-transfer.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/apps/runtime/src/config/agent-transfer.ts:14).

## 2. Runtime Environment

Add these to `apps/runtime/.env` for local development.

### Required For Any Agent Transfer Boot

```env
AGENT_TRANSFER_ENABLED=true
RUNTIME_BASE_URL=http://localhost:3112
RUNTIME_PUBLIC_BASE_URL=http://localhost:3112
```

`RUNTIME_PUBLIC_BASE_URL` becomes the default callback base when the adapter registers webhooks. See [apps/runtime/src/config/agent-transfer.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/apps/runtime/src/config/agent-transfer.ts:92).

### Required For SmartAssist

```env
SMARTASSIST_API_URL=https://<your-smartassist-host>
SMARTASSIST_API_KEY=<your-smartassist-api-key>
SMARTASSIST_APP_ID=<smartassist-app-id>
SMARTASSIST_ORG_ID=<smartassist-org-id>
SMARTASSIST_WEBHOOK_SECRET=<optional-shared-secret>
SMARTASSIST_TIMEOUT_MS=5000
ABL_WEBHOOK_BASE_URL=http://localhost:3112
```

Optional SmartAssist voice/CSAT fields:

```env
SMARTASSIST_BOT_SIP_URI=sip:bot@example.com
SMARTASSIST_CSAT_VOICE_PROMPT=Please rate your experience...
SMARTASSIST_CSAT_VOICE_THANKYOU=Thank you for your feedback.
KORE_HOST=https://bots.kore.ai
KORE_INTERNAL_API_KEY=<optional-kore-api-key>
```

These fields are loaded into the SmartAssist adapter config at runtime boot. See [apps/runtime/src/config/agent-transfer.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/apps/runtime/src/config/agent-transfer.ts:49) and [packages/agent-transfer/src/config/schema.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/packages/agent-transfer/src/config/schema.ts:18).

### Optional Session TTL Overrides

```env
TRANSFER_SESSION_TTL_CHAT=1800
TRANSFER_SESSION_TTL_EMAIL=14400
TRANSFER_SESSION_TTL_VOICE=0
TRANSFER_SESSION_TTL_MESSAGING=1800
TRANSFER_SESSION_TTL_DEFAULT=1800
```

These are in seconds. If omitted, project lifecycle settings and package defaults apply.

### Optional Voice Gateway Type

```env
VOICE_GATEWAY_TYPE=korevg
```

Supported values are `audiocodes`, `korevg`, and `jambonz`. See [packages/agent-transfer/src/config/schema.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/packages/agent-transfer/src/config/schema.ts:95).

## 3. Studio Environment

Add these to `apps/studio/.env` or `apps/studio/.env.local`.

```env
RUNTIME_URL=http://localhost:3112
NEXT_PUBLIC_RUNTIME_URL=http://localhost:3112
```

Studio server-side proxy routes require `RUNTIME_URL`, not just `NEXT_PUBLIC_RUNTIME_URL`. See [apps/studio/src/config/runtime.server.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/apps/studio/src/config/runtime.server.ts:31).

## 4. Start the Apps

From the repo root:

```bash
pnpm --dir apps/runtime dev
pnpm --dir apps/studio dev
```

If you changed env files, restart both processes.

## 5. Create The Agent Desktop Connection In Studio

Open the project in Studio and create a connection for the provider you want to use.

### SmartAssist Connection

Create an **Agent Desktop** connection with provider `Kore SmartAssist` and fill:

- `Base URL`
- `App ID`
- `API Key` if you want Studio-managed secrets for connection-backed routing metadata
- `Webhook Secret` if SmartAssist signs webhooks
- `Organization ID` if you do not want it inferred

Studio’s SmartAssist connection schema is defined in [apps/studio/src/components/connections/agent-desktop-registry.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/apps/studio/src/components/connections/agent-desktop-registry.ts:31).

### Five9 Connection

Create an **Agent Desktop** connection with provider `Five9` and fill:

- `Tenant Name`
- `Campaign Name`
- `Auth Mode`
- `Username` and `Password` only if `Auth Mode=supervisor`
- `Host` optionally, default is `app.five9.com`
- `Callback URL` optionally, otherwise runtime generates it

Five9 is connection-backed and is initialized lazily at transfer time. See [apps/runtime/src/services/agent-transfer/index.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/apps/runtime/src/services/agent-transfer/index.ts:302).

## 6. Configure Project Agent Transfer Settings

In Studio, open the project’s **Agent Transfer** settings page and configure:

- `Default Routing Connection`
- `Queue`
- `Priority`
- `Post-Agent Action`
- `Voice Type`
- `Transfer Method`
- `Header Passthrough`
- `Recording Enabled`
- `PII de-tokenization`

These settings are stored per project through the runtime route at `/api/v1/agent-transfer/settings`. See [apps/runtime/src/routes/agent-transfer-settings.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/apps/runtime/src/routes/agent-transfer-settings.ts:170) and the Studio client model at [apps/studio/src/api/agent-transfer.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/apps/studio/src/api/agent-transfer.ts:10).

Important:

- `defaultRouting.connectionId` should point to the Agent Desktop connection you created
- transfer TTLs shown in Studio are minutes; runtime lifecycle storage uses seconds

## 7. Provider-Specific Notes

### SmartAssist

- The runtime SmartAssist adapter boots from env, not from the project connection alone.
- If `SMARTASSIST_API_URL` and `SMARTASSIST_API_KEY` are missing, the runtime still boots the subsystem but SmartAssist transfers will not be operational.
- Webhooks arrive at:

```text
/api/v1/agent-transfer/webhooks/smartassist
```

If `SMARTASSIST_WEBHOOK_SECRET` is set, signature verification is enforced. See [apps/runtime/src/routes/agent-transfer-webhooks.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/apps/runtime/src/routes/agent-transfer-webhooks.ts:109).

### Five9

- Five9 uses the selected connection metadata and credentials.
- The callback URL defaults to:

```text
<runtimeBaseUrl>/api/v1/agent-transfer/webhooks/five9?tid=<tenantId>
```

- Five9 webhooks require `?tid=` so the runtime can resolve tenant scope. See [apps/runtime/src/routes/agent-transfer-webhooks.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/apps/runtime/src/routes/agent-transfer-webhooks.ts:149).

## 8. Smoke Tests

Use these checks after setup.

### Check Runtime Boot

Call the project settings route through Studio:

```bash
curl "http://localhost:5173/api/projects/<projectId>/agent-transfer/settings" \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-Id: <tenantId>"
```

Expected result:

- `success: true`
- `data` returns settings or `null` for a new project

### Check Runtime Settings Route Directly

```bash
curl "http://localhost:3112/api/v1/agent-transfer/settings" \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-Id: <tenantId>" \
  -H "X-Project-Id: <projectId>"
```

### Check Transfer Sessions Route

```bash
curl "http://localhost:3112/api/v1/agent-transfer/sessions" \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-Id: <tenantId>" \
  -H "X-Project-Id: <projectId>"
```

Expected result:

- `503 NOT_INITIALIZED` means the subsystem did not boot
- `200` with an empty `sessions` list means boot succeeded and there are no active transfers yet

The sessions route is defined at [apps/runtime/src/routes/agent-transfer-sessions.ts](/Users/SrinivasaRao.Yasarla/Documents/projects/dev-abl-platform/abl-platform/apps/runtime/src/routes/agent-transfer-sessions.ts:178).

## 9. Common Failure Modes

### `NOT_INITIALIZED`

Likely causes:

- runtime booted with `AGENT_TRANSFER_ENABLED=false`
- Redis not available
- tenant encryption not initialized
- runtime boot failed before registering the session store or adapter registry

### Settings Save Works But Transfers Do Not Start

Likely causes:

- no `defaultRouting.connectionId` selected
- SmartAssist env missing from runtime
- Five9 connection credentials incomplete
- provider webhook callback URL not reachable from the provider

### Webhooks Return `INVALID_SIGNATURE`

Likely causes:

- `SMARTASSIST_WEBHOOK_SECRET` does not match provider configuration
- raw-body middleware/signing headers do not match provider expectations

## 10. Recommended Local Bring-Up Order

1. Start Redis and confirm runtime can connect to it.
2. Add runtime env and restart runtime.
3. Add Studio `RUNTIME_URL` and restart Studio.
4. Create the Agent Desktop connection in Studio.
5. Save project Agent Transfer settings with that connection selected.
6. Verify `GET /api/v1/agent-transfer/settings` succeeds.
7. Trigger a transfer flow from a project/agent that uses transfer tooling.
