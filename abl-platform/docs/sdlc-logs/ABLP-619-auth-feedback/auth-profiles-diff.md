# ABLP-619 — Proposed diff against `docs/features/auth-profiles.md`

**Goal:** Encode the ABLP-619 feedback into the canonical Auth Profiles spec.

- (a) Profile creation for `oauth2_app` and `oauth2_client_credentials` (project + workspace scope) must surface an **Authorize** action that runs the OAuth flow / client-credentials grant inline at creation time. The current "Test credentials" path is insufficient because it does not capture user consent or persist a working grant.
- (b) Integrations that reference an OAuth profile must consume the existing grant. They must **not** initiate a second OAuth user-consent flow. Function-step usage today is the reference behavior.

This file is a **draft** — nothing in `auth-profiles.md` has been changed yet. After review, the changes below will be applied verbatim, in one focused `docs(auth-profiles)` commit.

---

## Edit 1 — Section 3: add a creation-time consent user story

**Where:** end of section "## 3. User Stories" (after item 5, line 62)

**Add:**

```md
6. As a project or workspace admin creating an `oauth2_app` or `oauth2_client_credentials` profile, I want to authorize the grant inline at creation time so that the profile lands in an `active` state with a working token, instead of discovering missing consent later when an integration first runs.
7. As an integration author, I want to bind a workflow integration node to an existing OAuth profile and have it use the profile's existing grant directly, so that end users are not asked to re-consent every time an integration runs.
```

---

## Edit 2 — Section 4: add explicit functional requirements

**Where:** end of "## 4. Functional Requirements" (after FR-8, line 75)

**Add:**

```md
9. **FR-9 (Authorize at creation)**: Profile creation for `oauth2_app` and `oauth2_client_credentials`, at both project (`/projects/:projectId/auth-profiles`) and workspace (`/settings/auth-profiles`) scopes, MUST expose an **Authorize** action that runs the appropriate grant inline before the profile is finalized:
   - `oauth2_app`: launch the existing PKCE authorization-code flow (via `AuthProfileOAuthDialog` and `POST /api/projects/:projectId/auth-profiles/oauth/initiate` + callback), persist the resulting `EndUserOAuthToken` per `connectionMode`, and only then mark the profile `active`.
   - `oauth2_client_credentials`: perform a `client_credentials` token exchange via `client-credentials-service.ts` against the configured `tokenUrl`, surface success/failure to the operator, cache the token in Redis, and only then mark the profile `active`.
   - A profile that fails authorize at creation is rejected with a structured error; partial state is not persisted.
   - The pre-existing "Test credentials" affordance, where present, is replaced by **Authorize** for these two auth types. "Test credentials" remains valid for non-OAuth auth types (api_key, bearer, basic, custom_header, etc.).

10. **FR-10 (Integrations consume profile without re-consent)**: Surfaces that select an OAuth profile by `authProfileId` (workflow integration nodes, connectors, MCP servers, channels) MUST resolve credentials through the runtime resolver and `oauth-grant-service.ts` and MUST NOT initiate an additional OAuth user-consent flow at integration-bind or integration-run time. Re-consent only occurs when the underlying token is missing/expired and `usageMode = 'preflight' | 'jit'` requires it — never as a side effect of binding the profile to an integration.
```

---

## Edit 3 — Section 6: clarify Authorize-at-creation as a design principle

**Where:** end of "## 6. Design Considerations" (after the addon bullet, line 113)

**Add:**

```md
- **Authorize-at-creation for OAuth profiles**: For `oauth2_app` and `oauth2_client_credentials`, the create dialog must run the grant inline. This avoids the failure mode where an apparently-active profile is later resolved by Runtime and discovered to lack a usable token. "Test credentials" is acceptable for non-OAuth auth types because those have no asynchronous consent step; for OAuth, capturing consent at creation is the only way to keep `status === 'active'` honest.
- **Integrations are pure consumers**: Workflow integration nodes, connectors, channels, and MCP servers bind to an `authProfileId` and resolve credentials through the runtime resolver; they do not own an OAuth flow. When a runtime caller needs interactive consent (token missing/expired with `preflight` or `jit` semantics), that consent surfaces through the existing handoff/preflight UX, not through a duplicate OAuth dialog at the integration boundary.
```

---

## Edit 4 — Section 8 (Studio UI): mark Authorize as the canonical create-time CTA

**Where:** the "Studio UI" sub-section bullets (lines 130–139), specifically the line for `AuthProfileOAuthDialog` and the test-credentials affordance.

**Replace:**

```md
- **OAuth Dialog**: `AuthProfileOAuthDialog` handles the OAuth2 authorization flow (redirects to provider, handles callback)
```

**With:**

```md
- **Authorize at create**: `AuthProfileOAuthDialog` is launched **inline from the create form** for `oauth2_app` and `oauth2_client_credentials`, at both `/projects/:projectId/auth-profiles` and `/settings/auth-profiles`. The create form's primary CTA for these auth types is **Authorize**, not "Test credentials". On success the dialog closes, the form is finalized via `POST /auth-profiles`, and the profile is created with `status: 'active'` and a working `EndUserOAuthToken` (oauth2_app) or cached client-credentials token (oauth2_client_credentials).
- **Test credentials**: remains the create-time CTA for non-OAuth auth types (api_key, bearer, basic, custom_header, mtls, etc.) where validation is a single round-trip against the target service.
```

---

## Edit 5 — Section 9 (Usage Modes): tie creation-time consent to `preconfigured`

**Where:** end of "#### Key Design Principle" block (after line 334).

**Add:**

```md
#### Authorize at creation vs. runtime consent

Creation-time **Authorize** populates the profile under `usageMode: 'preconfigured'`:

- `connectionMode: 'shared'` → the admin authorizes once; the resulting `EndUserOAuthToken` is stored under `userId = '__tenant__'` and reused by every consumer.
- `connectionMode: 'per_user'` → the admin authorizes for themselves at creation; their `EndUserOAuthToken` is stored under their real user ID. Other end users obtain their own grants the first time a `preflight`- or `jit`-tagged tool needs one, **not** at integration-bind time.

`oauth2_client_credentials` is always machine-to-machine; creation-time Authorize performs the `client_credentials` grant against `tokenUrl` and caches the resulting token in Redis under `auth-profile:cc-token:{tenantId}:{profileId}`. There is no per-user variant for this auth type.
```

---

## Edit 6 — Section 13: add P8 delivery phase

**Where:** end of "## 13. Delivery Plan / Work Breakdown" (after P7, line 607).

**Add:**

```md
### P8: Authorize-at-creation hardening (ABLP-619, IN PROGRESS)

1. Replace "Test credentials" with **Authorize** in the Studio create form for `oauth2_app` and `oauth2_client_credentials`, at both project and workspace scope (`AuthProfilesPage.tsx`, `WorkspaceAuthProfilesPage.tsx`, and the create-dialog component).
2. Wire the inline Authorize CTA into `AuthProfileOAuthDialog` so that the OAuth flow runs _before_ the profile is persisted; reject creation if the grant does not complete.
3. For `oauth2_client_credentials`, run the `client_credentials` grant via `client-credentials-service.ts` from the create flow and surface success/failure inline.
4. Ensure runtime integration consumers (workflow integration node, connector connections, MCP) resolve through `oauth-grant-service.ts` only and never initiate a new OAuth flow at bind/run time. Add a regression test that asserts `oauth/initiate` is not called from the integration node binding path.
5. Update `docs/testing/auth-profiles.md` with E2E scenarios for create-with-Authorize at both scopes and for both auth types, plus an integration-bind scenario asserting "no second consent".
```

---

## Edit 7 — Section 16: log the current gap until P8 lands

**Where:** end of the GAP table (after GAP-6, line 641).

**Add row:**

```md
| GAP-7 | HIGH | Studio create form currently exposes "Test credentials" for `oauth2_app` and `oauth2_client_credentials` instead of an inline **Authorize** action. Profiles can land in `status: 'active'` with no usable token, deferring failure to the first integration run. ABLP-619. | Open |
| GAP-8 | MEDIUM | The "no second OAuth consent at integration bind/run" contract is not yet asserted by an automated test. ABLP-619. | Open |
```

---

## Edit 8 — Section 17: add coverage for FR-9/FR-10

**Where:** Coverage Matrix table (line 649).

**Add rows:**

```md
| FR-9 (Authorize at creation) | Studio create-form unit tests for both auth types and both scopes | Studio create-route integration test asserting profile lands `active` only after grant succeeds | E2E: create `oauth2_app` with inline Authorize → profile active + EndUserOAuthToken persisted; create `oauth2_client_credentials` with inline Authorize → token cached in Redis | - |
| FR-10 (Integrations consume profile only) | Workflow integration node binding test | Integration node bind/run integration test asserting `oauth/initiate` is NOT called | E2E: bind workflow integration node to existing oauth2_app profile → execute → no consent prompt, runtime resolves grant via oauth-grant-service | - |
```

---

## Cross-doc impact (out of scope for this commit but noted)

- `docs/features/workflow-integration-node.md` — should reference FR-10 and link back to this doc; integration node UX must not show an "Authorize" / "Connect" button when an `authProfileId` is bound, only a profile picker.
- `docs/features/oauth-tooling.md` — function-step path is the reference behavior for FR-10; update its cross-reference table.
- `docs/testing/auth-profiles.md` — pick up the new E2E rows from Edit 8; will be updated when the test spec is regenerated.

---

## Apply plan

1. Open `docs/features/auth-profiles.md` and apply edits 1–8 verbatim.
2. Run `npx prettier --write docs/features/auth-profiles.md`.
3. Stage and commit:
   `[ABLP-619] docs(auth-profiles): require Authorize at creation, document integration consume-only contract`
4. Map commit SHA back to ABLP-619 via `pnpm jira:update -- ABLP-619 --comment "..."`.
5. Follow-up commits (separate concerns): the matching `workflow-integration-node.md` and `oauth-tooling.md` cross-refs.
