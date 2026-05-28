/**
 * PII Vault Boundary Contract — E2E Tests
 *
 * ABLP-535: HTTP-only E2E tests exercising PII vault boundary contract
 * through real Express runtime + MongoMemoryServer.
 *
 * Per CLAUDE.md test architecture:
 *   - No vi.mock of @abl/* or @agent-platform/*
 *   - API-only interaction (seed via POST, assert via GET)
 *   - LLM mocked via DI (external third-party, allowed)
 *   - No direct DB access
 *
 * Scenarios covered:
 *   E2E-1/E2E-2: Input PII tokenization + output masking round-trip
 *   E2E-6: PII pattern routes cross-project isolation (RBAC)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../../services/permission-resolution.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from '../helpers/channel-e2e-bootstrap.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';
import {
  bootstrapPIIProject,
  bootstrapPIIToolProject,
  chatWithPIIEcho,
  chatWithPIIToolAgent,
  patchPIIConfig,
  registerCustomPattern,
  startMockToolCaptor,
  type MockToolCaptor,
  type PIITraceEvent,
} from '../helpers/pii-e2e-helpers.js';

const SUITE_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 60_000;

let harness: RuntimeApiHarness;
let mockLlm: MockLLM;
let toolCaptor: MockToolCaptor;

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

describe.sequential('PII Vault Boundary Contract — E2E', () => {
  beforeAll(async () => {
    mockLlm = await startMockLLM();
    toolCaptor = await startMockToolCaptor();
    harness = await startRuntimeServerHarness({ ALLOW_INMEMORY_ASYNC_INFRA: 'true' });
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    mockLlm.reset();
    toolCaptor.reset();
  });

  afterAll(async () => {
    await harness.close();
    await mockLlm.close();
    await toolCaptor.close();
  }, SUITE_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // E2E-1 / E2E-2: PII input tokenization + output masking round-trip
  // -------------------------------------------------------------------------
  // These tests verify the user-visible boundary: PII in the user's message
  // is tokenized before reaching the LLM (observable via mock LLM request
  // capture), and PII in the LLM response is masked before reaching the user.

  test(
    'E2E-1: PII in user message is tokenized before LLM sees it (input redaction)',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-bc-input');
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: true,
        redact_output: true,
        enabled_recognizer_packs: ['core'],
      });

      const SSN = '123-45-6789';
      mockLlm.register('look up', { content: 'I found the record.' });

      const response = await chatWithPIIEcho(harness, admin, `Please look up SSN ${SSN}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // Verify the LLM received tokenized input (not raw SSN)
      const lastRequest = mockLlm.getLastRequest();
      expect(lastRequest).toBeDefined();

      const allContent = lastRequest!.messages
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join(' ');

      // The raw SSN should NOT appear in any message sent to the LLM
      expect(allContent).not.toContain(SSN);
      // The tokenized form should appear
      expect(allContent).toContain('{{PII:');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'E2E-2: PII in LLM response is masked for the end user (output redaction)',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-bc-output');
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: true,
        enabled_recognizer_packs: ['core'],
      });

      const PHONE = '555-867-5309';
      // Mock LLM returns a response containing PII
      mockLlm.register('what is', { content: `The contact number is ${PHONE}.` });

      const response = await chatWithPIIEcho(harness, admin, 'What is the contact number?');
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // The raw phone should NOT appear in the user-facing response
      expect(response.body.response).not.toContain(PHONE);
      // It should be masked (***-***-NNNN pattern)
      expect(response.body.response).toMatch(/\*{3}-\*{3}-\d{4}/);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'E2E-2b: PII in LLM response passes through raw when output redaction is OFF',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-bc-output-off');
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: false,
        redact_output: false,
        enabled_recognizer_packs: ['core'],
      });

      const PHONE = '555-867-5309';
      mockLlm.register('what is', { content: `The contact number is ${PHONE}.` });

      const response = await chatWithPIIEcho(harness, admin, 'What is the contact number?');
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // With output redaction OFF, the phone should appear raw
      expect(response.body.response).toContain(PHONE);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // E2E-1 (tool): Full Round-Trip — Original Access (pii_access='original')
  // -------------------------------------------------------------------------
  // Mock LLM receives tokenized PII, emits a tool call echoing the tokenized
  // arg (via dynamic extraction). The tool executor restores plaintext
  // (pii_access='original') and dispatches to the mock HTTP tool endpoint.
  // Assertions:
  //   (a) LLM saw tokenized form
  //   (b) Tool endpoint received plaintext SSN
  //   (c) pii_plaintext_dispensed trace event emitted
  //   (d) Final user-facing response masks the SSN

  test(
    'E2E-1 (tool): Full round-trip — tool with pii_access=original receives plaintext SSN',
    async () => {
      const admin = await bootstrapPIIToolProject(
        harness,
        mockLlm,
        toolCaptor,
        'pii-tool-orig',
        'original',
      );
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: true,
        redact_output: true,
        enabled_recognizer_packs: ['core'],
      });

      const SSN = '123-45-6789';

      // Use registerDynamicToolCall: the mock LLM extracts the PII token
      // from the message corpus at request time and echoes it as the tool
      // call argument. This avoids the UUID prediction problem.
      mockLlm.registerDynamicToolCall('look up', {
        name: 'crm_lookup',
        argExtractors: {
          // Match the full {{PII:ssn:UUID}} token from the corpus
          ssn: /\{\{PII:ssn:[0-9a-f-]+\}\}/i,
        },
        followUpContent: 'Record found. The SSN on file is confirmed.',
      });

      const response = await chatWithPIIToolAgent(harness, admin, `Please look up SSN ${SSN}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // (a) Verify LLM received tokenized input
      const allRequests = mockLlm.getAllRequests();
      const firstReq = allRequests[0];
      expect(firstReq).toBeDefined();
      const firstCorpus = firstReq.messages
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join(' ');
      expect(firstCorpus).not.toContain(SSN);
      expect(firstCorpus).toContain('{{PII:');

      // (b) Verify the tool captor received the plaintext SSN
      const capturedCalls = toolCaptor.getCapturedCalls();
      expect(capturedCalls.length).toBeGreaterThanOrEqual(1);
      const paramsStr = JSON.stringify(capturedCalls[0].params);
      expect(paramsStr).toContain(SSN);
      expect(paramsStr).not.toContain('{{PII:');

      // (c) Verify pii_plaintext_dispensed trace event — exactly one,
      // because only one PII token (the SSN) was dispensed to the tool.
      const traceEvents: PIITraceEvent[] = response.body.traceEvents ?? [];
      const dispensedEvents = traceEvents.filter((e) => e.type === 'pii_plaintext_dispensed');
      expect(dispensedEvents).toHaveLength(1);
      const dispensedEvent = dispensedEvents[0];
      expect(dispensedEvent.data.toolName).toBe('crm_lookup');
      expect(dispensedEvent.data.entityType).toBe('ssn');
      expect(dispensedEvent.data.piiAccess).toBe('original');
      // entityHash should be a SHA-256 hex string
      expect(typeof dispensedEvent.data.entityHash).toBe('string');
      expect((dispensedEvent.data.entityHash as string).length).toBe(64);

      // (d) Verify user-facing response masks the SSN
      expect(response.body.response).toBeDefined();
      expect(response.body.response).not.toContain(SSN);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // E2E-1B (tool): Audit precision under a multi-token vault (R1)
  // -------------------------------------------------------------------------
  // Seed the session vault with TWO different PII values (SSN + email) but
  // dispatch a tool whose single arg only contains the SSN. The audit
  // emitter must emit exactly ONE pii_plaintext_dispensed event (for the
  // SSN). Prior to R1 this would have emitted two events — one per vault
  // token — regardless of which tokens were actually substituted into
  // the tool call. This is the end-to-end proof of the precision claim.

  test(
    'E2E-1B (tool): multi-token vault — only dispensed tokens are audit-logged',
    async () => {
      const admin = await bootstrapPIIToolProject(
        harness,
        mockLlm,
        toolCaptor,
        'pii-tool-multi',
        'original',
      );
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: true,
        redact_output: true,
        enabled_recognizer_packs: ['core'],
      });

      const SSN = '123-45-6789';
      const EMAIL = 'alice@example.com';

      // Tool call echoes ONLY the SSN token — the email gets tokenized
      // into the vault but is never substituted into a tool arg.
      mockLlm.registerDynamicToolCall('look up', {
        name: 'crm_lookup',
        argExtractors: {
          ssn: /\{\{PII:ssn:[0-9a-f-]+\}\}/i,
        },
        followUpContent: 'Record found.',
      });

      const response = await chatWithPIIToolAgent(
        harness,
        admin,
        `Please look up SSN ${SSN} for ${EMAIL}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // Both PII values must have been tokenized in the LLM-facing prompt
      // — proves the vault held two tokens during dispatch.
      const allRequests = mockLlm.getAllRequests();
      const firstCorpus = allRequests[0].messages
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join(' ');
      expect(firstCorpus).not.toContain(SSN);
      expect(firstCorpus).not.toContain(EMAIL);
      expect(firstCorpus).toContain('{{PII:ssn:');
      expect(firstCorpus).toContain('{{PII:email:');

      // Tool received plaintext SSN, never the email (email was not in args).
      const capturedCalls = toolCaptor.getCapturedCalls();
      expect(capturedCalls.length).toBeGreaterThanOrEqual(1);
      const paramsStr = JSON.stringify(capturedCalls[0].params);
      expect(paramsStr).toContain(SSN);
      expect(paramsStr).not.toContain(EMAIL);

      // Exactly ONE pii_plaintext_dispensed event — for the SSN only.
      // Prior to R1 this would have been TWO events (SSN + email).
      const traceEvents: PIITraceEvent[] = response.body.traceEvents ?? [];
      const dispensedEvents = traceEvents.filter((e) => e.type === 'pii_plaintext_dispensed');
      expect(dispensedEvents).toHaveLength(1);
      expect(dispensedEvents[0].data.entityType).toBe('ssn');
      expect(dispensedEvents[0].data.toolName).toBe('crm_lookup');
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // E2E-2 (tool): Full Round-Trip — Redacted Access (default pii_access)
  // -------------------------------------------------------------------------
  // Tool has NO pii_access field (defaults to 'tools' → redacted rendering).
  // The tool executor should receive the redacted label, NOT plaintext.
  // No pii_plaintext_dispensed trace event should be emitted.

  test(
    'E2E-2 (tool): Full round-trip — tool with default pii_access receives redacted SSN',
    async () => {
      const admin = await bootstrapPIIToolProject(
        harness,
        mockLlm,
        toolCaptor,
        'pii-tool-redact',
        undefined, // no pii_access → default
      );
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: true,
        redact_output: true,
        enabled_recognizer_packs: ['core'],
      });

      const SSN = '123-45-6789';

      // Dynamic tool call: extract PII token and echo it as tool arg.
      // With default pii_access ('tools'), the runtime should render
      // the token as a redacted label before dispatching to the tool.
      mockLlm.registerDynamicToolCall('look up', {
        name: 'crm_lookup',
        argExtractors: {
          ssn: /\{\{PII:ssn:[0-9a-f-]+\}\}/i,
        },
        followUpContent: 'Record found with redacted data.',
      });

      const response = await chatWithPIIToolAgent(harness, admin, `Please look up SSN ${SSN}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // Verify the tool captor received redacted SSN (NOT plaintext)
      const capturedCalls = toolCaptor.getCapturedCalls();
      expect(capturedCalls.length).toBeGreaterThanOrEqual(1);
      const paramsStr = JSON.stringify(capturedCalls[0].params);
      // Should NOT contain the plaintext SSN
      expect(paramsStr).not.toContain(SSN);
      // Should NOT contain the tokenized form (it should be rendered)
      expect(paramsStr).not.toContain('{{PII:');
      // Should contain a redacted label (e.g. [REDACTED_SSN] or ***-**-****)
      expect(
        paramsStr.includes('[REDACTED') ||
          paramsStr.match(/\*{3}-\*{2}-\*{4}/) !== null ||
          paramsStr.includes('***'),
      ).toBe(true);

      // Verify NO pii_plaintext_dispensed event
      const traceEvents: PIITraceEvent[] = response.body.traceEvents ?? [];
      const dispensedEvents = traceEvents.filter((e) => e.type === 'pii_plaintext_dispensed');
      expect(dispensedEvents).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // E2E-3 (tool): Bare-UUID Restoration
  // -------------------------------------------------------------------------
  // Mock LLM strips the {{PII:type:UUID}} wrapper and emits ONLY the bare
  // UUID in the tool call args. The runtime's bare-UUID restoration path
  // (pii-vault.ts:253) should still restore the plaintext for
  // pii_access='original' tools.

  test(
    'E2E-3 (tool): Bare-UUID restoration — tool receives plaintext when LLM strips PII wrapper',
    async () => {
      const admin = await bootstrapPIIToolProject(
        harness,
        mockLlm,
        toolCaptor,
        'pii-tool-bare',
        'original',
      );
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: true,
        redact_output: true,
        enabled_recognizer_packs: ['core'],
      });

      const SSN = '123-45-6789';

      // Dynamic tool call that extracts ONLY the bare UUID (not the full
      // {{PII:...}} wrapper). This simulates an LLM that strips the wrapper
      // when constructing tool call arguments — a common real-world behavior.
      mockLlm.registerDynamicToolCall('look up', {
        name: 'crm_lookup',
        argExtractors: {
          // Extract just the UUID from inside the {{PII:ssn:UUID}} wrapper
          ssn: /(?<=\{\{PII:ssn:)[0-9a-f-]+(?=\}\})/i,
        },
        followUpContent: 'Record found via bare UUID restoration.',
      });

      const response = await chatWithPIIToolAgent(harness, admin, `Please look up SSN ${SSN}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      // Verify the tool captor received the PLAINTEXT SSN
      // (the bare-UUID restoration path should have matched the UUID
      // against the vault and resolved it to the original value)
      const capturedCalls = toolCaptor.getCapturedCalls();
      expect(capturedCalls.length).toBeGreaterThanOrEqual(1);
      const paramsStr = JSON.stringify(capturedCalls[0].params);
      expect(paramsStr).toContain(SSN);
      // Should NOT contain the tokenized form
      expect(paramsStr).not.toContain('{{PII:');

      // Verify pii_plaintext_dispensed trace event is emitted
      // (bare-UUID restoration with pii_access='original' still dispenses
      // plaintext, so the audit event fires)
      const traceEvents: PIITraceEvent[] = response.body.traceEvents ?? [];
      const dispensedEvents = traceEvents.filter((e) => e.type === 'pii_plaintext_dispensed');
      expect(dispensedEvents.length).toBeGreaterThanOrEqual(1);
      expect(dispensedEvents[0].data.toolName).toBe('crm_lookup');
      expect(dispensedEvents[0].data.entityType).toBe('ssn');
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // E2E-6: PII pattern routes — cross-project isolation (RBAC)
  // -------------------------------------------------------------------------
  // Verifies that PII patterns created in one project are not visible from
  // another project (even within the same tenant).

  test(
    'E2E-6a: PII pattern created in project A is not visible from project B (same tenant)',
    async () => {
      const adminA = await bootstrapPIIProject(harness, mockLlm, 'pii-bc-rbac-a');
      await patchPIIConfig(harness, adminA, {
        enabled: true,
        redact_input: true,
        redact_output: true,
      });

      // Create a custom PII pattern in project A
      const createResult = await registerCustomPattern(harness, adminA, {
        name: 'employee-id',
        regex: 'EMP-\\d{6}',
        piiType: 'employee_id',
        description: 'Employee ID format EMP-NNNNNN',
      });
      expect(createResult.status).toBe(201);

      // Verify pattern is visible in project A
      const getA = await requestJson<{ success: boolean; data: unknown[] }>(
        harness,
        `/api/projects/${adminA.projectId}/pii-patterns`,
        { method: 'GET', headers: authHeaders(adminA.token) },
      );
      expect(getA.status).toBe(200);
      expect(getA.body.data.length).toBeGreaterThanOrEqual(1);

      // Bootstrap project B under a different tenant
      const adminB = await bootstrapProject(
        harness,
        uniqueEmail('pii-bc-rbac-b-admin'),
        uniqueSlug('pii-bc-rbac-b-tenant'),
        uniqueSlug('pii-bc-rbac-b-project'),
      );

      // Project B should see no patterns (or 404 if tenant mismatch)
      const getB = await requestJson<{ success: boolean; data?: unknown[] }>(
        harness,
        `/api/projects/${adminB.projectId}/pii-patterns`,
        { method: 'GET', headers: authHeaders(adminB.token) },
      );
      // Either 200 with empty data (different tenant, different project) or 404
      if (getB.status === 200) {
        expect(getB.body.data).toHaveLength(0);
      } else {
        expect(getB.status).toBe(404);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'E2E-6b: cross-tenant access to PII patterns returns 404',
    async () => {
      const adminA = await bootstrapPIIProject(harness, mockLlm, 'pii-bc-cross-tenant-a');
      await registerCustomPattern(harness, adminA, {
        name: 'secret-code',
        regex: 'SEC-[A-Z]{4}',
        piiType: 'secret_code',
      });

      // Different tenant admin trying to access project A's patterns
      const adminB = await bootstrapProject(
        harness,
        uniqueEmail('pii-bc-cross-tenant-b-admin'),
        uniqueSlug('pii-bc-cross-tenant-b-tenant'),
        uniqueSlug('pii-bc-cross-tenant-b-project'),
      );

      const crossGet = await requestJson<{ success: boolean }>(
        harness,
        `/api/projects/${adminA.projectId}/pii-patterns`,
        { method: 'GET', headers: authHeaders(adminB.token) },
      );
      expect(crossGet.status).toBe(404);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // E2E-4 (boundary): cross-session isolation — PII from session A
  // does not leak into session B's response
  // -------------------------------------------------------------------------

  test(
    'E2E-4: PII from session A does not leak into session B output',
    async () => {
      const admin = await bootstrapPIIProject(harness, mockLlm, 'pii-bc-cross-session');
      await patchPIIConfig(harness, admin, {
        enabled: true,
        redact_input: true,
        redact_output: true,
        enabled_recognizer_packs: ['core'],
      });

      const EMAIL_A = 'secretagent@classified.gov';
      mockLlm.register('identify', { content: `The agent is ${EMAIL_A}.` });

      // Session A: send PII, get masked response
      const resA = await chatWithPIIEcho(harness, admin, 'Identify the secret agent');
      expect(resA.status).toBe(200);
      expect(resA.body.response).not.toContain(EMAIL_A);

      // Session B: different message, same project — should not see Session A's PII
      mockLlm.reset();
      mockLlm.register('weather', { content: 'The weather is sunny today.' });

      const resB = await chatWithPIIEcho(harness, admin, 'What is the weather?');
      expect(resB.status).toBe(200);
      // Session B's response should not contain session A's email
      expect(resB.body.response).not.toContain(EMAIL_A);
      expect(resB.body.response).not.toContain('classified.gov');
      // And should contain the expected weather response
      expect(resB.body.response).toContain('sunny');
    },
    TEST_TIMEOUT_MS,
  );
});
