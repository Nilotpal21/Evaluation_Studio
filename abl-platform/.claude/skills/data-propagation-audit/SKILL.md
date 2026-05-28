---
name: data-propagation-audit
description: Audit auth profile field propagation across all layers — schema, catalog, UI prefill, API write, OAuth initiation, token exchange, token refresh, and runtime resolution. Catches omission bugs where a field is defined in one layer but missing in the next.
---

# Data Propagation Audit

## Purpose

Catches **omission bugs** where a field exists in one layer (e.g., schema defines `tokenParams`) but is silently dropped in a downstream layer (e.g., token exchange never sends it). These bugs are invisible in file-level code review because each file is correct in isolation.

## When to Use

- After modifying any auth profile field (schema, config, secrets)
- After adding a new field to OAuth2App config or secrets
- After modifying OAuth initiation, callback, or refresh flows
- After changing provider catalog enrichment or UI prefill logic
- Before PRs touching auth profile data flow
- When reviewing integration auth changes

## Architecture: The 8 Layers

Auth profile fields flow through these layers. A field must be handled at every layer it passes through:

```
Layer 1: Schema (Zod)          — Defines and validates the field
Layer 2: Provider Catalog       — Nango providers.json + catalog enrichment
Layer 3: Provider Service       — Surfaces catalog data to UI (IntegrationProvider)
Layer 4: UI Prefill             — Maps provider data to profile creation form
Layer 5: API Write              — Validates and persists to DB (config bag + encrypted secrets)
Layer 6: OAuth Initiation       — Reads config to build authorization URL
Layer 7: OAuth Callback         — Reads config to build token exchange request
Layer 8: Token Refresh          — Reads config via OAuth2AppCredentials resolver
```

## Audit Procedure

### Step 1: Identify Changed Fields

Read the diff or changed files. List every auth profile config/secret field that was added, modified, or referenced.

### Step 2: Trace Each Field Through All Layers

For each field, check presence and correct handling at every applicable layer.

#### Config Fields — Check Files

| Layer                       | File(s)                                                                                                                                          | What to Check                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Schema**                  | `packages/shared/src/validation/auth-profile.schema.ts`                                                                                          | Field defined in Zod schema (OAuth2AppConfigSchema, OAuth2ClientCredentialsConfigSchema, etc.) |
| **Catalog**                 | `packages/connectors/src/adapters/nango/generated/providers.json`                                                                                | Field present in provider entries                                                              |
| **Provider Service**        | `apps/studio/src/lib/integration-provider-service.ts`                                                                                            | Field read from Nango config and included in `oauth2` object                                   |
| **UI Prefill**              | `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx` — `buildConnectorPrefillConfig()`                                            | Field mapped from `connector.oauth2.*` to `prefillConfig.*`                                    |
| **Config Field Extraction** | `apps/studio/src/lib/connection-config-utils.ts` — `extractConnectionConfigFields()`                                                             | If field contains `${connectionConfig.xxx}` templates, those templates are scanned             |
| **API Write**               | `apps/studio/src/app/api/auth-profiles/route.ts` (workspace POST), `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts` (project POST) | URL fields SSRF-validated; config persisted                                                    |
| **API Update**              | `apps/studio/src/app/api/auth-profiles/[profileId]/route.ts`, `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts`         | Merge logic handles field (especially `mergeOAuth2AppConfig()`)                                |
| **OAuth Initiate**          | `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`                                                                    | Field read from `config` and applied to authorization URL                                      |
| **OAuth Callback**          | `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts`                                                                    | Field read from `config` and sent in token exchange body                                       |
| **App Resolver**            | `packages/shared/src/services/auth-profile/oauth2-app-resolver.ts`, `packages/shared-auth-profile/src/oauth2-app-resolver.ts`                    | Field included in `OAuth2AppCredentials` interface and return object                           |
| **Token Refresh**           | `packages/shared/src/services/auth-profile/token-refresh-service.ts`, `packages/shared-auth-profile/src/token-refresh-service.ts`                | Field consumed from `appCreds` and applied to refresh request                                  |

#### Secret Fields — Check Files

| Layer              | File(s)                                                                   | What to Check                                                                |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Schema**         | `packages/shared/src/validation/auth-profile.schema.ts` — secrets schemas | Field defined                                                                |
| **API Write**      | POST routes                                                               | `JSON.stringify(body.secrets)` persists all secrets                          |
| **OAuth Callback** | callback route                                                            | `JSON.parse(appProfile.encryptedSecrets)` reads, field destructured and sent |
| **App Resolver**   | `oauth2-app-resolver.ts`                                                  | Secrets parsed and field included in return                                  |
| **Token Refresh**  | `token-refresh-service.ts`                                                | Field consumed from `appCreds`                                               |

### Step 3: Check Provider-Specific Requirements

Pick 3-5 providers with non-standard configs from `providers.json` and verify the full flow works for each:

| Test Provider              | Non-Standard Config                                            | What to Verify                                                    |
| -------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| **BambooHR**               | `tokenParams: { "request": "token" }`                          | tokenParams sent in token exchange AND refresh                    |
| **Basecamp**               | `tokenParams: { "type": "web_server" }`                        | tokenParams sent in token exchange AND refresh                    |
| **Amazon Selling Partner** | `authorizationParams` with `${connectionConfig.applicationId}` | connectionConfigFields includes `applicationId`, form renders it  |
| **Figma**                  | Distinct `refreshUrl` vs `tokenUrl`                            | refreshUrl prefilled, stored, used in refresh                     |
| **Salesforce**             | `authorizationUrl` with `${connectionConfig.instance}`         | connectionConfigFields includes `instance`, URL template resolved |
| **Clover**                 | Distinct `refreshUrl` + `tokenParams`                          | Both propagated correctly                                         |

### Step 4: Check for Parallel Implementations

These file pairs MUST stay in sync — any field added to one must be added to the other:

| Primary                                                              | Mirror                                                      | What to Sync                                     |
| -------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| `packages/shared/src/services/auth-profile/oauth2-app-resolver.ts`   | `packages/shared-auth-profile/src/oauth2-app-resolver.ts`   | `OAuth2AppCredentials` interface + return object |
| `packages/shared/src/services/auth-profile/token-refresh-service.ts` | `packages/shared-auth-profile/src/token-refresh-service.ts` | Refresh token body construction                  |

## Expected Field Propagation Matrix

Reference matrix for OAuth2App fields. A gap in this matrix is a potential bug:

| Field                 | Schema | Catalog | Svc | Prefill | Initiate   | Callback  | Resolver | Refresh   |
| --------------------- | ------ | ------- | --- | ------- | ---------- | --------- | -------- | --------- |
| `authorizationUrl`    | Y      | Y       | Y   | Y       | READ       | -         | Y        | Y\*       |
| `tokenUrl`            | Y      | Y       | Y   | Y       | check      | READ      | Y        | Y         |
| `refreshUrl`          | Y      | Y       | Y   | Y       | -          | -         | Y        | READ      |
| `revocationUrl`       | Y      | -       | -   | -       | -          | -         | Y        | -         |
| `defaultScopes`       | Y      | Y       | Y   | Y       | READ       | -         | Y        | Y\*       |
| `scopeSeparator`      | Y      | Y       | -   | -       | READ       | -         | -        | -         |
| `pkceRequired`        | Y      | Y(pkce) | Y   | Y       | READ       | READ      | Y        | Y\*       |
| `pkceMethod`          | Y      | -       | -   | -       | READ       | -         | Y        | Y\*       |
| `authorizationParams` | Y      | Y       | Y   | Y       | READ+APPLY | -         | -        | -         |
| `tokenParams`         | Y      | Y       | Y   | Y       | -          | READ+SEND | Y        | READ+SEND |
| `connectionConfig`    | Y      | Y       | Y   | partial | template   | template  | -        | -         |
| `clientId`            | Y      | -       | -   | -       | READ+SEND  | READ+SEND | Y        | READ+SEND |
| `clientSecret`        | Y      | -       | -   | -       | -          | READ+SEND | Y        | READ+SEND |

`*` = via OAuth2AppCredentials resolver
`-` = not applicable at this layer
`partial` = only fields referenced in URL/param templates

## Reporting Format

For each field audited, report:

```
FIELD: <fieldName>
  Layer 1 (Schema):     OK — defined at auth-profile.schema.ts:183
  Layer 3 (Service):    OK — surfaced at integration-provider-service.ts:307
  Layer 4 (Prefill):    GAP — missing from buildConnectorPrefillConfig()
  Layer 7 (Callback):   OK — sent in token exchange at callback/route.ts:222
  Layer 8 (Refresh):    GAP — not in OAuth2AppCredentials, not sent in refresh body
  VERDICT: INCOMPLETE — gaps at Layer 4, Layer 8
```

## Known Design Decisions (Not Bugs)

These are intentional gaps, not propagation bugs:

- `authorizationParams` is NOT in `OAuth2AppCredentials` — it's only needed at initiation time, not refresh
- `scopeSeparator` is NOT in the resolver — scope joining only happens at initiation
- `connectionConfig` values are resolved into URLs at initiation/callback time, not stored separately in the resolver
- `deviceAuthorizationUrl`, `tokenIntrospectionUrl`, `supportedGrantTypes` are schema-only (future use)
- `setupGuideUrl`, `docsUrl` are UI-display-only fields
