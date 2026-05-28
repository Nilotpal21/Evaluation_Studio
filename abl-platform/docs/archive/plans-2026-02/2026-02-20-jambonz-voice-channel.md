# Jambonz Voice Channel Provisioning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire Jambonz (KoreVG) as the voice gateway for `voice_pipeline` and `voice_realtime` channel connections — auto-provisioning Jambonz applications and phone numbers on channel CRUD, with a refreshed Studio UI.

**Architecture:** Jambonz credentials live at server/env level (one account per deployment). Each `ChannelConnection` of type `voice_pipeline` or `voice_realtime` maps 1:1 to a Jambonz Application. On create/update/delete of such a connection, a `JambonzProvisioningService` calls the Jambonz REST API and writes the resulting SIDs back into `ChannelConnection.config`. The Studio UI drops the provider dropdown and phone-number free-text in favour of a Twilio-fetched dropdown, plus full ASR/TTS language/voice/region fields.

**Tech Stack:** TypeScript, Express, Mongoose (MongoDB), Zod, Twilio Node SDK, React (Next.js app router), existing `RequestAgent` pattern replaced with plain `fetch` wrapped in a service class.

---

## Task 1: Add Jambonz env config to voice schema

**Files:**

- Modify: `packages/config/src/schemas/voice.schema.ts`
- Modify: `packages/config/src/env-mapping.ts`

**Context:** The `VoiceConfigSchema` already has `twilio`, `deepgram`, `elevenLabs`, `livekit` blocks. We add a `jambonz` block beside them. `env-mapping.ts` maps flat `JAMBONZ_*` env vars to the nested schema paths.

**Step 1: Add jambonz block to voice schema**

In `packages/config/src/schemas/voice.schema.ts`, add after the `livekit` block:

```typescript
jambonz: z
  .object({
    baseApiUrl: z.string().url().optional(),
    accountSid: z.string().optional(),
    apiKey: z.string().optional(),
    voipCarrierSid: z.string().optional(),
    serviceProviderId: z.string().optional(),
    serviceProviderApiKey: z.string().optional(),
  })
  .default({}),
```

**Step 2: Add env var mappings**

In `packages/config/src/env-mapping.ts`, inside `BASE_ENV_MAPPING`, add after the Redis block:

```typescript
// Jambonz (Voice Gateway)
JAMBONZ_BASE_API_URL: 'voice.jambonz.baseApiUrl',
JAMBONZ_ACCOUNT_SID: 'voice.jambonz.accountSid',
JAMBONZ_API_KEY: 'voice.jambonz.apiKey',
JAMBONZ_VOIP_CARRIER_SID: 'voice.jambonz.voipCarrierSid',
JAMBONZ_SERVICE_PROVIDER_ID: 'voice.jambonz.serviceProviderId',
JAMBONZ_SERVICE_PROVIDER_API_KEY: 'voice.jambonz.serviceProviderApiKey',
```

**Step 3: Verify typecheck passes**

```bash
pnpm --filter @agent-platform/config typecheck
```

Expected: no errors.

**Step 4: Commit**

```bash
git add packages/config/src/schemas/voice.schema.ts packages/config/src/env-mapping.ts
git commit -m "feat(config): add jambonz env config block to voice schema"
```

---

## Task 2: JambonzProvisioningService

**Files:**

- Create: `apps/runtime/src/services/voice/jambonz-provisioning.service.ts`
- Create: `apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts`

**Context:** This service wraps the Jambonz REST API (same calls as `KoreVGService.js` in koreserver). It reads credentials from the loaded voice config. All HTTP calls use native `fetch`. Singleton via lazy-init pattern matching `getEncryptionService()`.

**Step 1: Write failing tests**

```typescript
// apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const MOCK_CONFIG = {
  jambonz: {
    baseApiUrl: 'https://jambonz.example.com',
    accountSid: 'acc-123',
    apiKey: 'key-abc',
    voipCarrierSid: 'carrier-456',
  },
};

describe('JambonzProvisioningService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createApplication sends POST /Applications with correct payload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'app-sid-001' }),
    });
    const { JambonzProvisioningService } =
      await import('../services/voice/jambonz-provisioning.service.js');
    const svc = new JambonzProvisioningService(MOCK_CONFIG.jambonz as any);
    const sid = await svc.createApplication({
      name: 'test-bot',
      webhookUrl: 'wss://runtime.example.com/channels/jambonz?id=conn-1',
    });
    expect(sid).toBe('app-sid-001');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://jambonz.example.com/Applications',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('deleteApplication sends DELETE /Applications/:sid', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const { JambonzProvisioningService } =
      await import('../services/voice/jambonz-provisioning.service.js');
    const svc = new JambonzProvisioningService(MOCK_CONFIG.jambonz as any);
    await expect(svc.deleteApplication('app-sid-001')).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://jambonz.example.com/Applications/app-sid-001',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('addPhoneNumber sends POST /PhoneNumbers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: 'pn-sid-002' }),
    });
    const { JambonzProvisioningService } =
      await import('../services/voice/jambonz-provisioning.service.js');
    const svc = new JambonzProvisioningService(MOCK_CONFIG.jambonz as any);
    const sid = await svc.addPhoneNumber({
      phoneNumber: '+12345678',
      applicationSid: 'app-sid-001',
    });
    expect(sid).toBe('pn-sid-002');
  });

  it('throws if baseApiUrl is not configured', async () => {
    const { JambonzProvisioningService } =
      await import('../services/voice/jambonz-provisioning.service.js');
    const svc = new JambonzProvisioningService({} as any);
    await expect(svc.createApplication({ name: 'x', webhookUrl: 'wss://x' })).rejects.toThrow(
      'Jambonz not configured',
    );
  });
});
```

**Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @agent-platform/runtime test -- jambonz-provisioning
```

Expected: FAIL — module not found.

**Step 3: Implement the service**

```typescript
// apps/runtime/src/services/voice/jambonz-provisioning.service.ts

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('jambonz-provisioning');

export interface JambonzConfig {
  baseApiUrl?: string;
  accountSid?: string;
  apiKey?: string;
  voipCarrierSid?: string;
  serviceProviderId?: string;
  serviceProviderApiKey?: string;
}

export interface CreateApplicationInput {
  name: string;
  webhookUrl: string;
  asrVendor?: string;
  asrLanguage?: string;
  ttsVendor?: string;
  ttsLanguage?: string;
  ttsVoice?: string;
  ttsRegion?: string;
  asrRegion?: string;
  fallbackAsrVendor?: string;
  fallbackAsrLanguage?: string;
  fallbackAsrRegion?: string;
  fallbackTtsVendor?: string;
  fallbackTtsLanguage?: string;
  fallbackTtsVoice?: string;
  fallbackTtsRegion?: string;
}

export interface AddPhoneNumberInput {
  phoneNumber: string;
  applicationSid: string;
  voipCarrierSid?: string;
}

export class JambonzProvisioningService {
  constructor(private readonly cfg: JambonzConfig) {}

  private assertConfigured(): void {
    if (!this.cfg.baseApiUrl || !this.cfg.accountSid || !this.cfg.apiKey) {
      throw new Error('Jambonz not configured: missing baseApiUrl, accountSid, or apiKey');
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.cfg.apiKey}`,
    };
  }

  private async jambonzFetch<T>(path: string, options: RequestInit): Promise<T> {
    const url = `${this.cfg.baseApiUrl}${path}`;
    const res = await fetch(url, { ...options, headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Jambonz API error ${res.status} ${path}: ${body}`);
    }
    // DELETE returns 204 with no body
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async createApplication(input: CreateApplicationInput): Promise<string> {
    this.assertConfigured();
    const payload: Record<string, unknown> = {
      name: input.name,
      account_sid: this.cfg.accountSid,
      call_hook: { url: input.webhookUrl, method: 'POST' },
      call_status_hook: { url: input.webhookUrl, method: 'POST' },
    };
    if (input.asrVendor) payload.speech_recognizer_vendor = input.asrVendor;
    if (input.asrLanguage) payload.speech_recognizer_language = input.asrLanguage;
    if (input.asrRegion) payload.speech_recognizer_label = input.asrRegion;
    if (input.ttsVendor) payload.speech_synthesis_vendor = input.ttsVendor;
    if (input.ttsLanguage) payload.speech_synthesis_language = input.ttsLanguage;
    if (input.ttsVoice) payload.speech_synthesis_voice = input.ttsVoice;
    if (input.ttsRegion) payload.speech_synthesis_label = input.ttsRegion;
    if (input.fallbackAsrVendor) {
      payload.fallback_speech_recognizer_vendor = input.fallbackAsrVendor;
      payload.fallback_speech_recognizer_language = input.fallbackAsrLanguage ?? null;
      payload.fallback_speech_recognizer_label = input.fallbackAsrRegion ?? null;
    }
    if (input.fallbackTtsVendor) {
      payload.fallback_speech_synthesis_vendor = input.fallbackTtsVendor;
      payload.fallback_speech_synthesis_language = input.fallbackTtsLanguage ?? null;
      payload.fallback_speech_synthesis_voice = input.fallbackTtsVoice ?? null;
      payload.fallback_speech_synthesis_label = input.fallbackTtsRegion ?? null;
    }
    const hasFallback =
      (input.fallbackAsrVendor && input.fallbackAsrLanguage && input.fallbackAsrRegion) ||
      (input.fallbackTtsVendor &&
        input.fallbackTtsLanguage &&
        input.fallbackTtsVoice &&
        input.fallbackTtsRegion);
    payload.use_for_fallback_speech = hasFallback ? 1 : 0;

    const result = await this.jambonzFetch<{ sid: string }>('/Applications', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    log.info('Jambonz application created', { sid: result.sid, name: input.name });
    return result.sid;
  }

  async updateApplication(applicationSid: string, input: CreateApplicationInput): Promise<void> {
    this.assertConfigured();
    // Fetch existing to preserve call_hook
    const existing = await this.jambonzFetch<Record<string, unknown>>(
      `/Applications/${applicationSid}`,
      { method: 'GET' },
    );
    const payload: Record<string, unknown> = {
      name: input.name,
      call_hook: existing.call_hook,
      call_status_hook: existing.call_status_hook,
    };
    if (input.asrVendor !== undefined) payload.speech_recognizer_vendor = input.asrVendor;
    if (input.asrLanguage !== undefined) payload.speech_recognizer_language = input.asrLanguage;
    if (input.asrRegion !== undefined) payload.speech_recognizer_label = input.asrRegion;
    if (input.ttsVendor !== undefined) payload.speech_synthesis_vendor = input.ttsVendor;
    if (input.ttsLanguage !== undefined) payload.speech_synthesis_language = input.ttsLanguage;
    if (input.ttsVoice !== undefined) payload.speech_synthesis_voice = input.ttsVoice;
    if (input.ttsRegion !== undefined) payload.speech_synthesis_label = input.ttsRegion;
    await this.jambonzFetch(`/Applications/${applicationSid}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    log.info('Jambonz application updated', { applicationSid });
  }

  async deleteApplication(applicationSid: string): Promise<void> {
    this.assertConfigured();
    await this.jambonzFetch(`/Applications/${applicationSid}`, { method: 'DELETE' });
    log.info('Jambonz application deleted', { applicationSid });
  }

  async addPhoneNumber(input: AddPhoneNumberInput): Promise<string> {
    this.assertConfigured();
    const payload = {
      account_sid: this.cfg.accountSid,
      application_sid: input.applicationSid,
      number: input.phoneNumber,
      voip_carrier_sid: input.voipCarrierSid ?? this.cfg.voipCarrierSid,
    };
    const result = await this.jambonzFetch<{ sid: string }>('/PhoneNumbers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    log.info('Jambonz phone number registered', {
      phoneNumber: input.phoneNumber,
      sid: result.sid,
    });
    return result.sid;
  }

  async deletePhoneNumber(phoneNumberSid: string): Promise<void> {
    this.assertConfigured();
    await this.jambonzFetch(`/PhoneNumbers/${phoneNumberSid}`, { method: 'DELETE' });
    log.info('Jambonz phone number deleted', { phoneNumberSid });
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _instance: JambonzProvisioningService | null = null;

export function getJambonzProvisioningService(): JambonzProvisioningService {
  if (!_instance) {
    // Lazy import to avoid circular deps at module load time
    const { getConfig } = require('../../config.js');
    const voiceConfig = getConfig().voice ?? {};
    _instance = new JambonzProvisioningService(voiceConfig.jambonz ?? {});
  }
  return _instance;
}
```

**Step 4: Run tests**

```bash
pnpm --filter @agent-platform/runtime test -- jambonz-provisioning
```

Expected: all 4 tests PASS.

**Step 5: Commit**

```bash
git add apps/runtime/src/services/voice/jambonz-provisioning.service.ts \
        apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts
git commit -m "feat(runtime): add JambonzProvisioningService for Jambonz REST API calls"
```

---

## Task 3: Twilio phone numbers list endpoint

**Files:**

- Modify: `apps/runtime/src/routes/voice.ts`

**Context:** Studio needs a list of phone numbers from the Twilio account to show in the dropdown. We add `GET /api/voice/twilio/phone-numbers` — auth-guarded, returns array of `{ sid, phoneNumber, friendlyName }`. Uses the existing `getTwilioService()`.

**Step 1: Write failing test**

Add to `apps/runtime/src/__tests__/voice-routes.test.ts` (create if absent):

```typescript
it('GET /api/voice/twilio/phone-numbers returns phone list', async () => {
  // mock twilio service
  vi.mock('../services/voice/twilio-service.js', () => ({
    getTwilioService: () => ({
      listIncomingPhoneNumbers: async () => [
        { sid: 'PN001', phoneNumber: '+12345678', friendlyName: 'Main Line' },
      ],
    }),
  }));
  const res = await request(app)
    .get('/api/voice/twilio/phone-numbers')
    .set('Authorization', `Bearer ${validToken}`);
  expect(res.status).toBe(200);
  expect(res.body.phoneNumbers).toHaveLength(1);
  expect(res.body.phoneNumbers[0].phoneNumber).toBe('+12345678');
});
```

**Step 2: Add `listIncomingPhoneNumbers` to TwilioService**

In `apps/runtime/src/services/voice/twilio-service.ts`, add a method:

```typescript
async listIncomingPhoneNumbers(): Promise<Array<{ sid: string; phoneNumber: string; friendlyName: string }>> {
  const client = this.getClient(); // existing pattern
  const numbers = await client.incomingPhoneNumbers.list({ limit: 500 });
  return numbers.map((n) => ({
    sid: n.sid,
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
  }));
}
```

**Step 3: Add route in voice.ts**

After the existing capabilities route, add:

```typescript
openapi.get(
  '/twilio/phone-numbers',
  {
    summary: 'List Twilio phone numbers',
    description: 'Returns all incoming phone numbers on the configured Twilio account',
    responses: {
      200: z.object({
        phoneNumbers: z.array(
          z.object({
            sid: z.string(),
            phoneNumber: z.string(),
            friendlyName: z.string(),
          }),
        ),
      }),
    },
    middleware: [authMiddleware, tenantRateLimit('request')],
  },
  async (req, res) => {
    try {
      const twilio = getTwilioService();
      if (!twilio) {
        res.status(503).json({ success: false, error: 'Twilio not configured' });
        return;
      }
      const phoneNumbers = await twilio.listIncomingPhoneNumbers();
      res.json({ phoneNumbers });
    } catch (err: any) {
      log.error('Failed to list Twilio phone numbers', { error: err?.message });
      res.status(500).json({ success: false, error: 'Failed to list phone numbers' });
    }
  },
);
```

**Step 4: Run tests**

```bash
pnpm --filter @agent-platform/runtime test -- voice-routes
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/runtime/src/routes/voice.ts \
        apps/runtime/src/services/voice/twilio-service.ts
git commit -m "feat(runtime): add GET /api/voice/twilio/phone-numbers endpoint"
```

---

## Task 4: Jambonz provisioning hooks in channel-connections route

**Files:**

- Modify: `apps/runtime/src/routes/channel-connections.ts`

**Context:** On POST (create), PATCH (update), and DELETE of a `voice_pipeline` or `voice_realtime` connection, call `JambonzProvisioningService` and store/update the returned SIDs in `ChannelConnection.config`. Failures are **non-fatal on update/delete** (log + continue) but **fatal on create** (return 502).

**Voice channel types constant** — add near top of file:

```typescript
const VOICE_CHANNEL_TYPES = new Set(['voice_pipeline', 'voice_realtime']);
```

**Step 1: Webhook URL helper**

Add helper function:

```typescript
function getJambonzWebhookUrl(connectionId: string): string {
  const base =
    process.env.RUNTIME_PUBLIC_BASE_URL || process.env.RUNTIME_BASE_URL || 'http://localhost:3112';
  return `wss://${new URL(base).host}/api/v1/channels/jambonz?connectionId=${connectionId}`;
}
```

**Step 2: Hook into POST (create)**

After `ChannelConnection.create(...)`, before the success response, add:

```typescript
// Jambonz provisioning for voice channels
if (VOICE_CHANNEL_TYPES.has(channel_type)) {
  try {
    const { getJambonzProvisioningService } =
      await import('../services/voice/jambonz-provisioning.service.js');
    const jambonz = getJambonzProvisioningService();
    const webhookUrl = getJambonzWebhookUrl(doc._id as string);
    const voiceCfg = (config || {}) as Record<string, unknown>;

    const applicationSid = await jambonz.createApplication({
      name: display_name || resolvedIdentifier,
      webhookUrl,
      asrVendor: voiceCfg.asrVendor as string,
      asrLanguage: voiceCfg.asrLanguage as string,
      asrRegion: voiceCfg.asrRegion as string,
      ttsVendor: voiceCfg.ttsVendor as string,
      ttsLanguage: voiceCfg.ttsLanguage as string,
      ttsVoice: voiceCfg.ttsVoice as string,
      ttsRegion: voiceCfg.ttsRegion as string,
      fallbackAsrVendor: voiceCfg.fallbackAsrVendor as string,
      fallbackAsrLanguage: voiceCfg.fallbackAsrLanguage as string,
      fallbackAsrRegion: voiceCfg.fallbackAsrRegion as string,
      fallbackTtsVendor: voiceCfg.fallbackTtsVendor as string,
      fallbackTtsLanguage: voiceCfg.fallbackTtsLanguage as string,
      fallbackTtsVoice: voiceCfg.fallbackTtsVoice as string,
      fallbackTtsRegion: voiceCfg.fallbackTtsRegion as string,
    });

    const phoneNumberSid = await jambonz.addPhoneNumber({
      phoneNumber: resolvedIdentifier,
      applicationSid,
    });

    // Persist SIDs back into config
    await ChannelConnection.findByIdAndUpdate(doc._id, {
      $set: {
        'config.jambonzApplicationSid': applicationSid,
        'config.jambonzPhoneNumberSid': phoneNumberSid,
      },
    });
    (doc as any).config = {
      ...(doc as any).config,
      jambonzApplicationSid: applicationSid,
      jambonzPhoneNumberSid: phoneNumberSid,
    };
    log.info('Jambonz provisioning complete', { applicationSid, phoneNumberSid });
  } catch (err: any) {
    // Clean up the DB record since provisioning failed
    await ChannelConnection.findByIdAndDelete(doc._id).catch(() => {});
    log.error('Jambonz provisioning failed on create', { error: err?.message });
    res.status(502).json({
      success: false,
      error: `Voice gateway provisioning failed: ${err?.message}`,
    });
    return;
  }
}
```

**Step 3: Hook into PATCH (update)**

After `ChannelConnection.findByIdAndUpdate(...)`, add:

```typescript
if (VOICE_CHANNEL_TYPES.has((existing as any).channelType) && config !== undefined) {
  try {
    const { getJambonzProvisioningService } =
      await import('../services/voice/jambonz-provisioning.service.js');
    const jambonz = getJambonzProvisioningService();
    const existingConfig = ((existing as any).config || {}) as Record<string, unknown>;
    const newConfig = (config || {}) as Record<string, unknown>;
    const applicationSid =
      (newConfig.jambonzApplicationSid as string) ||
      (existingConfig.jambonzApplicationSid as string);

    if (applicationSid) {
      await jambonz.updateApplication(applicationSid, {
        name: display_name || (existing as any).displayName || (existing as any).externalIdentifier,
        webhookUrl: getJambonzWebhookUrl(req.params.id),
        asrVendor: (newConfig.asrVendor ?? existingConfig.asrVendor) as string,
        asrLanguage: (newConfig.asrLanguage ?? existingConfig.asrLanguage) as string,
        asrRegion: (newConfig.asrRegion ?? existingConfig.asrRegion) as string,
        ttsVendor: (newConfig.ttsVendor ?? existingConfig.ttsVendor) as string,
        ttsLanguage: (newConfig.ttsLanguage ?? existingConfig.ttsLanguage) as string,
        ttsVoice: (newConfig.ttsVoice ?? existingConfig.ttsVoice) as string,
        ttsRegion: (newConfig.ttsRegion ?? existingConfig.ttsRegion) as string,
      });
    }
  } catch (err: any) {
    log.error('Jambonz update failed (non-fatal)', { id: req.params.id, error: err?.message });
    // Non-fatal — DB is updated, Jambonz sync failed. Log and continue.
  }
}
```

**Step 4: Hook into DELETE**

After finding the existing doc, before deleting, add:

```typescript
if (VOICE_CHANNEL_TYPES.has((existing as any).channelType)) {
  try {
    const { getJambonzProvisioningService } =
      await import('../services/voice/jambonz-provisioning.service.js');
    const jambonz = getJambonzProvisioningService();
    const cfg = ((existing as any).config || {}) as Record<string, unknown>;
    if (cfg.jambonzPhoneNumberSid) {
      await jambonz.deletePhoneNumber(cfg.jambonzPhoneNumberSid as string);
    }
    if (cfg.jambonzApplicationSid) {
      await jambonz.deleteApplication(cfg.jambonzApplicationSid as string);
    }
  } catch (err: any) {
    log.error('Jambonz cleanup failed on delete (non-fatal)', {
      id: req.params.id,
      error: err?.message,
    });
  }
}
```

**Step 5: Typecheck**

```bash
pnpm --filter @agent-platform/runtime typecheck
```

Expected: no errors.

**Step 6: Commit**

```bash
git add apps/runtime/src/routes/channel-connections.ts
git commit -m "feat(runtime): provision/deprovision Jambonz on voice channel connection CRUD"
```

---

## Task 5: Studio API client — phone numbers fetch

**Files:**

- Create: `apps/studio/src/api/voice.ts`

**Context:** Studio needs to call the new `GET /api/voice/twilio/phone-numbers` endpoint. Following the same pattern as `apps/studio/src/api/channel-connections.ts`.

**Step 1: Create the API client file**

```typescript
// apps/studio/src/api/voice.ts
import { getApiBase } from './auth';

export interface TwilioPhoneNumber {
  sid: string;
  phoneNumber: string;
  friendlyName: string;
}

export async function listTwilioPhoneNumbers(): Promise<TwilioPhoneNumber[]> {
  const res = await fetch(`${getApiBase()}/api/voice/twilio/phone-numbers`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to fetch phone numbers: ${res.status}`);
  const data = await res.json();
  return data.phoneNumbers ?? [];
}
```

**Step 2: Typecheck**

```bash
pnpm --filter @agent-platform/studio typecheck
```

**Step 3: Commit**

```bash
git add apps/studio/src/api/voice.ts
git commit -m "feat(studio): add listTwilioPhoneNumbers API client"
```

---

## Task 6: Overhaul VoiceFields UI in ConfigurationTab

**Files:**

- Modify: `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx`

**Context:** Replace the current `VoiceFields` component. Remove: voice provider dropdown, SIP config section, phone provider dropdown, free-text phone number. Add: Twilio phone number dropdown (fetched on mount), full ASR (vendor + language + region), full TTS (vendor + voice + language + region), collapsible fallback ASR/TTS section.

**Step 1: Update constants — remove unneeded, keep useful**

Replace the constants block at the top of the file:

```typescript
// Remove: VOICE_PROVIDERS, PHONE_NUMBER_PROVIDERS, SIP_TRANSPORT_OPTIONS
// Keep and expand: ASR_VENDORS, TTS_VENDORS, REALTIME_MODELS

const ASR_VENDORS = [
  { value: 'deepgram', label: 'Deepgram' },
  { value: 'google', label: 'Google Cloud Speech' },
  { value: 'azure', label: 'Azure Speech' },
  { value: 'aws', label: 'Amazon Transcribe' },
] as const;

const TTS_VENDORS = [
  { value: 'elevenlabs', label: 'ElevenLabs' },
  { value: 'google', label: 'Google Cloud TTS' },
  { value: 'azure', label: 'Azure Speech' },
  { value: 'aws', label: 'Amazon Polly' },
] as const;

const REALTIME_MODELS = [
  { value: 'openai_realtime', label: 'OpenAI Realtime' },
  { value: 'gemini_live', label: 'Gemini Live' },
] as const;
```

**Step 2: Rewrite VoiceFields component**

Replace the entire `VoiceFields` function with:

```typescript
import { useEffect, useState } from 'react';
import { listTwilioPhoneNumbers, type TwilioPhoneNumber } from '../../../../api/voice';

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

  const [phoneNumbers, setPhoneNumbers] = useState<TwilioPhoneNumber[]>([]);
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [showFallback, setShowFallback] = useState(
    Boolean(config.fallbackAsrVendor || config.fallbackTtsVendor),
  );

  useEffect(() => {
    if (isVxml) return;
    setPhoneLoading(true);
    listTwilioPhoneNumbers()
      .then(setPhoneNumbers)
      .catch(() => setPhoneNumbers([]))
      .finally(() => setPhoneLoading(false));
  }, [isVxml]);

  const set = (key: string, value: unknown) =>
    setConfig((prev) => ({ ...prev, [key]: value }));

  return (
    <>
      {/* Phone Number */}
      {!isVxml && (
        <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Phone Number
          </h5>
          <Select
            label="Phone Number"
            options={
              phoneLoading
                ? [{ value: '', label: 'Loading…' }]
                : phoneNumbers.map((n) => ({
                    value: n.phoneNumber,
                    label: `${n.friendlyName} (${n.phoneNumber})`,
                  }))
            }
            value={(config.phoneNumber as string) || ''}
            onChange={(e) => set('phoneNumber', e.target.value)}
            disabled={phoneLoading}
          />
        </div>
      )}

      {/* ASR */}
      {!isVxml && (
        <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Speech Recognition (ASR)
          </h5>
          <Select
            label="Vendor"
            options={ASR_VENDORS.map((v) => ({ value: v.value, label: v.label }))}
            value={(config.asrVendor as string) || 'deepgram'}
            onChange={(e) => set('asrVendor', e.target.value)}
          />
          <Input
            label="Language"
            placeholder="en-US"
            value={(config.asrLanguage as string) || ''}
            onChange={(e) => set('asrLanguage', e.target.value)}
          />
          <Input
            label="Region / Label"
            placeholder="us-east-1 (optional)"
            value={(config.asrRegion as string) || ''}
            onChange={(e) => set('asrRegion', e.target.value)}
          />
        </div>
      )}

      {/* TTS */}
      {!isVxml && (
        <div className="space-y-3 p-3 rounded-lg border border-default bg-background-muted">
          <h5 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Speech Synthesis (TTS)
          </h5>
          <Select
            label="Vendor"
            options={TTS_VENDORS.map((v) => ({ value: v.value, label: v.label }))}
            value={(config.ttsVendor as string) || 'elevenlabs'}
            onChange={(e) => set('ttsVendor', e.target.value)}
          />
          <Input
            label="Voice"
            placeholder="en-US-Neural2-F"
            value={(config.ttsVoice as string) || ''}
            onChange={(e) => set('ttsVoice', e.target.value)}
          />
          <Input
            label="Language"
            placeholder="en-US"
            value={(config.ttsLanguage as string) || ''}
            onChange={(e) => set('ttsLanguage', e.target.value)}
          />
          <Input
            label="Region / Label"
            placeholder="us-east-1 (optional)"
            value={(config.ttsRegion as string) || ''}
            onChange={(e) => set('ttsRegion', e.target.value)}
          />
        </div>
      )}

      {/* Fallback ASR/TTS */}
      {!isVxml && (
        <div className="border border-default rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowFallback((v) => !v)}
            className="w-full flex items-center justify-between p-3 bg-background-muted text-xs font-semibold text-foreground uppercase tracking-wider hover:bg-background-elevated transition-default"
          >
            <span>Fallback Speech (optional)</span>
            <span>{showFallback ? '−' : '+'}</span>
          </button>
          {showFallback && (
            <div className="p-3 space-y-3">
              <Select
                label="Fallback ASR Vendor"
                options={[{ value: '', label: 'None' }, ...ASR_VENDORS.map((v) => ({ value: v.value, label: v.label }))]}
                value={(config.fallbackAsrVendor as string) || ''}
                onChange={(e) => set('fallbackAsrVendor', e.target.value || undefined)}
              />
              <Input
                label="Fallback ASR Language"
                placeholder="en-US"
                value={(config.fallbackAsrLanguage as string) || ''}
                onChange={(e) => set('fallbackAsrLanguage', e.target.value)}
              />
              <Input
                label="Fallback ASR Region"
                placeholder="us-east-1"
                value={(config.fallbackAsrRegion as string) || ''}
                onChange={(e) => set('fallbackAsrRegion', e.target.value)}
              />
              <Select
                label="Fallback TTS Vendor"
                options={[{ value: '', label: 'None' }, ...TTS_VENDORS.map((v) => ({ value: v.value, label: v.label }))]}
                value={(config.fallbackTtsVendor as string) || ''}
                onChange={(e) => set('fallbackTtsVendor', e.target.value || undefined)}
              />
              <Input
                label="Fallback TTS Voice"
                placeholder="en-US-Neural2-F"
                value={(config.fallbackTtsVoice as string) || ''}
                onChange={(e) => set('fallbackTtsVoice', e.target.value)}
              />
              <Input
                label="Fallback TTS Language"
                placeholder="en-US"
                value={(config.fallbackTtsLanguage as string) || ''}
                onChange={(e) => set('fallbackTtsLanguage', e.target.value)}
              />
              <Input
                label="Fallback TTS Region"
                placeholder="us-east-1"
                value={(config.fallbackTtsRegion as string) || ''}
                onChange={(e) => set('fallbackTtsRegion', e.target.value)}
              />
            </div>
          )}
        </div>
      )}

      {/* Realtime model */}
      {isRealtime && (
        <Select
          label="Realtime Model"
          options={REALTIME_MODELS.map((m) => ({ value: m.value, label: m.label }))}
          value={(config.realtimeModel as string) || 'openai_realtime'}
          onChange={(e) => set('realtimeModel', e.target.value)}
        />
      )}

      {/* Pipeline-specific */}
      {isPipeline && (
        <div className="space-y-3">
          <Checkbox
            checked={Boolean(config.bargeIn)}
            onChange={(checked) => set('bargeIn', checked)}
            label="Barge-in"
            description="Allow caller to interrupt the agent while it is speaking"
          />
          <Input
            label="Speech Timeout (ms)"
            placeholder="3000"
            value={String(config.speechTimeout || '')}
            onChange={(e) => set('speechTimeout', Number(e.target.value) || null)}
          />
          <Input
            label="Welcome Message"
            placeholder="Hello! How can I help you today?"
            value={(config.welcomeMessage as string) || ''}
            onChange={(e) => set('welcomeMessage', e.target.value)}
          />
        </div>
      )}

      {/* VXML-specific */}
      {isVxml && (
        <div className="space-y-3">
          <Input
            label="VXML Document URL"
            placeholder="https://your-server.com/vxml/main.xml"
            value={(config.vxmlDocUrl as string) || ''}
            onChange={(e) => set('vxmlDocUrl', e.target.value)}
          />
          <Input
            label="Fallback URL"
            placeholder="https://your-server.com/vxml/error.xml"
            value={(config.vxmlFallbackUrl as string) || ''}
            onChange={(e) => set('vxmlFallbackUrl', e.target.value)}
          />
        </div>
      )}
    </>
  );
}
```

**Step 3: Typecheck**

```bash
pnpm --filter @agent-platform/studio typecheck
```

Expected: no errors.

**Step 4: Commit**

```bash
git add apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx
git commit -m "feat(studio): overhaul voice channel config UI with Twilio phone dropdown and full ASR/TTS fields"
```

---

## Task 7: Build and smoke test

**Step 1: Full build**

```bash
pnpm build
```

Expected: no errors across all packages.

**Step 2: Run all runtime tests**

```bash
pnpm --filter @agent-platform/runtime test
```

Expected: all pass.

**Step 3: Manual smoke test checklist**

- [ ] `GET /api/voice/twilio/phone-numbers` returns list (or 503 if Twilio not configured)
- [ ] Create a `voice_pipeline` channel connection → Jambonz `POST /Applications` called → `jambonzApplicationSid` present in response config
- [ ] Update the connection config → Jambonz `PUT /Applications/:sid` called
- [ ] Delete the connection → Jambonz `DELETE /PhoneNumbers/:sid` + `DELETE /Applications/:sid` called
- [ ] Studio UI: phone number dropdown fetches on mount; ASR/TTS fields all present; fallback section toggles

**Step 4: Final commit if any fixes needed**

```bash
git add -p
git commit -m "fix: address smoke test findings"
```
