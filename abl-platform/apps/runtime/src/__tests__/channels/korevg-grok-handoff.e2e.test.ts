import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
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
} from '../helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';

const SUPERVISOR_DSL = `
SUPERVISOR: Grok_Supervisor

GOAL: "Route callers to the right specialist"
PERSONA: "A concise routing supervisor"

HANDOFF:
  - TO: Sales_Agent
    WHEN: intent.category == "sales"
    CONTEXT:
      summary: "The caller wants sales help."
    RETURN: false
`;

const SALES_AGENT_DSL = `
AGENT: Sales_Agent

GOAL: "Help callers with sales requests"

FLOW:
  entry_point: answer
  steps:
    - answer

answer:
  REASONING: false
  RESPOND: "Sales agent is ready."
  THEN: COMPLETE
`;

type JambonzApplicationRecord = {
  sid: string;
  payload: Record<string, unknown>;
};

class FakeJambonzApi {
  private readonly app: Express;
  private server: http.Server | null = null;
  private nextAppId = 1;

  readonly applications = new Map<string, JambonzApplicationRecord>();

  constructor(private readonly accountSid: string) {
    this.app = express();
    this.app.use(express.json());

    this.app.post('/Applications', (req, res) => {
      const sid = `app-${this.nextAppId++}`;
      this.applications.set(sid, { sid, payload: { ...req.body } });
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

    this.app.get(`/Accounts/${this.accountSid}/SpeechCredentials`, (_req, res) => {
      res.json([]);
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
    this.nextAppId = 1;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}

type KorevgWsMessage = {
  type: string;
  msgid?: string;
  command?: string;
  tool_call_id?: string;
  data?: unknown;
};

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

  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.instance;
}

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

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getMessageDataObject(message: KorevgWsMessage): Record<string, unknown> | null {
  return getObject(message.data);
}

describe.sequential('KoreVG Grok realtime handoff E2E', () => {
  let jambonzApi: FakeJambonzApi;
  let harness: RuntimeApiHarness;
  let mockLlm: MockLLM;

  beforeAll(async () => {
    jambonzApi = new FakeJambonzApi('acct-grok-test');
    const jambonzBaseUrl = await jambonzApi.start();
    mockLlm = await startMockLLM();

    harness = await startRuntimeServerHarness({
      JAMBONZ_BASE_API_URL: jambonzBaseUrl,
      JAMBONZ_ACCOUNT_SID: 'acct-grok-test',
      JAMBONZ_API_KEY: 'jambonz-api-key',
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

  test('keeps internal Grok handoff silent until the completed response swaps the live session', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('grok-handoff-admin'),
      uniqueSlug('tenant-grok-handoff'),
      uniqueSlug('project-grok-handoff'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/Grok_Supervisor.agent.abl': SUPERVISOR_DSL,
      'agents/Sales_Agent.agent.abl': SALES_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock Runtime Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-runtime-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-runtime-model',
        apiKey: 'test-api-key',
      },
    });

    await createServiceInstance(harness, admin.token, admin.tenantId, {
      displayName: 'Grok Realtime',
      serviceType: 's2s:grok',
      apiKey: 'xai-test-key',
      config: { model: 'grok-4-1-fast-non-reasoning', voice: 'ara' },
      isDefault: true,
    });

    const connection = await createChannelConnection(harness, admin.token, admin.projectId, {
      channel_type: 'voice_realtime',
      display_name: 'Grok Realtime Voice',
      external_identifier: uniqueSlug('grok-realtime-voice'),
      config: {
        s2sProvider: 's2s:grok',
        s2sModel: 'grok-4-1-fast-non-reasoning',
        s2sVoice: 'ara',
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
      `/ws/korevg/${encodeURIComponent(connection.id)}?token=${encodeURIComponent(String(inboundToken))}&agentId=Grok_Supervisor&caller=%2B15550011&called=%2B15550022`;

    const ws = await openWebSocket(wsUrl);
    const messages: KorevgWsMessage[] = [];
    ws.on('message', (raw) => {
      messages.push(parseWsMessage(raw as Buffer | string));
    });

    try {
      ws.send(
        JSON.stringify({
          type: 'session:new',
          msgid: 'msg-session',
          call_sid: 'call-grok-e2e',
          data: {
            from: '+15550011',
            to: '+15550022',
          },
        }),
      );

      const sessionAck = await waitForWsMessage(
        messages,
        (message) =>
          message.type === 'ack' &&
          message.msgid === 'msg-session' &&
          Array.isArray(message.data) &&
          message.data.some((verb) => getObject(verb)?.verb === 'llm'),
      );
      const llmVerb = (sessionAck.data as unknown[]).find(
        (verb) => getObject(verb)?.verb === 'llm',
      ) as Record<string, unknown>;
      const llmOptions = getObject(llmVerb.llmOptions);
      const sessionUpdate = getObject(llmOptions?.session_update);
      expect(llmVerb.vendor).toBe('grok');
      expect(llmVerb.model).toBe('grok-4-1-fast-non-reasoning');
      expect(sessionUpdate?.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'handoff_to_Sales_Agent',
          }),
        ]),
      );

      ws.send(
        JSON.stringify({
          type: 'llm:tool-call',
          msgid: 'msg-tool',
          data: {
            name: 'handoff_to_Sales_Agent',
            tool_call_id: 'call-handoff-1',
            args: {
              message: 'book a hotel',
            },
          },
        }),
      );

      const toolOutput = await waitForWsMessage(
        messages,
        (message) =>
          message.command === 'llm:tool-output' && message.tool_call_id === 'call-handoff-1',
      );
      expect(messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'ack', msgid: 'msg-tool' })]),
      );
      const toolPayload = getMessageDataObject(toolOutput);
      const toolItem = getObject(toolPayload?.item);
      expect(toolPayload).toEqual(
        expect.objectContaining({
          defer_response_create: true,
        }),
      );
      expect(toolItem?.output).toBe(JSON.stringify({ success: true }));
      expect(String(toolItem?.output)).not.toMatch(/\btransfer|handoff|Sales Agent\b/i);
      expect(
        messages.filter(
          (message) =>
            message.command === 'llm:update' &&
            getMessageDataObject(message)?.type === 'session.update',
        ),
      ).toHaveLength(0);
      expect(
        messages.filter(
          (message) =>
            message.command === 'llm:update' &&
            getMessageDataObject(message)?.type === 'response.create',
        ),
      ).toHaveLength(0);

      ws.send(
        JSON.stringify({
          type: 'llm:event',
          msgid: 'msg-transcript',
          data: {
            type: 'response.output_audio_transcript.done',
            response_id: 'resp-handoff-1',
          },
        }),
      );

      ws.send(
        JSON.stringify({
          type: 'llm:event',
          msgid: 'msg-done',
          data: {
            type: 'response.done',
            response_id: 'resp-handoff-1',
            response: {
              id: 'resp-handoff-1',
            },
          },
        }),
      );

      await waitForWsMessage(
        messages,
        (message) =>
          message.command === 'llm:update' &&
          getMessageDataObject(message)?.type === 'session.update',
      );
      const responseCreate = await waitForWsMessage(
        messages,
        (message) =>
          message.command === 'llm:update' &&
          getMessageDataObject(message)?.type === 'response.create',
      );

      const responsePayload = getObject(getMessageDataObject(responseCreate)?.response);
      expect(responsePayload?.instructions).toEqual(expect.stringContaining('book a hotel'));
      expect(responsePayload?.instructions).not.toMatch(/\btransfer|handoff\b/i);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'ack', msgid: 'msg-transcript' }),
          expect.objectContaining({ type: 'ack', msgid: 'msg-done' }),
        ]),
      );
    } finally {
      await closeWebSocket(ws);
    }
  }, 60_000);
});
