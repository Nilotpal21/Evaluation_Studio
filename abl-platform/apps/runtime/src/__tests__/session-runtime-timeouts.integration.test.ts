import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import { createRuntimeSession } from '../channels/pipeline/session-factory.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  bootstrapProject,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';

const BASE_AGENT_DSL = `AGENT: RuntimeTimeoutAgent

GOAL: "Handle runtime timeout tests"

PERSONA: "Helpful assistant"
`;

const AGENT_TIMEOUT_DSL = `AGENT: RuntimeTimeoutAgent

GOAL: "Handle runtime timeout tests"

EXECUTION:
  session_idle_timeout: 56000
`;

describe('Session Runtime Timeouts Integration', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
    });
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);

    const { ProjectAgent, ProjectSettings } = await import('@agent-platform/database/models');
    await Promise.all([ProjectAgent.deleteMany({}), ProjectSettings.deleteMany({})]);
  });

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  test('createRuntimeSession applies project runtime overrides to the created runtime session', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('runtime-timeout-int-project'),
      uniqueSlug('runtime-timeout-int-tenant-project'),
      uniqueSlug('runtime-timeout-int-project-project'),
    );

    const { ProjectAgent, ProjectSettings } = await import('@agent-platform/database/models');
    await Promise.all([
      ProjectAgent.create({
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        name: 'RuntimeTimeoutAgent',
        agentPath: `${admin.projectId}/RuntimeTimeoutAgent`,
        dslContent: BASE_AGENT_DSL,
        dslValidationStatus: 'valid',
        dslDiagnostics: [],
      }),
      ProjectSettings.findOneAndUpdate(
        { tenantId: admin.tenantId, projectId: admin.projectId },
        {
          $set: {
            tenantId: admin.tenantId,
            projectId: admin.projectId,
            sessionLifecycle: {
              runtime: {
                idleSeconds: 12,
                maxAgeSeconds: 34,
              },
            },
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      ).exec(),
    ]);

    const result = await createRuntimeSession({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      channelType: 'api',
      agentName: 'RuntimeTimeoutAgent',
    });

    expect(result.runtimeSession.idleSeconds).toBe(12);
    expect(result.runtimeSession.maxAgeSeconds).toBe(34);
  });

  test('createRuntimeSession lets the agent runtime override win over the project default', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('runtime-timeout-int-agent'),
      uniqueSlug('runtime-timeout-int-tenant-agent'),
      uniqueSlug('runtime-timeout-int-project-agent'),
    );

    const { ProjectAgent, ProjectSettings } = await import('@agent-platform/database/models');
    await Promise.all([
      ProjectAgent.create({
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        name: 'RuntimeTimeoutAgent',
        agentPath: `${admin.projectId}/RuntimeTimeoutAgent`,
        dslContent: AGENT_TIMEOUT_DSL,
        dslValidationStatus: 'valid',
        dslDiagnostics: [],
      }),
      ProjectSettings.findOneAndUpdate(
        { tenantId: admin.tenantId, projectId: admin.projectId },
        {
          $set: {
            tenantId: admin.tenantId,
            projectId: admin.projectId,
            sessionLifecycle: {
              runtime: {
                idleSeconds: 30,
                maxAgeSeconds: 90,
              },
            },
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      ).exec(),
    ]);

    const result = await createRuntimeSession({
      tenantId: admin.tenantId,
      projectId: admin.projectId,
      channelType: 'api',
      agentName: 'RuntimeTimeoutAgent',
    });

    expect(result.runtimeSession.idleSeconds).toBe(56);
    expect(result.runtimeSession.maxAgeSeconds).toBe(90);
  });
});
