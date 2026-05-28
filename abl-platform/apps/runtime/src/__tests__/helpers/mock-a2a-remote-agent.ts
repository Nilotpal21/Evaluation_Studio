import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import express from 'express';

interface MockA2ARemoteAgentOptions {
  callbackDelayMs?: number;
  responseText?: string;
  /** When set, the mock returns this HTTP status with an error body for POST requests. */
  errorStatus?: number;
  /** Custom error body to return when errorStatus is set. Defaults to `{ error: 'Mock error' }`. */
  errorBody?: unknown;
  /** Override fields on the agent card returned by GET requests. */
  agentCardOverrides?: Record<string, unknown>;
}

export interface MockA2ARemoteRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
  callbackUrl?: string;
  callbackToken?: string;
}

export interface MockA2ACallbackDelivery {
  url: string;
  token: string;
  payload: unknown;
  ok: boolean;
  status?: number;
  responseText?: string;
  error?: string;
}

export interface MockA2ARemoteAgent {
  baseUrl: string;
  endpointUrl: string;
  reset(): void;
  getRequests(): MockA2ARemoteRequest[];
  getDeliveries(): MockA2ACallbackDelivery[];
  /** Returns all headers from the most recent request (lowercased keys). */
  getReceivedHeaders(): Record<string, string>;
  close(): Promise<void>;
}

const DEFAULT_CALLBACK_DELAY_MS = 500;
const DEFAULT_RESPONSE_TEXT = 'Remote analytics complete.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function getNestedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function extractPushNotificationConfig(body: unknown): {
  callbackUrl?: string;
  callbackToken?: string;
  rpcId?: string | number;
  taskId?: string;
  contextId?: string;
} {
  if (!isRecord(body)) {
    return {};
  }

  const params = getNestedRecord(body, 'params') ?? body;
  const message = getNestedRecord(params, 'message');
  const configuration =
    getNestedRecord(params, 'configuration') ?? getNestedRecord(message ?? {}, 'configuration');
  const pushNotificationConfig = configuration
    ? getNestedRecord(configuration, 'pushNotificationConfig')
    : undefined;

  return {
    callbackUrl: pushNotificationConfig
      ? getNestedString(pushNotificationConfig, 'url')
      : undefined,
    callbackToken: pushNotificationConfig
      ? getNestedString(pushNotificationConfig, 'token')
      : undefined,
    rpcId: typeof body.id === 'string' || typeof body.id === 'number' ? body.id : undefined,
    taskId: typeof body.id === 'string' ? body.id : undefined,
    contextId:
      getNestedString(message ?? {}, 'contextId') ??
      getNestedString(getNestedRecord(message ?? {}, 'message') ?? {}, 'contextId'),
  };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startMockA2ARemoteAgent(
  options: MockA2ARemoteAgentOptions = {},
): Promise<MockA2ARemoteAgent> {
  const callbackDelayMs = options.callbackDelayMs ?? DEFAULT_CALLBACK_DELAY_MS;
  const responseText = options.responseText ?? DEFAULT_RESPONSE_TEXT;
  const errorStatus = options.errorStatus;
  const errorBody = options.errorBody ?? { error: 'Mock error' };
  const agentCardOverrides = options.agentCardOverrides;
  const requests: MockA2ARemoteRequest[] = [];
  const deliveries: MockA2ACallbackDelivery[] = [];
  let lastReceivedHeaders: Record<string, string> = {};
  let taskCounter = 0;
  let endpointUrl = '';

  const app = express();
  app.use(express.json({ limit: '2mb', type: '*/*' }));

  app.use((req, res) => {
    // Capture headers from every request for getReceivedHeaders()
    lastReceivedHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        lastReceivedHeaders[key] = value;
      } else if (Array.isArray(value)) {
        lastReceivedHeaders[key] = value.join(', ');
      }
    }

    if (req.method === 'GET') {
      const defaultCard = {
        name: 'Mock Remote Analytics Agent',
        description: 'Mock remote A2A agent for runtime routing E2E tests',
        url: endpointUrl,
        version: '1.0.0',
        capabilities: {
          streaming: false,
          pushNotifications: true,
        },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [
          {
            id: 'analytics',
            name: 'Analytics',
            description: 'Produces a canned remote analytics completion response',
          },
        ],
      };
      res.json(agentCardOverrides ? { ...defaultCard, ...agentCardOverrides } : defaultCard);
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const extracted = extractPushNotificationConfig(req.body);
    requests.push({
      method: req.method,
      path: req.path,
      authorization: req.header('authorization') ?? null,
      body: req.body,
      callbackUrl: extracted.callbackUrl,
      callbackToken: extracted.callbackToken,
    });

    // Configurable error response — return error status without processing
    if (errorStatus) {
      res.status(errorStatus).json(errorBody);
      return;
    }

    const taskId = `remote-task-${++taskCounter}`;
    const contextId = extracted.contextId ?? `ctx-${crypto.randomUUID()}`;

    if (extracted.callbackUrl && extracted.callbackToken) {
      const payload = {
        id: taskId,
        kind: 'task',
        contextId,
        status: { state: 'completed' },
        message: {
          kind: 'message',
          messageId: `msg-${taskId}`,
          role: 'agent',
          parts: [{ kind: 'text', text: responseText }],
        },
      };

      setTimeout(() => {
        void (async () => {
          try {
            const response = await fetch(extracted.callbackUrl!, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${extracted.callbackToken!}`,
              },
              body: JSON.stringify(payload),
            });
            deliveries.push({
              url: extracted.callbackUrl!,
              token: extracted.callbackToken!,
              payload,
              ok: response.ok,
              status: response.status,
              responseText: await response.text(),
            });
          } catch (error) {
            deliveries.push({
              url: extracted.callbackUrl!,
              token: extracted.callbackToken!,
              payload,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      }, callbackDelayMs);
    }

    res.json({
      jsonrpc: '2.0',
      id: extracted.rpcId ?? taskId,
      result: {
        id: taskId,
        contextId,
        kind: 'task',
        status: { state: 'working' },
      },
    });
  });

  const server = await new Promise<http.Server>((resolve) => {
    const candidate = http.createServer(app);
    candidate.listen(0, '127.0.0.1', () => resolve(candidate));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  endpointUrl = `${baseUrl}/a2a/mock-remote`;

  return {
    baseUrl,
    endpointUrl,
    reset() {
      requests.length = 0;
      deliveries.length = 0;
      lastReceivedHeaders = {};
      taskCounter = 0;
    },
    getRequests() {
      return requests.slice();
    },
    getDeliveries() {
      return deliveries.slice();
    },
    getReceivedHeaders() {
      return { ...lastReceivedHeaders };
    },
    async close() {
      await closeServer(server);
    },
  };
}
