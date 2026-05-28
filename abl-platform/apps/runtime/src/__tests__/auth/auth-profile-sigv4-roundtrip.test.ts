/**
 * SigV4 End-to-End Round-Trip Test
 *
 * Wires the full aws_iam credential pipeline in a single flow:
 *   resolveByName (stubbed at the relative seam) → resolveToolAuth (real)
 *   → createAuthProfileToolMiddleware (real) → HttpToolExecutor (real)
 *   → safeFetch (real) → loopback HTTP server
 *
 * Each layer is covered by isolated unit tests; this test ensures the
 * handoff contracts between all three hold together — specifically that
 * sigv4_auth injected by the middleware is consumed and signed by the
 * executor before the request leaves the process.
 *
 * No platform-package (`@agent-platform/*`, `@abl/*`) modules are mocked —
 * the outbound HTTP request is captured by a real loopback server reached
 * through `safeFetch` with `allowLocalhost: true`. See CLAUDE.md
 * "Test Architecture".
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ToolCallContext, ToolCallResult } from '@abl/compiler';

// ─── Mocks (hoisted before any imports) ──────────────────────────────────────

const mockResolveByName = vi.fn();

// Mock the runtime resolver at its relative-path seam rather than the DB model
// layer, so the test does not pull in an internal @agent-platform/* mock.
vi.mock('../../services/auth-profile-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth-profile-resolver.js')>();
  return {
    ...actual,
    resolveByName: (...args: unknown[]) => mockResolveByName(...args),
  };
});

vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  isRedisAvailable: () => false,
  getAuthProfileCache: vi.fn(),
  resolveAuthProfileCredentials: vi.fn(),
}));

vi.mock('../../services/tool-oauth-service-singleton.js', () => ({
  getToolOAuthService: () => ({
    getAccessToken: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ─── SUT — real implementations, no platform package mocked ──────────────────

import { createAuthProfileToolMiddleware } from '../../services/auth-profile/auth-profile-tool-middleware.js';
import { HttpToolExecutor } from '@abl/compiler';
import type { ToolDefinition } from '@abl/compiler';
import type { SecretsProvider } from '@abl/compiler';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeAwsIamProfile(overrides: Record<string, unknown> = {}) {
  // Shape matches AuthProfileCredentials (the result of resolveByName), not
  // the encrypted Mongo document. resolveByName already decrypts secrets.
  return {
    profileId: 'profile-aws-s3',
    name: 'aws-s3-profile',
    authType: 'aws_iam',
    projectId: null,
    environment: null,
    visibility: 'shared',
    createdBy: 'user-default',
    config: { region: 'us-east-1', service: 's3' },
    secrets: {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'AQoXnyc4lcK4w3zDM6/exampleSessionToken==',
    },
    ...overrides,
  };
}

const noopSecrets: SecretsProvider = {
  async getSecret() {
    return undefined;
  },
  async getEnvVar() {
    return undefined;
  },
};

// ─── Loopback server fixture ─────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

let server: Server;
let serverUrl: string;
let capturedRequests: CapturedRequest[] = [];

function readRequestHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      out[name] = value;
    } else if (Array.isArray(value)) {
      out[name] = value.join(',');
    }
  }
  return out;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    capturedRequests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: readRequestHeaders(req),
    });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function makeS3Tool(): ToolDefinition {
  return {
    name: 's3-get',
    description: 'S3 object fetch',
    parameters: [],
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'slow',
      parallelizable: false,
      side_effects: false,
      requires_auth: false,
    },
    tool_type: 'http',
    auth_profile_ref: 'aws-s3-profile',
    http_binding: {
      endpoint: `${serverUrl}/key`,
      method: 'GET',
      auth: { type: 'none' },
      headers: {},
    },
  } as unknown as ToolDefinition;
}

function makeExecutor(tool: ToolDefinition): HttpToolExecutor {
  return new HttpToolExecutor({
    tools: [tool],
    secrets: noopSecrets,
    // Required so safeFetch's SSRF protection lets the loopback request through.
    allowLocalhost: true,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SigV4 round-trip: resolveToolAuth → middleware → HttpToolExecutor', () => {
  beforeEach(() => {
    capturedRequests = [];
    vi.clearAllMocks();
    mockResolveByName.mockResolvedValue(makeAwsIamProfile());
  });

  afterEach(() => {
    capturedRequests = [];
  });

  it('resolves aws_iam credentials and signs the outbound request with SigV4', async () => {
    const middleware = createAuthProfileToolMiddleware({ tenantId: 'tenant-1' });
    const tool = makeS3Tool();

    await middleware(
      { toolName: 's3-get', params: {}, timeoutMs: 10_000, tool } as ToolCallContext,
      async (ctx: ToolCallContext): Promise<ToolCallResult> => {
        const executor = makeExecutor(ctx.tool as ToolDefinition);
        const result = await executor.execute('s3-get', {}, 10_000);
        return { result };
      },
    );

    expect(capturedRequests).toHaveLength(1);
    const headers = capturedRequests[0].headers;
    const authHeader = headers['authorization'] ?? headers['Authorization'] ?? '';

    expect(authHeader).toMatch(/^AWS4-HMAC-SHA256/);
    expect(headers['x-amz-date'] ?? headers['X-Amz-Date']).toBeTruthy();
    expect(headers['x-amz-security-token'] ?? headers['X-Amz-Security-Token']).toBe(
      'AQoXnyc4lcK4w3zDM6/exampleSessionToken==',
    );
  });

  it('includes the correct AWS service and region in the Authorization credential scope', async () => {
    const middleware = createAuthProfileToolMiddleware({ tenantId: 'tenant-1' });
    const tool = makeS3Tool();

    await middleware(
      { toolName: 's3-get', params: {}, timeoutMs: 10_000, tool } as ToolCallContext,
      async (ctx: ToolCallContext): Promise<ToolCallResult> => {
        const executor = makeExecutor(ctx.tool as ToolDefinition);
        const result = await executor.execute('s3-get', {}, 10_000);
        return { result };
      },
    );

    expect(capturedRequests).toHaveLength(1);
    const headers = capturedRequests[0].headers;
    const authHeader = headers['authorization'] ?? headers['Authorization'] ?? '';

    // Credential scope is: <accessKeyId>/<date>/<region>/<service>/aws4_request
    expect(authHeader).toContain('us-east-1/s3/aws4_request');
    expect(authHeader).toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('defaults aws_iam service to execute-api when the service field is omitted', async () => {
    mockResolveByName.mockResolvedValue(
      makeAwsIamProfile({ config: { region: 'us-east-1' } /* service omitted */ }),
    );

    const middleware = createAuthProfileToolMiddleware({ tenantId: 'tenant-1' });
    const tool = makeS3Tool();

    await middleware(
      { toolName: 's3-get', params: {}, timeoutMs: 10_000, tool } as ToolCallContext,
      async (ctx: ToolCallContext): Promise<ToolCallResult> => {
        const executor = makeExecutor(ctx.tool as ToolDefinition);
        const result = await executor.execute('s3-get', {}, 10_000);
        return { result };
      },
    );

    expect(capturedRequests).toHaveLength(1);
    const headers = capturedRequests[0].headers;
    const authHeader = headers['authorization'] ?? headers['Authorization'] ?? '';
    expect(authHeader).toContain('us-east-1/execute-api/aws4_request');
  });

  it('fails closed when aws_iam profile has no credentials in secrets', async () => {
    mockResolveByName.mockResolvedValue(makeAwsIamProfile({ secrets: {} }));

    const middleware = createAuthProfileToolMiddleware({ tenantId: 'tenant-1' });
    const tool = makeS3Tool();

    await expect(
      middleware(
        { toolName: 's3-get', params: {}, timeoutMs: 10_000, tool } as ToolCallContext,
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_PROFILE_VALIDATION_FAILED',
      message: expect.stringContaining('missing region or access key credentials'),
    });

    expect(capturedRequests).toHaveLength(0);
  });
});
