# C-10: Multi-Connector Management — Capability Note

**Status:** Reviewed
**Design Sections:** §8

## User Intent

The user has at least one SharePoint connector configured and wants to add another. Rather than repeating the full setup from scratch, they want options: clone an existing connector's configuration (re-authenticating only), apply a saved template, import a previously exported JSON/YAML config, or use the API/CLI. When cloning or applying a template that includes permission-aware search, the user must re-acknowledge the security implications before proceeding.

## UI Behaviors

- **Setup method dialog:** When the user clicks [+ Add Source] and selects SharePoint while at least one SharePoint connector already exists in the KB, the "How would you like to set up this connector?" dialog appears instead of immediately opening the Detail Panel. If this is the first SharePoint connector, this dialog is skipped and the panel opens directly with the Connect tab.

- **From Scratch:** User clicks [New Setup -->]. Dialog closes, Detail Panel opens with Connect tab active (standard new-connector flow, identical to first connector).

- **Clone Existing:**
  - A list of existing SharePoint connectors in the current KB is displayed as selectable items (e.g., "Marketing Hub", "Engineering Wiki", "Sales Docs").
  - User selects one source connector and clicks [Clone -->].
  - If the source connector has permission-aware search enabled OR uses Public Access mode, the Template Security Gate (§8b) is shown before proceeding.
  - On success, a new connector is created with copied configuration. The Detail Panel opens with the Connect tab active (auth required — auth is never cloned).
  - **Overlap warning:** Static informational note displayed below the connector list: "If two connectors sync overlapping SharePoint sites, the same document may be indexed twice. This doubles storage but does not cause errors. To avoid duplication, select non-overlapping sites across connectors."
  - **Cross-tenant notice:** When the selected source connector's tenant differs from the target tenant, an inline notice appears: "Target tenant differs from source tenant. Site selections have been cleared — the target tenant has different sites. After authenticating, you will select sites from the new tenant." A summary shows what was copied (filter rules, file types, folder exclusions, schedule, permission mode) and what was cleared (site selections, authentication, sync history).

- **From Template:**
  - Recently used or popular templates are shown inline (e.g., "Standard KB Template", "Engineering Docs Template").
  - [Browse All Templates] opens a full template browser (list/grid with search and filter).
  - [Create Template from Existing Connector] opens a flow to save an existing connector's config as a reusable template.
  - Selecting a template and confirming creates a new connector pre-filled with the template's configuration. If the template has permission-aware search enabled, the Template Security Gate (§8b) is shown.
  - The Detail Panel opens with the Connect tab active (auth still required).

- **Import Configuration:**
  - [Upload JSON/YAML File] opens a file picker accepting `.json` and `.yaml`/`.yml` files.
  - [Paste Configuration] opens a text area where the user can paste raw JSON or YAML.
  - **Round-trip workflow hint:** Inline helper text below the actions: "Round-trip: export from UI -> modify in editor -> import via API." Guides the user on the intended export-edit-import workflow.
  - On successful parse and validation, a new connector is created with the imported config. The Detail Panel opens with the Connect tab active.
  - On validation failure, inline errors are shown describing which fields are invalid or missing.

- **API/CLI reference pane:**
  - Displays the POST endpoint path, a cURL template, and a CLI command.
  - [View API Docs] opens external API documentation.
  - [Copy cURL Template] and [Copy CLI Command] copy to clipboard with toast confirmation.
  - This pane is informational only — no connector is created from this pane in the UI.

- **Template Security Gate (§8b):**
  - Triggered when cloning a connector or applying a template that has permission-aware search enabled (group resolution active).
  - Shows: source connector/template name, the inherited permission setting, and the required OAuth scopes (Sites.Read.All, Files.Read.All, GroupMember.Read.All).
  - Notes that if GroupMember.Read.All is not granted, group resolution will not be active.
  - Two actions:
    - [Continue with Permissions Enabled] — proceeds with permission-aware search inherited.
    - [I need to disable this...] — expands a type-to-confirm flow. User must type the confirmation phrase to disable permission-aware search. Once confirmed, the connector is created with Public Access mode.
  - For Public Access clones specifically: the gate requires re-acknowledgment that all KB users will see all documents.

## Required Data Fields

### Setup Method Dialog

- `existingConnectors` (array of `{connectorId: string, name: string, tenantId: string, permissionMode: "enabled" | "public_access", status: string}`) — populates the Clone Existing selector; only SharePoint connectors in the current KB
- `savedTemplates` (array of `{templateId: string, name: string, description?: string, permissionMode: "enabled" | "public_access", createdAt: Date, usageCount?: number}`) — populates the From Template list
- `currentTenantId` (string) — compared against source connector's `tenantId` to trigger the cross-tenant notice
- `knowledgeBaseId` (string) — scoping context for listing connectors and creating new ones
- `projectId` (string) — scoping context for API calls

### Clone Operation

- `sourceConnectorId` (string) — the connector being cloned
- `clonedFields` (object) — what gets copied: scope rules, filters (file types, folder exclusions, metadata conditions, CEL rules), schedule, permission mode
- `clearedFields` — what is NOT copied: authentication credentials, sync history; additionally site selections are cleared on cross-tenant clone
- `isCrossTenant` (boolean) — derived from comparing source `tenantId` with current `tenantId`

### Template Application

- `templateId` (string) — the template being applied
- `templateConfig` (object) — the full configuration snapshot stored in the template (scope, filters, schedule, permission mode)

### Import

- `importedConfig` (object) — parsed JSON/YAML configuration body
- `validationErrors` (array of `{field: string, message: string}`) — returned by the API if the imported config is invalid
- `importFormat` ("json" | "yaml") — detected or selected format

### Security Gate

- `sourcePermissionMode` ("enabled" | "public_access") — from the source connector or template
- `sourceName` (string) — connector or template name shown in the notice
- `requiredScopes` (array of string) — e.g., ["Sites.Read.All", "Files.Read.All", "GroupMember.Read.All"]
- `userConfirmation` (string) — the typed confirmation phrase for disabling permissions
- `securityDecision` ("continue_with_permissions" | "disable_permissions") — the user's choice

## API Requirements

### API-1: List Existing Connectors (for Clone selector)

- **Purpose:** Populate the Clone Existing dropdown with SharePoint connectors in the current KB.
- **Input:** `knowledgeBaseId`, `projectId`, `tenantId` (auth context). Filter: `type=sharepoint`.
- **Output:** Array of `{connectorId, name, tenantId, permissionMode, status}`.
- **Notes:** Only connectors with status "active" or "syncing" should be cloneable (not "draft" or "error"). May reuse an existing list-connectors endpoint with a type filter.

### API-2: Clone Connector

- **Endpoint pattern:** `POST /api/connectors/:id/clone`
- **Purpose:** Create a new connector by copying configuration from an existing one.
- **Input:** `sourceConnectorId` (path param), `knowledgeBaseId`, `projectId`, `tenantId`, `securityDecision` (if source has permission-aware search — "continue_with_permissions" or "disable_permissions").
- **Output:** `{connectorId, name, status: "draft", permissionMode, clonedFrom: sourceConnectorId, isCrossTenant: boolean}`.
- **Notes:** Auth is never copied. Site selections are cleared for cross-tenant clones. The new connector starts in "draft" status requiring authentication.

### API-3: List Templates

- **Endpoint pattern:** `GET /api/connector-templates`
- **Purpose:** Populate the From Template list and Browse All Templates view.
- **Input:** `projectId`, `tenantId` (auth context). Optional: `search` (string), `page`, `limit`.
- **Output:** Array of `{templateId, name, description, permissionMode, createdAt, updatedAt, usageCount, createdBy}`.

### API-4: Create Connector from Template

- **Purpose:** Create a new connector pre-filled with a template's configuration.
- **Input:** `templateId`, `knowledgeBaseId`, `projectId`, `tenantId`, `securityDecision` (if template has permission-aware search).
- **Output:** `{connectorId, name, status: "draft", permissionMode, templateId}`.
- **Notes:** Same as clone — auth not included, connector starts in "draft" requiring authentication.

### API-5: Create Template from Existing Connector

- **Endpoint pattern:** `POST /api/connector-templates`
- **Purpose:** Save an existing connector's configuration as a reusable template.
- **Input:** `sourceConnectorId`, `templateName`, `description` (optional), `projectId`, `tenantId`.
- **Output:** `{templateId, name, description, permissionMode, createdAt}`.

### API-6: Import Configuration

- **Endpoint pattern:** `POST /api/connectors/import`
- **Purpose:** Create a new connector from an imported JSON/YAML configuration.
- **Input:** `config` (parsed JSON object), `format` ("json" | "yaml"), `knowledgeBaseId`, `projectId`, `tenantId`.
- **Output on success:** `{connectorId, name, status: "draft", permissionMode}`.
- **Output on validation failure:** `{success: false, error: {code: "VALIDATION_ERROR", message: string, details: [{field, message}]}}`.
- **Notes:** OAuth credentials are never accepted in imported configs (stripped/rejected). If the imported config has permission-aware search, the security gate should be shown client-side before calling this endpoint, passing the security decision.

### API-7: Get API/CLI Reference

- **Purpose:** Provide the cURL template and CLI command pre-filled with the current KB context.
- **Notes:** This may be generated entirely client-side using known endpoint patterns and the current `knowledgeBaseId`/`projectId`. No dedicated API call may be needed — the UI can construct the cURL and CLI strings from constants.

## Assumptions

1. The setup method dialog only appears for connector #2+ of the same type (SharePoint). The first SharePoint connector always goes through the standard From Scratch flow.
2. Clone copies configuration only — never authentication tokens, client secrets, or sync history.
3. Cross-tenant detection is based on comparing the source connector's `tenantId` with the currently authenticated user's tenant context.
4. **[OPEN — see OQ #1]** Template scope is not specified by the design. Implementation must resolve whether templates are project-scoped, tenant-scoped, or global before building the template list UI.
5. The security gate for permission-aware search is always shown when the source has it enabled, even if the user previously acknowledged it on another connector — each connector requires independent acknowledgment.
6. Imported configurations must match a known schema version. The API validates and rejects configs with unknown or outdated versions.
7. The API/CLI pane is purely informational in the UI — no server round-trip is needed to render it.

## Open Questions

1. **Template scope:** Are templates project-scoped, tenant-scoped, or global? The design shows them in the connector-level dialog but does not specify visibility boundaries.
2. **Clone naming:** What is the default name for a cloned connector? Auto-generated (e.g., "Marketing Hub (Copy)")? Or does the user name it before cloning?
3. **Import version compatibility:** How are older config versions handled on import? Silent migration, warning, or rejection?
4. **Template permissions:** Can any project member create/edit templates, or is this restricted to admins?
5. **Browse All Templates view:** What metadata is shown? Is there search, filtering by permission mode, sorting by usage count? The design mentions the action but does not wire-frame the browse view.
6. **Security gate for imports:** Is the security gate shown before or after the import API call? If after (API validates then returns permission info), the UI needs a two-step flow. If before, the UI must parse the config client-side to detect permission mode.

## Edge Cases

1. **No existing connectors to clone:** The Clone Existing section should either be hidden or show an empty state ("No existing SharePoint connectors to clone from") when this is the first SharePoint connector — though normally the entire dialog would be skipped for connector #1.
2. **All existing connectors in error state:** If no connectors have status "active" or "syncing", the Clone section should show a disabled state with explanation.
3. **Cross-tenant clone with permission-aware search:** Both the cross-tenant notice (site selections cleared) AND the security gate (permission re-acknowledgment) must be shown. Order: security gate first, then cross-tenant notice on the resulting connector's Connect tab.
4. **Invalid import file:** Malformed JSON/YAML, missing required fields, or unrecognized schema version. The UI must show field-level validation errors, not a generic failure.
5. **Import with credentials present:** If the uploaded config contains OAuth credentials (from a manual edit), the API must strip or reject them. The UI should show a notice: "Authentication credentials were removed from the imported configuration for security."
6. **Template deleted between list and apply:** If the user selects a template that was deleted by another user before they click confirm, the API returns 404. The UI should show "This template is no longer available" and refresh the template list.
7. **Concurrent clone attempts:** Two users cloning the same source simultaneously — both should succeed as independent connectors (no conflict).
8. **Large template list:** The Browse All Templates view needs pagination or virtual scrolling if the project has many templates.
9. **Import with permission-aware search enabled:** When an imported config has permission-aware search enabled, the UI must detect the permission mode (client-side parse), show the Template Security Gate before calling the import API, collect the security decision, and then pass it to the API. This multi-step flow (import -> parse -> detect permission mode -> show security gate -> API call) should be handled as a distinct UX sequence.

## Out of Scope

- Template CRUD management UI (editing, deleting, versioning templates) — separate card
- Config version history and diff viewer (§9b) — covered by C-12 (Config Management & History)
- Export configuration flow (§9a) — covered by a separate card
- Config drift detection from template — covered by C-12 (Config Management & History)
- Danger zone operations (delete synced content, purge) — separate card
- The actual connector setup flow after the method is chosen (Connect tab, auth, discovery) — covered by C-02 through C-07
- CLI/API tool implementation — backend concern

## Resolution Log

**Resolved from verification-batch-4 findings (2026-03-24):**

| #   | Finding                                                                                               | Severity | Resolution                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Missing "Round-trip" workflow hint from Import section wireframe                                      | LOW      | **Fixed.** Added "Round-trip workflow hint" bullet under Import Configuration UI behavior with the exact text from §8 wireframe line 2562.                                                                                                     |
| 2   | Assumption 4 contradicts Open Question 1 (template scope asserted and questioned simultaneously)      | MEDIUM   | **Fixed.** Replaced Assumption 4's assertion ("project-scoped") with an `[OPEN — see OQ #1]` marker that defers to the open question. The assumption now states the scope is unspecified by design and must be resolved before implementation. |
| 3   | Out of Scope items 3 and 4 incorrectly reference C-11 instead of C-12                                 | LOW      | **Fixed.** Updated both Out of Scope items to reference "C-12 (Config Management & History)" instead of "C-11 or similar" / "the version history card".                                                                                        |
| 4   | Edge case gap: imported config with permission-aware search triggers a multi-step flow not documented | LOW      | **Fixed.** Added Edge Case #9 documenting the import -> parse -> detect permission mode -> security gate -> API call sequence.                                                                                                                 |
