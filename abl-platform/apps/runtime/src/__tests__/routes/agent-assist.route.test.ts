/**
 * Route-level tests for the Agent Assist V1 Compatibility Facade.
 *
 * These tests exercise the full Express router against an injected stub auth
 * middleware + a trivial in-memory UnifiedBindingResolver, covering validation,
 * isolation, disabled bindings, sessions envelope, and callback URL
 * validation. End-to-end execution (real RuntimeExecutor + DeploymentResolver +
 * Mongo) lives in the integration suite under `__tests__/integration/`.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedBindingResolver } from '../../services/agent-assist/binding-resolver.js';
import { createAgentAssistRouter } from '../../routes/agent-assist.js';
import type { AgentAssistBinding } from '../../services/agent-assist/types.js';

type AgentAssistRouterTestOptions = Parameters<typeof createAgentAssistRouter>[0];

const mocks = vi.hoisted(() => ({
  requireProjectPermission: vi.fn(async (req: Request, res: Response, permission: string) => {
    const ctx = (req as Request & { tenantContext?: Record<string, unknown> }).tenantContext;
    const permissions = Array.isArray(ctx?.permissions) ? ctx.permissions : [];
    if (!permissions.includes(permission)) {
      res.status(403).json({
        success: false,
        error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
        required: permission,
      });
      return false;
    }
    return true;
  }),
  resolveProjectAgentAssistEnabled: vi.fn(async () => null as boolean | null),
}));

const defaultExecuteTurn: NonNullable<AgentAssistRouterTestOptions['executeTurn']> = async (
  request,
) => {
  request.onChunk?.('stub response');
  return {
    sessionId: 's-stub-agent-assist',
    runId: request.runId ?? 'run-stub-agent-assist',
    responseText: 'stub response',
    deploymentId: request.binding.deploymentId,
  };
};

const defaultResolveWelcomeText: NonNullable<
  AgentAssistRouterTestOptions['resolveWelcomeTextForBinding']
> = async () => '';

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: mocks.requireProjectPermission,
}));

vi.mock('../../services/agent-assist/feature-gate.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/agent-assist/feature-gate.js')>();
  return {
    ...actual,
    resolveProjectAgentAssistEnabled: mocks.resolveProjectAgentAssistEnabled,
  };
});

function stubResolver(bindings: AgentAssistBinding[]): UnifiedBindingResolver {
  return {
    async resolve(tenantId: string, appId: string, environment: string) {
      const env = environment.toLowerCase();
      for (const b of bindings) {
        if (b.appId === appId && b.environment === env) {
          return b;
        }
      }
      return null;
      // tenantId check is enforced at the route layer, not here
      // (mirrors Mongo resolver behaviour)
      void tenantId;
    },
  };
}

function buildApp(options: {
  tenantId?: string;
  projectScope?: string[];
  authType?: string;
  permissions?: string[];
  bindings?: UnifiedBindingResolver;
  callbackQueue?: { add: (data: unknown) => Promise<unknown> };
  projectEnabled?: boolean | null;
  executeTurn?: AgentAssistRouterTestOptions['executeTurn'];
  resolveWelcomeTextForBinding?: AgentAssistRouterTestOptions['resolveWelcomeTextForBinding'];
}) {
  mocks.resolveProjectAgentAssistEnabled.mockImplementation(
    async () => options.projectEnabled ?? null,
  );
  const app = express();
  const stubAuth = (req: Request, _res: Response, next: NextFunction): void => {
    (req as Request & { tenantContext?: Record<string, unknown> }).tenantContext = {
      tenantId: options.tenantId ?? 'T1',
      userId: 'U1',
      role: options.authType === 'api_key' || !options.authType ? 'api_key' : 'ADMIN',
      authType: options.authType ?? 'api_key',
      apiKeyId: 'ak-1',
      permissions: options.permissions ?? ['session:send_message'],
      ...(options.projectScope ? { projectScope: options.projectScope } : {}),
    };
    next();
  };
  const router = createAgentAssistRouter({
    bindings: options.bindings ?? defaultBindings(),
    authMiddleware: stubAuth,
    skipFeatureGate: true,
    skipRateLimit: true,
    callbackQueue: options.callbackQueue ? () => options.callbackQueue : undefined,
    executeTurn: options.executeTurn ?? defaultExecuteTurn,
    resolveWelcomeTextForBinding: options.resolveWelcomeTextForBinding ?? defaultResolveWelcomeText,
  });
  app.use('/api/v2/apps', router);
  return app;
}

beforeEach(() => {
  mocks.requireProjectPermission.mockClear();
  mocks.resolveProjectAgentAssistEnabled.mockReset();
  mocks.resolveProjectAgentAssistEnabled.mockResolvedValue(null);
});

function defaultBindings(): UnifiedBindingResolver {
  return stubResolver([
    {
      tenantId: 'T1',
      projectId: 'P1',
      appId: 'aa-abc',
      environment: 'dev',
      status: 'active',
    },
  ]);
}

describe('agent-assist — request validation', () => {
  it('returns 400 INVALID_INPUT when sessionIdentity is missing', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        input: [{ type: 'text', content: 'hi' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('async without callbackUrl returns 400 CALLBACK_URL_REQUIRED', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-4' }],
        input: [{ type: 'text', content: 'hi' }],
        isAsync: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CALLBACK_URL_REQUIRED');
  });

  it('async with invalid callbackUrl returns 400 INVALID_CALLBACK_URL', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-5' }],
        input: [{ type: 'text', content: 'hi' }],
        isAsync: true,
        callbackUrl: 'http://10.0.0.1/internal',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CALLBACK_URL');
  });

  it('isAsync+stream.enable without callbackUrl streams via SSE (does not reject)', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-stream' }],
        input: [{ type: 'text', content: 'hi' }],
        isAsync: true,
        stream: { enable: true, streamMode: 'tokens' },
      });
    // Should NOT be a 400 CALLBACK_URL_REQUIRED — stream.enable routes to SSE.
    expect(res.status).not.toBe(400);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });

  it('preserves structured runtime output in the backward-compatible V1 text envelope', async () => {
    const app = buildApp({
      executeTurn: async (executeRequest) => ({
        sessionId: 's-structured',
        runId: executeRequest.runId ?? 'run-structured',
        responseText: '',
        richContent: { markdown: '**Choose a card**' },
        actions: { elements: [{ id: 'choose', type: 'button', label: 'Choose' }] },
        voiceConfig: { plain_text: 'Choose a card.' },
        contentEnvelope: {
          version: 2,
          format: 'message_envelope',
          text: '',
          richContent: { markdown: '**Choose a card**' },
          actions: { elements: [{ id: 'choose', type: 'button', label: 'Choose' }] },
          voiceConfig: { plain_text: 'Choose a card.' },
        },
      }),
    });

    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-structured' }],
        input: [{ type: 'text', content: 'show options' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.output[0]).toMatchObject({
      type: 'text',
      content: '',
      richContent: { markdown: '**Choose a card**' },
      actions: { elements: [{ id: 'choose', type: 'button', label: 'Choose' }] },
      voiceConfig: { plain_text: 'Choose a card.' },
      contentEnvelope: {
        version: 2,
        format: 'message_envelope',
        richContent: { markdown: '**Choose a card**' },
      },
    });
  });
});

describe('agent-assist — isolation & 404 semantics', () => {
  it('unknown appId → 404 APP_NOT_FOUND', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-unknown/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-1' }],
        input: [{ type: 'text', content: 'hi' }],
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('APP_NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toMatch(/T1|P1/);
  });

  it('cross-tenant request → 404 APP_NOT_FOUND (never 403)', async () => {
    const app = buildApp({ tenantId: 'T2' });
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-1' }],
        input: [{ type: 'text', content: 'hi' }],
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('APP_NOT_FOUND');
  });

  it('cross-project request (projectScope excludes binding projectId) → 404', async () => {
    const app = buildApp({ projectScope: ['P2'] });
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-1' }],
        input: [{ type: 'text', content: 'hi' }],
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('APP_NOT_FOUND');
  });

  it('disabled binding → 404 APP_NOT_FOUND (existence-disclosure invariant — same envelope as missing binding)', async () => {
    const bindings = stubResolver([
      {
        tenantId: 'T1',
        projectId: 'P1',
        appId: 'aa-dis',
        environment: 'dev',
        status: 'disabled',
      },
    ]);
    const app = buildApp({ bindings });
    const res = await request(app)
      .post('/api/v2/apps/aa-dis/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-1' }],
        input: [{ type: 'text', content: 'hi' }],
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('APP_NOT_FOUND');
  });

  it('project-level disable still hides legacy app bindings as 404', async () => {
    const app = buildApp({
      projectEnabled: false,
      bindings: stubResolver([
        {
          tenantId: 'T1',
          projectId: 'P1',
          appId: 'legacy-aa-app',
          environment: 'dev',
          status: 'active',
        },
      ]),
    });

    const res = await request(app)
      .post('/api/v2/apps/legacy-aa-app/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-1' }],
        input: [{ type: 'text', content: 'hi' }],
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('APP_NOT_FOUND');
  });
});

describe('agent-assist — auth contract', () => {
  it('rejects non-api-key callers with 401 API_KEY_REQUIRED', async () => {
    const app = buildApp({ authType: 'jwt' });
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-auth' }],
        input: [{ type: 'text', content: 'hi' }],
      });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('API_KEY_REQUIRED');
  });

  it('rejects API keys that lack session:send_message', async () => {
    const app = buildApp({ permissions: [] });
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-authz' }],
        input: [{ type: 'text', content: 'hi' }],
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_REQUIRED');
  });
});

describe('agent-assist — sessions', () => {
  it('POST /sessions creates a session envelope (no Welcome_Event when isSendWelcomeMessage is false)', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/sessions')
      .send({ sessionIdentity: [{ type: 'sessionReference', value: 'conv-x' }] });
    expect(res.status).toBe(200);
    expect(res.body.session).toBeDefined();
    expect(res.body.session.sessionId).toMatch(/^s-/);
    expect(res.body.session.userId).toMatch(/^u-/);
    expect(res.body.session.status).toBe('idle');
    expect(res.body.events).toEqual([]);
    expect(res.body.output).toEqual([]);
    expect(res.body.allowedMimeTypes).toBeInstanceOf(Array);
    expect(res.body.fileUploadConfig).toBeDefined();
  });

  it('POST /sessions emits an empty Welcome_Event when isSendWelcomeMessage is true (FR-8)', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/sessions')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-y' }],
        metadata: { isSendWelcomeMessage: true },
      });
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toEqual({
      type: 'Welcome_Event',
      content: { messageToUser: '' },
    });
    expect(res.body.output).toEqual([{ type: 'text', content: '' }]);
  });

  it('POST /sessions/terminate returns terminate response', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/sessions/terminate')
      .send({ sessionIdentity: [{ type: 'sessionId', value: 's-test-session' }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('terminated');
    expect(res.body.appId).toBe('aa-abc');
  });

  it('POST /sessions/terminate accepts sessionIdentity as the canonical session id alias', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/sessions/terminate')
      .send({ sessionIdentity: [{ type: 'sessionIdentity', value: 's-test-session' }] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('terminated');
    expect(res.body.sessionId).toBe('s-test-session');
  });
});

describe('agent-assist — async callback queueing', () => {
  it('returns 202 and enqueues async callback jobs when the callback queue is available', async () => {
    const add = vi.fn(async () => undefined);
    const app = buildApp({
      callbackQueue: { add },
    });

    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [
          { type: 'sessionReference', value: 'conv-queued' },
          { type: 'userReference', value: 'user-queued' },
        ],
        input: [{ type: 'text', content: 'queue this' }],
        isAsync: true,
        callbackUrl: 'https://example.com/callback',
        metadata: { locale: 'en-US' },
      });

    expect(res.status).toBe(202);
    expect(res.body.sessionInfo.status).toBe('processing');
    expect(add).toHaveBeenCalledOnce();
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'T1',
      projectId: 'P1',
      appId: 'aa-abc',
      envName: 'dev',
      callbackUrl: 'https://example.com/callback',
      input: {
        executionInput: {
          userMessage: 'queue this',
          sessionReference: 'conv-queued',
          messageMetadata: { locale: 'en-US' },
        },
        userReference: 'user-queued',
        callerApiKeyId: 'ak-1',
      },
    });
  });
});

describe('agent-assist — callback URL validation', () => {
  it('rejects loopback addresses', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-1' }],
        input: [{ type: 'text', content: 'hi' }],
        isAsync: true,
        callbackUrl: 'https://127.0.0.1/callback',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CALLBACK_URL');
  });

  it('rejects RFC1918 private IPs', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-1' }],
        input: [{ type: 'text', content: 'hi' }],
        isAsync: true,
        callbackUrl: 'https://192.168.1.1/callback',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CALLBACK_URL');
  });

  it('rejects non-HTTPS schemes (except http://localhost)', async () => {
    const app = buildApp({});
    const res = await request(app)
      .post('/api/v2/apps/aa-abc/environments/dev/runs/execute')
      .send({
        sessionIdentity: [{ type: 'sessionReference', value: 'conv-1' }],
        input: [{ type: 'text', content: 'hi' }],
        isAsync: true,
        callbackUrl: 'ftp://example.com/callback',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CALLBACK_URL');
  });
});
