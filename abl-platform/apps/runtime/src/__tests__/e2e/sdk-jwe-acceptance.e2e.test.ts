/**
 * ABLP-862 red-phase E2E acceptance scenarios for hosted_exchange JWE.
 *
 * Design source: docs/architecture/runtime-deterministic-test-architecture.md.
 * This file is Tier 3: public HTTP/WebSocket boundary proof only. Keep it
 * small and lifecycle-oriented; detailed policy branches live in the Tier 1
 * resolver scenarios.
 *
 * These scenarios are intentionally expected to fail until the JWE envelope,
 * runtime key capability, route wiring, and diagnostics slices are implemented.
 */

import { WebSocket as NodeWebSocket } from 'ws';
import { signSdkBootstrapArtifact } from '@agent-platform/shared';
import { signSDKSessionToken } from '@agent-platform/shared-auth';
import { buildSdkWSProtocols } from '@agent-platform/shared/websocket-auth';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  startRuntimeServerHarness,
  TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET,
  TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET,
  type RuntimeApiHarness,
} from '../helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  createSdkChannelDetailed,
  createSdkCustomerSession,
  createSdkPublicKey,
  provisionBasicAgentProject,
  requestJson,
  sdkHeaders,
  uniqueEmail,
  uniqueSlug,
  updateSdkChannel,
  type BootstrapProjectResult,
  type DeploymentRecord,
  type SdkCustomerSessionResult,
  type SdkInitResult,
} from '../helpers/channel-e2e-bootstrap.js';
import { resetHybridRateLimiter } from '../../services/resilience/hybrid-rate-limiter.js';
import { startMockLLM } from '../../../../../tools/agents/e2e-functional/mock-llm-server.js';
import type { MockLLM } from '../../../../../tools/agents/e2e-functional/types.js';

const SUITE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 45_000;
const SENSITIVE_VERIFIED_USER_ID = 'member-sensitive-12345';
const SENSITIVE_POLICY_ID = 'policy-id-FB-998877';

type TokenEnvelope = 'signed' | 'jwe';
type SdkTokenEnvelopePolicy = 'signed' | 'jwe_preferred' | 'jwe_required';

type JweAcceptanceScenarioKind =
  | 'encrypted_lifecycle'
  | 'tamper_rejected'
  | 'strict_policy_rejects_signed'
  | 'preferred_policy_legacy_compat'
  | 'public_key_compat'
  | 'oversize_rejected'
  | 'diagnostics_guarded'
  | 'project_default_inheritance'
  | 'signed_channel_override'
  | 'preferred_refresh_preserves_existing_jwe'
  | 'session_transport_budget_rejected'
  | 'diagnostic_oracle_guard'
  | 'signed_rollback_verifies_existing_jwe'
  | 'origin_policy_after_decrypt'
  | 'response_minimization'
  | 'malformed_jwe_no_fallback';

const JWE_E2E_SCENARIO_COVERAGE = {
  encrypted_lifecycle:
    'JWE-E2E-01/02/03/04/05 encrypted bootstrap, init, refresh, HTTP auth, WebSocket auth',
  tamper_rejected: 'JWE-E2E-06 tampering any encrypted token segment fails closed',
  strict_policy_rejects_signed: 'JWE-E2E-07 jwe_required rejects signed bootstrap/session',
  preferred_policy_legacy_compat: 'JWE-E2E-08 jwe_preferred keeps signed rollback compatibility',
  public_key_compat: 'JWE-E2E-09 public-key bootstrap remains signed and working',
  oversize_rejected: 'JWE-E2E-10 encrypted token size budget fails deterministically',
  diagnostics_guarded: 'JWE-E2E-11 diagnostics are authenticated and claim-safe',
  project_default_inheritance:
    'JWE-E2E-12 project default jwe_required encrypts inherited hosted_exchange channels',
  signed_channel_override:
    'JWE-E2E-13 signed channel override prevents accidental project-default JWE rollout',
  preferred_refresh_preserves_existing_jwe:
    'JWE-E2E-14 jwe_preferred refresh preserves existing encrypted SDK sessions',
  session_transport_budget_rejected:
    'JWE-E2E-15 oversized SDK session headers and WebSocket protocols fail at the boundary',
  diagnostic_oracle_guard:
    'JWE-E2E-16 diagnostics do not distinguish unknown, expired, or disabled kid states',
  signed_rollback_verifies_existing_jwe:
    'JWE-E2E-17 signed rollback stops issuance while verifying existing encrypted SDK sessions',
  origin_policy_after_decrypt:
    'JWE-E2E-18 origin allowlist still fails closed after encrypted bootstrap decrypt',
  response_minimization:
    'JWE-E2E-19 JWE customer, init, and refresh responses expose no claims or key metadata',
  malformed_jwe_no_fallback:
    'JWE-E2E-20 malformed compact JWE never falls back to signed verification',
} satisfies Record<JweAcceptanceScenarioKind, string>;

interface SdkInitJweResult extends SdkInitResult {
  tokenEnvelope?: TokenEnvelope;
}

interface SdkCustomerSessionJweResult extends SdkCustomerSessionResult {
  tokenEnvelope?: TokenEnvelope;
}

interface HostedExchangeFixture {
  channelId: string;
  serverSecret: string;
}

let harness: RuntimeApiHarness;
let mockLlm: MockLLM;
let admin: BootstrapProjectResult;
let deployment: DeploymentRecord;

function tokenSegmentCount(token: string): number {
  return token.split('.').length;
}

function expectCompactJwe(token: string, label: string): void {
  expect(tokenSegmentCount(token), `${label} must be compact JWE`).toBe(5);
}

function expectSensitiveValuesHidden(token: string): void {
  expect(token).not.toContain(SENSITIVE_VERIFIED_USER_ID);
  expect(token).not.toContain(SENSITIVE_POLICY_ID);
}

function expectNoSensitiveResponseLeak(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(SENSITIVE_VERIFIED_USER_ID);
  expect(serialized).not.toContain(SENSITIVE_POLICY_ID);
  expect(serialized).not.toMatch(
    /"claims"|verifiedUserId|customAttributes|serverSecret|keyMaterial|encryptionKey|plaintext|jwk/i,
  );
}

function tamperCompactToken(token: string): string {
  const segments = token.split('.');
  expect(segments.length, 'test setup requires compact JWE before tampering').toBe(5);
  const ciphertext = segments[3] ?? '';
  segments[3] = ciphertext.endsWith('A') ? `${ciphertext.slice(0, -1)}B` : `${ciphertext}A`;
  return segments.join('.');
}

async function waitForSocketMessage(
  ws: NodeWebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    };

    const onMessage = (data: NodeWebSocket.RawData) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }

      if (predicate(parsed)) {
        cleanup();
        resolve(parsed);
      }
    };

    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(
        new Error(
          `WebSocket closed before ${label}: code=${code} reason=${reason.toString('utf8')}`,
        ),
      );
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    ws.on('message', onMessage);
    ws.once('close', onClose);
    ws.once('error', onError);
  });
}

async function waitForSocketClose(ws: NodeWebSocket, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket close'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('close', onClose);
      ws.off('open', onOpen);
      ws.off('error', onError);
    };

    const onClose = (code: number) => {
      cleanup();
      resolve(code);
    };

    const onOpen = () => {
      cleanup();
      reject(new Error('Oversized SDK token unexpectedly opened WebSocket'));
    };

    const onError = () => {
      cleanup();
      resolve(1006);
    };

    ws.once('close', onClose);
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

function createOversizedJweShapedToken(): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM', kid: 'oversize' })).toString(
      'base64url',
    ),
    '',
    'i'.repeat(1200),
    'c'.repeat(3600),
    't'.repeat(1200),
  ].join('.');
}

function createMalformedJweShapedToken(kid = 'malformed-kid'): string {
  return [
    Buffer.from(
      JSON.stringify({
        alg: 'dir',
        enc: 'A256GCM',
        kid,
        typ: 'abl-sdk-session+jwe',
        cty: 'abl-sdk-session+jwt',
        epv: 1,
      }),
    ).toString('base64url'),
    '',
    Buffer.from('invalid-iv').toString('base64url'),
    Buffer.from('not-a-real-ciphertext').toString('base64url'),
    Buffer.from('invalid-tag').toString('base64url'),
  ].join('.');
}

async function setProjectHostedExchangePolicy(
  policy: SdkTokenEnvelopePolicy | null,
): Promise<void> {
  const response = await requestJson<{ success: boolean }>(
    harness,
    `/api/projects/${admin.projectId}/settings`,
    {
      method: 'PUT',
      headers: authHeaders(admin.token),
      body: {
        sdkDefaults: policy
          ? {
              hostedExchangeTokenEnvelopePolicy: policy,
            }
          : null,
      },
    },
  );

  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function createHostedExchangeFixture(
  policy: SdkTokenEnvelopePolicy,
  namePrefix: string,
): Promise<HostedExchangeFixture> {
  const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
    name: `${namePrefix} key`,
    permissions: { chat: true, voice: false },
  });
  const channel = await createSdkChannelDetailed(harness, admin.token, admin.projectId, {
    name: `${namePrefix}-${uniqueSlug('channel')}`,
    channelType: 'web',
    publicApiKeyId: key.id,
    deploymentId: deployment.id,
    config: {
      sdkTokenEnvelopePolicy: policy,
      allowedOrigins: ['https://allowed.example'],
    },
    auth: {
      mode: 'hosted_exchange',
    },
  });

  expect(channel.serverSecret).toBeTruthy();
  return {
    channelId: channel.channel.id,
    serverSecret: channel.serverSecret!,
  };
}

async function createSensitiveCustomerSession(
  fixture: HostedExchangeFixture,
): Promise<SdkCustomerSessionJweResult> {
  const response = await requestJson<SdkCustomerSessionJweResult>(
    harness,
    '/api/v1/sdk/customer-sessions',
    {
      method: 'POST',
      headers: {
        'X-SDK-Channel-Secret': fixture.serverSecret,
      },
      body: {
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelId: fixture.channelId,
        verifiedUserId: SENSITIVE_VERIFIED_USER_ID,
        customAttributes: {
          policyId: SENSITIVE_POLICY_ID,
          plan: 'platinum',
        },
      },
    },
  );

  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.bootstrapToken).toBeTruthy();
  return response.body;
}

async function initFromBootstrap(bootstrapToken: string): Promise<SdkInitJweResult> {
  const response = await requestJson<SdkInitJweResult>(harness, '/api/v1/sdk/init', {
    method: 'POST',
    headers: {
      Origin: 'https://allowed.example',
    },
    body: { bootstrapToken },
  });

  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.token).toBeTruthy();
  return response.body;
}

beforeAll(async () => {
  mockLlm = await startMockLLM();
  harness = await startRuntimeServerHarness({}, { autoIndex: false });
  admin = await bootstrapProject(
    harness,
    uniqueEmail('sdk-jwe-admin'),
    uniqueSlug('tenant-sdk-jwe'),
    uniqueSlug('project-sdk-jwe'),
  );
  deployment = await provisionBasicAgentProject(
    harness,
    admin.token,
    admin.tenantId,
    admin.projectId,
    mockLlm.url,
    'sdk_jwe_test_agent',
  );
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  if (harness) {
    await harness.close();
  }
  if (mockLlm) {
    await mockLlm.close();
  }
}, SUITE_TIMEOUT_MS);

afterEach(() => {
  resetHybridRateLimiter();
});

describe('ABLP-862 hosted_exchange JWE E2E acceptance scenarios', () => {
  test(
    JWE_E2E_SCENARIO_COVERAGE.encrypted_lifecycle,
    async () => {
      const fixture = await createHostedExchangeFixture('jwe_required', 'encrypted-lifecycle');
      const customerSession = await createSensitiveCustomerSession(fixture);

      expect(customerSession.tokenEnvelope).toBe('jwe');
      expectCompactJwe(customerSession.bootstrapToken, 'bootstrapToken');
      expectSensitiveValuesHidden(customerSession.bootstrapToken);

      const sdkSession = await initFromBootstrap(customerSession.bootstrapToken);
      expect(sdkSession.tokenEnvelope).toBe('jwe');
      expectCompactJwe(sdkSession.token, 'SDK session token');
      expectSensitiveValuesHidden(sdkSession.token);

      const refreshed = await requestJson<SdkInitJweResult>(harness, '/api/v1/sdk/refresh', {
        method: 'POST',
        headers: sdkHeaders(sdkSession.token),
        body: {},
      });
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      expect(refreshed.body.tokenEnvelope).toBe('jwe');
      expectCompactJwe(refreshed.body.token, 'refreshed SDK session token');

      const sessions = await requestJson<{ success: boolean; sessions: Array<unknown> }>(
        harness,
        `/api/projects/${admin.projectId}/sessions`,
        {
          method: 'GET',
          headers: sdkHeaders(refreshed.body.token),
        },
      );
      expect(sessions.status, JSON.stringify(sessions.body)).toBe(200);
      expect(sessions.body.success).toBe(true);

      const ws = new NodeWebSocket(
        `${harness.baseUrl.replace(/^http/, 'ws')}/ws/sdk`,
        buildSdkWSProtocols(refreshed.body.token),
      );
      try {
        const sessionStart = await waitForSocketMessage(
          ws,
          (message) => message.type === 'session_start',
          'session_start',
        );
        expect(sessionStart.sessionId).toEqual(expect.any(String));
      } finally {
        ws.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.tamper_rejected,
    async () => {
      const fixture = await createHostedExchangeFixture('jwe_required', 'tamper-rejected');
      const customerSession = await createSensitiveCustomerSession(fixture);
      expectCompactJwe(customerSession.bootstrapToken, 'bootstrapToken');
      const sdkSession = await initFromBootstrap(customerSession.bootstrapToken);
      expectCompactJwe(sdkSession.token, 'SDK session token');

      const tamperedBootstrap = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
        method: 'POST',
        body: { bootstrapToken: tamperCompactToken(customerSession.bootstrapToken) },
      });
      expect(tamperedBootstrap.status).toBe(401);

      const tamperedSession = await requestJson<{ error: string }>(harness, '/api/v1/sdk/refresh', {
        method: 'POST',
        headers: sdkHeaders(tamperCompactToken(sdkSession.token)),
        body: {},
      });
      expect(tamperedSession.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.strict_policy_rejects_signed,
    async () => {
      const fixture = await createHostedExchangeFixture('jwe_required', 'manual-signed');
      const legacySignedBootstrap = signSdkBootstrapArtifact(
        {
          type: 'customer',
          tenantId: admin.tenantId,
          projectId: admin.projectId,
          channelId: fixture.channelId,
          verifiedUserId: 'manual-signed-user',
          channelArtifact: 'manual-channel-artifact',
          jti: 'manual-jti',
          exp: Date.now() + 60_000,
          permissions: ['session:send_message', 'session:read'],
        },
        TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET,
      );

      const response = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
        method: 'POST',
        body: { bootstrapToken: legacySignedBootstrap },
      });
      expect(response.status).toBe(401);

      const legacySignedSdkSession = signSDKSessionToken(
        {
          type: 'sdk_session',
          tenantId: admin.tenantId,
          projectId: admin.projectId,
          deploymentId: deployment.id,
          channelId: fixture.channelId,
          sessionId: 'strict-signed-session',
          sessionPrincipal: 'strict-signed-principal',
          permissions: ['session:read', 'session:send_message'],
          verifiedUserId: 'manual-signed-user',
          identityTier: 2,
          verificationMethod: 'server_secret',
          authScope: 'user',
          bootstrapType: 'customer',
        },
        TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET,
        { expiresIn: '5m' },
      );

      const refresh = await requestJson<{ error: string }>(harness, '/api/v1/sdk/refresh', {
        method: 'POST',
        headers: sdkHeaders(legacySignedSdkSession),
        body: {},
      });
      expect(refresh.status).toBe(401);

      const sessions = await requestJson<{ error: string }>(
        harness,
        `/api/projects/${admin.projectId}/sessions`,
        {
          method: 'GET',
          headers: sdkHeaders(legacySignedSdkSession),
        },
      );
      expect(sessions.status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.preferred_policy_legacy_compat,
    async () => {
      const fixture = await createHostedExchangeFixture('signed', 'preferred-compat');
      const legacyCustomerSession = await createSdkCustomerSession(harness, {
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        channelId: fixture.channelId,
        channelSecret: fixture.serverSecret,
        verifiedUserId: 'rollback-compat-user',
      });
      const legacySdkSession = await initFromBootstrap(legacyCustomerSession.bootstrapToken);

      await updateSdkChannel(harness, admin.token, admin.projectId, fixture.channelId, {
        config: { sdkTokenEnvelopePolicy: 'jwe_preferred' },
      });

      const signedRefreshCompat = await requestJson<SdkInitResult>(harness, '/api/v1/sdk/refresh', {
        method: 'POST',
        headers: sdkHeaders(legacySdkSession.token),
        body: {},
      });
      expect(signedRefreshCompat.status, JSON.stringify(signedRefreshCompat.body)).toBe(200);
      expect(signedRefreshCompat.body.channelId).toBe(fixture.channelId);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.public_key_compat,
    async () => {
      const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
        name: 'public-key-compat',
        permissions: { chat: true, voice: false },
      });
      await createSdkChannelDetailed(harness, admin.token, admin.projectId, {
        name: `public-key-${uniqueSlug('channel')}`,
        channelType: 'web',
        publicApiKeyId: key.id,
        deploymentId: deployment.id,
        config: { sdkTokenEnvelopePolicy: 'jwe_required' },
        auth: { mode: 'anonymous' },
      });

      const sdkSession = await requestJson<SdkInitJweResult>(harness, '/api/v1/sdk/init', {
        method: 'POST',
        body: { userContext: { userId: 'public-key-user' } },
        headers: { 'X-Public-Key': key.key! },
      });

      expect(sdkSession.status, JSON.stringify(sdkSession.body)).toBe(200);
      expect(sdkSession.body.tokenEnvelope ?? 'signed').toBe('signed');
      expect(tokenSegmentCount(sdkSession.body.token)).toBe(3);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.oversize_rejected,
    async () => {
      const fixture = await createHostedExchangeFixture('jwe_required', 'oversize');
      const response = await requestJson<{ error?: string; success?: boolean }>(
        harness,
        '/api/v1/sdk/customer-sessions',
        {
          method: 'POST',
          headers: {
            'X-SDK-Channel-Secret': fixture.serverSecret,
          },
          body: {
            tenantId: admin.tenantId,
            projectId: admin.projectId,
            channelId: fixture.channelId,
            verifiedUserId: 'oversize-user',
            customAttributes: {
              policyBlob: 'x'.repeat(3_800),
            },
          },
        },
      );

      expect(response.status).toBe(413);
      expect(JSON.stringify(response.body)).toMatch(/token.*size|too large|budget/i);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.diagnostics_guarded,
    async () => {
      const fixture = await createHostedExchangeFixture('jwe_required', 'diagnostics');
      const customerSession = await createSensitiveCustomerSession(fixture);
      expectCompactJwe(customerSession.bootstrapToken, 'bootstrapToken');

      const unauthenticated = await requestJson<{ error?: string }>(
        harness,
        `/api/projects/${admin.projectId}/sdk-token-diagnostics`,
        {
          method: 'POST',
          body: { token: customerSession.bootstrapToken },
        },
      );
      expect(unauthenticated.status).toBe(401);

      const privileged = await requestJson<{
        success: boolean;
        envelope: TokenEnvelope;
        claims?: unknown;
      }>(harness, `/api/projects/${admin.projectId}/sdk-token-diagnostics`, {
        method: 'POST',
        headers: authHeaders(admin.token),
        body: { token: customerSession.bootstrapToken },
      });
      expect(privileged.status, JSON.stringify(privileged.body)).toBe(200);
      expect(privileged.body.success).toBe(true);
      expect(privileged.body.envelope).toBe('jwe');
      expect(privileged.body.claims).toBeUndefined();
      expect(JSON.stringify(privileged.body)).not.toContain(SENSITIVE_POLICY_ID);
      expect(JSON.stringify(privileged.body)).not.toContain(SENSITIVE_VERIFIED_USER_ID);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.project_default_inheritance,
    async () => {
      await setProjectHostedExchangePolicy('jwe_required');
      try {
        const key = await createSdkPublicKey(harness, admin.token, admin.projectId, {
          name: 'project-default-jwe-key',
          permissions: { chat: true, voice: false },
        });
        const channel = await createSdkChannelDetailed(harness, admin.token, admin.projectId, {
          name: `project-default-${uniqueSlug('channel')}`,
          channelType: 'web',
          publicApiKeyId: key.id,
          deploymentId: deployment.id,
          config: {
            allowedOrigins: ['https://allowed.example'],
          },
          auth: {
            mode: 'hosted_exchange',
          },
        });

        const customerSession = await createSensitiveCustomerSession({
          channelId: channel.channel.id,
          serverSecret: channel.serverSecret!,
        });
        expect(customerSession.tokenEnvelope).toBe('jwe');
        expectCompactJwe(customerSession.bootstrapToken, 'project default bootstrapToken');

        const sdkSession = await initFromBootstrap(customerSession.bootstrapToken);
        expect(sdkSession.tokenEnvelope).toBe('jwe');
        expectCompactJwe(sdkSession.token, 'project default SDK session token');
      } finally {
        await setProjectHostedExchangePolicy(null);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.signed_channel_override,
    async () => {
      await setProjectHostedExchangePolicy('jwe_required');
      try {
        const fixture = await createHostedExchangeFixture('signed', 'signed-channel-override');
        const customerSession = await createSensitiveCustomerSession(fixture);

        expect(customerSession.tokenEnvelope ?? 'signed').toBe('signed');
        expect(tokenSegmentCount(customerSession.bootstrapToken)).not.toBe(5);

        const sdkSession = await initFromBootstrap(customerSession.bootstrapToken);
        expect(sdkSession.tokenEnvelope ?? 'signed').toBe('signed');
        expect(tokenSegmentCount(sdkSession.token)).toBe(3);
      } finally {
        await setProjectHostedExchangePolicy(null);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.preferred_refresh_preserves_existing_jwe,
    async () => {
      const fixture = await createHostedExchangeFixture('jwe_required', 'preferred-jwe-refresh');
      const customerSession = await createSensitiveCustomerSession(fixture);
      const sdkSession = await initFromBootstrap(customerSession.bootstrapToken);
      expect(sdkSession.tokenEnvelope).toBe('jwe');
      expectCompactJwe(sdkSession.token, 'preference rollback source SDK session');

      await updateSdkChannel(harness, admin.token, admin.projectId, fixture.channelId, {
        config: { sdkTokenEnvelopePolicy: 'jwe_preferred' },
      });

      const refreshed = await requestJson<SdkInitJweResult>(harness, '/api/v1/sdk/refresh', {
        method: 'POST',
        headers: sdkHeaders(sdkSession.token),
        body: {},
      });
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      expect(refreshed.body.tokenEnvelope).toBe('jwe');
      expectCompactJwe(refreshed.body.token, 'preferred refreshed SDK session');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.session_transport_budget_rejected,
    async () => {
      const oversizedToken = createOversizedJweShapedToken();
      expect(oversizedToken.length).toBeGreaterThan(4096);

      const refresh = await requestJson<{ error?: string }>(harness, '/api/v1/sdk/refresh', {
        method: 'POST',
        headers: sdkHeaders(oversizedToken),
        body: {},
      });
      expect([400, 413]).toContain(refresh.status);
      expect(JSON.stringify(refresh.body)).toMatch(/size|too large|budget/i);

      const ws = new NodeWebSocket(
        `${harness.baseUrl.replace(/^http/, 'ws')}/ws/sdk`,
        buildSdkWSProtocols(oversizedToken),
      );
      const closeCode = await waitForSocketClose(ws);
      expect(closeCode).not.toBe(1000);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.diagnostic_oracle_guard,
    async () => {
      const fixture = await createHostedExchangeFixture('jwe_required', 'diagnostic-oracle');
      const customerSession = await createSensitiveCustomerSession(fixture);
      const unknownKidToken = customerSession.bootstrapToken.replace(
        customerSession.bootstrapToken.split('.')[0]!,
        Buffer.from(
          JSON.stringify({
            alg: 'dir',
            enc: 'A256GCM',
            kid: 'unknown-diagnostic-kid',
            typ: 'abl-sdk-bootstrap+jwe',
            cty: 'abl-sdk-bootstrap+jwt',
            epv: 1,
          }),
        ).toString('base64url'),
      );
      const tamperedToken = tamperCompactToken(customerSession.bootstrapToken);

      const unknownKid = await requestJson<Record<string, unknown>>(
        harness,
        `/api/projects/${admin.projectId}/sdk-token-diagnostics`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: { token: unknownKidToken },
        },
      );
      const tampered = await requestJson<Record<string, unknown>>(
        harness,
        `/api/projects/${admin.projectId}/sdk-token-diagnostics`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: { token: tamperedToken },
        },
      );

      expect(unknownKid.status, JSON.stringify(unknownKid.body)).toBe(200);
      expect(tampered.status, JSON.stringify(tampered.body)).toBe(200);
      expect(unknownKid.status).toBe(tampered.status);
      expect(JSON.stringify(unknownKid.body)).toBe(JSON.stringify(tampered.body));
      expect(JSON.stringify(unknownKid.body)).not.toContain('unknown-diagnostic-kid');
      expect(JSON.stringify(tampered.body)).not.toContain(SENSITIVE_VERIFIED_USER_ID);
      expect(JSON.stringify(tampered.body)).not.toContain(SENSITIVE_POLICY_ID);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.signed_rollback_verifies_existing_jwe,
    async () => {
      const fixture = await createHostedExchangeFixture('jwe_required', 'signed-rollback');
      const customerSession = await createSensitiveCustomerSession(fixture);
      const encryptedSession = await initFromBootstrap(customerSession.bootstrapToken);
      expect(encryptedSession.tokenEnvelope).toBe('jwe');
      expectCompactJwe(encryptedSession.token, 'rollback source SDK session');

      await updateSdkChannel(harness, admin.token, admin.projectId, fixture.channelId, {
        config: { sdkTokenEnvelopePolicy: 'signed' },
      });

      const refreshed = await requestJson<SdkInitJweResult>(harness, '/api/v1/sdk/refresh', {
        method: 'POST',
        headers: sdkHeaders(encryptedSession.token),
        body: {},
      });
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      expect(refreshed.body.tokenEnvelope ?? 'signed').toBe('signed');
      expect(tokenSegmentCount(refreshed.body.token)).toBe(3);

      const newCustomerSession = await createSensitiveCustomerSession(fixture);
      expect(newCustomerSession.tokenEnvelope ?? 'signed').toBe('signed');
      expect(tokenSegmentCount(newCustomerSession.bootstrapToken)).not.toBe(5);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.origin_policy_after_decrypt,
    async () => {
      const fixture = await createHostedExchangeFixture('jwe_required', 'origin-after-decrypt');
      const customerSession = await createSensitiveCustomerSession(fixture);
      expectCompactJwe(customerSession.bootstrapToken, 'origin policy bootstrapToken');

      const blocked = await requestJson<{ error: string }>(harness, '/api/v1/sdk/init', {
        method: 'POST',
        headers: {
          Origin: 'https://blocked.example',
        },
        body: { bootstrapToken: customerSession.bootstrapToken },
      });

      expect(blocked.status, JSON.stringify(blocked.body)).toBe(403);
      expect(blocked.body.error).toBe('Origin not allowed');
      expectNoSensitiveResponseLeak(blocked.body);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.response_minimization,
    async () => {
      const fixture = await createHostedExchangeFixture('jwe_required', 'response-minimization');
      const customerSession = await createSensitiveCustomerSession(fixture);
      expect(customerSession.tokenEnvelope).toBe('jwe');
      expectNoSensitiveResponseLeak(customerSession);

      const sdkSession = await initFromBootstrap(customerSession.bootstrapToken);
      expect(sdkSession.tokenEnvelope).toBe('jwe');
      expectNoSensitiveResponseLeak(sdkSession);

      const refreshed = await requestJson<SdkInitJweResult>(harness, '/api/v1/sdk/refresh', {
        method: 'POST',
        headers: sdkHeaders(sdkSession.token),
        body: {},
      });
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      expect(refreshed.body.tokenEnvelope).toBe('jwe');
      expectNoSensitiveResponseLeak(refreshed.body);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    JWE_E2E_SCENARIO_COVERAGE.malformed_jwe_no_fallback,
    async () => {
      const malformedToken = createMalformedJweShapedToken();

      const init = await requestJson<{ error?: string }>(harness, '/api/v1/sdk/init', {
        method: 'POST',
        headers: {
          Origin: 'https://allowed.example',
        },
        body: { bootstrapToken: malformedToken },
      });
      expect(init.status).toBe(401);
      expect(JSON.stringify(init.body)).not.toMatch(/malformed-kid|decrypt|keyring|kid/i);

      const refresh = await requestJson<{ error?: string }>(harness, '/api/v1/sdk/refresh', {
        method: 'POST',
        headers: sdkHeaders(malformedToken),
        body: {},
      });
      expect(refresh.status).toBe(401);
      expect(JSON.stringify(refresh.body)).not.toMatch(/malformed-kid|decrypt|keyring|kid/i);

      const sessions = await requestJson<{ error?: string }>(
        harness,
        `/api/projects/${admin.projectId}/sessions`,
        {
          method: 'GET',
          headers: sdkHeaders(malformedToken),
        },
      );
      expect(sessions.status).toBe(401);
      expect(JSON.stringify(sessions.body)).not.toMatch(/malformed-kid|decrypt|keyring|kid/i);
    },
    TEST_TIMEOUT_MS,
  );
});
