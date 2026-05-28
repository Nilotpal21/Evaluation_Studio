# SharePoint Connector UX -- Wave 2 LLD (Setup Flow)

**HLD Reference:** sharepoint-connector-ux.hld.md
**Wave:** 2 of 4 -- Setup Flow (Connect, Proposal, Scope+Filters, Preview, Approve, Wiring)
**Tasks:** T-13 to T-25
**Builds on:** Wave 1 foundation (useConnector, useConnectorStore, SharePointDetailPanel, TypeToConfirmInput)

---

## Task T-13: Create Connect Tab (First-Time + Returning UX, Auth Method Selection)

### Problem

The Connect tab is the entry point for establishing a SharePoint connection. It must provide two distinct experiences:

1. **First-time** (0 existing SharePoint connectors in this KB): conversational welcome, two radio card options (Azure App Registration or Sign in with Microsoft), deferred connector name.
2. **Returning** (1+ existing): compact numbered-step form, mandatory connector name, Client ID + Tenant ID fields, three auth method radio options, expandable IT admin guide.

Both experiences include a Connection Scopes display (read-only) with a type-to-confirm disable flow for permission-aware search (uses `TypeToConfirmInput` from Wave 1 T-11).

Currently, `EnterpriseConnectorWizard.tsx` (595 lines, at `apps/studio/src/components/search-ai/EnterpriseConnectorWizard.tsx`) handles all of this in a 5-step wizard. The Connect tab replaces steps 1-2 of that wizard.

### Files to Modify

- `apps/studio/src/api/search-ai.ts` -- Add `checkConnectorName()` API function (line ~2100 area, after existing connector functions)

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/ConnectTab.tsx` -- Main Connect tab component
- `apps/studio/src/components/search-ai/sharepoint/AuthMethodSelector.tsx` -- Radio cards (first-time) / radio options (returning)
- `apps/studio/src/components/search-ai/sharepoint/ConnectionScopesDisplay.tsx` -- Read-only scopes checklist + disable flow
- `apps/studio/src/components/search-ai/sharepoint/ITAdminGuide.tsx` -- Expandable guide with send-to-admin + self-service steps

> **Note:** `apps/studio/src/hooks/useConnectorProposal.ts` is owned by T-16 (ST-16.1). T-13 does NOT create or modify this file. If T-13 needs proposal data, import the hook from T-16's file after T-16 is complete (T-16 runs in Batch 5, after T-13 in Batch 3).

### Component Interfaces

```tsx
// ConnectTab.tsx

interface ConnectTabProps {
  indexId: string;
  connectorId: string | null; // null when creating new
  onAuthComplete: () => void; // triggers proposal generation
  onConnectorCreated: (connectorId: string) => void;
}

// Internal state:
// - Determines first-time vs returning by calling useConnectorList(indexId)
//   and filtering by connectorType === 'sharepoint'
// - Uses useConnector(indexId, connectorId) when resuming a draft
// - Auth polling via useConnectorSync or direct SWR on auth/status endpoint
```

```tsx
// AuthMethodSelector.tsx

type FirstTimeAuthMethod = 'app_registration' | 'microsoft_signin';
type ReturningAuthMethod = 'device_code' | 'authorization_code' | 'client_credentials';

interface AuthMethodSelectorProps {
  variant: 'first-time' | 'returning';
  selectedMethod: FirstTimeAuthMethod | ReturningAuthMethod | null;
  onMethodChange: (method: FirstTimeAuthMethod | ReturningAuthMethod) => void;
}

// First-time variant: renders 2 radio Card components
//   - "Azure App Registration (production)" card
//   - "Sign in with Microsoft (quick setup)" card
// Returning variant: renders 3 RadioGroup options
//   - Device Code, Browser Login, App-Only (Client Credentials)
```

```tsx
// ConnectionScopesDisplay.tsx

interface ConnectionScopesDisplayProps {
  permissionAwareEnabled: boolean;
  onDisablePermissionAware: () => void;
  disabledBy?: { email: string; date: string } | null;
}

// Uses TypeToConfirmInput from '../../../ui/TypeToConfirmInput'
// confirmText="public access"
// Renders: base scope checklist (static), permission-aware section,
//   "[I need to disable this...]" expand link, type-to-confirm panel
```

```tsx
// ITAdminGuide.tsx

interface ITAdminGuideProps {
  onSendToAdmin: () => void;
  loading?: boolean;
}

// Collapsible section: "Don't have an app registration?"
// Two options: Send Setup Request to IT Admin, Self-service 6-step guide
```

### Function Signatures (Studio API additions)

**Before:** No `checkConnectorName` function exists in `apps/studio/src/api/search-ai.ts`.

**After:**

```ts
// apps/studio/src/api/search-ai.ts (add after fetchEnterpriseConnectors at ~line 2078)

export async function checkConnectorName(
  indexId: string,
  name: string,
): Promise<{ available: boolean; suggestion?: string }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/check-name?name=${encodeURIComponent(name)}`),
    { method: 'GET' },
  );
  return response.data;
}

export async function generateAdminEmail(
  indexId: string,
  type: string,
): Promise<{ subject: string; body: string; mailto: string }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/generate-admin-email`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    },
  );
  return response.data;
}
```

### i18n Keys

Namespace: `search_ai.sharepoint.connect` under `packages/i18n/locales/en/studio.json`

> **Implementation note:** This uses 3 levels of JSON nesting (`search_ai` → `sharepoint` → `connect`). Verify the JSON structure in `studio.json` matches this nesting depth. next-intl supports it but the hierarchy must be consistent.

Keys:

- `welcome_title`: "Let us get you connected to SharePoint"
- `welcome_description`: "This takes about 3 minutes. After authentication..."
- `name_label`: "Connector name"
- `name_placeholder`: "e.g., Marketing SharePoint, Engineering Docs"
- `name_help_first_time`: "Optional now -- system will suggest after discovery"
- `name_help_returning`: "Required. Shown in sources list, panel header, and alerts."
- `name_taken`: "This name is already in use. Suggestion: {{suggestion}}"
- `auth_app_registration_title`: "Azure App Registration"
- `auth_app_registration_subtitle`: "For automated sync, delegation, and enterprise deployment"
- `auth_microsoft_signin_title`: "Sign in with Microsoft"
- `auth_microsoft_signin_subtitle`: "Try the connector quickly. No Client ID needed."
- `auth_device_code`: "Device Code"
- `auth_browser_login`: "Browser Login"
- `auth_client_credentials`: "App-Only (Client Credentials)"
- `client_id_label`: "Client ID (Application ID)"
- `tenant_id_label`: "Tenant ID (Directory ID)"
- `client_secret_label`: "Client Secret"
- `scopes_base_title`: "Base capabilities (always included)"
- `scopes_permission_aware_title`: "Permission-aware search"
- `scopes_permission_aware_description`: "Search results respect SharePoint access controls."
- `scopes_disable_link`: "I need to disable this..."
- `configure_before_auth`: "While you wait for authentication, you can configure scope, filters, and schedule..."
- `admin_consent_note`: "Entering the device code signs you in. It does NOT grant admin consent..."
- `btn_cancel`: "Cancel"
- `btn_continue`: "Continue"
- `btn_connect`: "Connect"

### Subtasks (execution order)

1. **ST-13.1:** Create `AuthMethodSelector.tsx`. Read `Card` component signature from `apps/studio/src/components/ui/Card.tsx` and `RadioGroup` from `apps/studio/src/components/ui/RadioGroup.tsx` before implementation. First-time variant renders two clickable `Card` components with selected state (border highlight). Returning variant renders `RadioGroup` with three options. Both use `const t = useTranslations('search_ai.sharepoint.connect');`.
2. **ST-13.2:** Create `ConnectionScopesDisplay.tsx`. Import `TypeToConfirmInput` from `'../../ui/TypeToConfirmInput'` (Wave 1 T-11). The disable flow uses an `expanded` state boolean controlled by the "[I need to disable this...]" link. When confirmed, calls `onDisablePermissionAware()` and shows the post-disable warning.
3. **ST-13.3:** Create `ITAdminGuide.tsx`. Collapsible section using a controlled expand state with a `Button variant="ghost"` trigger plus conditional rendering (NOT native `details`/`summary` — use controlled state for consistent design system styling). Contains two sub-options. "Send to Admin" calls `onSendToAdmin()` which triggers the `generateAdminEmail()` API call.
4. **ST-13.4:** Create `ConnectTab.tsx`. Orchestrates the sub-components. Import `useConnectorList` from `'../../../hooks/useConnectorList'`. Determines first-time vs returning by checking `useConnectorList(indexId).connectors.filter(c => c.connectorType === 'sharepoint').length`. Handles form state: name, clientId, tenantId, clientSecret, authMethod, permissionAwareSearch. On "Continue"/"Connect" click: (a) create connector via `createEnterpriseConnector()` if new, (b) call `initiateConnectorAuth()`, (c) handle auth response based on method type (redirect URL, device code display, or immediate success). Poll auth status via SWR with `refreshInterval: 3000` when auth is pending.
5. **ST-13.5:** Add `checkConnectorName()` and `generateAdminEmail()` to `apps/studio/src/api/search-ai.ts`. Follow the `apiFetch(engineUrl(...))` pattern used by existing functions (e.g., `fetchEnterpriseConnectors` at line 2072).
6. **ST-13.6:** Add i18n keys to `packages/i18n/locales/en/studio.json` under the `search_ai.sharepoint.connect` namespace.
7. **ST-13.7:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: First-time experience renders 2 radio cards and no Client ID/Tenant ID fields.
  - Verify: Component test with `useConnectorList` returning 0 SharePoint connectors
  - Expected: Two card elements visible, no input fields for clientId/tenantId
- AC-02: Returning experience renders Client ID + Tenant ID fields and 3 auth method radio options.
  - Verify: Component test with `useConnectorList` returning 1+ SharePoint connectors
  - Expected: Two UUID input fields and three radio options visible
- AC-03: Connection Scopes disable flow requires typing "public access" before enabling Confirm button.
  - Verify: Component test expanding the disable section, typing partial text
  - Expected: Confirm button disabled until exact match
- AC-04: Auth initiation calls `initiateConnectorAuth()` and polls status every 3s.
  - Verify: Component test mocking auth/initiate response, checking SWR refreshInterval
  - Expected: `refreshInterval` set to 3000ms after auth initiation
- AC-05: `pnpm build --filter=@agent-platform/studio` succeeds.
  - Verify: `pnpm build --filter=@agent-platform/studio`
  - Expected: Exit code 0

### Dependencies

- **T-10** (SharePointDetailPanel shell) -- ConnectTab renders inside the panel
- **T-08** (SWR hooks) -- uses `useConnector`, `useConnectorList`
- **T-11** (TypeToConfirmInput) -- used by ConnectionScopesDisplay

### Risk Notes

- The first-time "Sign in with Microsoft" option maps to `authorization_code` auth method under the hood with `Sites.Read.All` scope automatically (no scope selector). The backend `initiateAuth()` at `connector.service.ts` line 436 already handles this.
- The GUID_VALIDATOR pattern from `EnterpriseConnectorWizard.tsx` (line 111) should be reused for Client ID / Tenant ID validation: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
- Auth popup blocking is a known edge case. Detect via `window.open()` returning null and show a fallback message offering Device Code as alternative.

---

## Task T-14: Create ProposalState Model + Proposal Generation Service

### Problem

The Configuration Proposal is the heart of the setup flow. After authentication completes, the system generates a proposal by orchestrating 9 dependent steps: Connection, Scopes, Health Check, Scope, Filters, Schedule, Permissions, Sample Preview, Security Gate. No `ProposalState` model or proposal generation service exists today.

The proposal generation orchestrates existing discovery (`POST /connectors/:connectorId/discover`), recommendation (`POST /connectors/:connectorId/recommendations`), and filter preview (`POST /connectors/:connectorId/filters/preview`) endpoints defined in `apps/search-ai/src/routes/connector-discovery.ts` and `apps/search-ai/src/routes/connectors.ts`.

### Files to Modify

- `packages/database/src/index.ts` -- Add export for ProposalState model
- `apps/search-ai/src/server.ts` (line ~185) -- Import and mount proposal routes

### Files to Create

- `packages/database/src/models/proposal-state.model.ts` -- Mongoose model
- `apps/search-ai/src/services/proposal.service.ts` -- Proposal generation orchestrator + section review service
- `apps/search-ai/src/routes/connector-proposal.ts` -- Express routes (20 endpoints)

### Model Schema

```ts
// proposal-state.model.ts

export type ProposalStatus = 'generating' | 'ready' | 'approved' | 'failed' | 'abandoned';
export type GenerationStepStatus = 'pending' | 'in_progress' | 'done' | 'waiting' | 'failed';
export type SectionReviewStatus = 'pending' | 'accepted' | 'modified' | 'skipped';

export interface IGenerationStep {
  id: string;
  label: string;
  status: GenerationStepStatus;
  statusText: string;
  dependsOn: string[];
  startedAt?: Date;
  completedAt?: Date;
}

export interface ISectionData {
  status: SectionReviewStatus;
  data: Record<string, unknown>;
  reviewedAt?: Date;
  reviewedBy?: string;
}

export interface IDecisionEntry {
  timestamp: Date;
  user: string;
  section: string;
  decision: 'accept' | 'modify' | 'skip' | 'disable' | 'accept_all';
  detail?: string;
}

export interface IProposalState {
  _id: string;
  connectorId: string;
  tenantId: string;
  status: ProposalStatus;
  generationSteps: IGenerationStep[];
  sections: Record<string, ISectionData>;
  decisions: IDecisionEntry[];
  generatedAt?: Date;
  approvedAt?: Date;
  approvedBy?: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// Import uuidv7 — follow the pattern from existing Wave 1 models:
// connector-audit-entry.model.ts and connector-config-version.model.ts
import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// Schema
const ProposalStateSchema = new Schema<IProposalState>(
  {
    _id: { type: String, default: uuidv7 },
    connectorId: { type: String, required: true },
    tenantId: { type: String, required: true },
    status: {
      type: String,
      enum: ['generating', 'ready', 'approved', 'failed', 'abandoned'],
      default: 'generating',
    },
    generationSteps: [
      {
        id: String,
        label: String,
        status: { type: String, enum: ['pending', 'in_progress', 'done', 'waiting', 'failed'] },
        statusText: String,
        dependsOn: [String],
        startedAt: Date,
        completedAt: Date,
      },
    ],
    sections: { type: Schema.Types.Mixed, default: {} },
    decisions: [
      {
        timestamp: { type: Date, default: Date.now },
        user: String,
        section: String,
        decision: { type: String, enum: ['accept', 'modify', 'skip', 'disable', 'accept_all'] },
        detail: String,
      },
    ],
    generatedAt: Date,
    approvedAt: Date,
    approvedBy: String,
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'proposal_states' },
);

// Indexes
ProposalStateSchema.index({ tenantId: 1, connectorId: 1, status: 1 }); // Primary query
ProposalStateSchema.index(
  { tenantId: 1, connectorId: 1 },
  { unique: true, partialFilterExpression: { status: { $nin: ['abandoned', 'failed'] } } },
); // One active proposal per connector (abandoned/failed excluded so re-creation works)

// Plugins
ProposalStateSchema.plugin(tenantIsolationPlugin);

// Registry
ModelRegistry.registerModelDefinition('ProposalState', ProposalStateSchema, 'platform');

// Model — hot-reload safe export (prevents "Cannot overwrite model" in dev)
export const ProposalState =
  (mongoose.models.ProposalState as mongoose.Model<IProposalState>) ||
  model<IProposalState>('ProposalState', ProposalStateSchema);
```

### Service Signatures

```ts
// proposal.service.ts

import { createLogger } from '@abl/compiler/platform';
import type { IProposalState, ISectionData, IDecisionEntry } from '@agent-platform/database/models';

const logger = createLogger('proposal-service');

// ─── Generation ──────────────────────────────────────────────────────────

/** Start proposal generation (called after auth completes).
 *  Creates the ProposalState document and returns it immediately.
 *  The 9-step pipeline runs asynchronously in the background.
 *  Route handler returns HTTP 202; frontend polls GET /proposal/status. */
export async function startGeneration(
  connectorId: string,
  tenantId: string,
): Promise<IProposalState>;

/** Get generation progress (for polling) */
export async function getGenerationStatus(
  connectorId: string,
  tenantId: string,
): Promise<{ status: IProposalState['status']; steps: IProposalState['generationSteps'] }>;

/** Get full proposal (after generation completes) */
export async function getProposal(connectorId: string, tenantId: string): Promise<IProposalState>;

// ─── Section Review ──────────────────────────────────────────────────────

/** Accept a section with current recommended data */
export async function acceptSection(
  connectorId: string,
  tenantId: string,
  sectionId: string,
  actor: string,
): Promise<ISectionData>;

/** Modify a section with user-provided data */
export async function modifySection(
  connectorId: string,
  tenantId: string,
  sectionId: string,
  data: Record<string, unknown>,
  actor: string,
): Promise<ISectionData>;

/** Skip a section */
export async function skipSection(
  connectorId: string,
  tenantId: string,
  sectionId: string,
  actor: string,
): Promise<ISectionData>;

/** Accept all remaining unreviewed sections */
export async function acceptAllRemaining(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<IProposalState>;

/** Approve the proposal and trigger sync */
export async function approveProposal(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<{ syncJobId: string }>;

/** Abandon connector setup (deletes or marks cancelled) */
export async function abandonProposal(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<{ abandoned: boolean }>;

// ─── Utilities ───────────────────────────────────────────────────────────

/** Refresh sample preview (re-run preview with current filters) */
export async function refreshSamplePreview(
  connectorId: string,
  tenantId: string,
): Promise<ISectionData>;

/** Validate sites for Sites.Selected access */
export async function validateSites(
  connectorId: string,
  tenantId: string,
  siteUrls: string[],
): Promise<{ valid: boolean; results: { url: string; accessible: boolean; error?: string }[] }>;

/** Re-run health check */
export async function rerunHealthCheck(
  connectorId: string,
  tenantId: string,
): Promise<ISectionData>;

/** Disable permission-aware search (type-to-confirm) */
export async function disablePermissionAware(
  connectorId: string,
  tenantId: string,
  confirmationText: string,
  actor: string,
): Promise<{ disabled: boolean; auditRecord: { disabledBy: string; disabledAt: Date } }>;

/** Get config summary (aggregates proposal sections + connector config for Preview/Approve views) */
export async function getConfigSummary(
  connectorId: string,
  tenantId: string,
  indexId: string,
): Promise<{
  connection: { authMethod: string; tenantId: string; clientId: string };
  scope: { variant: string; siteCount: number; sites: string[] };
  filters: {
    template: string;
    fileTypes: string[];
    dateRange?: { after?: string; before?: string };
  };
  schedule: { frequency: string; nextRun?: string };
  permissions: { mode: string; permissionAwareEnabled: boolean };
  security: { status: string; approvalRequired: boolean };
  estimatedSyncMinutes: number;
  totalDocuments: number;
  estimatedSizeBytes: number;
}>;

/** Export proposal as PDF/JSON/YAML */
export async function exportProposal(
  connectorId: string,
  tenantId: string,
  format: 'pdf' | 'json' | 'yaml',
): Promise<{ data: string | Buffer; contentType: string; filename: string }>;
```

### Generation Steps (9 items with dependencies)

```ts
const GENERATION_STEPS: IGenerationStep[] = [
  { id: 'connection', label: 'Connection', status: 'pending', statusText: '', dependsOn: [] },
  { id: 'scopes', label: 'Scopes', status: 'pending', statusText: '', dependsOn: ['connection'] },
  {
    id: 'health-check',
    label: 'Health Check',
    status: 'pending',
    statusText: '',
    dependsOn: ['scopes'],
  },
  {
    id: 'scope',
    label: 'Scope',
    status: 'pending',
    statusText: '',
    dependsOn: ['health-check'],
  },
  { id: 'filters', label: 'Filters', status: 'pending', statusText: '', dependsOn: ['scope'] },
  {
    id: 'schedule',
    label: 'Schedule',
    status: 'pending',
    statusText: '',
    dependsOn: ['health-check'],
  },
  {
    id: 'permissions',
    label: 'Permissions',
    status: 'pending',
    statusText: '',
    dependsOn: ['scopes'],
  },
  {
    id: 'sample-preview',
    label: 'Sample Preview',
    status: 'pending',
    statusText: '',
    dependsOn: ['filters'],
  },
  {
    id: 'security-gate',
    label: 'Security Gate',
    status: 'pending',
    statusText: '',
    dependsOn: [
      'connection',
      'scopes',
      'health-check',
      'scope',
      'filters',
      'schedule',
      'permissions',
      'sample-preview',
    ],
  },
];
```

### Generation Logic

`startGeneration()` creates a `ProposalState` document with status `'generating'` and all steps in `'pending'`, then **returns immediately** (the route handler responds with HTTP 202 and the initial ProposalState). The 9-step pipeline runs asynchronously in the background via a fire-and-forget pattern with error handling:

```ts
// In the route handler:
const proposal = await proposalService.startGeneration(connectorId, tenantId);
res.status(202).json({ success: true, data: proposal });
// Pipeline runs in background — frontend polls GET /proposal/status

// In the service:
export async function startGeneration(
  connectorId: string,
  tenantId: string,
): Promise<IProposalState> {
  const proposal = await ProposalState.create({
    connectorId,
    tenantId,
    status: 'generating',
    generationSteps: GENERATION_STEPS,
  });
  // Fire-and-forget with error handling
  runGenerationPipeline(proposal._id, connectorId, tenantId).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Generation pipeline failed for connector ${connectorId}: ${msg}`);
    await ProposalState.findOneAndUpdate(
      { _id: proposal._id, tenantId },
      { $set: { status: 'failed' } },
    );
  });
  return proposal;
}
```

**Timeouts:** Each step has a 30-second timeout. The overall pipeline has a 3-minute timeout. If a step exceeds its timeout, it is marked `'failed'` and the pipeline transitions the proposal to `'failed'` status.

The pipeline processes steps in dependency order:

1. **Connection**: Read connector config from `ConnectorConfig`. Extract tenant, clientId, authMethod, token expiry. Always succeeds if connector exists.
2. **Scopes**: Read granted scopes from OAuth token. Determine `scopeVariant` (`sites_read_all` or `sites_selected`).
3. **Health Check**: Call Graph API `/me` and `/sites/root` for connectivity. Check token validity. Evaluate granted scopes against required scopes. Return pass/fail/warn per check.
4. **Scope**: If `sites_read_all`: trigger discovery via existing `triggerDiscovery()` from `apps/search-ai/src/services/setup/quick-setup-orchestrator.ts` (line 76 of connector-discovery.ts). Wait for discovery completion. Generate site recommendations via `generateRecommendations()`. If `sites_selected`: use manually provided site URLs.
5. **Filters**: Build default filter config based on discovery profile. Apply draft-mode pre-configured filters if they exist.
6. **Schedule**: Determine recommended frequency based on document count and change rate from discovery.
7. **Permissions**: Set default mode (`enabled`). If `GroupMember.Read.All` not in granted scopes, note reduced accuracy.
8. **Sample Preview**: Call `previewFilters()` service function (at `connector.service.ts` line 833) with the proposed filter config. Return 20-doc sample.
9. **Security Gate**: Aggregate all section data. Determine if security approval is required (based on scope breadth, permission mode).

Each step update writes to the `ProposalState` document via `findOneAndUpdate({ connectorId, tenantId })`.

### Subtasks (execution order)

1. **ST-14.1:** Create `proposal-state.model.ts` with schema, indexes, plugin, and ModelRegistry registration. Export types (`IProposalState`, `ProposalStatus`, `GenerationStepStatus`, `SectionReviewStatus`) from `packages/database/src/models/index.ts` and re-export the model from `packages/database/src/index.ts`.
2. **ST-14.2:** Create `proposal.service.ts` with all function signatures. Implement `startGeneration()` with the 9-step pipeline. Each step is a private function that reads the connector, performs its check, and updates the ProposalState document. Use `findOneAndUpdate` with `{ new: true }` to return the updated document.
3. **ST-14.3:** Implement `acceptSection()`, `modifySection()`, `skipSection()`. Each updates `sections[sectionId].status` and appends to `decisions[]`. All queries include `tenantId` (tenant isolation).
4. **ST-14.4:** Implement `acceptAllRemaining()`. Iterate all sections where `status === 'pending'`, set each to `'accepted'` with the recommended data. Append one `accept_all` decision entry.
5. **ST-14.5:** Implement `approveProposal()`. Apply final configuration to the connector via `updateConnector()` (connector.service.ts line 335), then call `startSync()` (line 891). Write audit entry via `writeAuditEntry()` from T-06.
6. **ST-14.6:** Implement `abandonProposal()`. Set proposal status to `'abandoned'`. Delete the connector via `deleteConnector()` (line 366).
7. **ST-14.7:** Implement utility functions: `refreshSamplePreview()`, `validateSites()`, `rerunHealthCheck()`, `disablePermissionAware()`, `exportProposal()`, `getConfigSummary()`. The `getConfigSummary()` function aggregates proposal sections and connector config into a read-only summary consumed by T-20 (PreviewTab) and T-21 (ApproveAndStart).
8. **ST-14.8:** Build: `pnpm build --filter=@agent-platform/database --filter=search-ai`.

### Acceptance Criteria

- AC-01: `ProposalState` is registered with ModelRegistry as `'platform'` affinity.
  - Verify: `ModelRegistry.getPlatformModels().some(m => m.name === 'ProposalState')`
  - Expected: `true`
- AC-02: `startGeneration()` creates a ProposalState with 9 generation steps and status `'generating'`.
  - Verify: Unit test calling `startGeneration()` and checking returned document
  - Expected: `status === 'generating'`, `generationSteps.length === 9`
- AC-03: `acceptSection()` updates the section status and appends a decision entry, scoped to `tenantId`.
  - Verify: Unit test calling `acceptSection('scope', ...)` and reading back
  - Expected: `sections.scope.status === 'accepted'`, `decisions.length === 1`
- AC-04: `approveProposal()` calls `startSync()` and returns a `syncJobId`.
  - Verify: Unit test with mocked `startSync()` returning a job ID
  - Expected: `syncJobId` is non-empty string
- AC-05: Partial unique index prevents creating two active proposals for the same connector but allows re-creation after abandon.
  - Verify: (a) Unit test attempting to create two active proposals for the same connectorId → Mongoose duplicate key error. (b) Unit test creating a proposal, abandoning it, then creating a new one → succeeds.
  - Expected: (a) duplicate key error, (b) new proposal created successfully

### Dependencies

- **T-06** (ConnectorAuditEntry) -- `approveProposal()` writes audit entries
- Wave 1 T-08 SWR hooks (for frontend consumption, not used directly in this backend task)

### Risk Notes

- Proposal generation orchestrates multiple async operations (discovery, health check, preview). If any step fails, the proposal transitions to `'failed'` with the error step marked. The UI can display a "Retry" button that re-runs from the failed step.
- The partial unique index `{ tenantId, connectorId }` with `partialFilterExpression: { status: { $nin: ['abandoned', 'failed'] } }` ensures only one active proposal per connector. Abandoned or failed proposals are excluded from the uniqueness constraint, allowing users to abandon a proposal and create a new one without manual cleanup. Regenerating from a non-terminal state still requires abandoning first.
- Discovery (step 4) can take 10-30s depending on the number of sites. The polling interval should be 2-3s for the frontend.

---

## Task T-15: Create Proposal Routes (20 Endpoints)

### Problem

The HLD defines 20+ proposal API endpoints. These are thin route handlers that delegate to `proposal.service.ts` (T-14). The routes follow the same pattern as existing `connectors.ts` routes: auth middleware applied, `handleError()` for error handling, Zod validation for params/body.

### Files to Create

- `apps/search-ai/src/routes/connector-proposal.ts` -- Express router with proposal endpoints

### Files to Modify

- `apps/search-ai/src/server.ts` (line ~185) -- Import and mount proposal router

### Route Definitions

```
# Generation & Status
POST   /:indexId/connectors/:connectorId/proposal/generate   → startGeneration() — returns 202 with initial proposal state, runs pipeline asynchronously
GET    /:indexId/connectors/:connectorId/proposal/status    → getGenerationStatus()
GET    /:indexId/connectors/:connectorId/proposal            → getProposal()

# Section Review
POST   /:indexId/connectors/:connectorId/proposal/sections/:sectionId/accept   → acceptSection()
PUT    /:indexId/connectors/:connectorId/proposal/sections/:sectionId           → modifySection()
POST   /:indexId/connectors/:connectorId/proposal/sections/:sectionId/skip     → skipSection()
POST   /:indexId/connectors/:connectorId/proposal/accept-all                    → acceptAllRemaining()

# Approval & Lifecycle
POST   /:indexId/connectors/:connectorId/proposal/approve        → approveProposal()
DELETE /:indexId/connectors/:connectorId/proposal/abandon         → abandonProposal()

# Config Summary (consumed by T-20 PreviewTab and T-21 ApproveAndStart)
GET    /:indexId/connectors/:connectorId/summary                 → getConfigSummary()

# Utilities
POST   /:indexId/connectors/:connectorId/proposal/scope/validate-sites              → validateSites()
POST   /:indexId/connectors/:connectorId/proposal/preview/refresh                   → refreshSamplePreview()
POST   /:indexId/connectors/:connectorId/proposal/sections/permissions/disable      → disablePermissionAware()
GET    /:indexId/connectors/:connectorId/proposal/export                            → exportProposal()
POST   /:indexId/connectors/:connectorId/proposal/sections/health-check/rerun       → rerunHealthCheck()
POST   /:indexId/connectors/:connectorId/proposal/filters/preview                   → previewFilters() (inline)
```

### Validation Schemas

```ts
const connectorParams = z.object({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const sectionParams = z.object({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
  sectionId: z.string().min(1),
});

const modifySectionBody = z.object({
  data: z.record(z.unknown()),
});

const validateSitesBody = z.object({
  siteUrls: z.array(z.string().url()).min(1).max(100),
});

const disablePermissionBody = z.object({
  confirmationText: z.string().min(1),
});

const exportQuery = z.object({
  format: z.enum(['pdf', 'json', 'yaml']),
});
```

### Subtasks (execution order)

1. **ST-15.1:** Create `connector-proposal.ts`. Import `Router` from express, `proposalService` from `'../services/proposal.service.js'`, `authMiddleware` from `'../middleware/auth.js'`, and `createLogger` from `'@abl/compiler/platform'`. Apply `router.use(authMiddleware)` at the top of the router (matching connectors.ts line 20, connector-audit.ts line 20, connector-config-versions.ts line 20). Create `const logger = createLogger('connector-proposal-routes')`. Implement the `handleError()` pattern from `connectors.ts` (lines 22-37) which requires the module-level logger instance. Import `z` from zod for validation.
2. **ST-15.2:** Implement all route handlers, including `GET /:indexId/connectors/:connectorId/summary` for `getConfigSummary()`. Each handler: validates params/body with Zod `.safeParse()`, extracts `tenantId` from `req.tenantContext!.tenantId`, extracts `actor` from `req.tenantContext!.email ?? req.tenantContext!.userId ?? 'system'`, calls the corresponding service function, returns `{ success: true, data: result }`.
3. **ST-15.3:** Mount in `server.ts`: `import connectorProposalRouter from './routes/connector-proposal.js';` and `app.use('/api/indexes', connectorProposalRouter);` after the existing connector audit mount (line ~185).
4. **ST-15.4:** Build: `pnpm build --filter=search-ai`.

### Acceptance Criteria

- AC-01: `GET /:indexId/connectors/:connectorId/proposal/status` returns generation steps with status.
  - Verify: Integration test with a connector that has a generating proposal
  - Expected: 200 with `{ success: true, data: { status, steps } }`
- AC-02: `POST .../sections/:sectionId/accept` updates the section and returns updated data.
  - Verify: Integration test calling accept for the 'scope' section
  - Expected: 200 with `{ success: true, data: { status: 'accepted' } }`
- AC-03: Invalid `sectionId` returns 400 with Zod validation error.
  - Verify: Integration test with empty sectionId
  - Expected: 400 with validation error
- AC-04: All routes require `tenantId` from auth middleware (no anonymous access).
  - Verify: Integration test without auth headers
  - Expected: 401

### Dependencies

- **T-14** (ProposalState model + service) -- routes delegate to service functions

### Risk Notes

- The 20 endpoints share a common pattern. A helper factory function can reduce boilerplate:
  ```ts
  function proposalRoute(handler: (req: Request, res: Response) => Promise<void>) { ... }
  ```
- The `export` endpoint (GET with query `?format=pdf`) may need `res.setHeader('Content-Disposition', ...)` for file download instead of JSON response.

---

## Task T-16: Create Proposal Tab (Generation Progress, TOC, Section Review)

### Problem

The Proposal tab is the largest frontend component in Wave 2. It renders three states:

1. **Generating**: Animated 9-item checklist showing real-time generation progress (polls `GET /proposal/status`).
2. **Ready**: Table of Contents with status badges per section, section detail views with Accept/Modify/Skip buttons, Accept All Remaining button, export buttons.
3. **Approved**: Read-only summary view.

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/ProposalTab.tsx` -- Main proposal tab
- `apps/studio/src/components/search-ai/sharepoint/ProposalGenerationProgress.tsx` -- Animated checklist
- `apps/studio/src/components/search-ai/sharepoint/ProposalTableOfContents.tsx` -- TOC with badges
- `apps/studio/src/components/search-ai/sharepoint/ProposalSection.tsx` -- Generic section wrapper
- `apps/studio/src/components/search-ai/sharepoint/ProposalScopeSection.tsx` -- Scope section (Variant A/B)
- `apps/studio/src/components/search-ai/sharepoint/ProposalFiltersSection.tsx` -- Filter summary + inline editor
- `apps/studio/src/components/search-ai/sharepoint/ProposalScheduleSection.tsx` -- Schedule summary + inline editor
- `apps/studio/src/components/search-ai/sharepoint/ProposalPermissionsSection.tsx` -- Permission mode + trust note
- `apps/studio/src/components/search-ai/sharepoint/ProposalHealthCheckSection.tsx` -- Health check results
- `apps/studio/src/components/search-ai/sharepoint/ProposalSamplePreview.tsx` -- 20-doc sample table
- `apps/studio/src/components/search-ai/sharepoint/ProposalSecurityGate.tsx` -- Approval gate + export
- `apps/studio/src/components/search-ai/sharepoint/UserDecisionsLog.tsx` -- Decision history display
- `apps/studio/src/hooks/useConnectorProposal.ts` -- SWR hook for proposal data

### Component Interfaces

```tsx
// ProposalTab.tsx

interface ProposalTabProps {
  indexId: string;
  connectorId: string;
  simplifiedView: boolean;
  onNavigateToTab: (tab: string) => void; // for "Modify" in Full View → navigate to Scope+Filters
}
```

```tsx
// ProposalGenerationProgress.tsx

interface ProposalGenerationProgressProps {
  steps: Array<{
    id: string;
    label: string;
    status: 'pending' | 'in_progress' | 'done' | 'waiting' | 'failed';
    statusText: string;
  }>;
}

// Renders an animated checklist. Each item has:
//   - Spinner icon when 'in_progress'
//   - Check icon when 'done'
//   - Clock icon when 'waiting'
//   - X icon when 'failed'
//   - Empty circle when 'pending'
//   - statusText shown inline (e.g., "Discovering sites...")
```

```tsx
// ProposalSection.tsx (generic wrapper)

interface ProposalSectionProps {
  sectionId: string;
  title: string;
  badge: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  actions: Array<{
    label: string;
    variant: 'primary' | 'secondary' | 'ghost';
    onClick: () => void;
    disabled?: boolean;
  }>;
  children: React.ReactNode;
}
```

```tsx
// useConnectorProposal.ts

interface UseConnectorProposalReturn {
  proposal: IProposalState | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

export function useConnectorProposal(
  indexId: string | null,
  connectorId: string | null,
  options?: { pollWhileGenerating?: boolean },
): UseConnectorProposalReturn;
// SWR key: indexId && connectorId ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/proposal` : null
// When pollWhileGenerating is true and status === 'generating': refreshInterval = 2000
// When status !== 'generating': refreshInterval = 0
```

### API Functions (Studio side)

Add to `apps/studio/src/api/search-ai.ts`:

```ts
export async function startProposalGeneration(
  indexId: string,
  connectorId: string,
): Promise<ProposalState> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/generate`),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return response.data;
}

export async function getProposalStatus(
  indexId: string,
  connectorId: string,
): Promise<{
  status: string;
  steps: Array<{ id: string; label: string; status: string; statusText: string }>;
}> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/status`),
    { method: 'GET' },
  );
  return response.data;
}

export async function getProposal(indexId: string, connectorId: string): Promise<ProposalState> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal`),
    { method: 'GET' },
  );
  return response.data;
}

export async function acceptProposalSection(
  indexId: string,
  connectorId: string,
  sectionId: string,
): Promise<{ status: string }> {
  const response = await apiFetch(
    engineUrl(
      `/indexes/${indexId}/connectors/${connectorId}/proposal/sections/${sectionId}/accept`,
    ),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return response.data;
}

export async function modifyProposalSection(
  indexId: string,
  connectorId: string,
  sectionId: string,
  data: Record<string, unknown>,
): Promise<{ status: string }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/sections/${sectionId}`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    },
  );
  return response.data;
}

export async function skipProposalSection(
  indexId: string,
  connectorId: string,
  sectionId: string,
): Promise<{ status: string }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/sections/${sectionId}/skip`),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return response.data;
}

export async function acceptAllRemaining(
  indexId: string,
  connectorId: string,
): Promise<ProposalState> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/accept-all`),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return response.data;
}

export async function approveProposal(
  indexId: string,
  connectorId: string,
): Promise<{ syncJobId: string }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/approve`),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return response.data;
}

export async function abandonProposal(
  indexId: string,
  connectorId: string,
): Promise<{ abandoned: boolean }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/abandon`),
    { method: 'DELETE' },
  );
  return response.data;
}
```

### i18n Keys

Namespace: `search_ai.sharepoint.proposal`

Keys:

- `generating_title`: "Generating your Configuration Proposal..."
- `generating_description`: "Sections will appear as they are ready. This typically takes 30-90 seconds."
- `toc_title`: "Table of Contents"
- `progress_label`: "Progress: {{reviewed}} of {{total}} sections reviewed"
- `accept_all`: "Accept All Remaining"
- `approve_start_sync`: "Approve All & Start Sync"
- `export_pdf`: "Export as PDF"
- `export_json`: "Export JSON"
- `export_yaml`: "Export YAML"
- `section.connection`: "Connection"
- `section.health_check`: "Health Check"
- `section.scope`: "Scope"
- `section.filters`: "Filters"
- `section.schedule`: "Schedule"
- `section.permissions`: "Permissions"
- `section.sample_preview`: "Sample Preview"
- `section.security_gate`: "Security Gate"
- `badge.accepted`: "Accepted"
- `badge.modified`: "Modified"
- `badge.pending`: "Pending"
- `badge.skipped`: "Skipped"
- `badge.reviewed`: "Reviewed"
- `btn.accept`: "Accept"
- `btn.modify`: "Modify"
- `btn.skip`: "Skip"
- `btn.re_authenticate`: "Re-authenticate"
- `btn.re_run`: "Re-run"
- `btn.accept_warnings`: "Accept with warnings"
- `btn.looks_good`: "Looks Good"
- `btn.adjust_filters`: "Adjust Filters"
- `btn.refresh_sample`: "Refresh Sample"
- `btn.abandon`: "Abandon -- Do Not Sync"
- `trust_note`: "We request Sites.Read.All and Files.Read.All -- both read-only..."
- `step_indicator`: "Step {{current}} of {{total}}: {{label}}"

### Subtasks (execution order)

1. **ST-16.1:** Create `useConnectorProposal.ts` SWR hook. Follow the `useConnector` pattern from Wave 1 T-08. Conditional `refreshInterval` based on proposal `status === 'generating'`.
2. **ST-16.2:** Add proposal API functions to `apps/studio/src/api/search-ai.ts`. All use `apiFetch(engineUrl(...))` pattern.
3. **ST-16.3:** Create `ProposalGenerationProgress.tsx`. Animated checklist using Framer Motion `AnimatePresence` for step transitions. Each step uses `motion.div` with `layout` prop for smooth reordering.
4. **ST-16.4:** Create `ProposalSection.tsx` generic wrapper. Collapsible section with header (title + badge), action buttons in footer, children for content.
5. **ST-16.5:** Create `ProposalTableOfContents.tsx`. Renders a list of section entries, each clickable (scrolls to section). Uses `Badge` component for status display.
6. **ST-16.6:** Create section-specific components: `ProposalHealthCheckSection`, `ProposalScopeSection` (with Variant A/B based on `scopeVariant`), `ProposalFiltersSection` (with inline editor for Simplified View), `ProposalScheduleSection`, `ProposalPermissionsSection` (includes `TypeToConfirmInput` for disable flow), `ProposalSamplePreview`, `ProposalSecurityGate`.
7. **ST-16.7:** Create `UserDecisionsLog.tsx`. Read-only list of decision entries with timestamp, user, section, decision type.
8. **ST-16.8:** Create `ProposalTab.tsx`. Orchestrates all sub-components. Uses `useConnectorProposal()` for data. Renders `ProposalGenerationProgress` when `status === 'generating'`, renders TOC + sections when `status === 'ready'`. Handles Accept/Modify/Skip button clicks by calling the corresponding API and mutating the SWR cache. In Simplified View, renders a step progress indicator above the proposal.
9. **ST-16.9:** Add i18n keys.
10. **ST-16.10:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: Generation progress renders 9 items with correct status icons.
  - Verify: Component test with mock generation steps
  - Expected: 9 list items, spinner on `in_progress`, check on `done`
- AC-02: TOC section click scrolls to corresponding section.
  - Verify: Component test clicking a TOC entry
  - Expected: `scrollIntoView` called on the section element
- AC-03: Accept button on a section calls `acceptProposalSection()` and updates the badge.
  - Verify: Component test clicking Accept on the Scope section with mocked API
  - Expected: API called, badge changes to "Accepted"
- AC-04: Simplified View shows 4-step progress indicator above the proposal.
  - Verify: Component test with `simplifiedView: true`
  - Expected: Step indicator visible with step 2 highlighted
- AC-05: `useConnectorProposal` polls at 2s when generating, stops when ready.
  - Verify: Unit test checking SWR `refreshInterval`
  - Expected: 2000 when generating, 0 when ready

### Dependencies

- **T-10** (SharePointDetailPanel) -- ProposalTab renders inside panel
- **T-15** (Proposal routes) -- API endpoints consumed by this tab
- **T-11** (TypeToConfirmInput) -- used in ProposalPermissionsSection

### Risk Notes

- The Proposal tab contains 11 new components, making it the largest single frontend task. **Recommended split:** T-16a (ST-16.1 through ST-16.5: hook + API + ProposalGenerationProgress + ProposalTableOfContents + ProposalSection shell + ProposalTab orchestrator) and T-16b (ST-16.6 through ST-16.7: section-specific components + UserDecisionsLog). The section-specific components in ST-16.6 are independent of each other and can be built in parallel within T-16b.
- The inline editors in Simplified View (for Scope, Filters, Schedule) reuse logic from the full Scope+Filters tab (T-17). To avoid duplication, extract shared form components.
- **i18n pattern:** `ProposalTab.tsx` and `ProposalGenerationProgress.tsx` use `useTranslations('search_ai.sharepoint.proposal')` directly. Section-specific components (ProposalScopeSection, ProposalFiltersSection, etc.) receive translated strings via props from ProposalTab to avoid redundant hook calls.

---

## Task T-17: Create Scope+Filters Split-Pane (Controls + Preview Panels)

### Problem

The Scope+Filters tab provides a 60/40 split-pane layout for iterative filter configuration. The left panel contains all filter controls (sites, file types, dates, templates, folders, size, metadata, condition builder). The right panel shows a live preview with counts, diff, samples, and exclusion reasons. The tab auto-expands the panel to full viewport width (via `useConnectorStore.setExpandedPanel(true)`).

The existing `ConnectorFilterSection.tsx` (691 lines at `apps/studio/src/components/search-ai/ConnectorFilterSection.tsx`) has the filter logic but not the split-pane layout or live preview. This component is ENHANCED with the new layout.

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/ScopeFiltersSplitPane.tsx` -- 60/40 layout wrapper
- `apps/studio/src/components/search-ai/sharepoint/ScopeControlsPanel.tsx` -- Left panel controls
- `apps/studio/src/components/search-ai/sharepoint/ScopePreviewPanel.tsx` -- Right panel preview
- `apps/studio/src/components/search-ai/sharepoint/FilterTemplateSelector.tsx` -- Preset buttons
- `apps/studio/src/hooks/useConnectorDiscovery.ts` -- SWR hook for discovery data
- `apps/studio/src/hooks/useFilterPreview.ts` -- SWR hook for filter preview (debounced)

### Component Interfaces

```tsx
// ScopeFiltersSplitPane.tsx

interface ScopeFiltersSplitPaneProps {
  indexId: string;
  connectorId: string;
  isDraftMode: boolean;
  simplifiedView: boolean;
}

// On mount: calls useConnectorStore.setExpandedPanel(true)
// On unmount: calls useConnectorStore.setExpandedPanel(false)
// Layout: flex with 60% left, 40% right, gap-4
```

```tsx
// ScopeControlsPanel.tsx

interface ScopeControlsPanelProps {
  indexId: string;
  connectorId: string;
  isDraftMode: boolean;
  discovery: DiscoveryData | null;
  filterConfig: FilterConfig;
  onFilterChange: (config: FilterConfig) => void;
}

// Sections:
// 1. Sites list (checkboxes) - disabled in draft mode
// 2. File type checkboxes
// 3. Date range pickers
// 4. Filter templates (FilterTemplateSelector)
// 5. Folder rules (toggle chips + custom glob)
// 6. Size limits (min/max with unit selector)
// 7. People & Metadata
// 8. Advanced (expandable): CEL editor (T-18), Condition builder (T-19)
```

```tsx
// ScopePreviewPanel.tsx

interface ScopePreviewPanelProps {
  preview: FilterPreviewData | null;
  isLoading: boolean;
  onUndo: () => void;
  onReset: () => void;
  canUndo: boolean;
}

// Renders: summary counts, filter diff, undo/reset buttons,
// sample documents table, excluded documents list, exclusion summary,
// OData display (collapsible), filter audit table
```

```tsx
// FilterTemplateSelector.tsx

interface FilterTemplateSelectorProps {
  selected: string;
  onSelect: (templateId: string) => void;
  templates: Array<{ id: string; label: string }>;
}

// Renders: row of toggle-style buttons (Documents Only, Tech Docs, Everything, Custom)
```

```tsx
// useConnectorDiscovery.ts

interface DiscoveryData {
  sites: Array<{
    siteId: string;
    name: string;
    activityScore: number;
    fileCount: number;
    libraryCount: number;
    sizeBytes: number;
    lastModified: string;
    recommended: boolean;
    excludeReason?: string;
  }>;
  fileTypeProfile: Array<{
    mimeType: string;
    extension: string;
    displayName: string;
    count: number;
    indexable: boolean;
  }>;
  metadataFields: Array<{ fieldName: string; type: string; sampleValues?: string[] }>;
}

export function useConnectorDiscovery(connectorId: string | null): {
  discovery: DiscoveryData | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
};
// SWR key: connectorId ? `/api/search-ai/connectors/${connectorId}/discovery` : null
// NOTE: This key path does NOT include indexId, unlike useConnector which uses
// `/api/search-ai/indexes/${indexId}/connectors/${connectorId}`. This is because
// the discovery endpoint is mounted at `app.use('/api', connectorDiscoveryRouter)`
// in server.ts (line ~187), not under `/api/indexes`. Document this in a code comment.
```

```tsx
// useFilterPreview.ts

interface FilterPreviewData {
  matchCount: number;
  excludedCount: number;
  estimatedSyncMinutes: number;
  diff: {
    newlyIncluded: number;
    newlyExcluded: number;
    reasons: Array<{ description: string; count: number }>;
  };
  sampleDocuments: Array<{ name: string; type: string; sizeBytes: number }>;
  excludedDocuments: Array<{ name: string; reason: string }>;
  exclusionSummary: Array<{ category: string; count: number }>;
  perRuleImpact: Array<{
    ruleName: string;
    includeCount: number;
    excludeCount: number;
    netCount: number;
  }>;
  generatedODataFilter: string;
  generatedODataSelect: string;
}

export function useFilterPreview(
  connectorId: string | null,
  filterConfig: FilterConfig | null,
): { preview: FilterPreviewData | null; isLoading: boolean; error: string | null };
// Uses useSWR with a debounced key — only fires after 500ms of no filterConfig changes
// SWR key: connectorId && filterConfig ? ['/api/search-ai/connectors/${connectorId}/filters/preview', JSON.stringify(filterConfig)] : null
// Uses POST via custom fetcher
```

### Filter Configuration Type

```ts
interface FilterConfig {
  selectedSiteIds: string[];
  selectedFileTypes: string[];
  dateRange: { modifiedAfter?: string; modifiedBefore?: string };
  filterTemplate: 'documents-only' | 'tech-docs' | 'everything' | 'custom';
  folderRules: { include: string[]; exclude: string[] };
  sizeLimits: { minBytes?: number; maxBytes?: number };
  metadataConditions: Array<{ field: string; operator: string; value: string }>;
  conditionGroups: Array<{
    logic: 'AND' | 'OR';
    conditions: Array<{ field: string; operator: string; value: string }>;
  }>;
  celExpression?: string;
}
```

### Subtasks (execution order)

1. **ST-17.1:** Create `useConnectorDiscovery.ts` following the SWR pattern from Wave 1 T-08. Key uses the existing `GET /connectors/:connectorId/discovery` endpoint (confirmed in `connector-discovery.ts` line ~80).
2. **ST-17.2:** Create `useFilterPreview.ts`. Uses a POST-based SWR fetcher since `previewFilters` is a POST endpoint (connectors.ts line 204). Debounce using `useDebouncedValue` or a 500ms delay on key change.
3. **ST-17.3:** Create `FilterTemplateSelector.tsx`. Row of button-style toggles. Read `getFilterTemplates` API function signature from `apps/studio/src/api/search-ai.ts` (search for it) or use hardcoded preset list.
4. **ST-17.4:** Create `ScopeControlsPanel.tsx`. Render sections in order: sites list, file types, dates, templates, folders, size, people/metadata, advanced. Each section is collapsible. Sites section shows disabled state in draft mode. File type checkboxes auto-populate from discovery `fileTypeProfile`. Each control change calls `onFilterChange()` with updated config.
5. **ST-17.5:** Create `ScopePreviewPanel.tsx`. Renders preview data from `useFilterPreview`. Skeleton loading state during preview calculation. Undo/Reset buttons. Sample documents in a table using `DataTable` component.
6. **ST-17.6:** Create `ScopeFiltersSplitPane.tsx`. Layout wrapper. On mount, sets `expandedPanel: true`. On unmount or other tab switch, sets `expandedPanel: false`. Manages filter config state with undo history (array of previous configs, max 20 entries). Passes config to `useFilterPreview`.
7. **ST-17.7:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: Split-pane renders with 60/40 width ratio.
  - Verify: Component test checking flex basis values
  - Expected: Left panel `basis-3/5`, right panel `basis-2/5`
- AC-02: Panel auto-expands on tab activation.
  - Verify: Component test checking `useConnectorStore.setExpandedPanel` called with `true` on mount
  - Expected: Store updated
- AC-03: Changing a filter control triggers preview API call after 500ms debounce.
  - Verify: Component test toggling a file type checkbox, checking API call timing
  - Expected: API called after debounce period
- AC-04: Undo button reverts to previous filter configuration.
  - Verify: Component test making a change, clicking undo
  - Expected: Config reverts to previous state
- AC-05: Draft mode shows sites section as disabled with placeholder text.
  - Verify: Component test with `isDraftMode: true`
  - Expected: Sites section shows "Will be populated after authentication and discovery"

### Dependencies

- **T-10** (SharePointDetailPanel) -- renders inside panel
- **T-08** (SWR hooks) -- pattern reference for new hooks

### Risk Notes

- **Auth gap:** The `connector-discovery.ts` router does NOT currently apply `authMiddleware` at the router level. The `useConnectorDiscovery` hook calls `GET /connectors/:connectorId/discovery` which hits this router. Verify that auth is handled by global middleware in `server.ts` before relying on these endpoints in production. If auth is not provided globally, add `router.use(authMiddleware)` to `connector-discovery.ts` before Wave 2 implementation.
- The live preview debounce at 500ms needs testing with large filter configs. If the preview API takes >3s, consider a loading skeleton that persists until the new data arrives rather than showing stale data.
- The undo history is kept in component state (not Zustand), limited to 20 entries. This is sufficient for a single editing session.
- The existing `ConnectorFilterSection.tsx` interface (`ConnectorFilterSectionProps` at line 41) is NOT reused directly -- the new components have different props. However, the filter API functions (`updateConnectorConfig`, `getFilterTemplates`, `applyFilterTemplate`, `previewFilters` from `apps/studio/src/api/search-ai.ts`) are reused.

---

## Task T-18: Create CELExpressionEditor with Autocomplete + Validation

### Problem

Power users need a CEL (Common Expression Language) editor for advanced filter expressions. The editor requires syntax highlighting, field autocomplete on `resource.[field]`, value autocomplete from discovery data, and validation with error position/description/fix.

No CEL editor component exists in the codebase.

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/CELExpressionEditor.tsx` -- Editor component

### Component Interface

```tsx
// CELExpressionEditor.tsx

interface CELExpressionEditorProps {
  value: string;
  onChange: (value: string) => void;
  onValidate: () => void;
  validationResult?: {
    valid: boolean;
    error?: { position: number; description: string; suggestion?: string };
  };
  fieldSuggestions: Array<{ field: string; type: string; sampleValues?: string[] }>;
  valueSuggestions: Record<string, Array<{ value: string; docCount: number }>>;
  disabled?: boolean;
}

// v1: Basic textarea with monospace font, validation button, error display
// v2 (future): Integrate CodeMirror with CEL grammar for syntax highlighting
```

### Subtasks (execution order)

1. **ST-18.1:** Create `CELExpressionEditor.tsx`. v1 implementation uses a `Textarea` component with monospace font. The `[Validate Expression]` button triggers `onValidate()`. Validation result renders below the editor: green check for valid, red error with position indicator for invalid.
2. **ST-18.2:** Implement basic autocomplete: on typing `resource.`, show a dropdown of `fieldSuggestions`. On typing `== "`, show value suggestions for the current field. Use a simple popup positioned relative to the textarea cursor.
3. **ST-18.3:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: Typing `resource.` shows field suggestions dropdown.
  - Verify: Component test typing "resource." with mock field suggestions
  - Expected: Dropdown appears with field names
- AC-02: Validate button triggers validation and displays result.
  - Verify: Component test clicking Validate with a valid expression
  - Expected: Green check icon appears
- AC-03: Invalid expression shows error with position.
  - Verify: Component test with validation error at position 15
  - Expected: Error message displayed with position indicator

### Dependencies

- None (self-contained component)

### Risk Notes

- HLD Risk R3: CEL editor is complex. v1 uses a basic textarea. CodeMirror integration deferred to a future enhancement.
- The autocomplete popup positioning relative to textarea cursor is non-trivial. Consider using a `contentEditable` div instead of textarea for precise cursor tracking, or use a simple dropdown below the editor for v1.

---

## Task T-19: Create ConditionBuilder with 15 Operators + AND/OR

### Problem

The Condition Builder provides a visual field/operator/value interface for non-technical users to build filter conditions without writing CEL. It supports 15 operators (equals, not equals, contains, starts with, ends with, greater than, less than, in list, not in list, exists, not exists, regex match, and 3 more) with AND/OR grouping at one nesting level.

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/ConditionBuilder.tsx` -- Builder component

### Component Interface

```tsx
// ConditionBuilder.tsx

type Operator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'less_than'
  | 'in_list'
  | 'not_in_list'
  | 'exists'
  | 'not_exists'
  | 'regex_match'
  | 'between'
  | 'is_empty';

interface Condition {
  field: string;
  operator: Operator;
  value: string;
}

interface ConditionGroup {
  logic: 'AND' | 'OR';
  conditions: Condition[];
}

interface ConditionBuilderProps {
  groups: ConditionGroup[];
  onChange: (groups: ConditionGroup[]) => void;
  fields: Array<{ name: string; type: string }>;
  disabled?: boolean;
}

// Renders:
// - Each group as a bordered section with AND/OR toggle
// - Each condition as a row: [Field Select] [Operator Select] [Value Input] [Remove X]
// - [+ Add Condition] button per group
// - [+ Add Group] button (max 1 nesting level)
```

### Subtasks (execution order)

1. **ST-19.1:** Create `ConditionBuilder.tsx`. Use `Select` component from `apps/studio/src/components/ui/Select.tsx` (read signature first) for field and operator dropdowns. Use `Input` for value. Each group has an AND/OR toggle (two small buttons or a segmented control). Conditions within a group are joined by the group's logic operator.
2. **ST-19.2:** Implement add/remove condition, add/remove group. Max 1 nesting level (groups cannot contain sub-groups). Max 10 conditions per group.
3. **ST-19.3:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: Renders a condition row with field, operator, and value dropdowns.
  - Verify: Component test with one default group and one condition
  - Expected: Three select/input elements in a row
- AC-02: Adding a condition via [+ Add Condition] appends to the group.
  - Verify: Component test clicking the add button
  - Expected: `onChange` called with group containing 2 conditions
- AC-03: AND/OR toggle changes the group logic operator.
  - Verify: Component test clicking the OR toggle
  - Expected: `onChange` called with `logic: 'OR'`
- AC-04: All 15 operators appear in the operator dropdown.
  - Verify: Component test opening the operator select
  - Expected: 15 options listed

### Dependencies

- None (self-contained component)

### Risk Notes

- The operator list in the design mentions 12 explicitly plus "3 unspecified." The LLD defines all 15: the 12 from the design plus `not_contains`, `between`, and `is_empty`.
- The `in_list` and `not_in_list` operators need a multi-value input (comma-separated or tag input). v1 uses comma-separated text input.

---

## Task T-20: Create Preview Tab (Dry-Run, Content Type Breakdown)

### Problem

The Preview tab shows a dry-run summary of what WOULD be synced before the user approves. It displays: 4 summary stats (doc count, skip count, estimated size, time range), filter change tracking, sample documents table (25 docs), skipped documents table (10), and a content type breakdown horizontal bar chart.

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/PreviewTab.tsx` -- Preview/dry-run view
- `apps/studio/src/components/search-ai/sharepoint/ContentTypeBreakdown.tsx` -- Horizontal bar chart

### Component Interfaces

```tsx
// PreviewTab.tsx

interface PreviewTabProps {
  indexId: string;
  connectorId: string;
  onNavigateToFilters: () => void; // [Adjust Filters] navigates back
  onNavigateToApprove: () => void; // [Approve Sync] navigates forward
}

// Fetches preview data via runPreview(connectorId) — note: no indexId needed
// Uses the connector's current filter config (saved server-side)
```

```tsx
// ContentTypeBreakdown.tsx

interface ContentTypeBreakdownProps {
  data: Array<{
    type: string;
    count: number;
    percentage: number;
  }>;
}

// Renders horizontal bars with proportional widths, labels, counts, and percentages
// Uses Tailwind CSS for bar widths (style={{ width: `${percentage}%` }})
```

### API Function

Add to `apps/studio/src/api/search-ai.ts`:

```ts
export async function runPreview(connectorId: string): Promise<PreviewData> {
  // Note: No indexId needed — the preview endpoint is mounted under /api/connectors (not /api/indexes)
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/filters/preview`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return response.data;
}

export async function getConfigSummary(
  indexId: string,
  connectorId: string,
): Promise<ConfigSummary> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/summary`),
    { method: 'GET' },
  );
  return response.data;
}
```

### Subtasks (execution order)

1. **ST-20.1:** Create `ContentTypeBreakdown.tsx`. Horizontal bar chart using Tailwind. Each bar: type label, proportional width bar with background color, count, percentage. Top 4 types shown individually, remaining grouped as "Other".
2. **ST-20.2:** Create `PreviewTab.tsx`. On mount, fetches preview data via `runPreview()`. Renders: summary stats panel (4 numbers in a grid), filter change tracking (if `hasPreviousPreview`), sample documents table using `DataTable`, skipped documents table, `ContentTypeBreakdown`. Navigation buttons: [Adjust Filters] and [Approve Sync].
3. **ST-20.3:** Add API functions to `search-ai.ts`.
4. **ST-20.4:** Add i18n keys under `search_ai.sharepoint.preview`.
5. **ST-20.5:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: Preview tab renders 4 summary stats from the preview API response.
  - Verify: Component test with mock preview data
  - Expected: Doc count, skip count, size, time range visible
- AC-02: Content type breakdown renders proportional bars.
  - Verify: Component test with 3 content types
  - Expected: 3 bars with proportional widths
- AC-03: [Adjust Filters] button calls `onNavigateToFilters()`.
  - Verify: Component test clicking the button
  - Expected: Callback invoked
- AC-04: Sample documents table shows up to 25 rows.
  - Verify: Component test with 30 sample documents
  - Expected: Table shows 25 rows

### Dependencies

- **T-10** (SharePointDetailPanel) -- renders inside panel

### Risk Notes

- The preview API (`POST /connectors/:connectorId/filters/preview` at connectors.ts line 204) currently returns basic estimate data (line 874-886). The enhanced response format (samples, breakdown, diff) will need backend enhancements. If the backend doesn't return all fields yet, the UI should gracefully handle missing fields with empty states.

---

## Task T-21: Create Approve & Start View (Summary, 3 Actions, Confirmation Dialog)

### Problem

The Approve & Start view is the final checkpoint. It shows a read-only configuration summary, estimated sync time, and three action buttons: Start Sync, Save as Draft, Export Template. Start Sync triggers an inline confirmation dialog.

### Files to Create

- `apps/studio/src/components/search-ai/sharepoint/ApproveAndStart.tsx` -- Approval view

### Component Interface

```tsx
// ApproveAndStart.tsx

interface ApproveAndStartProps {
  indexId: string;
  connectorId: string;
  onSyncStarted: (syncJobId: string) => void; // transitions to Overview tab
  onSaveAsDraft: () => void;
  onExportTemplate: () => void;
}

// Fetches config summary via getConfigSummary()
// Renders: configuration summary block, estimated sync time,
//   [Start Sync] with confirmation dialog, [Save as Draft], [Export Template]
// If security approval pending: [Start Sync] becomes [Submit for Security Approval]
```

### Subtasks (execution order)

1. **ST-21.1:** Create `ApproveAndStart.tsx`. Fetch configuration summary via `getConfigSummary()` (T-20 API function). Render summary sections: Connection, Scope, Filters, Schedule, Permissions, Security. Render 3 action buttons. [Start Sync] opens a `ConfirmDialog` (design system component) with inline text showing doc count and size.
2. **ST-21.2:** On confirmation, call `approveProposal()` API (from T-16). On success, call `onSyncStarted(syncJobId)`. On error, show toast error.
3. **ST-21.3:** Handle security gate override: if `security.status === 'pending'`, button text changes to "Submit for Security Approval".
4. **ST-21.4:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: Configuration summary renders all 6 sections.
  - Verify: Component test with mock config summary
  - Expected: Connection, Scope, Filters, Schedule, Permissions, Security sections visible
- AC-02: [Start Sync] opens confirmation dialog before starting.
  - Verify: Component test clicking Start Sync
  - Expected: ConfirmDialog opens with doc count
- AC-03: Confirming starts sync and calls `onSyncStarted`.
  - Verify: Component test confirming in dialog with mocked API
  - Expected: `onSyncStarted` called with syncJobId
- AC-04: Security pending state shows "Submit for Security Approval" button text.
  - Verify: Component test with `security.status === 'pending'`
  - Expected: Button text changed

### Dependencies

- **T-20** (Preview Tab) -- uses same `getConfigSummary()` API function
- **T-16** (Proposal Tab) -- uses `approveProposal()` API function

### Risk Notes

- The "Export Template" button opens the template creation flow which is fully built in Wave 4 (T-51). For Wave 2, the button renders but is disabled with a tooltip: "Available in a future update".

---

## Task T-22: Create Connection Scopes Display + Disable Flow

### Problem

This task was originally listed as separate from T-13 but the Connection Scopes display is already part of ConnectTab (T-13). After code inspection, this task covers the **standalone reuse** of the scopes display in the Proposal tab's Permissions section and the Security tab. The `ConnectionScopesDisplay` component created in T-13 ST-13.2 needs to be generic enough for reuse.

### Files to Modify

- `apps/studio/src/components/search-ai/sharepoint/ConnectionScopesDisplay.tsx` -- Ensure reusability for Proposal Permissions section

### Subtasks (execution order)

1. **ST-22.1:** Review the `ConnectionScopesDisplay` from T-13. Verify it accepts `permissionAwareEnabled`, `onDisablePermissionAware`, and `disabledBy` props generically (not Connect-tab-specific). Add an optional `compact` prop for inline display within the Proposal Permissions section (fewer margins, smaller text).
2. **ST-22.2:** The Proposal Permissions section (T-16 `ProposalPermissionsSection.tsx`) imports and renders `ConnectionScopesDisplay` with `compact={true}`.
3. **ST-22.3:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: `ConnectionScopesDisplay` renders in both full and compact modes.
  - Verify: Component test rendering with `compact={false}` and `compact={true}`
  - Expected: Different margin/text sizes
- AC-02: Type-to-confirm flow works identically in both contexts.
  - Verify: Component test in compact mode completing the disable flow
  - Expected: `onDisablePermissionAware` called

### Dependencies

- **T-13** (ConnectTab) -- creates the base component
- **T-11** (TypeToConfirmInput) -- used internally

### Risk Notes

- Minimal risk. This is a refinement of T-13's component for cross-context reuse.

---

## Task T-23: Wire Flow A (SetupGuide Opens Dialog on Home Tab)

### Problem

The current `SetupGuide` component (at `apps/studio/src/components/search-ai/home/SetupGuide.tsx` line 105-108) handles "Connect Source" by navigating to the Data tab with `autoOpenAddSource: true`:

```ts
// Current (line 105-108):
const handleConnectSource = useCallback(() => {
  setPendingFilter({ view: 'documents', autoOpenAddSource: true });
  onNavigate?.('data');
}, [setPendingFilter, onNavigate]);
```

The redesign opens the Add Source dialog directly on the Home tab (no tab switch). After the user selects SharePoint and completes setup, THEN navigate to Data tab > Sources.

### Files to Modify

- `apps/studio/src/components/search-ai/home/SetupGuide.tsx` (lines 105-108) -- Change `handleConnectSource` behavior
- `apps/studio/src/components/search-ai/data/AddSourceButton.tsx` (line 31) -- Extract dialog into a standalone component or add a render-only mode

### Approach

Two options:

**Option A (preferred):** Import `AddSourceButton` in `SetupGuide` and render it with a `renderTrigger` prop that lets SetupGuide control the trigger element. The dialog itself is self-contained.

**Option B:** Extract the dialog portion of `AddSourceButton` into a separate `AddSourceDialog` component. Both `AddSourceButton` and `SetupGuide` import it.

After inspection, `AddSourceButton` (line 37-44) already has `autoOpen` and `onAutoOpenConsumed` props. The redesign can use these by setting a local state in `SetupGuide` and rendering `AddSourceButton` with `autoOpen={true}`.

However, the current flow navigates to the Data tab first. The redesign needs the dialog to appear on the Home tab. Since `AddSourceButton` is rendered inside `DataSection`, we need it renderable from `SetupGuide` too.

### Files to Modify (detailed)

- `apps/studio/src/components/search-ai/home/SetupGuide.tsx` -- lines 105-108: render `AddSourceButton` inline (hidden trigger) with `autoOpen` controlled by local state
- `apps/studio/src/components/search-ai/data/AddSourceButton.tsx` -- add `renderInline?: boolean` prop that hides the trigger button and only renders the dialog (controlled externally)

### Function Signatures

**Before (`SetupGuide.tsx` line 105):**

```ts
const handleConnectSource = useCallback(() => {
  setPendingFilter({ view: 'documents', autoOpenAddSource: true });
  onNavigate?.('data');
}, [setPendingFilter, onNavigate]);
```

**After:**

```ts
const [showAddSourceDialog, setShowAddSourceDialog] = useState(false);

const handleConnectSource = useCallback(() => {
  setShowAddSourceDialog(true);
}, []);

const handleSourceAdded = useCallback(
  (source?: { _id: string; name: string; sourceType: string }) => {
    setShowAddSourceDialog(false);
    if (source?.sourceType === 'sharepoint') {
      // SharePoint: panel will open via store, then navigate after setup
      setPendingFilter({ view: 'sources' });
      onNavigate?.('data');
    } else if (source) {
      setPendingFilter({ view: 'documents' });
      onNavigate?.('data');
    }
  },
  [setPendingFilter, onNavigate],
);
```

**Before (`AddSourceButton.tsx` line 37):**

```ts
interface AddSourceButtonProps {
  indexId: string;
  onSourceAdded: (source?: { _id: string; name: string; sourceType: string }) => void;
  autoOpen?: boolean;
  onAutoOpenConsumed?: () => void;
}
```

**After:**

```ts
interface AddSourceButtonProps {
  indexId: string;
  onSourceAdded: (source?: { _id: string; name: string; sourceType: string }) => void;
  autoOpen?: boolean;
  onAutoOpenConsumed?: () => void;
  /** When true, only renders the dialog (no trigger button). Parent controls open state. */
  dialogOnly?: boolean;
  /** External open state when dialogOnly is true */
  open?: boolean;
  /** Called when dialog closes in dialogOnly mode */
  onClose?: () => void;
}
```

### Subtasks (execution order)

1. **ST-23.1:** Modify `AddSourceButton.tsx` to accept `dialogOnly`, `open`, `onClose` props. When `dialogOnly` is true, skip rendering the trigger `Button` and use the `open` prop to control dialog visibility.
2. **ST-23.2:** Modify `SetupGuide.tsx`: remove the `setPendingFilter({ view: 'documents', autoOpenAddSource: true })` + `onNavigate?.('data')` pattern. Add local state `showAddSourceDialog`. Render `AddSourceButton` with `dialogOnly={true}` and `open={showAddSourceDialog}`. When a source is added, navigate to Data tab > Sources.
3. **ST-23.3:** When SharePoint is selected in the Add Source dialog on the Home tab: instead of opening `EnterpriseConnectorWizard`, open `SharePointDetailPanel` via `useConnectorStore.openPanel()`. This wiring connects the type selection to the new panel.
4. **ST-23.4:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: Clicking "Connect Source" on SetupGuide opens the Add Source dialog on the Home tab (no tab switch).
  - Verify: Component test clicking the button, checking dialog renders
  - Expected: Dialog visible, `onNavigate` NOT called yet
- AC-02: Selecting SharePoint in the dialog opens the SharePointDetailPanel.
  - Verify: Component test selecting SharePoint type
  - Expected: `useConnectorStore.openPanel` called
- AC-03: After setup completes, user is navigated to Data tab > Sources.
  - Verify: Component test completing the flow
  - Expected: `onNavigate('data')` called with `view: 'sources'`

### Dependencies

- **T-10** (SharePointDetailPanel) -- panel must exist to open
- **T-09** (Zustand store) -- `useConnectorStore.openPanel()`

### Risk Notes

- The `AddSourceButton` component at 543 lines contains significant logic for non-SharePoint source types (file, web, database, API). The `dialogOnly` prop change is surgical -- it only affects the rendering of the trigger button. The dialog content and logic remain unchanged.
- The SharePoint type handler in `AddSourceButton` currently renders `EnterpriseConnectorWizard`. This wiring change (ST-23.3) means `AddSourceButton` needs to know about `useConnectorStore`. This is a cross-component dependency. Alternative: emit a custom event or callback that the parent handles.

---

## Task T-24: Wire Flow D (SourcesTable Row Click Opens Panel with Correct Tab)

### Problem

When clicking a SharePoint connector row in the SourcesTable, the panel should open with the correct initial tab:

- Draft/Awaiting Auth: Connect tab
- Active/Syncing: Overview tab
- Error: Overview tab (with error state)

The existing `SourcesTable` already has a `connectorMap` that maps `source._id` to `connectorId`. The row click handler currently opens the old `ConnectorDetailPanel`. This needs to be updated to open `SharePointDetailPanel` via `useConnectorStore.openPanel()`.

### Files to Modify

- `apps/studio/src/components/search-ai/data/SourcesTable.tsx` -- Update SharePoint row click handler

### Function Signatures

**Before (conceptual, in SourcesTable row click handler):**

```tsx
// Opens old ConnectorDetailPanel
onRowClick(source) → opens ConnectorDetailPanel with connectorMap[source._id]
```

**After:**

```tsx
// Opens new SharePointDetailPanel via Zustand store
onRowClick(source) → {
  if (connectorMap[source._id]) {
    const connectorId = connectorMap[source._id];
    // Determine tab based on connector status
    // For now, use 'overview' as default for existing connectors
    useConnectorStore.getState().openPanel(connectorId, { isNew: false, tab: 'overview' });
  } else {
    // Non-SharePoint: open existing SourceDetailPanel
  }
}
```

### Subtasks (execution order)

1. **ST-24.1:** Read `SourcesTable.tsx` to find the exact row click handler and `connectorMap` usage pattern. Verify the component imports and how `ConnectorDetailPanel` is currently opened.
2. **ST-24.2:** Modify the row click handler for SharePoint sources: instead of opening `ConnectorDetailPanel`, call `useConnectorStore.getState().openPanel(connectorId, { isNew: false, tab: 'overview' })`.
3. **ST-24.3:** Determine the correct initial tab by inspecting the connector's status. If status is `'draft'` or `'awaiting_auth'`, open with `tab: 'connect'`. Otherwise, open with `tab: 'overview'`.
4. **ST-24.4:** Verify that the `SharePointDetailPanel` renders at the appropriate level in the component tree (sibling to `SourcesTable`, within the KB detail page). If not already mounted, add it to `DataSection.tsx` or the KB detail page layout.
5. **ST-24.5:** Build: `pnpm build --filter=@agent-platform/studio`.

### Acceptance Criteria

- AC-01: Clicking a SharePoint source row opens `SharePointDetailPanel` via the store.
  - Verify: Component test with a SharePoint source in `connectorMap`, clicking the row
  - Expected: `useConnectorStore.openPanel` called with connector ID
- AC-02: Draft connector opens panel on Connect tab.
  - Verify: Component test with connector status `'draft'`
  - Expected: `tab: 'connect'` passed to `openPanel`
- AC-03: Active connector opens panel on Overview tab.
  - Verify: Component test with active connector
  - Expected: `tab: 'overview'` passed to `openPanel`
- AC-04: Non-SharePoint sources continue to open existing `SourceDetailPanel`.
  - Verify: Component test clicking a web source row
  - Expected: `useConnectorStore.openPanel` NOT called

### Dependencies

- **T-10** (SharePointDetailPanel) -- panel must be mounted in the component tree
- **T-09** (Zustand store) -- `useConnectorStore`

### Risk Notes

- Need to verify where `SharePointDetailPanel` is rendered in the component tree. The panel reads from `useConnectorStore` and renders conditionally when `panelOpen` is true. It should be mounted at the KB detail page level (near `DataSection`) so it persists across tab switches.

---

## Task T-25: Backend: Name Uniqueness Check + Admin Email Generation

### Problem

The Connect tab needs two backend capabilities:

1. **Name uniqueness check**: `GET /connectors/check-name?name=...` to verify a connector name is unique within a KB.
2. **Admin email generation**: `POST /connectors/generate-admin-email` to generate a pre-formatted email body with Azure Portal setup instructions.

### Files to Modify

- `apps/search-ai/src/routes/connectors.ts` -- Add two new route handlers
- `apps/search-ai/src/services/connector.service.ts` -- Add two new service functions

### Function Signatures

**New service functions:**

```ts
// connector.service.ts

export async function checkConnectorName(
  indexId: string,
  tenantId: string,
  name: string,
): Promise<{ available: boolean; suggestion?: string }>;
// Checks if a connector with this name exists in the given index
// If taken, suggests "{name} (2)" or incrementing

export async function generateAdminEmail(
  indexId: string,
  tenantId: string,
  type: 'app_registration_setup',
): Promise<{ subject: string; body: string; mailto: string }>;
// Generates pre-formatted email with Azure Portal instructions
// Body includes: step-by-step guide, required permissions list, redirect URI
```

**New routes:**

```
GET  /:indexId/connectors/check-name?name={name}
     Response: { success: true, data: { available: boolean, suggestion?: string } }

POST /:indexId/connectors/generate-admin-email
     Body: { type: 'app_registration_setup' }
     Response: { success: true, data: { subject, body, mailto } }
```

### Route Placement

CRITICAL: These routes must be registered BEFORE the `/:indexId/connectors/:connectorId` route (connectors.ts line 69). Express matches top-down -- `/:indexId/connectors/check-name` would be captured by `/:indexId/connectors/:connectorId` with `connectorId = 'check-name'` if registered after.

### Subtasks (execution order)

1. **ST-25.1:** Add `checkConnectorName()` to `connector.service.ts`. Query `ConnectorConfig.findOne({ tenantId, sourceId: { $in: sourceIds } })` with a name match. The `sourceIds` come from `Source.find({ indexId, tenantId }).select('_id')`. If name taken, generate suggestion by appending " (2)" and checking again.
2. **ST-25.2:** Add `generateAdminEmail()` to `connector.service.ts`. Static email template with placeholders for redirect URI (from `getConnectorRedirectUri()` at line 97) and required permissions list (`Sites.Read.All`, `Files.Read.All`, `GroupMember.Read.All`, `offline_access`).
3. **ST-25.3:** Add route handlers to `connectors.ts`. Insert these routes between line 67 (end of `POST /:indexId/connectors` create handler) and line 69 (start of `GET /:indexId/connectors/:connectorId` handler). The routes MUST appear before any `/:connectorId` parameterized route, otherwise Express will match `check-name` as a `connectorId` value. Use Zod validation: `const checkNameQuery = z.object({ name: z.string().min(1).max(200) })` and `const generateEmailBody = z.object({ type: z.enum(['app_registration_setup']) })`. Apply `safeParse` in the route handlers.
4. **ST-25.4:** Build: `pnpm build --filter=search-ai`.

### Acceptance Criteria

- AC-01: `checkConnectorName("Marketing SP")` returns `{ available: true }` when no connector has that name.
  - Verify: Unit test with empty connector list
  - Expected: `available === true`
- AC-02: `checkConnectorName("Marketing SP")` returns `{ available: false, suggestion: "Marketing SP (2)" }` when name is taken.
  - Verify: Unit test with a connector named "Marketing SP"
  - Expected: `available === false`, suggestion provided
- AC-03: `generateAdminEmail('app_registration_setup')` returns subject, body, and mailto string.
  - Verify: Unit test calling the function
  - Expected: All three fields non-empty, body contains "Sites.Read.All"
- AC-04: Route `GET /:indexId/connectors/check-name` is matched before `/:indexId/connectors/:connectorId`.
  - Verify: Integration test calling `GET /:indexId/connectors/check-name?name=test`
  - Expected: 200 with name check response, NOT a "connector not found" 404
- AC-05: All queries include `tenantId` (tenant isolation).
  - Verify: Code review of service functions
  - Expected: Every DB query includes `tenantId` filter

### Dependencies

- None

### Risk Notes

- Express route ordering is critical. The static route `check-name` MUST be registered before the parameterized `:connectorId` route. The CLAUDE.md explicitly calls this out as a known anti-pattern.
- The admin email template is static text, not a dynamically generated document. It can be a template string in the service function.

---

## Task Independence Matrix

| Task | Can Parallel With                                    | Blocked By       | Blocks               |
| ---- | ---------------------------------------------------- | ---------------- | -------------------- |
| T-13 | T-14, T-18, T-19, T-25                               | T-10, T-08, T-11 | T-22, T-23 (partial) |
| T-14 | T-13, T-18, T-19, T-23, T-24, T-25                   | T-06 (audit)     | T-15                 |
| T-15 | T-13, T-18, T-19, T-23, T-24, T-25                   | T-14             | T-16                 |
| T-16 | T-17, T-18, T-19, T-23, T-24, T-25                   | T-10, T-15, T-11 | —                    |
| T-17 | T-16, T-18, T-19, T-23, T-24, T-25                   | T-10, T-08       | —                    |
| T-18 | T-13, T-14, T-15, T-16, T-17, T-19, T-20, T-21-T-25  | —                | —                    |
| T-19 | T-13, T-14, T-15, T-16, T-17, T-18, T-20, T-21-T-25  | —                | —                    |
| T-20 | T-13, T-14, T-15, T-16, T-17, T-18, T-19, T-23-T-25  | T-10             | T-21                 |
| T-21 | T-13-T-19, T-23, T-24, T-25                          | T-20             | —                    |
| T-22 | T-14-T-21, T-23, T-24, T-25                          | T-13, T-11       | —                    |
| T-23 | T-14, T-15, T-16, T-17, T-18, T-19, T-20, T-24, T-25 | T-10, T-09       | —                    |
| T-24 | T-13-T-23, T-25                                      | T-10, T-09       | —                    |
| T-25 | T-13, T-14, T-15, T-16, T-17, T-18, T-19, T-20-T-24  | —                | —                    |

**Recommended execution order:**

- **Batch 1 (parallel):** T-14 (model+service), T-18 (CEL editor), T-19 (condition builder), T-25 (backend name check + email)
- **Batch 2 (after T-14):** T-15 (proposal routes)
- **Batch 3 (parallel, after Wave 1 T-10):** T-13 (connect tab), T-17 (split-pane), T-20 (preview tab), T-23 (Flow A wiring), T-24 (Flow D wiring)
- **Batch 4 (after T-13):** T-22 (scopes reuse refinement)
- **Batch 5 (after T-15, T-13):** T-16 (proposal tab -- largest frontend task)
- **Batch 6 (after T-20):** T-21 (approve & start)

---

## File Overlap Check (CRITICAL)

| File                                                                          | Tasks Touching It                                                                                                 |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/api/search-ai.ts`                                            | T-13 (checkConnectorName, generateAdminEmail), T-16 (proposal API functions), T-20 (runPreview, getConfigSummary) |
| `apps/studio/src/components/search-ai/sharepoint/ConnectionScopesDisplay.tsx` | T-13 (create), T-22 (add compact prop)                                                                            |
| `apps/studio/src/components/search-ai/data/AddSourceButton.tsx`               | T-23 (add dialogOnly/open/onClose props)                                                                          |
| `apps/studio/src/components/search-ai/home/SetupGuide.tsx`                    | T-23 (change handleConnectSource)                                                                                 |
| `apps/search-ai/src/routes/connectors.ts`                                     | T-25 (add check-name + admin-email routes)                                                                        |
| `apps/search-ai/src/services/connector.service.ts`                            | T-25 (add checkConnectorName + generateAdminEmail)                                                                |
| `packages/database/src/index.ts`                                              | T-14 (add ProposalState export)                                                                                   |
| `apps/search-ai/src/server.ts`                                                | T-15 (mount proposal routes)                                                                                      |

**Overlap analysis:**

1. **`apps/studio/src/api/search-ai.ts`** is touched by T-13, T-16, and T-20 — all adding NEW functions at the end of the file (different line ranges, no overlap in modifications). Can be parallel if appending to different areas. **Coordination note for Batch 3:** T-13 and T-20 both run in Batch 3 and both append to this file. If running in parallel, assign distinct line ranges: T-13 appends first (after existing connector functions ~line 2078), T-20 appends after T-13's additions. Alternatively, serialize the file edits.

2. **`ConnectionScopesDisplay.tsx`** is created by T-13 and modified by T-22. **T-22 depends on T-13.** Execute T-13 first.

3. **`AddSourceButton.tsx`** and **`SetupGuide.tsx`** are both modified by T-23 only. No cross-task overlap.

4. **`connectors.ts`** and **`connector.service.ts`** are touched by T-25 only. No cross-task overlap.

5. **`packages/database/src/index.ts`** is touched by T-14 (adding ProposalState export). Wave 1 T-06 and T-07 also touch this file but at different lines. No conflict if Wave 1 is complete.

6. **`apps/studio/src/hooks/useConnectorProposal.ts`** is owned exclusively by T-16 (ST-16.1). Previously listed in both T-13 and T-16; resolved by removing it from T-13's Files to Create. No overlap remains.

**File overlap resolution:** The only sequential dependency due to file overlap is T-13 → T-22 (ConnectionScopesDisplay). All other overlaps involve separate tasks writing to non-overlapping regions of the same file.
