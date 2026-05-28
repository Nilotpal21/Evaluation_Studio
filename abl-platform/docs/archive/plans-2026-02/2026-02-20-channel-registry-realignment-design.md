# Channel Registry Realignment Design

## Goal

Align the Studio channel UI with all 22+ runtime channel types. The current UI covers 11 types; the runtime supports 9 registered adapters, 4 WebSocket handlers, a voice subsystem, and 2 protocol adapters (AG-UI, A2A) that have zero UI surface.

## Architecture

Provider-agnostic channel registry with 16 entries across 5 groups. Voice channels use a pluggable provider model where Kore.ai Voice Gateway (wrapping jambonz protocol) is the default provider, with room for Twilio, LiveKit-based hosted service, and others in the future.

## Tech Stack

- Studio: Next.js, React, Zustand, Tailwind, Framer Motion, Lucide
- Runtime: Express.js, WebSocket, MongoDB + Prisma
- Existing: `channel-registry.tsx`, `channel-normalizer.ts`, `channel-utils.ts`, `types.ts`

---

## Section 1: Channel Taxonomy (16 Types, 5 Groups)

### Messaging

| ID          | Label           | Source               | Runtime Adapter   |
| ----------- | --------------- | -------------------- | ----------------- |
| `slack`     | Slack           | `channel_connection` | Slack adapter     |
| `msteams`   | Microsoft Teams | `channel_connection` | MSTeams adapter   |
| `whatsapp`  | WhatsApp        | `channel_connection` | WhatsApp adapter  |
| `messenger` | Messenger       | `channel_connection` | Messenger adapter |

### SDK

| ID           | Label      | Source        | Runtime Adapter       |
| ------------ | ---------- | ------------- | --------------------- |
| `sdk_web`    | Web Widget | `sdk_channel` | SDK WebSocket handler |
| `sdk_mobile` | Mobile SDK | `sdk_channel` | SDK WebSocket handler |
| `sdk_api`    | REST API   | `sdk_channel` | HTTP handler          |

### Voice

| ID               | Label              | Source               | Runtime Adapter                      |
| ---------------- | ------------------ | -------------------- | ------------------------------------ |
| `voice_realtime` | Realtime LLM Voice | `channel_connection` | Jambonz WS handler (via Kore.ai VGW) |
| `voice_pipeline` | Pipeline Voice     | `channel_connection` | Jambonz WS handler (via Kore.ai VGW) |
| `voice_vxml`     | VXML IVR           | `channel_connection` | VXML adapter                         |

### Webhook

| ID           | Label        | Source                 | Runtime Adapter   |
| ------------ | ------------ | ---------------------- | ----------------- |
| `http_async` | HTTP Webhook | `webhook_subscription` | HttpAsync adapter |
| `email`      | Email        | `channel_connection`   | Email adapter     |

### Protocols

| ID      | Label                | Source               | Runtime Adapter      |
| ------- | -------------------- | -------------------- | -------------------- |
| `ag_ui` | AG-UI (CopilotKit)   | `channel_connection` | AG-UI SSE adapter    |
| `a2a`   | Agent-to-Agent (A2A) | `channel_connection` | A2A Express handlers |

**Removed from UI:**

- `voice_sip` (replaced by `voice_pipeline` + `voice_realtime`)
- `voice_pstn` (replaced by `voice_pipeline` + `voice_realtime`)

**Total: 14 active entries** (down from 16 -- voice_sip and voice_pstn merged into voice_realtime and voice_pipeline)

---

## Section 2: Voice Provider Architecture

### Provider-Agnostic Model

Voice channels don't couple to a specific infrastructure provider. They have a **Voice Provider** selector:

- **Default provider:** Kore.ai Voice Gateway (wraps jambonz protocol internally)
- **Future providers:** Twilio, LiveKit-based hosted service, others
- **Provider field on `channel_connection`:** `provider: 'kore_vgw'` (today always this)
- **Protocol field:** `provider_protocol: 'jambonz'` (auto-detected from provider, not user-facing)

### Data Model

```typescript
{
  channel_type: 'voice_realtime' | 'voice_pipeline' | 'voice_vxml',
  provider: 'kore_vgw',              // extensible to 'twilio', 'livekit_hosted'
  provider_protocol: 'jambonz',       // internal routing detail
  config: {
    // Shared telephony (voice_realtime + voice_pipeline only):
    sip: { uri, transport, credentials },
    phoneNumber: { provider: 'twilio' | 'telnyx', number, sid },

    // Shared ASR/TTS:
    asr: { vendor, model, language },
    tts: { vendor, voice, model },

    // Mode-specific:
    realtimeModel: 'openai' | 'gemini',   // voice_realtime only
    bargeIn: boolean,                      // voice_pipeline only
    speechTimeout: number,                 // voice_pipeline only
    welcomeMessage: string,                // voice_pipeline only
    vxmlDocUrl: string,                    // voice_vxml only
  }
}
```

### Runtime Routing

- `voice_realtime` + `provider: 'kore_vgw'` -> jambonz WebSocket handler (realtime mode)
- `voice_pipeline` + `provider: 'kore_vgw'` -> jambonz WebSocket handler (pipeline mode)
- `voice_vxml` -> VXML adapter (no provider abstraction needed)
- Legacy `channel_type: 'jambonz'` records continue to work (backward compatible)

---

## Section 3: Backend Fixes

### DB Enum Expansion

`packages/database/src/models/channel-connection.model.ts`:

```typescript
// Current:
CHANNEL_CONNECTION_TYPES = ['http_async', 'slack', 'email', 'msteams', 'vxml', 'jambonz'];

// New:
CHANNEL_CONNECTION_TYPES = [
  'http_async',
  'slack',
  'email',
  'msteams',
  'vxml',
  'jambonz', // kept for backward compat
  'whatsapp',
  'messenger', // messaging (unblocked)
  'voice_realtime',
  'voice_pipeline', // voice (new)
  'ag_ui',
  'a2a', // protocols (new)
];
```

### CRUD Route Expansion

`apps/runtime/src/routes/channel-connections.ts`:

```typescript
// Current:
VALID_CHANNEL_TYPES = ['slack', 'msteams', 'email'];

// New — match DB enum:
VALID_CHANNEL_TYPES = CHANNEL_CONNECTION_TYPES;
```

### Webhook Route

No changes needed. `ALLOWED_CHANNEL_TYPES` already includes `jambonz`, `whatsapp`, `messenger`.

### Migration

- Existing `jambonz` records remain valid and functional
- New voice connections use `voice_realtime` / `voice_pipeline`
- No data migration needed; dual-support at runtime

---

## Section 4: Normalizer Changes

### `channel-normalizer.ts` Updates

```typescript
// mapSDKType:
case 'voice':         return 'voice_pipeline';     // was: 'voice_sip'
case 'voice_livekit': return 'voice_realtime';      // was: 'voice_sip'
case 'voice_twilio':  return 'voice_pipeline';      // was: 'voice_sip'

// mapConnectionType (new entries):
case 'whatsapp':        return 'whatsapp';
case 'messenger':       return 'messenger';
case 'jambonz':         return 'voice_pipeline';    // legacy records
case 'voice_realtime':  return 'voice_realtime';
case 'voice_pipeline':  return 'voice_pipeline';
case 'ag_ui':           return 'ag_ui';
case 'a2a':             return 'a2a';
```

---

## Section 5: Voice Configuration Tab

The `ConfigurationTab` gains a `'voice'` category strategy with sub-sections:

### A. Provider Selector (all 3 voice types)

Select box defaulting to "Kore.ai Voice Gateway". Read-only protocol indicator below it.

### B. Telephony Configuration (voice_realtime + voice_pipeline only)

**SIP Config:**

- SIP URI, Transport (UDP/TCP/TLS), Auth User, Auth Password

**Phone Number:**

- Provider selector (Twilio / Telnyx)
- Number field (with assign/release actions)

### C. ASR / TTS Model Selection (voice_realtime + voice_pipeline only)

**ASR (Speech-to-Text):**

- Vendor (Deepgram, Google, Azure)
- Model (vendor-specific dropdown)
- Language

**TTS (Text-to-Speech):**

- Vendor (ElevenLabs, Google, Azure, Amazon Polly)
- Voice (vendor-specific dropdown)
- Model (vendor-specific)

### D. Mode-Specific Fields

- **voice_realtime:** Realtime model selector (OpenAI Realtime, Gemini Live)
- **voice_pipeline:** Barge-in toggle, speech timeout (ms), welcome message
- **voice_vxml:** VXML document URL, fallback URL

---

## Registry Entry Changes Summary

### New entries to add (7):

1. `whatsapp` — Messaging, channel_connection
2. `messenger` — Messaging, channel_connection
3. `voice_realtime` — Voice, channel_connection
4. `voice_pipeline` — Voice, channel_connection
5. `voice_vxml` — Voice, channel_connection (replaces `vxml` entry)
6. `ag_ui` — Protocols, channel_connection
7. `a2a` — Protocols, channel_connection

### Entries to remove (3):

1. `voice_sip` — replaced by voice_realtime + voice_pipeline
2. `voice_pstn` — replaced by voice_realtime + voice_pipeline
3. `vxml` — renamed to voice_vxml (stays in Voice group)

### Entries unchanged (8):

slack, msteams, sdk_web, sdk_mobile, sdk_api, http_async, email, (internal http_async webhook)

### Net change: 11 -> 14 entries (add 7, remove 3, keep 8, rename 1 from vxml to voice_vxml -- but vxml removal and voice_vxml addition nets the same)

---

## Implementation Plan

_Merged from `2026-02-20-channel-registry-realignment-plan.md`._

### Task 1: Update ChannelTypeId and ChannelCategory types

**Files:**

- Modify: `apps/studio/src/components/deployments/channels/types.ts:7-20`

**Context:** The `ChannelTypeId` union currently has 11 values including `voice_sip` and `voice_pstn`. We need to replace those with `voice_realtime`, `voice_pipeline`, `voice_vxml`, and add `ag_ui`, `a2a`. The `ChannelCategory` type needs `'protocol'` added.

**Step 1: Update the ChannelTypeId union**

Replace lines 7-18 in `types.ts`:

```typescript
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
  | 'voice_realtime'
  | 'voice_pipeline'
  | 'voice_vxml'
  | 'ag_ui'
  | 'a2a';
```

**Step 2: Update ChannelCategory**

Replace line 20:

```typescript
export type ChannelCategory = 'messaging' | 'sdk' | 'webhook' | 'voice' | 'protocol';
```

**Step 3: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=studio`

Expected: TypeScript errors in `channel-registry.tsx` because `voice_sip` and `voice_pstn` no longer exist in the union. This is correct — Task 3 will fix them.

**Step 4: Commit**

```bash
git add apps/studio/src/components/deployments/channels/types.ts
git commit -m "feat(studio): update ChannelTypeId union — replace voice_sip/voice_pstn, add voice_realtime/pipeline/vxml, ag_ui, a2a"
```

---

### Task 2: Add channel icons for new types

**Files:**

- Modify: `apps/studio/src/components/deployments/channels/channel-icons.tsx`

**Context:** The file currently has `WhatsAppIcon`, `SlackIcon`, `TeamsIcon`, `MessengerIcon`. We need icons for the new voice types, AG-UI, and A2A. Use simple, recognizable SVG paths. Voice types use Lucide `Phone`, `Mic`, `FileAudio` inline so we only need brand-style icons for AG-UI (SSE/streaming icon) and A2A (agent-to-agent icon).

**Step 1: Add AG-UI and A2A icons**

Append to `channel-icons.tsx`:

```tsx
export function AGUIIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 12h8" />
      <path d="M4 18V6" />
      <polyline points="12 6 12 18" />
      <path d="M16 12h4" />
      <circle cx="20" cy="12" r="2" />
      <path d="M16 6l4 0" />
      <circle cx="20" cy="6" r="2" />
      <path d="M16 18l4 0" />
      <circle cx="20" cy="18" r="2" />
    </svg>
  );
}

export function A2AIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="4" width="6" height="6" rx="1" />
      <rect x="16" y="14" width="6" height="6" rx="1" />
      <path d="M8 7h3a2 2 0 0 1 2 2v6a2 2 0 0 0 2 2h1" />
      <polyline points="14 15 16 17 14 19" />
    </svg>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/deployments/channels/channel-icons.tsx
git commit -m "feat(studio): add AG-UI and A2A channel icons"
```

---

### Task 3: Replace and add channel registry entries

**Files:**

- Modify: `apps/studio/src/components/deployments/channels/channel-registry.tsx`

**Context:** Replace `voice_sip` (lines 489-514) and `voice_pstn` (lines 516-541) with `voice_realtime`, `voice_pipeline`, `voice_vxml`. Add `ag_ui` and `a2a` entries. Update `CHANNEL_CATALOG_ORDER`. Add new icon imports.

**Step 1: Update imports**

Replace the import line at line 10:

```typescript
import {
  Globe,
  Webhook,
  Mail,
  Phone,
  Smartphone,
  MessageSquare,
  Mic,
  FileAudio,
  Radio,
  Network,
} from 'lucide-react';
```

Add to the channel-icons import at line 11:

```typescript
import {
  WhatsAppIcon,
  SlackIcon,
  TeamsIcon,
  MessengerIcon,
  AGUIIcon,
  A2AIcon,
} from './channel-icons';
```

**Step 2: Mark WhatsApp and Messenger as available**

Change `whatsapp` entry at line 229:

```typescript
    available: true,
```

Change `messenger` entry at line 299:

```typescript
    available: true,
```

**Step 3: Replace voice_sip with voice_realtime**

Delete the entire `voice_sip` entry (lines 489-514) and replace with:

```typescript
  voice_realtime: {
    id: 'voice_realtime',
    name: 'Realtime LLM Voice',
    description: 'Live voice conversations using realtime LLM models (OpenAI Realtime, Gemini Live) via Kore.ai Voice Gateway',
    icon: createElement(Radio, { className: 'w-4 h-4' }),
    available: true,
    category: 'voice',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Select a voice provider (defaults to Kore.ai Voice Gateway)</li>
        <li>Configure SIP endpoint and phone number in the Configuration tab</li>
        <li>Choose your realtime LLM model (OpenAI Realtime or Gemini Live)</li>
        <li>Select ASR and TTS model preferences</li>
        <li>Assign the channel to a deployment environment</li>
      </ol>
    ),
    webhookUrlTemplate: null,
    externalIdentifierLabel: 'Connection Name',
    externalIdentifierPlaceholder: 'e.g. realtime-voice-prod',
  },
```

**Step 4: Replace voice_pstn with voice_pipeline**

Delete the entire `voice_pstn` entry (lines 516-541) and replace with:

```typescript
  voice_pipeline: {
    id: 'voice_pipeline',
    name: 'Pipeline Voice',
    description: 'Traditional STT → LLM → TTS voice pipeline via Kore.ai Voice Gateway with configurable ASR/TTS models',
    icon: createElement(Mic, { className: 'w-4 h-4' }),
    available: true,
    category: 'voice',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Select a voice provider (defaults to Kore.ai Voice Gateway)</li>
        <li>Configure SIP endpoint and phone number in the Configuration tab</li>
        <li>Choose ASR (speech-to-text) and TTS (text-to-speech) vendors and models</li>
        <li>Set barge-in behavior and speech timeout</li>
        <li>Assign the channel to a deployment environment</li>
      </ol>
    ),
    webhookUrlTemplate: null,
    externalIdentifierLabel: 'Connection Name',
    externalIdentifierPlaceholder: 'e.g. pipeline-voice-prod',
  },
```

**Step 5: Add voice_vxml entry**

After `voice_pipeline`, add:

```typescript
  voice_vxml: {
    id: 'voice_vxml',
    name: 'VXML IVR',
    description: 'VoiceXML 2.1 gateway for traditional IVR systems with DTMF and prompt-based navigation',
    icon: createElement(FileAudio, { className: 'w-4 h-4' }),
    available: true,
    category: 'voice',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Create a connection and provide your VXML document URL</li>
        <li>The platform serves VoiceXML 2.1 documents for your IVR system to consume</li>
        <li>Configure fallback URL and error handling in the Configuration tab</li>
      </ol>
    ),
    webhookUrlTemplate: null,
    externalIdentifierLabel: 'IVR System Name',
    externalIdentifierPlaceholder: 'e.g. main-ivr-menu',
  },
```

**Step 6: Add protocol entries (ag_ui and a2a)**

After `voice_vxml`, add a new section:

```typescript
  // ── Protocol channels ──────────────────────────────────────────────────

  ag_ui: {
    id: 'ag_ui',
    name: 'AG-UI (CopilotKit)',
    description: 'Server-sent events protocol for React/Next.js frontend agent UIs with streaming support',
    icon: createElement(AGUIIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'protocol',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Create a connection and assign it to a deployment</li>
        <li>Use the AG-UI SDK in your React/Next.js frontend to connect</li>
        <li>The agent streams responses as SSE events with structured payloads</li>
      </ol>
    ),
    webhookUrlTemplate: null,
    externalIdentifierLabel: 'Frontend App Name',
    externalIdentifierPlaceholder: 'e.g. copilot-dashboard',
  },

  a2a: {
    id: 'a2a',
    name: 'Agent-to-Agent (A2A)',
    description: 'Google A2A protocol for inter-agent communication with task lifecycle management',
    icon: createElement(A2AIcon, { className: 'w-4 h-4' }),
    available: true,
    category: 'protocol',
    capabilities: {
      multiConnection: true,
      hasCredentials: false,
      hasWebhookUrl: false,
      supportsTest: false,
      supportsDeliveryLog: false,
      autoGenerateIdentifier: false,
      supportsPauseResume: false,
    },
    credentialFields: [],
    setupInstructions: (
      <ol className="list-decimal list-inside space-y-1.5">
        <li>Create a connection to expose this agent via the A2A protocol</li>
        <li>Other A2A-compatible agents can discover and interact with your agent</li>
        <li>Supports task lifecycle: submitted → working → completed</li>
      </ol>
    ),
    webhookUrlTemplate: null,
    externalIdentifierLabel: 'Agent Endpoint Name',
    externalIdentifierPlaceholder: 'e.g. booking-agent-a2a',
  },
```

**Step 7: Update CHANNEL_CATALOG_ORDER**

Replace the existing `CHANNEL_CATALOG_ORDER` (lines 548-560) with a grouped order:

```typescript
export const CHANNEL_CATALOG_ORDER: ChannelTypeId[] = [
  // Messaging
  'slack',
  'msteams',
  'whatsapp',
  'messenger',
  'email',
  // SDK
  'sdk_web',
  'sdk_api',
  'sdk_mobile',
  // Voice
  'voice_realtime',
  'voice_pipeline',
  'voice_vxml',
  // Webhook
  'http_async',
  // Protocols
  'ag_ui',
  'a2a',
];
```

**Step 8: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=studio`

Expected: PASS (all type errors resolved)

**Step 9: Commit**

```bash
git add apps/studio/src/components/deployments/channels/channel-registry.tsx
git commit -m "feat(studio): replace voice_sip/pstn with realtime/pipeline/vxml, add ag_ui and a2a channel entries"
```

---

### Task 4: Update channel normalizer

**Files:**

- Modify: `apps/studio/src/components/deployments/channels/channel-normalizer.ts:24-37,72-89`

**Context:** `mapSDKType` currently maps voice types to the removed `voice_sip`. `normalizeConnection` casts `conn.channelType` directly as `ChannelTypeId` without mapping. We need to update `mapSDKType` and add proper mapping in `normalizeConnection` for new types.

**Step 1: Update mapSDKType (lines 24-37)**

Replace the function:

```typescript
/** Map SDK channelType string to our ChannelTypeId */
function mapSDKType(sdkType: SDKChannel['channelType']): ChannelTypeId {
  switch (sdkType) {
    case 'web':
      return 'sdk_web';
    case 'mobile_ios':
    case 'mobile_android':
      return 'sdk_mobile';
    case 'api':
      return 'sdk_api';
    case 'voice':
    case 'voice_twilio':
      return 'voice_pipeline';
    case 'voice_livekit':
      return 'voice_realtime';
    default:
      return 'sdk_web';
  }
}
```

**Step 2: Add mapConnectionType function**

After `mapSDKType`, add:

```typescript
/** Map channel_connection.channelType string to our ChannelTypeId */
function mapConnectionType(connType: string): ChannelTypeId {
  switch (connType) {
    case 'slack':
      return 'slack';
    case 'msteams':
      return 'msteams';
    case 'email':
      return 'email';
    case 'whatsapp':
      return 'whatsapp';
    case 'messenger':
      return 'messenger';
    case 'vxml':
      return 'voice_vxml';
    case 'jambonz':
      return 'voice_pipeline';
    case 'voice_realtime':
      return 'voice_realtime';
    case 'voice_pipeline':
      return 'voice_pipeline';
    case 'ag_ui':
      return 'ag_ui';
    case 'a2a':
      return 'a2a';
    case 'http_async':
      return 'http_async';
    default:
      return connType as ChannelTypeId;
  }
}
```

**Step 3: Update normalizeConnection to use mapConnectionType**

In the `normalizeConnection` function (line 72-89), change line 73 from:

```typescript
const channelType = conn.channelType as ChannelTypeId;
```

to:

```typescript
const channelType = mapConnectionType(conn.channelType);
```

**Step 4: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=studio`

Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/components/deployments/channels/channel-normalizer.ts
git commit -m "feat(studio): update normalizer — map jambonz→voice_pipeline, vxml→voice_vxml, add ag_ui/a2a"
```

---

### Task 5: Grouped catalog layout

**Files:**

- Modify: `apps/studio/src/components/deployments/channels/ChannelCatalog.tsx:20-21,56-67,151-199`

**Context:** The catalog currently renders a flat grid of all channels. We need to group them by category with section headers. The `getCategoryVariant` function needs `'protocol'` added.

**Step 1: Add protocol variant and group label map**

Update `getCategoryVariant` (lines 56-67) to include protocol:

```typescript
function getCategoryVariant(category: ChannelCategory): BadgeVariant {
  switch (category) {
    case 'messaging':
      return 'info';
    case 'sdk':
      return 'accent';
    case 'webhook':
      return 'warning';
    case 'voice':
      return 'purple';
    case 'protocol':
      return 'default';
  }
}

const CATEGORY_LABELS: Record<ChannelCategory, string> = {
  messaging: 'Messaging',
  sdk: 'SDK',
  voice: 'Voice',
  webhook: 'Webhook',
  protocol: 'Protocols',
};

const CATEGORY_ORDER: ChannelCategory[] = ['messaging', 'sdk', 'voice', 'webhook', 'protocol'];
```

**Step 2: Update the render to use grouped layout**

Replace the grid rendering section (inside the `else` branch of `loading`, approximately lines 160-198) with:

```tsx
<div className="space-y-6">
  {CATEGORY_ORDER.map((category) => {
    const channels = CHANNEL_CATALOG_ORDER.map((id) => CHANNEL_REGISTRY[id]).filter(
      (def) => def.category === category,
    );

    if (channels.length === 0) return null;

    return (
      <div key={category}>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
            {CATEGORY_LABELS[category]}
          </h3>
          <div className="flex-1 border-t border-default" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {channels.map((def) => (
            <button
              key={def.id}
              onClick={() => (def.available ? onSelect(def.id) : undefined)}
              disabled={!def.available}
              className={clsx(
                'text-left p-4 rounded-lg border transition-default',
                def.available
                  ? 'bg-background-elevated border-default hover:border-accent cursor-pointer card-hover'
                  : 'bg-background-subtle border-default opacity-60 cursor-default',
              )}
            >
              <div className="flex items-start gap-3">
                <div
                  className={clsx(
                    'shrink-0 p-2 rounded-lg',
                    def.available ? 'bg-accent-subtle' : 'bg-background-muted',
                  )}
                >
                  {def.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-foreground">{def.name}</p>
                    {getStatusBadge(def, instanceCounts)}
                  </div>
                  <p className="mt-1 text-xs text-muted line-clamp-2">{def.description}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  })}
</div>
```

Note: We remove the per-card category badge since the cards are now grouped by category — the section header replaces it.

**Step 3: Remove unused BadgeVariant import if getCategoryVariant is no longer used per-card**

The `getCategoryVariant` function and `BadgeVariant` import can be removed since the per-card category badge is gone. Keep the `Badge` import for the status badge.

Update the import at line 19:

```typescript
import { Badge } from '../../ui/Badge';
```

Remove the now-unused `getCategoryVariant` function.

**Step 4: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=studio`

Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/components/deployments/channels/ChannelCatalog.tsx
git commit -m "feat(studio): grouped channel catalog layout with category section headers"
```

---

### Task 6: Expand DB channel connection types

**Files:**

- Modify: `packages/database/src/models/channel-connection.model.ts:13`

**Context:** The MongoDB enum currently only allows `['http_async', 'slack', 'email', 'msteams', 'vxml', 'jambonz']`. We need to add `whatsapp`, `messenger`, `voice_realtime`, `voice_pipeline`, `ag_ui`, `a2a`. Keep `jambonz` and `vxml` for backward compatibility with existing records.

**Step 1: Expand the enum**

Replace line 13:

```typescript
const CHANNEL_CONNECTION_TYPES = [
  'http_async',
  'slack',
  'email',
  'msteams',
  'vxml',
  'jambonz',
  'whatsapp',
  'messenger',
  'voice_realtime',
  'voice_pipeline',
  'ag_ui',
  'a2a',
] as const;
```

**Step 2: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=@agent-platform/database`

Expected: PASS

**Step 3: Commit**

```bash
git add packages/database/src/models/channel-connection.model.ts
git commit -m "feat(database): expand channel connection types — add whatsapp, messenger, voice_realtime, voice_pipeline, ag_ui, a2a"
```

---

### Task 7: Expand CRUD route validation

**Files:**

- Modify: `apps/runtime/src/routes/channel-connections.ts:35-37,48-69`

**Context:** `VALID_CHANNEL_TYPES` at line 35 is `['slack', 'msteams', 'email']` which blocks creation of all other channel types. The `validateCredentials` function only handles those 3 types and returns an error for everything else.

**Step 1: Expand VALID_CHANNEL_TYPES**

Replace lines 35-37:

```typescript
const VALID_CHANNEL_TYPES = [
  'slack',
  'msteams',
  'email',
  'whatsapp',
  'messenger',
  'vxml',
  'jambonz',
  'voice_realtime',
  'voice_pipeline',
  'ag_ui',
  'a2a',
] as const;
type ChannelType = (typeof VALID_CHANNEL_TYPES)[number];
```

**Step 2: Update validateCredentials to not reject unknown types**

The `validateCredentials` function has a `default` case that returns `Unsupported channel type`. Change the default case (line 67) to return `null` instead — new channel types with no required credentials should pass validation:

```typescript
    default:
      // Channel types without per-connection credentials (voice, protocols, etc.)
      return null;
```

**Step 3: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=runtime`

Expected: PASS

**Step 4: Commit**

```bash
git add apps/runtime/src/routes/channel-connections.ts
git commit -m "feat(runtime): expand valid channel types for CRUD — unblock whatsapp, messenger, voice, protocols"
```

---

### Task 8: Add voice configuration fields to ConfigurationTab

**Files:**

- Modify: `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx`

**Context:** The `ConfigurationTab` uses a strategy pattern based on `channelDef.category`. Currently handles `messaging`, `webhook`, `sdk`, and `voice` (as placeholder). We need to replace the voice placeholder with real config: provider selector, telephony (SIP + phone number), ASR/TTS models, and mode-specific fields.

**Step 1: Add voice-related constants**

After the existing `AVAILABLE_EVENTS` constant (line 31), add:

```typescript
const VOICE_PROVIDERS = [{ value: 'kore_vgw', label: 'Kore.ai Voice Gateway' }] as const;

const ASR_VENDORS = [
  { value: 'deepgram', label: 'Deepgram' },
  { value: 'google', label: 'Google Cloud Speech' },
  { value: 'azure', label: 'Azure Speech' },
] as const;

const TTS_VENDORS = [
  { value: 'elevenlabs', label: 'ElevenLabs' },
  { value: 'google_tts', label: 'Google Cloud TTS' },
  { value: 'azure_speech', label: 'Azure Speech' },
  { value: 'amazon_polly', label: 'Amazon Polly' },
] as const;

const SIP_TRANSPORT_OPTIONS = [
  { value: 'udp', label: 'UDP' },
  { value: 'tcp', label: 'TCP' },
  { value: 'tls', label: 'TLS' },
] as const;

const PHONE_NUMBER_PROVIDERS = [
  { value: 'twilio', label: 'Twilio' },
  { value: 'telnyx', label: 'Telnyx' },
] as const;

const REALTIME_MODELS = [
  { value: 'openai_realtime', label: 'OpenAI Realtime' },
  { value: 'gemini_live', label: 'Gemini Live' },
] as const;
```

**Step 2: Add VoiceFields component**

After the existing `SDKFields` component (line 132), add:

```tsx
function VoiceFields({
  channelType,
  config,
  setConfig,
}: {
  channelType: ChannelTypeId;
  config: Record<string, unknown>;
  setConfig: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
}) {
  const isVxml = channelType === 'voice_vxml';
  const isRealtime = channelType === 'voice_realtime';
  const isPipeline = channelType === 'voice_pipeline';

  const updateField = (key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <>
      {/* Provider */}
      <Select
        label="Voice Provider"
        options={VOICE_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
        value={(config.provider as string) || 'kore_vgw'}
        onChange={(e) => updateField('provider', e.target.value)}
      />

      {/* SIP Configuration — realtime and pipeline only */}
      {!isVxml && (
        <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            SIP Configuration
          </h5>
          <Input
            label="SIP URI"
            placeholder="sip:agent@gw.kore.ai"
            value={(config.sipUri as string) || ''}
            onChange={(e) => updateField('sipUri', e.target.value)}
          />
          <Select
            label="Transport"
            options={SIP_TRANSPORT_OPTIONS.map((t) => ({ value: t.value, label: t.label }))}
            value={(config.sipTransport as string) || 'tls'}
            onChange={(e) => updateField('sipTransport', e.target.value)}
          />
        </div>
      )}

      {/* Phone Number — realtime and pipeline only */}
      {!isVxml && (
        <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Phone Number
          </h5>
          <Select
            label="Provider"
            options={PHONE_NUMBER_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
            value={(config.phoneProvider as string) || 'twilio'}
            onChange={(e) => updateField('phoneProvider', e.target.value)}
          />
          <Input
            label="Phone Number"
            placeholder="+1 (555) 123-4567"
            value={(config.phoneNumber as string) || ''}
            onChange={(e) => updateField('phoneNumber', e.target.value)}
          />
        </div>
      )}

      {/* ASR / TTS — realtime and pipeline only */}
      {!isVxml && (
        <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Speech Models
          </h5>
          <Select
            label="ASR Vendor"
            options={ASR_VENDORS.map((v) => ({ value: v.value, label: v.label }))}
            value={(config.asrVendor as string) || 'deepgram'}
            onChange={(e) => updateField('asrVendor', e.target.value)}
          />
          <Select
            label="TTS Vendor"
            options={TTS_VENDORS.map((v) => ({ value: v.value, label: v.label }))}
            value={(config.ttsVendor as string) || 'elevenlabs'}
            onChange={(e) => updateField('ttsVendor', e.target.value)}
          />
        </div>
      )}

      {/* Realtime model selector */}
      {isRealtime && (
        <Select
          label="Realtime Model"
          options={REALTIME_MODELS.map((m) => ({ value: m.value, label: m.label }))}
          value={(config.realtimeModel as string) || 'openai_realtime'}
          onChange={(e) => updateField('realtimeModel', e.target.value)}
        />
      )}

      {/* Pipeline-specific fields */}
      {isPipeline && (
        <div className="space-y-3">
          <Checkbox
            checked={Boolean(config.bargeIn)}
            onChange={(checked) => updateField('bargeIn', checked)}
            label="Barge-in"
            description="Allow caller to interrupt the agent while it is speaking"
          />
          <Input
            label="Speech Timeout (ms)"
            placeholder="e.g. 3000"
            value={String(config.speechTimeout || '')}
            onChange={(e) => updateField('speechTimeout', Number(e.target.value) || null)}
          />
          <Input
            label="Welcome Message"
            placeholder="Hello! How can I help you today?"
            value={(config.welcomeMessage as string) || ''}
            onChange={(e) => updateField('welcomeMessage', e.target.value)}
          />
        </div>
      )}

      {/* VXML-specific fields */}
      {isVxml && (
        <div className="space-y-3">
          <Input
            label="VXML Document URL"
            placeholder="https://your-server.com/vxml/main.xml"
            value={(config.vxmlDocUrl as string) || ''}
            onChange={(e) => updateField('vxmlDocUrl', e.target.value)}
          />
          <Input
            label="Fallback URL"
            placeholder="https://your-server.com/vxml/error.xml"
            value={(config.vxmlFallbackUrl as string) || ''}
            onChange={(e) => updateField('vxmlFallbackUrl', e.target.value)}
          />
        </div>
      )}
    </>
  );
}
```

**Step 3: Add Select import**

Add to the imports at the top of the file:

```typescript
import { Select } from '../../../ui/Select';
```

Also add `ChannelTypeId` to the type imports:

```typescript
import type { ChannelTabProps, ChannelTypeDef, ChannelInstance, ChannelTypeId } from '../types';
```

**Step 4: Wire VoiceFields into the component**

In the `ConfigurationTab` component, add state for voice config (after the existing `events` state, around line 148-150):

```typescript
const [voiceConfig, setVoiceConfig] = useState<Record<string, unknown>>(instance.config || {});
```

In the render section, after the `{channelDef.category === 'sdk' && <SDKFields />}` block (line 272), replace the existing voice placeholder (lines 274-281) with:

```tsx
{
  channelDef.category === 'voice' && (
    <VoiceFields channelType={channelType} config={voiceConfig} setConfig={setVoiceConfig} />
  );
}
```

Also add `'protocol'` handling after the voice block:

```tsx
{
  channelDef.category === 'protocol' && (
    <div className="flex items-start gap-2.5 p-3 rounded-lg bg-background-muted border border-default">
      <Info className="w-4 h-4 text-muted shrink-0 mt-0.5" />
      <p className="text-sm text-muted">
        Protocol channels are configured through the SDK integration. No additional settings needed.
      </p>
    </div>
  );
}
```

**Step 5: Update handleSave to include voice config**

In the `handleSave` callback, add a case for voice channel types. In the `channel_connection` case (line 197-200), update to merge voiceConfig:

```typescript
        case 'channel_connection': {
          const payload: Record<string, unknown> = {
            display_name: displayName,
          };
          if (channelDef.category === 'voice') {
            payload.config = voiceConfig;
          }
          await updateConnection(instance._sourceId, payload);
          break;
        }
```

**Step 6: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=studio`

Expected: PASS

**Step 7: Commit**

```bash
git add apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx
git commit -m "feat(studio): add voice configuration fields — provider, SIP, phone number, ASR/TTS, mode-specific settings"
```

---

### Task 9: Update ChannelInstanceConfig tab definitions for new categories

**Files:**

- Modify: `apps/studio/src/components/deployments/channels/ChannelInstanceConfig.tsx:70-75`

**Context:** The `resolveSource` function uses instance ID prefixes to determine backend source. Voice, protocol, WhatsApp, and Messenger channels use `channel_connection` source and get `conn_` prefix from the normalizer — so no changes needed there. However, we should verify the tab visibility logic works for the new categories. The `voice` category should show Configuration (for voice fields) but hide Credentials and Testing. Protocol category should show Configuration and Overview only.

**Step 1: Verify no changes needed**

Read through `ChannelInstanceConfig.tsx` and confirm:

- `resolveSource` handles `sdk_`, `conn_`, `sub_` prefixes — correct, no new prefixes needed
- `TAB_DEFINITIONS` visibility uses capabilities (`hasCredentials`, `supportsTest`, `supportsDeliveryLog`) — correct, the new registry entries set these to `false` so tabs auto-hide
- No category-specific logic in this file — all driven by capabilities

No code changes needed. Move on.

---

### Task 10: Run full build and verify

**Files:** None (verification only)

**Step 1: Build the full monorepo**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build`

Expected: PASS for all packages

**Step 2: Run Studio tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm test --filter=studio`

Expected: PASS (existing tests should still work since they mock channel data)

**Step 3: If tests fail, fix type errors**

Common issues:

- Test files may reference `voice_sip` or `voice_pstn` in mock data — update to `voice_realtime` or `voice_pipeline`
- Test files may not include `'protocol'` in category assertions — add it

**Step 4: Final commit if any test fixes were needed**

```bash
git add -A
git commit -m "fix(studio): update tests for new channel type IDs"
```
