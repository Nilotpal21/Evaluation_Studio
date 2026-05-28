import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoadServiceChangeCompatibility = vi.fn();
const mockPlatformAdminAuthMiddleware = vi.fn((_req: unknown, _res: unknown, next: () => void) =>
  next(),
);
const mockRequirePlatformAdminMiddleware = vi.fn((_req: unknown, _res: unknown, next: () => void) =>
  next(),
);
const mockRequirePlatformAdminIpMiddleware = vi.fn(
  (_req: unknown, _res: unknown, next: () => void) => next(),
);
const mockGetConfig = vi.fn();
const mockGetCurrentRequestId = vi.fn();
const mockGetServiceUrl = vi.fn();
const mockIsServiceConfigured = vi.fn();

const ORIGINAL_GIT_SHA = process.env.GIT_SHA;
const ORIGINAL_DEPLOY_ID = process.env.DEPLOY_ID;
const ORIGINAL_DEPLOYMENT_ENVIRONMENT = process.env.DEPLOYMENT_ENVIRONMENT;
const ORIGINAL_PACKAGE_VERSION = process.env.npm_package_version;

vi.mock('mongoose', () => ({
  default: {
    connection: {
      readyState: 1,
      db: {},
    },
  },
}));

vi.mock('@agent-platform/database', () => ({
  loadServiceChangeCompatibility: (...args: unknown[]) =>
    mockLoadServiceChangeCompatibility(...args),
}));

vi.mock('../change-management/requirements.js', () => ({
  getRuntimeChangeRequirement: vi.fn(() => ({
    service: 'runtime',
    environment: 'staging',
    enforcementMode: 'soft_ready',
    requiredChangeIds: ['seed.platform-core'],
    optionalChangeIds: [],
  })),
}));

vi.mock('../middleware/auth.js', () => ({
  platformAdminAuthMiddleware: (...args: unknown[]) => mockPlatformAdminAuthMiddleware(...args),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requirePlatformAdmin: vi.fn(
    () =>
      (...args: unknown[]) =>
        mockRequirePlatformAdminMiddleware(...args),
  ),
  requirePlatformAdminIp: vi.fn(
    () =>
      (...args: unknown[]) =>
        mockRequirePlatformAdminIpMiddleware(...args),
  ),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: (...args: unknown[]) => mockGetCurrentRequestId(...args),
}));

vi.mock('../config/index.js', () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../health/service-registry.js', () => ({
  SERVICE_REGISTRY: [
    {
      id: 'runtime',
      name: 'Runtime',
      group: 'agent-execution',
      description: 'Core runtime service',
      port: 3112,
      healthPath: '/health',
      checkMethod: 'self',
    },
    {
      id: 'search-ai',
      name: 'SearchAI',
      group: 'search-knowledge',
      description: 'Search service',
      port: 3113,
      healthPath: '/health',
      checkMethod: 'http',
      envVar: 'SEARCH_AI_URL',
    },
    {
      id: 'opensearch',
      name: 'OpenSearch',
      group: 'search-knowledge',
      description: 'Search index',
      port: 9200,
      healthPath: '/_cluster/health',
      checkMethod: 'http',
      envVar: 'OPENSEARCH_URL',
    },
  ],
  getServiceUrl: (...args: unknown[]) => mockGetServiceUrl(...args),
  isServiceConfigured: (...args: unknown[]) => mockIsServiceConfigured(...args),
}));

import platformAdminHealthRouter from '../routes/platform-admin-health.js';

function createApp() {
  const app = express();
  app.use('/api/platform/admin/system-health', platformAdminHealthRouter);
  return app;
}

describe('Platform admin system health route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadServiceChangeCompatibility.mockResolvedValue({
      service: 'runtime',
      environment: 'staging',
      enforcementMode: 'soft_ready',
      outcome: 'not_ready',
      ready: false,
      shouldExit: false,
      checkedAt: new Date().toISOString(),
      checkedChangeIds: ['seed.platform-core'],
      blockingIssues: [
        {
          changeId: 'seed.platform-core',
          severity: 'blocking',
          status: 'missing',
          reason: 'missing',
          message: 'seed.platform-core is missing from change history.',
        },
      ],
      warningIssues: [],
    });
    mockGetConfig.mockReturnValue({
      security: {
        platformAdminAllowedIps: ['127.0.0.1'],
      },
    });
    mockGetCurrentRequestId.mockReturnValue('req-health-1');
    mockGetServiceUrl.mockImplementation(
      (def: { id: string }) => `http://${encodeURIComponent(def.id)}.example.internal`,
    );
    mockIsServiceConfigured.mockReturnValue(true);

    process.env.GIT_SHA = 'runtime1234567890';
    process.env.DEPLOY_ID = 'deploy-runtime-1';
    process.env.DEPLOYMENT_ENVIRONMENT = 'staging';
    delete process.env.npm_package_version;
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    if (ORIGINAL_GIT_SHA === undefined) {
      delete process.env.GIT_SHA;
    } else {
      process.env.GIT_SHA = ORIGINAL_GIT_SHA;
    }

    if (ORIGINAL_DEPLOY_ID === undefined) {
      delete process.env.DEPLOY_ID;
    } else {
      process.env.DEPLOY_ID = ORIGINAL_DEPLOY_ID;
    }

    if (ORIGINAL_DEPLOYMENT_ENVIRONMENT === undefined) {
      delete process.env.DEPLOYMENT_ENVIRONMENT;
    } else {
      process.env.DEPLOYMENT_ENVIRONMENT = ORIGINAL_DEPLOYMENT_ENVIRONMENT;
    }

    if (ORIGINAL_PACKAGE_VERSION === undefined) {
      delete process.env.npm_package_version;
    } else {
      process.env.npm_package_version = ORIGINAL_PACKAGE_VERSION;
    }
  });

  it('returns build metadata for self and HTTP services when the health payload exposes it', async () => {
    const mockFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url.includes('search-ai.example.internal')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            service: 'search-ai',
            build: {
              environment: 'staging',
              deployId: 'deploy-search-2',
              codeVersion: 'searchabcdef123456',
              commitSha: 'searchabcdef123456',
              packageVersion: null,
              versionSource: 'git_sha',
            },
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          },
        );
      }

      return new Response(JSON.stringify({ status: 'green' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    });

    vi.stubGlobal('fetch', mockFetch);

    const response = await request(createApp())
      .get('/api/platform/admin/system-health')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.summary.total).toBe(3);

    const runtime = response.body.services.find(
      (service: { id?: string }) => service.id === 'runtime',
    );
    expect(runtime.build).toEqual({
      environment: 'staging',
      deployId: 'deploy-runtime-1',
      codeVersion: 'runtime1234567890',
      commitSha: 'runtime1234567890',
      packageVersion: null,
      versionSource: 'git_sha',
    });

    const searchAi = response.body.services.find(
      (service: { id?: string }) => service.id === 'search-ai',
    );
    expect(searchAi.build).toEqual({
      environment: 'staging',
      deployId: 'deploy-search-2',
      codeVersion: 'searchabcdef123456',
      commitSha: 'searchabcdef123456',
      packageVersion: null,
      versionSource: 'git_sha',
    });

    const opensearch = response.body.services.find(
      (service: { id?: string }) => service.id === 'opensearch',
    );
    expect(opensearch.build).toBeUndefined();
    expect(response.body.changeManagement).toMatchObject({
      outcome: 'not_ready',
      blockingIssues: [
        {
          changeId: 'seed.platform-core',
          reason: 'missing',
        },
      ],
    });
    expect(response.body.summary.changeManagementBlockers).toBe(1);
    expect(response.body.summary.changeManagementWarnings).toBe(0);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
