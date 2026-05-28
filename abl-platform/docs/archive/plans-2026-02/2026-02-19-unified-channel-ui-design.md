# Unified Channel UI Design

**Date**: 2026-02-19
**Status**: Approved
**Scope**: `apps/studio/src/components/deployments/channels/`

## Problem

The current Studio channel management has three fundamentally different UX paradigms:

| Paradigm                              | Lines | Features                                                        | Model                 |
| ------------------------------------- | ----- | --------------------------------------------------------------- | --------------------- |
| SDK Channels (inline in ChannelsTab)  | ~450  | Full CRUD, detail view, embed code, preview, deployment binding | `SDKChannel`          |
| HTTP Async (inline in ChannelsTab)    | ~700  | Subscriptions, test, delivery log, pause/resume, guides         | `WebhookSubscription` |
| External Channels (ChannelSetupPanel) | ~477  | Single-form wizard, credentials, basic status                   | `ChannelConnection`   |

This creates:

- **Feature parity gaps**: External channels lack test, delivery log, pause/resume, multi-connection, deployment follow/pin
- **Inconsistent UX**: Different navigation patterns, different information density, different actions per type
- **Monolith file**: `ChannelsTab.tsx` at 1435 lines mixing three unrelated paradigms
- **Viewport constraint**: All channel config is constrained to `max-w-5xl` (60rem), insufficient for channels with many config elements
- **Type narrowing**: `ChannelSetupPanel` hardcodes `'slack' | 'msteams' | 'email'`, blocking new channel types

## Design

### Three-Level Navigation Hierarchy

Multi-connection is first-class. Every channel type supports N instances.

```
Level 1: Channel Catalog      (grid of channel types with instance counts)
Level 2: Instance List         (table of connections/channels for one type)
Level 3: Instance Config       (full-width tabbed config for one instance)
```

### Layout Strategy

Levels 1 and 2 stay within the existing `max-w-5xl` constraint (catalog and lists are narrow data).
Level 3 expands to `max-w-6xl` for config forms, giving 12rem more width for complex forms.

`DeploymentsPage` receives a signal from `ChannelsTab` and conditionally widens:

```tsx
<div className={clsx('mx-auto px-6 py-8', isExpanded ? 'max-w-6xl' : 'max-w-5xl')}>
```

### Level 1: Channel Catalog

Grid of channel types. Each card shows:

- Channel icon and name
- Category badge (Messaging / SDK / Webhook / Voice)
- Instance count badge ("3 connections", "Available", "Coming Soon")
- Click navigates to Level 2

Layout: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3`

### Level 2: Instance List

DataTable of instances for the selected channel type. Columns:

- Display name
- Status (active/inactive/error dot)
- Environment badge
- External identifier (truncated)
- Last activity timestamp
- Actions (edit, pause/resume, delete)

Header with:

- Back arrow to catalog
- Channel type icon + name
- `+ New Connection` button
- Optional setup guide link (expandable)

Click row → navigates to Level 3.

### Level 3: Instance Config

Full-width tabbed configuration. Header:

- Back to instance list
- Channel icon + display name + environment badge
- Status indicator
- Quick actions (pause/resume toggle, delete)

Tabs (conditionally shown per channel capabilities):

| Tab               | Content                                                                                                         | When Shown                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Overview**      | Connection summary, setup instructions, webhook URL, auto-generated identifiers, status timeline                | Always                                  |
| **Credentials**   | Dynamic credential form fields per channel type (bot tokens, secrets, API keys)                                 | When `capabilities.hasCredentials`      |
| **Configuration** | Channel-specific settings: widget config (SDK), SMTP (email), retry policy (webhook), display name, external ID | Always                                  |
| **Deployment**    | Environment selector, follow deployment toggle, pin to version                                                  | Always                                  |
| **Testing**       | Send test message, preview widget, verify webhook delivery                                                      | When `capabilities.supportsTest`        |
| **Activity**      | Delivery log table, recent messages, error events, retry history                                                | When `capabilities.supportsDeliveryLog` |

## Data Model

### ChannelTypeDef (Static Catalog)

```typescript
type ChannelTypeId =
  | 'slack'
  | 'msteams'
  | 'email'
  | 'whatsapp'
  | 'messenger'
  | 'sdk_web'
  | 'sdk_mobile'
  | 'sdk_api'
  | 'http_async'
  | 'voice_sip'
  | 'voice_pstn';

type ChannelCategory = 'messaging' | 'sdk' | 'webhook' | 'voice';

interface ChannelCapabilities {
  multiConnection: boolean;
  hasCredentials: boolean;
  hasWebhookUrl: boolean;
  supportsTest: boolean;
  supportsDeliveryLog: boolean;
  autoGenerateIdentifier: boolean;
  supportsPauseResume: boolean;
}

interface CredentialFieldDef {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password';
  required: boolean;
  validation?: (value: string) => string | null;
}

interface ChannelTypeDef {
  id: ChannelTypeId;
  name: string;
  description: string;
  icon: ReactNode;
  available: boolean;
  category: ChannelCategory;
  capabilities: ChannelCapabilities;
  credentialFields: CredentialFieldDef[];
  setupInstructions: ReactNode;
  webhookUrlTemplate?: string; // e.g. '${RUNTIME_URL}/api/v1/channels/slack/webhook'
  externalIdentifierLabel?: string;
  externalIdentifierPlaceholder?: string;
}
```

### ChannelInstance (Frontend View Model)

Normalizes across the three backend models without changing any API.

```typescript
interface ChannelInstance {
  id: string;
  channelType: ChannelTypeId;
  displayName: string;
  status: 'active' | 'inactive' | 'error' | 'paused';
  environment?: string;
  externalIdentifier?: string;
  hasCredentials: boolean;
  config?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;

  // Source tracking for API dispatch
  _source: 'sdk_channel' | 'channel_connection' | 'webhook_subscription';
  _sourceId: string;
}
```

### Normalizer Functions

```typescript
function normalizeSDKChannel(ch: SDKChannel): ChannelInstance;
function normalizeConnection(conn: ChannelConnectionSummary): ChannelInstance;
function normalizeSubscription(sub: WebhookSubscription): ChannelInstance;

function normalizeInstances(
  sdkChannels: SDKChannel[],
  connections: ChannelConnectionSummary[],
  subscriptions: WebhookSubscription[],
): Map<ChannelTypeId, ChannelInstance[]>;
```

## Channel Type Registry

All channel-type-specific data (icons, fields, instructions) lives in one file: `channel-registry.ts`.

| Type ID      | Name            | Category  | Credentials                               | Webhook   | Test          | Delivery Log   |
| ------------ | --------------- | --------- | ----------------------------------------- | --------- | ------------- | -------------- |
| `slack`      | Slack           | messaging | bot_token, signing_secret, app_id         | Yes       | Yes           | Yes            |
| `msteams`    | Microsoft Teams | messaging | app_id, client_secret, tenant_id          | Yes       | Yes           | Yes            |
| `email`      | Email           | messaging | —                                         | No (SMTP) | Yes           | Yes            |
| `whatsapp`   | WhatsApp        | messaging | access_token, phone_number_id, app_secret | Yes       | Yes           | Yes            |
| `sdk_web`    | Web SDK         | sdk       | —                                         | No        | Yes (preview) | Yes (sessions) |
| `sdk_mobile` | Mobile SDK      | sdk       | —                                         | No        | No            | Yes            |
| `sdk_api`    | API             | sdk       | —                                         | No        | Yes (curl)    | Yes            |
| `http_async` | Webhooks        | webhook   | —                                         | No        | Yes           | Yes            |
| `voice_sip`  | Voice (SIP)     | voice     | provider creds                            | Yes       | Yes           | Yes            |

## Component Tree

```
DeploymentsPage (modified — conditional max-width)
└── ChannelsTab (slim router — manages navigation level)
    ├── ChannelCatalog.tsx         (Level 1)
    ├── ChannelInstanceList.tsx    (Level 2)
    │   └── CreateInstanceDialog   (inline dialog for new connection)
    └── ChannelInstanceConfig.tsx  (Level 3 — tab shell)
        ├── tabs/OverviewTab.tsx
        ├── tabs/CredentialsTab.tsx
        ├── tabs/ConfigurationTab.tsx
        ├── tabs/DeploymentTab.tsx
        ├── tabs/TestingTab.tsx
        └── tabs/ActivityTab.tsx
```

## File Structure

```
components/deployments/
├── ChannelsTab.tsx                  (rewritten — thin router, ~80 lines)
├── channels/
│   ├── types.ts                    (ChannelTypeId, ChannelTypeDef, ChannelInstance, etc.)
│   ├── channel-registry.ts         (CHANNEL_REGISTRY: Record<ChannelTypeId, ChannelTypeDef>)
│   ├── channel-normalizer.ts       (normalize* functions)
│   ├── channel-icons.tsx           (all brand SVG icons extracted)
│   ├── ChannelCatalog.tsx          (Level 1 — catalog grid)
│   ├── ChannelInstanceList.tsx     (Level 2 — instance table)
│   ├── ChannelInstanceConfig.tsx   (Level 3 — tabbed config shell)
│   ├── CreateInstanceDialog.tsx    (shared create dialog)
│   └── tabs/
│       ├── OverviewTab.tsx         (status, instructions, identifiers)
│       ├── CredentialsTab.tsx      (dynamic credential form)
│       ├── ConfigurationTab.tsx    (channel-specific settings)
│       ├── DeploymentTab.tsx       (env binding, follow/pin)
│       ├── TestingTab.tsx          (send test, preview)
│       └── ActivityTab.tsx         (delivery log, events)
```

## Files to Delete After Migration

| File                             | Reason                                                           |
| -------------------------------- | ---------------------------------------------------------------- |
| `channels/SlackSetupPanel.tsx`   | Absorbed into registry + CredentialsTab                          |
| `channels/TeamsSetupPanel.tsx`   | Absorbed into registry + CredentialsTab                          |
| `channels/EmailSetupPanel.tsx`   | Absorbed into registry + CredentialsTab                          |
| `channels/ChannelSetupPanel.tsx` | Logic split across OverviewTab, CredentialsTab, ConfigurationTab |

## Files to Modify

| File                  | Change                                                              |
| --------------------- | ------------------------------------------------------------------- |
| `DeploymentsPage.tsx` | Accept `isExpanded` signal, conditional `max-w-5xl` / `max-w-6xl`   |
| `ChannelsTab.tsx`     | Rewrite to thin router (~80 lines)                                  |
| `ChannelDetail.tsx`   | Refactor to be used by `ConfigurationTab` for SDK-specific settings |
| `ChannelCard.tsx`     | May be reused in `ChannelInstanceList` or replaced                  |

## API Dispatch Strategy

The unified UI dispatches to the correct backend API based on `_source`:

| Operation    | sdk_channel                | channel_connection                  | webhook_subscription            |
| ------------ | -------------------------- | ----------------------------------- | ------------------------------- |
| **List**     | `fetchChannels(projectId)` | `fetchConnections(projectId, type)` | `fetchSubscriptions(projectId)` |
| **Create**   | `createChannel(...)`       | `createConnection(...)`             | `createSubscription(...)`       |
| **Update**   | `updateChannel(...)`       | `updateConnection(...)`             | `updateSubscription(...)`       |
| **Delete**   | `deleteChannel(id)`        | `deleteConnection(id)`              | `deleteSubscription(id)`        |
| **Test**     | Preview URL                | `POST /test-message` (new)          | `sendTestMessage(...)`          |
| **Activity** | Sessions API               | Delivery log (new)                  | `fetchDeliveries(...)`          |

## Gaps Addressed

| #   | Gap from Architecture Doc                  | Resolution                                                   |
| --- | ------------------------------------------ | ------------------------------------------------------------ |
| 1   | Three different UX paradigms               | Single three-level hierarchy for all types                   |
| 2   | External channels missing test capability  | `TestingTab` for every channel                               |
| 3   | External channels missing delivery log     | `ActivityTab` for every channel                              |
| 4   | No multi-connection support for external   | Instance list (Level 2) supports N connections               |
| 5   | Missing deployment binding for external    | `DeploymentTab` with env + follow/pin                        |
| 6   | No pause/resume for external               | Status toggle in instance list + overview                    |
| 7   | Type narrowing prevents extension          | `ChannelTypeId` union extensible, registry pattern           |
| 8   | 1435-line monolith file                    | Decomposed into ~15 focused files                            |
| 9   | Viewport too narrow for config             | Level 3 expands to `max-w-6xl`                               |
| 10  | WhatsApp/Messenger in catalog but disabled | Registry entries ready, `available: true` when adapter ships |
| 11  | Inconsistent status model                  | Unified `ChannelInstance.status` across all types            |
| 12  | No health monitoring                       | `OverviewTab` status timeline + `ActivityTab` error events   |

## Design Constraints

- **No backend API changes** in this phase — frontend view model normalizes existing APIs
- **Incremental migration** — new components built alongside old, old deleted after parity
- **Existing design system only** — uses DataTable, Tabs, Dialog, Badge, Input, Select, Button, Card
- **All semantic colors** — no raw colors, follows CSS variable system
- **Framer Motion springs** — `springs.snappy` for tabs, `springs.gentle` for layout transitions
- **`clsx` for all classNames** — no string concatenation

---

## Implementation Plan

_Merged from `2026-02-19-unified-channel-ui-plan.md`._

## Task 1: Channel Types & Registry Foundation

**Files:**

- Create: `apps/studio/src/components/deployments/channels/types.ts`
- Create: `apps/studio/src/components/deployments/channels/channel-icons.tsx`
- Create: `apps/studio/src/components/deployments/channels/channel-registry.ts`
- Test: `apps/studio/src/__tests__/channel-registry.test.ts`

### Step 1: Create `types.ts` — shared type definitions

Create `apps/studio/src/components/deployments/channels/types.ts` with:

```typescript
/**
 * Unified Channel type definitions.
 *
 * ChannelTypeId — every supported channel platform.
 * ChannelTypeDef — static registry entry with capabilities and fields.
 * ChannelInstance — normalized frontend view model across backend APIs.
 */

import type { ReactNode } from 'react';

// =============================================================================
// CHANNEL TYPE IDS
// =============================================================================

export type ChannelTypeId =
  | 'slack'
  | 'msteams'
  | 'email'
  | 'whatsapp'
  | 'messenger'
  | 'sdk_web'
  | 'sdk_mobile'
  | 'sdk_api'
  | 'http_async'
  | 'voice_sip'
  | 'voice_pstn';

export type ChannelCategory = 'messaging' | 'sdk' | 'webhook' | 'voice';

// =============================================================================
// CAPABILITIES & FIELD DEFINITIONS
// =============================================================================

export interface ChannelCapabilities {
  multiConnection: boolean;
  hasCredentials: boolean;
  hasWebhookUrl: boolean;
  supportsTest: boolean;
  supportsDeliveryLog: boolean;
  autoGenerateIdentifier: boolean;
  supportsPauseResume: boolean;
}

export interface CredentialFieldDef {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password';
  required: boolean;
  validation?: (value: string) => string | null;
}

// =============================================================================
// CHANNEL TYPE DEFINITION (static registry entry)
// =============================================================================

export interface ChannelTypeDef {
  id: ChannelTypeId;
  name: string;
  description: string;
  icon: ReactNode;
  available: boolean;
  category: ChannelCategory;
  capabilities: ChannelCapabilities;
  credentialFields: CredentialFieldDef[];
  setupInstructions: ReactNode;
  webhookUrlTemplate: string | null;
  externalIdentifierLabel: string;
  externalIdentifierPlaceholder: string;
}

// =============================================================================
// CHANNEL INSTANCE (normalized frontend view model)
// =============================================================================

export type InstanceSource = 'sdk_channel' | 'channel_connection' | 'webhook_subscription';

export type InstanceStatus = 'active' | 'inactive' | 'error' | 'paused';

export interface ChannelInstance {
  id: string;
  channelType: ChannelTypeId;
  displayName: string;
  status: InstanceStatus;
  environment: string | null;
  externalIdentifier: string | null;
  hasCredentials: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  _source: InstanceSource;
  _sourceId: string;
}

// =============================================================================
// NAVIGATION STATE
// =============================================================================

export type ChannelNavLevel =
  | { level: 'catalog' }
  | { level: 'list'; channelType: ChannelTypeId }
  | { level: 'config'; channelType: ChannelTypeId; instanceId: string };
```

### Step 2: Create `channel-icons.tsx` — extracted brand SVG icons

Extract all brand SVGs from `ChannelsTab.tsx` (lines 21–46) and the setup panels into a single icons file.

Create `apps/studio/src/components/deployments/channels/channel-icons.tsx` with all brand icons (WhatsApp, Slack, Teams, Messenger) plus re-exports of Lucide icons used for other channel types. Each icon component accepts `{ className?: string }`.

Icons to include:

- `WhatsAppIcon` — green #25D366 SVG (from ChannelsTab.tsx line 22)
- `SlackIcon` — multi-color SVG (from ChannelsTab.tsx line 30)
- `TeamsIcon` — purple #6264A7 SVG (from ChannelsTab.tsx line 41)
- `MessengerIcon` — blue #0084FF SVG (new, Facebook Messenger brand)

For non-brand channels, the registry uses Lucide icons directly (`Globe`, `Webhook`, `Mail`, `Phone`, `Smartphone`).

### Step 3: Create `channel-registry.ts` — the full registry

Create `apps/studio/src/components/deployments/channels/channel-registry.ts`.

This file imports the brand icons and Lucide icons, and exports:

- `CHANNEL_REGISTRY: Record<ChannelTypeId, ChannelTypeDef>` — complete registry of all channel types
- `CHANNEL_CATALOG_ORDER: ChannelTypeId[]` — display order for catalog grid
- `getChannelDef(id: ChannelTypeId): ChannelTypeDef` — lookup helper

Each registry entry includes:

- `id`, `name`, `description`, `icon`, `available`, `category`
- `capabilities` object (multiConnection, hasCredentials, etc.)
- `credentialFields[]` with validation (migrate from SlackSetupPanel, TeamsSetupPanel)
- `setupInstructions` JSX (migrate from each setup panel)
- `webhookUrlTemplate` (e.g. `'${RUNTIME_URL}/api/v1/channels/slack/webhook'`)
- `externalIdentifierLabel` and `externalIdentifierPlaceholder`

Channel entries to create:

1. `slack` — migrate from `SlackSetupPanel.tsx` (credential fields at lines 21–44, instructions at lines 46–72)
2. `msteams` — migrate from `TeamsSetupPanel.tsx` (credential fields at lines 18–40, instructions at lines 42–60)
3. `email` — migrate from `EmailSetupPanel.tsx` (no credentials, auto-generate ID, instructions at lines 11–21)
4. `whatsapp` — new entry, `available: false`, placeholder credentials (access_token, phone_number_id, app_secret)
5. `sdk_web` — from existing SDK channel config, `available: true`, no credentials, no webhook
6. `sdk_mobile` — `available: false`, placeholder
7. `sdk_api` — from existing SDK API type, `available: true`
8. `http_async` — from existing webhook panel, `available: true`, no credentials
9. `voice_sip` — `available: false`, placeholder
10. `voice_pstn` — `available: false`, placeholder

### Step 4: Write test for registry

Create `apps/studio/src/__tests__/channel-registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// Test the registry — import types and registry
// Note: We can't import JSX icons in a pure TS test, so test the logic portions

describe('channel-registry', () => {
  it('exports CHANNEL_CATALOG_ORDER with all available channels first', async () => {
    // Dynamic import to handle JSX
    const { CHANNEL_CATALOG_ORDER, CHANNEL_REGISTRY } =
      await import('../components/deployments/channels/channel-registry');
    expect(CHANNEL_CATALOG_ORDER.length).toBeGreaterThanOrEqual(8);

    // Available channels should appear before unavailable
    const availableIds = CHANNEL_CATALOG_ORDER.filter(
      (id: string) => CHANNEL_REGISTRY[id]?.available,
    );
    const unavailableIds = CHANNEL_CATALOG_ORDER.filter(
      (id: string) => !CHANNEL_REGISTRY[id]?.available,
    );
    // All available should come before all unavailable in the order
    const lastAvailableIdx = Math.max(
      ...availableIds.map((id: string) => CHANNEL_CATALOG_ORDER.indexOf(id)),
    );
    const firstUnavailableIdx =
      unavailableIds.length > 0
        ? Math.min(...unavailableIds.map((id: string) => CHANNEL_CATALOG_ORDER.indexOf(id)))
        : Infinity;
    expect(lastAvailableIdx).toBeLessThan(firstUnavailableIdx);
  });

  it('every registry entry has required fields', async () => {
    const { CHANNEL_REGISTRY } =
      await import('../components/deployments/channels/channel-registry');
    for (const [id, def] of Object.entries(CHANNEL_REGISTRY)) {
      expect(def.id).toBe(id);
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.category).toMatch(/^(messaging|sdk|webhook|voice)$/);
      expect(def.capabilities).toBeDefined();
      expect(typeof def.capabilities.multiConnection).toBe('boolean');
      expect(typeof def.capabilities.hasCredentials).toBe('boolean');
      expect(Array.isArray(def.credentialFields)).toBe(true);
    }
  });

  it('credential fields have unique keys per channel type', async () => {
    const { CHANNEL_REGISTRY } =
      await import('../components/deployments/channels/channel-registry');
    for (const def of Object.values(CHANNEL_REGISTRY)) {
      const keys = def.credentialFields.map((f: { key: string }) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
```

### Step 5: Run test to verify it passes

```bash
cd apps/studio && pnpm build && pnpm test -- --run src/__tests__/channel-registry.test.ts
```

Expected: All 3 tests pass.

### Step 6: Commit

```bash
git add apps/studio/src/components/deployments/channels/types.ts \
       apps/studio/src/components/deployments/channels/channel-icons.tsx \
       apps/studio/src/components/deployments/channels/channel-registry.ts \
       apps/studio/src/__tests__/channel-registry.test.ts
git commit -m "[ABLP-2] feat(studio): add channel type registry and unified types"
```

---

## Task 2: Channel Instance Normalizer

**Files:**

- Create: `apps/studio/src/components/deployments/channels/channel-normalizer.ts`
- Test: `apps/studio/src/__tests__/channel-normalizer.test.ts`

### Step 1: Write the failing test

Create `apps/studio/src/__tests__/channel-normalizer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  normalizeSDKChannel,
  normalizeConnection,
  normalizeSubscription,
  normalizeAllInstances,
} from '../components/deployments/channels/channel-normalizer';
import type { SDKChannel } from '../api/channels';
import type { ChannelConnectionSummary } from '../api/channel-connections';
import type { WebhookSubscription } from '../api/http-async-channels';

describe('channel-normalizer', () => {
  describe('normalizeSDKChannel', () => {
    it('maps web SDK channel to ChannelInstance', () => {
      const sdk: SDKChannel = {
        id: 'ch-1',
        tenantId: 't-1',
        projectId: 'p-1',
        deploymentId: 'd-1',
        name: 'My Web Widget',
        channelType: 'web',
        publicApiKeyId: 'key-1',
        config: { mode: 'chat' },
        isActive: true,
        environment: 'production',
        followEnvironment: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      const instance = normalizeSDKChannel(sdk);
      expect(instance.id).toBe('sdk_ch-1');
      expect(instance.channelType).toBe('sdk_web');
      expect(instance.displayName).toBe('My Web Widget');
      expect(instance.status).toBe('active');
      expect(instance.environment).toBe('production');
      expect(instance._source).toBe('sdk_channel');
      expect(instance._sourceId).toBe('ch-1');
    });

    it('maps inactive SDK channel to inactive status', () => {
      const sdk: SDKChannel = {
        id: 'ch-2',
        tenantId: 't-1',
        projectId: 'p-1',
        deploymentId: null,
        name: 'Disabled',
        channelType: 'api',
        publicApiKeyId: 'key-1',
        config: {},
        isActive: false,
        environment: null,
        followEnvironment: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      const instance = normalizeSDKChannel(sdk);
      expect(instance.status).toBe('inactive');
      expect(instance.channelType).toBe('sdk_api');
    });
  });

  describe('normalizeConnection', () => {
    it('maps active Slack connection to ChannelInstance', () => {
      const conn: ChannelConnectionSummary = {
        id: 'conn-1',
        projectId: 'p-1',
        channelType: 'slack',
        displayName: 'Production Slack',
        externalIdentifier: 'T01ABCDEF',
        hasCredentials: true,
        config: {},
        status: 'active',
        deploymentId: 'd-1',
        environment: 'production',
        webhookUrl: 'https://example.com/webhook',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      const instance = normalizeConnection(conn);
      expect(instance.id).toBe('conn_conn-1');
      expect(instance.channelType).toBe('slack');
      expect(instance.displayName).toBe('Production Slack');
      expect(instance.status).toBe('active');
      expect(instance.hasCredentials).toBe(true);
      expect(instance.externalIdentifier).toBe('T01ABCDEF');
      expect(instance._source).toBe('channel_connection');
    });

    it('maps msteams channelType correctly', () => {
      const conn: ChannelConnectionSummary = {
        id: 'conn-2',
        projectId: 'p-1',
        channelType: 'msteams',
        displayName: null,
        externalIdentifier: 'app-id-123',
        hasCredentials: true,
        config: {},
        status: 'inactive',
        deploymentId: null,
        environment: null,
        webhookUrl: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      const instance = normalizeConnection(conn);
      expect(instance.channelType).toBe('msteams');
      expect(instance.status).toBe('inactive');
      expect(instance.displayName).toBe('Microsoft Teams');
    });
  });

  describe('normalizeSubscription', () => {
    it('maps active webhook subscription to ChannelInstance', () => {
      const sub: WebhookSubscription = {
        id: 'sub-1',
        channelConnectionId: 'cc-1',
        callbackUrl: 'https://example.com/hook',
        events: ['agent.response'],
        status: 'active',
        description: 'Prod webhook',
        failureCount: 0,
        lastDeliveryAt: '2026-01-02T00:00:00Z',
        agentId: 'a-1',
        projectId: 'p-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      const instance = normalizeSubscription(sub);
      expect(instance.id).toBe('sub_sub-1');
      expect(instance.channelType).toBe('http_async');
      expect(instance.displayName).toBe('Prod webhook');
      expect(instance.status).toBe('active');
      expect(instance._source).toBe('webhook_subscription');
    });

    it('maps paused subscription to paused status', () => {
      const sub: WebhookSubscription = {
        id: 'sub-2',
        channelConnectionId: 'cc-1',
        callbackUrl: 'https://example.com/hook2',
        events: ['agent.response'],
        status: 'paused',
        description: null,
        failureCount: 3,
        lastDeliveryAt: null,
        agentId: null,
        projectId: 'p-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };
      const instance = normalizeSubscription(sub);
      expect(instance.status).toBe('paused');
      expect(instance.displayName).toBe('https://example.com/hook2');
    });
  });

  describe('normalizeAllInstances', () => {
    it('groups instances by channel type', () => {
      const sdkChannels: SDKChannel[] = [
        {
          id: 'ch-1',
          tenantId: 't-1',
          projectId: 'p-1',
          deploymentId: null,
          name: 'Web',
          channelType: 'web',
          publicApiKeyId: 'k-1',
          config: {},
          isActive: true,
          environment: null,
          followEnvironment: false,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ];
      const connections: ChannelConnectionSummary[] = [
        {
          id: 'conn-1',
          projectId: 'p-1',
          channelType: 'slack',
          displayName: 'Slack Prod',
          externalIdentifier: 'T01',
          hasCredentials: true,
          config: {},
          status: 'active',
          deploymentId: null,
          environment: 'production',
          webhookUrl: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'conn-2',
          projectId: 'p-1',
          channelType: 'slack',
          displayName: 'Slack Dev',
          externalIdentifier: 'T02',
          hasCredentials: true,
          config: {},
          status: 'active',
          deploymentId: null,
          environment: 'dev',
          webhookUrl: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ];
      const subscriptions: WebhookSubscription[] = [];

      const result = normalizeAllInstances(sdkChannels, connections, subscriptions);
      expect(result.get('sdk_web')?.length).toBe(1);
      expect(result.get('slack')?.length).toBe(2);
      expect(result.get('http_async')).toBeUndefined();
    });
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd apps/studio && pnpm build && pnpm test -- --run src/__tests__/channel-normalizer.test.ts
```

Expected: FAIL — module not found.

### Step 3: Write the normalizer implementation

Create `apps/studio/src/components/deployments/channels/channel-normalizer.ts`:

```typescript
/**
 * Channel Instance Normalizer
 *
 * Maps the three backend API models into a unified ChannelInstance view model.
 * No backend API changes — pure frontend normalization.
 */

import type { SDKChannel } from '../../../api/channels';
import type { ChannelConnectionSummary } from '../../../api/channel-connections';
import type { WebhookSubscription } from '../../../api/http-async-channels';
import type { ChannelTypeId, ChannelInstance, InstanceStatus } from './types';
import { CHANNEL_REGISTRY } from './channel-registry';

// =============================================================================
// SDK CHANNEL → ChannelInstance
// =============================================================================

/** Map SDK channelType string to our ChannelTypeId */
function mapSDKType(sdkType: string): ChannelTypeId {
  switch (sdkType) {
    case 'web':
      return 'sdk_web';
    case 'mobile_ios':
    case 'mobile_android':
      return 'sdk_mobile';
    case 'api':
      return 'sdk_api';
    case 'voice':
    case 'voice_livekit':
    case 'voice_twilio':
      return 'voice_sip';
    default:
      return 'sdk_web';
  }
}

export function normalizeSDKChannel(ch: SDKChannel): ChannelInstance {
  return {
    id: `sdk_${ch.id}`,
    channelType: mapSDKType(ch.channelType),
    displayName: ch.name,
    status: ch.isActive ? 'active' : 'inactive',
    environment: ch.environment,
    externalIdentifier: null,
    hasCredentials: false,
    config: ch.config,
    createdAt: ch.createdAt,
    updatedAt: ch.updatedAt,
    _source: 'sdk_channel',
    _sourceId: ch.id,
  };
}

// =============================================================================
// CHANNEL CONNECTION → ChannelInstance
// =============================================================================

function mapConnectionStatus(status: string): InstanceStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'error':
      return 'error';
    default:
      return 'inactive';
  }
}

export function normalizeConnection(conn: ChannelConnectionSummary): ChannelInstance {
  const channelType = conn.channelType as ChannelTypeId;
  const def = CHANNEL_REGISTRY[channelType];
  return {
    id: `conn_${conn.id}`,
    channelType,
    displayName: conn.displayName || def?.name || conn.channelType,
    status: mapConnectionStatus(conn.status),
    environment: conn.environment,
    externalIdentifier: conn.externalIdentifier || null,
    hasCredentials: conn.hasCredentials,
    config: conn.config,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
    _source: 'channel_connection',
    _sourceId: conn.id,
  };
}

// =============================================================================
// WEBHOOK SUBSCRIPTION → ChannelInstance
// =============================================================================

function mapSubStatus(status: string): InstanceStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'deactivated':
      return 'inactive';
    default:
      return 'inactive';
  }
}

export function normalizeSubscription(sub: WebhookSubscription): ChannelInstance {
  return {
    id: `sub_${sub.id}`,
    channelType: 'http_async',
    displayName: sub.description || sub.callbackUrl,
    status: mapSubStatus(sub.status),
    environment: null,
    externalIdentifier: sub.callbackUrl,
    hasCredentials: false,
    config: { events: sub.events, callbackUrl: sub.callbackUrl },
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
    _source: 'webhook_subscription',
    _sourceId: sub.id,
  };
}

// =============================================================================
// AGGREGATE
// =============================================================================

export function normalizeAllInstances(
  sdkChannels: SDKChannel[],
  connections: ChannelConnectionSummary[],
  subscriptions: WebhookSubscription[],
): Map<ChannelTypeId, ChannelInstance[]> {
  const result = new Map<ChannelTypeId, ChannelInstance[]>();

  const addInstance = (instance: ChannelInstance) => {
    const existing = result.get(instance.channelType) || [];
    existing.push(instance);
    result.set(instance.channelType, existing);
  };

  for (const ch of sdkChannels) addInstance(normalizeSDKChannel(ch));
  for (const conn of connections) addInstance(normalizeConnection(conn));
  for (const sub of subscriptions) addInstance(normalizeSubscription(sub));

  return result;
}
```

### Step 4: Run test to verify it passes

```bash
cd apps/studio && pnpm build && pnpm test -- --run src/__tests__/channel-normalizer.test.ts
```

Expected: All 7 tests pass.

### Step 5: Commit

```bash
git add apps/studio/src/components/deployments/channels/channel-normalizer.ts \
       apps/studio/src/__tests__/channel-normalizer.test.ts
git commit -m "[ABLP-2] feat(studio): add channel instance normalizer for unified view model"
```

---

## Task 3: Channel Catalog Component (Level 1)

**Files:**

- Create: `apps/studio/src/components/deployments/channels/ChannelCatalog.tsx`

### Step 1: Build the catalog component

Create `apps/studio/src/components/deployments/channels/ChannelCatalog.tsx`.

This replaces the inline `ChannelCatalog` function currently at `ChannelsTab.tsx:202-280`.

**Key differences from current:**

- Uses `CHANNEL_REGISTRY` and `CHANNEL_CATALOG_ORDER` instead of inline `CHANNEL_CATALOG` array
- 3-column grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`) instead of 2-column
- Shows category badges (Messaging, SDK, Webhook, Voice)
- Instance count fetched from all three APIs via `normalizeAllInstances`
- Uses `clsx` (not template literals) for all className composition
- Uses semantic colors only

Props:

```typescript
interface ChannelCatalogProps {
  projectId: string;
  onSelect: (channelType: ChannelTypeId) => void;
}
```

Fetches on mount:

- `fetchChannels(projectId)` → SDK channels
- `fetchConnections(projectId)` → channel connections
- `fetchSubscriptions(projectId)` → webhook subscriptions

Passes all three to `normalizeAllInstances()` to get instance counts per type.

Each card renders:

- Channel icon (from registry `def.icon`)
- Channel name (from registry `def.name`)
- Description (from registry `def.description`)
- Category badge (`Badge` component, variant based on category)
- Instance count badge or "Available" or "Coming Soon"
- Click handler: `onSelect(def.id)` for available channels

### Step 2: Commit

```bash
git add apps/studio/src/components/deployments/channels/ChannelCatalog.tsx
git commit -m "[ABLP-2] feat(studio): add unified ChannelCatalog component (Level 1)"
```

---

## Task 4: Channel Instance List Component (Level 2)

**Files:**

- Create: `apps/studio/src/components/deployments/channels/ChannelInstanceList.tsx`
- Create: `apps/studio/src/components/deployments/channels/CreateInstanceDialog.tsx`

### Step 1: Build the instance list component

Create `apps/studio/src/components/deployments/channels/ChannelInstanceList.tsx`.

Props:

```typescript
interface ChannelInstanceListProps {
  projectId: string;
  channelType: ChannelTypeId;
  onBack: () => void;
  onSelectInstance: (instanceId: string) => void;
}
```

This component:

1. Looks up `ChannelTypeDef` from `CHANNEL_REGISTRY[channelType]`
2. Fetches instances for this channel type:
   - For `sdk_*`: `fetchChannels(projectId)`, filter by matching SDK type, normalize
   - For `http_async`: `fetchSubscriptions(projectId)`, normalize
   - For messaging types: `fetchConnections(projectId, channelType)`, normalize
3. Renders a `DataTable` with columns:
   - **Name**: `displayName` (sortable)
   - **Status**: Badge with dot (active/inactive/paused/error)
   - **Environment**: Badge or "—"
   - **Identifier**: Truncated external identifier
   - **Updated**: Relative timestamp (reuse `timeAgo` helper from old ChannelsTab)
   - **Actions**: Pause/Resume button (if `capabilities.supportsPauseResume`), Delete button
4. Header with:
   - Back arrow (calls `onBack`)
   - Channel icon + name
   - `+ New Connection` button (opens `CreateInstanceDialog`)
   - Optional setup instructions (collapsible `<details>`)
5. Row click: `onSelectInstance(instance.id)`
6. Empty state: `EmptyState` with channel icon, "No {name} connections yet", CTA to create

### Step 2: Build the create instance dialog

Create `apps/studio/src/components/deployments/channels/CreateInstanceDialog.tsx`.

This is a `Dialog` component that handles creating a new instance for any channel type.

Props:

```typescript
interface CreateInstanceDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  channelType: ChannelTypeId;
  onCreated: () => void;
}
```

The dialog dynamically renders fields based on `ChannelTypeDef`:

- Display name (always shown)
- External identifier (if not `autoGenerateIdentifier`)
- Credential fields (from `def.credentialFields`)
- Environment selector
- For `http_async`: callback URL and events

Dispatches create to correct API based on channel type:

- `sdk_*` → `createChannel(projectId, ...)`
- messaging → `createConnection(...)`
- `http_async` → `createSubscription(...)`

### Step 3: Commit

```bash
git add apps/studio/src/components/deployments/channels/ChannelInstanceList.tsx \
       apps/studio/src/components/deployments/channels/CreateInstanceDialog.tsx
git commit -m "[ABLP-2] feat(studio): add ChannelInstanceList and CreateInstanceDialog (Level 2)"
```

---

## Task 5: Channel Instance Config Shell (Level 3)

**Files:**

- Create: `apps/studio/src/components/deployments/channels/ChannelInstanceConfig.tsx`

### Step 1: Build the config shell

Create `apps/studio/src/components/deployments/channels/ChannelInstanceConfig.tsx`.

This is the Level 3 full-width tabbed config view.

Props:

```typescript
interface ChannelInstanceConfigProps {
  projectId: string;
  channelType: ChannelTypeId;
  instanceId: string;
  onBack: () => void;
}
```

This component:

1. Looks up `ChannelTypeDef` from registry
2. Resolves the source instance: extracts `_source` and `_sourceId` from the `instanceId` prefix (`sdk_`, `conn_`, `sub_`)
3. Fetches the full instance data from the appropriate API
4. Renders a **header** with:
   - Back arrow (to instance list)
   - Channel icon + display name + environment badge
   - Status badge with dot
   - Quick actions: Pause/Resume toggle, Delete (with ConfirmDialog)
5. Renders `Tabs` with conditional tabs based on `capabilities`:
   - Overview (always)
   - Credentials (if `capabilities.hasCredentials`)
   - Configuration (always)
   - Deployment (always)
   - Testing (if `capabilities.supportsTest`)
   - Activity (if `capabilities.supportsDeliveryLog`)
6. Renders the active tab content component

Tab component mapping:

```typescript
const TAB_COMPONENTS: Record<string, React.ComponentType<TabProps>> = {
  overview: OverviewTab,
  credentials: CredentialsTab,
  configuration: ConfigurationTab,
  deployment: DeploymentTab,
  testing: TestingTab,
  activity: ActivityTab,
};
```

Each tab receives:

```typescript
interface TabProps {
  projectId: string;
  channelType: ChannelTypeId;
  channelDef: ChannelTypeDef;
  instance: ChannelInstance;
  sourceData: SDKChannel | ChannelConnectionSummary | WebhookSubscription;
  onRefresh: () => void;
}
```

### Step 2: Commit

```bash
git add apps/studio/src/components/deployments/channels/ChannelInstanceConfig.tsx
git commit -m "[ABLP-2] feat(studio): add ChannelInstanceConfig tabbed shell (Level 3)"
```

---

## Task 6: Tab Components — Overview & Credentials

**Files:**

- Create: `apps/studio/src/components/deployments/channels/tabs/OverviewTab.tsx`
- Create: `apps/studio/src/components/deployments/channels/tabs/CredentialsTab.tsx`

### Step 1: Build OverviewTab

Create `apps/studio/src/components/deployments/channels/tabs/OverviewTab.tsx`.

Renders:

- **Connection Summary Card**: Status, created date, last activity, environment
- **Setup Instructions**: Collapsible section from `channelDef.setupInstructions`
- **Webhook URL** (if `channelDef.webhookUrlTemplate`): Read-only field with copy button
- **External Identifier** (if auto-generated): Read-only field with copy button (email inbound address, etc.)
- **Connection Details**: channel type, source model, IDs

Migrates webhook URL display logic from `ChannelSetupPanel.tsx:299-316`.
Migrates auto-generated identifier display from `ChannelSetupPanel.tsx:329-350`.

### Step 2: Build CredentialsTab

Create `apps/studio/src/components/deployments/channels/tabs/CredentialsTab.tsx`.

Renders dynamic credential form based on `channelDef.credentialFields[]`.

Migrates from `ChannelSetupPanel.tsx:390-412`:

- Shows "Credentials saved" indicator when `instance.hasCredentials` is true
- Input fields for each credential (placeholder shows "(saved — enter to update)" when already saved)
- Validation per field using `field.validation?.(value)`
- Save button dispatches to correct update API based on `instance._source`
- Clears credential inputs after save (credentials are encrypted server-side)
- Error display per field

### Step 3: Commit

```bash
git add apps/studio/src/components/deployments/channels/tabs/OverviewTab.tsx \
       apps/studio/src/components/deployments/channels/tabs/CredentialsTab.tsx
git commit -m "[ABLP-2] feat(studio): add OverviewTab and CredentialsTab for channel config"
```

---

## Task 7: Tab Components — Configuration & Deployment

**Files:**

- Create: `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx`
- Create: `apps/studio/src/components/deployments/channels/tabs/DeploymentTab.tsx`

### Step 1: Build ConfigurationTab

Create `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx`.

Renders channel-specific settings. Uses a **strategy pattern** based on `channelType`:

- **SDK channels**: Display name, widget mode (chat/voice/unified), position, features toggles. Migrates from `ChannelDetail.tsx` widget config section.
- **Messaging channels** (slack, msteams, email): Display name, external identifier (if not auto-generated). Migrates from `ChannelSetupPanel.tsx:327-388`.
- **HTTP Async**: Callback URL (editable), event subscriptions (checkboxes), description. Migrates from `HttpAsyncPanel` edit dialog logic.

Each strategy renders a form section with Save button.

### Step 2: Build DeploymentTab

Create `apps/studio/src/components/deployments/channels/tabs/DeploymentTab.tsx`.

Renders:

- **Environment selector**: Select dropdown (Working Copy, Development, Staging, Production). Migrates from `ChannelSetupPanel.tsx:377-388` and `ChannelDetail.tsx` deployment section.
- **Follow environment toggle**: Checkbox — when enabled, channel auto-follows the latest deployment to the selected environment. From `ChannelDetail.tsx` follow/pin logic.
- **Pin to specific deployment**: Optional override to pin to a specific deployment version.
- **Current deployment info**: Shows which deployment version is currently serving.

Fetches deployments via `fetchDeployments(projectId)`.

Save dispatches to correct update API.

### Step 3: Commit

```bash
git add apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx \
       apps/studio/src/components/deployments/channels/tabs/DeploymentTab.tsx
git commit -m "[ABLP-2] feat(studio): add ConfigurationTab and DeploymentTab for channel config"
```

---

## Task 8: Tab Components — Testing & Activity

**Files:**

- Create: `apps/studio/src/components/deployments/channels/tabs/TestingTab.tsx`
- Create: `apps/studio/src/components/deployments/channels/tabs/ActivityTab.tsx`

### Step 1: Build TestingTab

Create `apps/studio/src/components/deployments/channels/tabs/TestingTab.tsx`.

Strategy based on channel type:

- **HTTP Async**: Send test message form (migrates from `HttpAsyncPanel` test dialog). Input for message text, send button, result display.
- **SDK Web**: Preview widget link, embed code. Migrates from `ChannelDetail.tsx` preview section.
- **Messaging channels**: Send test message form (future API — shows placeholder with "Test message API coming soon" for now, since `POST /test-message` doesn't exist yet for connections).

### Step 2: Build ActivityTab

Create `apps/studio/src/components/deployments/channels/tabs/ActivityTab.tsx`.

Strategy based on source:

- **HTTP Async**: `fetchDeliveries(subscriptionId)` → DataTable with columns: Event Type, Status, HTTP Status, Attempts, Delivered At. Migrates from `HttpAsyncPanel` deliveries dialog.
- **SDK/Messaging**: Placeholder with "Activity log coming soon" — future integration with sessions/traces API.

Both show a refresh button and auto-refresh toggle.

### Step 3: Commit

```bash
git add apps/studio/src/components/deployments/channels/tabs/TestingTab.tsx \
       apps/studio/src/components/deployments/channels/tabs/ActivityTab.tsx
git commit -m "[ABLP-2] feat(studio): add TestingTab and ActivityTab for channel config"
```

---

## Task 9: Rewrite ChannelsTab Router & Modify DeploymentsPage

**Files:**

- Modify: `apps/studio/src/components/deployments/ChannelsTab.tsx` (rewrite)
- Modify: `apps/studio/src/components/deployments/DeploymentsPage.tsx`

### Step 1: Rewrite ChannelsTab as thin router

Replace the entire 1435-line `ChannelsTab.tsx` with a slim router (~80 lines):

```typescript
/**
 * ChannelsTab — slim router managing three navigation levels.
 *
 * Level 1: ChannelCatalog (grid of channel types)
 * Level 2: ChannelInstanceList (table of instances per type)
 * Level 3: ChannelInstanceConfig (full-width tabbed config)
 */

import { useState, useCallback } from 'react';
import type { ChannelNavLevel, ChannelTypeId } from './channels/types';
import { ChannelCatalog } from './channels/ChannelCatalog';
import { ChannelInstanceList } from './channels/ChannelInstanceList';
import { ChannelInstanceConfig } from './channels/ChannelInstanceConfig';

interface ChannelsTabProps {
  projectId: string;
  onExpandedChange?: (expanded: boolean) => void;
}

export function ChannelsTab({ projectId, onExpandedChange }: ChannelsTabProps) {
  const [nav, setNav] = useState<ChannelNavLevel>({ level: 'catalog' });

  const goToCatalog = useCallback(() => {
    setNav({ level: 'catalog' });
    onExpandedChange?.(false);
  }, [onExpandedChange]);

  const goToList = useCallback((channelType: ChannelTypeId) => {
    setNav({ level: 'list', channelType });
    onExpandedChange?.(false);
  }, [onExpandedChange]);

  const goToConfig = useCallback((channelType: ChannelTypeId, instanceId: string) => {
    setNav({ level: 'config', channelType, instanceId });
    onExpandedChange?.(true);
  }, [onExpandedChange]);

  switch (nav.level) {
    case 'catalog':
      return <ChannelCatalog projectId={projectId} onSelect={goToList} />;

    case 'list':
      return (
        <ChannelInstanceList
          projectId={projectId}
          channelType={nav.channelType}
          onBack={goToCatalog}
          onSelectInstance={(instanceId) => goToConfig(nav.channelType, instanceId)}
        />
      );

    case 'config':
      return (
        <ChannelInstanceConfig
          projectId={projectId}
          channelType={nav.channelType}
          instanceId={nav.instanceId}
          onBack={() => goToList(nav.channelType)}
        />
      );
  }
}
```

### Step 2: Modify DeploymentsPage for conditional width

Edit `apps/studio/src/components/deployments/DeploymentsPage.tsx`:

Add state for expanded mode and pass callback to ChannelsTab:

```typescript
const [channelExpanded, setChannelExpanded] = useState(false);
```

Change the container div:

```typescript
<div className={clsx(
  'mx-auto px-6 py-8',
  channelExpanded && activeTab === 'channels' ? 'max-w-6xl' : 'max-w-5xl'
)}>
```

Pass callback to ChannelsTab:

```typescript
{activeTab === 'channels' && (
  <ChannelsTab projectId={projectId} onExpandedChange={setChannelExpanded} />
)}
```

Add `clsx` import.

### Step 3: Run build to verify compilation

```bash
cd apps/studio && pnpm build
```

Expected: Build succeeds. The old inline SDK/HTTP Async panels and old ChannelSetupPanel-based panels are no longer imported.

### Step 4: Commit

```bash
git add apps/studio/src/components/deployments/ChannelsTab.tsx \
       apps/studio/src/components/deployments/DeploymentsPage.tsx
git commit -m "[ABLP-2] refactor(studio): rewrite ChannelsTab as thin router with conditional viewport"
```

---

## Task 10: Cleanup — Delete Old Files

**Files:**

- Delete: `apps/studio/src/components/deployments/channels/SlackSetupPanel.tsx`
- Delete: `apps/studio/src/components/deployments/channels/TeamsSetupPanel.tsx`
- Delete: `apps/studio/src/components/deployments/channels/EmailSetupPanel.tsx`
- Delete: `apps/studio/src/components/deployments/channels/ChannelSetupPanel.tsx`

### Step 1: Verify no remaining imports

```bash
grep -r "SlackSetupPanel\|TeamsSetupPanel\|EmailSetupPanel\|ChannelSetupPanel" apps/studio/src/ --include='*.tsx' --include='*.ts' -l
```

Expected: No results (all imports were in the old ChannelsTab.tsx which was rewritten).

### Step 2: Delete old files

```bash
rm apps/studio/src/components/deployments/channels/SlackSetupPanel.tsx
rm apps/studio/src/components/deployments/channels/TeamsSetupPanel.tsx
rm apps/studio/src/components/deployments/channels/EmailSetupPanel.tsx
rm apps/studio/src/components/deployments/channels/ChannelSetupPanel.tsx
```

### Step 3: Run build to confirm nothing breaks

```bash
cd apps/studio && pnpm build
```

Expected: Build succeeds.

### Step 4: Commit

```bash
git add -u apps/studio/src/components/deployments/channels/
git commit -m "[ABLP-2] refactor(studio): delete old channel setup panels replaced by unified UI"
```

---

## Task 11: Integration Test

**Files:**

- Modify: `apps/studio/src/__tests__/channel-registry.test.ts` (add integration assertions)

### Step 1: Add integration tests

Add test cases to verify:

1. All `CHANNEL_CATALOG_ORDER` entries exist in `CHANNEL_REGISTRY`
2. Every channel with `hasCredentials: true` has at least one credential field
3. Every channel with `hasWebhookUrl: true` has a `webhookUrlTemplate`
4. No duplicate IDs in catalog order

### Step 2: Run full test suite

```bash
cd apps/studio && pnpm build && pnpm test -- --run
```

Expected: All tests pass.

### Step 3: Commit

```bash
git add apps/studio/src/__tests__/channel-registry.test.ts
git commit -m "[ABLP-2] test(studio): add integration tests for channel registry consistency"
```

---

## Task Summary

| #   | Task                            | Files Created                                          | Files Modified                       | Files Deleted |
| --- | ------------------------------- | ------------------------------------------------------ | ------------------------------------ | ------------- |
| 1   | Types & Registry                | types.ts, channel-icons.tsx, channel-registry.ts, test | —                                    | —             |
| 2   | Normalizer                      | channel-normalizer.ts, test                            | —                                    | —             |
| 3   | Catalog (L1)                    | ChannelCatalog.tsx                                     | —                                    | —             |
| 4   | Instance List (L2)              | ChannelInstanceList.tsx, CreateInstanceDialog.tsx      | —                                    | —             |
| 5   | Instance Config (L3)            | ChannelInstanceConfig.tsx                              | —                                    | —             |
| 6   | Overview & Credentials tabs     | OverviewTab.tsx, CredentialsTab.tsx                    | —                                    | —             |
| 7   | Configuration & Deployment tabs | ConfigurationTab.tsx, DeploymentTab.tsx                | —                                    | —             |
| 8   | Testing & Activity tabs         | TestingTab.tsx, ActivityTab.tsx                        | —                                    | —             |
| 9   | Router rewrite & viewport       | —                                                      | ChannelsTab.tsx, DeploymentsPage.tsx | —             |
| 10  | Cleanup                         | —                                                      | —                                    | 4 old panels  |
| 11  | Integration test                | —                                                      | test file                            | —             |

**Total: 15 new files, 2 modified files, 4 deleted files, 11 commits**
