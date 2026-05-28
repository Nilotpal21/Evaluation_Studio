import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { WebSocket as NodeWebSocket } from 'ws';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  createChannelConnection,
  importProjectFiles,
  provisionTenantModel,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
  updateChannelConnection,
} from '../helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';

const CONTEXT_AGENT_DSL = `
AGENT: voicecontext

GOAL: "Collect caller context across multiple turns"

FLOW:
  entry_point: collect_name
  steps:
    - collect_name
    - collect_topic
    - summary

collect_name:
  REASONING: false
  GATHER:
    - name: required
  THEN: collect_topic

collect_topic:
  REASONING: false
  GATHER:
    - topic: required
  THEN: summary

summary:
  REASONING: false
  RESPOND: "Summary for {{name}} about {{topic}}."
  THEN: COMPLETE
`;

type JambonzApplicationRecord = {
  sid: string;
  payload: Record<string, unknown>;
};

type JambonzSpeechCredentialRecord = {
  sid: string;
  vendor?: string;
  label?: string;
  payload: Record<string, unknown>;
};

type JambonzPhoneNumberRecord = {
  sid: string;
  payload: Record<string, unknown>;
};

class FakeJambonzApi {
  private readonly app: Express;
  private server: http.Server | null = null;
  private nextAppId = 1;
  private nextSpeechCredentialId = 1;
  private nextPhoneNumberId = 1;

  readonly applications = new Map<string, JambonzApplicationRecord>();
  readonly speechCredentials = new Map<string, JambonzSpeechCredentialRecord>();
  readonly phoneNumbers = new Map<string, JambonzPhoneNumberRecord>();
  readonly deletedSpeechCredentialSids: string[] = [];
  readonly requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }> =
    [];

  constructor(private readonly accountSid: string) {
    this.app = express();
    this.app.use(express.json());
    this.app.use((req, _res, next) => {
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
      this.requests.push({
        method: req.method,
        path: req.path,
        body,
      });
      next();
    });

    this.app.post('/Applications', (req, res) => {
      const sid = `app-${this.nextAppId++}`;
      this.applications.set(sid, { sid, payload: { ...req.body }, ...{} });
      res.json({ sid });
    });

    this.app.get('/Applications/:sid', (req, res) => {
      const existing = this.applications.get(req.params.sid);
      if (!existing) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(existing.payload);
    });

    this.app.put('/Applications/:sid', (req, res) => {
      const existing = this.applications.get(req.params.sid);
      if (!existing) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      existing.payload = { ...req.body };
      res.status(204).end();
    });

    this.app.post('/PhoneNumbers', (req, res) => {
      const sid = `pn-${this.nextPhoneNumberId++}`;
      this.phoneNumbers.set(sid, { sid, payload: { ...req.body } });
      res.json({ sid });
    });

    this.app.delete('/PhoneNumbers/:sid', (req, res) => {
      this.phoneNumbers.delete(req.params.sid);
      res.status(204).end();
    });

    this.app.get(`/Accounts/${this.accountSid}/SpeechCredentials`, (_req, res) => {
      res.json(
        Array.from(this.speechCredentials.values()).map((record) => ({
          speech_credential_sid: record.sid,
          vendor: record.vendor,
          label: record.label,
        })),
      );
    });

    this.app.post(`/Accounts/${this.accountSid}/SpeechCredentials`, (req, res) => {
      const sid = `speech-${this.nextSpeechCredentialId++}`;
      const payload = { ...req.body } as Record<string, unknown>;
      const record: JambonzSpeechCredentialRecord = {
        sid,
        vendor: typeof payload.vendor === 'string' ? payload.vendor : undefined,
        label: typeof payload.label === 'string' ? payload.label : undefined,
        payload,
      };
      this.speechCredentials.set(sid, record);
      res.json({ sid });
    });

    this.app.put(`/Accounts/${this.accountSid}/SpeechCredentials/:sid`, (req, res) => {
      const existing = this.speechCredentials.get(req.params.sid);
      if (!existing) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      existing.payload = {
        ...existing.payload,
        ...req.body,
      };
      res.status(204).end();
    });

    this.app.delete(`/Accounts/${this.accountSid}/SpeechCredentials/:sid`, (req, res) => {
      this.deletedSpeechCredentialSids.push(req.params.sid);
      this.speechCredentials.delete(req.params.sid);
      res.status(204).end();
    });
  }

  async start(): Promise<string> {
    this.server = await new Promise<http.Server>((resolve) => {
      const candidate = http.createServer(this.app);
      candidate.listen(0, '127.0.0.1', () => resolve(candidate));
    });
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  reset(): void {
    this.applications.clear();
    this.speechCredentials.clear();
    this.phoneNumbers.clear();
    this.deletedSpeechCredentialSids.length = 0;
    this.requests.length = 0;
    this.nextAppId = 1;
    this.nextSpeechCredentialId = 1;
    this.nextPhoneNumberId = 1;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}

async function createServiceInstance(
  harness: RuntimeApiHarness,
  token: string,
  tenantId: string,
  body: {
    displayName: string;
    serviceType: string;
    apiKey: string;
    config?: Record<string, unknown>;
    isDefault?: boolean;
  },
): Promise<{
  id: string;
  displayName: string;
  serviceType: string;
  isDefault: boolean;
  isActive: boolean;
}> {
  const response = await requestJson<{
    success: boolean;
    instance: {
      id: string;
      displayName: string;
      serviceType: string;
      isDefault: boolean;
      isActive: boolean;
    };
  }>(harness, `/api/tenants/${tenantId}/service-instances`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body,
  });

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.instance;
}

async function getChannelConnection(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  connectionId: string,
): Promise<{
  id: string;
  config: Record<string, unknown>;
}> {
  const response = await requestJson<{
    success: boolean;
    connection: {
      id: string;
      config: Record<string, unknown>;
    };
  }>(harness, `/api/projects/${projectId}/channel-connections/${connectionId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(response.status).toBe(200);
  expect(response.body.success).toBe(true);
  return response.body.connection;
}

type KorevgWsMessage = {
  type: string;
  msgid?: string;
  command?: string;
  data?: Array<Record<string, unknown>>;
};

function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(() => {
        void tick();
      }, intervalMs);
    };
    void tick();
  });
}

async function openWebSocket(url: string): Promise<NodeWebSocket> {
  const ws = new NodeWebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.off('open', handleOpen);
      ws.off('error', handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    ws.on('open', handleOpen);
    ws.on('error', handleError);
  });
  return ws;
}

async function closeWebSocket(ws: NodeWebSocket, timeoutMs = 1_000): Promise<void> {
  if (ws.readyState === NodeWebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      ws.off('close', handleClose);
      clearTimeout(timer);
      resolve();
    };
    const handleClose = () => finish();
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      finish();
    }, timeoutMs);

    ws.on('close', handleClose);
    try {
      ws.close();
    } catch {
      finish();
    }
  });
}

function parseWsMessage(raw: Buffer | string): KorevgWsMessage {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  return JSON.parse(text) as KorevgWsMessage;
}

async function waitForWsMessage(
  messages: KorevgWsMessage[],
  predicate: (message: KorevgWsMessage) => boolean,
  timeoutMs = 10_000,
): Promise<KorevgWsMessage> {
  await waitForCondition(() => messages.some(predicate), timeoutMs);
  const found = messages.find(predicate);
  if (!found) {
    throw new Error('Expected websocket message not found');
  }
  return found;
}

describe.sequential('Voice pipeline Orpheus admin/channel E2E', () => {
  let jambonzApi: FakeJambonzApi;
  let harness: RuntimeApiHarness;
  let mockLlm: MockLLM;

  beforeAll(async () => {
    jambonzApi = new FakeJambonzApi('acct-test');
    const jambonzBaseUrl = await jambonzApi.start();
    mockLlm = await startMockLLM();

    harness = await startRuntimeServerHarness({
      JAMBONZ_BASE_API_URL: jambonzBaseUrl,
      JAMBONZ_ACCOUNT_SID: 'acct-test',
      JAMBONZ_API_KEY: 'jambonz-api-key',
      ORPHEUS_TTS_AUTH_TOKEN: 'route-token',
    });
  }, 120_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    jambonzApi.reset();
    mockLlm.reset();
  });

  afterAll(async () => {
    await harness.close();
    await jambonzApi.close();
    await mockLlm.close();
  }, 120_000);

  test('creates Orpheus and Deepgram service instances via public APIs and provisions the selected Orpheus instance into Jambonz', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('orpheus-admin'),
      uniqueSlug('tenant-orpheus-admin'),
      uniqueSlug('project-orpheus-admin'),
    );

    const deepgram = await createServiceInstance(harness, admin.token, admin.tenantId, {
      displayName: 'Deepgram Primary',
      serviceType: 'deepgram',
      apiKey: 'deepgram-api-key',
      config: { model: 'nova-3' },
      isDefault: true,
    });
    const orpheusDefault = await createServiceInstance(harness, admin.token, admin.tenantId, {
      displayName: 'Orpheus Default',
      serviceType: 'custom:orpheus',
      apiKey: 'groq-key-default',
      config: { model: 'canopylabs/orpheus-v1-english', voiceId: 'daniel' },
      isDefault: true,
    });
    const orpheusSelected = await createServiceInstance(harness, admin.token, admin.tenantId, {
      displayName: 'Orpheus Selected',
      serviceType: 'custom:orpheus',
      apiKey: 'groq-key-selected',
      config: { model: 'canopylabs/orpheus-v1-english', voiceId: 'hannah' },
      isDefault: false,
    });

    const connection = await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'voice_pipeline',
      display_name: 'Orpheus Voice Pipeline',
      external_identifier: uniqueSlug('orpheus-voice'),
      config: {
        asrVendor: 'deepgram',
        asrServiceInstanceId: deepgram.id,
        asrLanguage: 'en',
        ttsVendor: 'custom:orpheus',
        ttsServiceInstanceId: orpheusSelected.id,
        ttsVoice: 'hannah',
        orpheusWsStreamingEnabled: false,
      },
    });

    const fetched = await getChannelConnection(
      harness,
      admin.token,
      admin.projectId,
      connection.id,
    );

    expect(fetched.config).toMatchObject({
      asrVendor: 'deepgram',
      asrServiceInstanceId: deepgram.id,
      asrLanguage: 'en',
      ttsVendor: 'custom:orpheus',
      ttsServiceInstanceId: orpheusSelected.id,
      ttsVoice: 'hannah',
      orpheusWsStreamingEnabled: false,
    });

    const deepgramCredential = Array.from(jambonzApi.speechCredentials.values()).find(
      (record) => record.vendor === 'deepgram',
    );
    expect(deepgramCredential?.payload).toMatchObject({
      vendor: 'deepgram',
      label: `t:${admin.tenantId}`,
      use_for_stt: 1,
      use_for_tts: 1,
      model_id: 'nova-3',
    });

    const orpheusCredential = Array.from(jambonzApi.speechCredentials.values()).find(
      (record) => record.vendor === 'custom:orpheus',
    );
    expect(orpheusCredential).toBeDefined();
    expect(orpheusCredential?.payload.auth_token).toBe('route-token');

    const customTtsUrl = new URL(String(orpheusCredential?.payload.custom_tts_url));
    expect(customTtsUrl.searchParams.get('tenantId')).toBe(admin.tenantId);
    expect(customTtsUrl.searchParams.get('serviceInstanceId')).toBe(orpheusSelected.id);

    const customTtsStreamingUrl = new URL(
      String(orpheusCredential?.payload.custom_tts_streaming_url),
    );
    expect(customTtsStreamingUrl.searchParams.get('tenantId')).toBe(admin.tenantId);
    expect(customTtsStreamingUrl.searchParams.get('serviceInstanceId')).toBe(orpheusSelected.id);

    const application = Array.from(jambonzApi.applications.values())[0];
    expect(application?.payload).toMatchObject({
      speech_recognizer_vendor: 'deepgram',
      speech_recognizer_language: 'en',
      speech_recognizer_label: `t:${admin.tenantId}`,
      speech_synthesis_vendor: 'custom:orpheus',
      speech_synthesis_voice: 'hannah',
      speech_synthesis_label: `t:${admin.tenantId}`,
    });

    expect(orpheusDefault.id).not.toBe(orpheusSelected.id);
  });

  test('patching the selected Orpheus service instance recreates the custom speech credential and persists the streaming toggle', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('orpheus-patch'),
      uniqueSlug('tenant-orpheus-patch'),
      uniqueSlug('project-orpheus-patch'),
    );

    const deepgram = await createServiceInstance(harness, admin.token, admin.tenantId, {
      displayName: 'Deepgram Primary',
      serviceType: 'deepgram',
      apiKey: 'deepgram-api-key',
      config: { model: 'nova-3' },
      isDefault: true,
    });
    const orpheusA = await createServiceInstance(harness, admin.token, admin.tenantId, {
      displayName: 'Orpheus A',
      serviceType: 'custom:orpheus',
      apiKey: 'groq-key-a',
      config: { model: 'canopylabs/orpheus-v1-english', voiceId: 'hannah' },
      isDefault: true,
    });
    const orpheusB = await createServiceInstance(harness, admin.token, admin.tenantId, {
      displayName: 'Orpheus B',
      serviceType: 'custom:orpheus',
      apiKey: 'groq-key-b',
      config: { model: 'canopylabs/orpheus-v1-english', voiceId: 'austin' },
      isDefault: false,
    });

    const connection = await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'voice_pipeline',
      display_name: 'Orpheus Patch Voice Pipeline',
      external_identifier: uniqueSlug('orpheus-patch-voice'),
      config: {
        asrVendor: 'deepgram',
        asrServiceInstanceId: deepgram.id,
        asrLanguage: 'en',
        ttsVendor: 'custom:orpheus',
        ttsServiceInstanceId: orpheusA.id,
        ttsVoice: 'hannah',
        orpheusWsStreamingEnabled: false,
      },
    });

    const initialOrpheusCredential = Array.from(jambonzApi.speechCredentials.values()).find(
      (record) => record.vendor === 'custom:orpheus',
    );
    expect(initialOrpheusCredential?.sid).toBeDefined();

    const updated = await updateChannelConnection(
      harness,
      admin.token,
      admin.projectId,
      connection.id,
      {
        config: {
          asrVendor: 'deepgram',
          asrServiceInstanceId: deepgram.id,
          asrLanguage: 'en',
          ttsVendor: 'custom:orpheus',
          ttsServiceInstanceId: orpheusB.id,
          ttsVoice: 'austin',
          orpheusWsStreamingEnabled: true,
        },
      },
    );

    expect(updated.config).toMatchObject({
      ttsVendor: 'custom:orpheus',
      ttsServiceInstanceId: orpheusB.id,
      ttsVoice: 'austin',
      orpheusWsStreamingEnabled: true,
    });

    const fetched = await getChannelConnection(
      harness,
      admin.token,
      admin.projectId,
      connection.id,
    );
    expect(fetched.config).toMatchObject({
      ttsServiceInstanceId: orpheusB.id,
      ttsVoice: 'austin',
      orpheusWsStreamingEnabled: true,
    });

    expect(jambonzApi.deletedSpeechCredentialSids).toContain(initialOrpheusCredential!.sid);

    const latestOrpheusCredential = Array.from(jambonzApi.speechCredentials.values()).find(
      (record) => record.vendor === 'custom:orpheus',
    );
    expect(latestOrpheusCredential?.sid).not.toBe(initialOrpheusCredential?.sid);

    const latestTtsUrl = new URL(String(latestOrpheusCredential?.payload.custom_tts_url));
    expect(latestTtsUrl.searchParams.get('serviceInstanceId')).toBe(orpheusB.id);

    const latestStreamingUrl = new URL(
      String(latestOrpheusCredential?.payload.custom_tts_streaming_url),
    );
    expect(latestStreamingUrl.searchParams.get('serviceInstanceId')).toBe(orpheusB.id);

    const latestApp = Array.from(jambonzApi.applications.values())[0];
    expect(latestApp?.payload).toMatchObject({
      speech_synthesis_vendor: 'custom:orpheus',
      speech_synthesis_voice: 'austin',
      speech_synthesis_label: `t:${admin.tenantId}`,
    });
  });

  test('processes a real KoreVG websocket call through greeting and first user turn', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('orpheus-runtime-call'),
      uniqueSlug('tenant-orpheus-runtime'),
      uniqueSlug('project-orpheus-runtime'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/voicecontext.agent.abl': CONTEXT_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Voice Runtime Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-voice-runtime-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-voice-runtime-model',
        apiKey: 'test-api-key',
      },
    });

    mockLlm.registerToolCall('Alice', {
      name: '_extract_entities',
      arguments: { name: 'Alice' },
      followUpContent: '{}',
    });

    const deepgram = await createServiceInstance(harness, admin.token, admin.tenantId, {
      displayName: 'Deepgram Primary',
      serviceType: 'deepgram',
      apiKey: 'deepgram-api-key',
      config: { model: 'nova-3' },
      isDefault: true,
    });
    const orpheus = await createServiceInstance(harness, admin.token, admin.tenantId, {
      displayName: 'Orpheus Voice',
      serviceType: 'custom:orpheus',
      apiKey: 'groq-key-runtime',
      config: { model: 'canopylabs/orpheus-v1-english', voiceId: 'hannah' },
      isDefault: true,
    });

    const connection = await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'voice_pipeline',
      display_name: 'Orpheus Runtime Voice Pipeline',
      external_identifier: uniqueSlug('orpheus-runtime-voice'),
      config: {
        asrVendor: 'deepgram',
        asrServiceInstanceId: deepgram.id,
        asrLanguage: 'en',
        ttsVendor: 'custom:orpheus',
        ttsServiceInstanceId: orpheus.id,
        ttsVoice: 'hannah',
        orpheusWsStreamingEnabled: false,
      },
    });

    const jambonzApplication = Array.from(jambonzApi.applications.values())[0];
    expect(jambonzApplication).toBeDefined();
    const webhookUrl = String(
      (jambonzApplication?.payload.call_hook as { url?: string } | undefined)?.url || '',
    );
    expect(webhookUrl).toContain('/ws/korevg/');
    const inboundToken = new URL(webhookUrl).searchParams.get('token');
    expect(inboundToken).toBeTruthy();

    const wsUrl =
      harness.baseUrl.replace(/^http/, 'ws') +
      `/ws/korevg/${encodeURIComponent(connection.id)}?token=${encodeURIComponent(String(inboundToken))}&agentId=voicecontext&caller=%2B15550001&called=%2B15550002`;

    const ws = await openWebSocket(wsUrl);
    const messages: KorevgWsMessage[] = [];
    ws.on('message', (raw) => {
      messages.push(parseWsMessage(raw as Buffer | string));
    });

    ws.send(
      JSON.stringify({
        type: 'session:new',
        msgid: 'msg-1',
        call_sid: 'call-1',
        data: {
          from: '+15550001',
          to: '+15550002',
        },
      }),
    );

    const answerAck = await waitForWsMessage(
      messages,
      (message) =>
        message.type === 'ack' &&
        message.msgid === 'msg-1' &&
        Array.isArray(message.data) &&
        message.data.some((verb) => verb.verb === 'answer'),
    );
    expect(answerAck.type).toBe('ack');

    const greetingRedirect = await waitForWsMessage(
      messages,
      (message) =>
        message.type === 'command' &&
        message.command === 'redirect' &&
        Array.isArray(message.data) &&
        message.data.some(
          (verb) =>
            verb.verb === 'say' && typeof verb.text === 'string' && verb.text.includes('name'),
        ),
    );
    expect(greetingRedirect.command).toBe('redirect');

    ws.send(
      JSON.stringify({
        type: 'verb:hook',
        msgid: 'msg-2',
        call_sid: 'call-1',
        data: {
          speech: {
            alternatives: [{ transcript: 'Alice', confidence: 0.98 }],
            language_code: 'en-US',
          },
          stt_latency_ms: '120',
        },
      }),
    );

    const turnAck = await waitForWsMessage(
      messages,
      (message) => message.type === 'ack' && message.msgid === 'msg-2',
    );
    expect(turnAck.type).toBe('ack');

    const firstTurnRedirect = await waitForWsMessage(
      messages,
      (message) =>
        message.type === 'command' &&
        message.command === 'redirect' &&
        Array.isArray(message.data) &&
        message.data.some(
          (verb) =>
            verb.verb === 'say' && typeof verb.text === 'string' && verb.text.includes('topic'),
        ),
    );
    expect(firstTurnRedirect.command).toBe('redirect');

    await closeWebSocket(ws);
  });
});
