# Auth Profile — Studio UI Analysis

> Analysis of existing Studio UI components, patterns, and user experience flows for all auth-related touchpoints, with a detailed gap analysis for the Auth Profile migration.

---

## 1. Existing UI Components Catalog

### 1.1 Connection Management (Project-Level)

**Location:** `apps/studio/src/components/connections/`

| Component                | File                        | Purpose                                                                                                          |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ConnectionsPage`        | `ConnectionsPage.tsx`       | Split-layout page: "My Connections" (cards + inline expand) above, "Connector Catalog" (grid) below              |
| `ConnectionCard`         | `ConnectionCard.tsx`        | Compact card with connector logo, name, health dot (green/amber/red), agent count, relative time                 |
| `ConnectionExpandPanel`  | `ConnectionExpandPanel.tsx` | Inline expand below card row; shows status badge, auth type, created/expires dates; test/edit/disconnect         |
| `ConnectionStatusBar`    | `ConnectionStatusBar.tsx`   | Header bar showing "N connected, N expiring, N failed, N available" + "New Connection" button                    |
| `CatalogCard`            | `CatalogCard.tsx`           | Card for available connectors; shows action/trigger counts; "Connect" or "Connected" badge                       |
| `CreateConnectionModal`  | `CreateConnectionModal.tsx` | 3-step modal: pick connector (search+category grid) -> configure (name+credentials) -> success animation         |
| `OAuthFlowDialog`        | `OAuthFlowDialog.tsx`       | 6-step OAuth flow: authorize -> initiating -> waiting (popup) -> exchanging -> success/error                     |
| `ConnectorLogo`          | `ConnectorLogo.tsx`         | Logo resolver component for connector icons                                                                      |
| `connector-categories`   | `connector-categories.ts`   | Category taxonomy: communication, productivity, storage, crm, ai_dev, custom; with ordering                      |
| `agent-desktop-registry` | `agent-desktop-registry.ts` | Provider definitions with typed credential field schemas (smartassist, genesys, salesforce, servicenow, generic) |

**API client:** `apps/studio/src/api/connections.ts` -- CRUD for connections, OAuth callback, test connection. All routes under `/api/projects/:projectId/connections`.

**Key types:**

- `ConnectionSummary`: id, connectorName, displayName, scope (`tenant | user`), authType (`oauth2 | api_key | bearer | basic | custom | none`), status (`active | expired | revoked`), hasCredentials, expiresAt
- `ConnectionDetail`: extends ConnectionSummary with metadata

### 1.2 Channel Connection Setup

**Location:** `apps/studio/src/components/deployments/channels/`

| Component               | File                        | Purpose                                                                                                     |
| ----------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ChannelInstanceConfig` | `ChannelInstanceConfig.tsx` | Tabbed shell (overview, credentials, configuration, deployment, testing, activity)                          |
| `CredentialsTab`        | `tabs/CredentialsTab.tsx`   | Dynamic credential form driven by `CredentialFieldDef[]` from channel type registry                         |
| `CreateInstanceDialog`  | `CreateInstanceDialog.tsx`  | Dialog for creating new channel instances                                                                   |
| `channel-registry`      | `channel-registry.tsx`      | Registry of channel types with capabilities and credential field definitions                                |
| `channel-normalizer`    | `channel-normalizer.ts`     | Normalizes 3 backend sources (sdk_channel, channel_connection, webhook_subscription) into `ChannelInstance` |
| `types`                 | `types.ts`                  | `ChannelInstance`, `CredentialFieldDef`, `ChannelTypeDef`, `ChannelTabProps`                                |

**Key patterns:**

- `CredentialsTab` renders fields dynamically from `channelDef.credentialFields` -- each field has `key`, `label`, `type`, `required`, `placeholder`, `validation`
- Handles Infobip auth type switching (api_key vs basic) -- conditional field visibility
- Shows "Credentials saved and encrypted" indicator with Shield icon
- Validates on save, sends only non-empty values

### 1.3 LLM Provider/Credential Setup (Workspace Admin)

**Location:** `apps/studio/src/components/admin/`

| Component               | File                        | Purpose                                                                                                     |
| ----------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ModelsPage`            | `ModelsPage.tsx`            | Workspace model catalog: credentials management, model listing with expandable rows, connections wiring     |
| `AddConnectionDialog`   | `AddConnectionDialog.tsx`   | Wires tenant credentials to models via connections; credential picker + inline "create new credential" form |
| `AddModelDialog`        | `AddModelDialog.tsx`        | Dialog for adding models to tenant catalog                                                                  |
| `HyperParameterForm`    | `HyperParameterForm.tsx`    | Model hyperparameter configuration (temperature, maxTokens, etc.)                                           |
| `LLMPolicySection`      | `LLMPolicySection.tsx`      | LLM usage policies                                                                                          |
| `SecretsPage`           | `SecretsPage.tsx`           | Tool Secrets, Proxy Configs, OAuth Tokens management (tabbed interface)                                     |
| `ConnectorsPage`        | `ConnectorsPage.tsx`        | Workspace channel connections and SDK channels management                                                   |
| `GuardrailProviderForm` | `GuardrailProviderForm.tsx` | Guardrail provider config form with API key field and adapter type selection                                |

**Key patterns in `AddConnectionDialog`:**

- Credential picker dropdown: lists existing credentials filtered by provider, plus "Create New Credential" option
- Inline credential creation form that adapts per provider:
  - Default: name + API key
  - Azure: + resource name, deployment ID, API version
  - Bedrock (AWS IAM): + region, access key ID, secret access key, session token
  - Custom: + endpoint URL, custom headers JSON
- Post-creation: "Test Connection" button calls validate endpoint, shows success/error/warning states
- Uses `ProviderSelect` component for provider branding

**Key patterns in `SecretsPage`:**

- Three tabs: Tool Secrets, Proxy Configs, OAuth Tokens
- Each tab has CRUD operations against runtime API
- Tool Secrets: projectId-scoped, versioned, optional expiry
- Proxy Configs: name, URL, auth type, enabled toggle
- OAuth Tokens: provider, scope, expires, last used

### 1.4 MCP Server Configuration

**Location:** `apps/studio/src/components/mcp-servers/`

| Component               | File                         | Purpose                                                                   |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| `McpServerCreateDialog` | `McpServerCreateDialog.tsx`  | Full create/edit dialog: Connection, Authentication, Environment sections |
| `McpServersListPage`    | `McpServersListPage.tsx`     | List page for registered MCP servers                                      |
| `McpServerDetailPage`   | `McpServerDetailPage.tsx`    | Detail view for individual MCP server                                     |
| `McpServerCard`         | `McpServerCard.tsx`          | Card component for server listing                                         |
| `McpServerStatusBadge`  | `McpServerStatusBadge.tsx`   | Status indicator badge                                                    |
| `McpConfigForm`         | `McpConfigForm.tsx` (tools/) | Per-tool config: server reference, transport, headers, advanced settings  |

**Key patterns in `McpServerCreateDialog`:**

- Three collapsible `FormSection` groups with icons: Connection (Server icon), Authentication (Lock icon), Environment (Lock icon)
- Authentication section: `Select` dropdown with 5 auth types: none, bearer, api_key, custom_headers, oauth2_client_credentials
- Conditional sub-forms per auth type:
  - Bearer: single token field
  - API Key: header name + header value (grid-2)
  - Custom Headers: dynamic key-value pair list (add/remove)
  - OAuth2 Client Credentials: client ID + client secret (grid-2), token endpoint, scope
- `EncryptedBanner` for edit mode: "Bearer token configured" with "Replace" button -- avoids re-entering existing encrypted values
- Environment variables: dynamic key-value pairs (add/remove), all encrypted at rest
- `useReducer` pattern for complex form state management

### 1.5 Tool Configuration

**Location:** `apps/studio/src/components/tools/`

| Component                  | File                                    | Purpose                                                  |
| -------------------------- | --------------------------------------- | -------------------------------------------------------- |
| `McpConfigForm`            | `McpConfigForm.tsx`                     | MCP tool binding config (server ref, transport, headers) |
| `ToolConfigView`           | `sections/ToolConfigView.tsx`           | Read-only view of tool configuration                     |
| `ToolConfigurationSection` | `sections/ToolConfigurationSection.tsx` | Editable tool configuration section                      |

### 1.6 Agent Editor Tool Configuration

**Location:** `apps/studio/src/components/agent-editor/sections/`

| Component     | File              | Purpose                                                                                                    |
| ------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `ToolsEditor` | `ToolsEditor.tsx` | Inline tool definition editor: name, description, parameters, binding type badge (HTTP/MCP/Sandbox/Lambda) |

**Current state:** No `connection` or `per_user`/`shared` mode selection exists in the tools editor. Tools currently show binding type (HTTP, MCP, etc.) but have no auth profile or connection mode configuration.

### 1.7 Git Integration (Auth Pattern Reference)

**Location:** `apps/studio/src/components/settings/GitIntegrationTab.tsx`

Uses a credential type selector (PAT vs OAuth) with a `secretId` input field -- references a stored secret. This is the closest existing pattern to the proposed `authProfileId` reference approach.

### 1.8 Project Settings Shell

**Location:** `apps/studio/src/components/settings/ProjectSettingsPage.tsx`

Tab-based settings with routing via `page` store key (e.g., `settings-members`, `settings-models`, `settings-git`). Sidebar navigation in `ProjectSidebar.tsx` defines the settings group with 10 current sub-pages.

---

## 2. UI Patterns and Design System

### 2.1 Dialog/Modal Patterns

**Standard pattern:** Radix UI `Dialog` with Framer Motion animations.

- **Component:** `apps/studio/src/components/ui/Dialog.tsx`
- **API:** `{ open, onClose, title?, description?, children, maxWidth }` where maxWidth is `'sm' | 'md' | 'lg' | 'xl' | '2xl' | '4xl' | '5xl'`
- **Animation:** scale 0.95 -> 1.0, backdrop blur
- **Max height:** `calc(85vh - 4rem)` with overflow-y-auto

**Specialized dialogs used:**

- `ConfirmDialog`: destructive action confirmation (danger variant)
- `CreateConnectionModal`: multi-step with `AnimatePresence mode="wait"` and directional slide animations (x: -20 for back, x: 20 for forward)
- `McpServerCreateDialog`: sectioned form with collapsible `<details>` groups

### 2.2 Form Patterns for Credential Input

**Pattern 1: Direct credential fields**

- `Input` component with `type="password"` for secrets
- Provider-specific conditional fields (Azure resource name, Bedrock IAM, Custom headers)
- Inline validation with error text below field

**Pattern 2: Credential picker + inline create**

- `<select>` dropdown listing existing credentials
- "Create New Credential" option at bottom
- Inline creation form appears within the same dialog (bordered, muted background card)
- After creation, auto-selects new credential in dropdown

**Pattern 3: Encrypted banner (edit mode)**

- `EncryptedBanner` component: shows "X configured" with Lock icon + "Replace" button
- Avoids exposing existing encrypted values; user must explicitly choose to replace

**Pattern 4: Dynamic key-value lists**

- Add/remove rows pattern for custom headers and environment variables
- Each row: two inputs (key + value) + delete button
- "Add" link below with Plus icon

### 2.3 Status Indicators

**Badge component:** `apps/studio/src/components/ui/Badge.tsx`

- Variants: `default | accent | success | warning | error | info | purple`
- Optional `dot` prop for status dot prefix
- Pill-shaped (`rounded-full`), `text-xs font-medium`

**Health dots (ConnectionCard):**

- Green (`bg-success`): active
- Amber (`bg-warning`): expiring within 7 days
- Red (`bg-error`): revoked
- Gray (`bg-muted`): unknown/inactive

**Inline status indicators:**

- `CheckCircle2` (green) + "Ready" text for verified credentials
- `AlertTriangle` (amber) + "No credentials" / "No keys" for missing credentials
- `Shield` icon + "Saved and encrypted" for confirmed credential storage

### 2.4 List/Table Components

**Card grid layout:** `grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3` (connections), `xl:grid-cols-4` (catalog)
**Grouped sections:** Category headers with separator line: `<span className="text-xs font-medium text-muted">{label}</span><div className="h-px flex-1 bg-border" />`
**Expandable rows:** `AnimatePresence` + `motion.div` with height animation (0 -> auto)
**Divided list:** `rounded-lg border border-default overflow-hidden divide-y divide-default` (model list)

### 2.5 Inline Help/Guidance

**Current patterns:**

- Tooltip component (`Tooltip` from ui/Tooltip) for short explanations
- `<p className="text-xs text-muted">` hint text below inputs
- Empty state component (`EmptyState`) with icon, title, description, action button
- Warning banners: `bg-warning-subtle border-warning/30` with `AlertTriangle` icon
- Info sections with `<details>/<summary>` for advanced/optional configuration

---

## 3. User Experience Flows by Persona

### 3.1 Workspace Admin — Tenant-Level Credential Setup

**Current flow (LLM credentials):**

1. Navigate to Admin > Models (`/admin/models`)
2. `ModelsPage` shows model catalog with credential status indicators per model
3. Click "Add Connection" on a model row -> `AddConnectionDialog` opens
4. Select existing credential from dropdown OR create new inline
5. New credential form: name, provider (ProviderSelect), API key (password), provider-specific fields
6. Create credential -> auto-selects -> wire connection -> test connection -> done

**Current flow (Secrets):**

1. Navigate to Admin > Secrets
2. `SecretsPage` with three tabs: Tool Secrets, Proxy Configs, OAuth Tokens
3. Each tab has "Add" dialog for creating entries with encrypted storage

**Current flow (Guardrails):**

1. Navigate to Admin > Guardrails
2. `GuardrailProviderForm` dialog: adapter type, endpoint, API key, hosting type

**Gaps for Auth Profile:**

- No unified "Auth Profiles" page exists at workspace level
- Credentials are scattered across Models (LLMCredential), Secrets (ToolSecret, ProxyConfig), and individual connector configs
- No tenant-level Auth Profile browser that shows all auth types in one view

### 3.2 Project Member — Project Connections

**Current flow (Connector connections):**

1. Navigate to project Connections page
2. `ConnectionsPage` shows "My Connections" grid + "Connector Catalog" grid
3. Click "Connect" on catalog card -> `CreateConnectionModal` opens
4. Step 1: pick connector (search + category grid)
5. Step 2: configure -- name + credentials (OAuth2 -> `OAuthFlowDialog` popup; API key -> password input)
6. Step 3: success animation
7. Connection appears in "My Connections" with health dot

**Current flow (Channel credentials):**

1. Navigate to Deployments > Channels > select instance
2. `ChannelInstanceConfig` tabbed view -> Credentials tab
3. `CredentialsTab` renders dynamic fields from channel type definition
4. Fill in credentials -> Save -> encrypted storage

**Gaps for Auth Profile:**

- No concept of "scope" (tenant vs project) in current connection UI
- No "inherited from workspace" indicator
- No "per_user" vs "shared" connection mode toggle
- No Auth Profile reference selection -- credentials are always inline

### 3.3 Workflow Developer — Tool Auth Selection

**Current flow (Agent editor):**

1. Open agent in editor
2. `ToolsEditor` shows inline tool cards with name, description, parameters
3. Tool binding type shown as badge (HTTP, MCP, Sandbox, Lambda)
4. No connection or auth configuration available in the editor

**Current flow (MCP tool setup):**

1. Navigate to Tools page, create MCP tool
2. `McpConfigForm` references server by name (resolved to URL)
3. Auth configured at MCP server level, not per-tool
4. Per-tool: only transport type and custom headers

**Gaps for Auth Profile:**

- No "Select connection" dropdown in tool/trigger configuration panels
- No "Shared vs Per-user" toggle for connection mode
- No "Create new connection" shortcut from within the editor
- No visual indicator of which tools require end-user authorization

### 3.4 End User — Runtime Consent

**Current flow:**

- No runtime consent UI exists in Studio
- `OAuthFlowDialog` exists for developer-time OAuth, not end-user runtime consent
- No pre-flight authorization screen
- No inline consent prompt component

**Gaps for Auth Profile:**

- Pre-flight consent UI: "This agent needs access to: Gmail, Calendar. [Authorize Gmail] [Authorize Calendar]"
- Inline consent UI: "I need access to your Gmail. [Authorize]" as a chat message action
- Personal token management view for end users

---

## 4. New UI Needed for Auth Profile

### 4.1 Auth Profiles Management Page (Settings > Auth Profiles)

**Design doc Section 7.1 requirement:** Table/grid listing Auth Profiles for current scope with name, authType icon, status badge, scope, visibility, last used, linked consumers count. "New Auth Profile" button with type selector and type-specific form.

**Recommended implementation:**

**New component:** `apps/studio/src/components/settings/AuthProfilesTab.tsx`

**Reuse patterns from:**

- `ModelConfigTab`: table layout with expandable rows, status badges, category filters, "Add from Catalog" dialog pattern
- `SecretsPage`: tabbed interface for different auth type categories
- `ConnectionsPage`: card grid with health dots and inline expand panels

**Structure:**

- Header: title + "New Auth Profile" button (same as ModelConfigTab header)
- Filter bar: authType chips, status filter, scope toggle (tenant | project)
- List: divided list (like ModelsPage model list) with each row showing:
  - Auth type icon (locked into a set of 17 -- map each to a Lucide icon)
  - Name + description preview
  - Status badge (active/expired/revoked/invalid using Badge component)
  - Scope badge (tenant/project)
  - Visibility badge (shared/personal)
  - Last used relative time
  - Consumer count
  - Expand/actions chevron
- Expand panel: full details + linked consumers list + edit/revoke/delete actions (same pattern as `ConnectionExpandPanel`)

**New dialog:** `AuthProfileCreateDialog.tsx`

- Step 1: Auth type selector grid (similar to CreateConnectionModal step 1 connector picker, but with auth type icons)
- Step 2: Type-specific configuration form (reuse conditional form pattern from `McpServerCreateDialog` and `AddConnectionDialog`)
- Step 3: Review + create

**Navigation changes:**

- Add `settings-auth-profiles` to `ProjectSidebar.tsx` settings group pages array
- Add route case in `AppShell.tsx`
- Add `AuthProfilesTab` to `ProjectSettingsPage.tsx`

### 4.2 Connector Setup Flow Modifications

**Design doc Section 7.2 requirement:** 3-step flow: App Credentials (oauth2_app), Authorization (shared vs per_user), Confirmation.

**Modify:** `CreateConnectionModal.tsx`

**Changes needed:**

1. **Replace Step 2 ("configure")** with a multi-sub-step flow:
   - **Sub-step 2a (OAuth connectors):** "Does this project have OAuth app credentials?"
     - Show linked `oauth2_app` Auth Profile if exists (new lookup)
     - "Using workspace default" indicator if tenant-level exists (new `inherited` flag)
     - Inline form to create `oauth2_app` Auth Profile with Nango setup guide
   - **Sub-step 2b:** "Who authorizes?"
     - Radio/toggle: "I'll authorize now (shared)" vs "End users authorize themselves (per_user)"
     - If shared: trigger OAuthFlowDialog -> create `oauth2_token` with `visibility: shared`
     - If per_user: set `connection: per_user` in DSL config

2. **For non-OAuth connectors:** replace inline credentials with Auth Profile picker:
   - Dropdown: "Select Auth Profile" (filtered by compatible auth types for this connector)
   - "Create new" option -> opens AuthProfileCreateDialog
   - Still support direct credential entry as shortcut (creates Auth Profile behind the scenes)

3. **Step 3 (Confirmation):** show summary of created Auth Profiles (both oauth2_app and oauth2_token if applicable)

**New component:** `AuthProfilePicker.tsx` -- reusable dropdown for selecting Auth Profiles filtered by compatible auth types. Pattern from `AddConnectionDialog`'s credential picker but referencing Auth Profiles.

### 4.3 Workflow Editor Changes

**Design doc Section 7.3 requirement:** Dropdown for connection selection, "Create new", Shared/Per-user toggle, info text for per_user.

**Modify:** `apps/studio/src/components/agent-editor/sections/ToolsEditor.tsx`

**Changes needed:**

1. **Add "Connection" field to `EditableToolCard`** expanded view:
   - Dropdown: "Select connection" listing shared `oauth2_token` profiles for this connector
   - "Create new connection" option -> opens connector setup flow
   - Only show for connector-backed tools (filter by tool binding type)

2. **Add "Connection Mode" toggle:**
   - Toggle/radio: "Shared" vs "Per-user"
   - For "Per-user": info text "End users will be prompted to authorize when they use this workflow"
   - For "Shared": shows selected connection name/status

3. **Add visual indicator:**
   - Tools requiring per_user auth get a small user icon badge
   - Tools with expired/invalid connections get a warning badge

**New types needed in `ToolSectionData`:**

- `connectionMode?: 'shared' | 'per_user'`
- `authProfileId?: string`
- `consent?: 'preflight' | 'inline'`

### 4.4 Runtime Consent UI

**Design doc Section 7.4 requirement:** Pre-flight and inline consent flows for end-user OAuth.

**Entirely new components needed:**

**Pre-flight consent:** `apps/studio/src/components/runtime/AuthConsentScreen.tsx`

- Full-page or modal overlay before agent session starts
- Lists required connectors with display names and icons
- Per-connector "Authorize" button -> opens OAuth popup
- Status tracking: pending, authorized, denied
- "Continue" button enabled only when all preflight requirements satisfied
- Denied state: shows which connectors were denied with option to retry

**Inline consent:** `apps/studio/src/components/runtime/InlineAuthPrompt.tsx`

- Chat message-style component embedded in conversation
- "I need access to your Gmail to send that email. [Authorize]" pattern
- Triggers OAuth popup via `OAuthFlowDialog` (reuse existing component)
- Shows success/failure inline after auth completes

**Reuse:** `OAuthFlowDialog` for the actual OAuth popup mechanics. Modify to accept an `authProfileId` (for `oauth2_app` lookup) instead of raw `authorizationUrl`.

### 4.5 Inline Setup Help (Nango-Powered)

**Design doc Section 7.5 requirement:** Expandable panels with provider-specific guidance sourced from Nango.

**New component:** `apps/studio/src/components/connections/SetupGuidePanel.tsx`

- Expandable panel (use `<details>/<summary>` pattern from McpServerCreateDialog)
- Content: "How to get these credentials?" header
- Dynamic content from Nango `setup_guide_url` and `docs_connect` (fetched or embedded)
- Shows:
  - Required redirect URI (auto-generated, with copy button -- use existing `Copy` icon + `navigator.clipboard` pattern)
  - Common scopes checklist
  - Provider-specific gotchas (Google consent screen, Slack bot scopes, etc.)
- Rendered inside `AuthProfileCreateDialog` for `oauth2_app` auth type forms
- Rendered inside `CreateConnectionModal` step 2a

---

## 5. Component Reuse vs. New — Summary Matrix

### Reuse As-Is

| Component        | File                            | Used In                                                            |
| ---------------- | ------------------------------- | ------------------------------------------------------------------ |
| `Dialog`         | `ui/Dialog.tsx`                 | All new dialogs (AuthProfileCreateDialog, AuthConsentScreen, etc.) |
| `Badge`          | `ui/Badge.tsx`                  | Auth type badges, status badges, scope badges, visibility badges   |
| `Button`         | `ui/Button.tsx`                 | All action buttons, loading states                                 |
| `Input`          | `ui/Input.tsx`                  | All form fields                                                    |
| `Select`         | `ui/Select.tsx`                 | Auth type selector, scope selector, filter dropdowns               |
| `EmptyState`     | `ui/EmptyState.tsx`             | Empty Auth Profiles list, no connections state                     |
| `ConfirmDialog`  | `ui/ConfirmDialog.tsx`          | Delete/revoke Auth Profile confirmation                            |
| `Tabs`           | `ui/Tabs.tsx`                   | Auth Profiles filtering tabs (by category)                         |
| `Tooltip`        | `ui/Tooltip.tsx`                | Help tooltips on form fields                                       |
| `ConnectorLogo`  | `connections/ConnectorLogo.tsx` | Connector icons in Auth Profile list, consent screen               |
| `Skeleton`       | `ui/Skeleton.tsx`               | Loading states                                                     |
| `Card`           | `ui/Card.tsx`                   | Auth Profile detail cards                                          |
| `ProviderSelect` | `ui/ProviderSelect.tsx`         | Provider selection in auth profile creation                        |

### Modify Existing

| Component                | File                                           | Changes Needed                                                                                                                         |
| ------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateConnectionModal`  | `connections/CreateConnectionModal.tsx`        | Add oauth2_app sub-step, shared/per_user mode selector, Auth Profile picker integration, Nango guide panel                             |
| `OAuthFlowDialog`        | `connections/OAuthFlowDialog.tsx`              | Accept `authProfileId` prop for resolving auth URL via Auth Profile API instead of raw URL; support end-user consent mode              |
| `ConnectionsPage`        | `connections/ConnectionsPage.tsx`              | Add "scope" filter (tenant/project), "inherited" badge for workspace-level profiles, visibility indicators                             |
| `ConnectionCard`         | `connections/ConnectionCard.tsx`               | Add visibility badge (shared/personal), scope indicator (project/inherited), authProfileId display                                     |
| `ConnectionExpandPanel`  | `connections/ConnectionExpandPanel.tsx`        | Show linked Auth Profile name/ID, add "View Auth Profile" link, show consumer count                                                    |
| `ConnectionStatusBar`    | `connections/ConnectionStatusBar.tsx`          | Add "inherited" count, "per_user" count to status summary                                                                              |
| `ToolsEditor`            | `agent-editor/sections/ToolsEditor.tsx`        | Add connection dropdown, connection mode toggle (shared/per_user), consent type selector, visual indicators                            |
| `McpServerCreateDialog`  | `mcp-servers/McpServerCreateDialog.tsx`        | Replace inline auth section with Auth Profile picker (reuse AuthProfilePicker); keep "Create new" inline option                        |
| `CredentialsTab`         | `deployments/channels/tabs/CredentialsTab.tsx` | Replace inline credential fields with Auth Profile picker; show linked profile status                                                  |
| `AddConnectionDialog`    | `admin/AddConnectionDialog.tsx`                | Replace `TenantCredential` picker with Auth Profile picker; credential creation -> Auth Profile creation                               |
| `ProjectSettingsPage`    | `settings/ProjectSettingsPage.tsx`             | Add `settings-auth-profiles` route case                                                                                                |
| `ProjectSidebar`         | `navigation/ProjectSidebar.tsx`                | Add `settings-auth-profiles` to settings group pages and items arrays                                                                  |
| `AppShell`               | `navigation/AppShell.tsx`                      | Add `settings-auth-profiles` route rendering                                                                                           |
| `GitIntegrationTab`      | `settings/GitIntegrationTab.tsx`               | Replace `secretId` field with Auth Profile picker for git credentials                                                                  |
| `GuardrailProviderForm`  | `admin/GuardrailProviderForm.tsx`              | Replace inline API key field with Auth Profile reference                                                                               |
| `agent-desktop-registry` | `connections/agent-desktop-registry.ts`        | Migrate field definitions to reference Auth Profile config schemas                                                                     |
| `connector-categories`   | `connections/connector-categories.ts`          | Add `auth` category for auth-specific connectors if needed                                                                             |
| `connections.ts` (API)   | `api/connections.ts`                           | Add `authProfileId` to `ConnectionSummary`, update `createConnection` to accept `authProfileId`, add Auth Profile API client functions |

### Entirely New

| Component                 | Proposed Path                                     | Purpose                                                                            |
| ------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `AuthProfilesTab`         | `components/settings/AuthProfilesTab.tsx`         | Auth Profiles management page for project settings                                 |
| `AuthProfileCreateDialog` | `components/settings/AuthProfileCreateDialog.tsx` | Multi-step dialog for creating Auth Profiles (type selection -> config -> confirm) |
| `AuthProfilePicker`       | `components/connections/AuthProfilePicker.tsx`    | Reusable dropdown for selecting Auth Profiles filtered by compatible auth types    |
| `AuthProfileExpandPanel`  | `components/settings/AuthProfileExpandPanel.tsx`  | Inline expand panel for Auth Profile details (consumers, rotate, revoke)           |
| `AuthTypeIcon`            | `components/settings/AuthTypeIcon.tsx`            | Maps 17 auth types to Lucide icons for consistent visual identity                  |
| `AuthConsentScreen`       | `components/runtime/AuthConsentScreen.tsx`        | Pre-flight consent UI for end-user OAuth authorization                             |
| `InlineAuthPrompt`        | `components/runtime/InlineAuthPrompt.tsx`         | In-conversation consent prompt for inline OAuth                                    |
| `SetupGuidePanel`         | `components/connections/SetupGuidePanel.tsx`      | Nango-powered expandable help panel for OAuth app credential setup                 |
| `auth-profiles.ts` (API)  | `api/auth-profiles.ts`                            | API client for Auth Profile CRUD, OAuth flows, validation endpoint                 |
| `useAuthProfiles` (hook)  | `hooks/useAuthProfiles.ts`                        | SWR/fetch hook for Auth Profile listing with filtering                             |
| `auth-profile-store`      | `store/auth-profile-store.ts`                     | Zustand store for auth profile state (selected profile, creation flow state)       |

---

## 6. Implementation Priority

### Phase 1: Foundation (Auth Profile CRUD)

1. `auth-profiles.ts` API client
2. `useAuthProfiles` hook
3. `AuthTypeIcon` component
4. `AuthProfilesTab` management page
5. `AuthProfileCreateDialog` with basic auth types (api_key, bearer, basic)
6. Navigation changes (sidebar, AppShell, ProjectSettingsPage)

### Phase 2: Consumer Migration

7. `AuthProfilePicker` reusable component
8. Modify `AddConnectionDialog` (admin LLM credentials -> Auth Profile)
9. Modify `McpServerCreateDialog` (MCP auth -> Auth Profile reference)
10. Modify `CredentialsTab` (channel credentials -> Auth Profile reference)
11. Modify `GitIntegrationTab` (git credentials -> Auth Profile reference)
12. Modify `GuardrailProviderForm` (guardrail API key -> Auth Profile reference)

### Phase 3: Connector OAuth

13. Add `oauth2_app` and `oauth2_token` auth type forms to AuthProfileCreateDialog
14. Modify `CreateConnectionModal` for two-layer OAuth flow
15. Modify `OAuthFlowDialog` to resolve from Auth Profile
16. `SetupGuidePanel` with Nango integration

### Phase 4: Workflow Editor Integration

17. Modify `ToolsEditor` with connection dropdown and mode toggle
18. Add `connectionMode`, `authProfileId`, `consent` to tool section data model

### Phase 5: Runtime Consent

19. `AuthConsentScreen` (pre-flight)
20. `InlineAuthPrompt` (inline consent)
21. Modify `OAuthFlowDialog` for end-user consent mode

---

## 7. Key Design Decisions

### 7.1 Auth Profile Picker Pattern

The `AuthProfilePicker` should follow the `AddConnectionDialog` credential picker pattern:

- Dropdown listing compatible profiles (filtered by `authType` array and `connector` name)
- Inline "Create New Auth Profile" option
- Shows profile name, auth type badge, status dot
- Edit mode: shows current profile with "Change" button

### 7.2 Backward Compatibility

During migration, forms should support both:

- Legacy inline credentials (for existing connections not yet migrated)
- Auth Profile references (for new and migrated connections)

The UI should detect whether an entity has `authProfileId` or legacy credentials and render accordingly.

### 7.3 Status Badge Mapping

Map Auth Profile `status` field to existing Badge variants:

- `active` -> `success` (green)
- `expired` -> `warning` (amber)
- `revoked` -> `error` (red)
- `invalid` -> `default` (gray)

### 7.4 Auth Type Icon Mapping

Proposed mapping for `AuthTypeIcon` (using Lucide icons):

- `none` -> `Ban`
- `api_key` -> `Key`
- `bearer` -> `Shield`
- `basic` -> `Lock`
- `digest` -> `Lock`
- `oauth2_app` -> `AppWindow`
- `oauth2_token` -> `UserCheck`
- `oauth2_client_credentials` -> `KeyRound`
- `custom_header` -> `FileCode`
- `aws_iam` -> `Cloud`
- `azure_ad` -> `Cloud`
- `kerberos` -> `ShieldCheck`
- `saml` -> `Fingerprint`
- `hawk` -> `ShieldAlert`
- `ssh_key` -> `Terminal`
- `mtls` -> `ShieldCheck`
- `ws_security` -> `FileCode`
