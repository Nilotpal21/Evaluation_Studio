# Auth Profile — Setup Instructions, Provider Metadata & Maintenance Guide

**Date:** 2026-03-11
**Companion to:** `docs/plans/2026-03-11-auth-profile-design.md`

---

## 1. Current Setup & Configuration Patterns

### 1.1 Environment Variable-Based Auth (Status Quo)

Users currently configure authentication through environment variables scattered across three `.env.example` files. Each app owns its own credential surface area, creating duplication and inconsistency.

#### Studio (`apps/studio/.env.example`)

| Purpose                | Variables                                                                        | Notes                                                 |
| ---------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Platform OAuth (login) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                       | NextAuth-managed, for user sign-in                    |
| Platform OAuth (login) | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                                       | NextAuth-managed, for user sign-in                    |
| Connector OAuth apps   | `OAUTH_PROVIDER_<PROVIDER>_CLIENT_ID`, `OAUTH_PROVIDER_<PROVIDER>_CLIENT_SECRET` | Pattern-based: `GOOGLE`, `SLACK`, `GITHUB` documented |
| LLM keys               | `ANTHROPIC_API_KEY`                                                              | Server-side only                                      |
| Encryption             | `ENCRYPTION_MASTER_KEY`                                                          | Must match Runtime                                    |

#### Runtime (`apps/runtime/.env.example`)

| Purpose        | Variables                                                                                                                                | Notes                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| LLM providers  | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`, `AZURE_OPENAI_API_KEY/ENDPOINT`, `AWS_BEDROCK_REGION`                        | 5 LLM providers supported                       |
| Channel OAuth  | `CHANNEL_OAUTH_SLACK_CLIENT_ID`, `CHANNEL_OAUTH_SLACK_CLIENT_SECRET`, `CHANNEL_OAUTH_SLACK_SIGNING_SECRET`, `CHANNEL_OAUTH_SLACK_SCOPES` | Only Slack documented                           |
| Voice services | `TWILIO_*` (5 vars), `DEEPGRAM_*` (3 vars), `ELEVENLABS_*` (3 vars), `LIVEKIT_*` (5 vars)                                                | Voice providers have their own env var families |
| Encryption     | `ENCRYPTION_MASTER_KEY`                                                                                                                  | Must match Studio                               |

#### Root (`.env.example`)

| Purpose    | Variables               | Notes                                                   |
| ---------- | ----------------------- | ------------------------------------------------------- |
| Encryption | `ENCRYPTION_MASTER_KEY` | Shared across runtime, workflow-engine, pipeline-engine |

### 1.2 LLM Provider Setup (Database-Backed)

LLM credentials are stored in MongoDB via the `LLMCredential` model (accessed through `apps/studio/src/repos/credential-repo.ts`). The flow:

1. User navigates to Settings > LLM Providers in Studio
2. Enters API key, selects provider (Anthropic, OpenAI, Azure, etc.)
3. Studio encrypts the key using the `encryptionPlugin` (AES-256-GCM)
4. Stores as `LLMCredential` document with `encryptedApiKey`, `tenantId`, `ownerId`
5. `TenantModel` references `LLMCredential` via `connections[].credentialId`

**Current schema fields:** `tenantId`, `credentialScope` (user|tenant), `ownerId`, `provider`, `name`, `encryptedApiKey`, `encryptedEndpoint`, `customHeaders`, `authType`, `authConfig`, `isActive`, `isDefault`, `lastUsedAt`, `lastValidatedAt`

### 1.3 Connector OAuth App Setup

Connectors (Gmail, GitHub, Slack, etc.) use a dual-credential pattern:

- **Platform-level:** `OAUTH_PROVIDER_<NAME>_CLIENT_ID/SECRET` env vars in Studio
- **User-level:** `EndUserOAuthToken` documents in MongoDB, managed by `tool-oauth-service.ts`

The `tool-oauth-service.ts` defines its own `OAuthProviderConfig` interface:

```typescript
interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  scopes: string[];
}
```

### 1.4 Channel OAuth Setup

Channel connections (Slack, WhatsApp, MS Teams) use a separate `channel-oauth` service tree:

- `apps/runtime/src/services/channel-oauth/` — service + provider implementations
- Provider-specific classes: `SlackOAuthProvider`, `MetaOAuthProvider`, `MsTeamsOAuthProvider`
- Each hardcodes its own OAuth URLs (e.g., `SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'`)
- Client ID/secret come from env vars: `CHANNEL_OAUTH_SLACK_CLIENT_ID`, etc.
- Studio client: `apps/studio/src/api/channel-oauth.ts` — thin wrapper for initiate/callback

### 1.5 Enterprise Data Connectors (SearchAI)

`ConnectorConfig` model (`packages/database/src/models/connector-config.model.ts`) stores:

- `oauthTokenId` — references `EndUserOAuthToken._id`
- `connectionConfig.clientId`, `connectionConfig.scopes` — duplicated OAuth metadata
- Supports: SharePoint, Jira, Confluence, HubSpot, ServiceNow, Salesforce

### 1.6 Summary of Auth Fragmentation

| Credential Type        | Storage Location        | Encryption                   | Refresh Logic Location     |
| ---------------------- | ----------------------- | ---------------------------- | -------------------------- |
| LLM API keys           | `LLMCredential` (Mongo) | `encryptionPlugin` (AES-GCM) | N/A (static keys)          |
| Connector OAuth tokens | `EndUserOAuthToken`     | `encryptionPlugin`           | `tool-oauth-service.ts`    |
| Channel OAuth tokens   | `ChannelConnection`     | `encryptedCredentials` field | `channel-oauth-service.ts` |
| Enterprise connectors  | `ConnectorConfig`       | Via `oauthTokenId` reference | `connector-sync-worker.ts` |
| Tool secrets (DSL)     | `ToolSecret` / env vars | `encryptionPlugin`           | N/A (static)               |
| Platform login OAuth   | NextAuth session        | NextAuth built-in            | NextAuth built-in          |

Auth Profile will unify the top 5 rows into a single `AuthProfile` entity. Platform login (NextAuth) remains separate.

---

## 2. Nango providers.yaml Analysis

### 2.1 Existing Nango Integration

The codebase has a complete Nango import pipeline, though the generated output is currently empty:

| File                                                              | Purpose                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/connectors/src/adapters/nango/provider-mapper.ts`       | Maps Nango YAML schema to our `ProviderConfig` type                      |
| `packages/connectors/src/adapters/nango/importer.ts`              | Import orchestration, YAML URL constant                                  |
| `scripts/import-nango-providers.ts`                               | CLI script: fetch YAML, parse, write JSON                                |
| `packages/connectors/src/auth/provider-config-registry.ts`        | Runtime lookup: loads generated JSON, provides `getProviderConfig(name)` |
| `packages/connectors/src/adapters/nango/generated/providers.json` | **Currently empty `[]`** — script has not been run                       |
| `packages/connectors/src/__tests__/nango-importer.test.ts`        | Unit tests for mapper + importer                                         |

### 2.2 Nango's providers.yaml Schema

Source: `https://raw.githubusercontent.com/NangoHQ/nango/master/packages/shared/providers.yaml`

Per the `NangoProvider` interface already mapped in our codebase, each Nango provider entry contains:

| Field                  | Type                                           | Our Mapping                            | Relevance to Auth Profile                                                    |
| ---------------------- | ---------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| `auth_mode`            | `OAUTH2 \| OAUTH1 \| API_KEY \| BASIC \| NONE` | `authMode`                             | Maps directly to `authType`                                                  |
| `authorization_url`    | string                                         | `authorizationUrl`                     | `oauth2_app.config.authorizationUrl`                                         |
| `token_url`            | string                                         | `tokenUrl`                             | `oauth2_app.config.tokenUrl`                                                 |
| `refresh_url`          | string?                                        | `refreshUrl` (defaults to `token_url`) | `oauth2_app.config.refreshUrl`                                               |
| `authorization_params` | Record                                         | `authorizationParams`                  | Needed for providers requiring `access_type=offline`, `prompt=consent`, etc. |
| `token_params`         | Record                                         | `tokenParams`                          | Custom token exchange params                                                 |
| `scope_separator`      | string                                         | `scopeSeparator` (default: `' '`)      | `oauth2_app.config.scopeSeparator`                                           |
| `default_scopes`       | string[]                                       | `defaultScopes`                        | `oauth2_app.config.defaultScopes`                                            |
| `pkce`                 | boolean                                        | `pkce` (default: false)                | `oauth2_app.config.pkceRequired`                                             |
| `docs`                 | string?                                        | `docsUrl`                              | `oauth2_app.config.docsUrl` — links to provider API docs                     |
| `connection_config`    | Record?                                        | Not yet mapped                         | Provider-specific config (e.g., `subdomain` for Zendesk)                     |
| `proxy.base_url`       | string?                                        | `proxyBaseUrl`                         | Useful for API call routing                                                  |

### 2.3 What Nango Does NOT Provide (Gaps for Auth Profile)

| Missing Data               | Why We Need It                                    | Solution                                        |
| -------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `setup_guide_url`          | Inline help for "How to create an OAuth app"      | Maintain our own per-provider guide URLs        |
| `revocationUrl`            | Token revocation endpoint                         | Add to our provider metadata                    |
| `deviceAuthorizationUrl`   | Device authorization grant flow                   | Add to our provider metadata                    |
| `tokenIntrospectionUrl`    | Token introspection for validation                | Add to our provider metadata                    |
| `supportedGrantTypes`      | Which OAuth grant types the provider supports     | Derive from `auth_mode` + manual annotation     |
| Human-readable setup steps | Step-by-step instructions for creating OAuth apps | Author and maintain per-provider                |
| Icon/logo URLs             | For catalog UI display                            | Already in connector catalog (separate concern) |

### 2.4 Nango Provider Count Estimates

Nango's `providers.yaml` contains 250+ providers (as of early 2026). After filtering to OAuth2 only, approximately 180+ providers are available. Our connector catalog currently has ~25 implemented connectors. The gap is bridged by importing Nango metadata for all 180+ OAuth2 providers — even those without full connector implementations — so that Auth Profile can provide correct OAuth URLs when a user manually configures an `oauth2_app` for any provider.

---

## 3. Connector Catalog Current State

### 3.1 CatalogEntry Schema

Defined in `packages/connectors/src/catalog/extract-entry.ts`:

```typescript
interface CatalogEntry {
  name: string;
  displayName: string;
  version: string;
  description: string;
  category: string;
  authType: string;
  actions: { name; displayName; description }[];
  triggers: { name; displayName; description }[];
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    defaultScopes: string[];
    scopeSeparator: string;
    pkce: boolean;
  };
}
```

### 3.2 OAuth Metadata Already in Catalog

The `connector-catalog.json` includes OAuth2 metadata for connectors that declare it. Example from the GitHub entry:

```json
{
  "name": "github",
  "authType": "oauth2",
  "oauth2": {
    "authorizationUrl": "https://github.com/login/oauth/authorize",
    "tokenUrl": "https://github.com/login/oauth/access_token",
    "defaultScopes": ["admin:repo_hook", "admin:org", "repo"],
    "scopeSeparator": " ",
    "pkce": false
  }
}
```

### 3.3 Gap Analysis: Catalog vs Auth Profile Needs

| Field                    | In CatalogEntry             | Needed by Auth Profile `oauth2_app`       | Gap                            |
| ------------------------ | --------------------------- | ----------------------------------------- | ------------------------------ |
| `authorizationUrl`       | Yes                         | Yes                                       | None                           |
| `tokenUrl`               | Yes                         | Yes                                       | None                           |
| `refreshUrl`             | Yes (optional)              | Yes                                       | None                           |
| `defaultScopes`          | Yes                         | Yes                                       | None                           |
| `scopeSeparator`         | Yes                         | Yes                                       | None                           |
| `pkce`                   | Yes                         | `pkceRequired` + `pkceMethod`             | Need `pkceMethod` (S256/plain) |
| `revocationUrl`          | **No**                      | Yes                                       | Add to catalog                 |
| `deviceAuthorizationUrl` | **No**                      | Yes                                       | Add to catalog                 |
| `tokenIntrospectionUrl`  | **No**                      | Yes                                       | Add to catalog                 |
| `supportedGrantTypes`    | **No**                      | Yes                                       | Add to catalog                 |
| `setupGuideUrl`          | **No**                      | Yes                                       | Add to catalog                 |
| `docsUrl`                | **No** (`docsUrl` in Nango) | Yes                                       | Import from Nango              |
| `authorizationParams`    | **No**                      | Yes (runtime needs `access_type=offline`) | Import from Nango              |
| `tokenParams`            | **No**                      | Yes                                       | Import from Nango              |
| `refreshTokenRotation`   | **No**                      | Yes (for `oauth2_token`)                  | Manual annotation              |
| `connectionConfig`       | **No**                      | Yes (e.g., subdomain for Zendesk)         | Import from Nango              |

### 3.4 Required CatalogEntry Enrichment

Extend `CatalogEntry.oauth2` to include all fields Auth Profile needs:

```typescript
oauth2?: {
  // Existing
  authorizationUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  defaultScopes: string[];
  scopeSeparator: string;
  pkce: boolean;
  // New — from Nango
  pkceMethod?: 'S256' | 'plain';
  authorizationParams?: Record<string, string>;
  tokenParams?: Record<string, string>;
  docsUrl?: string;
  // New — manually maintained
  revocationUrl?: string;
  deviceAuthorizationUrl?: string;
  tokenIntrospectionUrl?: string;
  supportedGrantTypes?: string[];
  setupGuideUrl?: string;
  refreshTokenRotation?: boolean;
};
```

The `enrichWithOAuth()` function in `extract-entry.ts` already merges Nango provider data into catalog entries — extend it to carry the new fields.

---

## 4. Provider-Specific Setup Guides

### 4.1 Google (OAuth Consent Screen)

**Steps users must complete:**

1. Go to [Google Cloud Console > APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth 2.0 Client ID (type: Web application)
3. Add authorized redirect URI: `{STUDIO_URL}/api/projects/{projectId}/auth-profiles/oauth/callback`
4. Configure OAuth consent screen (external or internal)
5. Add required scopes (Gmail: `https://www.googleapis.com/auth/gmail.send`, Calendar: `https://www.googleapis.com/auth/calendar.readonly`, etc.)
6. For production: submit for Google verification (if requesting sensitive scopes)

**Gotchas:**

- Must enable specific APIs in the project (Gmail API, Calendar API, etc.)
- `access_type=offline` required for refresh tokens (our Nango data includes this in `authorization_params`)
- `prompt=consent` needed to force refresh token issuance on re-authorization
- Unverified apps show a warning screen; users must click through in dev

**Setup guide URL:** `https://developers.google.com/identity/protocols/oauth2/web-server`

### 4.2 Microsoft / Azure (App Registration)

**Steps:**

1. Go to [Azure Portal > App Registrations](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. New registration (single-tenant or multi-tenant)
3. Add redirect URI: `{STUDIO_URL}/api/projects/{projectId}/auth-profiles/oauth/callback`
4. Under "Certificates & secrets," create a client secret
5. Under "API permissions," add required Microsoft Graph permissions (e.g., `Mail.Send`, `Calendars.Read`)
6. Grant admin consent (for organizational permissions)

**Gotchas:**

- Client secrets expire (max 24 months); rotation is required
- Multi-tenant vs single-tenant affects `authorization_url` (uses `{tenantId}` placeholder)
- Some permissions require admin consent before users can authorize

**Setup guide URL:** `https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app`

### 4.3 Slack (Bot Tokens & Scopes)

**Steps:**

1. Go to [Slack API > Your Apps](https://api.slack.com/apps)
2. Create New App (from scratch or manifest)
3. Under "OAuth & Permissions," add redirect URL: `{STUDIO_URL}/api/projects/{projectId}/auth-profiles/oauth/callback`
4. Add bot token scopes (e.g., `chat:write`, `channels:read`, `im:history`)
5. Install to workspace
6. Copy Client ID, Client Secret, and Signing Secret

**Gotchas:**

- Bot tokens (`xoxb-`) vs user tokens (`xoxp-`) — most integrations need bot tokens
- Scope separator is comma (`,`), not space
- Signing secret is separate from client secret (used for event verification)
- Socket Mode vs Events API affects how real-time events are received

**Current env vars:** `CHANNEL_OAUTH_SLACK_CLIENT_ID`, `CHANNEL_OAUTH_SLACK_CLIENT_SECRET`, `CHANNEL_OAUTH_SLACK_SIGNING_SECRET`, `CHANNEL_OAUTH_SLACK_SCOPES`

**Setup guide URL:** `https://api.slack.com/quickstart`

### 4.4 GitHub (OAuth App vs GitHub App)

**Two options:**

**OAuth App (simpler):**

1. Go to [GitHub > Settings > Developer Settings > OAuth Apps](https://github.com/settings/developers)
2. Register new OAuth application
3. Set callback URL: `{STUDIO_URL}/api/projects/{projectId}/auth-profiles/oauth/callback`
4. Note: OAuth Apps grant broad access to all user repos

**GitHub App (recommended for production):**

1. Go to [GitHub > Settings > Developer Settings > GitHub Apps](https://github.com/settings/apps)
2. Create new GitHub App with fine-grained permissions
3. Set callback URL and webhook URL
4. Install on specific repositories

**Gotchas:**

- GitHub OAuth does not support PKCE
- Access tokens do not expire by default (no refresh needed for OAuth Apps)
- GitHub Apps use installation tokens that do expire (1 hour)

**Setup guide URL:** `https://docs.github.com/en/apps/creating-github-apps`

### 4.5 Salesforce

**Steps:**

1. Go to Setup > App Manager > New Connected App
2. Enable OAuth Settings
3. Set callback URL
4. Select OAuth scopes (`api`, `refresh_token`, `offline_access`)
5. For sandbox: use `https://test.salesforce.com` as authorization base URL

**Gotchas:**

- Sandbox vs production have different OAuth URLs
- IP restrictions may block token exchange from unexpected IPs
- Connected App needs 2-10 minutes to propagate after creation

**Setup guide URL:** `https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm`

### 4.6 HubSpot

**Steps:**

1. Go to [HubSpot Developer Portal](https://developers.hubspot.com/)
2. Create an app
3. Under "Auth," add redirect URI
4. Select required scopes (e.g., `crm.objects.contacts.read`)

**Gotchas:**

- HubSpot uses comma-separated scopes
- Rate limits are per-app, not per-token
- Private app tokens (API keys) are simpler for server-side-only access

**Setup guide URL:** `https://developers.hubspot.com/docs/api/working-with-oauth`

### 4.7 Surfacing Setup Guides in the UI

The Auth Profile design (Section 7.5) specifies inline setup help powered by Nango metadata. Implementation plan:

1. **Static guide content**: Store per-provider markdown guides in `packages/connectors/src/guides/` (e.g., `google.md`, `slack.md`). Keep guides short (redirect URI, common scopes, gotchas).

2. **Expandable help panel**: When creating an `oauth2_app` Auth Profile, show:
   - Auto-generated redirect URI (copy-able): `{APP_URL}/api/projects/{pid}/auth-profiles/oauth/callback`
   - "How to get these credentials?" expandable section
   - Link to provider's developer console (from `docsUrl`)
   - Common scopes checklist (from `defaultScopes`)
   - Provider-specific gotchas (from static guides)

3. **Dynamic links**: Use `setupGuideUrl` from enriched catalog, falling back to Nango's `docsUrl`, then to a generic "OAuth 2.0 setup" guide.

---

## 5. Keeping Up to Date

### 5.1 Nango providers.yaml Sync Strategy

**Current mechanism:** `pnpm connectors:import-providers` runs `scripts/import-nango-providers.ts`, which fetches from `https://raw.githubusercontent.com/NangoHQ/nango/master/packages/shared/providers.yaml` and writes to `packages/connectors/src/adapters/nango/generated/providers.json`.

**Problem:** The generated file is currently empty (`[]`), meaning the import script has never been run successfully in the current branch.

**Recommended sync cadence:**

| Frequency   | Trigger                                           | Action                                                 |
| ----------- | ------------------------------------------------- | ------------------------------------------------------ |
| Weekly (CI) | Scheduled GitHub Action (cron)                    | Run import script, open PR if `providers.json` changed |
| On demand   | Developer runs `pnpm connectors:import-providers` | Manual refresh for adding new providers                |
| On release  | Pre-release CI step                               | Ensure providers are up to date before deploying       |

**CI workflow sketch:**

```yaml
name: sync-nango-providers
on:
  schedule:
    - cron: '0 6 * * 1' # Every Monday at 6am UTC
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm connectors:import-providers
      - uses: peter-evans/create-pull-request@v6
        with:
          title: 'chore(connectors): sync Nango provider metadata'
          branch: chore/sync-nango-providers
```

### 5.2 When Providers Change OAuth Endpoints

OAuth endpoint changes are rare but do happen (e.g., Microsoft deprecating v1.0 endpoints). Detection strategies:

1. **Diff detection in weekly sync**: The CI job compares new `providers.json` against the checked-in version. Any URL changes appear in the PR diff for human review.

2. **Runtime validation (background)**: A periodic health check job can attempt a lightweight request to each provider's `authorizationUrl` (HEAD request, expect 200/302). Log warnings for non-responsive URLs.

3. **Scope deprecation detection**: When Nango updates `default_scopes` for a provider, the sync PR highlights the change. Manual review determines if existing Auth Profiles need scope updates.

4. **Provider status page monitoring**: For critical providers (Google, Microsoft, Slack), consider monitoring their status pages or changelog RSS feeds.

### 5.3 Versioning of Provider Metadata

Provider metadata should be versioned for auditability:

```typescript
// In the enriched catalog / provider config
{
  providerMetadataVersion: '2026-03-11',  // Date of last Nango sync
  nangoCommitSha: 'abc123...',            // Git SHA of providers.yaml source
  lastSyncedAt: '2026-03-11T06:00:00Z',
  manualOverrides: ['revocationUrl', 'setupGuideUrl'],  // Fields we added beyond Nango
}
```

Store the Nango source commit SHA alongside the generated JSON so we can trace exactly which version of Nango metadata is deployed.

### 5.4 Adding New Providers (Developer Workflow)

**For providers already in Nango (180+ OAuth2 providers):**

1. Run `pnpm connectors:import-providers` — the provider is already there
2. Create a connector implementation in `packages/connectors/` (if full connector support is needed)
3. Add any manual overrides (revocation URL, setup guide) to a provider overrides file

**For providers NOT in Nango:**

1. Add a manual entry to `packages/connectors/src/adapters/manual/providers.json`:
   ```json
   {
     "name": "custom-provider",
     "authMode": "oauth2",
     "authorizationUrl": "https://provider.com/oauth/authorize",
     "tokenUrl": "https://provider.com/oauth/token",
     "defaultScopes": ["read", "write"],
     "pkce": true,
     "docsUrl": "https://provider.com/docs/oauth"
   }
   ```
2. The catalog generation script merges manual entries with Nango imports
3. Manual entries take precedence over Nango data (for overrides)

**For custom enterprise providers (per-tenant):**

- Users create an `oauth2_app` Auth Profile directly in the UI, entering all OAuth URLs manually
- No catalog entry needed — the Auth Profile stores all metadata

### 5.5 Automated Validation of OAuth URLs/Endpoints

**Build-time validation** (in `generate-connector-catalog.ts` or a dedicated check):

```typescript
// For each OAuth2 provider in the catalog:
// 1. authorization_url must be HTTPS
// 2. token_url must be HTTPS
// 3. URLs must be well-formed (new URL() does not throw)
// 4. Known providers must match expected domains
//    (e.g., Google authorization_url must contain accounts.google.com)
```

**Runtime validation** (in `AuthProfileService.validate()`):

- When creating/updating an `oauth2_app`, validate URLs are reachable (optional, behind a flag)
- When a token refresh fails with a URL error, mark the Auth Profile status as `invalid`

---

## 6. Migration Guide for Existing Users

### 6.1 What Happens to Existing Connections

Per the Auth Profile design (Section 11), this is a **full replacement**. Three models are deleted; eight models are simplified.

| Current Entity                                 | Migration Target                                                   | Automatic?                  |
| ---------------------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| `LLMCredential`                                | `AuthProfile { authType: 'api_key' }`                              | Yes (data migration script) |
| `EndUserOAuthToken`                            | `AuthProfile { authType: 'oauth2_token', visibility: 'personal' }` | Yes                         |
| `ToolSecret`                                   | `AuthProfile { authType: 'api_key' \| 'bearer' }`                  | Yes                         |
| `ConnectorConnection.encryptedCredentials`     | `ConnectorConnection.authProfileId` → new `AuthProfile`            | Yes                         |
| `ChannelConnection.encryptedCredentials`       | `ChannelConnection.authProfileId` → new `AuthProfile`              | Yes                         |
| `TenantModel.connections[].credentialId`       | `TenantModel.connections[].authProfileId`                          | Yes                         |
| Env var OAuth credentials (`OAUTH_PROVIDER_*`) | `AuthProfile { authType: 'oauth2_app' }` seed data                 | Manual or seed script       |
| Channel OAuth env vars (`CHANNEL_OAUTH_*`)     | `AuthProfile { authType: 'oauth2_app' }` seed data                 | Manual or seed script       |

### 6.2 Data Migration Strategy

**Phase 1: Schema addition (non-breaking)**

1. Add `AuthProfile` collection and `authProfileId` field to all consumer models
2. Deploy with both old and new fields present
3. Old code paths continue working — no behavior change

**Phase 2: Data migration script**

```
pnpm migration:auth-profiles
```

The migration script:

1. **LLMCredentials → AuthProfile**: For each `LLMCredential`, create an `AuthProfile` with:
   - `authType`: `'api_key'` (or `'azure_ad'`/`'aws_iam'` based on `provider`)
   - `encryptedSecrets`: Re-encrypt `encryptedApiKey` into the new format
   - `tenantId`, `createdBy`: Copy from source
   - `scope`: `'tenant'` for `credentialScope: 'tenant'`, else `'project'`
   - `visibility`: `'shared'` for tenant-scope, `'personal'` for user-scope
   - `category`: `'llm'`

2. **EndUserOAuthToken → AuthProfile**: For each token:
   - `authType`: `'oauth2_token'`
   - `visibility`: `'personal'`
   - `encryptedSecrets`: Re-encrypt access/refresh tokens
   - `linkedAppProfileId`: Create corresponding `oauth2_app` profile from env vars (or find existing)

3. **ToolSecret → AuthProfile**: For each tool secret:
   - `authType`: Infer from usage (`api_key`, `bearer`, `basic`)
   - `category`: `'tool'`

4. **Consumer model updates**: For each migrated credential, update the consumer model to set `authProfileId` and clear the old field

5. **Idempotency**: Track migration state in a `_migrations` collection. Re-running the script skips already-migrated records.

**Phase 3: Code migration (breaking)**

1. Update all credential resolution paths to use `AuthProfileService.resolve()`
2. Remove old `tool-oauth-service.ts`, `channel-oauth-service.ts` refresh logic
3. Remove env var-based OAuth credential loading
4. Remove old model fields

**Phase 4: Cleanup**

1. Drop `LLMCredential`, `EndUserOAuthToken`, `ToolSecret` collections
2. Remove old fields from consumer models
3. Remove `OAUTH_PROVIDER_*` and `CHANNEL_OAUTH_*` env var documentation

### 6.3 Backwards Compatibility During Transition

During the Phase 1-2 transition window (recommended: 2-4 weeks):

- **Read path**: Check `authProfileId` first; fall back to old inline credentials if not set
- **Write path**: New connections always create Auth Profiles; old connections are updated via migration
- **API compatibility**: Old credential API endpoints continue working but are marked deprecated
- **Env vars**: Continue reading `OAUTH_PROVIDER_*` vars as a fallback during transition. Log deprecation warnings when they are used.

### 6.4 User-Facing Communication

**Before launch:**

- In-app banner (Studio): "We're upgrading authentication management. Your existing connections will be automatically migrated."
- Changelog/release notes: Document the Auth Profile feature and what changes for users

**During migration:**

- Migration progress indicator in Studio Settings (if migration runs in background)
- Any failed migrations surfaced as "Action required" items in Settings > Auth Profiles
- Email notification for admin users if manual intervention is needed

**After migration:**

- Old Settings > LLM Providers redirects to Settings > Auth Profiles (filtered by `category: 'llm'`)
- Old connection setup flows replaced by Auth Profile-aware flows
- Documentation updated: remove references to `OAUTH_PROVIDER_*` env vars, link to Auth Profile setup

### 6.5 Rollback Plan

If critical issues are found post-migration:

1. Auth Profile code behind feature flag: `FEATURE_AUTH_PROFILES=true`
2. Old credential data is NOT deleted during Phase 2 — only new `authProfileId` references are added
3. Disabling the flag reverts to old resolution paths
4. Collection drop (Phase 4) only happens after the feature flag has been enabled in production for 30+ days with no rollback

---

## Appendix A: File Reference

| File                                                              | Description                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| `apps/studio/.env.example`                                        | Studio env vars including OAuth provider credentials  |
| `apps/runtime/.env.example`                                       | Runtime env vars including LLM keys, channel OAuth    |
| `.env.example`                                                    | Root env vars (encryption key)                        |
| `packages/connectors/src/catalog/extract-entry.ts`                | `CatalogEntry` type + `enrichWithOAuth()`             |
| `packages/connectors/src/generated/connector-catalog.json`        | Static connector catalog (build-time generated)       |
| `packages/connectors/src/adapters/nango/provider-mapper.ts`       | `NangoProvider` → `ProviderConfig` mapping            |
| `packages/connectors/src/adapters/nango/importer.ts`              | Nango import orchestration + YAML URL                 |
| `scripts/import-nango-providers.ts`                               | CLI: fetch, parse, write provider JSON                |
| `packages/connectors/src/auth/provider-config-registry.ts`        | Runtime provider config lookup (600+ providers)       |
| `packages/connectors/src/adapters/nango/generated/providers.json` | Generated provider data (**currently empty**)         |
| `apps/studio/src/repos/credential-repo.ts`                        | `LLMCredential` + `TenantModel` data access           |
| `apps/runtime/src/services/tool-oauth-service.ts`                 | End-user tool OAuth flow (to be replaced)             |
| `apps/runtime/src/services/channel-oauth/`                        | Channel OAuth providers (Slack, Meta, Teams)          |
| `apps/runtime/src/channels/connection-resolver.ts`                | Channel connection resolution + credential decryption |
| `packages/database/src/models/connector-config.model.ts`          | Enterprise connector config (SearchAI)                |
| `docs/plans/2026-03-11-auth-profile-design.md`                    | Auth Profile design document                          |
| `docs/plans/2026-03-10-connector-catalog-redesign.md`             | Connector catalog redesign plan                       |

## Appendix B: Critical First Actions

1. **Run `pnpm connectors:import-providers`** — the generated providers.json is empty. This is the single biggest gap blocking Auth Profile's OAuth metadata.

2. **Extend `CatalogEntry.oauth2`** with `pkceMethod`, `authorizationParams`, `tokenParams`, `docsUrl`, `revocationUrl`, `setupGuideUrl` fields.

3. **Author setup guides** for the top 6 providers (Google, Microsoft, Slack, GitHub, Salesforce, HubSpot) as static markdown in `packages/connectors/src/guides/`.

4. **Set up weekly Nango sync CI job** to keep provider metadata current.

5. **Write the migration script** (`scripts/migrate-to-auth-profiles.ts`) with idempotent, per-record migration and rollback support.
