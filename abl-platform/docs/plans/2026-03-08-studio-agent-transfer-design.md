# Studio Agent Transfer & Call Flow — Design Document

**Date**: 2026-03-08
**Status**: Approved
**Scope**: Studio UI for agent transfer configuration, escalation routing, and transfer session monitoring

## Overview

Extend Studio to support end-to-end agent transfer authoring and operations. Agent transfer is unified under the existing `ESCALATE` DSL construct — there is no separate `transfer_to_agent` tool. The LLM calls `__escalate__`, and the ESCALATE routing config determines which provider/queue/skills to use.

## Key Architectural Decision

`__escalate__` is the only tool the LLM calls for human handoff. The runtime reads `ESCALATE.routing` from IR and delegates to the `@agent-platform/agent-transfer` package. IVR tools (`ivr_menu`, `ivr_digit_input`, `call_transfer`, `deflect_to_chat`) remain standalone voice-specific tools — they are pre-transfer interactions, not escalation itself.

## Scope

### In Scope (This Design)

1. Connections — Agent desktop providers as categorized connection types
2. EscalationEditor — Routing sub-section in agent editor
3. Settings → Agent Transfer — Project-level defaults (new sidebar nav item)
4. Operate → Transfer Sessions — Light monitoring dashboard
5. Serializer fix — ESCALATE round-trip (form ↔ DSL ↔ IR)
6. Sidebar nav refactor — Settings tabs → collapsible nav group

### Out of Scope (Phase 2)

- IVR tool form editors (`ivr_menu`, `ivr_digit_input`)
- Real-time WebSocket monitoring
- Third-party adapter UIs beyond connection credentials
- CSAT survey builder
- Disposition code management

---

## Section 1: Connections — Agent Desktop Providers

### What

SmartAssist, Genesys, Salesforce, etc. appear as connection types in the existing Connections page. Each stores credentials and endpoint config.

### Connection Types

| Provider         | Auth Type | Key Fields                                   |
| ---------------- | --------- | -------------------------------------------- |
| Kore SmartAssist | `api_key` | baseUrl, apiKey, webhookSecret, orgId        |
| Genesys          | `oauth2`  | region, clientId, clientSecret, deploymentId |
| Salesforce       | `oauth2`  | instanceUrl, clientId, clientSecret, orgId   |
| ServiceNow       | `oauth2`  | instanceUrl, clientId, clientSecret          |
| Generic HTTP     | `custom`  | webhookUrl, authHeader, secret               |

### Categorized Display

Connections page shows inline section headers with dividers to group by category:

```
Connections                    [+ New]
[Search...]

── Agent Desktop ──────────────────────
[SmartAssist ✓]  [Genesys ✓]  [Generic]

── Tools & APIs ────────────────────────
[Slack ✓]  [Jira ✓]  [Salesforce API]
[OpenAI]   [Custom HTTP]
```

- Category derived from `category` field on connector definition: `'agent_desktop'` | `'tool'` | `'messaging'`
- Empty "Agent Desktop" category shows CTA: "Connect an agent desktop to enable escalation routing"
- Create wizard first step shows categories, then provider selection

### Data Model Extension

```typescript
interface AgentDesktopConnection extends ConnectionSummary {
  connectorName: 'smartassist' | 'genesys' | 'salesforce' | 'servicenow' | 'generic';
  category: 'agent_desktop';
  providerConfig: Record<string, unknown>;
}
```

### UI

Reuses existing `ConnectionCard`, `ConnectionCreatePage`, `ConnectionDetailPage`. Each provider gets a config schema that drives form fields dynamically. "Test Connection" hits the provider's health endpoint.

---

## Section 2: EscalationEditor — Routing Sub-Section

### What

A 4th collapsible sub-section in the existing `EscalationEditor.tsx` (724 LOC), after Triggers / Context for Human / On Human Complete.

### Layout

```
▼ Routing
  ┌─────────────────────────────────────────────┐
  │ Connection     [SmartAssist (Production) ▼]  │  ← agent_desktop connections only
  │ Queue          [billing                   ]  │  ← text input, optional
  │ Skills         [billing] [english] [+ Add ]  │  ← tag input
  │ Priority       [●●●●●○○○○○  5            ]  │  ← 0-10 number input
  │ Post-Agent     (●) Return to bot  ( ) End    │  ← radio
  │                                               │
  │ ▸ Voice Settings (conditional)                │
  │   Transfer Method  [SIP REFER ▼]             │
  │   Custom SIP Headers                          │
  │     UUI: [template input]                     │
  │     X-KoreReason: [template input]            │
  │                                               │
  │ ▸ Kore Settings (conditional on SmartAssist)  │
  │   Business Hours ID  [optional]               │
  │   Check Availability [toggle]                 │
  │   No Agents Flow     [agent selector]         │
  │   Out of Hours Flow  [agent selector]         │
  └─────────────────────────────────────────────┘
```

### Behaviors

- Connection dropdown filters to `category: 'agent_desktop'` connections only
- If no connections exist, shows inline CTA: "Create an agent desktop connection first"
- Provider-specific fields (Kore Settings, Genesys Settings) appear/hide based on selected connection's `connectorName`
- Voice Settings appear/hide based on whether the agent has a voice channel deployment
- Skills accumulate — IR stores them, runtime merges with skills from prior flow steps

### Data Model

```typescript
interface EscalationRouting {
  connectionId: string;
  queue?: string;
  skills?: string[];
  priority?: number; // 0-10, default 5
  postAgentAction: 'return' | 'end';
  voice?: {
    transferMethod?: 'invite' | 'refer' | 'bye';
    sipHeaders?: Record<string, string>;
  };
  providerConfig?: Record<string, unknown>;
}
```

Extends existing `EscalationSectionData`:

```typescript
interface EscalationSectionData {
  triggers: Array<{ when: string; reason: string; priority: string; tags?: string[] }>;
  contextForHuman: string[];
  onHumanComplete: Array<{ condition: string; action: string }>;
  routing?: EscalationRouting; // ← new
}
```

---

## Section 3: Settings → Agent Transfer

### What

Project-level defaults and behavior config. New nav item under the Settings collapsible group in the sidebar.

### Layout

Uses collapsible sections (same pattern as RuntimeConfigTab / AdvancedSettingsTab):

```
Agent Transfer Settings

▼ Session Lifecycle
  Chat TTL         [30] minutes
  Email TTL        [240] minutes
  Voice TTL        [Session duration ▼]
  Messaging TTL    [30] minutes
  Campaign TTL     [60] minutes
  Max Concurrent   [1] per contact

▼ Default Routing
  Default Provider    [SmartAssist (Production) ▼]
  Default Queue       [optional]
  Default Priority    [5]
  Default Post-Agent  (●) Return  ( ) End

▼ Voice Gateway
  Gateway Type        [KoreVG / Jambonz ▼]
  Transfer Method     [SIP REFER ▼]
  Header Passthrough  [toggle]
  Recording Enabled   [toggle]

▼ PII Handling
  De-tokenize before transfer  [toggle] (on)
  Detection pattern            [regex input]

                        [Save] [Reset]
```

### Behaviors

- Project-level defaults — per-agent ESCALATE routing config overrides them
- Stored via `PUT /api/projects/:id/settings` (extends existing settings payload with `agentTransfer` key)
- Voice Gateway section hidden if project has no voice channel deployments
- Save/Reset pattern matches existing settings tabs

### API

Extends existing project settings endpoint:

```typescript
// Added to project settings payload
interface AgentTransferSettings {
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
```

---

## Section 4: Operate → Transfer Sessions

### What

New nav item under the Operate group. Light monitoring of active transfer sessions.

### Layout

Table view using `ListPageShell`:

```
Transfer Sessions              [Refresh]
[Search...]  [Provider ▼]  [Status ▼]  [Channel ▼]

┌──────────┬───────────┬────────┬─────────┬─────────┬──────────┬─────────┐
│ Contact  │ Agent     │Provider│ Status  │ Queue   │ Duration │ Actions │
├──────────┼───────────┼────────┼─────────┼─────────┼──────────┼─────────┤
│ c-a8f3.. │ BillingBot│ Kore   │ ● Active│ billing │ 4m 23s   │ [End]   │
│ c-b2d1.. │ SupportBot│ Kore   │ ◐ Queued│ support │ 1m 02s   │ [End]   │
│ c-f9e0.. │ SalesBot  │Genesys │ ○ Ended │ sales   │ 12m 45s  │   —     │
└──────────┴───────────┴────────┴─────────┴─────────┴──────────┴─────────┘
```

### Behaviors

- Polling refresh: 30s auto + manual refresh button. No WebSocket.
- Status badges: Pending (gray), Queued (blue), Active (green), Post-Agent (amber), Ended (default)
- Filters: provider, status, channel via dropdown selects
- "End" action opens confirm dialog → `POST /sessions/:sid/end`
- Click row → detail modal: full metadata, provider session ID, skills, priority, timestamps, provider data
- Sorted by createdAt descending

### API

```
GET  /api/projects/:id/agent-transfer/sessions           — list with filters + pagination
POST /api/projects/:id/agent-transfer/sessions/:sid/end   — force-end
```

---

## Section 5: Serializer Fix + Compiler Integration

### Problem

`abl-serializers.ts` writes a hardcoded ESCALATE stub. Triggers, context, on_human_complete, and routing data are all lost on save.

### Fix: Serialization (Form → DSL)

```yaml
ESCALATE:
  triggers:
    - WHEN: user.sentiment == "frustrated" AND handoff_count > 2
      REASON: 'Frustrated customer bounced between agents'
      PRIORITY: high
      TAGS: [sentiment, ux_failure]
  context_for_human:
    - apple_id
    - conversation_history
  on_human_complete:
    - IF: human.resolved == true
      THEN: COMPLETE
  routing:
    connection: smartassist-prod
    queue: billing
    skills: [billing, english]
    priority: 5
    post_agent: return
    voice:
      transfer_method: refer
      sip_headers:
        UUI: '{{contactId}}'
    kore:
      hours_id: bh-12345
      check_availability: true
```

### Fix: Deserialization (IR → Form)

Compiler already parses ESCALATE into `ir.coordination.escalation`. Extend IR schema with `routing` field.

### Compiler Change

`EscalationConfig` in `packages/compiler/src/platform/ir/schema.ts`:

```typescript
export interface EscalationConfig {
  triggers: EscalationTrigger[];
  context_for_human: string[];
  on_human_complete: OnHumanComplete[];
  routing?: EscalationRouting; // ← new
}

export interface EscalationRouting {
  connection: string; // connection name reference
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

### Runtime Wiring

When `__escalate__` fires:

1. Routing executor reads `ir.coordination.escalation.routing`
2. Resolves connection credentials from project connections
3. Delegates to `@agent-platform/agent-transfer` package (KoreAdapter, etc.)
4. Sets `session.isEscalated = true` + stores transfer session in Redis

This replaces the current behavior of just setting a flag and emitting a trace.

---

## Section 6: Sidebar Nav Refactor

### What

Convert 8 Settings tabs into sidebar nav items under a collapsible "Settings" group.

### Before

```
Bottom bar: [Settings ⚙️]  → single page with tab bar
```

### After

```
More section:
  ...
  Govern
    ├── Guardrails
    └── Governance
  Settings
    ├── Members
    ├── API Keys
    ├── Models
    ├── Config Vars
    ├── Git
    ├── Advanced
    ├── Runtime Config
    ├── Trace Dimensions
    └── Agent Transfer     ← new
```

### Changes

- `ProjectSidebar.tsx`: Add `settings` as collapsible group in More section with 9 sub-items
- Remove gear icon from bottom bar (or keep as shortcut → Settings/Members)
- Each sub-item becomes its own `ProjectPage` type (e.g., `'settings-members'`, `'settings-agent-transfer'`)
- `AppShell.tsx` `renderContent()`: Route each to its existing tab component
- Tab components (`ProjectMembersTab`, `ApiKeysTab`, etc.) stay as-is — only navigation layer changes

---

## Files to Create/Modify

### New Files

| File                                                | Purpose                                             |
| --------------------------------------------------- | --------------------------------------------------- |
| `components/connections/agent-desktop-registry.ts`  | Agent desktop provider definitions + config schemas |
| `components/settings/AgentTransferSettingsPage.tsx` | Project-level agent transfer settings               |
| `components/operate/TransferSessionsPage.tsx`       | Transfer session monitoring table                   |
| `components/operate/TransferSessionDetailModal.tsx` | Session detail modal                                |
| `api/agent-transfer.ts`                             | API client for transfer sessions + settings         |
| `hooks/useTransferSessions.ts`                      | SWR hook for polling transfer sessions              |
| `hooks/useAgentTransferSettings.ts`                 | SWR hook for agent transfer settings                |

### Modified Files

| File                                                      | Change                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `components/agents/agent-editor/EscalationEditor.tsx`     | Add Routing sub-section                                              |
| `components/connections/ConnectionsPage.tsx`              | Add category grouping with inline headers                            |
| `components/connections/ConnectionCreatePage.tsx`         | Add category step + agent desktop providers                          |
| `components/navigation/ProjectSidebar.tsx`                | Settings → collapsible group, add Agent Transfer + Transfer Sessions |
| `components/navigation/AppShell.tsx`                      | Route new pages                                                      |
| `store/navigation-store.ts`                               | Add new ProjectPage types                                            |
| `lib/abl-serializers.ts`                                  | Fix ESCALATE serialization (triggers, context, routing)              |
| `store/agent-editor-store.ts`                             | Add EscalationRouting to section data                                |
| `app/api/projects/[id]/agent-transfer/`                   | New API routes (sessions, settings)                                  |
| `packages/compiler/src/platform/ir/schema.ts`             | Add EscalationRouting to IR                                          |
| `apps/runtime/src/services/execution/routing-executor.ts` | Wire escalation → agent-transfer                                     |

---

## Testing Strategy

- **Unit**: Serializer round-trip (form → DSL → IR → form), routing config validation
- **Component**: EscalationEditor routing section renders/updates correctly, connection dropdown filters by category
- **Integration**: Settings save/load, transfer session list/end, connection CRUD for agent desktop types
- **E2E**: Create SmartAssist connection → configure ESCALATE routing → verify DSL output
