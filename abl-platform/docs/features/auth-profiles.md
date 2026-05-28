# Feature: Auth Profiles

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA <!-- ABLP-913 core implementation and 2026-05-13 review hardening landed; strict E2E depth and production soak remain pending -->
**Feature Area(s)**: `integrations`, `governance`, `enterprise`, `admin operations`, `observability`
**Package(s)**: `@agent-platform/shared`, `@agent-platform/shared-auth-profile`, `@agent-platform/database`, `apps/runtime`, `apps/studio`, `apps/search-ai`, `packages/project-io`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/auth-profiles.md](../testing/auth-profiles.md)
**Last Updated**: 2026-05-20
**Driving Tickets**: [ABLP-913](https://koreteam.atlassian.net/browse/ABLP-913) — Auth Profile Design — Decisions & Behavior Spec
**Discussion Inputs**: 2026-05-09 Auth Profile review

---

## 1. Introduction / Overview

### Problem Statement

Before Auth Profiles, platform credentials were scattered across connector records, model configs, channel connections, and other consumer-specific settings. Each consumer type implemented its own credential storage, making rotation, revocation, import/export, auditing, and consistent tenant/project/user isolation difficult. As the platform grew to support OAuth, client credentials, mTLS, request signing, and enterprise auth variations, the absence of a centralized credential layer created security risks (credentials duplicated across documents) and operational overhead (no single place to rotate or revoke a key).

ABLP-913 extends the spec with the operator-facing behaviors needed to make Auth Profiles a **single, unified concept**: explicit Integration vs Custom typing, profile-level Authorize CTAs and "To be Authorized" state, vendor-grouped Integrations Tab, type-aware assignment UI at tools/integration nodes, project-scoped consent persistence, blast-radius-aware revocation (with a new "Revoke User Tokens" action distinct from profile decommission), mid-session invalidation, and per-profile audit logs.

### Goal Statement

Auth Profiles provides a single, tenant-isolated, project-aware credential management layer that supports multiple auth mechanisms, formal lifecycle management (create, validate, rotate, expire, revoke profile, revoke user tokens), safe runtime resolution with caching and distributed locking, upfront session-init scanning for credential readiness, and gradual migration away from legacy embedded credentials via a dual-read pattern. Studio operators manage credentials once and authorize Preconfigured profiles in place; end users authorize once per project (JIT/Preflight) and never re-prompt across sessions in the same project. Runtime, connectors, models, MCP servers, A2A servers, and channels consume credentials through a consistent contract with explicit blast-radius visibility.

### Summary

Auth Profiles is a unified, encrypted credential management system for the ABL Platform. It centralizes API keys, OAuth tokens, and other credentials into an encrypted MongoDB-backed store with formal lifecycle management. The system supports 17 authentication types across three implementation phases:

- **Phase 1** (core): none, api_key, bearer, oauth2_app, oauth2_token, oauth2_client_credentials
- **Phase 2** (enterprise): basic, custom_header, aws_iam, azure_ad, mtls, ssh_key
- **Phase 3** (advanced enterprise): digest, kerberos, saml, hawk, ws_security

Each profile carries one of two **profile types** — `integration` (vendor-aware, prepopulates known OAuth endpoints/scopes; visible in the vendor-grouped Integrations Tab) or `custom` (generic; for internal APIs and bespoke services). Each profile carries a single **usage mode** that applies everywhere it is referenced — `preconfigured` (admin authorizes once; token shared across all assignments), `jit` (end user authorizes mid-conversation per tool need), or `preflight` (end user authorizes upfront before session starts). Each auth type has its own Zod-validated config and secrets schema. Secrets are encrypted at rest via AES-256-GCM with tenant-scoped key derivation (PBKDF2 or HKDF). A dual-read migration pattern (`dualReadCredentials()`) allows consumers to resolve credentials from either Auth Profiles or legacy credential fields. The `AUTH_PROFILE_ENABLED` feature flag has been removed — auth profiles are always enabled.

Per-user OAuth grants (JIT/Preflight) persist in `EndUserOAuthToken` keyed by `{tenantId, projectId, userId, provider}` so a user authorizes **once per project** and is never re-prompted across sessions in that project. Profile updates and token revocation are fully decoupled — saving config never auto-invalidates tokens. Two distinct revoke actions: **Revoke Profile** (irreversible decommission) and **Revoke User Tokens** (clears stored or per-user OAuth tokens, profile and assignments stay intact). Both surface a pre-revoke blast-radius warning showing the count of affected tools, integration nodes, MCP/A2A servers, and active sessions. Mid-session invalidation propagates revocation through pod-local cache TTL (5 min) by default, with an explicit force-invalidate broadcast endpoint as P2.

---

## 2. Scope

### Goals

- Centralize credential storage and lifecycle management behind a consistent, encrypted profile model
- Support 17 heterogeneous auth mechanisms via Zod discriminated unions without forcing each consumer to implement its own credential resolution
- Enforce tenant, project, and owner visibility rules so personal and shared credentials stay isolated correctly
- Allow gradual consumer migration through dual-read behavior instead of an all-at-once cutover
- Provide OAuth2 lifecycle management including app registration, authorization (PKCE), token exchange, refresh with distributed Redis locks, and client credentials grant
- Enable key rotation with grace period fallback and batch re-encryption jobs
- **(ABLP-913)** Make profile typing explicit (`profileType: 'integration' \| 'custom'`) so vendor-aware vs generic profiles drive different defaults and a vendor-grouped Integrations Tab experience
- **(2026-05-09 meeting)** Treat all credentials as encrypted auth profiles — no inline-Add at tool level, no plaintext credentials anywhere
- **(2026-05-09 meeting)** Surface integration catalog as informational vendor list including vendors with no profiles yet, with "Configure" CTA soft-linking to a vendor-pre-filtered Auth Profiles page
- **(2026-05-09 meeting)** Make revocation immediately effective on active sessions via Redis pub/sub broadcast (force-invalidate as P0)
- **(2026-05-09 meeting)** Preflight failures degrade to JIT (do not block the conversation)
- **(2026-05-09 meeting)** Map known OAuth error codes (redirect_uri_mismatch, invalid_client, etc.) to actionable admin-visible error messages
- **(ABLP-913)** Provide a profile-level Authorize CTA for Preconfigured OAuth profiles, with a "To be Authorized" state surfaced both on the profile and at every assignment (tool, integration node, MCP, A2A) so admins know readiness without navigating away
- **(ABLP-913)** Resolve all required credentials at session start (upfront scan), not lazily at tool-call time, so credential failures surface before execution begins
- **(ABLP-913)** Replace the flat "Auth Profile Reference" text input at tool/integration-node level with a type-aware stepped flow — simple types support inline-add (encrypted, tool-scoped); complex types require a saved profile
- **(ABLP-913)** Persist per-user JIT/Preflight authorization at project scope so end users authorize once per project, not per session
- **(ABLP-913)** Decouple profile updates from token validity. Provide two explicit revoke actions — Revoke Profile (decommission) and Revoke User Tokens (token-only). Show pre-revoke blast-radius. Propagate revocation to active sessions.
- **(ABLP-913)** Surface a per-profile audit log covering authorization, refresh, revocation, and sensitive-field changes
- **(ABLP-913)** Surface clear, actionable errors when OAuth scopes are insufficient (re-auth prompt to end user; detailed required-vs-granted scope info to admin audit)

### Non-Goals (Out of Scope)

- Auth Profiles do not replace first-party end-user login flows (password login, SSO)
- Auth Profiles do not guarantee that every downstream protocol implementation for Phase 3 auth types is fully exercised in Runtime today (schema and dispatch exist; protocol-level E2E testing is partial)
- Auth Profiles do not provide per-tenant rollout controls; auth profiles are always enabled when a consumer is configured with `authProfileId`
- Auth Profiles do not manage internal platform-to-platform authentication (that is handled by `@agent-platform/shared-auth`)
- **(ABLP-913)** Auth Profiles do not maintain a proactive per-tool required-scopes registry. Scope mismatches are detected reactively via provider error responses (`insufficient_scope`, 401/403) and surfaced as a re-auth prompt
- **(ABLP-913)** A standalone, cross-feature `/audit-logs` page is out of scope. Per-profile audit history is surfaced via the slide-over Activity tab; a global audit page is a separate feature
- **(ABLP-913)** A central `connection` collection or "connection layer" is **explicitly not introduced**. The single auth profile carries OAuth app config + usage mode + (for Preconfigured) the stored token. The existing `ConnectorConnection` model is now **deprecated and binding-only** per the 2026-05-09 meeting — full removal is a follow-up ticket and out of scope here, but no new code paths depend on it for credential resolution (FR-33)
- **(ABLP-913)** Removing existing auth-type UI options is out of scope. Phase 3 types remain available but visually de-emphasized in the new type-selector. Removing them would orphan existing profiles
- **(ABLP-913)** Deprecating or removing the legacy `user_token` `usageMode` value is out of scope. It remains as a legacy alias and behaves like `jit` in the session-init scan (see §12 Session Initialization Behavior). Deprecation is a future consideration

---

## 3. User Stories

1. As a project or workspace admin, I want to manage credentials once in Studio so that multiple consumers (connectors, models, MCP servers, channels) can reuse them safely without duplicating secrets.
2. As a runtime execution path, I want to resolve credentials with tenant/project/user isolation so that tools, models, and connectors use the right secrets without leaking access.
3. As a platform operator, I want rotation, revocation, redaction, and health monitoring so that credential drift and expiry are visible and recoverable.
4. As a connector developer, I want a dual-read migration path so that I can adopt Auth Profiles incrementally without breaking existing credential resolution.
5. As an agent builder, I want OAuth2 authorization flows in Studio so that I can set up provider access with PKCE and scopes without manually exchanging tokens.
6. **(ABLP-913)** As an admin, I want to browse profiles in a vendor-grouped **Integrations Tab** so that I can find or create the right profile for a vendor (e.g., Salesforce, Google, GitHub) without scrolling through a flat list.
7. **(ABLP-913)** As an admin, I want to **Authorize** a Preconfigured OAuth profile from the profile itself so that the resulting token is shared across every tool, integration node, MCP, and A2A server that references the profile. I want a clear "To be Authorized" indicator before authorization and "Authorized as user@x" after — with the Authorize CTA always available for re-auth (rotation, expiry, handover).
8. **(ABLP-913)** As an agent builder configuring an HTTP tool or integration node, I want a **type-aware assignment flow**: I pick the auth type first (API Key, Bearer, Basic, Custom Header, OAuth 2.0, Client Credentials, Azure AD, AWS IAM, TLS), then for simple types I either pick a saved profile or add a value inline (stored encrypted on the tool only); for complex types I pick a saved profile or jump to the profile section to create one.
9. **(ABLP-913)** As an end user starting a session, I want **all required authorizations to be resolved upfront** (Preflight prompts before the session, Preconfigured tokens validated/refreshed before any tool call) so that I never hit a credential failure mid-conversation. JIT-mode tools may still prompt me mid-conversation when I first invoke them.
10. **(ABLP-913)** As an end user who has authorized a profile in a project once, I want to **never re-authorize the same profile in the same project across sessions** — the platform should remember my consent until I or the admin explicitly revoke it.
11. **(ABLP-913)** As an admin, before I revoke a profile or revoke its tokens, I want to see the **blast radius** — the count of affected tools, integration nodes, MCP/A2A servers, and active sessions — so I can confirm the change with full awareness.
12. **(ABLP-913)** As an admin, I want **two distinct revoke actions**: "Revoke Profile" decommissions the profile irreversibly; "Revoke User Tokens" invalidates the stored Preconfigured token or all per-user JIT/Preflight tokens while leaving the profile and its assignments intact. Saving config changes never auto-invalidates tokens.
13. **(ABLP-913)** As an admin, I want a per-profile **Activity log** showing who authorized when from where, token refresh events (success and failure), revocation events, and sensitive-field changes — so I can audit and debug auth issues without leaving the profile.
14. **(ABLP-913)** As an end user, when an API call fails because OAuth scopes are insufficient, I want a **clear, actionable re-auth prompt** ("This action needs additional permissions — please re-authorize") rather than an opaque 401/403; admins should see the required vs granted scopes in the audit log.
15. **(ABLP-913)** As an admin, when I delete or revoke a profile, I want every consumer that referenced it to surface a **clear auth error at call time** rather than failing silently or returning generic 500s.

---

## 4. Functional Requirements

> Requirements FR-1 through FR-8 reflect existing, shipped behavior. Requirements FR-9 through FR-33 are introduced or sharpened by ABLP-913. Core implementation and the 2026-05-13 review hardening have landed on this branch; strict E2E execution depth and production soak remain pending. Each requirement is testable; coverage is tracked in [docs/testing/auth-profiles.md](../testing/auth-profiles.md).

### Foundational (existing)

1. **FR-1**: The system must store auth profile secrets encrypted at rest with tenant-scoped key derivation (AES-256-GCM, PBKDF2/HKDF). Verified in `packages/shared/src/encryption/engine.ts` (EncryptionService) and `packages/database/src/models/auth-profile.model.ts` (encryptionPlugin applied to `encryptedSecrets` and `previousEncryptedSecrets`).
2. **FR-2**: The system must support 17 auth-type families and validate each through explicit config/secrets Zod schemas. Verified in `packages/shared/src/validation/auth-profile.schema.ts`, `auth-profile-phase2.schema.ts`, `auth-profile-phase3.schema.ts`.
3. **FR-3**: The system must resolve credentials with scope-aware precedence. The `AuthProfileService` in `packages/shared/src/services/auth-profile.service.ts` implements multi-level resolution (personal > shared > project+env > project fallback > tenant fallback).
4. **FR-4**: The system must support OAuth2 app registration, authorization, callback, refresh, and client-credentials token exchange. Verified in Studio OAuth routes (`apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/`), canonical token refresh in `packages/shared-auth-profile/src/token-refresh-service.ts`, and client credentials in `packages/shared/src/services/auth-profile/client-credentials-service.ts`.
5. **FR-5**: The system must redact secret material from API responses and audit writes. Verified in `packages/shared/src/services/auth-profile/redact.ts` (strips `encryptedSecrets`, `previousEncryptedSecrets`, `encryptionKeyVersion`).
6. **FR-6**: The system must preserve backward compatibility through the dual-read migration path. Verified in `packages/shared/src/services/auth-profile/dual-read.ts` and `packages/shared-auth-profile/src/dual-read.ts`.
7. **FR-7**: The system must return `404` for inaccessible profiles and enforce owner-only semantics for personal profiles. Cross-scope access returns 404 per platform isolation invariants.
8. **FR-8**: The system must expose profile validation, consumer discovery, and rotation/health behavior to Studio and Runtime operators. Studio exposes validate, consumers, and bulk action endpoints. Runtime exposes `AuthProfileAlertEvaluator` (4 alert dimensions) and `checkAuthProfileHealth()`.

### Profile Model & Typing (ABLP-913)

9. **FR-9** (P0): The system must persist a `profileType: 'integration' | 'custom'` discriminator on every auth profile. `integration` profiles MUST carry a `connector` (vendor) value and SHOULD prepopulate known OAuth endpoints/scopes; `custom` profiles MUST NOT require a vendor. Existing profiles MUST be backfilled via migration: `profileType = connector ? 'integration' : 'custom'`.
10. **FR-10** (P0): The system must surface a vendor-grouped **Integrations Tab** that is **informational** (per 2026-05-09 meeting decision: "the 'Integrations' page should display a list of all available integrations, including custom ones, but should not show custom auth profiles"). The tab MUST list every supported integration vendor (catalog entries from `integration-catalog.ts`) **even when no profile exists** for that vendor (`profileCount: 0`). Each card MUST display the vendor's name, profile count, and per-profile authorization state. Each card MUST expose a "Configure" CTA that soft-links to the auth profiles page pre-filtered to that vendor (`?connector=<name>`). Custom-only profiles (`profileType: 'custom'`) MUST NOT appear in the Integrations Tab — they remain selectable from the workflow integration-node and tool-config dropdowns. Multiple profiles per vendor MUST be supported under the same vendor card.
11. **FR-11** (P0): The system must enforce that the `usageMode` field (`preconfigured | jit | preflight | user_token`) on each profile applies to every assignment of that profile. Preconfigured profiles MUST share a single token across all assignments; JIT and Preflight profiles MUST always store tokens per real end user, regardless of `connectionMode`.

### Session Initialization (ABLP-913)

12. **FR-12** (P0): At session start, the system must scan all nodes in the workflow or agent that reference auth profiles and resolve credentials upfront — not lazily at tool-call time. The scan MUST: (a) for **Preconfigured** profiles, fetch and validate (refresh if expired) the stored token before any tool call and surface a clear error if refresh fails; (b) for **JIT** profiles, identify which nodes will require user authorization and prepare the runtime to trigger the prompt at the right moment; (c) for **Preflight** profiles, trigger all required authorizations upfront BUT MUST NOT block the session if the user declines or fails to authorize — failed Preflight authorizations MUST degrade gracefully to JIT behavior so the conversation proceeds and the prompt is re-issued at first tool need (per 2026-05-09 meeting decision: "failure to authorize should not block the conversation, causing it to revert to Just-in-Time behavior").

### Preconfigured Authorization & State (ABLP-913)

13. **FR-13** (P0): The system must expose a profile-level **Authorize** CTA for Preconfigured OAuth profiles that triggers the full OAuth flow (redirect → user approval → token exchange) and stores the resulting token at the profile level. The CTA MUST remain active after a successful authorization (re-auth supported for rotation, expiry, handover). The CTA MUST be available on both the Integrations Tab card and the profile slide-over detail panel.
14. **FR-14** (P1): The system must compute and surface an `isAuthorized` per-user state for OAuth profiles. Preconfigured profiles are authorized when a token is stored on the profile; JIT/Preflight profiles are authorized for a given user when an `EndUserOAuthToken` exists for `{tenantId, projectId, userId, provider}`. The UI MUST surface a **"To be Authorized"** indicator on every profile that is not authorized — both on the profile card and inline at every assignment (tool/integration node config).
15. **FR-15** (P1): Assignment dropdowns at tool/integration-node level MUST display all authorized profiles as selectable and unauthorized OAuth profiles as **disabled** rows with an inline Authorize CTA — never silently hidden.
16. **FR-16** (P0): For Preconfigured OAuth profiles, the **Token Refresh URL** MUST be required at CREATE time (not optional). Existing profiles missing it MAY continue working but MUST trigger a non-blocking warning on the validate endpoint.
17. **FR-17** (P0): Token refresh MUST occur automatically using the stored refresh token, with distributed Redis locks to prevent concurrent refresh across pods. On refresh failure, the system MUST: (a) emit an alert (admin-visible), (b) revert the profile's per-user state to `isAuthorized: false` for affected tokens, (c) mark consumers needing re-auth, (d) NOT silently fail at tool-call time.

### Assignment & UI (ABLP-913)

18. **FR-18** (P0): The system must replace the flat "Auth Profile Reference" text input at HTTP-tool, integration-node, MCP-server, and A2A-server config surfaces with a **type-aware profile-only flow** (per 2026-05-09 meeting decision: "all authentication types, including API key and bearer token, should utilize an authorization profile for security reasons"): (Step 1) select Auth Type from the supported list (API Key, Bearer, Basic, Custom Header, OAuth 2.0 App, Client Credentials, Azure AD, AWS IAM, TLS, plus Phase 2/3 types in de-emphasized categories); (Step 2) show a dropdown of existing profiles of that type **and** a "Create Auth Profile" CTA. Empty state MUST show "No profiles found for this auth type" with the Create CTA inline. The dropdown MUST always render a prominent "Create Auth Profile" nudge alongside saved profiles (not only in the empty state) so users have a clear path to create new profiles. **No inline credential entry is permitted at the tool level — credentials must always be saved as an auth profile so encryption-at-rest is uniform.**
19. **FR-19** (P2): When a user navigates to the Auth Profiles section via the "Create Auth Profile" CTA from a tool config, the section MUST pre-filter to the auth type the user came from.
20. **FR-20** (P0): ~~Inline-Add for simple types stores transient encrypted profile.~~ **REMOVED per 2026-05-09 meeting**: inline-Add is no longer supported. Every credential MUST be a first-class auth profile so the encryption-at-rest contract is uniform across all consumer surfaces. The `inlineHostedTool` field on `auth_profiles` remains in the schema for migration neutrality but the platform MUST NOT create new transient profiles. The Studio "Add value inline" UI option MUST be removed; only "Create Auth Profile" is offered.

### Visibility, Deletion, Revoke (ABLP-913)

21. **FR-21** (P1): Each auth profile card MUST surface a **"Used by"** view showing every consumer that currently references it — HTTP tools, integration nodes, MCP servers, A2A servers, channels, models, connectors, triggers — with the assignment level auth-state inline. The system MUST extend the existing `/consumers` endpoint to include ToolDefinition (HTTP tools) and A2A servers (when the A2AServer model exists).
22. **FR-22** (P0): Profile deletion MUST be guarded — if a profile is currently referenced by any consumer, the system MUST either block deletion outright or require an explicit confirmation modal that lists every affected consumer. Deletion MUST never silently break references.
23. **FR-23** (P0): The system must expose **two distinct revoke actions**:
    - **Revoke Profile** (existing): permanently decommissions the profile, marks status `revoked`, makes all assignments inactive. Irreversible.
    - **Revoke User Tokens** (NEW): invalidates the stored Preconfigured token (clears `encryptedSecrets`) OR all `EndUserOAuthToken` records for the profile (JIT/Preflight). The profile stays `active`; assignments stay intact. Optional `userId` query parameter for per-user revoke.
      Profile config updates MUST NEVER auto-invalidate tokens — the two flows are fully decoupled.
24. **FR-24** (P0): Both revoke actions MUST display a **pre-revoke blast-radius warning** before confirmation: "Revoking … will affect X tools, Y integration nodes, Z MCP/A2A servers. All active sessions using this profile will lose authorization immediately." Admin MUST explicitly confirm.
25. **FR-25** (P2): When sensitive fields (`clientId`, `clientSecret`, `scopes`, `tokenUrl`, `refreshUrl`) change on a Preconfigured profile, the system MUST display an informational nudge AFTER saving: "You've updated fields that may affect the stored token. If the token is no longer valid, use Revoke Tokens to force re-authorization." No automatic action.
26. **FR-26** (P0, promoted from P2 on 2026-05-09): Revocation MUST take **immediate effect** on active runtime sessions (per meeting decision: "Revocation should take effect immediately, meaning ongoing sessions must prompt for reauthorization when they hit the relevant integration node"). Every Revoke Profile, Revoke User Tokens, and force-invalidate call MUST publish to the Redis pub/sub channel `auth-profile:invalidate`. Every runtime pod's `ForceInvalidateSubscriber` MUST evict the matching pod-local cache entry on receipt. Pod-local cache TTL (5 min) remains the safety net for any missed pub/sub message. Tokens from a revoked profile MUST cause an explicit re-auth prompt rather than silent failures.
27. **FR-27** (P1): When a profile is deleted, every consumer that previously referenced it MUST surface a **clear auth error at call time** ("Auth profile X has been deleted; reconfigure this consumer.") — never a generic 500 or silent skip.

### Consent Persistence & Scope Errors (ABLP-913)

28. **FR-28** (P0): JIT/Preflight tokens MUST persist at **project scope** so an end user authorizes once per project across sessions. The `EndUserOAuthToken` model MUST carry `projectId` and the unique index MUST be `{tenantId, projectId, userId, provider}`. Once authorized, the platform MUST NOT re-prompt the same user for the same profile in the same project until the user or an admin explicitly revokes the tokens.
29. **FR-29** (P1): When a downstream API returns an `insufficient_scope` / 401 / 403 indicating OAuth scope mismatch, the system MUST: (a) surface a **generic, sanitized re-auth prompt** to the end user ("This action requires additional permissions. Please re-authorize."); (b) record the **detailed required-vs-granted scope information** in the per-profile audit log for admin diagnosis. User-facing surfaces MUST follow the platform's User-Facing Runtime Error Sanitization rules (CLAUDE.md).

30. **FR-32** (P0, added 2026-05-09): When the OAuth callback or token endpoint returns a recognized OAuth error code (`redirect_uri_mismatch`, `invalid_client`, `invalid_grant`, `access_denied`, `unauthorized_client`, `unsupported_response_type`, `invalid_scope`, `server_error`, `temporarily_unavailable`), the system MUST surface a **structured, actionable error message** to the admin instead of the generic "operation failed" / "authorization failed" text. Examples: `redirect_uri_mismatch` → "Authorization failed: the redirect URI in the OAuth app does not match the platform's callback URL. Update the OAuth app to use {expectedRedirectUri}." `invalid_client` → "Authorization failed: the Client ID or Client Secret is invalid. Update the profile credentials." `access_denied` → "Authorization was denied by the user." Generic provider errors not in this map MUST still emit `authorize_failed` with the raw provider error code captured in the audit payload (per meeting decision: "the team committed to attempting to fix the messaging to be more informative").

31. **FR-33** (P1, added 2026-05-09): The platform MUST treat the legacy `ConnectorConnection` collection as a **deprecated binding-only artifact**. Workflow integration-node, MCP-server, A2A-server, and HTTP-tool consumers MUST NOT depend on `ConnectorConnection` for credential resolution; they MUST resolve credentials directly through `authProfileId` (per meeting decision: "the concept of connections should be removed... Authorization profiles will now be directly assigned in workflows instead of relying on a separate connection entity"). Full removal of the `ConnectorConnection` model is tracked as a follow-up ticket and is OUT OF SCOPE for ABLP-913, but ABLP-913 MUST NOT introduce any new dependency on `ConnectorConnection` and MUST document deprecation in the consumer surfaces.

### Audit Logs (ABLP-913)

30. **FR-30** (P1): The system must record the following events per profile to the audit log: (a) **authorization** events (who, when, from where — profile screen, integration node, tool config); (b) **token refresh** events (success and failure with diagnostic codes); (c) **revocation** events (who triggered, what was affected, scope = profile vs tokens-only); (d) **profile updates**, with sensitive-field changes (clientId, clientSecret, scopes, tokenUrl, refreshUrl) flagged separately. Events MUST be queryable per profile.
31. **FR-31** (P1): The Studio profile slide-over MUST expose an **Activity tab** rendering the per-profile audit log, filtered by `profileId`, with timestamp, actor identity, event type, and structured event payload. Secrets MUST NEVER appear in displayed events.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Profiles can be project-scoped, environment-aware, and imported/exported across project contexts                                                                                                                                                                             |
| Agent lifecycle            | SECONDARY    | Runtime execution and handoff/preflight flows resolve credentials during execution                                                                                                                                                                                           |
| Customer experience        | SECONDARY    | (ABLP-913) End users see JIT/Preflight consent prompts (project-scoped, persisted across sessions per FR-28), session-init readiness errors (FR-12), and sanitized re-auth prompts on insufficient-scope (FR-29). Once authorized in a project, they are not prompted again. |
| Integrations / channels    | PRIMARY      | Connectors, channels, MCP servers, models, and tooling depend on auth profile resolution                                                                                                                                                                                     |
| Observability / tracing    | SECONDARY    | Health probes, alert evaluators, and trace events surface auth-profile lifecycle issues                                                                                                                                                                                      |
| Governance / controls      | PRIMARY      | Scope, owner visibility, redaction, audit, and deletion guards are core governance concerns                                                                                                                                                                                  |
| Enterprise / compliance    | PRIMARY      | Encryption, rotation, mTLS, signing, and advanced auth mechanisms are enterprise-facing                                                                                                                                                                                      |
| Admin / operator workflows | PRIMARY      | Studio pages, pickers, validation, and consumer views are the main operator-facing surfaces                                                                                                                                                                                  |

### Related Feature Integration Matrix

| Related Feature            | Relationship Type | Why It Matters                                                                                                                                                                  | Key Touchpoints                                                         | Current State       |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------- |
| Connectors                 | configured by     | Connector configs and connections resolve external-service credentials through auth profiles                                                                                    | `authProfileId`, dual-read migration, Studio pickers                    | Active integration  |
| MCP Support                | configured by     | MCP server definitions can consume auth profiles rather than embedding secrets directly                                                                                         | Runtime resolver, Studio config flows                                   | Active integration  |
| SDK / Channels             | configured by     | Channel and SDK-adjacent surfaces use auth profiles for backend/provider credentials and dual-read migration                                                                    | channel connections, voice/provider credentials, connector OAuth        | Active integration  |
| SearchAI                   | configured by     | Model configs and embedding credentials resolve via auth profiles                                                                                                               | `apps/search-ai/src/services/auth-profile-resolver.ts`                  | Active integration  |
| Import/Export (project-io) | participates in   | Auth profiles are included in project import/export with name-based resolution and fuzzy matching                                                                               | `packages/project-io/src/import/auth-profile-resolver.ts`               | Active integration  |
| Password Login             | adjacent to       | Handles first-party user auth; Auth Profiles manages service credentials                                                                                                        | shared Studio auth context                                              | Explicitly separate |
| HTTP Tools                 | configured by     | Tool definitions reference auth profiles via the type-aware Auth Assignment UI (FR-18). Inline credential entry is removed; tools store only opaque `authProfileId` references. | ToolDefinition schema, AuthProfileAssignment component                  | Active integration  |
| A2A Server Support         | configured by     | A2A server definitions assign Custom auth profiles. **Note**: A2AServer Mongoose model does not yet exist; consumers query gated on model availability (open question 7).       | A2A config UI, `/consumers` endpoint extension                          | Pending             |
| Model Configuration / LLMs | configured by     | Model configs (LLM and embedding providers) resolve credentials via SearchAI auth-profile resolver and shared resolver in runtime                                               | `apps/search-ai/src/services/auth-profile-resolver.ts`, model config UI | Active integration  |

---

## 6. Design Considerations

- Studio exposes both project-scoped and workspace-scoped management surfaces because credential sharing and ownership differ by scope
- The UI needs reusable picker, status badge, preflight, OAuth dialog, and slide-over patterns because auth profiles are consumed from many other configuration flows
- Consumer counts and lists must respect caller-visible project/user scope rather than showing tenant-wide metadata indiscriminately
- The `CredentialCache` uses an LRU eviction strategy with max 200 entries and 5-minute TTL (see `packages/shared/src/services/auth-profile/credential-cache.ts`)
- Addon mechanisms (signing, webhook verification, proxy, certificate pinning, JWT wrapping) are defined in schema but their runtime exercise varies by phase

---

## 7. Technical Considerations

- The feature is built around encrypted MongoDB-backed profiles, a shared validation layer (`packages/shared/src/validation/auth-profile*.schema.ts`), and auth-profile service modules in `packages/shared/src/services/auth-profile/`
- Runtime uses distributed Redis locks for token refresh (`refresh-lock.ts`, 30s TTL) and rotation work to stay safe in multi-pod deployments
- The feature flag `AUTH_PROFILE_ENABLED` has been fully removed. Auth profiles are always active when a consumer record references an `authProfileId`.
- Runtime and Studio now share both `packages/shared/src/services/auth-profile/` and `packages/shared-auth-profile/src/` helpers during the migration/hardening period; keep the signatures aligned when touching either package.
- The actual unique index strategy uses 2 partial indexes (by projectId null vs not-null), not 4 (no separate personal-visibility partials)

---

## 8. How to Consume

### Studio UI

Auth Profiles are managed through the Studio UI with dedicated pages and components:

- **Project-level Auth Profiles**: `/projects/:projectId/auth-profiles` — lists, creates, edits, and deletes auth profiles scoped to a project. Tabs: `All`, **`Integrations`** (vendor-grouped, ABLP-913 FR-10).
- **Workspace-level Auth Profiles**: `/settings/auth-profiles` — manages tenant-scoped profiles shared across all projects
- **Auth Profile Picker** (existing): Reusable component (`AuthProfilePicker`) for selecting an auth profile when configuring connectors, model configs, and other consumers — kept for backward compatibility (8 callers).
- **Auth Profile Assignment** (NEW, ABLP-913 FR-18): New stepped, type-aware component (`AuthProfileAssignment`) used in HTTP-tool, integration-node, MCP-server, and A2A-server config. Step 1 selects auth type; Step 2 shows a saved-profile dropdown and a "Create Auth Profile" CTA. Inline credential entry is removed for all auth types.
- **OAuth Dialog**: `AuthProfileOAuthDialog` handles the OAuth2 authorization flow (redirects to provider, handles callback). Now wired from the slide-over **Authorize CTA** (FR-13) in addition to integration cards.
- **Preflight Check**: `AuthProfilePreflightCheck` validates auth requirements before agent handoffs
- **Status Badge**: `AuthProfileStatusBadge` displays active/expired/revoked/invalid status with color coding. **"To be Authorized"** is rendered as a separate per-user computed badge (`AuthProfileAuthorizationBadge`, NEW, FR-14) — orthogonal to the lifecycle status.
- **Slide-Over Detail**: `AuthProfileSlideOver` shows full profile details, consumers, and edit/revoke/delete actions. Tabs: `Overview`, `Consumers (Used by)` (FR-21), **`Activity`** (NEW, FR-31), `Settings`.
- **Revoke Modals** (NEW, ABLP-913 FR-23, FR-24): Two distinct confirm modals — `RevokeProfileConfirm` (irreversible; lists affected consumers) and `RevokeUserTokensConfirm` (token-only; lists affected sessions and per-user tokens). Both surface blast-radius counts before confirmation.

Key UI files (all verified to exist):

| File                                                                     | Purpose                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`          | Project-scoped auth profile list and management           |
| `apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx` | Workspace (tenant-scoped) auth profile management         |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`      | Detail slide-over panel for viewing/editing a profile     |
| `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`    | OAuth2 authorization flow dialog                          |
| `apps/studio/src/components/auth-profiles/AuthProfilePicker.tsx`         | Reusable profile selector component                       |
| `apps/studio/src/components/auth-profiles/AuthProfilePreflightCheck.tsx` | Pre-handoff auth requirements validation                  |
| `apps/studio/src/components/auth-profiles/AuthProfileStatusBadge.tsx`    | Status badge component                                    |
| `apps/studio/src/components/auth-profiles/AuthProfileToggle.tsx`         | Toggle for enabling/disabling auth profile usage          |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`         | Metadata for auth types (display names, icons, etc.)      |
| `apps/studio/src/hooks/useAuthProfiles.ts`                               | React hook for auth profile data fetching                 |
| `apps/studio/src/api/auth-profiles.ts`                                   | Typed API client functions for all auth profile endpoints |

### Surface Semantics Matrix

Auth profiles are referenced as **opaque IDs** by every consumer surface. Credentials are never embedded into consumer documents. Runtime materialization decrypts on demand and caches with TTL.

| Asset / Entity Type                      | Source of Truth / Ownership                                                               | Design-Time Surface(s)                                                                                                                        | Editable or Read-Only?                                       | Consumer Reference / Binding Model                                                                         | Runtime Materialization / Resolution                                                                                                                                   | Notes / Unsupported State                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth Profile (project-scoped)            | `auth_profiles` collection, owned by `{tenantId, projectId}`                              | Studio: `/projects/:projectId/auth-profiles` (with All / Integrations tabs), `AuthProfileSlideOver`, `AuthProfileAssignment` dropdown         | Editable by project members with `auth_profile:write`        | Consumers reference `authProfileId: string` only — never embed config or secrets                           | `AuthProfileService.resolve()` reads, decrypts via `EncryptionService`, caches in pod-local LRU (200 entries, 5 min TTL)                                               | Cross-project access returns 404. Personal-visibility profiles only listed to owner.                                                                   |
| Auth Profile (tenant-scoped / workspace) | `auth_profiles` collection, `projectId: null`                                             | Studio: `/settings/auth-profiles`                                                                                                             | Editable by workspace admins                                 | Same `authProfileId` reference — visible to all projects in the tenant                                     | Falls back from project-level resolution when no project-scoped profile matches by name                                                                                | Cross-tenant access returns 404.                                                                                                                       |
| Inline-Add Tool-Scoped Profile           | Legacy schema compatibility only (`inlineHostedTool` may exist on old rows)               | No new inline credential UI is exposed (FR-20 removed per 2026-05-09 decision)                                                                | Read-only legacy metadata                                    | New tool configs hold saved-profile `authProfileId` references only                                        | Existing legacy rows resolve through the same encrypted profile path while present                                                                                     | Platform MUST NOT create new transient profiles. Cleanup/promotion is a follow-up only if legacy rows are discovered.                                  |
| EndUserOAuthToken (per-user OAuth grant) | `end_user_oauth_tokens` collection, owned by `{tenantId, projectId, userId}` (post-FR-28) | Not directly editable by users — created via OAuth callback flow; revoked via Revoke User Tokens action; visible per-profile via Activity tab | Read-only via Studio; revoke only                            | Implicit binding: looked up by `{tenantId, projectId, userId, provider}` post-migration                    | Resolved at JIT/Preflight prompts and at every tool-call needing per-user OAuth credentials. Refreshed via `packages/shared-auth-profile/src/token-refresh-service.ts` | Tokens stored as `userId='__tenant__'` for Preconfigured connection mode share across users in scope. Cross-project token reuse is BLOCKED post-FR-28. |
| Auth Profile Audit Event                 | `auth_profile_audit_events` collection (NEW, FR-30)                                       | Studio: `AuthProfileSlideOver` Activity tab (filtered by profileId)                                                                           | Read-only                                                    | Foreign-keyed by `profileId`                                                                               | Emitted from runtime + Studio at authorize / refresh / revoke / sensitive-field-change / scope-insufficient                                                            | TTL-indexed at 365 days. Long-term retention is the global audit-log responsibility.                                                                   |
| Integration Vendor Catalog               | Static catalog (`auth-type-metadata.ts` + connector registry); no DB model                | Studio: Integrations Tab (vendor-grouped, FR-10). Cards drive the "Create profile for this vendor" flow.                                      | Read-only catalog; the profiles created from it are editable | Vendor identity stored as `connector: string` field on profile; `profileType: 'integration'` discriminator | Runtime resolves vendor-specific OAuth endpoints from the same catalog when initiating a profile-level OAuth flow                                                      | Not a separate data model. Removing or renaming a vendor entry must keep `connector` field stable.                                                     |

### Design-Time vs Runtime Behavior

| Concern                     | Design-Time (Studio)                                                                                                 | Runtime                                                                                                                                                   | Spans Both                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Profile CRUD                | YES — list/create/edit/delete profiles via `/api/projects/:projectId/auth-profiles` and slide-over                   | Read-only resolution; runtime never mutates profile config                                                                                                | Validate endpoint runs at design-time and is also called by session-init scan                                          |
| Authorize CTA + OAuth flow  | YES — Authorize CTA on profile slide-over and Integrations Tab card; UI orchestrates OAuth popup                     | Token exchange happens via Studio API which calls provider; runtime consumes the resulting token                                                          | OAuth callback writes both the profile (Preconfigured) and `EndUserOAuthToken` (Preflight/JIT)                         |
| Type-aware Assignment UI    | YES — `AuthProfileAssignment` component rendered in HTTP-tool, integration-node, MCP-server, A2A-server config forms | N/A — runtime sees only the resulting `authProfileId` reference                                                                                           | Inline credential entry is removed; use saved profiles only.                                                           |
| Used-by view                | YES — slide-over Consumers tab queries `/consumers` endpoint                                                         | N/A                                                                                                                                                       | The endpoint scans both Studio-owned config docs (ConnectorConnection, ChannelConnection) and runtime-owned references |
| Session-init scan           | N/A — the scan is purely a runtime concern                                                                           | YES — `AuthProfileSessionScanner` walks the agent IR, collects `authProfileId` references, validates Preconfigured tokens, prepares JIT/Preflight prompts | Errors surface in both Studio (session preview) and runtime (live sessions)                                            |
| Credential cache            | N/A                                                                                                                  | YES — pod-local LRU cache (200 entries, 5 min TTL); decrypted credential cache in `auth-profile-cache.ts`                                                 | Force-invalidate broadcast endpoint (FR-26) is admin-triggered from Studio and propagates to runtime pods              |
| Token refresh               | N/A                                                                                                                  | YES — canonical `packages/shared-auth-profile/src/token-refresh-service.ts` with Redis distributed lock (30s TTL)                                         | Refresh failure surfaces an alert visible in Studio (alert evaluator) and audit log                                    |
| Revoke Profile              | YES — confirmation modal + endpoint                                                                                  | Cache invalidates within 5 min (TTL) or instantly via force-invalidate; running tool calls return clear auth error                                        | Audit event written from Studio; cache busts at runtime                                                                |
| Revoke User Tokens          | YES — confirmation modal with blast-radius; endpoint deletes from `end_user_oauth_tokens`                            | Active sessions using the revoked tokens prompt for re-auth at next tool call (JIT) or fail with clear error (Preconfigured)                              | Audit event written from Studio; runtime tool-call path detects missing/revoked tokens                                 |
| Audit events                | YES — Activity tab queries `/audit-events`                                                                           | YES — runtime emits events for refresh success/failure, scope-insufficient detection                                                                      | Both surfaces emit into the same `auth_profile_audit_events` collection                                                |
| Insufficient-scope handling | Admin sees detailed required-vs-granted scopes in Activity tab                                                       | Runtime detects 401/403 with `error: 'insufficient_scope'`, emits audit event, surfaces sanitized re-auth prompt to end user                              | The end-user-visible prompt is sanitized; admin-visible audit event is detailed                                        |

### API (Studio)

Studio proxies auth profile operations through Next.js API routes:

**Project-scoped routes** (`apps/studio/src/app/api/projects/[id]/auth-profiles/`):

| Method | Path                                                                                               | Purpose                                                                                                                                                                                                                                                                                                      | Status (ABLP-913)         |
| ------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| GET    | `/api/projects/:projectId/auth-profiles`                                                           | List project-scoped profiles                                                                                                                                                                                                                                                                                 | EXISTING                  |
| POST   | `/api/projects/:projectId/auth-profiles`                                                           | Create a new auth profile                                                                                                                                                                                                                                                                                    | EXISTING                  |
| GET    | `/api/projects/:projectId/auth-profiles/:profileId`                                                | Get single profile detail (secrets redacted)                                                                                                                                                                                                                                                                 | EXISTING                  |
| PUT    | `/api/projects/:projectId/auth-profiles/:profileId`                                                | Update an existing profile                                                                                                                                                                                                                                                                                   | EXISTING                  |
| DELETE | `/api/projects/:projectId/auth-profiles/:profileId`                                                | Delete a profile (consumer-guard enforced)                                                                                                                                                                                                                                                                   | EXISTING                  |
| POST   | `/api/projects/:projectId/auth-profiles/:profileId/revoke`                                         | **Revoke Profile** — decommission, irreversible                                                                                                                                                                                                                                                              | EXISTING                  |
| POST   | `/api/projects/:projectId/auth-profiles/:profileId/revoke-user-tokens`                             | **Revoke User Tokens** — clear stored / per-user OAuth tokens; profile stays active. Optional `?userId=…` for per-user revoke                                                                                                                                                                                | NEW (FR-23)               |
| POST   | `/api/projects/:projectId/auth-profiles/:profileId/force-invalidate`                               | Broadcast to all runtime pods to bust their pod-local cache for this profile (admin-only). Always-on per FR-26 (P0).                                                                                                                                                                                         | NEW P0 (FR-26)            |
| POST   | `/api/projects/:projectId/auth-profiles/:profileId/validate`                                       | Validate profile credentials; warns on missing refreshUrl                                                                                                                                                                                                                                                    | EXISTING (warning is NEW) |
| GET    | `/api/projects/:projectId/auth-profiles/:profileId/consumers`                                      | List entities consuming this profile (extended to include ToolDefinition + A2A)                                                                                                                                                                                                                              | EXISTING (extended FR-21) |
| GET    | `/api/projects/:projectId/auth-profiles/:profileId/revoke-preview?type=profile\|tokens[&userId=…]` | Pre-revoke blast-radius preview — aggregates affected consumers (per type), affected user count, active session count for the requested revoke scope                                                                                                                                                         | NEW (FR-24)               |
| GET    | `/api/projects/:projectId/auth-profiles/:profileId/audit-events`                                   | Query per-profile audit events (Activity tab data source)                                                                                                                                                                                                                                                    | NEW (FR-30, FR-31)        |
| GET    | `/api/projects/:projectId/auth-profiles/integrations`                                              | Vendor-grouped Integrations Tab data. Includes ALL supported vendors from the static integration catalog, even those with `profileCount: 0`. Excludes `profileType: 'custom'`. Each vendor card carries `displayName`, `profileCount`, `profiles[]`, and a `configureHref` deep-link to `?connector=<name>`. | NEW (FR-10)               |
| POST   | `/api/projects/:projectId/auth-profiles/oauth/initiate`                                            | Start OAuth2 authorization flow                                                                                                                                                                                                                                                                              | EXISTING                  |
| POST   | `/api/projects/:projectId/auth-profiles/oauth/user-consent`                                        | Complete per-user consent capture (now writes projectId-scoped EndUserOAuthToken)                                                                                                                                                                                                                            | EXISTING (extended FR-28) |
| POST   | `/api/projects/:projectId/auth-profiles/oauth/callback`                                            | Handle OAuth2 callback with auth code                                                                                                                                                                                                                                                                        | EXISTING                  |

**Workspace-scoped routes** (`apps/studio/src/app/api/auth-profiles/`):

| Method | Path                                      | Purpose                                 |
| ------ | ----------------------------------------- | --------------------------------------- |
| GET    | `/api/auth-profiles`                      | List workspace (tenant-scoped) profiles |
| POST   | `/api/auth-profiles`                      | Create workspace profile                |
| GET    | `/api/auth-profiles/:profileId`           | Get single workspace profile            |
| PUT    | `/api/auth-profiles/:profileId`           | Update workspace profile                |
| DELETE | `/api/auth-profiles/:profileId`           | Delete workspace profile                |
| POST   | `/api/auth-profiles/:profileId/revoke`    | Revoke workspace profile                |
| POST   | `/api/auth-profiles/:profileId/validate`  | Validate workspace profile              |
| GET    | `/api/auth-profiles/:profileId/consumers` | List workspace profile consumers        |

**OAuth callback page**: `apps/studio/src/app/oauth/auth-profile-callback/page.tsx`

### API (Runtime)

Runtime now has a dedicated auth-profile router for shared/workspace-scoped runtime operations and runtime-side lookups:

| Method | Path                               | Purpose                                                              |
| ------ | ---------------------------------- | -------------------------------------------------------------------- |
| POST   | `/api/auth-profiles`               | Create a shared/workspace auth profile from runtime-managed flows    |
| GET    | `/api/auth-profiles/by-name/:name` | Resolve a shared/workspace profile by name with runtime auth applied |
| GET    | `/api/auth-profiles/:id`           | Fetch a single shared/workspace profile                              |
| DELETE | `/api/auth-profiles/:id`           | Delete a shared/workspace profile after consumer checks              |

Supporting runtime surfaces:

- `apps/runtime/src/routes/auth-profiles.ts` -- production router with auth middleware and tenant rate limiting
- `apps/runtime/src/routes/auth-profile-route-utils.ts` -- consumer checks and delete guards
- `apps/runtime/src/services/auth-profile-resolver.ts` -- runtime credential resolution and cache-backed lookup
- `apps/runtime/src/services/auth-profile/auth-profile-cache.ts` -- pod-local LRU cache
- `apps/runtime/src/services/auth-profile/auth-profile-rotation-job.ts` -- batch re-encryption job
- `apps/runtime/src/services/oauth-grant-service.ts` -- durable OAuth grant resolution keyed off linked app profiles
- `apps/runtime/src/routes/platform-admin-health.ts` -- health checks that include auth-profile subsystems

Project-scoped CRUD, bulk actions, validate, revoke, and OAuth consent UX remain Studio-owned control-plane routes.

### Admin Portal

No dedicated admin portal routes exist for auth profiles. Admin management is handled through the Studio workspace-level endpoints.

### Channel / SDK / Voice / A2A / MCP Integration

Auth profiles integrate with channel types through the dual-read pattern:

- **Digital channels**: Connector connections reference `authProfileId` for API credentials
- **Voice channels**: Voice service credentials (STT/TTS providers) can use auth profiles (`apps/runtime/src/services/voice/voice-credential-cache.ts` references auth profiles)
- **SearchAI**: Model configs and embedding credentials resolve via `apps/search-ai/src/services/auth-profile-resolver.ts`
- **MCP**: MCP server definitions can consume auth profiles (`apps/studio/src/components/mcp-servers/McpServerCreateDialog.tsx` references auth profiles)

---

## 9. Data Model

### Collections / Tables

```
Collection: auth_profiles
Fields:
  - _id: string (UUID v7, auto-generated)
  - name: string (required, max 255, trimmed)
  - description: string (optional, max 1000)
  - tenantId: string (required, indexed)
  - projectId: string | null (null for tenant-scoped)
  - scope: 'tenant' | 'project' (required, default 'project')
  - environment: string | null (e.g. 'development', 'staging', 'production')
  - visibility: 'shared' | 'personal' (required, default 'shared')
  - createdBy: string (required, immutable)
  - authType: enum (17 types)
  - profileType: 'integration' | 'custom' (required, default derived from `connector` presence)  # ABLP-913 NEW
  - usageMode: 'preconfigured' | 'jit' | 'preflight' | 'user_token' (required, default per authType)
  - connectionMode: 'shared' | 'per_user' (token storage scope; only meaningful for preconfigured oauth2_app)
  - config: Mixed (auth-type-specific configuration, unencrypted)
  - encryptedSecrets: string (required, encrypted at rest via encryptionPlugin)
  - encryptionKeyVersion: number (required, default 1)
  - linkedAppProfileId: string (optional -- references an oauth2_app profile)
  - connector: string (optional -- e.g. 'google', 'slack', 'salesforce') -- required when profileType='integration'
  - category: string (optional -- e.g. 'llm', 'search', 'communication')
  - tags: string[] (optional)
  - status: 'active' | 'expired' | 'revoked' | 'invalid' (required, default 'active')
  - expiresAt: Date (optional)
  - lastValidatedAt: Date (optional)
  - lastUsedAt: Date (optional)
  - lastAuthorizedAt: Date (optional)  # ABLP-913 NEW -- when the Preconfigured Authorize CTA last completed
  - lastAuthorizedBy: string (optional)  # ABLP-913 NEW -- userId of admin who authorized
  - rotationPolicy: Mixed (optional, deferred to future release)
  - previousEncryptedSecrets: string (optional, encrypted -- holds previous secrets during key rotation)
  - rotationGracePeriodMs: number (optional)
  - groupId: string | null (Phase 2)
  - migrationStatus: 'active' | 'migrating' | 'migrated' (default 'active')
  - signing: Mixed (signing addon config)
  - webhookVerification: Mixed (webhook verification addon config)
  - proxy: Mixed (proxy addon config)
  - certificatePinning: Mixed (Phase 3 addon)
  - jwtWrapping: Mixed (Phase 3 addon)
  - inlineHostedTool: { toolId: string, fieldKey: string } | null  # legacy compatibility only; new inline credentials are rejected
  - _v: number (schema version, default 1)
  - createdAt: Date (auto, timestamps)
  - updatedAt: Date (auto, timestamps)

Plugins:
  - tenantIsolationPlugin -- enforces tenantId on all queries
  - encryptionPlugin -- encrypts/decrypts encryptedSecrets and previousEncryptedSecrets
  - auditTrailPlugin -- tracks create/update/delete events

Query Indexes (10 — adds profileType lookup for ABLP-913):
  - { tenantId: 1, scope: 1 }
  - { tenantId: 1, projectId: 1, scope: 1 }
  - { tenantId: 1, projectId: 1, connector: 1, authType: 1 }
  - { tenantId: 1, projectId: 1, visibility: 1, createdBy: 1 }
  - { tenantId: 1, projectId: 1, connector: 1, visibility: 1, createdBy: 1 }
  - { tenantId: 1, projectId: 1, category: 1 }
  - { tenantId: 1, projectId: 1, profileType: 1, connector: 1 }   # ABLP-913 NEW -- powers Integrations Tab vendor grouping
  - { linkedAppProfileId: 1 }
  - { status: 1, expiresAt: 1, authType: 1 }
  - { groupId: 1 }

Unique Indexes (2 partial):
  - { tenantId: 1, name: 1, environment: 1 } (partial: projectId is null)
  - { tenantId: 1, projectId: 1, name: 1, environment: 1 } (partial: projectId is not null)
```

```
Collection: end_user_oauth_tokens (CURRENT SCHEMA -- pre-ABLP-913)
Source: packages/database/src/models/end-user-oauth-token.model.ts
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required, indexed)
  - userId: string (required) -- '__tenant__' for shared/preconfigured connection mode
  - provider: string (required) -- e.g. 'google', 'slack', 'salesforce'
  - providerUserId: string (required) -- the upstream provider's user ID
  - encryptedAccessToken: string (required, encrypted at rest)
  - encryptedRefreshToken: string | null (encrypted at rest)
  - scope: string (required) -- space-delimited per OAuth2 spec
  - expiresAt: Date | null
  - refreshedAt: Date | null
  - consentedAt: Date (required)
  - revokedAt: Date | null
  - lastUsedAt: Date | null
  - _v: number (default 1)
  - createdAt: Date (auto, timestamps)
  - updatedAt: Date (auto, timestamps)

Plugins:
  - tenantIsolationPlugin
  - encryptionPlugin (fields: encryptedAccessToken, encryptedRefreshToken; scope: 'tenant')

Indexes (CURRENT):
  - { tenantId: 1, userId: 1, provider: 1 } (unique)
  - { tenantId: 1 }

# ─── ABLP-913 Planned Changes ──────────────────────────────────────────

New fields (PLANNED — added by FR-28):
  - projectId: string (required, indexed) -- enables project-scoped consent persistence
  - profileId: string (required, FK to auth_profiles, indexed) -- enables per-profile bulk revoke (FR-23)

Index migration (PLANNED):
  - DROP existing unique index { tenantId, userId, provider }
  - CREATE new unique index { tenantId, projectId, userId, provider }
  - CREATE new query index { tenantId, profileId, userId } (powers Revoke User Tokens)

Backfill strategy (see Open Question 6):
  - When a token row's source profile has projectId: use profile.projectId.
  - When source is tenant-scoped (profile.projectId === null): leave projectId null and emit a non-blocking deprecation
    warning at next refresh; admin can re-authorize to upgrade.
  - profileId backfill: derive from existing oauth-grant-service lookup logic (linked-app-aware) where possible;
    rows that cannot be deterministically mapped are left null and force re-auth at next use (matches the current
    "tenant-scoped fallback" semantics).
```

```
Collection: auth_profile_audit_events (NEW for ABLP-913)
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string | null (indexed)
  - profileId: string (required, FK to auth_profiles, indexed)
  - eventType: 'authorized' | 'authorize_failed' | 'token_refreshed' | 'token_refresh_failed'
              | 'profile_revoked' | 'tokens_revoked' | 'profile_updated' | 'sensitive_field_changed'
              | 'profile_deleted' | 'scope_insufficient_detected'
  - actorUserId: string (who triggered)
  - actorContext: { source: 'profile' | 'integration_node' | 'tool_config' | 'session_init' | 'system',
                    requestId?: string, sessionId?: string }
  - eventPayload: Mixed (event-specific structured data — required vs granted scopes for scope events,
                          changed-field names for update events, affected-consumer counts for revoke events)
  - createdAt: Date (TTL-indexed at 365 days)

Indexes:
  - { tenantId: 1, projectId: 1, profileId: 1, createdAt: -1 }   # primary query (Activity tab)
  - { tenantId: 1, eventType: 1, createdAt: -1 }                  # cross-profile event queries
  - { createdAt: 1 } (TTL: 365 days)
```

### Key Relationships

- **oauth2_token -> oauth2_app**: Token profiles reference an app profile via `linkedAppProfileId`. The app profile provides `clientId`, `clientSecret`, `tokenUrl` for token refresh. Deleting an oauth2_app is blocked if active consumers exist.
- **Consumers -> auth_profiles**: Connector configs, connector connections, model configs, MCP servers, and channel connections reference auth profiles via `authProfileId` fields.
- **auth_profiles -> tenants**: Every profile is scoped to a `tenantId`. Tenant-level profiles (`projectId: null`) are accessible by all projects within the tenant.
- **auth_profiles -> projects**: Project-scoped profiles are only accessible within their owning project.

### OAuth Token Storage & Usage Modes

Auth profiles support four usage modes for `oauth2_app` profiles. The usage mode determines **when** and **how** OAuth tokens are obtained and stored.

#### Visibility vs Connection Mode

These are **independent** fields on an auth profile:

| Field            | Controls                                               | Values                 |
| ---------------- | ------------------------------------------------------ | ---------------------- |
| `visibility`     | Who can see/access the profile in the UI and API       | `shared` \| `personal` |
| `connectionMode` | How OAuth tokens are stored — tenant-level or per-user | `shared` \| `per_user` |

- **`visibility: 'shared'`** — all project members can see the profile
- **`visibility: 'personal'`** — only the creator can see it
- **`connectionMode: 'shared'`** — OAuth tokens stored as `__tenant__` (one token for all users)
- **`connectionMode: 'per_user'`** — OAuth tokens stored under the real user's ID

#### Usage Modes

| Mode                       | Timing                       | Who Authorizes                      | Token Storage                                                                             |
| -------------------------- | ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `preconfigured` (shared)   | Admin setup time             | Admin                               | `EndUserOAuthToken` with `userId = '__tenant__'` — one token shared across all executions |
| `preconfigured` (per_user) | Admin setup time             | Admin (for themselves)              | `EndUserOAuthToken` with `userId = admin's real ID` — only that admin's executions use it |
| `preflight`                | Before session starts        | End user (upfront consent)          | `EndUserOAuthToken` with `userId = real user ID` — always per-user                        |
| `jit`                      | During execution (on demand) | End user (mid-conversation consent) | `EndUserOAuthToken` with `userId = real user ID` — always per-user                        |

#### Key Design Principle

**Preflight and JIT are identical in token storage — both always store as the real end user.** The only difference is timing:

- **Preflight**: Consent happens upfront before the agent runs. The user sees "Authorize Gmail" before the session starts.
- **JIT**: Consent happens mid-execution when a tool actually needs credentials. The agent pauses, the user authorizes, and the agent resumes.

The `connectionMode` field on the auth profile controls credential storage scope only for `preconfigured` mode. For JIT and preflight, token storage is always per-user regardless of the profile's `connectionMode` setting.

#### Token Collections

| Collection                                         | Purpose                                                                                    | Lifetime                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------- |
| `end_user_oauth_tokens` (`EndUserOAuthToken`)      | Primary store for all modern OAuth grants — preconfigured, preflight, and JIT              | Durable until revoked               |
| `session_oauth_artifacts` (`SessionOAuthArtifact`) | Session-scoped ephemeral tokens for anonymous SDK sessions without a durable user identity | TTL-indexed, deleted on session end |
| `auth_profiles` (`oauth2_token` type)              | Legacy path — tokens stored inline in `encryptedSecrets`. New flows do not write here.     | Durable until deleted               |

`SessionOAuthArtifact` is only used when the runtime session has no authenticated user identity (anonymous SDK sessions). It is not tied to any usage mode — it is a runtime fallback for sessions that cannot persist tokens under a real user ID.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                           | Purpose                                                                                                    | Verified |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| `packages/shared/src/services/auth-profile.service.ts`         | `AuthProfileService` -- CRUD, multi-level resolve, token refresh with distributed lock                     | YES      |
| `packages/shared/src/validation/auth-profile.schema.ts`        | Zod schemas -- `CreateAuthProfileSchema` (discriminated union on authType), per-type config/secrets maps   | YES      |
| `packages/shared/src/validation/auth-profile-phase2.schema.ts` | Phase 2 Zod schemas: basic, custom_header, aws_iam, azure_ad, mtls, ssh_key                                | YES      |
| `packages/shared/src/validation/auth-profile-phase3.schema.ts` | Phase 3 Zod schemas: digest, kerberos, saml, hawk, ws_security                                             | YES      |
| `packages/shared/src/validation/auth-profile-addons.schema.ts` | Addon schemas (signing, webhook verification, proxy, cert pinning, JWT wrapping)                           | YES      |
| `packages/shared/src/errors/auth-profile-errors.ts`            | Re-export of `AuthProfileError` and `AuthProfileErrorCode`                                                 | YES      |
| `packages/database/src/models/auth-profile.model.ts`           | Mongoose model with 17 auth types, 11 indexes, encryption/tenant-isolation/audit plugins                   | YES      |
| `packages/shared-auth-profile/src/legacy-auth-profile.ts`      | Canonical helper for read-only legacy `oauth2_token` migration state                                       | YES      |
| `packages/shared-auth-profile/src/token-refresh-service.ts`    | Canonical OAuth2 token refresh implementation with Redis locking and audit/authorization state propagation | YES      |

### Auth Profile Service Modules (`packages/shared/src/services/auth-profile/`)

| File                                             | Purpose                                                                                                                                                               | Verified |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `packages/shared-auth-profile/src/apply-auth.ts` | `applyAuth()` -- dispatches resolved credentials to HTTP request headers/query/TLS based on auth type; `withPrefix()` helper ensures prefix+value are space-separated | YES      |
| `apply-signing.ts`                               | `applySigning()` -- HMAC/RSA request signing addon                                                                                                                    | YES      |
| `apply-proxy.ts`                                 | `applyProxy()` -- proxy routing addon with basic/bearer auth                                                                                                          | YES      |
| `client-credentials-service.ts`                  | `resolveClientCredentialsToken()` -- client_credentials grant with Redis-cached tokens                                                                                | YES      |
| `credential-cache.ts`                            | `CredentialCache` -- generic LRU cache (200 entries, 5min TTL)                                                                                                        | YES      |
| `dual-read.ts`                                   | `dualReadCredentials()` -- dual-read pattern: auth profile vs legacy fallback                                                                                         | YES      |
| `grace-period.ts`                                | `resolveWithGracePeriod()` -- falls back to `previousEncryptedSecrets` during key rotation                                                                            | YES      |
| `linked-app-validator.ts`                        | `validateLinkedAppProfile()` -- validates linkedAppProfileId references                                                                                               | YES      |
| `oauth2-app-resolver.ts`                         | `resolveOAuth2AppCredentials()` -- resolves parent oauth2_app profile for token refresh                                                                               | YES      |
| `redact.ts`                                      | `redactAuthProfile()`, `redactAuthProfileList()` -- strips secret fields from API responses                                                                           | YES      |
| `refresh-lock.ts`                                | `acquireRefreshLock()` -- distributed Redis lock (SET NX PX, 30s TTL)                                                                                                 | YES      |
| `trace-events.ts`                                | `emitAuthProfileTraceEvent()` + `AUTH_PROFILE_TRACE_EVENTS` constants                                                                                                 | YES      |
| `update-validator.ts`                            | `validateAuthProfileUpdate()` -- prevents authType mutation, re-validates linked app on change                                                                        | YES      |
| `verify-webhook.ts`                              | `verifyWebhook()` -- HMAC webhook signature verification with replay protection                                                                                       | YES      |
| `audit-event-emitter.ts`                         | `emitAuthProfileAuditEvent()` -- structured audit event writes to `auth_profile_audit_events`                                                                         | YES      |
| `blast-radius-aggregator.ts`                     | `aggregateBlastRadius()` -- counts affected tools, nodes, MCP/A2A, sessions for revoke previews                                                                       | YES      |
| `force-invalidate-publisher.ts`                  | `publishForceInvalidate()` -- Redis pub/sub `auth-profile:invalidate` broadcast to runtime pods                                                                       | YES      |
| `inline-host-cleanup.ts`                         | `cleanupInlineHostedProfiles()` -- cascade-delete tool-scoped profiles on tool delete                                                                                 | YES      |
| `integration-catalog.ts`                         | `getIntegrationCatalog()` -- static vendor registry for Integrations Tab grouping                                                                                     | YES      |
| `oauth-error-map.ts`                             | `mapOAuthError()` -- maps provider error codes to actionable admin-visible messages                                                                                   | YES      |
| `scope-insufficient-detector.ts`                 | `detectInsufficientScope()` -- parses 401/403 responses for scope mismatch, emits audit event                                                                         | YES      |

> Note: OAuth token refresh is canonical in `@agent-platform/shared-auth-profile`. The older local duplicate under `packages/shared/src/services/auth-profile/token-refresh-service.ts` was removed during the 2026-05-13 hardening sync.

### Runtime Integration

| File                                                                    | Purpose                                                                                                                                                                                         | Verified |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `apps/runtime/src/services/auth-profile-resolver.ts`                    | `resolveAuthProfileCredentials()` -- runtime credential resolution                                                                                                                              | YES      |
| `apps/runtime/src/routes/auth-profiles.ts`                              | Dedicated runtime auth-profile router with create / get / by-name / delete                                                                                                                      | YES      |
| `apps/runtime/src/routes/auth-profile-route-utils.ts`                   | Runtime-side consumer discovery and delete safety helpers                                                                                                                                       | YES      |
| `apps/runtime/src/services/auth-profile/auth-profile-cache.ts`          | `AuthProfileCache` -- pod-local LRU cache                                                                                                                                                       | YES      |
| `apps/runtime/src/services/auth-profile/auth-profile-rotation-job.ts`   | `AuthProfileRotationJob` -- batch re-encryption job with distributed locks                                                                                                                      | YES      |
| `apps/runtime/src/services/oauth-grant-service.ts`                      | Durable OAuth grant lookup and linked-app metadata resolution                                                                                                                                   | YES      |
| `apps/runtime/src/services/execution/auth-profile-delegate.ts`          | `buildDelegateAuthContext()` -- propagates user identity through delegation chains                                                                                                              | YES      |
| `apps/runtime/src/services/execution/auth-profile-fanout.ts`            | `buildFanOutAuthContexts()` -- creates independent auth contexts per fan-out branch                                                                                                             | YES      |
| `apps/runtime/src/services/execution/auth-profile-handoff.ts`           | `validateHandoffAuthRequirements()` -- validates target agent's auth requirements before handoff                                                                                                | YES      |
| `apps/runtime/src/health/auth-profile-health.ts`                        | `checkAuthProfileHealth()` -- probes MongoDB, decryption, and Redis lock subsystems                                                                                                             | YES      |
| `apps/runtime/src/health/auth-profile-alerting.ts`                      | `AuthProfileAlertEvaluator` -- monitors refresh failures, decryption failures, expiry warnings, error rates                                                                                     | YES      |
| `apps/runtime/src/services/credential-age-monitor.ts`                   | Credential age monitoring                                                                                                                                                                       | YES      |
| `apps/runtime/src/services/auth-profile/session-scanner.ts`             | `AuthProfileSessionScanner` -- walks agent IR, resolves all auth refs at session start (FR-12)                                                                                                  | YES      |
| `apps/runtime/src/services/auth-profile/force-invalidate-subscriber.ts` | Redis pub/sub subscriber for `auth-profile:invalidate` — evicts pod-local cache on revoke (FR-26)                                                                                               | YES      |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`           | `resolveToolAuth()` -- runtime per-tool credential resolution with scope detection                                                                                                              | YES      |
| `packages/shared/src/tools/resolve-tool-implementations.ts`             | `resolveToolImplementations()` / `toToolDefinition()` -- propagates `auth_profile_ref` and related fields from project tool DSL into compiled `ToolDefinitionLocal` for the compiler (ABLP-655) | YES      |
| `packages/shared-kernel/src/utils/http-auth-config-normalizer.ts`       | `normalizeHttpAuthConfig()` -- normalizes tool form auth config for serialization; omits inline secrets when an auth profile ref is set                                                         | YES      |
| `packages/project-io/src/module-release/module-publish-safety.ts`       | `validatePublishSafety()` / `validateHttpToolAuth()` -- publish-safety validator; `AUTH_TYPE_KEYWORDS` guards auth type names from being flagged as literal secrets                             | YES      |
| `apps/runtime/src/services/auth-profile/scope-insufficient-detector.ts` | Runtime-side scope-insufficient detection from 401/403 responses                                                                                                                                | YES      |

### Cross-Service Resolvers

| File                                                      | Purpose                                              | Verified |
| --------------------------------------------------------- | ---------------------------------------------------- | -------- |
| `apps/search-ai/src/services/auth-profile-resolver.ts`    | SearchAI credential resolution with dual-read        | YES      |
| `packages/project-io/src/import/auth-profile-resolver.ts` | Import/export profile resolution with fuzzy matching | YES      |
| `packages/project-io/src/import/auth-mapping.ts`          | Auth profile mapping for import operations           | YES      |

### Connectors Integration (ABLP-913)

| File                                                  | Purpose                                                                                         | Verified |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------- |
| `packages/connectors/src/auth/connection-resolver.ts` | `ConnectionResolver` -- synthesizes connection from AuthProfile when ConnectorConnection absent | YES      |
| `packages/connectors/src/auth/index.ts`               | Re-exports `ConnectionResolver`, `AuthProfileLookupModel` types                                 | YES      |

### Encryption Layer

| File                                          | Purpose                                                                                                    | Verified |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| `packages/shared/src/encryption/engine.ts`    | `EncryptionService` -- AES-256-GCM with tenant-scoped key derivation, fallback decryption for key rotation | YES      |
| `packages/shared/src/encryption/constants.ts` | Algorithm constants: AES-256-GCM, 12-byte IV, PBKDF2 100K iterations, HKDF SHA-256                         | YES      |
| `packages/shared/src/encryption/types.ts`     | `EncryptionServiceConfig`, `PreviousKeyConfig`, `KeyDerivation` interface                                  | YES      |

### UI Components (Studio)

| File                                                                         | Purpose                                                                       | Verified |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------- |
| `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`              | Project-scoped profile list with filtering, bulk actions, delete/revoke       | YES      |
| `apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx`     | Workspace (tenant-scoped) profile management                                  | YES      |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`          | Detail panel with edit, consumers list, revoke/delete actions                 | YES      |
| `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`        | OAuth2 authorization flow UI                                                  | YES      |
| `apps/studio/src/components/auth-profiles/AuthProfilePicker.tsx`             | Profile selector for use in connector/model config forms                      | YES      |
| `apps/studio/src/components/auth-profiles/AuthProfilePreflightCheck.tsx`     | Pre-handoff auth requirement validation UI                                    | YES      |
| `apps/studio/src/components/auth-profiles/AuthProfileStatusBadge.tsx`        | Status indicator badge                                                        | YES      |
| `apps/studio/src/components/auth-profiles/AuthProfileToggle.tsx`             | Toggle switch for enabling auth profile usage                                 | YES      |
| `apps/studio/src/components/auth-profiles/AuthProfileAssignment.tsx`         | Type-aware stepped auth assignment flow (FR-18) — replaces flat picker        | YES      |
| `apps/studio/src/components/auth-profiles/AuthProfileAuthorizationBadge.tsx` | Per-user `isAuthorized` / "To be Authorized" badge (FR-14)                    | YES      |
| `apps/studio/src/components/auth-profiles/RevokeProfileConfirm.tsx`          | Revoke Profile confirmation modal with blast-radius (FR-24)                   | YES      |
| `apps/studio/src/components/auth-profiles/RevokeUserTokensConfirm.tsx`       | Revoke User Tokens confirmation modal with blast-radius (FR-23, FR-24)        | YES      |
| `apps/studio/src/components/auth-profiles/SensitiveFieldChangeAdvisory.tsx`  | Post-save advisory for sensitive field changes (FR-25)                        | YES      |
| `apps/studio/src/components/auth-profiles/ActivityTabPanel.tsx`              | Per-profile audit log Activity tab content (FR-31)                            | YES      |
| `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx`            | Integrations Tab with vendor-grouped cards (FR-10)                            | YES      |
| `apps/studio/src/components/auth-profiles/IntegrationCard.tsx`               | Individual vendor card in Integrations Tab                                    | YES      |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`             | Auth type display names, icons, and metadata                                  | YES      |
| `apps/studio/src/components/connections/ConnectionsPage.tsx`                 | Informational Integrations page (deprecated connections; vendor catalog)      | YES      |
| `apps/studio/src/components/connections/CatalogCard.tsx`                     | Vendor catalog card with auth-profile count and auth state                    | YES      |
| `apps/studio/src/hooks/useAuthProfiles.ts`                                   | React hook for auth profile data fetching                                     | YES      |
| `apps/studio/src/api/auth-profiles.ts`                                       | Typed API client functions for all auth profile endpoints                     | YES      |
| `apps/studio/src/app/api/auth-profiles/_auth-profile-route-utils.ts`         | Shared runtime-facing route utilities for workspace/admin auth-profile routes | YES      |
| `apps/studio/src/app/api/auth-profiles/_bulk-handler.ts`                     | Shared bulk revoke / activate / delete helpers                                | YES      |

### Representative Tests (Verified to Exist; inventory refreshed on 2026-05-13)

| File                                                                               | Type        | Purpose                                             |
| ---------------------------------------------------------------------------------- | ----------- | --------------------------------------------------- |
| `packages/database/src/__tests__/auth-profile/auth-profile-model.test.ts`          | unit        | Mongoose model schema validation                    |
| `packages/database/src/__tests__/auth-profile/auth-profile-indexes.test.ts`        | unit        | Index definitions and uniqueness constraints        |
| `packages/database/src/__tests__/auth-profile/auth-profile-integration.test.ts`    | integration | CRUD operations with actual model                   |
| `packages/database/src/__tests__/auth-profile-factory.test.ts`                     | unit        | Test factory for creating auth profile fixtures     |
| `packages/database/src/__tests__/auth-profile-audit-events.test.ts`                | unit        | Audit trail plugin integration                      |
| `packages/database/src/__tests__/helpers/auth-profile-factory.ts`                  | helper      | Factory function for test fixtures                  |
| `packages/shared/src/__tests__/auth-profile/auth-profile-schema.test.ts`           | unit        | Zod validation schema tests                         |
| `packages/shared/src/__tests__/auth-profile/auth-profile-errors.test.ts`           | unit        | Error class and error codes                         |
| `packages/shared/src/__tests__/auth-profile/auth-profile-service.test.ts`          | unit        | AuthProfileService CRUD and resolve logic           |
| `packages/shared/src/__tests__/auth-profile/apply-auth.test.ts`                    | unit        | Auth dispatcher coverage across auth types          |
| `packages/shared/src/__tests__/auth-profile/dual-read.test.ts`                     | unit        | Dual-read migration behavior and error propagation  |
| `packages/shared/src/__tests__/auth-profile/secret-redaction.test.ts`              | unit        | Secret redaction and response safety                |
| `packages/shared/src/__tests__/auth-profile/consumer-dual-read.test.ts`            | unit        | Consumer-facing dual-read semantics                 |
| `packages/shared-auth-profile/src/__tests__/legacy-auth-profile.test.ts`           | unit        | Legacy `oauth2_token` migration-state helpers       |
| `packages/shared-auth-profile/src/__tests__/token-refresh-service.test.ts`         | unit        | Shared auth-profile token refresh paths             |
| `packages/project-io/src/__tests__/auth-profile-mapping.test.ts`                   | unit        | Import/export profile resolution and fuzzy matching |
| `apps/runtime/src/__tests__/auth/auth-profile-cache.test.ts`                       | unit        | LRU cache behavior, TTL eviction                    |
| `apps/runtime/src/__tests__/auth/auth-profile-rotation.test.ts`                    | unit        | Rotation job batch processing and locking           |
| `apps/runtime/src/__tests__/auth/auth-profile-resolve-by-name.test.ts`             | unit        | Runtime by-name lookup and scope handling           |
| `apps/runtime/src/__tests__/auth/auth-profile-resolver-grace-period.test.ts`       | unit        | Grace-period fallback behavior                      |
| `apps/runtime/src/__tests__/auth/oauth-grant-service.test.ts`                      | unit        | Durable OAuth grant metadata and linked-app lookup  |
| `apps/runtime/src/__tests__/integration/auth-profile-route-validation.test.ts`     | integration | Runtime router validation and usage-mode checks     |
| `apps/runtime/src/__tests__/integration/auth-profile-connector-setup.test.ts`      | integration | Connector setup via auth profiles                   |
| `apps/runtime/src/__tests__/integration/auth-profile-oauth-flow.test.ts`           | integration | OAuth2 authorization and callback path              |
| `apps/runtime/src/__tests__/integration/auth-profile-token-refresh.test.ts`        | integration | Token refresh with distributed locking              |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-api.test.ts`      | unit        | Studio CRUD visibility and isolation                |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-security.test.ts` | unit        | Route authorization and security checks             |
| `apps/studio/src/__tests__/auth-profile-oauth-initiate-route.test.ts`              | unit        | OAuth initiate route behavior                       |
| `apps/studio/src/__tests__/auth-profile-oauth-callback-route.test.ts`              | unit        | OAuth callback completion                           |
| `apps/studio/src/__tests__/auth-profile-consumers-routes.test.ts`                  | unit        | Consumer discovery routes                           |
| `apps/studio/src/__tests__/workspace-auth-profile-list-route.test.ts`              | unit        | Workspace list aggregation                          |

---

## 11. Configuration

### Environment Variables

| Variable                       | Default    | Description                                                                                                             |
| ------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `STUDIO_OAUTH_ALLOWED_ORIGINS` | (unset)    | Optional comma-separated OAuth callback origin allowlist used when `NEXT_PUBLIC_APP_URL` is not set.                    |
| `ENCRYPTION_MASTER_KEY`        | (required) | 64-character hex string (256-bit) used as the root master key for all encryption. Generate with `openssl rand -hex 32`. |

### Runtime Configuration

- **Credential Cache**: Pod-local LRU, max 200 entries, 5-minute TTL. Configured via `CredentialCache` constructor in `packages/shared/src/services/auth-profile/credential-cache.ts`.
- **Refresh Lock TTL**: 30 seconds (hardcoded in `refresh-lock.ts`, constant `LOCK_TTL_MS`). Prevents concurrent token refresh across pods.
- **Client Credentials Cache**: Redis-based, TTL = `expires_in - 60s` buffer. Key prefix: `auth-profile:cc-token:{tenantId}:{profileId}`.
- **Rotation Batch Size**: Default 100 profiles per batch (configurable in `RotationJobConfig`).

### DSL / Agent IR

Auth profiles are referenced from the agent DSL via tool-level properties: `auth_profile`, `auth_jit`, `consent`, and `connection`. These compile to `auth_profile_ref`, `jit_auth`, `consent_mode`, and `connection_mode` fields on `ToolDefinition` in the IR. Templated references like `"{{config.GOOGLE_AUTH}}"` are preserved verbatim for runtime name resolution while other config variables resolve at compile time. See ABL_SPEC.md Section 3.5 for full syntax.

---

## 12. Non-Functional Concerns

### Tenant Isolation

| Query Pattern      | Isolation Enforced                    | Mechanism                                     |
| ------------------ | ------------------------------------- | --------------------------------------------- |
| Create profile     | tenantId from auth context            | `tenantIsolationPlugin` auto-injects tenantId |
| Read profile by ID | `findOne({ _id, tenantId })`          | Plugin + explicit query                       |
| List profiles      | `find({ tenantId, projectId })`       | Plugin + route-level filters                  |
| Update profile     | `findOneAndUpdate({ _id, tenantId })` | Plugin + explicit query                       |
| Delete profile     | `findOneAndDelete({ _id, tenantId })` | Plugin + consumer check                       |

### Project Isolation

| Query Pattern        | Isolation Enforced                                  | Mechanism                            |
| -------------------- | --------------------------------------------------- | ------------------------------------ |
| Project-scoped CRUD  | `projectId` in all queries                          | Route-level enforcement              |
| Workspace fallback   | Only for tenant-scoped profiles (`projectId: null`) | Service-level logic                  |
| Cross-project access | Returns 404                                         | Service rejects mismatched projectId |

### User Isolation

| Query Pattern                  | Isolation Enforced                          | Mechanism                      |
| ------------------------------ | ------------------------------------------- | ------------------------------ |
| Personal profiles              | `visibility: 'personal', createdBy: userId` | Service filters by owner       |
| Other users' personal profiles | Hidden as 404                               | Not returned in list or get    |
| Shared profiles                | Visible to all users in scope               | No createdBy filter for shared |

### EndUserOAuthToken Isolation (post-FR-28)

| Query Pattern                         | Isolation Enforced                                                               | Mechanism                                        |
| ------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| Create token                          | `{tenantId, projectId, userId, provider}` (unique)                               | Plugin-injected tenantId + service-set projectId |
| Lookup at session-init                | `findOne({ tenantId, projectId, userId, provider })`                             | Service + plugin                                 |
| Lookup for tool call                  | Same key — never falls back to a different projectId                             | Service + plugin                                 |
| Cross-project token reuse             | **BLOCKED** — returns null even if a same-tenant token exists in another project | Mandatory `projectId` in lookup                  |
| Cross-tenant access                   | Returns null                                                                     | `tenantIsolationPlugin`                          |
| Bulk Revoke User Tokens (per profile) | `deleteMany({ tenantId, profileId })`                                            | Service + plugin                                 |
| Per-user Revoke                       | `deleteMany({ tenantId, profileId, userId })`                                    | Service + plugin                                 |

### Audit Events Isolation

The `auth_profile_audit_events` collection is scoped by `tenantId` and `projectId` (denormalized from the profile at write time). All Activity-tab queries MUST include `{tenantId, projectId, profileId}` in the filter. Cross-project event leakage is prevented at both the plugin layer (tenantIsolationPlugin) and the route layer (explicit `projectId` from `req.params`). TTL: 365 days.

### Security

- **Encryption at rest**: AES-256-GCM with tenant-scoped key derivation (PBKDF2 100K iterations or HKDF SHA-256). Master key stored as env var `ENCRYPTION_MASTER_KEY`.
- **Secret redaction**: `encryptedSecrets`, `previousEncryptedSecrets`, `encryptionKeyVersion` stripped from all API responses via `redactAuthProfile()`.
- **SSRF protection**: OAuth token URLs and client credentials endpoints validated at schema level via `z.string().url()`.
- **Distributed locking**: Redis `SET NX PX` with 30s TTL prevents concurrent token refresh across pods.
- **Audit logging**: `auditTrailPlugin` records all create/update/delete operations.

### Performance

- **Credential cache**: LRU with 200 max entries and 5-minute TTL avoids repeated DB lookups during execution.
- **lastUsedAt debounce**: Updates skipped if lastUsedAt was updated within 5-minute window to reduce DB write pressure.
- **Client credentials caching**: Redis-cached tokens with TTL = `expires_in - 60s` buffer.

### Reliability

- **Grace period fallback**: During key rotation, `resolveWithGracePeriod()` falls back to `previousEncryptedSecrets` if primary decryption fails.
- **Distributed lock resilience**: Lock acquisition failures are logged as warnings, not thrown -- degraded but functional.
- **Dual-read error propagation**: When auth profile is configured, errors propagate (no silent fallback to legacy) to surface credential issues immediately.

### Observability

- **Trace events**: 16+ structured events via `emitAuthProfileTraceEvent()` covering resolution, refresh, OAuth flows, and caching.
- **Health probes**: `checkAuthProfileHealth()` probes MongoDB, decryption, and Redis lock subsystems.
- **Alert evaluator**: 4 dimensions -- token refresh failures, decryption failures, profile expiry warnings, high error rates.

### Data Lifecycle

- **Retention**: No automatic TTL on profiles. Explicit delete or revoke required.
- **Cascade**: Deleting an `oauth2_app` profile is blocked if active `oauth2_token` profiles reference it. Deleting any profile with active consumers is blocked or requires explicit confirmation (FR-22).
- **Import/Export**: Profiles included in project export/import with name-based resolution and fuzzy matching.
- **(ABLP-913) Audit-event retention**: `auth_profile_audit_events` documents are TTL-indexed at 365 days. Long-term retention beyond 365 days is the platform-wide audit-log responsibility, not this collection.
- **(ABLP-913) `EndUserOAuthToken` retention**: Tokens persist until explicit revocation (per-user via "Revoke User Tokens", or via profile revoke/delete cascade). No automatic TTL.
- **(ABLP-913) Inline-Add tool-scoped profiles**: Inline credential creation is removed per FR-20. Any legacy `inlineHostedTool` rows remain encrypted auth profiles and should be cleaned up with their owning tool if encountered.

### (ABLP-913) Session Initialization Behavior

| Profile Mode          | Scan Behavior                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preconfigured`       | Token MUST be fetched and validated before any tool call. If expired, refresh inline. If refresh fails, surface a clear session-init error and refuse to proceed. |
| `jit`                 | Identify which nodes will require user authorization. Prepare runtime to trigger prompt mid-conversation when first tool call hits.                               |
| `preflight`           | Trigger all required authorizations upfront. Block session start until each Preflight prompt completes (or user explicitly skips an optional one).                |
| `user_token` (legacy) | Behave like `jit` — tokens are per-user; lookups happen at first need.                                                                                            |

The scan MUST be project-scoped. Token lookup uses `{tenantId, projectId, userId, provider}` so a user's prior consent in the same project is reused without re-prompting.

### (ABLP-913) Revoke Flow Semantics

| Action                               | Mutates `auth_profiles`?                              | Mutates `EndUserOAuthToken`?                | Active sessions                                                                                           | Reversible?                   |
| ------------------------------------ | ----------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Revoke Profile**                   | YES (`status = 'revoked'`, clears `encryptedSecrets`) | Cascade-deletes all rows for this profile   | All sessions using this profile lose authorization within ≤ 5 min (TTL) or instantly via force-invalidate | NO — permanent decommission   |
| **Revoke User Tokens (per-profile)** | NO                                                    | DELETE all rows for this profile, all users | All affected sessions need re-auth                                                                        | YES — re-auth restores tokens |
| **Revoke User Tokens (per-user)**    | NO                                                    | DELETE rows for `{profileId, userId}`       | Only that user's sessions need re-auth                                                                    | YES — re-auth restores        |
| **Saving config (any field)**        | YES (config update)                                   | NO — fully decoupled                        | No effect (P0 contract)                                                                                   | YES — admin can re-save       |

---

## 13. Delivery Plan / Work Breakdown

### P1: Core Infrastructure (COMPLETE)

1. Auth profile Mongoose model with encryption, tenant isolation, and audit plugins
2. Zod validation schemas for Phase 1 auth types (6 types)
3. `AuthProfileService` -- CRUD, multi-level resolve, token refresh
4. Dual-read migration pattern with auth-profile precedence when `authProfileId` is present
5. Secret redaction for API responses
6. Distributed Redis lock for token refresh

### P2: Studio UI (COMPLETE)

1. Project-scoped and workspace-scoped management pages
2. Auth profile picker, status badge, slide-over detail
3. OAuth2 authorization flow dialog with PKCE
4. Preflight check component
5. API client functions and hooks

### P3: Runtime Integration (COMPLETE)

1. Runtime credential resolver with grace period
2. Pod-local LRU cache
3. Key rotation batch job
4. Execution context propagation (delegate, fanout, handoff)
5. Health probes and alert evaluator

### P4: Phase 2 Auth Types (COMPLETE)

1. Zod schemas for 6 enterprise types (basic through ssh_key)
2. `applyAuth()` dispatch for Phase 2 types
3. Database model updated with Phase 2 enum values

### P5: Phase 3 Auth Types (COMPLETE)

1. Zod schemas for 5 advanced types (digest through ws_security)
2. `applyAuth()` dispatch for Phase 3 types
3. Addon schemas (signing, webhook verification, proxy, cert pinning, JWT wrapping)

### P6: Cross-Service Integration (COMPLETE)

1. SearchAI auth profile resolver
2. Import/export with name-based resolution and fuzzy matching
3. Consumer count/discovery endpoints

### P7: Hardening & Observability (IN PROGRESS)

1. Full E2E test coverage for all auth types
2. Production-grade trace event integration (currently uses structured logging, not full TraceStore)
3. Legacy credential retirement after remaining consumer migrations
4. Bulk action routes with mixed outcomes
5. OAuth callback origin hardening

### P8: ABLP-913 Operator-Facing Behaviors (IN PROGRESS)

> Detailed phased plan, exit criteria, and wiring checklist live in [docs/plans/auth-profiles.lld.md](../plans/auth-profiles.lld.md). The work breakdown below is intentionally aligned with the LLD phases.

1. **Profile model & typing (P0)**
   1.1 Add `profileType: 'integration' | 'custom'` field to model + Zod schema; backfill migration
   1.2 Add `lastAuthorizedAt`, `lastAuthorizedBy`; mark `inlineHostedTool` shape on the model
   1.3 Add new query index `{ tenantId, projectId, profileType, connector }`
2. **Project-scoped consent persistence (P0)**
   2.1 Add `projectId` AND `profileId` fields to `EndUserOAuthToken` model
   2.2 Drop existing unique index `{ tenantId, userId, provider }` and create new unique index `{ tenantId, projectId, userId, provider }`. Add query index `{ tenantId, profileId, userId }` (powers Revoke User Tokens by profile).
   2.3 Backfill migration script: project-scoped tokens use profile.projectId; tenant-scoped tokens left null with deprecation warning at next refresh; profileId derived from oauth-grant-service linked-app lookup where deterministic
   2.4 Update `oauth-grant-service.ts` lookup paths and `EndUserOAuthToken` query helpers to read project-scoped index and emit deprecation warnings on null projectId
3. **Session initialization scan (P0)**
   3.1 Implement `AuthProfileSessionScanner` — walks the agent graph, collects all `authProfileId` references and JIT/Preflight nodes
   3.2 Wire into runtime session bootstrap before first tool dispatch
   3.3 Surface clear failure on Preconfigured token-not-ready
4. **Authorize CTA + To-be-Authorized state (P0/P1)**
   4.1 Add Authorize CTA to `AuthProfileSlideOver` (currently only on integration cards)
   4.2 Compute `isAuthorized` per-user in list/get responses
   4.3 Render `AuthProfileAuthorizationBadge` in profile cards and assignment dropdowns; disabled-row pattern for unauthorized OAuth in dropdowns
   4.4 Required `refreshUrl` on CREATE for `oauth2_app + preconfigured`; warning on existing
5. **Type-aware Auth Assignment UI (P0)**
   5.1 Build `AuthProfileAssignment` component (stepped, type-aware) — coexists with `AuthProfilePicker`
   5.2 Wire into HTTP-tool config, integration-node config, MCP-server config, A2A-server config
   5.3 Inline-Add removed; show saved-profile dropdown plus "Create Auth Profile" CTA only
   5.4 Empty state + Create CTA + auth-type-pre-filter on arrival (P2)
6. **Used-by view & deletion guard (P1)**
   6.1 Extend `/consumers` to include ToolDefinition (HTTP tools) and A2A servers (when model exists)
   6.2 Render Consumers tab on slide-over with per-consumer auth-state inline
   6.3 Render deletion confirmation modal listing affected consumers
7. **Two revoke actions + blast radius (P0)**
   7.1 New endpoint `POST /:profileId/revoke-user-tokens` (with optional `userId` query)
   7.2 `RevokeUserTokensConfirm` modal with blast-radius counts (tools, integration nodes, MCP/A2A, active sessions)
   7.3 Updated `RevokeProfileConfirm` modal with consumer count + active-session count
   7.4 Sensitive-field-change advisory toast (`clientId`, `clientSecret`, `scopes`, `tokenUrl`, `refreshUrl`)
8. **Mid-session invalidation (P1/P2)**
   8.1 Pod-local cache TTL ≤ 5 min as P1 baseline (already implemented)
   8.2 New endpoint `POST /:profileId/force-invalidate` + cross-pod broadcast (HTTP fanout to known runtime pods or Redis pub/sub) as P2
   8.3 Runtime tool-call path emits explicit re-auth prompt when revoked tokens hit
9. **Audit logs (P1)**
   9.1 New `auth_profile_audit_events` collection + indexes
   9.2 Wire emit points: authorize success/failure, refresh success/failure, profile/token revoke, sensitive-field change, scope-insufficient detection
   9.3 New endpoint `GET /:profileId/audit-events` (filtered, paginated)
   9.4 New `Activity` tab in `AuthProfileSlideOver`
10. **Scope-error handling (P1)**
    10.1 New error class extending `AuthProfileError` with code `INSUFFICIENT_SCOPE`
    10.2 OAuth callback path detects scope mismatch (granted vs requested) and emits audit event
    10.3 Tool-execution path detects 401/403 with `insufficient_scope` and surfaces sanitized re-auth prompt to end user
    10.4 Audit log captures detailed required-vs-granted scopes
11. **Migration & rollout (P0)**
    11.1 Mongo migration: backfill `profileType` from `connector`
    11.2 Mongo migration: backfill `EndUserOAuthToken.projectId` from source profile (or per-tenant default project)
    11.3 Re-create unique index on `EndUserOAuthToken` (drop old, create new)
    11.4 Documentation + runbook for the migration; reversibility checklist

---

## 14. Success Metrics

| Metric                                                    | Baseline                               | Target                                                                 | Measurement                                         |
| --------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| Consumer migration coverage                               | 0% consumers using auth profiles       | 80%+ connectors, models, channels migrated to dual-read                | Count of entities with `authProfileId` set vs total |
| Credential resolution latency                             | N/A (new feature)                      | P99 < 50ms for cache hits, P99 < 200ms for cache misses                | Runtime trace events                                |
| Token refresh success rate                                | N/A                                    | 99.5%+                                                                 | Alert evaluator metrics                             |
| Key rotation completion time                              | N/A                                    | < 5 minutes for 1000 profiles                                          | Rotation job metrics                                |
| Test coverage                                             | Unit tests only                        | Unit + integration + E2E for all auth types                            | CI coverage reports                                 |
| **(ABLP-913)** Session-init scan latency                  | N/A                                    | P95 < 250ms for sessions with ≤ 10 auth references                     | Runtime trace `auth_profile.session_init.scan`      |
| **(ABLP-913)** Re-auth prompts per project, per user      | High (per-session)                     | ≤ 1 per profile per project (lifetime, until revoke)                   | Count of OAuth initiate events vs unique users      |
| **(ABLP-913)** Mid-session invalidation propagation       | Indefinite (no propagation)            | ≤ 5 min P95 (TTL-based), ≤ 5 sec P95 (force-invalidate)                | Time between revoke and last cache-hit emission     |
| **(ABLP-913)** Insufficient-scope re-auth conversion rate | N/A                                    | ≥ 70% of `INSUFFICIENT_SCOPE` errors lead to user re-auth within 60s   | Audit events + OAuth callback completion            |
| **(ABLP-913)** Audit-log completeness                     | Partial (auditTrailPlugin writes only) | 100% of authorize / refresh / revoke / sensitive-field events recorded | Spot-check vs expected event matrix                 |

---

## 15. Open Questions

1. **Legacy credential retirement**: When should the remaining legacy credential fields be removed once all consumers have migrated to `authProfileId`?
2. **Legacy token retirement**: When can read-only `oauth2_token` migration records stop being imported/exported and fully give way to linked-app durable grants?
3. **Personal visibility unique indexes**: The model has 2 unique indexes (shared namespace only). Should personal profiles also have per-owner unique name constraints (4 partial indexes total)?
4. **TraceStore integration**: Trace events currently use structured logging (`emitAuthProfileTraceEvent` -> `log.info`). When should these be wired to the full `TraceStore` event pipeline?
5. **(ABLP-913)** **Force-invalidate transport**: P2 calls for cross-pod cache busting on revoke. Two options: (a) Redis pub/sub channel `auth-profile:invalidate` consumed by every runtime pod, (b) HTTP fanout to known runtime pods via service-discovery. (a) is more reliable and matches existing Redis usage; (b) avoids a new pub/sub dependency. **Default chosen for HLD: Redis pub/sub.**
6. **(ABLP-913)** **EndUserOAuthToken backfill source**: When migrating tokens to project-scoped uniqueness, what `projectId` do we assign to existing tenant-scoped tokens? Three options: (a) the projectId of the auth profile they reference, (b) a per-tenant default project ID configured in migration, (c) leave them un-migrated and force re-auth at next use. **Default chosen for LLD: option (a) when profile has projectId; otherwise leave un-migrated and emit a non-blocking deprecation warning at refresh time.**
7. **(ABLP-913)** **A2A model**: ABLP-913 lists A2A servers as a consumer type. The codebase does not currently have a dedicated `A2AServer` Mongoose model. Should the spec include A2A consumers from day one (block on building the model), or ship the rest of ABLP-913 first and add A2A coverage when the model lands? **Default: stub the consumer query for A2A; gate on model existence with a feature flag.**
8. **(ABLP-913)** **Legacy inlineHostedTool cleanup**: Inline-Add creation is removed, but the schema keeps `inlineHostedTool` for migration neutrality. If legacy rows are found, should cleanup happen on owner-tool deletion only, or should there be a one-time migration to promote/delete them? **Default: cleanup on owner-tool deletion; promotion remains a follow-up only if real legacy data requires it.**
9. **(ABLP-913)** **Authorize CTA visibility for non-admin users**: Should non-admin project members see the Authorize CTA on Preconfigured profiles? Probably no — only profile owners + project admins should be able to authorize. Confirm RBAC mapping for the new CTA against `requireProjectPermission('auth_profile:authorize')` (new permission) vs reusing `auth_profile:write`.

---

## 16. Gaps, Known Issues & Limitations

| ID     | Severity | Description                                                                                                                                                                                                                                                                                  | Status     |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| GAP-1  | MEDIUM   | Legacy `oauth2_token` profiles are intentionally read-only migration records; durable OAuth grants resolve from linked `oauth2_app` profiles instead                                                                                                                                         | By design  |
| GAP-2  | LOW      | Runtime auth-profile routes are intentionally limited to shared/workspace CRUD plus lookup-by-name; project-scoped control plane remains Studio-owned                                                                                                                                        | By design  |
| GAP-3  | LOW      | Unique index strategy covers shared visibility only (2 partial indexes); personal visibility names are not uniqueness-constrained                                                                                                                                                            | Documented |
| GAP-4  | MEDIUM   | Addon and advanced protocol coverage (signing/proxy/webhook verification, mTLS, phase-3 auth types) is still uneven at E2E depth                                                                                                                                                             | Open       |
| GAP-5  | MEDIUM   | Consumer migration is still mixed across the platform; dual-read remains necessary until remaining surfaces stop embedding legacy credentials                                                                                                                                                | Ongoing    |
| GAP-6  | LOW      | Auth-profile health and alerting signals are emitted via dedicated evaluators and structured logs, but not yet queryable through a full TraceStore-native event surface                                                                                                                      | Open       |
| GAP-7  | HIGH     | **(ABLP-913)** No `profileType` discriminator field — Integration vs Custom inferred from `connector` presence. Backfill migration required.                                                                                                                                                 | Mitigated  |
| GAP-8  | HIGH     | **(ABLP-913)** No "To be Authorized" surface — Preconfigured OAuth profile without a token is shown as `active`, indistinguishable from authorized profiles.                                                                                                                                 | Mitigated  |
| GAP-9  | HIGH     | **(ABLP-913)** Token Refresh URL (`refreshUrl`) is optional in the schema. Required for Preconfigured OAuth per ABLP-913.                                                                                                                                                                    | Mitigated  |
| GAP-10 | HIGH     | **(ABLP-913)** Tool-level auth assignment was a flat `AuthProfilePicker`, not type-aware. ABLP-913 replaces it with saved-profile-only `AuthProfileAssignment`; no inline credential entry is allowed.                                                                                       | Mitigated  |
| GAP-11 | HIGH     | **(ABLP-913)** Only one revoke action exists (Revoke Profile). "Revoke User Tokens" is missing.                                                                                                                                                                                              | Mitigated  |
| GAP-12 | HIGH     | **(ABLP-913)** No pre-revoke blast-radius warning modal — admins revoke without knowing what breaks.                                                                                                                                                                                         | Mitigated  |
| GAP-13 | HIGH     | **(ABLP-913)** Mid-session token invalidation does not propagate — cached credentials live for up to 5 min after revoke; no force-invalidate path.                                                                                                                                           | Mitigated  |
| GAP-14 | HIGH     | **(ABLP-913)** No insufficient-scope error handling — provider 401/403 surface as opaque errors; no audit of required vs granted scopes.                                                                                                                                                     | Mitigated  |
| GAP-15 | MEDIUM   | **(ABLP-913)** `EndUserOAuthToken` is tenant-scoped (no `projectId` field). Cross-project token reuse violates project isolation invariant and ABLP-913 requirement.                                                                                                                         | Mitigated  |
| GAP-16 | MEDIUM   | **(ABLP-913)** `/consumers` endpoint covers 6 entity types but not ToolDefinition (HTTP tools as distinct from ServiceNode) or A2A servers.                                                                                                                                                  | Mitigated  |
| GAP-17 | MEDIUM   | **(ABLP-913)** No dedicated audit-events surface for auth profiles — `auditTrailPlugin` captures generic writes, but per-profile authorize/refresh/revoke timeline is missing.                                                                                                               | Mitigated  |
| GAP-18 | LOW      | **(ABLP-913)** Authorize CTA exists only on Integration cards (Integrations Tab); not on the slide-over detail panel.                                                                                                                                                                        | Mitigated  |
| GAP-19 | LOW      | **(ABLP-913)** No sensitive-field-change advisory toast when admins update `clientId` / `clientSecret` / `scopes` / `tokenUrl` / `refreshUrl`.                                                                                                                                               | Mitigated  |
| GAP-20 | LOW      | **(ABLP-913)** Auth Profiles section does not pre-filter to the auth type the user came from when arriving via "Create Auth Profile" CTA from a tool config.                                                                                                                                 | Deferred   |
| GAP-21 | MEDIUM   | **(2026-05-09)** `ConnectorConnection` model is deprecated but not yet removed; some legacy paths still reference `connectionId`. Full removal tracked as a follow-up ticket.                                                                                                                | Deferred   |
| GAP-22 | MEDIUM   | **(2026-05-09)** Session-init scan runs at every session start. Suggested optimization: snapshot resolved `authProfileId[]` into the deployed agent version at compile/deploy time, so runtime reads the snapshot instead of walking IR fresh per session. Tracked as follow-up perf ticket. | Deferred   |
| GAP-23 | MEDIUM   | **(2026-05-09)** Per-trigger required-scopes documentation (HubSpot, Salesforce, etc.) is missing. Vijay owns docs effort per meeting next steps; a `requiredScopes` annotation on integration catalog entries is a candidate follow-up.                                                     | Open       |
| GAP-24 | MEDIUM   | **(2026-05-09)** A2A (Agent-to-Agent) auth profile usage flows are not enumerated beyond "assign a Custom auth profile." Vijay to add A2A details per meeting next steps.                                                                                                                    | Open       |
| GAP-25 | LOW      | **(2026-05-09)** "Shared credentials" scenario follow-up ticket per meeting; details TBD.                                                                                                                                                                                                    | Deferred   |
| GAP-26 | HIGH     | **(ABLP-655)** `resolveToolImplementations` dropped `auth_profile_ref`, `jit_auth`, `connection_mode`, `consent_mode` from the resolved `ToolDefinitionLocal`. Agent IR tools therefore had no `auth_profile_ref`, causing the auth-profile middleware to skip them entirely at runtime.     | Mitigated  |
| GAP-27 | MEDIUM   | **(ABLP-655)** `applyAuth` for `api_key` type concatenated prefix directly onto the key without a space separator (e.g. `"Basictoken"`). `bearer` case already handled this correctly. `api_key` now uses the same `withPrefix()` helper.                                                    | Mitigated  |
| GAP-28 | MEDIUM   | **(ABLP-655)** `module-publish-safety.ts` `AUTH_CONFIG_RE` matched `auth: api_key` DSL lines and treated the auth type keyword as a literal secret, causing false-positive `LITERAL_AUTH_VALUE` blocks on module publish for tools using auth profiles.                                      | Mitigated  |
| GAP-29 | LOW      | **(ABLP-655)** `normalizeHttpAuthConfig` preserved inline `apiKey`/`token` secrets in the normalized output even when `hasAuthProfileRef` was true, causing literal credentials to be serialized into the tool DSL alongside the auth profile reference.                                     | Mitigated  |

---

## 17. Testing & Validation

### Coverage Matrix

| FR                                        | Unit                                                                   | Integration                                    | E2E                                        | Manual | Status     |
| ----------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ | ------ | ---------- |
| FR-1 (Encryption)                         | Model test, encryption engine tests                                    | DB integration test                            | -                                          | -      | PASS       |
| FR-2 (17 Auth Types)                      | Schema test (all types), model test                                    | -                                              | -                                          | -      | PASS       |
| FR-3 (Scope Resolution)                   | Service test (resolve logic)                                           | -                                              | -                                          | -      | PASS       |
| FR-4 (OAuth2 Lifecycle)                   | Token refresh, client creds, OAuth app resolver, durable grant tests   | Runtime route/integration coverage             | OAuth flow, connector setup, token refresh | -      | PASS       |
| FR-5 (Redaction)                          | Dedicated secret redaction tests                                       | -                                              | -                                          | -      | PASS       |
| FR-6 (Dual-Read)                          | Dedicated dual-read tests and consumer-dual-read tests                 | Connector/runtime integration coverage         | Connector setup E2E                        | -      | PASS       |
| FR-7 (404 Isolation)                      | Studio API test (visibility), service test                             | -                                              | -                                          | -      | PASS       |
| FR-8 (Health/Alerting)                    | Health test, alerting test                                             | -                                              | -                                          | -      | PASS       |
| **FR-9 (profileType discriminator)**      | Migration test (`20260508_019`), schema test                           | DB integration (`cascade-delete-auth-profile`) | -                                          | -      | PARTIAL    |
| **FR-10 (Integrations Tab)**              | `integrations-route.test.ts`, `integration-catalog.test.ts`            | `/integrations` endpoint test                  | `integration-auth-profiles.e2e.test.ts`    | -      | PARTIAL    |
| **FR-11 (usageMode applies everywhere)**  | `is-authorized.test.ts`                                                | Runtime session-scanner                        | -                                          | -      | PARTIAL    |
| **FR-12 (Session-init scan)**             | `session-scanner.test.ts`                                              | Runtime bootstrap wiring                       | -                                          | -      | PARTIAL    |
| **FR-13 (Authorize CTA on profile)**      | `auth-profile-slide-over-authorize-flow.test.tsx`                      | OAuth callback route test                      | -                                          | -      | PARTIAL    |
| **FR-14 (`isAuthorized` computed)**       | `is-authorized.test.ts`, `AuthProfileHealthPill.test.tsx`              | List endpoint coverage                         | -                                          | -      | PARTIAL    |
| **FR-15 (disabled-row dropdown)**         | `AuthProfileAssignment.test.tsx`                                       | -                                              | -                                          | -      | PARTIAL    |
| **FR-16 (refreshUrl required)**           | `auth-profile-schema.test.ts`                                          | Validate endpoint route test                   | -                                          | -      | PARTIAL    |
| **FR-17 (auto refresh + alert + revert)** | `token-refresh-service.test.ts`                                        | Alert evaluator test                           | -                                          | -      | PARTIAL    |
| **FR-18 (type-aware assignment UI)**      | `AuthProfileAssignment.test.tsx`                                       | Wiring in IntegrationNodeConfig                | -                                          | -      | PARTIAL    |
| **FR-19 (pre-filter on arrival)**         | PLANNED — query-param unit                                             | -                                              | -                                          | -      | NOT TESTED |
| **FR-20 (inline-Add removed)**            | REMOVED per 2026-05-09 meeting — inline-Add no longer supported        | N/A                                            | N/A                                        | -      | N/A        |
| **FR-21 (Used-by extended)**              | `auth-profile-consumers-routes.test.ts`                                | `/consumers` route coverage                    | -                                          | -      | PARTIAL    |
| **FR-22 (deletion guard)**                | `cascade-delete-auth-profile.test.ts`                                  | DB cascade integration                         | -                                          | -      | PARTIAL    |
| **FR-23 (two revoke actions)**            | `revoke-user-tokens-route.test.ts`, `RevokeUserTokensConfirm.test.tsx` | `/revoke-user-tokens` route                    | -                                          | -      | PARTIAL    |
| **FR-24 (blast-radius warning)**          | `blast-radius-aggregator.test.ts`, `revoke-preview-route.test.ts`      | `/revoke-preview` endpoint                     | -                                          | -      | PARTIAL    |
| **FR-25 (sensitive-field advisory)**      | SensitiveFieldChangeAdvisory component exists                          | -                                              | -                                          | -      | PARTIAL    |
| **FR-26 (mid-session invalidation)**      | `force-invalidate.test.ts`                                             | Force-invalidate endpoint + subscriber         | -                                          | -      | PARTIAL    |
| **FR-27 (clear delete-time errors)**      | Runtime consumer-error-handling test                                   | Resolve-tool-auth returns clear errors         | -                                          | -      | PARTIAL    |
| **FR-28 (project-scoped consent)**        | `20260508_020_end_user_oauth_token_project.test.ts`                    | Migration + index verification                 | -                                          | -      | PARTIAL    |
| **FR-29 (insufficient_scope error)**      | `scope-insufficient-detector.test.ts`, `scope-insufficient.test.ts`    | Runtime detection path                         | -                                          | -      | PARTIAL    |
| **FR-30 (audit events)**                  | `audit-event-emitter.test.ts`, `audit-events-route.test.ts`            | `/audit-events` endpoint                       | -                                          | -      | PARTIAL    |
| **FR-31 (Activity tab)**                  | `ActivityTabPanel.tsx` component exists                                | -                                              | -                                          | -      | PARTIAL    |

### Existing Test Summary

- **191 auth-related test files** across database (14), shared/shared-auth-profile (42), runtime (82), studio (52), and project-io (1)
- **ABLP-913 specific additions** (since 2026-05-08): `blast-radius-aggregator.test.ts`, `audit-event-emitter.test.ts`, `integration-catalog.test.ts`, `is-authorized.test.ts`, `oauth-error-map.test.ts`, `scope-insufficient-detector.test.ts`, `session-scanner.test.ts`, `force-invalidate.test.ts`, `cascade-delete-auth-profile.test.ts`, `20260508_020_end_user_oauth_token_project.test.ts`, `integrations-route.test.ts`, `revoke-preview-route.test.ts`, `revoke-user-tokens-route.test.ts`, `audit-events-route.test.ts`, `AuthProfileAssignment.test.tsx`, `RevokeUserTokensConfirm.test.tsx`, `integration-auth-profiles.e2e.test.ts`
- **2026-05-13 verification**: `pnpm build` passed. Focused post-review regression suites passed across shared auth-profile authorization/refresh, Studio OAuth callback/integrations routes, and runtime session scanner/force invalidation (77 tests). Full `pnpm test` is currently blocked by a known `@agent-platform/shared-auth` platform-key scope registry mismatch that is present on `origin/develop`, not introduced by this branch.
- **2026-05-20 (ABLP-655)**: Fixed four bugs: `resolveToolImplementations` dropped auth profile fields from resolved tool definition; `applyAuth` api_key prefix missing space; `normalizeHttpAuthConfig` retained inline secrets when auth profile ref set; `LITERAL_AUTH_VALUE` false positive on auth type keywords. All four packages built clean. Unit test coverage for these specific paths is not yet added — tracked as follow-up.
- **Remaining coverage gap**: full E2E matrix permutations across all auth types + session re-auth flow E2E; unit tests for ABLP-655 fix paths

**Testing guide**: [docs/testing/auth-profiles.md](../testing/auth-profiles.md)

---

## 18. References

- Data model: `packages/database/src/models/auth-profile.model.ts`
- Core service: `packages/shared/src/services/auth-profile.service.ts`
- Validation schemas: `packages/shared/src/validation/auth-profile*.schema.ts`
- Encryption engine: `packages/shared/src/encryption/engine.ts`
- Auth-profile service modules: `packages/shared/src/services/auth-profile/` (23 files)
- Runtime resolver: `apps/runtime/src/services/auth-profile-resolver.ts`
- Studio components: `apps/studio/src/components/auth-profiles/` (24 files)
- Studio API routes: `apps/studio/src/app/api/auth-profiles/` and `apps/studio/src/app/api/projects/[id]/auth-profiles/`
- SearchAI resolver: `apps/search-ai/src/services/auth-profile-resolver.ts`
- Import/export: `packages/project-io/src/import/auth-profile-resolver.ts`
