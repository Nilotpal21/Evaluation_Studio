import { test, expect, type APIRequestContext } from '@playwright/test';
import { buildWebDebugWSProtocols } from '@agent-platform/shared/websocket-auth';
import { apiDelete, apiGet, apiPost } from './helpers/api';
import { env } from './helpers/env';

const TEST_LOGIN_EMAIL = 'session-attachments@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Session Attachments E2E';

interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
}

interface AgentRecord {
  id: string;
  name: string;
  description?: string | null;
}

interface StudioProjectResponse {
  success: boolean;
  project: ProjectRecord;
}

interface StudioAttachmentUploadResponse {
  success: boolean;
  attachmentId: string;
  status: string;
}

interface StudioAttachmentRecord {
  id: string;
  _id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: string;
  processingStatus: string;
  [key: string]: unknown;
}

interface StudioAttachmentListResponse {
  success: boolean;
  data: {
    attachments: StudioAttachmentRecord[];
    total: number;
  };
}

interface RuntimeWsMessage {
  type: string;
  sessionId?: string;
  requestId?: string;
  persisted?: boolean;
  error?: {
    code?: string;
    message?: string;
  };
  [key: string]: unknown;
}

function uniqueSuffix() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getTenantIdFromToken(token: string) {
  const [, payload = ''] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tenantId?: string;
  };
  return decoded.tenantId ?? env.tenantId;
}

async function getDevAccessToken(request: APIRequestContext) {
  const response = await request.post(`${env.baseUrl}/api/auth/dev-login`, {
    data: { email: TEST_LOGIN_EMAIL, name: TEST_LOGIN_NAME },
  });

  expect(response.ok()).toBeTruthy();

  const body = (await response.json()) as {
    accessToken?: string;
  };

  expect(body.accessToken).toBeTruthy();
  return body.accessToken ?? '';
}

async function createProject(request: APIRequestContext, token: string, tenantId: string) {
  const suffix = uniqueSuffix();
  const slugSuffix = suffix.replace(/_/g, '-');
  const response = await apiPost<StudioProjectResponse>(
    request,
    '/api/projects',
    token,
    {
      name: `Session Attachments ${suffix}`,
      slug: `session-attachments-${slugSuffix}`,
      description: 'Playwright API coverage for Studio session attachment proxy routes',
    },
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);

  return response.body.project;
}

async function createAgent(
  request: APIRequestContext,
  token: string,
  tenantId: string,
  projectId: string,
  name: string,
) {
  const response = await request.post(`${env.baseUrl}/api/projects/${projectId}/agents`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
    },
    data: {
      name,
      agentPath: `e2e/${name}`,
      description: `${name} API E2E agent`,
    },
  });

  expect(response.status()).toBe(201);
  return (await response.json()) as AgentRecord;
}

async function saveDsl(
  request: APIRequestContext,
  token: string,
  tenantId: string,
  projectId: string,
  agentName: string,
) {
  const dslContent = `AGENT: ${agentName}
ROLE: Attachment helper
GOAL: Help with attachment verification`;

  const response = await request.put(
    `${env.baseUrl}/api/projects/${projectId}/agents/${agentName}/dsl`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-Id': tenantId,
        'Content-Type': 'application/json',
      },
      data: { dslContent },
    },
  );

  expect(response.status()).toBe(200);
}

async function createChatSession(
  request: APIRequestContext,
  token: string,
  tenantId: string,
  projectId: string,
  agentName: string,
) {
  const response = await request.post(`${env.runtimeUrl}/api/v1/chat/agent`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
    },
    data: {
      projectId,
      // Runtime chat accepts agent path/name here; this test uses the created agent name.
      agentId: agentName,
      message: 'hello',
    },
  });

  expect(response.status()).toBe(200);

  const body = (await response.json()) as {
    sessionId?: string;
    response?: string;
  };

  expect(body.sessionId).toBeTruthy();
  return body.sessionId ?? '';
}

async function uploadAttachmentViaStudio(
  request: APIRequestContext,
  token: string,
  tenantId: string,
  projectId: string,
  sessionId: string,
  fileName: string,
  content: string,
) {
  const response = await request.post(
    `${env.baseUrl}/api/projects/${projectId}/sessions/${sessionId}/attachments`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-Id': tenantId,
      },
      multipart: {
        file: {
          name: fileName,
          mimeType: 'text/plain',
          buffer: Buffer.from(content),
        },
      },
    },
  );

  const body = (await response.json()) as StudioAttachmentUploadResponse;
  return { status: response.status(), body };
}

async function listAttachmentsViaStudio(
  request: APIRequestContext,
  token: string,
  tenantId: string,
  projectId: string,
  sessionId: string,
) {
  return await apiGet<StudioAttachmentListResponse>(
    request,
    `/api/projects/${projectId}/sessions/${sessionId}/attachments?limit=20&offset=0`,
    token,
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );
}

async function waitForAttachment(
  request: APIRequestContext,
  token: string,
  tenantId: string,
  projectId: string,
  sessionId: string,
  attachmentId: string,
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await listAttachmentsViaStudio(request, token, tenantId, projectId, sessionId);

    if (
      response.status === 200 &&
      response.body.data.attachments.some((attachment) => attachment.id === attachmentId)
    ) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Attachment ${attachmentId} did not appear in session ${sessionId}`);
}

async function readWebSocketPayload(data: unknown): Promise<string> {
  if (typeof data === 'string') {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }

  if (data instanceof Blob) {
    return await data.text();
  }

  return String(data);
}

async function waitForRuntimeMessage(
  ws: WebSocket,
  predicate: (message: RuntimeWsMessage) => boolean,
  timeoutMs = 20_000,
): Promise<RuntimeWsMessage> {
  return await new Promise<RuntimeWsMessage>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener('message', handleMessage);
      ws.removeEventListener('close', handleClose);
      ws.removeEventListener('error', handleError);
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const timeout = setTimeout(() => {
      settle(() => reject(new Error(`Timed out waiting for runtime WebSocket message`)));
    }, timeoutMs);

    const handleMessage = (event: MessageEvent) => {
      readWebSocketPayload(event.data)
        .then((payload) => {
          const message = JSON.parse(payload) as RuntimeWsMessage;
          if (predicate(message)) {
            settle(() => resolve(message));
          }
        })
        .catch((error: unknown) => {
          settle(() => reject(error instanceof Error ? error : new Error(String(error))));
        });
    };

    const handleClose = (event: CloseEvent) => {
      settle(() =>
        reject(
          new Error(
            `Runtime WebSocket closed before expected message: ${event.code} ${event.reason}`,
          ),
        ),
      );
    };

    const handleError = () => {
      settle(() => reject(new Error('Runtime WebSocket errored before expected message')));
    };

    ws.addEventListener('message', handleMessage);
    ws.addEventListener('close', handleClose);
    ws.addEventListener('error', handleError);
  });
}

async function waitForRuntimeOpen(ws: WebSocket, timeoutMs = 20_000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener('open', handleOpen);
      ws.removeEventListener('close', handleClose);
      ws.removeEventListener('error', handleError);
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const timeout = setTimeout(() => {
      settle(() => reject(new Error('Timed out opening runtime WebSocket')));
    }, timeoutMs);

    const handleOpen = () => settle(resolve);
    const handleClose = (event: CloseEvent) => {
      settle(() =>
        reject(new Error(`Runtime WebSocket closed before open: ${event.code} ${event.reason}`)),
      );
    };
    const handleError = () => settle(() => reject(new Error('Runtime WebSocket open failed')));

    ws.addEventListener('open', handleOpen);
    ws.addEventListener('close', handleClose);
    ws.addEventListener('error', handleError);
  });
}

async function loadAgentViaRuntimeWebSocket(
  token: string,
  projectId: string,
  agentName: string,
): Promise<{ ws: WebSocket; sessionId: string }> {
  const wsUrl = `${env.runtimeUrl.replace(/^http/, 'ws')}/ws`;
  const ws = new WebSocket(wsUrl, buildWebDebugWSProtocols(token));

  await waitForRuntimeOpen(ws);
  ws.send(JSON.stringify({ type: 'load_agent', agentPath: agentName, projectId }));

  const loaded = await waitForRuntimeMessage(
    ws,
    (message) => message.type === 'agent_loaded' && typeof message.sessionId === 'string',
  );

  return { ws, sessionId: loaded.sessionId ?? '' };
}

async function ensureRuntimeSessionPersisted(ws: WebSocket, sessionId: string): Promise<void> {
  const requestId = `persist-${uniqueSuffix()}`;

  ws.send(JSON.stringify({ type: 'ensure_session_persisted', sessionId, requestId }));

  const result = await waitForRuntimeMessage(
    ws,
    (message) =>
      (message.type === 'session_persisted' || message.type === 'session_persist_failed') &&
      message.sessionId === sessionId &&
      message.requestId === requestId,
  );

  expect(result.type).toBe('session_persisted');
  expect(result.persisted).toBe(true);
}

test.describe.configure({ mode: 'serial' });

test.describe('Studio Session Attachments API', () => {
  let token = '';
  let tenantId = '';
  let projectId = '';
  let agentName = '';

  test.beforeAll(async ({ request }) => {
    token = await getDevAccessToken(request);
    tenantId = getTenantIdFromToken(token);

    const project = await createProject(request, token, tenantId);
    projectId = project.id;

    agentName = `attachment_proxy_${uniqueSuffix().replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const agent = await createAgent(request, token, tenantId, projectId, agentName);
    expect(agent.name).toBe(agentName);

    await saveDsl(request, token, tenantId, projectId, agentName);
  });

  test.afterAll(async ({ request }) => {
    if (projectId && token) {
      await apiDelete(request, `/api/projects/${projectId}`, token, {
        headers: { 'X-Tenant-Id': tenantId },
      });
    }
  });

  test('uploads and lists attachments through the Studio public API', async ({ request }) => {
    const sessionId = await createChatSession(request, token, tenantId, projectId, agentName);
    const fileName = `attachment-${uniqueSuffix()}.txt`;
    const content = `Incident note\nTicket reference: TCK-9001\nCreated at ${new Date().toISOString()}`;

    const upload = await uploadAttachmentViaStudio(
      request,
      token,
      tenantId,
      projectId,
      sessionId,
      fileName,
      content,
    );

    expect(upload.status).toBe(201);
    expect(upload.body.success).toBe(true);
    expect(upload.body.attachmentId).toBeTruthy();

    const list = await waitForAttachment(
      request,
      token,
      tenantId,
      projectId,
      sessionId,
      upload.body.attachmentId,
    );

    expect(list.status).toBe(200);
    expect(list.body.success).toBe(true);
    expect(list.body.data.total).toBeGreaterThanOrEqual(1);

    const attachment = list.body.data.attachments.find(
      (record) => record.id === upload.body.attachmentId,
    );
    expect(attachment).toBeTruthy();
    expect(attachment?.originalFilename).toBe(fileName);
    expect(attachment?.mimeType).toBe('text/plain');
  });

  test('uploads after persisting a debug WebSocket session before the first message', async ({
    request,
  }) => {
    const { ws, sessionId } = await loadAgentViaRuntimeWebSocket(token, projectId, agentName);

    try {
      expect(sessionId).toBeTruthy();
      await ensureRuntimeSessionPersisted(ws, sessionId);

      const fileName = `pre-message-${uniqueSuffix()}.txt`;
      const upload = await uploadAttachmentViaStudio(
        request,
        token,
        tenantId,
        projectId,
        sessionId,
        fileName,
        'Attachment uploaded before the first chat message',
      );

      expect(upload.status).toBe(201);
      expect(upload.body.success).toBe(true);
      expect(upload.body.attachmentId).toBeTruthy();

      const list = await waitForAttachment(
        request,
        token,
        tenantId,
        projectId,
        sessionId,
        upload.body.attachmentId,
      );

      const attachment = list.body.data.attachments.find(
        (record) => record.id === upload.body.attachmentId,
      );

      expect(attachment?.originalFilename).toBe(fileName);
    } finally {
      ws.close();
    }
  });

  test('keeps attachments isolated to the owning session', async ({ request }) => {
    const sessionA = await createChatSession(request, token, tenantId, projectId, agentName);
    const sessionB = await createChatSession(request, token, tenantId, projectId, agentName);
    const fileName = `session-a-${uniqueSuffix()}.txt`;

    const upload = await uploadAttachmentViaStudio(
      request,
      token,
      tenantId,
      projectId,
      sessionA,
      fileName,
      'Attachment scoped to session A',
    );

    expect(upload.status).toBe(201);

    const sessionAList = await waitForAttachment(
      request,
      token,
      tenantId,
      projectId,
      sessionA,
      upload.body.attachmentId,
    );
    const sessionBList = await listAttachmentsViaStudio(
      request,
      token,
      tenantId,
      projectId,
      sessionB,
    );

    expect(sessionAList.status).toBe(200);
    expect(
      sessionAList.body.data.attachments.some(
        (attachment) => attachment.id === upload.body.attachmentId,
      ),
    ).toBe(true);

    expect(sessionBList.status).toBe(200);
    expect(
      sessionBList.body.data.attachments.some(
        (attachment) => attachment.id === upload.body.attachmentId,
      ),
    ).toBe(false);
  });
});
