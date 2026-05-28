# C-02: Connect Tab -- Capability Note

**Status:** Reviewed
**Design Sections:** SS4a

## User Intent

The Connect tab is the entry point for establishing a SharePoint connection. First-time users need a guided, conversational experience that explains what will happen (~3 min), collects authentication details, and sets permission scope before auth begins. Returning users (1+ existing connectors) need a compact, efficient form that skips the welcome copy and goes straight to credential entry + auth method selection.

## UI Behaviors

### First-Time Experience (0 existing connectors in this KB)

1. **Conversational welcome** -- heading "Let us get you connected to SharePoint" with ~3 min time estimate and explanation that a Configuration Proposal will be generated after auth.
2. **Connector name field** -- text input with placeholder "e.g., Marketing SharePoint, Engineering Docs". Optional on initial entry (user can leave blank). Helper text explains: system will suggest a name after discovery; name appears in sources list, panel header, and alerts; must be unique within KB. Field is marked as required but deferrable. The suggestion appears during/after Proposal generation, not on the Connect tab (confirmed by Sarah persona, design line 3123).
3. **Auth method selection** -- two radio card options (delegation is INTENTIONALLY EXCLUDED per user scope decision):
   - **Azure App Registration (production)** -- shows subtitle "For automated sync, delegation, and enterprise deployment" and "Best for: Production deployments, IT-managed connectors". Requires Client ID and Tenant ID fields.
   - **Sign in with Microsoft (quick setup)** -- shows subtitle "Try the connector quickly. Sign in with your Microsoft account. No Client ID needed. Upgrade to App Registration later." and "Best for: Evaluating the connector, testing with your data". Triggers browser OAuth flow. Uses `Sites.Read.All` automatically with no scope selector (confirmed by Sarah persona, design line 3123, and design line 1277).
4. **Configure-before-auth messaging** -- text at bottom: "While you wait for authentication, you can configure scope, filters, and schedule in the other tabs. Everything saves automatically and applies once connected."
5. **Action buttons** -- [Cancel] and [Continue -->] at bottom-right.

### Returning User Experience (1+ existing connectors)

1. **No welcome copy** -- compact form layout with numbered steps.
2. **Connector name field** -- same input but marked "(Required. Shown in sources list, panel header, and alerts.)" with no deferral messaging.
3. **Step 1: Azure App Registration** -- Client ID and Tenant ID fields shown directly (no radio cards).
4. **"Don't have an app registration?" expandable guide** -- collapsible section with two options:
   - Option A: "Send Setup Request to IT Admin" button (generates email with step-by-step Azure Portal instructions).
   - Option B: Self-service 6-step guide (Azure Portal > App Registrations > permissions list).
   - "Download Full Setup Guide (PDF)" link.
5. **Step 1b: Connection Scopes** -- read-only display of base capabilities and permission-aware search toggle (see below).
6. **Step 2a: Authentication Method** -- three radio options:
   - Device Code -- "share a code with the person who authenticates"
   - Browser Login -- "sign in with your Microsoft account now" (default selected)
   - App-Only (Client Credentials) -- "automated with secret"
7. **Step 2b: Admin Consent** -- informational note: "Entering the device code signs you in. It does NOT grant admin consent. Admin consent (if needed for Sites.Read.All) is a separate step after authentication."
8. **Configure-before-auth messaging** -- same as first-time.
9. **Action buttons** -- [Cancel] and [Connect -->].

### Connection Scopes Display (both experiences)

1. **Base capabilities (always included)** -- read-only checklist: content sync, discovery, delta sync, real-time webhooks, read document permissions. Shows scope names: `Sites.Read.All + Files.Read.All + offline_access`.
2. **Permission-aware search** -- displayed as ENABLED by default with locked indicator. NOT a toggle. Shows added scope: `GroupMember.Read.All`. Description: "Search results respect SharePoint access controls."
3. **Disable flow** -- a text link "[I need to disable this...]" that expands (not navigates) to a type-to-confirm panel:
   - Warning text listing consequences (all docs visible to all KB users, SharePoint access controls not enforced, Confidential docs visible).
   - "Appropriate ONLY when" guidance (intentionally public content, public-facing KB).
   - Text input: user must type exactly "public access" to enable [Confirm Disable] button.
   - [Cancel -- Keep Enabled] and [Confirm Disable] (greyed until exact match typed).
   - On confirm: records who disabled, when, and the confirmation text to audit log.
   - After confirm: section shows "[Warning] Public Access -- Opted In by {email} on {date}".

### Post-Auth Transition

After authentication completes, the system transitions to the Proposal tab where discovery runs and a Configuration Proposal is generated. Any pre-configured settings from draft mode (scope, filters, schedule, permissions) are applied automatically.

## Required Data Fields

### Inputs (user-provided)

| Field                      | Type    | Required                        | Validation                                                                                                       | Notes                                                |
| -------------------------- | ------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `connectorName`            | string  | Yes (deferrable for first-time) | Unique within KB                                                                                                 | System suggests after discovery if left blank        |
| `authMethod`               | enum    | Yes                             | `app_registration` or `microsoft_signin` (first-time); `device_code`, `browser_login`, or `app_only` (returning) | First-time maps to simplified choices                |
| `clientId`                 | string  | Conditional                     | UUID format (Application ID)                                                                                     | Required for App Registration and App-Only           |
| `tenantId`                 | string  | Conditional                     | UUID format (Directory ID)                                                                                       | Required for App Registration and App-Only           |
| `clientSecret`             | string  | Conditional                     | Non-empty                                                                                                        | Required only for App-Only (Client Credentials)      |
| `permissionAwareSearch`    | boolean | No                              | --                                                                                                               | Default: `true`. Disabling requires type-to-confirm  |
| `publicAccessConfirmation` | string  | Conditional                     | Exact match "public access"                                                                                      | Required only when disabling permission-aware search |

### Display-Only Data (from API)

| Field                    | Source               | Purpose                                                             |
| ------------------------ | -------------------- | ------------------------------------------------------------------- |
| `existingConnectorCount` | API                  | Determines first-time vs returning experience                       |
| `existingConnectorNames` | API                  | Client-side uniqueness validation hint                              |
| `baseScopes`             | Static/config        | Display scope list (Sites.Read.All, Files.Read.All, offline_access) |
| `permissionScopes`       | Static/config        | Display additional scope (GroupMember.Read.All)                     |
| `suggestedName`          | API (post-discovery) | System-suggested connector name                                     |

## API Requirements

### 1. Check Existing Connectors

**When:** On Connect tab mount.
**What the UI needs:** Count of existing SharePoint connectors in this KB, plus their names (for uniqueness check).

```
GET /api/projects/:projectId/knowledge-bases/:kbId/connectors?type=sharepoint
Response: { connectors: [{ id, name }], count: number }
```

### 2. Validate Connector Name Uniqueness

**When:** On connector name field blur or on Continue/Connect click.
**What the UI needs:** Boolean -- is this name already taken within this KB?

```
GET /api/projects/:projectId/knowledge-bases/:kbId/connectors/check-name?name={name}
Response: { available: boolean, suggestion?: string }
```

Alternative: Client-side check against the names returned in API #1. Server-side validation still required on save.

### 3. Initiate Authentication

**When:** User clicks [Continue -->] or [Connect -->].
**What the UI needs:** Depends on auth method:

- **Browser Login / Sign in with Microsoft:** API returns an OAuth redirect URL. UI opens it (popup or redirect). For the "Sign in with Microsoft" first-time path, the platform uses `Sites.Read.All` scope automatically (no scope selector shown).
- **Device Code:** API returns a `deviceCode`, `userCode`, and `verificationUri`. UI displays the code and polls for completion.
- **App-Only (Client Credentials):** API validates credentials immediately and returns success/failure.

```
POST /api/projects/:projectId/knowledge-bases/:kbId/connectors/auth/initiate
Body: { authMethod, clientId?, tenantId?, clientSecret?, permissionAwareSearch }
Response (browser_login): { redirectUrl: string, state: string }
Response (device_code): { deviceCode, userCode, verificationUri, expiresIn, pollInterval }
Response (app_only): { success: boolean, error?: { code, message } }
```

### 4. Poll Authentication Status

**When:** After Device Code or Browser Login initiation, poll at the interval specified.
**What the UI needs:** Current auth status (pending, completed, failed, expired).

```
GET /api/projects/:projectId/knowledge-bases/:kbId/connectors/auth/status?state={state}
Response: { status: 'pending' | 'completed' | 'failed' | 'expired', authenticatedUser?: string, error?: { code, message } }
```

### 5. Save Connector (Draft)

**When:** On field changes (auto-save) or explicit save before auth completes.
**What the UI needs:** Confirmation that draft state is persisted so user can close browser and resume.

```
POST /api/projects/:projectId/knowledge-bases/:kbId/connectors
Body: { name?, authMethod, clientId?, tenantId?, permissionAwareSearch, status: 'draft' }
Response: { connectorId: string, status: 'draft' }
```

### 6. Update Permission-Aware Search Setting

**When:** User completes the type-to-confirm disable flow.
**What the UI needs:** Confirmation that the opt-out was recorded with audit details.

```
PATCH /api/projects/:projectId/knowledge-bases/:kbId/connectors/:connectorId/permissions
Body: { permissionAwareSearch: false, confirmationText: "public access" }
Response: { success: boolean, auditRecord: { disabledBy, disabledAt, confirmationText } }
```

### 7. Generate IT Admin Email

**When:** User clicks "Send Setup Request to IT Admin" in the expandable guide.
**What the UI needs:** Pre-formatted email body with Azure Portal instructions customized to this tenant.

```
POST /api/projects/:projectId/knowledge-bases/:kbId/connectors/generate-admin-email
Body: { type: 'app_registration_setup' }
Response: { subject: string, body: string, mailto: string }
```

## Assumptions

1. The UI can determine first-time vs returning experience by checking the count of existing SharePoint connectors in the KB (API #1).
2. Connector name uniqueness is scoped to a single Knowledge Base, not globally.
3. The "Sign in with Microsoft" first-time option maps to the Browser Login auth method under the hood (same OAuth flow, just presented without requiring Client ID). It uses `Sites.Read.All` scope automatically -- no scope selector is shown (confirmed by Sarah persona, design line 3123, and design rationale lines 1273-1291).
4. The base scopes list (`Sites.Read.All`, `Files.Read.All`, `offline_access`) and the permission scope (`GroupMember.Read.All`) are static display values that do not need an API call. They may come from a shared config or be hardcoded in the UI.
5. Auto-save (draft persistence) is expected so the user can configure other tabs while waiting for auth and even close the browser.
6. The type-to-confirm "public access" match is case-insensitive on the client side but the exact string is sent to the server for audit.
7. After auth completes, the transition to the Proposal tab is triggered by the auth status poll returning `completed`.

## Open Questions

1. **App-Only (Client Credentials) and client secret:** The returning user form shows App-Only as an option but the wireframe does not show a client secret field. Where does the user enter the client secret? Is it a conditional field that appears when App-Only is selected?
2. **Admin Consent flow (Step 2b):** The design mentions admin consent as "a separate step after authentication." Is this a separate API call the UI must trigger, or does it happen within the Microsoft OAuth flow? Does the UI need to display admin consent status?
3. **PDF download:** The expandable guide mentions "Download Full Setup Guide (PDF)." Is this a static asset or a generated document? Does it need an API endpoint?

## Edge Cases

1. **Duplicate connector name** -- User enters a name already used by another connector in this KB. Show inline validation error with the system's suggested alternative name.
2. **Auth timeout** -- Device code expires (typically 15 min). UI must show expiry countdown and offer [Regenerate Code] when expired.
3. **Auth popup blocked** -- Browser Login popup may be blocked. Detect and show fallback instructions ("Allow popups for this site" or offer Device Code as alternative).
4. **Client ID / Tenant ID format error** -- User pastes malformed UUIDs. Validate on blur with regex and show inline error before allowing Continue.
5. **Browser closed mid-auth** -- User starts auth, closes browser, returns later. Draft connector should be resumable from the Sources table (shows "Awaiting Auth" status).
6. **Permission-aware search re-enable** -- User disables via type-to-confirm, then wants to re-enable. The design does not show a re-enable path on this tab (it may be in the Proposal's Permissions section).
7. **Rate limit during auth** -- Microsoft OAuth may rate-limit. API should return a retryable error; UI shows "Please wait and try again" with the retry delay.
8. **Multiple concurrent auth attempts** -- User clicks Connect, then navigates away and tries again. The system should invalidate the previous auth state or warn about the in-progress attempt.

## Out of Scope

- **"Someone else will authenticate (delegation)"** auth method -- INTENTIONALLY EXCLUDED per user scope decision. The design wireframe (lines 829-836) shows a third radio card for delegation in the first-time experience, and lines 847-925 detail the delegation sub-flow (form, invite generation, countdown). These are all intentionally excluded from C-02 scope. A separate delegation card can be created to cover this Connect tab sub-state if/when delegation is brought into scope.
- **Delegation form, invite generation, countdown, resume state** -- All delegation-related UI within the Connect tab (back link, configurable expiry, "Don't have Client ID?" delegation variant, scope consent text) is INTENTIONALLY EXCLUDED per user scope decision (design lines 847-925, 863, 874-899, 916).
- **Configuration Proposal generation and display** -- that is the Proposal tab (post-auth), not the Connect tab.
- **Scope+Filters, Schedule, Preview, Security, History tabs** -- separate cards.
- **Draft mode tab editing** -- the configure-before-auth experience for other tabs is a separate concern; this card only covers the Connect tab's own messaging about it.
- **Backend implementation** -- no DB schema, service architecture, or queue design.
- **Simplified View toggle behavior** -- panel-level concern, not Connect-tab-specific.

## Resolution Log

| Finding                                                           | Disposition                                       | Action Taken                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FINDING-10 (Delegation radio card in first-time experience)       | INTENTIONALLY EXCLUDED -- per user scope decision | The design wireframe shows three radio cards, but delegation is excluded from scope. Documented the exclusion explicitly in Out of Scope with design line references. The UI will show two radio cards, not three.              |
| FINDING-11 (Delegation form within Connect tab)                   | INTENTIONALLY EXCLUDED -- per user scope decision | The design places the delegation sub-flow inside the Connect tab (lines 847-925). Documented in Out of Scope. A separate delegation card can be created later.                                                                  |
| FINDING-12 ("Back to auth method selection" link)                 | INTENTIONALLY EXCLUDED -- per user scope decision | Part of the delegation form UI. Documented in Out of Scope.                                                                                                                                                                     |
| FINDING-13 (Returning user shows THREE auth methods)              | NO FINDING (verified)                             | Returning user form correctly shows Device Code, Browser Login, and App-Only. No gap.                                                                                                                                           |
| FINDING-14 ("Don't have an app registration?" in delegation form) | INTENTIONALLY EXCLUDED -- per user scope decision | The delegation-specific variant of the expandable guide is part of the delegation sub-flow. Documented in Out of Scope.                                                                                                         |
| FINDING-15 (Delegation scope consent text)                        | INTENTIONALLY EXCLUDED -- per user scope decision | Part of delegation form. Documented in Out of Scope.                                                                                                                                                                            |
| FINDING-16 (delegationConfig fields)                              | INTENTIONALLY EXCLUDED -- per user scope decision | No delegation fields needed since the delegation radio card is excluded.                                                                                                                                                        |
| FINDING-17 (Delegation invite generation API)                     | INTENTIONALLY EXCLUDED -- per user scope decision | Part of delegation flow. Documented in Out of Scope.                                                                                                                                                                            |
| FINDING-18 (Assumption #3 -- automatic Sites.Read.All)            | VALID -- fixed                                    | Updated Assumption #3 to note that "Sign in with Microsoft" uses `Sites.Read.All` automatically with no scope selector. Added design line references. Also updated the first-time radio card description and API #3 notes.      |
| FINDING-19 (Delegation countdown and resume)                      | INTENTIONALLY EXCLUDED -- per user scope decision | The delegation status tracker and countdown are part of the delegation flow. Documented in Out of Scope.                                                                                                                        |
| FINDING-20 (Configurable delegation expiry window)                | INTENTIONALLY EXCLUDED -- per user scope decision | Part of delegation flow. Documented in Out of Scope.                                                                                                                                                                            |
| FINDING-21 (Open Question #1 answered)                            | VALID -- resolved                                 | Design confirms: "Sign in with Microsoft" uses platform-provided app registration with `Sites.Read.All` automatically. Removed Open Question #1 (was about Client ID). Answer incorporated into Assumption #3 and UI Behaviors. |
| FINDING-22 (Open Question #2 answered)                            | VALID -- resolved                                 | Design confirms: connector name suggestion appears during/after Proposal generation, not on the Connect tab. Removed Open Question #2. Answer incorporated into connector name field description.                               |
| FINDING-23 (Delegation scope issue)                               | INTENTIONALLY EXCLUDED -- per user scope decision | The delegation radio card, form, and invite generation are all intentionally excluded. Documented comprehensively in Out of Scope with all relevant design line references.                                                     |
