# Data-Flow & Dependency-Wiring Audit: ABLP-1098 Integration Detail Side Panel

**Date**: 2026-05-18
**Auditor**: Claude Code (Opus 4.7)
**Round**: 1 & 2 (combined — no CRITICAL/HIGH findings required gating a second pass)
**Feature**: Integration detail side panel (apps/studio connections + auth-profiles)
**Commit**: `cb8e7e0af2` on `feat/ABLP-1098-integration-detail-panel`

## Trigger

This audit was invoked because the change introduces **parallel implementations**: the project-scoped auth-profiles page (`/projects/:projectId/settings/auth-profiles`) and the workspace-scoped auth-profiles page (`/admin/auth-profiles`) now both consume the same `?profileId=` URL deep-link parameter, and the integration side panel dispatches between them based on `AuthProfileSummary.scope`.

The feature **does NOT** introduce:

- New sensitive values (no new PII / credentials / payment data — the panel only consumes the existing `AuthProfileSummary` shape, which excludes secret material)
- New serialization boundaries (no Kafka / Restate / HTTP-client / worker-queue payloads)
- New dependency wiring (no constructor injection / factory / singleton additions; all reuses existing hooks and components)
- New persistence (no new MongoDB / ClickHouse / Redis / S3 writes)
- Right-to-erasure paths

Boundary categories touched by the commit: `ui` + `route` (URL routing logic). Two categories — audit warranted.

## Sensitive Values Audited

| Value                                                                 | Data Class                  | Notes                                                                |
| --------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `profileId` (URL param)                                               | INTERNAL identifier         | Used to deep-link the edit slide-over                                |
| `AuthProfileSummary.scope`                                            | INTERNAL routing dispatcher | Decides between `/admin/...` and `/projects/.../settings/...`        |
| Profile metadata displayed in panel (`name`, `description`, `status`) | INTERNAL (non-secret)       | Already rendered by `AuthProfilesPage` and other UI; no new exposure |
| Connector name (URL param)                                            | INTERNAL (non-sensitive)    | Filters / tab selection on auth-profiles page                        |

**Profile credential secrets are out of scope**: the slide-over fetches `AuthProfileDetail` via the existing API which redacts secrets (`AuthProfileDetail.redactedSecrets` per `apps/studio/src/api/auth-profiles.ts:81-86`). My code only consumes `AuthProfileSummary` for display and routing, never secrets.

---

## Round 1: Path Trace

### VALUE: `profileId`

**Approved consumers:** `AuthProfileSlideOver` (edit form, with API-enforced scope check)

#### 1. Source

- `apps/studio/src/components/connections/ConnectionsPage.tsx` — `handleManageProfileFromPanel(profile)` constructs the URL `?profileId=<id>` and calls `navigate(path)`.
- `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx:683` — "Manage in Workspace" `<a href>` link constructs `/admin/auth-profiles?profileId=<id>` for inherited (tenant-scoped) rows.
- **Validation at entry:** none at the URL level. Relies on the API endpoint to enforce scope (existing platform invariant).

#### 2. Writes

- **Not persisted by this feature.** `profileId` is an identifier that already exists in the auth profiles collection.

#### 3. Serialization boundaries

- URL only. No Kafka / HTTP body / worker queue payloads.

#### 4. Read paths

- `AuthProfilesPage.tsx:154-160` — `useState` lazy initializer reads `?profileId=` → `editProfileId`.
- `WorkspaceAuthProfilesPage.tsx:169-176` — `useState` lazy initializer reads `?profileId=` → `editProfileId`.
- `AuthProfileSlideOver` consumes `editProfileId` and fetches profile detail via existing API.

#### 5. Policy boundary

- **Receiving page → AuthProfileSlideOver → API fetch.** The fetch hits the existing route:
  - Project page: API is project-scoped per CLAUDE.md "Resource Isolation" invariant. Requests for a `profileId` outside the user's project return 404, not the raw profile.
  - Workspace page: API is tenant-scoped. Cross-tenant access returns 404.
- **My code does not bypass any policy gate.** It only constructs URLs that the receiving page interprets; the policy gate is the API on the receiving page.

#### 6. Consumers / sinks

- Browser URL bar (visible to the authenticated user — standard URL semantics).
- `AuthProfileSlideOver` (UI edit form).
- **No LLMs / external APIs / outbound webhooks.**

#### 7. Dependency wiring

- **No new dependencies.** Reuses:
  - `useAuthProfiles` SWR hook
  - `AuthProfileSlideOver` component (and its existing setters)
  - `useNavigationStore.navigate`
- All consumers (`AuthProfileSlideOver`, `setEditProfileId`, `setSlideOverOpen`) are already-wired existing primitives on both pages.

#### 8. Parallel paths

- **Project `AuthProfilesPage`** and **Workspace `WorkspaceAuthProfilesPage`** both handle `?profileId=` via the **same code shape**:
  - useState lazy initializer reads `window.location.search`.
  - On match, seeds `editProfileId` + `slideOverOpen=true`.
- Parity verified by direct diff: identical pattern in both files.
- `handleManageProfileFromPanel` correctly dispatches based on `profile.scope === 'tenant'` (the same field used by 4 other call sites in the codebase per the platform-toolkit research earlier in this session).

#### 9. Boundary tests

- ✅ `IntegrationDetailPanel.test.tsx` verifies `onManageProfile` is invoked with the full profile object including `scope: 'project'`, so the routing dispatcher receives the field it needs.
- ❌ No automated regression test for URL-tampering (e.g., project-A user opens `?profileId=<profile-from-project-B>` → expects 404). **This is an existing platform invariant**, not introduced or relaxed by this change. See Finding F-1.

---

### VALUE: `AuthProfileSummary.scope`

**Approved consumers:** `ConnectionsPage` routing dispatcher

| Dimension       | Result                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Source          | Already a field on `AuthProfileSummary` (existing API response). No new entry point.                  |
| Writes          | None.                                                                                                 |
| Serialization   | None new.                                                                                             |
| Read paths      | `ConnectionsPage.handleManageProfileFromPanel`: `profile.scope === 'tenant' ? /admin : /projects/...` |
| Policy boundary | Not a sensitive value; it is a routing discriminator.                                                 |
| Consumers       | Internal routing only.                                                                                |
| Wiring          | No new deps.                                                                                          |
| Parallel paths  | Single read site. No siblings.                                                                        |
| Boundary tests  | ✅ Test asserts profile object including scope is passed through.                                     |

**No findings.**

---

### VALUE: Connector name (URL param)

Already a non-sensitive value used widely throughout Studio. Audit dismissed as non-applicable.

---

## Findings

| ID  | Severity | Dimension        | Finding                                                                                                                               |
| --- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | MEDIUM   | Regression Tests | No automated test asserts the API returns 404 for a `profileId` that doesn't belong to the user's project/tenant. Existing invariant. |
| F-2 | LOW      | Policy Boundary  | "Manage in Workspace" link now exposes `profileId` in the URL. Standard URL semantics; not a new leak.                                |

### F-1 (MEDIUM)

- **Path:** URL → page → `AuthProfileSlideOver` → API GET `/auth-profiles/:id` → expected 404 on cross-scope access.
- **Evidence:** No test in `apps/studio/src/__tests__/api-routes/auth-profiles/` asserts the 404 path for cross-project access via the deep-link entry. The platform invariant is documented in CLAUDE.md but not enforced by an automated test gated on this entry point.
- **Impact:** If a future regression weakens the API's scope check, the side-panel deep-link becomes a vector for cross-scope ID enumeration / leakage.
- **Fix (deferred — out of scope for ABLP-1098):** Add an integration test on the auth-profiles API that seeds two projects in MongoDB and asserts a cross-project `GET /auth-profiles/:id` returns 404 with no body leak. Track as platform-hardening follow-up.
- **Test:** `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-api.test.ts` — add a `describe('cross-scope deep-link', ...)` block.

### F-2 (LOW)

- **Path:** Inherited row click → `/admin/auth-profiles?profileId=<id>` (previously `/admin/auth-profiles`).
- **Evidence:** `AuthProfilesPage.tsx:683` `<a href={...}>`.
- **Impact:** None. URL params for resource identifiers are standard and require an authenticated, scope-checked GET to actually return data.
- **Fix:** No action required.

---

## Round 2: Fix Verification

| Finding | Disposition                                                      | Test Coverage        | Verified                                                   |
| ------- | ---------------------------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| F-1     | Deferred — platform-hardening follow-up (out of ABLP-1098 scope) | Not added in this PR | N/A (no new risk introduced; relies on existing invariant) |
| F-2     | Won't fix — standard URL semantics                               | N/A                  | ✓                                                          |

---

## Dependency Wiring Verification

**Procedure:** Trace every consumer of the new code paths back to its construction site.

| Dependency                                       | Constructed at                                                                                       | Consumer                                                                                             | Status  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------- |
| `IntegrationDetailPanel`                         | `apps/studio/src/components/connections/ConnectionsPage.tsx` (rendered with `detailConnector` state) | `ConnectionsPage` body                                                                               | WIRED ✓ |
| `useAuthProfiles({limit:500})` slice             | `ConnectionsPage.tsx:189` (existing)                                                                 | `detailAuthProfiles` memo filters by `profile.connector === detailConnector.name`                    | WIRED ✓ |
| `handleManageProfileFromPanel`                   | `ConnectionsPage.tsx` (new `useCallback`)                                                            | Passed as `onManageProfile` prop to `IntegrationDetailPanel`                                         | WIRED ✓ |
| `handleConnectFromPanel`                         | `ConnectionsPage.tsx` (new `useCallback`)                                                            | Passed as `onConnect` prop to `IntegrationDetailPanel`                                               | WIRED ✓ |
| `AuthProfileSlideOver` on edit deep-link         | Existing component on both `AuthProfilesPage` and `WorkspaceAuthProfilesPage`                        | `useState` lazy initializer seeds `editProfileId` + `slideOverOpen` from URL — slide-over auto-opens | WIRED ✓ |
| `setActiveTab('integrations')` for `?connector=` | Lazy initializer in `AuthProfilesPage.tsx`                                                           | Tab bar reads `activeTab` state                                                                      | WIRED ✓ |

No null-handling gaps: every consumer expects the values that the URL/state actually provides.

---

## Parallel Paths Parity Verification

Two parallel auth-profiles pages must handle `?profileId=` identically:

| Behavior                                                | Project `AuthProfilesPage` | Workspace `WorkspaceAuthProfilesPage` | Parity             |
| ------------------------------------------------------- | -------------------------- | ------------------------------------- | ------------------ |
| Reads `?profileId=` via useState lazy initializer       | ✓ (lines 154-160)          | ✓ (lines 169-176)                     | ✓                  |
| Seeds `editProfileId` and `slideOverOpen=true` on match | ✓                          | ✓                                     | ✓                  |
| Returns sane defaults when `window === undefined` (SSR) | ✓ `null`/`false`           | ✓ `null`/`false`                      | ✓                  |
| Slide-over component used                               | `AuthProfileSlideOver`     | `AuthProfileSlideOver`                | ✓ (same component) |

Inbound link sources for both pages, also verified parallel:

| Source link                                                 | Target page    | Includes `?profileId=` | Status |
| ----------------------------------------------------------- | -------------- | ---------------------- | ------ |
| `IntegrationDetailPanel` per-profile Manage (scope=project) | Project page   | ✓                      | ✓      |
| `IntegrationDetailPanel` per-profile Manage (scope=tenant)  | Workspace page | ✓                      | ✓      |
| `AuthProfilesPage` "Manage in Workspace" inline link        | Workspace page | ✓ (newly added)        | ✓      |

---

## Field-Propagation Sub-Audit (Cross-Boundary Field Drop Check)

The `onManageProfile` callback signature changed from `(profileId: string) => void` to `(profile: AuthProfileSummary) => void`. Propagation matrix:

| Field               | Panel passes | Callback receives | Routing reads | Result       |
| ------------------- | ------------ | ----------------- | ------------- | ------------ |
| `profile.id`        | Y            | Y                 | Y             | propagates ✓ |
| `profile.scope`     | Y            | Y                 | Y             | propagates ✓ |
| `profile.name`      | Y            | Y                 | (not used)    | -            |
| `profile.status`    | Y            | Y                 | (not used)    | -            |
| `profile.connector` | Y            | Y                 | (not used)    | -            |

No GAPs. The signature change is consistently applied: `IntegrationDetailPanel.tsx` passes the full object, `ConnectionsPage.tsx` reads `.id` and `.scope`, test asserts the full object reaches the handler.

---

## Final Verdict

- [x] No CRITICAL findings open
- [x] No HIGH findings open
- [x] All MEDIUM findings dispositioned (F-1 deferred as platform-hardening follow-up; F-2 won't-fix)
- [x] Boundary tests for THIS feature added (`IntegrationDetailPanel.test.tsx` covers scope-routing handoff)
- [x] Parallel paths verified identical (project AuthProfilesPage ↔ workspace AuthProfilesPage)
- [x] Dependency wiring traced — no missing consumers
- [x] No new sensitive values introduced; existing platform invariants relied upon and not bypassed
- [x] Audit log complete

**Conclusion:** Feature is safe to ship under ABLP-1098. Recommend opening a small platform-hardening ticket to add the cross-scope deep-link API test described in F-1 — this hardens an existing platform invariant against future regressions but is not blocking this PR.
