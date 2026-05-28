# Design Document: Integration Auth Profiles

**Date**: 2026-04-01
**Author**: Pattabhi Dasari
**Status**: Draft — Pending Review
**Location**: `docs/plans/2026-04-01-integration-auth-profiles-design.md`

---

## 1. Problem Statement

Our platform supports 26 ActivePieces integrations (Gmail, Google Calendar, Slack, GitHub, etc.), each requiring authentication to execute actions and triggers. Today, two separate systems manage credentials:

- **Auth Profiles** (`auth_profiles` collection) — a rich, unified credential store with 17 auth types, encryption at rest, key rotation, JIT auth, and multi-scope support.
- **Connector Connections** (`connector_connections` collection) — a simpler, connector-specific credential store that can optionally delegate to auth profiles.

This dual system creates confusion about where credentials live, duplicates auth logic, and makes it hard to manage integration credentials alongside custom API credentials in one place.

**Goal**: Extend the existing auth profile system to natively support predefined integration auth — using Nango's 600+ provider configs for pre-filling OAuth metadata — without creating any new backend systems.

---

## 2. Current Architecture

### 2.1 Auth Profile Collection (`auth_profiles`)

The central credential store. Key characteristics:

| Field                | Purpose                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `authType`           | One of 17 types: `api_key`, `bearer`, `oauth2_app`, `oauth2_token`, `oauth2_client_credentials`, plus Phase 2/3 types |
| `scope`              | `tenant` (workspace-wide) or `project` (single project)                                                               |
| `visibility`         | `shared` (anyone in scope) or `personal` (creator only)                                                               |
| `connector`          | **Already exists** — optional string field for linking to a connector name                                            |
| `encryptedSecrets`   | AES-256-GCM encrypted credentials                                                                                     |
| `linkedAppProfileId` | Links `oauth2_token` profiles to their parent `oauth2_app`                                                            |

**OAuth two-layer design**:

- **Layer 1 (`oauth2_app`)**: Stores app registration — clientId, clientSecret, authorization/token URLs, PKCE config.
- **Layer 2 (`oauth2_token`)**: Stores user tokens (accessToken, refreshToken) after consent. Links back to Layer 1 via `linkedAppProfileId`.

**Token lifecycle**:

- `oauth2_client_credentials`: Access tokens are **Redis-cached** with automatic re-acquisition on expiry. No refresh token.
- `oauth2_token`: Proactive refresh via `shared-auth-profile/token-refresh-service.ts` with distributed Redis locks to prevent concurrent refresh across pods.
- Runtime tokens: `end_user_oauth_tokens` (durable per-user) and `session_oauth_artifacts` (ephemeral per-session with TTL auto-cleanup).

### 2.2 Nango Provider Registry

Nango's open-source providers.yaml (600+ OAuth2 providers) is fetched at **build time** and mapped to a `ProviderConfig` format:

```typescript
interface ProviderConfig {
  name: string;                          // e.g., 'gmail'
  authMode: 'oauth2' | 'oauth1' | ...;
  authorizationUrl?: string;             // e.g., 'https://accounts.google.com/o/oauth2/auth'
  tokenUrl?: string;                     // e.g., 'https://oauth2.googleapis.com/token'
  refreshUrl?: string;                   // Falls back to tokenUrl if not set
  defaultScopes: string[];               // e.g., ['gmail.send', 'gmail.readonly']
  pkce: boolean;
  scopeSeparator: string;
}
```

Accessed at runtime via `ProviderConfigRegistry.getProviderConfig(name)`. Nango is **not** a runtime dependency — it's a static reference data source only.

### 2.3 Connector Catalog

**Source**: `packages/connectors/src/generated/connector-catalog.json` (generated via `pnpm connectors:generate-catalog`)

26 ActivePieces connectors with metadata (actions, triggers, auth type), organized by category:

| Category          | Connector       | Catalog Auth Type | Nango Provider            | Nango Auth Mode | Resolved Auth | Runtime connectionConfig | Notes                                                             |
| ----------------- | --------------- | ----------------- | ------------------------- | --------------- | ------------- | ------------------------ | ----------------------------------------------------------------- |
| **ai_dev**        | claude          | `api_key`         | `anthropic`               | `api_key`       | `api_key`     | —                        | Key via `x-api-key` header, no prefix                             |
|                   | github          | `oauth2`          | `github`                  | `oauth2`        | `oauth2`      | —                        | Static URLs, no templates                                         |
|                   | openai          | `api_key`         | `openai`                  | `api_key`       | `api_key`     | —                        |                                                                   |
| **communication** | discord         | `api_key`         | `discord`                 | `oauth2`        | `oauth2`      | —                        | Nango resolves to OAuth2                                          |
|                   | gmail           | `oauth2`          | `gmail`                   | `oauth2`        | `oauth2`      | —                        |                                                                   |
|                   | microsoft-teams | `oauth2`          | `microsoft-teams`         | `oauth2`        | `oauth2`      | —                        |                                                                   |
|                   | sendgrid        | `api_key`         | `sendgrid`                | `api_key`       | `api_key`     | —                        | Key via `Bearer ${apiKey}` header                                 |
|                   | slack           | `oauth2`          | `slack`                   | `oauth2`        | `oauth2`      | —                        |                                                                   |
|                   | twilio          | `none`            | `twilio`                  | `oauth2`        | `oauth2`      | —                        | Nango resolves to OAuth2                                          |
| **crm**           | hubspot         | `oauth2`          | `hubspot`                 | `oauth2`        | `oauth2`      | —                        |                                                                   |
|                   | pipedrive       | `oauth2`          | `pipedrive`               | `oauth2`        | `oauth2`      | —                        | `api_domain` is proxy-only (automated), not shown                 |
|                   | salesforce      | `oauth2`          | `salesforce`              | `oauth2`        | `oauth2`      | —                        | Static OAuth URLs (no template in auth/token URLs)                |
|                   | shopify         | `custom`          | `shopify`                 | `oauth2`        | `oauth2`      | `subdomain` ✅           | URL template in authorizationUrl + tokenUrl                       |
|                   | stripe          | `api_key`         | `stripe`                  | `oauth2`        | `oauth2`      | —                        | Nango resolves to OAuth2                                          |
| **productivity**  | asana           | `oauth2`          | `asana`                   | `oauth2`        | `oauth2`      | —                        |                                                                   |
|                   | clickup         | `oauth2`          | `clickup`                 | `oauth2`        | `oauth2`      | —                        |                                                                   |
|                   | google-calendar | `oauth2`          | `google-calendar`         | `oauth2`        | `oauth2`      | —                        |                                                                   |
|                   | jira-cloud      | `custom`          | `jira` ✅ (via alias map) | `oauth2`        | `oauth2`      | —                        | Static Atlassian cloud URLs; `subdomain` unused in any URL        |
|                   | linear          | `api_key`         | `linear`                  | `oauth2`        | `oauth2`      | —                        | Nango resolves to OAuth2; scope separator is `,`                  |
|                   | notion          | `oauth2`          | `notion`                  | `oauth2`        | `oauth2`      | —                        |                                                                   |
| **storage**       | airtable        | `api_key`         | `airtable`                | `oauth2`        | `oauth2`      | —                        | Nango resolves to OAuth2; also `airtable-pat` (api_key) available |
|                   | amazon-s3       | `custom`          | —                         | —               | —             | —                        | No Nango entry — unsupported (AWS SigV4)                          |
|                   | google-drive    | `oauth2`          | `google-drive`            | `oauth2`        | `oauth2`      | —                        |                                                                   |
|                   | google-sheets   | `none`            | `google-sheets`           | `oauth2`        | `oauth2`      | —                        | Nango resolves to OAuth2                                          |
|                   | postgres        | `custom`          | —                         | —               | —             | —                        | No Nango entry — unsupported (TCP wire protocol)                  |

> **Removed from catalog**: `http` connector (`authType: 'none'`, no Nango entry, no auth capability). Not shown in the Integrations tab at all — it has no authentication to manage.

**Auth type summary (after Nango resolution)**:

- `oauth2` — 21 connectors: 12 native + 9 resolved via Nango (shopify, jira-cloud, twilio, google-sheets, discord, stripe, linear, airtable, claude†)
- `api_key` — 2 connectors with no Nango match (openai, sendgrid — both have Nango entries but catalog already has correct type)
- Unsupported (no Nango entry) — 2 connectors (amazon-s3, postgres)

> † claude/anthropic has Nango `api_key` mode — it stays as `api_key` since Nango confirms it.

**Corrected auth type resolution** (verified against `providers.json`):

| Connector  | Old Assumption            | Actual Nango Auth Mode                            | Correction                       |
| ---------- | ------------------------- | ------------------------------------------------- | -------------------------------- |
| discord    | `api_key` (no Nango)      | `oauth2`                                          | Resolves to OAuth2               |
| stripe     | `api_key` (no Nango)      | `oauth2` (`stripe`), `basic` (`stripe-api-key`)   | Resolves to OAuth2               |
| linear     | `api_key` (no Nango)      | `oauth2`                                          | Resolves to OAuth2               |
| airtable   | `api_key` (no Nango)      | `oauth2` (`airtable`), `api_key` (`airtable-pat`) | Resolves to OAuth2 (primary)     |
| salesforce | URL template `{instance}` | Static OAuth URLs                                 | No connectionConfig in auth URLs |

> **Jira alias resolution:** The connector catalog name is `jira-cloud` but the Nango provider name is `jira`. A manual `NANGO_ALIAS_MAP` (`{ 'jira-cloud': 'jira' }`) has been added to `enrichWithOAuth()` in `packages/connectors/src/catalog/extract-entry.ts`. The Jira `subdomain` field in Nango connectionConfig is **not used** in authorizationUrl, tokenUrl, or proxyBaseUrl — it is an optional metadata field with no URL interpolation. It is therefore **excluded** from the connection config form.

> **Shopify URL template:** Shopify's Nango OAuth URLs use `${connectionConfig.subdomain}` placeholders in both `authorizationUrl` and `tokenUrl`. This makes Shopify the only connector in our catalog that requires runtime connection config for the OAuth flow.

> **Note**: A separate `AGENT_DESKTOP_PROVIDERS` registry exists in `apps/studio/src/components/connections/agent-desktop-registry.ts` with 6 agent desktop integrations (smartassist, genesys, salesforce, servicenow, five9, generic). These are NOT ActivePieces connectors and are managed through the Connections page, not the Integrations tab.

> **Custom auth connectors in Integrations tab:** Of the 4 connectors with catalog `authType: 'custom'`, 2 have Nango entries (jira-cloud, shopify) and resolve to OAuth2. The remaining 2 (amazon-s3, postgres) have no Nango entry and appear in the catalog grid with an "Unsupported — use Connector Connections" badge and no "Create New Profile" button.

### 2.4 Existing UI Structure

| Page                            | Scope                    | Location                                   |
| ------------------------------- | ------------------------ | ------------------------------------------ |
| `AuthProfilesPage.tsx`          | Project-level            | `/projects/:id/settings/auth-profiles`     |
| `WorkspaceAuthProfilesPage.tsx` | Tenant-level (workspace) | `/workspace/auth-profiles` (Admin sidebar) |

Project page shows inherited tenant profiles as read-only with "Manage in Workspace" link.

---

## 3. Proposed Design — Option B: Tabs with Inline Expand

### 3.1 Approach Summary

Add two tabs ("All Profiles" / "Integrations") to **both** the project-level and workspace-level auth profile pages. The Integrations tab shows a browsable catalog grid of connectors. Clicking a connector expands it inline to show available auth types, existing profiles, and a "Create New Profile" button. Creation opens the existing slide-over form with Nango-prefilled OAuth fields.

**Key principle**: All integration auth profiles are regular `auth_profiles` documents with the `connector` field populated. A bridge `ConnectorConnection` is auto-created to keep connector execution working without modifying the existing resolution pipeline (see §6.6).

### 3.2 Usage Modes (Already Implemented)

Each integration auth profile uses the existing `usageMode` field to determine when and how credentials are obtained. This field is **already implemented** in the model, Zod schemas, and UI — no new backend work needed.

| Mode                | When Credentials Are Obtained                                                                                      | Use Case                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **`preconfigured`** | Admin provides credentials/consent at **design time**. Tokens stored immediately.                                  | Process automation, M2M workflows where no end-user is present at runtime. |
| **`jit`**           | Only app config stored at design time. End user provides consent at **runtime** via JIT auth (`BatchConsentGate`). | HR portal, IT helpdesk — each user sees their own data.                    |
| **`preflight`**     | Similar to JIT but consent obtained before execution starts.                                                       | Flows requiring upfront authorization before any step runs.                |
| **`user_token`**    | Per-user token (auto-set for `oauth2_token` profiles).                                                             | Linked OAuth2 token profiles — set automatically, not user-selectable.     |

> **Already implemented.** The `usageMode` field exists in `IAuthProfile` (model), `CreateAuthProfileSchema` / `UpdateAuthProfileSchema` (Zod), and the `AuthProfileSlideOver` UI. The legal mode matrix (`AUTH_TYPE_USAGE_MODE_MAP` in `packages/shared/src/validation/auth-profile.schema.ts`) enforces which modes are allowed per auth type. No new persistence, validation, or runtime wiring is needed.

**Auth type eligibility by mode** (from existing `AUTH_TYPE_USAGE_MODE_MAP`):

| Auth Type                   | `preconfigured` | `jit` | `preflight` | `user_token` |
| --------------------------- | :-------------: | :---: | :---------: | :----------: |
| `api_key`                   |       Yes       |  No   |     No      |      No      |
| `oauth2_client_credentials` |       Yes       |  No   |     No      |      No      |
| `bearer`                    |       Yes       |  Yes  |     Yes     |      No      |
| `oauth2_app`                |       Yes       |  Yes  |     Yes     |      No      |
| `oauth2_token`              |       No        |  No   |     No      |  Yes (auto)  |

> **Constraint — end-user consent requires project-scoped OAuth apps.** The `jit` and `preflight` modes are only available for **project-scoped** `oauth2_app` profiles. Workspace (tenant-scoped) OAuth apps cannot complete end-user consent because the callback route validates `requiredScope: 'project'` via `validateLinkedAppProfile`, which rejects tenant-scoped apps on both scope and projectId. Rather than redesigning the callback validation and token-ownership model, we constrain the UX: the `jit`/`preflight` options are disabled when creating workspace-level integration profiles, with a tooltip explaining that end-user consent requires a project-scoped app.

---

## 4. User Experience

### 4.1 Integrations Tab — Catalog Grid

Both project and workspace pages show the same catalog grid. Each card displays the connector name, supported auth type(s), and existing profile count.

```
Auth Profiles > [All Profiles]  [Integrations]
─────────────────────────────────────────────────
Search: [_________________________] [Category ▾]

┌──────────┐ ┌──────────┐ ┌──────────┐
│   Gmail   │ │  G.Cal   │ │  G.Drive │
│  oauth2   │ │  oauth2  │ │  oauth2  │
│ 2 profiles│ │    —     │ │ 1 profile│
└──────────┘ └──────────┘ └──────────┘
┌──────────┐ ┌──────────┐ ┌──────────┐
│   Slack   │ │   Jira   │ │  Stripe  │
│  oauth2   │ │  oauth2  │ │  oauth2  │
│     —     │ │    —     │ │    —     │
└──────────┘ └──────────┘ └──────────┘
```

> 25 connectors shown (http removed — no auth). Amazon S3 and Postgres shown with "Unsupported" badge.

### 4.2 Inline Card Expand

Clicking a connector card expands it to show **all** profiles for that integration — both `oauth2_app` and `oauth2_token` documents, with display rules based on usage mode:

**Display rules for linked OAuth app/token pairs:**

- **Preconfigured** (`usageMode: 'preconfigured'`): Show the `oauth2_token` profile only (with status badge: active/expired/revoked). The parent `oauth2_app` is hidden — it is an implementation detail. If no `oauth2_token` exists yet (authorization not completed), show the `oauth2_app` with a "Pending Authorization" badge.
- **JIT / Preflight** (`usageMode: 'jit'` or `'preflight'`): Show the `oauth2_app` profile only. Do **not** show `oauth2_token` profiles — end-user tokens are per-session runtime artifacts, not admin-managed credentials.
- **Non-OAuth profiles** (`api_key`, `bearer`): Show as-is, one row per profile.

**Operations on displayed profiles:**

- **Edit**: Opens the `oauth2_app` for preconfigured profiles (even though the token row is displayed). For JIT/preflight profiles, edits the `oauth2_app` directly.
- **Re-authorize**: Available on preconfigured OAuth. Opens consent popup, replaces the existing `oauth2_token`.
- **Delete**: Deletes the `oauth2_app` and cascades to linked `oauth2_token`(s).
- **Profile count**: Counts logical profiles (one per `oauth2_app` for OAuth, one per profile for non-OAuth), not raw documents.

```
┌─────────────────────────────────────────────────┐
│   Gmail                                    [▲]  │
│─────────────────────────────────────────────────│
│ Auth Types: OAuth 2.0 | API Key                  │
│                                                  │
│ Existing Profiles:                               │
│  ✅ Gmail-Shared   oauth2  preconfig  Workspace  │  ← shows oauth2_token status
│  ✅ Gmail-Sales    oauth2  preconfig  Project    │  ← shows oauth2_token status
│  🔑 Gmail-Support  oauth2  jit        Project    │  ← shows oauth2_app only
│                                                  │
│           [+ Create New Profile]                 │
└─────────────────────────────────────────────────┘
```

At **project level**, tenant-scoped (workspace) profiles appear read-only with a "Manage in Workspace" indicator. At **workspace level**, only tenant-scoped profiles are shown.

### 4.3 Create Flow — Slide-Over

Clicking "Create New Profile" opens the existing `AuthProfileSlideOver` with integration-specific behavior. The form fields are sourced from multiple places:

#### Example 1: Gmail (simple OAuth — no connection config needed)

```
══ CREATE: Gmail Auth Profile ════════════════════

  ── Auth Type ────────────────────────────────────
  [OAuth 2.0 App ▾]        (only types from Nango)

  ── Usage Mode ────────────────────────────────────
  [Preconfigured ▾]
    Options: Preconfigured | JIT | Preflight
    (filtered by AUTH_TYPE_USAGE_MODE_MAP)

  ── Details ──────────────────────────────────────
  Name:        [Gmail - Marketing______________]
  Description: [Campaign automation_____________]
  Environment: [All ▾]

  ── OAuth Settings (pre-filled from Nango) ───────
  Auth URL:  [accounts.google.com/o/oauth2/auth ]  ← from Nango
  Token URL: [oauth2.googleapis.com/token       ]  ← from Nango
  Scopes:    [gmail.send] [gmail.readonly]     [+]  ← from Nango

  ── Your Credentials ─────────────────────────────
  Client ID:     [_____________________________]  ← user input
  Client Secret: [•••••••••••••••••••••••••••••]  ← user input

               [Cancel]    [Save & Authorize →]
```

#### Example 2: Shopify (OAuth with connection config — URL has `${connectionConfig.*}` templates)

Shopify is the only connector in our catalog whose OAuth URLs contain runtime `${connectionConfig.*}` placeholders. The user must provide their shop subdomain before the OAuth flow can begin:

```
══ CREATE: Shopify Auth Profile ═════════════════

  ── Auth Type ────────────────────────────────────
  [OAuth 2.0 App]

  ── Usage Mode ────────────────────────────────────
  [Preconfigured ▾]
    Options: Preconfigured | JIT | Preflight

  ── Details ──────────────────────────────────────
  Name:        [Shopify - Main Store_______]
  Environment: [Production ▾]

  ── Connection Config (required for OAuth URLs) ──
  Subdomain:   [my-store__________________]  ← user input
    ℹ Your Shopify store name (e.g., "my-store" from my-store.myshopify.com)

  ── OAuth Settings (resolved from Nango + connection config) ──
  Auth URL:  [https://my-store.myshopify.com/admin/oauth/authorize  ]
  Token URL: [https://my-store.myshopify.com/admin/oauth/access_token]
  Scopes:    [_______________________________] [+]  ← from Nango (empty default)

  ── Your Credentials ─────────────────────────────
  Client ID:     [_____________________________]  ← user input
  Client Secret: [•••••••••••••••••••••••••••••]  ← user input

               [Cancel]    [Save & Authorize →]
```

#### Example 3: Stripe (OAuth — resolved from Nango)

Stripe's Nango provider is `oauth2` (not API key). The UI shows a standard OAuth form with static URLs:

```
══ CREATE: Stripe Auth Profile ═══════════════════

  ── Auth Type ────────────────────────────────────
  [OAuth 2.0 App]

  ── Usage Mode ────────────────────────────────────
  [Preconfigured ▾]

  ── Details ──────────────────────────────────────
  Name:        [Stripe Production__________]
  Environment: [Production ▾]

  ── OAuth Settings (pre-filled from Nango) ───────
  Auth URL:  [connect.stripe.com/oauth/authorize]  ← from Nango
  Token URL: [connect.stripe.com/oauth/token    ]  ← from Nango
  Scopes:    [read_write]                      [+]  ← from Nango

  ── Your Credentials ─────────────────────────────
  Client ID:     [_____________________________]  ← user input
  Client Secret: [•••••••••••••••••••••••••••••]  ← user input

               [Cancel]    [Save & Authorize →]
```

#### Example 4: Anthropic (API Key — no prefix, no OAuth)

Anthropic has no Nango OAuth entry. The API key is passed via the `x-api-key` header with no prefix:

```
══ CREATE: Anthropic Auth Profile ════════════════

  ── Auth Type ────────────────────────────────────
  [API Key]

  ── Usage Mode ────────────────────────────────────
  [Preconfigured ▾]  (only valid option for api_key)

  ── Details ──────────────────────────────────────
  Name:        [Claude API________________]
  Environment: [All ▾]

  ── Credentials ──────────────────────────────────
  API Key:     [sk-ant-•••••••••••••••••••]  ← user input

               [Cancel]    [Save →]
```

#### Field Source Matrix

> **Schema extension required:** The current `OAuth2AppConfigSchema` is `.strict()` and does not include `authorizationParams`, `tokenParams`, or `connectionConfig`. These fields must be added to the schema, and the corresponding route handlers (`initiate`, `user-consent`, `callback`) must be updated to consume them. Note: the `oauth2_app` UI metadata already uses `defaultScopes` (line 198) — no naming fix is needed for that auth type.

| Field Category                                          | Source                                     | When Shown                  | Stored In                    | Schema Status                                                     |
| ------------------------------------------------------- | ------------------------------------------ | --------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| **OAuth URLs** (authorizationUrl, tokenUrl, refreshUrl) | Nango `ProviderConfig`                     | OAuth connectors            | `config`                     | ✅ Exists                                                         |
| **Default Scopes**                                      | Nango `ProviderConfig.defaultScopes`       | OAuth connectors            | `config.defaultScopes`       | ✅ Exists (`oauth2_app` UI metadata already uses `defaultScopes`) |
| **Authorization Params** (access_type, prompt, etc.)    | Nango `ProviderConfig.authorizationParams` | Auto-applied when present   | `config.authorizationParams` | ⚠️ **New — add to schema**                                        |
| **Token Params**                                        | Nango `ProviderConfig.tokenParams`         | Auto-applied when present   | `config.tokenParams`         | ⚠️ **New — add to schema**                                        |
| **PKCE**                                                | Nango `ProviderConfig.pkce`                | Auto-applied, not shown     | `config.pkceRequired`        | ✅ Exists                                                         |
| **Connection Config** (subdomain, instance)             | Nango URL `{placeholders}`                 | When URL has templates      | `config.connectionConfig`    | ⚠️ **New — add to schema**                                        |
| **Client ID / Client Secret**                           | User input                                 | OAuth connectors            | `encryptedSecrets`           | ✅ Exists                                                         |
| **API Key / Bearer Token**                              | User input                                 | API key / bearer connectors | `encryptedSecrets`           | ✅ Exists                                                         |

#### UX Rules for Integration Forms

**Rule 1 — Only show runtime connectionConfig.** Only show connectionConfig fields that appear in `authorizationUrl` or `tokenUrl` (needed at OAuth flow time). Fields that only appear in `proxyBaseUrl` or `proxyHeaders` (used by Nango's proxy, which we don't use) are **excluded** from the form. Example: Pipedrive's `api_domain` (proxy-only) is not shown; Shopify's `subdomain` (in auth URLs) is shown.

**Rule 2 — No prefix field when provider has none.** The "Header Name" / "Prefix" field is only shown when the Nango provider explicitly defines one. Anthropic uses `x-api-key` with no prefix — the form shows only the API key input. SendGrid uses `Bearer` prefix — the form shows the prefix field pre-filled.

**Rule 3 — No "Resolved URL Preview" for static URLs.** The resolved URL preview section is only shown when the provider's `authorizationUrl` or `tokenUrl` contains `${connectionConfig.*}` templates. For providers with static URLs (Gmail, GitHub, Salesforce, Jira, etc.), the OAuth Settings section shows the URLs directly — no separate preview.

**Rule 4 — Help text from Nango connectionConfig metadata.** When a connectionConfig field is shown, use the Nango `description` as help text below the input and `placeholder` / `example` as the input placeholder. Example for Shopify subdomain: help text = _"Your Shopify store name"_, placeholder = _"my-store"_.

**Rule 5 — Help text for credential fields.** When Nango provides `credentials` metadata (e.g., `airtable-pat` has `title: "Personal Access Token"`, `description`, `example`, `pattern`), use these to enhance the credential input: `title` as label, `description` as help text, `example` as placeholder, `pattern` for client-side validation.

#### URL Template Resolution

When a Nango provider URL contains `${connectionConfig.*}` placeholders (e.g., `https://${connectionConfig.subdomain}.myshopify.com/admin/oauth/authorize`):

1. **At form load**: Parse URL for `${connectionConfig.*}` patterns → generate input fields in "Connection Config" section (only for fields used in auth/token URLs, per Rule 1)
2. **On user input**: Replace placeholders in real-time → show resolved URLs inline in the OAuth Settings fields (not a separate preview section, per Rule 3)
3. **On save**: Store both the template variables (`config.connectionConfig`) and the resolved URLs (`config.authorizationUrl`, `config.tokenUrl`)
4. **At runtime**: Token refresh uses the resolved URLs stored in `config`

**Nango pre-fill**: All OAuth URLs and default scopes are automatically populated from `ProviderConfigRegistry.getProviderConfig(name)`. Fields are shown as pre-filled but **overridable** by the user.

**After save**:

- **Preconfigured OAuth** (`usageMode: 'preconfigured'`): Consent popup opens immediately (existing `AuthProfileOAuthDialog`). On completion, an `oauth2_token` profile is created and linked.
- **JIT / Preflight OAuth** (`usageMode: 'jit'` or `'preflight'`): No popup. Profile saved as `oauth2_app` only. End users authorize at runtime via JIT auth (`BatchConsentGate`).
- **API Key / Bearer**: Simple save, no consent needed.

### 4.4 All Profiles Tab — Unified List

The first tab shows ALL profiles (custom + integration) with connector badge and scope columns. The same OAuth app/token aggregation rules from the Integrations tab apply here:

- **Preconfigured OAuth** (`usageMode: 'preconfigured'`): Show the `oauth2_token` row with status badge. Hide the parent `oauth2_app`. If no token exists, show `oauth2_app` with "Pending Authorization".
- **JIT / Preflight OAuth** (`usageMode: 'jit'` or `'preflight'`): Show the `oauth2_app` row only. Hide `oauth2_token` profiles.
- **Non-OAuth and custom profiles**: Show as-is.

```
Auth Profiles > [All Profiles]  [Integrations]
─────────────────────────────────────────────────
[+ Add Profile ▾]
  ├─ Custom Profile
  └─ Integration Profile → (switches to Integrations tab)

| Name           | Type          | Connector  | Usage Mode    | Scope     | Status  |
|----------------|---------------|------------|---------------|-----------|---------|
| My CRM API     | api_key       | —          | —             | Project   | active  |
| Gmail-Shared   | oauth2_token  | Gmail      | preconfigured | Workspace | active  |
| Gmail-Sales    | oauth2_token  | Gmail      | preconfigured | Project   | expired |
| Webhook Token  | bearer        | —          | —             | Project   | active  |
| GDrive-Portal  | oauth2_app    | G.Drive    | jit           | Project   | active  |
| Stripe Prod    | oauth2_token  | Stripe     | preconfigured | Project   | active  |
```

Workspace-scoped profiles at project level are shown read-only with "Manage in Workspace" link (existing behavior).

---

## 5. Tenant vs Project Scope

Integration auth profiles follow the same scoping rules as custom auth profiles:

| Scope                  | Created From                       | `projectId` | Accessibility              |
| ---------------------- | ---------------------------------- | ----------- | -------------------------- |
| **Tenant** (Workspace) | Admin → Auth Profiles              | `null`      | All projects in the tenant |
| **Project**            | Project → Settings → Auth Profiles | `projectId` | Only that project          |

**Inheritance behavior** (existing, no changes needed):

- Project pages show tenant profiles as read-only, inherited rows
- Tenant profiles can be used by any project's tools and agents
- Expanded integration cards at project level show combined count (project + inherited tenant profiles)
- Workspace Integrations tab shows only tenant profile counts

**Use case examples**:

- **Workspace Gmail profile (preconfigured)**: Company-wide Gmail automation account — all projects can use it.
- **Project Gmail profile (preconfigured)**: Sales team's Gmail — only the Sales project can use it.
- **Project Gmail profile (JIT)**: HR portal where each user authorizes their own Gmail — project-scoped only (see §3.2 constraint).

---

## 6. Backend Changes

### 6.1 Usage Mode — Already Implemented ✅

The `usageMode` field is already fully implemented across the stack:

- **Model**: `packages/database/src/models/auth-profile.model.ts` — `usageMode` field with dynamic default per auth type
- **Zod schemas**: `packages/shared/src/validation/auth-profile.schema.ts` — `usageMode` in `CreateAuthProfileSchema` and `UpdateAuthProfileSchema`, with `AUTH_TYPE_USAGE_MODE_MAP` enforcing legal combinations
- **UI**: `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx` — usage mode dropdown with `AUTH_PROFILE_USAGE_MODE_OPTIONS` labels
- **Runtime**: Already wired through `resolve-tool-auth.ts`, `auth-scope-policy.ts`, and JIT auth middleware

**No new backend persistence or validation work is needed.** Integration auth profiles will use the same `usageMode` values as custom profiles.

### 6.2 ~~Zod Schema Update~~ — Already Done ✅

See §6.1 — `usageMode` is already in both create and update Zod schemas with legal mode matrix validation.

### 6.3 New API Endpoints — Integration Providers

Two new endpoints (matching the existing project/workspace pattern):

| Endpoint                                         | Scope                                                     |
| ------------------------------------------------ | --------------------------------------------------------- |
| `GET /api/projects/:pid/auth-profiles/providers` | Project-scoped (includes inherited tenant profile counts) |
| `GET /api/auth-profiles/providers`               | Workspace-scoped (tenant profiles only)                   |

**Response**:

```json
[
  {
    "connectorName": "gmail",
    "displayName": "Gmail",
    "description": "Email service by Google",
    "category": "communication",
    "availableAuthTypes": ["oauth2"],
    "oauth2": {
      "authorizationUrl": "https://accounts.google.com/o/oauth2/auth",
      "tokenUrl": "https://oauth2.googleapis.com/token",
      "refreshUrl": "https://oauth2.googleapis.com/token",
      "defaultScopes": ["gmail.send", "email", "gmail.readonly", "gmail.compose"],
      "pkce": false
    },
    "profileCount": 3,
    "profiles": [
      { "id": "...", "name": "Gmail-Shared", "scope": "tenant", "usageMode": "preconfigured" },
      { "id": "...", "name": "Gmail-Sales", "scope": "project", "usageMode": "preconfigured" },
      { "id": "...", "name": "Gmail-Support", "scope": "project", "usageMode": "jit" }
    ]
  }
]
```

**Data source**: Merges `connector-catalog.json` (actions, triggers, authType) with `ProviderConfigRegistry.getProviderConfig(name)` (OAuth URLs, scopes, PKCE).

**Visibility rules**: The `profiles` array and `profileCount` MUST apply the same visibility filtering as existing auth-profile list routes (`route.ts:53-61`). Non-admin users see only `shared` profiles and their own `personal` profiles. Hidden personal profiles are excluded from both the count and the array. This prevents leaking profile existence through aggregate counts.

### 6.4 Validation Rules — Mostly Already Enforced ✅

The existing `AUTH_TYPE_USAGE_MODE_MAP` already enforces which usage modes are legal per auth type. No new validation code needed for the mode matrix. One additional rule for integration profiles:

| Condition                                                          | Rule                                                         | Status                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------- |
| Any auth type + `usageMode`                                        | Legal combinations enforced by `AUTH_TYPE_USAGE_MODE_MAP`    | ✅ Already implemented                         |
| `connector` set + workspace scope + `usageMode: 'jit'/'preflight'` | Blocked — end-user consent requires project scope (see §3.2) | ⚠️ **New UI constraint** (disable in dropdown) |

### 6.5 Prerequisite: Populate Nango Providers

Run `pnpm connectors:import-providers` to populate `packages/connectors/src/adapters/nango/generated/providers.json` (currently empty).

### 6.6 Simplified ConnectorConnection Model (No Backward Compatibility)

> **Decision**: The product is in beta. No backward compatibility is required. The `ConnectorConnection` model is simplified to a **pure binding record** — all credential storage, encryption, and token refresh is handled exclusively by auth profiles.

#### Simplified IConnectorConnection Interface

```typescript
export interface IConnectorConnection {
  _id: string;
  tenantId: string;
  projectId: string;
  connectorName: string;
  displayName: string;
  scope: 'tenant' | 'user';
  userId?: string;
  authProfileId: string; // REQUIRED — always resolves via auth profile
  status: 'active' | 'expired' | 'revoked';
  createdAt: Date;
  updatedAt: Date;
}
```

**Removed fields** (credentials now live exclusively in auth profiles):

| Removed Field            | Reason                                                               |
| ------------------------ | -------------------------------------------------------------------- |
| `authType`               | Derived from the linked auth profile                                 |
| `encryptedCredentials`   | Auth profile handles encryption via `encryptionPlugin`               |
| `encryptionKeyVersion`   | No local encryption — auth profile manages this                      |
| `oauth2TokenExpiresAt`   | Token lifecycle managed by auth profile + `token-refresh-service.ts` |
| `oauth2RefreshToken`     | Stored in auth profile's `encryptedSecrets`                          |
| `oauth2ConnectionConfig` | Stored in auth profile's `config.connectionConfig`                   |
| `oauth2Provider`         | Derived from auth profile's `connector` field                        |
| `scopes`                 | Stored in auth profile's `config.defaultScopes`                      |

#### New Unique Index

```typescript
// Old: { tenantId, projectId, connectorName, scope, userId } — one connection per connector per scope
// New: { tenantId, projectId, connectorName, authProfileId } — one connection per auth profile per connector
ConnectorConnectionSchema.index(
  { tenantId: 1, projectId: 1, connectorName: 1, authProfileId: 1 },
  { unique: true },
);
```

This allows **multiple connections per connector** (e.g., Gmail-Marketing + Gmail-Support) while preventing the same auth profile from being used twice for the same connector in the same project.

#### Simplified ConnectionResolver

`ConnectionResolver.resolveAuth()` becomes a single path — always delegates to auth profile:

```typescript
async resolveAuth(connection: IConnectorConnection): Promise<Record<string, unknown>> {
  // authProfileId is always set — no fallback to inline credentials
  return this.authProfileResolver.resolve({
    authProfileId: connection.authProfileId,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
  });
}
```

**Removed code paths**:

- Inline `decrypt(encryptedCredentials)` fallback
- `refreshOAuth2()` with distributed locking and env-var client secrets (`OAUTH2_CLIENT_ID_<PROVIDER>`)
- Token expiry checking on the connection document
- All credential management logic in `ConnectionResolver`

Token refresh is handled by the auth profile system (`token-refresh-service.ts`) with its own distributed Redis locks, key rotation, and grace periods.

#### ConnectionResolver.resolve() — Auth Profile Cascading

`ConnectionResolver.resolve()` is updated to support multiple connections per connector:

```typescript
// Priority: specific connectionId → user-scoped → tenant-scoped
// When multiple user-scoped connections exist for the same connector,
// the caller must specify connectionId (e.g., from tool config)
```

### 6.7 ConnectorConnection Bridge (Auto-Create)

When an integration auth profile is created (i.e., `connector` field is set), auto-create a thin `ConnectorConnection` that binds to it:

```typescript
{
  connectorName: authProfile.connector,        // e.g., 'gmail'
  tenantId: authProfile.tenantId,
  projectId: authProfile.projectId ?? projectId,
  scope: authProfile.scope === 'tenant' ? 'tenant' : 'user',
  userId: authProfile.visibility === 'personal' ? authProfile.createdBy : null,
  authProfileId: authProfile._id,              // always set
  status: 'active',
  displayName: authProfile.name,
}
```

**Lifecycle**:

- **Create**: After `AuthProfile.create()` with `connector` set → create bridge `ConnectorConnection`
- **Delete**: After `AuthProfile.delete()` with `connector` set → delete bridge `ConnectorConnection` where `authProfileId` matches
- **Update**: If auth profile name/scope changes → update the bridge connection

### 6.8 New API Endpoints — Integration Connections

Two new endpoints for managing integration connections (the binding between connectors and auth profiles):

| Endpoint                                                 | Purpose                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /api/projects/:pid/integrations/connections`        | List connections for a project (with auth profile details) |
| `POST /api/projects/:pid/integrations/connections`       | Create a new connection (select connector + auth profile)  |
| `DELETE /api/projects/:pid/integrations/connections/:id` | Delete a connection                                        |
| `GET /api/integrations/connections`                      | Workspace-scoped variant                                   |
| `POST /api/integrations/connections`                     | Workspace-scoped create                                    |
| `DELETE /api/integrations/connections/:id`               | Workspace-scoped delete                                    |

**Create request body**:

```json
{
  "connectorName": "gmail",
  "displayName": "Gmail - Marketing",
  "authProfileId": "auth-profile-uuid",
  "scope": "user"
}
```

**Validation rules**:

- `authProfileId` must reference an existing, active auth profile accessible to the user
- Auth profile's `authType` must be compatible with the connector's supported auth types
- Unique constraint: `{ tenantId, projectId, connectorName, authProfileId }` prevents duplicate bindings
- The referenced auth profile must not already be used by another connection for the same connector in the same project

---

## 7. What Existing Infrastructure Is Reused

| Capability                   | Existing Component                                                   | Change Needed                                                             |
| ---------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Credential storage           | `auth_profiles` collection with `connector` field                    | None — field exists                                                       |
| Tenant/project scoping       | `scope: 'tenant'` / `scope: 'project'` on AuthProfile                | None                                                                      |
| Workspace UI                 | `WorkspaceAuthProfilesPage.tsx`                                      | Add tabs                                                                  |
| Project UI with inheritance  | `AuthProfilesPage.tsx` (shows tenant profiles read-only)             | Add tabs                                                                  |
| OAuth consent popup          | `AuthProfileOAuthDialog.tsx`                                         | None                                                                      |
| Token refresh (distributed)  | `shared-auth-profile/token-refresh-service.ts`                       | None                                                                      |
| Client credentials caching   | `shared-auth-profile/client-credentials-service.ts`                  | None                                                                      |
| JIT auth / end-user consent  | `BatchConsentGate`, `PausedExecutionStore`, `consent-state-resolver` | None                                                                      |
| Credential encryption        | `encryptionPlugin` on `encryptedSecrets`                             | None                                                                      |
| Nango provider lookup        | `ProviderConfigRegistry.getProviderConfig(name)`                     | Populate data                                                             |
| Tool auth resolution         | `resolve-tool-auth.ts` + `usageMode`                                 | None — already wired through `auth-scope-policy.ts`                       |
| OAuth schema                 | `OAuth2AppConfigSchema` (.strict())                                  | **Extend** — add `authorizationParams`, `tokenParams`, `connectionConfig` |
| OAuth routes                 | `initiate`, `user-consent`, `callback` routes                        | **Update** — consume new schema fields                                    |
| Connector execution          | `connection-resolver.ts`                                             | None — bridge `ConnectorConnection` auto-created (§6.6)                   |
| Slide-over with preselection | `AuthProfileSlideOver` with `preselectedAuthType`                    | Add `preselectedConnector`                                                |
| UI field naming              | `auth-type-metadata.ts` uses `defaultScopes` for `oauth2_app`        | None — already aligned                                                    |
| Workspace scope detection    | `projectId === '_workspace'` in slide-over                           | None                                                                      |

**No new collections. No new auth flows. No new model fields** (`usageMode` already exists). Schema extensions (OAuth config fields) and auto-bridge creation are required.

---

## 8. Files to Modify

### Backend — Model Simplification (§6.6)

| File                                                                              | Change                                                                                                     |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/database/src/models/connector-connection.model.ts`                      | Simplify to pure binding record: remove credential fields, make `authProfileId` required, new unique index |
| `packages/connectors/src/auth/connection-resolver.ts`                             | Remove legacy `refreshOAuth2()`, inline decrypt, env-var client secrets. Always delegate to auth profile   |
| `packages/shared/src/validation/auth-profile.schema.ts`                           | Extend `OAuth2AppConfigSchema` with `authorizationParams`, `tokenParams`, `connectionConfig`               |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`     | Consume `authorizationParams`, `connectionConfig`                                                          |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts` | Consume `authorizationParams`, `connectionConfig`                                                          |

> **Note**: `usageMode` field, Zod validation, and runtime wiring (`resolve-tool-auth.ts`, `auth-scope-policy.ts`, `auth-profile-tool-middleware.ts`) are already implemented — no changes needed.

### API Routes — Providers + Connection CRUD

| File                                                                               | Change                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/providers/route.ts`           | **New** — project-scoped providers endpoint (with visibility filtering)                           |
| `apps/studio/src/app/api/auth-profiles/providers/route.ts`                         | **New** — workspace-scoped providers endpoint (with visibility filtering)                         |
| `apps/studio/src/app/api/projects/[id]/integrations/connections/route.ts`          | **New** — project-scoped connection CRUD (list, create)                                           |
| `apps/studio/src/app/api/projects/[id]/integrations/connections/[connId]/route.ts` | **New** — project-scoped connection detail (update, delete)                                       |
| `apps/studio/src/app/api/integrations/connections/route.ts`                        | **New** — workspace-scoped connection CRUD                                                        |
| `apps/studio/src/app/api/integrations/connections/[connId]/route.ts`               | **New** — workspace-scoped connection detail                                                      |
| `apps/studio/src/api/auth-profiles.ts`                                             | Add `fetchIntegrationProviders()` + workspace variant                                             |
| `apps/studio/src/api/integrations.ts`                                              | **New** — client API functions for connection CRUD                                                |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts` (POST handler)      | After creating auth profile with `connector` set, auto-create bridge `ConnectorConnection` (§6.7) |
| `apps/studio/src/app/api/auth-profiles/route.ts` (POST handler)                    | Same bridge logic for workspace-scoped profiles                                                   |

### UI Components — Auth Profiles Page

| File                                                                     | Change                                                                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`          | Add tab bar, connector badge + scope columns in All Profiles; OAuth app/token aggregation (preconfigured → show token status, jit/preflight → show app only) |
| `apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx` | Add same tab bar, reuse shared components; disable `jit`/`preflight` modes (§3.2 constraint)                                                                 |
| `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx`        | **New** — catalog grid + inline expand. Props: `scope`, `projectId`. Show "Unsupported" badge for custom-auth connectors without Nango alias                 |
| `apps/studio/src/components/auth-profiles/IntegrationCard.tsx`           | **New** — expandable connector card with profile list and OAuth aggregation rules                                                                            |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`      | Add `preselectedConnector`, Nango pre-fill, connection config fields for URL templates (usage mode dropdown already exists)                                  |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`         | Add `getIntegrationTypeMetadata()` helper                                                                                                                    |

### UI Components — Integrations Page (§14)

| File                                                                 | Change                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/studio/src/components/integrations/IntegrationsPage.tsx`       | **New** — two-tab page (My Connections + Connector Catalog)                                |
| `apps/studio/src/components/integrations/MyConnectionsTab.tsx`       | **New** — connection list with auth profile details, scope badges, actions                 |
| `apps/studio/src/components/integrations/ConnectorCatalogTab.tsx`    | **New** — catalog grid (reuses `IntegrationCard` from auth profiles with connection count) |
| `apps/studio/src/components/integrations/CreateConnectionDialog.tsx` | **New** — name + grouped auth profile dropdown + scope selector                            |
| `apps/studio/src/components/auth-profiles/AuthProfilePicker.tsx`     | Enhance with `connectorName`, `excludeProfileIds`, grouped display, "Create New" link      |

---

## 9. Alternatives Considered

### Option A: Unified List (No Tabs)

Single list with all profiles (custom + integration). Filter by connector. Fastest to build (~3-5 days) but mixes power-user auth concepts with integration-focused UX. Integration discovery buried in form flow.

**Why not chosen**: Cluttered UX. Integration discovery is not first-class.

### Option C: Separate Pages, Shared Backend

Keep `ConnectionsPage` for integrations, `AuthProfilesPage` for custom. ConnectionsPage creates auth profiles under the hood.

**Why not chosen**: Two pages showing overlapping data creates source-of-truth confusion. Requires significant refactoring of `CreateConnectionModal`. Risk of inconsistency between pages.

---

## 10. Migration — Clean Break (No Backward Compatibility)

> **Decision**: The product is in beta. Rather than maintaining backward compatibility with the legacy credential system, we perform a clean break.

**What changes**:

1. **ConnectorConnection model** is simplified to a pure binding record (§6.6). All credential fields removed.
2. **ConnectionResolver** always delegates to auth profile. Legacy inline credential path and `refreshOAuth2()` are removed.
3. **Existing `ConnectorConnection` documents** with inline credentials are dropped. Any existing connections must be recreated through the new Integrations UI.
4. **Environment variable client secrets** (`OAUTH2_CLIENT_ID_<PROVIDER>`, `OAUTH_PROVIDER_<PROVIDER>_CLIENT_ID`) are no longer read by the connector system. Client secrets live in auth profiles.
5. **Dual-read pattern** (`dualReadCredentials()`) is no longer needed for new code. Existing consumers should be migrated to auth-profile-only resolution.
6. **ConnectionsPage** is replaced by the Integrations tabs (§14). The legacy `CreateConnectionModal` with inline credential entry is removed.

**Migration script**: A one-time script drops the old `connector_connections` collection and recreates it with the simplified schema. No data migration — beta users recreate connections through the new UI.

**Eliminated complexity**:

| Removed                                    | Impact                                             |
| ------------------------------------------ | -------------------------------------------------- |
| `ConnectionResolver.refreshOAuth2()`       | ~80 lines of distributed lock + token refresh code |
| `encryptedCredentials` on connections      | Eliminates one of two encryption approaches        |
| Env-var client secrets per provider        | Credentials managed in one place (auth profiles)   |
| `dualReadCredentials()` pattern            | 12+ call sites simplified                          |
| `CreateConnectionModal` inline credentials | One creation path: auth profile dropdown           |

---

## 11. Verification Plan

### Auth Profile Creation (Integrations Tab on Auth Profiles Page)

1. Create **preconfigured OAuth** profile: Integrations tab → Gmail → Expand → Create → OAuth App → Preconfigured → Fill clientId/clientSecret → Save & Authorize → Verify popup → Verify `oauth2_token` created with `connector: 'gmail'`, `scope: 'project'`
2. Create **JIT OAuth** profile: Gmail → OAuth App → JIT → Save → Verify no popup → At runtime, verify `BatchConsentGate` triggers consent flow
3. Create **API key** profile: Anthropic → API Key → Preconfigured → Fill key → Save → Verify `connector: 'claude'`, `scope: 'project'`
4. **Nango pre-fill**: Google Calendar → Verify authorizationUrl, tokenUrl, defaultScopes auto-populated
5. **Multiple profiles per integration**: Create 2 Gmail profiles → Both visible in expanded Gmail card
6. **All Profiles tab**: Verify all profiles (custom + integration + inherited tenant) visible with connector badge + scope columns
7. **OAuth aggregation (preconfigured)**: All Profiles tab shows `oauth2_token` with status badge for preconfigured Gmail — `oauth2_app` is hidden
8. **OAuth aggregation (JIT)**: All Profiles tab shows `oauth2_app` for JIT Gmail — no `oauth2_token` rows shown

### Integration Connections (Integrations Page — §14)

9. **Create connection with integration profile**: Integrations → Connector Catalog → Gmail → "New Connection" → Dropdown shows "Gmail Profiles" group with Gmail-Shared → Select → Create → Verify `ConnectorConnection` created with `authProfileId`
10. **Create connection with compatible profile**: Gmail → "New Connection" → Dropdown shows "Other Compatible Profiles" group → Select a non-connector oauth2 profile → Create → Verify connection works
11. **Duplicate auth profile blocked**: Try creating a second Gmail connection with the same auth profile → Dropdown shows it as disabled in "Already In Use" group → API returns uniqueness error
12. **Multiple connections per connector**: Create Gmail-Marketing (auth profile A) + Gmail-Support (auth profile B) → Both appear in My Connections tab
13. **My Connections tab**: Verify all connections listed with connector name, auth profile name+type, scope, status
14. **Tab switching**: Verify My Connections ↔ Connector Catalog tab switch uses same animated underline as auth profiles tabs
15. **Create New Auth Profile from dropdown**: Click "+ Create New Auth Profile" in dropdown → Opens `AuthProfileSlideOver` with `preselectedConnector` → Create profile → Returns to connection dialog with new profile auto-selected
16. **Delete connection**: Delete a connection → Verify auth profile is NOT deleted (only the binding)
17. **Delete auth profile cascade**: Delete a Gmail auth profile → Verify all `ConnectorConnection` documents with that `authProfileId` are also deleted

### Workspace (Tenant-Level)

18. Create **workspace integration profile**: Admin sidebar → Auth Profiles → Integrations tab → Gmail → Create → Verify `scope: 'tenant'`, `projectId: null`
19. **JIT/Preflight mode disabled**: Workspace Gmail create form → Verify `jit`/`preflight` options are disabled with tooltip
20. **Workspace connections**: Admin → Integrations → Create workspace Gmail connection → Verify visible as read-only in project-level My Connections tab
21. **Inheritance**: Create tenant Gmail profile → Go to project Integrations → Dropdown shows it in "Gmail Profiles" group with Workspace badge
22. **Visibility filtering**: Non-admin user → Dropdown and provider endpoint show only shared + own personal profiles

### Cross-Cutting

23. **Token refresh**: Create preconfigured Gmail connection → Verify `shared-auth-profile` refresh works (token-refresh-service.ts)
24. **Connector execution**: Create Gmail connection → Execute a connector action → Verify `ConnectionResolver` resolves credentials via `authProfileId` → auth profile system
25. **Simplified ConnectionResolver**: Verify no legacy `encryptedCredentials` / `refreshOAuth2()` code path exists
26. **Scope isolation**: Tenant profile visible across projects. Project profile not visible in other projects or workspace page.
27. **Custom profile flow unchanged**: All Profiles tab → Add Profile → Custom → Same flow as today
28. **Schema extension**: Create OAuth profile with `connectionConfig` (e.g., Shopify subdomain) → Verify field persists and resolves URL templates

---

## 12. Estimated Effort

| Area                                                    | Effort         | Notes                                                                                                            |
| ------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| ~~Backend (model + validation)~~                        | ~~0~~          | ✅ `usageMode` field, Zod schemas, and legal mode matrix already implemented                                     |
| ~~Runtime wiring~~                                      | ~~0~~          | ✅ `usageMode` already wired through `resolve-tool-auth.ts`, `auth-scope-policy.ts`, JIT middleware              |
| Backend (schema extension)                              | ~0.5 day       | Extend `OAuth2AppConfigSchema` with `authorizationParams`/`tokenParams`/`connectionConfig`                       |
| Backend (ConnectorConnection simplification)            | ~1 day         | Simplify model (§6.6), remove legacy credential fields, simplify `ConnectionResolver`                            |
| API endpoints (providers + connections)                 | ~2 days        | 2 provider endpoints, 6 connection CRUD endpoints (project + workspace), uniqueness validation                   |
| OAuth route updates                                     | ~0.5 day       | `initiate` + `user-consent` routes consume `authorizationParams`, `connectionConfig`                             |
| IntegrationAuthTab + IntegrationCard (Auth Profiles pg) | ~2 days        | Catalog grid, inline expand, "Unsupported" badge for custom-auth without Nango alias                             |
| AuthProfileSlideOver changes                            | ~1 day         | Nango pre-fill, `preselectedConnector`, connection config fields, URL template resolution                        |
| IntegrationsPage + My Connections tab (§14)             | ~2 days        | Two-tab page, connection list, expanded catalog card with connection count                                       |
| CreateConnectionDialog + AuthProfilePicker enhancements | ~1.5 days      | Grouped dropdown with connector/compatible/in-use sections, "Create New Auth Profile" flow                       |
| OAuth app/token aggregation (UI)                        | ~1 day         | Preconfigured → show token status; jit/preflight → show app only. Same logic in Integrations + All Profiles tabs |
| WorkspaceAuthProfilesPage + workspace connections       | ~0.5 day       | Reuse shared components, disable `jit`/`preflight` for workspace scope                                           |
| Testing + polish                                        | ~2 days        | Connection CRUD tests, dropdown grouping tests, uniqueness constraint tests, cascade delete tests                |
| **Total**                                               | **~14.5 days** |                                                                                                                  |

---

## 13. Design Decisions

| #   | Question                                                                                                    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should Nango pre-filled fields (authorizationUrl, tokenUrl, scopes) be read-only or overridable?            | **Overridable** — pre-filled as defaults, but users can modify them for custom OAuth app configurations or non-standard endpoints.                                                                                                                                                                                                                                                                                                                             |
| 2   | Should connectors with `authType: 'none'` (HTTP, Twilio, Google Sheets) appear in the Integrations tab?     | **Alias-first resolution** — check if the connector has a Nango provider alias (exact name or hyphen→underscore). If a Nango provider is found, show it with the resolved auth type. If no alias match, **filter it out** of the Integrations tab.                                                                                                                                                                                                             |
| 3   | How should connectors with `authType: 'custom'` (Jira, Shopify, Amazon S3, Postgres) map to our auth types? | **Alias resolution with unsupported fallback** — look up Nango provider config by connector name. Shopify matches directly (`shopify` → `shopify`, OAuth2 with URL template). Jira requires an alias fix (`jira-cloud` → `jira`). If **no Nango entry** (Amazon S3, Postgres), show in the catalog grid with an "Unsupported — use Connector Connections" badge and no "Create New Profile" button. No new `connector_custom` auth-profile type is introduced. |
| 4   | Should `pnpm connectors:import-providers` run in CI?                                                        | **Manual step** — run as needed when updating Nango provider data. The generated `providers.json` is checked into the repo.                                                                                                                                                                                                                                                                                                                                    |
| 5   | Can workspace OAuth apps support project-level end-user consent?                                            | **No — constrained.** The callback route's `validateLinkedAppProfile` rejects tenant-scoped apps when creating project-scoped tokens. `jit`/`preflight` modes are only available for project-scoped OAuth apps. The UI disables them for workspace-level profiles.                                                                                                                                                                                             |
| 6   | How should linked OAuth app/token pairs display in the UI?                                                  | **Mode-based aggregation.** `preconfigured`: show `oauth2_token` status only (hide app). `jit`/`preflight`: show `oauth2_app` only (hide per-user tokens). Same rules in both Integrations tab and All Profiles tab.                                                                                                                                                                                                                                           |
| 7   | How do integration auth profiles become runnable by connectors?                                             | **Auto-create bridge `ConnectorConnection`.** When an auth profile with `connector` is created, a thin `ConnectorConnection` with `authProfileId` is auto-created. `ConnectionResolver` is simplified to always delegate to auth profile (§6.6).                                                                                                                                                                                                               |
| 8   | Should provider endpoint counts include hidden personal profiles?                                           | **No.** Apply the same visibility filter as existing auth-profile routes. Non-admins see only `shared` + own `personal` profiles in both counts and arrays.                                                                                                                                                                                                                                                                                                    |
| 9   | Which connectionConfig fields should the UI show?                                                           | **Runtime-only.** Only show fields that appear in `authorizationUrl` or `tokenUrl` (needed at OAuth flow time). Fields in `proxyBaseUrl`/`proxyHeaders` only are excluded. Example: Pipedrive `api_domain` (proxy-only) hidden; Shopify `subdomain` (in auth URLs) shown; Jira `subdomain` (unused in any URL) hidden.                                                                                                                                         |
| 10  | Should the API key prefix/header field always be shown?                                                     | **Only when the provider defines one.** If Nango specifies a prefix (e.g., SendGrid `Bearer`), show it pre-filled. If no prefix (e.g., Anthropic `x-api-key` with no prefix), hide the prefix field entirely.                                                                                                                                                                                                                                                  |
| 11  | Should a "Resolved URL Preview" section be shown for all OAuth providers?                                   | **Only for providers with URL templates.** If `authorizationUrl`/`tokenUrl` contain `${connectionConfig.*}` placeholders, show the resolved URLs inline as the user fills in connection config. For static URLs (Gmail, GitHub, Salesforce, Jira, etc.), the OAuth Settings section shows URLs directly — no separate preview.                                                                                                                                 |
| 12  | How should Nango credential metadata (title, description, example, pattern) be used?                        | **As help text and placeholders.** Use `description` as help text below inputs, `example` as placeholder, `pattern` for client-side validation, `title` as label override. Applies to both connectionConfig fields and credential fields (e.g., `airtable-pat` has a `Personal Access Token` title and example pattern).                                                                                                                                       |
| 13  | Should `http` connector appear in the Integrations tab?                                                     | **No.** Removed entirely — it has `authType: 'none'`, no Nango entry, and no authentication to manage. 25 connectors shown (down from 26).                                                                                                                                                                                                                                                                                                                     |
| 14  | Should backward compatibility be maintained for existing ConnectorConnection credentials?                   | **No.** Product is in beta. Clean break — `ConnectorConnection` simplified to a pure binding record. Legacy inline credentials dropped. Existing connections must be recreated through the new UI.                                                                                                                                                                                                                                                             |
| 15  | Should inline credential entry be allowed when creating connections?                                        | **No.** Auth profiles are the only credential source. Connection creation shows an auth profile dropdown, not credential fields. Users create auth profiles first (or via the "Create New Auth Profile" link in the dropdown).                                                                                                                                                                                                                                 |
| 16  | How should the auth profile dropdown be grouped?                                                            | **Three groups:** (1) "{Connector} Profiles" — profiles with matching `connector` field; (2) "Other Compatible Profiles" — profiles with no connector but compatible `authType`; (3) "Already In Use" — profiles already bound to another connection for the same connector, shown disabled.                                                                                                                                                                   |
| 17  | Can the same auth profile be used by multiple connectors?                                                   | **Yes.** A Google OAuth profile can be used by both Gmail and Google Calendar connections. The uniqueness constraint is per-connector: `{ tenantId, projectId, connectorName, authProfileId }`.                                                                                                                                                                                                                                                                |
| 18  | Where do users manage connections vs auth profiles?                                                         | **Two pages.** Auth Profiles page (Settings > Auth Profiles) for credential CRUD. Integrations page (sidebar, prominent) for connection bindings. Cross-navigation via "Create New Auth Profile" link in the connection dropdown.                                                                                                                                                                                                                              |

### Alias Resolution Logic

The `enrichWithOAuth()` function in `packages/connectors/src/catalog/extract-entry.ts` does alias matching with three strategies:

```typescript
const NANGO_ALIAS_MAP: Record<string, string> = {
  'jira-cloud': 'jira',
  claude: 'anthropic',
};

const alias = NANGO_ALIAS_MAP[entry.name];
const provider = providers.find(
  (p) =>
    p.name === entry.name ||
    p.name === entry.name.replaceAll('-', '_') ||
    (alias != null && p.name === alias),
);
```

The function works for **all** catalog auth types (not just `oauth2`), so connectors with `authType: 'custom'` or `'none'` are enriched with Nango OAuth2 metadata when a provider match exists.

This same logic will be used to determine which connectors appear in the Integrations tab:

- **Match found** → show in Integrations tab with Nango-resolved auth type and OAuth metadata
- **No match** → unsupported badge (custom auth) or filtered out (no auth, no Nango)

**Examples**:
| Connector | Catalog `authType` | Nango Alias Match | Integrations Tab? | Resolved Auth | Runtime connectionConfig |
|---|---|---|---|---|---|
| `gmail` | `oauth2` | `gmail` ✅ | Yes — create enabled | OAuth 2.0 | — |
| `discord` | `api_key` | `discord` ✅ (Nango: `oauth2`) | Yes — create enabled | OAuth 2.0 | — |
| `stripe` | `api_key` | `stripe` ✅ (Nango: `oauth2`) | Yes — create enabled | OAuth 2.0 | — |
| `linear` | `api_key` | `linear` ✅ (Nango: `oauth2`) | Yes — create enabled | OAuth 2.0 | — |
| `airtable` | `api_key` | `airtable` ✅ (Nango: `oauth2`) | Yes — create enabled | OAuth 2.0 | — |
| `shopify` | `custom` | `shopify` ✅ (Nango: `oauth2`) | Yes — create enabled | OAuth 2.0 | `subdomain` (in auth+token URLs) |
| `jira-cloud` | `custom` | `jira` ✅ (via `NANGO_ALIAS_MAP`) | Yes — create enabled | OAuth 2.0 | — (`subdomain` unused in URLs) |
| `google-sheets` | `none` | `google-sheets` ✅ (Nango: `oauth2`) | Yes — create enabled | OAuth 2.0 | — |
| `twilio` | `none` | `twilio` ✅ (Nango: `oauth2`) | Yes — create enabled | OAuth 2.0 | — |
| `claude` | `api_key` | `anthropic` ✅ (Nango: `api_key`) | Yes — create enabled | API Key | — (`version` is proxy-only) |
| `sendgrid` | `api_key` | `sendgrid` ✅ (Nango: `api_key`) | Yes — create enabled | API Key | — |
| `amazon-s3` | `custom` | No Nango entry | Yes — **"Unsupported" badge**, no create | — | — |
| `postgres` | `custom` | No Nango entry | Yes — **"Unsupported" badge**, no create | — | — |

---

## 14. Integration Connections — Two-Tab UX with Auth Profile Selection

### 14.1 Overview

Integration connections are managed through a dedicated Integrations page with two tabs: "My Connections" and "Connector Catalog". Connections are **binding records** that link a connector to an auth profile — no inline credentials are allowed. Users select an auth profile from a grouped dropdown when creating a connection.

This replaces the legacy `ConnectionsPage` which had inline credential entry and a split-page layout.

### 14.2 Page Layout — Two Tabs

```
Integrations > [My Connections]  [Connector Catalog]
```

Uses the same `<Tabs>` component with Framer Motion animated underline as `AuthProfilesPage`. Tab state is local React state (`useState`), no URL routing.

### 14.3 My Connections Tab

Lists all connections for the current scope (project or workspace), with auth profile details inline:

```
Integrations > [My Connections]  [Connector Catalog]
─────────────────────────────────────────────────────
[+ New Connection]   Search: [_______________]

| Name              | Connector | Auth Profile          | Scope     | Status |
|-------------------|-----------|-----------------------|-----------|--------|
| Gmail-Marketing   | Gmail     | Gmail-Shared (oauth2) | Project   | Active |
| Gmail-Support     | Gmail     | Gmail-Support (oauth2)| Project   | Active |
| Slack-Team        | Slack     | Slack-WS (oauth2)    | Workspace | Active |
| Stripe-Prod       | Stripe    | Stripe Key (api_key)  | Project   | Active |
| GitHub-CI         | GitHub    | GH-Org (oauth2)      | Workspace | Active |
```

**Row details**:

- **Name**: `displayName` from the connection
- **Connector**: Connector display name with icon
- **Auth Profile**: Name + auth type badge of the linked auth profile
- **Scope**: Project or Workspace (inherited workspace connections shown read-only with "Managed in Workspace" badge)
- **Status**: Active / Expired / Revoked (derived from linked auth profile status)
- **Actions**: Edit (change name/auth profile), Delete

### 14.4 Connector Catalog Tab

Same catalog grid as the current Integrations tab on the auth profiles page. Each card shows the connector name, supported auth types, and existing connection count.

```
Integrations > [My Connections]  [Connector Catalog]
─────────────────────────────────────────────────────
Search: [_________________________] [Category ▾]

┌──────────┐ ┌──────────┐ ┌──────────┐
│   Gmail   │ │  G.Cal   │ │  G.Drive │
│  oauth2   │ │  oauth2  │ │  oauth2  │
│ 2 conns   │ │    —     │ │ 1 conn   │
└──────────┘ └──────────┘ └──────────┘
```

Clicking a card expands it inline to show existing connections and a "New Connection" button.

### 14.5 Create Connection Flow — Auth Profile Dropdown

Clicking "New Connection" (from either tab or an expanded catalog card) opens a dialog:

```
══ New Connection: Gmail ════════════════════════

  ── Name ─────────────────────────────────────
  [Gmail - Marketing_________________________]

  ── Auth Profile ─────────────────────────────
  [▾ Select auth profile...                   ]
  ┌───────────────────────────────────────────┐
  │ ── Gmail Profiles ───────────────────────  │
  │   ✅ Gmail-Shared        oauth2  Workspace │
  │   ✅ Gmail-Sales         oauth2  Project   │
  │   🔒 Gmail-Personal     oauth2  Personal  │
  │                                            │
  │ ── Other Compatible Profiles ────────────  │
  │   ✅ Google OAuth App    oauth2  Workspace │
  │   ✅ Custom Bearer Token bearer  Project   │
  │                                            │
  │ ── Already In Use ───────────────────────  │
  │   ⛔ Gmail-Old          oauth2  Project   │
  │      (used by "Gmail-Legacy" connection)   │
  │                                            │
  │ ─────────────────────────────────────────  │
  │   [+ Create New Auth Profile]              │
  └───────────────────────────────────────────┘

             [Cancel]    [Create Connection]
```

### 14.6 Dropdown Grouping Logic

The enhanced `AuthProfilePicker` groups profiles into three sections:

| Group                              | Label                  | Filter                                                                                                                    | Display                                                |
| ---------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **1. "{Connector} Profiles"**      | e.g., "Gmail Profiles" | `connector === connectorName`, active, accessible to user (project + inherited tenant)                                    | Enabled, sorted by scope (workspace first) then name   |
| **2. "Other Compatible Profiles"** | Static label           | `connector IS NULL` AND `authType` compatible with connector's available auth types, active                               | Enabled, sorted by scope then name                     |
| **3. "Already In Use"**            | Static label           | Profiles from groups 1+2 that are already linked to another connection for the **same connector** in the **same project** | **Disabled** with "used by {connection name}" subtitle |

**Compatibility**: A profile's `authType` must match one of the connector's `availableAuthTypes`. For example, a Gmail connector (OAuth2 only) won't show `api_key` profiles in "Other Compatible Profiles".

**"Create New Auth Profile" link**: At the bottom of the dropdown. Clicking it:

1. Closes the connection dialog (preserves state)
2. Opens `AuthProfileSlideOver` with `preselectedConnector` for the current connector
3. On profile creation → returns to connection dialog with new profile auto-selected

### 14.7 Uniqueness Constraint

**Rule**: One auth profile cannot be used by multiple connections for the same connector in the same project.

- **Enforced at DB level**: Unique index `{ tenantId, projectId, connectorName, authProfileId }`
- **Enforced in UI**: Profiles already in use appear in the "Already In Use" group, disabled
- **Allowed**: The same auth profile CAN be used by different connectors (e.g., a Google OAuth profile could be used by both Gmail and Google Calendar connections)
- **Allowed**: Multiple connections for the same connector with different auth profiles (e.g., Gmail-Marketing and Gmail-Support using different Gmail auth profiles)

### 14.8 Connection Lifecycle

| Action                   | What Happens                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Create connection**    | `POST /api/projects/:pid/integrations/connections` with `connectorName` + `authProfileId` → validates uniqueness, creates binding record         |
| **Delete connection**    | Deletes the `ConnectorConnection` document. Does NOT delete the auth profile (it may be shared).                                                 |
| **Delete auth profile**  | Cascades: all `ConnectorConnection` documents with `authProfileId` matching the deleted profile are also deleted                                 |
| **Edit connection**      | Can change `displayName` and `authProfileId` (to switch to a different profile). Uniqueness validated on update.                                 |
| **Auth profile expires** | Connection status derived from profile — shown as "Expired" in My Connections tab. User re-authorizes via the auth profile (not the connection). |

### 14.9 Relationship to Auth Profiles Page

The two pages serve different purposes:

| Page                                         | Purpose                                                  | Creates                                            |
| -------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| **Auth Profiles** (Settings > Auth Profiles) | Manage credentials — create OAuth apps, API keys, tokens | `auth_profile` documents                           |
| **Integrations** (sidebar, prominent)        | Manage connections — bind connectors to auth profiles    | `connector_connection` documents (binding records) |

The Auth Profiles page retains its "All Profiles" and "Integrations" (catalog) tabs for profile CRUD. The new Integrations page focuses on the connection binding.

**Cross-navigation**:

- From Integrations "Create Connection" dropdown → "Create New Auth Profile" → opens `AuthProfileSlideOver`
- From Auth Profiles "Integrations" tab → expanding a connector card shows connections using that profile
- From My Connections → clicking the auth profile name navigates to the auth profile detail/edit

### 14.10 Workspace (Tenant-Level) Connections

The same two-tab layout appears in the workspace admin area:

- **My Connections**: Shows tenant-scoped connections only (`scope: 'tenant'`)
- **Connector Catalog**: Same grid, counts show tenant connections only
- Create flow: Same dropdown, but only tenant-scoped and shared auth profiles shown
- At project level, inherited workspace connections appear read-only with "Managed in Workspace" badge

### 14.11 Files to Modify for Integration Connections

| File                                                                      | Change                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/database/src/models/connector-connection.model.ts`              | Simplify model (§6.6), new unique index                            |
| `packages/connectors/src/auth/connection-resolver.ts`                     | Simplify to auth-profile-only resolution                           |
| `apps/studio/src/app/api/projects/[id]/integrations/connections/route.ts` | **New** — project-scoped connection CRUD                           |
| `apps/studio/src/app/api/integrations/connections/route.ts`               | **New** — workspace-scoped connection CRUD                         |
| `apps/studio/src/api/integrations.ts`                                     | **New** — client API functions                                     |
| `apps/studio/src/components/integrations/IntegrationsPage.tsx`            | **New** — two-tab page (My Connections + Catalog)                  |
| `apps/studio/src/components/integrations/MyConnectionsTab.tsx`            | **New** — connection list with auth profile details                |
| `apps/studio/src/components/integrations/CreateConnectionDialog.tsx`      | **New** — name + auth profile dropdown                             |
| `apps/studio/src/components/auth-profiles/AuthProfilePicker.tsx`          | Enhance with `connectorName`, `excludeProfileIds`, grouped display |

---

## Appendix A: The Dual Credential System — Detailed Problem Analysis

This appendix provides the detailed evidence behind the problem statement in §1: _"This dual system creates confusion about where credentials live, duplicates auth logic, and makes it hard to manage integration credentials alongside custom API credentials in one place."_

### A.1 Four Possible Credential Locations

A single integration like Gmail can have its OAuth2 credentials stored in any of these locations:

| #   | Location                                   | Collection              | Field                                            | Example                                                                                              |
| --- | ------------------------------------------ | ----------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1   | Connector Connection (own credentials)     | `connector_connections` | `encryptedCredentials` + `oauth2RefreshToken`    | A Gmail connection storing its own access/refresh tokens                                             |
| 2   | Auth Profile                               | `auth_profiles`         | `encryptedSecrets`                               | An `oauth2_app` + linked `oauth2_token` profile for Gmail                                            |
| 3   | Connector Connection → Auth Profile bridge | `connector_connections` | `authProfileId` → resolves from `auth_profiles`  | A Gmail connection with empty `encryptedCredentials` but `authProfileId` pointing to an auth profile |
| 4   | EndUserOAuthToken                          | `end_user_oauth_tokens` | `encryptedAccessToken` + `encryptedRefreshToken` | Per-user runtime tokens managed by `TokenManager`                                                    |

When debugging "why isn't my Gmail connector working?", all four must be checked.

### A.2 Two UI Paths, No Guidance on Which to Use

The Studio sidebar presents two entry points for managing integration credentials:

**Path A — "Connections" (prominent, under Resources in the project sidebar)**

- `ProjectSidebar.tsx:100` — appears as a top-level sidebar item with a `Plug` icon
- `ConnectionsPage.tsx` — split layout: "My Connections" cards on top, "Connector Catalog" grid with "Connect" buttons on bottom
- Creates `connector_connection` documents
- This is where most users naturally go for Gmail, Slack, GitHub, etc.

**Path B — "Auth Profiles" (buried under Settings > Integrations)**

- `ProjectSidebar.tsx:190` — nested inside the Settings group with a `KeyRound` icon
- `AuthProfilesPage.tsx` — CRUD table with 17 auth types, status badges, environment filters, bulk operations
- Creates `auth_profile` documents
- Designed for power users managing API keys, custom OAuth apps, mTLS certs, etc.

**Path C — Workspace "Auth Profiles" (admin sidebar)**

- `WorkspaceAuthProfilesPage.tsx` — tenant-level auth profile management in the admin area

A user setting up Gmail has to decide: go to the prominent "Connections" page, or to "Settings > Auth Profiles"? Both can store OAuth2 credentials for the same providers. The `CreateConnectionModal` offers a toggle between "enter credentials directly" and "select an auth profile" — acknowledging internally that both systems exist — but this creates more confusion, not less.

### A.3 Three Separate OAuth Token Refresh Implementations

The platform refreshes OAuth tokens in three different codepaths with three different locking strategies:

| #   | Implementation                     | File                                                                     | Lock Strategy                                                                             | Storage Target                                       |
| --- | ---------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | `ConnectionResolver.refreshOAuth2` | `packages/connectors/src/auth/connection-resolver.ts:160`                | Generic `LockManagerLike`, key `oauth2:refresh:{connectionId}`, 30s TTL                   | `connector_connection.encryptedCredentials`          |
| 2   | `refreshOAuth2Token`               | `packages/shared/src/services/auth-profile/token-refresh-service.ts:191` | Direct Redis `SET NX PX`, key `auth-profile:refresh-lock:{tenantId}:{profileId}`, 30s TTL | `auth_profile.encryptedSecrets` via `profile.save()` |
| 3   | `TokenManager.refreshToken`        | `packages/connectors/base/src/auth/token-manager.ts:187`                 | No distributed lock                                                                       | `EndUserOAuthToken` model                            |

All three do the same thing: POST to a provider's token endpoint with a `refresh_token` grant. But they have different error-handling semantics:

- `TokenManager` silently falls back to legacy on auth profile resolution failure (`void error;`)
- `dual-read.ts` explicitly states errors must propagate and NOT silently fall back

### A.4 Two Encryption Approaches for the Same Purpose

| Aspect                   | connector_connections                                                                             | auth_profiles                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Encryption method**    | Manual `encryptionService.encryptForTenant()` / `decryptForTenant()` calls in `ConnectionService` | Mongoose `encryptionPlugin` (automatic on save/read)                                                       |
| **Field name**           | `encryptedCredentials`                                                                            | `encryptedSecrets`                                                                                         |
| **Key rotation**         | Bespoke batch utility (`key-rotation.ts`) — manual decrypt-old + encrypt-new in batches of 100    | Plugin-based with `previousEncryptedSecrets` + grace period (`grace-period.ts`) for zero-downtime rotation |
| **Key version tracking** | `encryptionKeyVersion`                                                                            | `encryptionKeyVersion`                                                                                     |

Same AES-256-GCM encryption under the hood, but two completely different implementation patterns. A security audit must review both paths independently.

### A.5 The Dual-Read Pattern (12+ Consumers)

Because credentials can live in either system, a `dualReadCredentials()` helper exists (`packages/shared/src/services/auth-profile/dual-read.ts`) that every consumer must call:

```
if (AUTH_PROFILE_ENABLED && entity.authProfileId) → resolve from auth_profiles
else → decrypt entity.encryptedCredentials (legacy fallback)
```

This is repeated across 12+ call sites. The channel connection resolver alone (`apps/runtime/src/channels/connection-resolver.ts`) repeats this pattern 3 times in a single file (lines 96-120, 208-221, 312-325). Every new feature that touches credentials must remember to check both systems.

### A.6 Misaligned Scoping Models

| Dimension             | connector_connections                                 | auth_profiles                                                                   |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Ownership scope**   | `tenant` or `user`                                    | `tenant` or `project`                                                           |
| **Visibility**        | Not modeled                                           | `shared` or `personal`                                                          |
| **Project binding**   | Always requires `projectId`                           | `projectId` or `null` (tenant-wide, inherited by all projects)                  |
| **User binding**      | `userId` when `scope: 'user'`                         | `createdBy` (immutable), filtered by `personal` visibility                      |
| **Environment**       | Not modeled                                           | Optional `environment` with cascading fallback resolution                       |
| **Unique constraint** | `(tenantId, projectId, connectorName, scope, userId)` | `(tenantId, projectId, name, environment, visibility)` across 4 partial indexes |

A tenant-scoped auth profile (`projectId: null`) is inherited by all projects automatically. A tenant-scoped connector connection still requires a specific `projectId`. This mismatch means bridging via `authProfileId` creates asymmetric access patterns — the auth profile is visible everywhere, but the connector connection that points to it is project-bound.

### A.7 What This Design Addresses

The Integration Auth Profiles design performs a **clean break** (product is in beta — no backward compatibility). `ConnectorConnection` is simplified to a pure binding record, and all credential management is consolidated into `auth_profiles`:

| Problem                             | Solution                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two UI paths with no guidance       | Two pages with clear purpose: Auth Profiles for credentials, Integrations for connection bindings. Cross-linked via dropdown.                          |
| Credentials in 4 locations          | **One location**: `auth_profiles`. Connections are binding records with no credential fields.                                                          |
| Three OAuth refresh implementations | **One implementation**: `token-refresh-service.ts`. `ConnectionResolver.refreshOAuth2()` eliminated entirely.                                          |
| Two encryption approaches           | **One approach**: Mongoose `encryptionPlugin` on `auth_profiles`. No encryption on connections.                                                        |
| 12+ dual-read consumers             | `dualReadCredentials()` no longer needed. All consumers resolve through auth profile system.                                                           |
| Misaligned scoping                  | Auth profile scoping (tenant/project + shared/personal + environment) is the canonical model. Connections derive scope from their parent auth profile. |
