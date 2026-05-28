# Studio Agent Transfer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add agent transfer configuration, escalation routing, and transfer session monitoring to Studio.

**Architecture:** Extend existing Connections, Agent Editor, Settings, and Operate pages. Agent transfer is unified under the ESCALATE DSL construct — no separate tool. Connection credentials for agent desktops (SmartAssist, Genesys, etc.) live in Connections; routing config lives in ESCALATE; project-level defaults live in Settings.

**Tech Stack:** React 18, Next.js 15, Zustand, SWR, Tailwind CSS, Framer Motion, Lucide icons, next-intl, sonner (toasts)

**Design doc:** `docs/plans/2026-03-08-studio-agent-transfer-design.md`

---

## Task 1: Sidebar Nav Refactor — Types & Store

Convert Settings tabs into sidebar nav items. Start with the data layer.

**Files:**

- Modify: `apps/studio/src/store/navigation-store.ts`

**Step 1: Add new ProjectPage types**

In `navigation-store.ts`, find the `ProjectPage` type union (lines 17-39). Add the settings sub-pages and new pages:

```typescript
// Add these to the ProjectPage union type:
| 'settings-members'
| 'settings-api-keys'
| 'settings-models'
| 'settings-config-vars'
| 'settings-git'
| 'settings-advanced'
| 'settings-runtime-config'
| 'settings-trace-dimensions'
| 'settings-agent-transfer'
| 'transfer-sessions'
```

**Step 2: Update parseUrl to route settings sub-pages**

In `parseUrl()` (lines 87-171), add a redirect so that the old `/projects/:id/settings` URL maps to `page: 'settings-members'`:

```typescript
// After the existing page redirects (line 149):
if (page === 'settings') {
  page = 'settings-members';
}
```

**Step 3: Verify**

Run: `cd apps/studio && pnpm build 2>&1 | tail -20`
Expected: Build succeeds. No type errors from new union members.

**Step 4: Commit**

```
[ABLP-2] feat(studio): add settings sub-page and transfer-sessions navigation types
```

---

## Task 2: Sidebar Nav Refactor — ProjectSidebar Component

**Files:**

- Modify: `apps/studio/src/components/navigation/ProjectSidebar.tsx`

**Step 1: Add Settings as a collapsible nav group**

In `ProjectSidebar.tsx`, find `navGroups` (lines 81-130). Add a `settings` group after the `govern` group:

```typescript
// Add to lucide-react imports:
import { ..., PhoneForwarded, Key, Cpu, Variable, GitBranch, Cog, LineChart } from 'lucide-react';

// Add to navGroups array:
{
  id: 'settings',
  Icon: Settings,
  key: 'settings_group',
  defaultPage: 'settings-members' as ProjectPage,
  pages: [
    'settings-members', 'settings-api-keys', 'settings-models',
    'settings-config-vars', 'settings-git', 'settings-advanced',
    'settings-runtime-config', 'settings-trace-dimensions', 'settings-agent-transfer',
  ] as ProjectPage[],
  items: [
    { id: 'settings-members' as ProjectPage, Icon: Settings, key: 'members' },
    { id: 'settings-api-keys' as ProjectPage, Icon: Key, key: 'api_keys' },
    { id: 'settings-models' as ProjectPage, Icon: Cpu, key: 'models' },
    { id: 'settings-config-vars' as ProjectPage, Icon: Variable, key: 'config_vars' },
    { id: 'settings-git' as ProjectPage, Icon: GitBranch, key: 'git' },
    { id: 'settings-advanced' as ProjectPage, Icon: Cog, key: 'advanced' },
    { id: 'settings-runtime-config' as ProjectPage, Icon: Cog, key: 'runtime_config' },
    { id: 'settings-trace-dimensions' as ProjectPage, Icon: LineChart, key: 'trace_dimensions' },
    { id: 'settings-agent-transfer' as ProjectPage, Icon: PhoneForwarded, key: 'agent_transfer' },
  ],
},
```

**Step 2: Add Transfer Sessions to the Operate group**

Find the `operate` group (lines 93-104). Add to its `pages` and `items` arrays:

```typescript
// Add to pages array:
'transfer-sessions'
// Add to items array:
{ id: 'transfer-sessions' as ProjectPage, Icon: PhoneForwarded, key: 'transfer_sessions' },
```

**Step 3: Remove or convert the bottom-bar Settings button**

Find the bottom bar (lines 423-440). Remove `renderNavItem({ id: 'settings', ... })` (line 425). Keep only the collapse toggle.

**Step 4: Verify**

Run: `cd apps/studio && pnpm build 2>&1 | tail -20`
Expected: Build succeeds. Sidebar renders Settings group.

**Step 5: Commit**

```
[ABLP-2] feat(studio): refactor settings tabs into sidebar nav group
```

---

## Task 3: Sidebar Nav Refactor — AppShell Routing

**Files:**

- Modify: `apps/studio/src/components/navigation/AppShell.tsx`

**Step 1: Import existing tab components**

Check lines 38-105 for existing imports. Ensure all settings tab components are imported. They exist as:

- `ProjectMembersTab` in `../settings/ProjectMembersTab`
- `ApiKeysTab` in `../settings/ApiKeysTab`
- `ModelConfigTab` in `../settings/ModelConfigTab`
- `ConfigVariablesTab` in `../settings/ConfigVariablesTab`
- `GitIntegrationTab` in `../settings/GitIntegrationTab`
- `AdvancedSettingsTab` in `../settings/AdvancedSettingsTab`
- `RuntimeConfigTab` in `../settings/RuntimeConfigTab`
- `TraceDimensionsTab` in `../settings/TraceDimensionsTab`

If `ProjectSettingsPage` is the only import, you need to import the individual tabs.

**Step 2: Add routing cases in renderContent**

In `renderContent()` (line 376), add cases in the `switch(page)` block. Each settings sub-page renders its tab component. Use `DetailPageShell` if appropriate, or render the tab component directly:

```typescript
case 'settings-members':
  return <ProjectMembersTab />;
case 'settings-api-keys':
  return <ApiKeysTab />;
case 'settings-models':
  return <ModelConfigTab />;
case 'settings-config-vars':
  return <ConfigVariablesTab />;
case 'settings-git':
  return <GitIntegrationTab />;
case 'settings-advanced':
  return <AdvancedSettingsTab />;
case 'settings-runtime-config':
  return <RuntimeConfigTab />;
case 'settings-trace-dimensions':
  return <TraceDimensionsTab />;
case 'settings-agent-transfer':
  return <ComingSoonPage titleKey="agent_transfer_title" descriptionKey="agent_transfer_description" />;
case 'transfer-sessions':
  return <ComingSoonPage titleKey="transfer_sessions_title" descriptionKey="transfer_sessions_description" />;
```

Keep the old `case 'settings':` pointing to `ProjectSettingsPage` for now (it will redirect via parseUrl).

**Step 3: Add i18n keys for new coming-soon pages**

Check the i18n messages file (e.g., `apps/studio/messages/en.json`) and add keys for `agent_transfer_title`, `agent_transfer_description`, `transfer_sessions_title`, `transfer_sessions_description` under `coming_soon`.

**Step 4: Verify**

Run: `cd apps/studio && pnpm build 2>&1 | tail -20`
Expected: Build succeeds. Each settings sub-page renders.

**Step 5: Commit**

```
[ABLP-2] feat(studio): route settings sub-pages through AppShell
```

---

## Task 4: Connections — Agent Desktop Category Registry

**Files:**

- Create: `apps/studio/src/components/connections/agent-desktop-registry.ts`
- Modify: `apps/studio/src/api/connections.ts`

**Step 1: Create the agent desktop provider registry**

Create `apps/studio/src/components/connections/agent-desktop-registry.ts` with:

- A `ConnectionCategory` type: `'agent_desktop' | 'tool' | 'messaging'`
- An `AgentDesktopProviderDef` interface with: id, label, description, Icon, authType, fields[]
- A `AGENT_DESKTOP_PROVIDERS` array with 5 providers (SmartAssist, Genesys, Salesforce, ServiceNow, Generic HTTP)
- Helper functions: `getProviderDef(id)`, `getConnectionCategory(connectorName)`

Each provider defines its form fields (key, label, type, required, placeholder). See design doc Section 1 for exact fields per provider.

Provider IDs that map to `agent_desktop` category: `'smartassist'`, `'genesys'`, `'salesforce-agent'`, `'servicenow-agent'`, `'generic-agent-desktop'`.

**Step 2: Extend ConnectionSummary type with category**

In `apps/studio/src/api/connections.ts`, add `category?: ConnectionCategory` to `ConnectionSummary` (line 29-40). Update `normalizeConnection()` to derive category using `getConnectionCategory(connectorName)`.

**Step 3: Verify**

Run: `cd apps/studio && pnpm build 2>&1 | tail -20`

**Step 4: Commit**

```
[ABLP-2] feat(studio): add agent desktop provider registry and connection categorization
```

---

## Task 5: Connections — Categorized Display

**Files:**

- Modify: `apps/studio/src/components/connections/ConnectionsPage.tsx`

**Step 1: Group connections by category**

After the search filter (line 80), add grouping logic:

```typescript
const grouped = useMemo(() => {
  const groups: Record<ConnectionCategory, ConnectionSummary[]> = {
    agent_desktop: [],
    tool: [],
    messaging: [],
  };
  for (const conn of filtered) {
    const cat = conn.category ?? 'tool';
    (groups[cat] ?? groups.tool).push(conn);
  }
  return groups;
}, [filtered]);
```

**Step 2: Render with inline section headers**

Replace the flat grid (lines 145-155) with categorized sections. Each category gets:

- A centered divider line with category label in uppercase
- The card grid underneath
- Agent Desktop always shows (with empty CTA if no connections)
- Tools & APIs only shows if it has items

Pattern for the divider:

```tsx
<div className="flex items-center gap-2 mb-3">
  <div className="h-px flex-1 bg-border" />
  <span className="text-xs font-medium text-muted uppercase tracking-wider">Agent Desktop</span>
  <div className="h-px flex-1 bg-border" />
</div>
```

Empty agent desktop CTA:

```tsx
<div className="rounded-lg border border-dashed border-default p-6 text-center">
  <p className="text-sm text-muted mb-2">Connect an agent desktop to enable escalation routing</p>
  <Button variant="secondary" size="sm" onClick={handleNewConnection}>
    Add Connection
  </Button>
</div>
```

**Step 3: Verify**

Run: `cd apps/studio && pnpm dev`
Navigate to Connections. Verify section headers and grouping.

**Step 4: Commit**

```
[ABLP-2] feat(studio): categorize connections with inline section headers
```

---

## Task 6: Connections — Agent Desktop Create Flow

**Files:**

- Modify: `apps/studio/src/components/connections/ConnectionCreatePage.tsx`

**Step 1: Read the existing create wizard**

Read `ConnectionCreatePage.tsx` to understand its current flow (steps, state management, form fields).

**Step 2: Add category selection step**

Before the existing provider step, add a category selection:

- Two cards: "Agent Desktop" (Headphones icon) and "Tools & APIs" (Wrench icon)
- Selecting "Agent Desktop" shows `AGENT_DESKTOP_PROVIDERS` as selectable cards
- Selecting "Tools & APIs" shows the existing provider list

**Step 3: Render dynamic form fields from provider definition**

When an agent desktop provider is selected, render form fields from `getProviderDef(selectedProvider).fields`. Each field becomes an input with label, placeholder, and required indicator.

**Step 4: Wire create API**

On submit, call `createConnection()` with `connectorName` set to the provider ID and credentials from the form fields.

**Step 5: Verify**

Create a SmartAssist connection. Verify it appears under Agent Desktop category.

**Step 6: Commit**

```
[ABLP-2] feat(studio): add agent desktop provider creation flow
```

---

## Task 7: IR Schema — Add EscalationRouting

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts`

**Step 1: Update EscalationRouting interface**

Find `EscalationRouting` (lines 1087-1091). Replace with the full routing schema:

```typescript
export interface EscalationRouting {
  connection: string;
  queue?: string;
  skills?: string[];
  priority?: number;
  post_agent?: 'return' | 'end';
  voice?: {
    transfer_method?: 'invite' | 'refer' | 'bye';
    sip_headers?: Record<string, string>;
  };
  provider_config?: Record<string, unknown>;
}
```

Verify `EscalationConfig` (lines 1068-1073) already has `routing?: EscalationRouting`. If not, add it.

**Step 2: Run compiler tests**

Run: `cd packages/compiler && pnpm build && pnpm test -- --run 2>&1 | tail -20`
Expected: All 3,947 tests pass (interface change only).

**Step 3: Commit**

```
[ABLP-2] feat(compiler): extend EscalationRouting IR schema for agent transfer
```

---

## Task 8: Agent Transfer Settings Page

**Files:**

- Create: `apps/studio/src/api/agent-transfer.ts`
- Create: `apps/studio/src/hooks/useAgentTransferSettings.ts`
- Create: `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx`
- Modify: `apps/studio/src/components/navigation/AppShell.tsx`

**Step 1: Create API client**

Create `apps/studio/src/api/agent-transfer.ts` with:

```typescript
export interface AgentTransferSettings {
  session: {
    ttl: { chat: number; email: number; voice: number; messaging: number; campaign: number };
    maxConcurrentPerContact: number;
  };
  defaultRouting: {
    connectionId?: string;
    queue?: string;
    priority?: number;
    postAgentAction: 'return' | 'end';
  };
  voice: {
    type: 'korevg' | 'audiocodes' | 'jambonz';
    transferMethod: 'invite' | 'refer' | 'bye';
    headerPassthrough: boolean;
    recordingEnabled: boolean;
  };
  pii: {
    deTokenizeBeforeTransfer: boolean;
    detectionPattern: string;
  };
}

export const DEFAULT_AGENT_TRANSFER_SETTINGS: AgentTransferSettings = {
  session: {
    ttl: { chat: 30, email: 240, voice: 0, messaging: 30, campaign: 60 },
    maxConcurrentPerContact: 1,
  },
  defaultRouting: { priority: 5, postAgentAction: 'return' },
  voice: {
    type: 'korevg',
    transferMethod: 'refer',
    headerPassthrough: false,
    recordingEnabled: false,
  },
  pii: { deTokenizeBeforeTransfer: true, detectionPattern: '' },
};
```

Add `getAgentTransferSettings()` and `updateAgentTransferSettings()` functions that read/write via the existing `/api/projects/:id/settings` endpoint (extending the payload with an `agentTransfer` key). Follow the pattern in `apps/studio/src/lib/api-client.ts`.

**Step 2: Create SWR hook**

Create `apps/studio/src/hooks/useAgentTransferSettings.ts` using the same pattern as `useConnections.ts`: SWR key based on projectId, returns `{ settings, isLoading, error, save, refresh }`.

**Step 3: Build AgentTransferSettingsPage**

Create `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx`. Follow the `RuntimeConfigTab.tsx` pattern exactly:

- Use `ConfigSection` wrapper (collapsible with title, description, chevron)
- Four sections: Session Lifecycle, Default Routing, Voice Gateway, PII Handling
- Save and Reset buttons at bottom
- `useState` for form data with dirty tracking
- `toast` from sonner for save feedback
- Load initial data from `useAgentTransferSettings()`

Session Lifecycle fields: TTL inputs (number, suffix "minutes") for chat/email/voice/messaging/campaign + max concurrent.
Default Routing: Connection dropdown (filter to agent_desktop), queue text, priority number, post-agent radio.
Voice Gateway: Type select (korevg/audiocodes/jambonz), transfer method select (invite/refer/bye), toggles.
PII Handling: Toggle + regex input.

**Step 4: Wire into AppShell**

Replace `ComingSoonPage` for `'settings-agent-transfer'` with `<AgentTransferSettingsPage />`.

**Step 5: Verify**

Run: `cd apps/studio && pnpm build && pnpm dev`
Navigate to Settings → Agent Transfer. Verify all sections render and save works.

**Step 6: Commit**

```
[ABLP-2] feat(studio): add Agent Transfer settings page
```

---

## Task 9: Serializer Fix — ESCALATE Round-Trip

**Files:**

- Modify: `apps/studio/src/lib/abl-serializers.ts`
- Modify: `apps/studio/src/store/agent-detail-store.ts`

**Step 1: Expand CoordinationSectionData**

In `agent-detail-store.ts`, replace `hasEscalation: boolean` with full escalation data:

```typescript
export interface EscalationRoutingData {
  connectionId: string;
  queue?: string;
  skills?: string[];
  priority?: number;
  postAgentAction: 'return' | 'end';
  voice?: { transferMethod?: 'invite' | 'refer' | 'bye'; sipHeaders?: Record<string, string> };
  providerConfig?: Record<string, unknown>;
}

export interface EscalationSectionData {
  triggers: Array<{ when: string; reason: string; priority: string; tags?: string[] }>;
  contextForHuman: string[];
  onHumanComplete: Array<{ condition: string; action: string }>;
  routing?: EscalationRoutingData;
}

export interface CoordinationSectionData {
  delegates: DelegateData[];
  handoffs: HandoffData[];
  escalation: EscalationSectionData | null; // was: hasEscalation: boolean
}
```

Update `parseCoordination()` to parse full escalation from IR, mapping snake_case IR fields to camelCase form fields. Update `EMPTY_COORDINATION`.

**Step 2: Fix the ESCALATE serializer**

In `abl-serializers.ts`, replace the stub at lines 384-392 with a proper serializer that handles triggers (WHEN/REASON/PRIORITY/TAGS), context_for_human, on_human_complete (IF/THEN), and routing (connection/queue/skills/priority/post_agent/voice/provider_config).

Use `inlineQuote()` for string values. Follow the same line-building pattern as the DELEGATE and HANDOFF serializers above it.

Emit `null` content when `escalation` is null (removes the section).

**Step 3: Update all references**

Search for `hasEscalation` in the Studio codebase and update all references to use `escalation !== null` or `escalation?.triggers.length > 0`.

**Step 4: Verify**

Run: `cd apps/studio && pnpm build 2>&1 | tail -20`
Expected: Build succeeds. No type errors.

**Step 5: Commit**

```
[ABLP-2] fix(studio): implement full ESCALATE serialization and IR parsing
```

---

## Task 10: EscalationEditor — Routing Sub-Section

**Files:**

- Modify: `apps/studio/src/components/agent-editor/sections/EscalationEditor.tsx`

**Step 1: Add routing handler**

After the existing `onHumanComplete` handlers (around line 502), add:

```typescript
const handleRoutingChange = useCallback(
  (routing: EscalationRoutingData | undefined) => {
    onChange({ ...data, routing });
  },
  [data, onChange],
);
```

**Step 2: Build RoutingEditor sub-component**

Add a `RoutingEditor` function component within the file (or extract to sibling file). It needs:

- `useConnections(projectId)` to get agent desktop connections
- Filter to `category === 'agent_desktop'`
- Connection dropdown (select element)
- Queue text input
- Skills tag input (reuse the tag input pattern from triggers)
- Priority number input (0-10)
- Post-agent action radio (return / end)
- Conditional Kore Settings (when connection is SmartAssist): hours ID, check availability toggle
- Empty state when no agent desktop connections exist

Use the same `FieldGroup`, `INPUT_CLASSES`, `TAG_CLASSES` constants that exist in the file.

**Step 3: Add the Routing sub-section to the main component**

After the On Human Complete section, add:

```tsx
<SubSectionHeader
  icon={<PhoneForwarded className="w-4 h-4" />}
  title="Routing"
  count={data.routing?.connectionId ? 1 : 0}
  isOpen={expandedSections.routing}
  onToggle={() => toggleSection('routing')}
/>;
{
  expandedSections.routing && (
    <div className="pl-4 border-l-2 border-default/30 ml-2 space-y-3 pb-2">
      <RoutingEditor routing={data.routing} onChange={handleRoutingChange} readOnly={readOnly} />
    </div>
  );
}
```

Add `routing: false` to `expandedSections` initial state. Import `PhoneForwarded` from lucide-react.

**Step 4: Verify**

Run: `cd apps/studio && pnpm build 2>&1 | tail -20`
Open agent editor → Escalation → verify Routing section renders.

**Step 5: Commit**

```
[ABLP-2] feat(studio): add routing sub-section to EscalationEditor
```

---

## Task 11: Transfer Sessions — API & Hook

**Files:**

- Add to: `apps/studio/src/api/agent-transfer.ts`
- Create: `apps/studio/src/hooks/useTransferSessions.ts`
- Create: `apps/studio/src/app/api/projects/[id]/agent-transfer/sessions/route.ts`
- Create: `apps/studio/src/app/api/projects/[id]/agent-transfer/sessions/[sessionId]/end/route.ts`

**Step 1: Add types and API functions to agent-transfer.ts**

Add `TransferSession` interface with fields: id, contactId, agentId, agentName, provider, state, channel, queue, skills, priority, metadata, providerSessionId, providerData, createdAt, updatedAt.

Add `listTransferSessions(projectId, filters?)` and `endTransferSession(projectId, sessionId)`.

**Step 2: Create SWR hook with 30s polling**

Create `apps/studio/src/hooks/useTransferSessions.ts`:

- SWR key includes projectId and filters
- `refreshInterval: 30_000`
- Returns `{ sessions, isLoading, error, refresh }`

**Step 3: Create proxy API routes**

Follow the pattern from `apps/studio/src/app/api/projects/[id]/connections/route.ts`:

- GET sessions route: proxy to runtime `GET /api/projects/:id/agent-transfer/sessions`
- POST end route: proxy to runtime `POST /api/projects/:id/agent-transfer/sessions/:sid/end`

**Step 4: Verify**

Run: `cd apps/studio && pnpm build 2>&1 | tail -20`

**Step 5: Commit**

```
[ABLP-2] feat(studio): add transfer sessions API client, hook, and proxy routes
```

---

## Task 12: Transfer Sessions — Monitoring Page

**Files:**

- Create: `apps/studio/src/components/operate/TransferSessionsPage.tsx`
- Create: `apps/studio/src/components/operate/TransferSessionDetailModal.tsx`
- Modify: `apps/studio/src/components/navigation/AppShell.tsx`

**Step 1: Build TransferSessionsPage**

Use `ListPageShell` with title "Transfer Sessions". Include:

- Refresh button as primary action
- Three filter dropdowns (provider, status, channel) using `<select>` elements
- HTML table with columns: Contact, Agent, Provider, Status, Queue, Duration, Actions
- Status badges with color variants: pending (gray), queued (blue), active (green), post_agent (amber), ended (gray)
- Duration: calculated from `createdAt` to now using `formatDuration()` helper
- End button: opens `ConfirmDialog`, calls `endTransferSession()`, disabled for ended sessions
- Click row: sets `selectedSession` state, opens detail modal
- Empty state: "No transfer sessions found"

**Step 2: Build TransferSessionDetailModal**

A `Dialog` component showing all session fields in a labeled grid:

- ID, Contact, Agent, Provider, State, Channel
- Queue, Skills (as tags), Priority
- Provider Session ID
- Created/Updated timestamps
- Metadata (JSON in `<pre>` tag)
- Provider Data (JSON in `<pre>` tag)
- Close button

**Step 3: Wire into AppShell**

Replace `ComingSoonPage` for `'transfer-sessions'` with `<TransferSessionsPage />`.

**Step 4: Verify**

Run: `cd apps/studio && pnpm build && pnpm dev`
Navigate to Operate → Transfer Sessions. Verify table renders (empty state OK).

**Step 5: Commit**

```
[ABLP-2] feat(studio): add Transfer Sessions monitoring page
```

---

## Task 13: Final Integration & Verification

**Step 1: Run full build**

```bash
pnpm build 2>&1 | tail -30
```

Expected: All packages build successfully.

**Step 2: Run Studio tests**

```bash
cd apps/studio && pnpm test -- --run 2>&1 | tail -30
```

Expected: All tests pass. Fix any type errors from `CoordinationSectionData` shape change.

**Step 3: Run compiler tests**

```bash
cd packages/compiler && pnpm test -- --run 2>&1 | tail -20
```

Expected: All 3,947 tests pass.

**Step 4: Format all changed files**

```bash
npx prettier --write \
  apps/studio/src/store/navigation-store.ts \
  apps/studio/src/components/navigation/ProjectSidebar.tsx \
  apps/studio/src/components/navigation/AppShell.tsx \
  apps/studio/src/components/connections/agent-desktop-registry.ts \
  apps/studio/src/components/connections/ConnectionsPage.tsx \
  apps/studio/src/components/connections/ConnectionCreatePage.tsx \
  apps/studio/src/components/settings/AgentTransferSettingsPage.tsx \
  apps/studio/src/components/agent-editor/sections/EscalationEditor.tsx \
  apps/studio/src/components/operate/TransferSessionsPage.tsx \
  apps/studio/src/components/operate/TransferSessionDetailModal.tsx \
  apps/studio/src/api/agent-transfer.ts \
  apps/studio/src/hooks/useTransferSessions.ts \
  apps/studio/src/hooks/useAgentTransferSettings.ts \
  apps/studio/src/lib/abl-serializers.ts \
  apps/studio/src/store/agent-detail-store.ts \
  packages/compiler/src/platform/ir/schema.ts
```

**Step 5: Manual smoke test**

Start dev server: `cd apps/studio && pnpm dev`

Verify end-to-end:

1. Sidebar shows Settings as collapsible group with 9 items
2. Sidebar shows Transfer Sessions under Operate
3. Settings → Agent Transfer renders with 4 sections, save/reset works
4. Connections page shows category headers (Agent Desktop / Tools & APIs)
5. Create new SmartAssist connection → appears under Agent Desktop
6. Agent editor → Escalation → Routing section → select connection, set queue/skills
7. Save → verify DSL output contains `routing:` block
8. Operate → Transfer Sessions → table renders

**Step 6: Final commit if fixes needed**

```
[ABLP-2] chore(studio): final integration pass for agent transfer UI
```
