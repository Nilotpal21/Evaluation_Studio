/**
 * Attachment PII Redaction E2E Tests (E2E-0.1 through E2E-0.6)
 *
 * Validates that PII in uploaded documents is correctly redacted, blocked, or
 * allowed before reaching the LLM, depending on tenant piiPolicy and file content.
 *
 * Uses the same canonical E2E patterns as channels-sdk-runtime.e2e.test.ts:
 * real Express servers, real MongoDB (via MongoMemoryServer), real auth middleware,
 * and a mock LLM server for response capture.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../../routes/auth.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import platformAdminModelsRouter from '../../routes/platform-admin-models.js';
import sdkPublicKeysRouter from '../../routes/sdk-public-keys.js';
import sdkInitRouter from '../../routes/sdk-init.js';
import sdkChannelsRouter from '../../routes/sdk-channels.js';
import projectIoRouter from '../../routes/project-io.js';
import chatRouter from '../../routes/chat.js';
import sessionsRouter from '../../routes/sessions.js';
import attachmentsRouter from '../../routes/attachments.js';
import attachmentConfigRouter from '../../routes/attachment-config.js';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  createSdkBootstrapChannel,
  createSdkPublicKey,
  importProjectFiles,
  initSdkSession,
  provisionTenantModel,
  requestJson,
  sdkHeaders,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import {
  startMultimodalServiceHarness,
  type MultimodalServiceHarness,
} from '../helpers/multimodal-service-harness.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type {
  MockLLM,
  OpenAIChatRequest,
} from '../../../../../tools/agents/e2e-functional/types.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const SIMPLE_AGENT_DSL = `
AGENT: PII_Test_Agent

GOAL: "Analyze uploaded files and respond."

EXECUTION:
  mode: reasoning
`;

/** Minimal valid 1x1 transparent PNG (67 bytes). */
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Upload a file to the session's attachment endpoint and return the attachmentId.
 */
async function uploadFile(
  harness: RuntimeApiHarness,
  projectId: string,
  sessionId: string,
  sdkToken: string,
  content: Blob,
  filename: string,
): Promise<string> {
  const form = new FormData();
  form.append('file', content, filename);

  const response = await fetch(
    `${harness.baseUrl}/api/projects/${projectId}/sessions/${sessionId}/attachments`,
    { method: 'POST', headers: sdkHeaders(sdkToken), body: form },
  );
  const body = (await response.json()) as {
    success: boolean;
    attachmentId: string;
    status: string;
  };
  expect(response.status).toBe(201);
  expect(body.success).toBe(true);
  return body.attachmentId;
}

/**
 * Simulate the async processing pipeline by PATCHing the attachment record via
 * the multimodal service's internal PATCH endpoint (the same endpoint pipeline
 * workers use to update attachment state after processing completes).
 */
async function simulateProcessing(
  multimodal: MultimodalServiceHarness,
  tenantId: string,
  attachmentId: string,
  update: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${multimodal.baseUrl}/internal/attachments/${attachmentId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': tenantId,
    },
    body: JSON.stringify(update),
  });
  expect(response.status).toBe(200);
}

/**
 * Send a chat message referencing attachment IDs and return the mock LLM's captured request.
 */
async function chatWithAttachments(
  harness: RuntimeApiHarness,
  sdkToken: string,
  projectId: string,
  sessionId: string,
  message: string,
  attachmentIds: string[],
): Promise<{
  chatResponse: { sessionId: string; response: string };
  lastLlmRequest: OpenAIChatRequest | undefined;
}> {
  const chatResult = await requestJson<{
    sessionId: string;
    response: string;
  }>(harness, '/api/v1/chat/agent', {
    method: 'POST',
    headers: sdkHeaders(sdkToken),
    body: {
      projectId,
      sessionId,
      message,
      attachmentIds,
    },
  });
  return {
    chatResponse: chatResult.body,
    lastLlmRequest: undefined, // caller reads from mockLlm directly
  };
}

/**
 * Extract all text content from mock LLM request messages into a single string
 * for assertion purposes.
 */
function extractLlmTextContent(request: OpenAIChatRequest): string {
  const parts: string[] = [];
  for (const msg of request.messages) {
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'string') {
          parts.push(part);
        } else if (part && typeof part === 'object') {
          if (typeof part.text === 'string') {
            parts.push(part.text);
          }
          if (typeof part.content === 'string') {
            parts.push(part.content);
          }
        }
      }
    }
  }
  return parts.join('\n');
}

/**
 * The mock LLM may receive a small follow-up/filler call after the main
 * reasoning request. For content assertions, prefer the richest request.
 */
function getPrimaryLlmRequest(mockLlm: MockLLM): OpenAIChatRequest | undefined {
  const allRequests = mockLlm.getAllRequests();
  return allRequests.length > 0
    ? allRequests.reduce((current, candidate) => {
        const currentScore = extractLlmTextContent(current).length * 1000 + current.messages.length;
        const candidateScore =
          extractLlmTextContent(candidate).length * 1000 + candidate.messages.length;
        return currentScore >= candidateScore ? current : candidate;
      })
    : undefined;
}

// ─── Test Suite ────────────────────────────────────────────────────────────

describe('Attachment PII Redaction E2E', () => {
  let harness: RuntimeApiHarness;
  let multimodal: MultimodalServiceHarness;
  let mockLlm: MockLLM;

  beforeAll(async () => {
    multimodal = await startMultimodalServiceHarness();
    mockLlm = await startMockLLM();

    harness = await startRuntimeApiHarness(
      (app) => {
        app.use('/api/auth', authRouter);
        app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
        app.use('/api/platform/admin/tenant-models', platformAdminModelsRouter);
        app.use('/api/projects/:projectId/sdk-public-keys', sdkPublicKeysRouter);
        app.use('/api/projects/:projectId/sdk-channels', sdkChannelsRouter);
        app.use('/api/v1/sdk', sdkInitRouter);
        app.use('/api/projects/:projectId/project-io', projectIoRouter);
        app.use('/api/v1/chat', chatRouter);
        app.use('/api/projects/:projectId/sessions', sessionsRouter);
        app.use('/api/projects/:projectId/sessions/:sessionId/attachments', attachmentsRouter);
        app.use('/api/projects/:projectId/attachment-config', attachmentConfigRouter);
      },
      { MULTIMODAL_SERVICE_URL: multimodal.baseUrl },
    );
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
    await multimodal.close();
  });

  /**
   * Helper: bootstrap a project with a mock LLM model provisioned and
   * an SDK session ready to go.
   */
  async function setupProjectWithSdk(testPrefix: string): Promise<{
    admin: { token: string; userId: string; tenantId: string; projectId: string };
    sdkToken: string;
    sessionId: string;
  }> {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail(`${testPrefix}-admin`),
      uniqueSlug(`tenant-${testPrefix}`),
      uniqueSlug(`project-${testPrefix}`),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/pii-test.agent.abl': SIMPLE_AGENT_DSL,
    });

    await provisionTenantModel(harness, admin.token, {
      targetTenantId: admin.tenantId,
      displayName: 'Mock PII Test Model',
      integrationType: 'api',
      provider: 'openai_compatible',
      modelId: 'mock-model',
      endpointUrl: mockLlm.url,
      supportsStreaming: false,
      supportsTools: true,
      capabilities: ['text', 'tools'],
      tier: 'balanced',
      isDefault: true,
      connection: {
        credentialName: 'mock-pii-model',
        apiKey: 'test-api-key',
      },
    });

    mockLlm.register('analyze', { content: 'I analyzed the file.' });

    const publicKey = await createSdkPublicKey(harness, admin.token, admin.projectId, {
      name: 'PII Test SDK Key',
    });
    await createSdkBootstrapChannel(harness, admin.token, admin.projectId, publicKey.id);

    const sdkSession = await initSdkSession(harness, {
      publicKey: publicKey.key!,
      userContext: { userId: `${testPrefix}-user` },
    });

    // Create a session by sending an initial message
    const initial = await requestJson<{ sessionId: string; response: string }>(
      harness,
      '/api/v1/chat/agent',
      {
        method: 'POST',
        headers: sdkHeaders(sdkSession.token),
        body: { projectId: admin.projectId, message: 'hello' },
      },
    );
    expect(initial.status).toBe(200);

    return {
      admin,
      sdkToken: sdkSession.token,
      sessionId: initial.body.sessionId,
    };
  }

  // ─── E2E-0.1: Upload doc with PII → LLM receives redacted content ─────

  test(
    'E2E-0.1: PII in document is redacted before reaching the LLM',
    { timeout: 30_000 },
    async () => {
      const { admin, sdkToken, sessionId } = await setupProjectWithSdk('pii-redact');

      const piiContent = 'Contact user@example.com or call 123-45-6789 for details.';
      const attachmentId = await uploadFile(
        harness,
        admin.projectId,
        sessionId,
        sdkToken,
        new Blob([piiContent], { type: 'text/plain' }),
        'pii-doc.txt',
      );

      // Simulate the processing pipeline completing with PII detections.
      // Offsets must match the actual positions in processedContent:
      //   "Contact user@example.com or call 123-45-6789 for details."
      //            ^8             ^24          ^33          ^44
      await simulateProcessing(multimodal, admin.tenantId, attachmentId, {
        processingStatus: 'completed',
        scanStatus: 'clean',
        processedContent: piiContent,
        hasPII: true,
        piiDetections: [
          { type: 'email', start: 8, end: 24, value: 'user@example.com' },
          { type: 'ssn', start: 33, end: 44, value: '123-45-6789' },
        ],
      });

      mockLlm.reset();
      mockLlm.register('analyze', { content: 'I analyzed the file.' });

      await chatWithAttachments(harness, sdkToken, admin.projectId, sessionId, 'analyze the file', [
        attachmentId,
      ]);

      const primaryReq = getPrimaryLlmRequest(mockLlm);
      expect(primaryReq).toBeDefined();

      const llmText = extractLlmTextContent(primaryReq!);

      // PII should be redacted
      expect(llmText).not.toContain('user@example.com');
      expect(llmText).not.toContain('123-45-6789');
      expect(llmText).toContain('[REDACTED:email]');
      expect(llmText).toContain('[REDACTED:ssn]');
    },
  );

  // ─── E2E-0.2: Upload clean doc → LLM receives full content ────────────

  test(
    'E2E-0.2: clean document content reaches the LLM verbatim',
    { timeout: 30_000 },
    async () => {
      const { admin, sdkToken, sessionId } = await setupProjectWithSdk('pii-clean');

      const cleanContent = 'Hello World, this is a test document with no sensitive data.';
      const attachmentId = await uploadFile(
        harness,
        admin.projectId,
        sessionId,
        sdkToken,
        new Blob([cleanContent], { type: 'text/plain' }),
        'clean-doc.txt',
      );

      // Simulate processing — no PII detected
      await simulateProcessing(multimodal, admin.tenantId, attachmentId, {
        processingStatus: 'completed',
        scanStatus: 'clean',
        processedContent: cleanContent,
        hasPII: false,
        piiDetections: [],
      });

      mockLlm.reset();
      mockLlm.register('analyze', { content: 'I analyzed the file.' });

      await chatWithAttachments(harness, sdkToken, admin.projectId, sessionId, 'analyze the file', [
        attachmentId,
      ]);

      const primaryReq = getPrimaryLlmRequest(mockLlm);
      expect(primaryReq).toBeDefined();

      const llmText = extractLlmTextContent(primaryReq!);
      expect(llmText).toContain(cleanContent);
    },
  );

  // ─── E2E-0.3: Tenant piiPolicy='block' → LLM receives block message ──

  test(
    'E2E-0.3: piiPolicy=block sends block message instead of content',
    { timeout: 30_000 },
    async () => {
      const { admin, sdkToken, sessionId } = await setupProjectWithSdk('pii-block');

      // Set project-level piiPolicy to 'block' via the attachment config route
      const configRes = await requestJson(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { piiPolicy: 'block' },
        },
      );
      expect(configRes.status).toBe(200);

      const piiContent = 'Secret data: user@example.com and 123-45-6789';
      const attachmentId = await uploadFile(
        harness,
        admin.projectId,
        sessionId,
        sdkToken,
        new Blob([piiContent], { type: 'text/plain' }),
        'blocked-doc.txt',
      );

      await simulateProcessing(multimodal, admin.tenantId, attachmentId, {
        processingStatus: 'completed',
        scanStatus: 'clean',
        processedContent: piiContent,
        hasPII: true,
        piiDetections: [
          { type: 'email', start: 13, end: 33, value: 'user@example.com' },
          { type: 'ssn', start: 38, end: 49, value: '123-45-6789' },
        ],
      });

      mockLlm.reset();
      mockLlm.register('analyze', { content: 'I analyzed the file.' });

      await chatWithAttachments(harness, sdkToken, admin.projectId, sessionId, 'analyze the file', [
        attachmentId,
      ]);

      const primaryReq = getPrimaryLlmRequest(mockLlm);
      expect(primaryReq).toBeDefined();

      const llmText = extractLlmTextContent(primaryReq!);
      expect(llmText).toContain('[File contains PII and cannot be processed]');
      expect(llmText).not.toContain('user@example.com');
    },
  );

  // ─── E2E-0.4: Tenant piiPolicy='allow' → LLM receives raw content ────

  test(
    'E2E-0.4: piiPolicy=allow passes raw PII content to the LLM',
    { timeout: 30_000 },
    async () => {
      const { admin, sdkToken, sessionId } = await setupProjectWithSdk('pii-allow');

      // Set project-level piiPolicy to 'allow' via the attachment config route
      const configRes = await requestJson(
        harness,
        `/api/projects/${admin.projectId}/attachment-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: { piiPolicy: 'allow' },
        },
      );
      expect(configRes.status).toBe(200);

      const piiContent = 'Contact user@example.com or call 123-45-6789 for details.';
      const attachmentId = await uploadFile(
        harness,
        admin.projectId,
        sessionId,
        sdkToken,
        new Blob([piiContent], { type: 'text/plain' }),
        'allowed-doc.txt',
      );

      await simulateProcessing(multimodal, admin.tenantId, attachmentId, {
        processingStatus: 'completed',
        scanStatus: 'clean',
        processedContent: piiContent,
        hasPII: true,
        piiDetections: [
          { type: 'email', start: 8, end: 28, value: 'user@example.com' },
          { type: 'ssn', start: 37, end: 48, value: '123-45-6789' },
        ],
      });

      mockLlm.reset();
      mockLlm.register('analyze', { content: 'I analyzed the file.' });

      await chatWithAttachments(harness, sdkToken, admin.projectId, sessionId, 'analyze the file', [
        attachmentId,
      ]);

      const primaryReq = getPrimaryLlmRequest(mockLlm);
      expect(primaryReq).toBeDefined();

      const llmText = extractLlmTextContent(primaryReq!);
      expect(llmText).toContain('user@example.com');
      expect(llmText).toContain('123-45-6789');
    },
  );

  // ─── E2E-0.5: Image upload → no PII detection (regression) ────────────

  test(
    'E2E-0.5: image upload is processed normally without PII-related redaction',
    { timeout: 30_000 },
    async () => {
      const { admin, sdkToken, sessionId } = await setupProjectWithSdk('pii-image');

      const attachmentId = await uploadFile(
        harness,
        admin.projectId,
        sessionId,
        sdkToken,
        new Blob([MINIMAL_PNG], { type: 'image/png' }),
        'test-image.png',
      );

      // Images skip the processingStatus check in the preprocessor and go straight
      // to image handling. Simulate clean scan and no PII on the record.
      await simulateProcessing(multimodal, admin.tenantId, attachmentId, {
        scanStatus: 'clean',
        hasPII: false,
      });

      mockLlm.reset();
      mockLlm.register('analyze', { content: 'I see an image.' });

      await chatWithAttachments(harness, sdkToken, admin.projectId, sessionId, 'analyze the file', [
        attachmentId,
      ]);

      const primaryReq = getPrimaryLlmRequest(mockLlm);
      expect(primaryReq).toBeDefined();

      const llmText = extractLlmTextContent(primaryReq!);

      // Image content should NOT have any PII redaction markers
      expect(llmText).not.toContain('[REDACTED:');
      expect(llmText).not.toContain('[File contains PII');
      // The LLM should have received the user message at minimum
      expect(llmText).toContain('analyze the file');
    },
  );

  // ─── E2E-0.6: Multiple attachments, mixed PII → per-file handling ─────

  test(
    'E2E-0.6: mixed attachments — PII file is redacted, clean file is verbatim',
    { timeout: 30_000 },
    async () => {
      const { admin, sdkToken, sessionId } = await setupProjectWithSdk('pii-mixed');

      const piiContent = 'Send to user@example.com please.';
      const cleanContent = 'This document has no sensitive information at all.';

      const piiAttachmentId = await uploadFile(
        harness,
        admin.projectId,
        sessionId,
        sdkToken,
        new Blob([piiContent], { type: 'text/plain' }),
        'pii-file.txt',
      );

      const cleanAttachmentId = await uploadFile(
        harness,
        admin.projectId,
        sessionId,
        sdkToken,
        new Blob([cleanContent], { type: 'text/plain' }),
        'clean-file.txt',
      );

      // Simulate processing for PII file.
      // Offsets must match the actual positions in processedContent:
      //   "Send to user@example.com please."
      //            ^8             ^24
      await simulateProcessing(multimodal, admin.tenantId, piiAttachmentId, {
        processingStatus: 'completed',
        scanStatus: 'clean',
        processedContent: piiContent,
        hasPII: true,
        piiDetections: [{ type: 'email', start: 8, end: 24, value: 'user@example.com' }],
      });

      // Simulate processing for clean file
      await simulateProcessing(multimodal, admin.tenantId, cleanAttachmentId, {
        processingStatus: 'completed',
        scanStatus: 'clean',
        processedContent: cleanContent,
        hasPII: false,
        piiDetections: [],
      });

      mockLlm.reset();
      mockLlm.register('analyze', { content: 'I analyzed both files.' });

      await chatWithAttachments(
        harness,
        sdkToken,
        admin.projectId,
        sessionId,
        'analyze the files',
        [piiAttachmentId, cleanAttachmentId],
      );

      const primaryReq = getPrimaryLlmRequest(mockLlm);
      expect(primaryReq).toBeDefined();

      const llmText = extractLlmTextContent(primaryReq!);

      // PII file: email should be redacted
      expect(llmText).not.toContain('user@example.com');
      expect(llmText).toContain('[REDACTED:email]');

      // Clean file: content should appear verbatim
      expect(llmText).toContain(cleanContent);
    },
  );
});
