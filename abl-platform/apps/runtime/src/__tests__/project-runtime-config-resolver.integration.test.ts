import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { clearPermissionCache } from '../services/permission-resolution.js';
import { resolveProjectRuntimeConfig } from '../services/config/project-runtime-config-resolver.js';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  createProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';

const SUITE_TIMEOUT_MS = 120_000;

interface RuntimeConfigRouteResponse {
  success: boolean;
  data?: {
    projectId: string;
    pipeline?: {
      enabled?: boolean;
      mode?: 'parallel' | 'sequential';
      modelSource?: 'default' | 'tenant';
      tenantModelId?: string;
      shortCircuit?: {
        enabled?: boolean;
        confidenceThreshold?: number;
      };
      toolFilter?: {
        enabled?: boolean;
        maxTools?: number;
      };
      keywordVeto?: {
        enabled?: boolean;
        keywords?: string[];
      };
      intentBridge?: {
        enabled?: boolean;
        programmaticThreshold?: number;
        guidedThreshold?: number;
        outOfScopeDecline?: boolean;
        multiIntentSignal?: boolean;
      };
    };
  };
  error?: {
    code: string;
    message: string;
  };
}

describe.sequential('project runtime config resolver integration', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
  }, SUITE_TIMEOUT_MS);

  beforeEach(async () => {
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
    clearPermissionCache();
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await harness.close();
  }, SUITE_TIMEOUT_MS);

  test(
    'resolves route updates, leaves prior classifier config intact after validation rejection, and downgrades per project without cross-project leakage',
    async () => {
      const admin = await bootstrapProject(
        harness,
        uniqueEmail('runtime-config-resolver-admin'),
        uniqueSlug('runtime-config-resolver-tenant'),
        uniqueSlug('runtime-config-resolver-project'),
      );
      const siblingProject = await createProject(
        harness,
        admin.token,
        admin.tenantId,
        `${uniqueSlug('runtime-config-resolver-sibling')} Name`,
        uniqueSlug('runtime-config-resolver-sibling'),
      );

      await setSuperAdmins([]);
      clearPermissionCache();

      const enabledResponse = await requestJson<RuntimeConfigRouteResponse>(
        harness,
        `/api/projects/${admin.projectId}/runtime-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {
            pipeline: {
              enabled: true,
              mode: 'sequential',
              modelSource: 'default',
              shortCircuit: {
                enabled: false,
                confidenceThreshold: 0.92,
              },
              toolFilter: {
                enabled: true,
                maxTools: 4,
              },
              keywordVeto: {
                enabled: true,
                keywords: ['cancel'],
              },
              intentBridge: {
                enabled: true,
                programmaticThreshold: 0.77,
                guidedThreshold: 0.52,
                outOfScopeDecline: false,
                multiIntentSignal: false,
              },
            },
          },
        },
      );

      expect(enabledResponse.status).toBe(200);
      expect(enabledResponse.body.success).toBe(true);

      const resolvedEnabled = await resolveProjectRuntimeConfig(admin.tenantId, admin.projectId);

      expect(resolvedEnabled?.pipeline).toEqual({
        enabled: true,
        mode: 'sequential',
        modelSource: 'default',
        tenantModelId: undefined,
        shortCircuit: {
          enabled: false,
          confidenceThreshold: 0.92,
        },
        toolFilter: {
          enabled: true,
          maxTools: 4,
        },
        keywordVeto: {
          enabled: true,
          keywords: ['cancel'],
        },
        intentBridge: {
          enabled: true,
          programmaticThreshold: 0.77,
          guidedThreshold: 0.52,
          outOfScopeDecline: false,
          multiIntentSignal: false,
        },
      });

      const invalidTenantModelResponse = await requestJson<RuntimeConfigRouteResponse>(
        harness,
        `/api/projects/${admin.projectId}/runtime-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {
            pipeline: {
              enabled: true,
              modelSource: 'tenant',
            },
          },
        },
      );

      expect(invalidTenantModelResponse.status).toBe(400);

      const resolvedAfterInvalid = await resolveProjectRuntimeConfig(
        admin.tenantId,
        admin.projectId,
      );
      expect(resolvedAfterInvalid?.pipeline).toEqual(resolvedEnabled?.pipeline);

      const downgradedResponse = await requestJson<RuntimeConfigRouteResponse>(
        harness,
        `/api/projects/${admin.projectId}/runtime-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {
            pipeline: {
              enabled: false,
            },
          },
        },
      );

      expect(downgradedResponse.status).toBe(200);
      expect(downgradedResponse.body.success).toBe(true);

      const resolvedDowngraded = await resolveProjectRuntimeConfig(admin.tenantId, admin.projectId);
      expect(resolvedDowngraded?.pipeline).toEqual({
        ...resolvedEnabled?.pipeline,
        enabled: false,
      });

      const siblingResponse = await requestJson<RuntimeConfigRouteResponse>(
        harness,
        `/api/projects/${siblingProject._id}/runtime-config`,
        {
          method: 'PUT',
          headers: authHeaders(admin.token),
          body: {
            pipeline: {
              enabled: true,
              shortCircuit: {
                enabled: true,
                confidenceThreshold: 0.66,
              },
            },
          },
        },
      );

      expect(siblingResponse.status).toBe(200);
      expect(siblingResponse.body.success).toBe(true);

      const resolvedSibling = await resolveProjectRuntimeConfig(admin.tenantId, siblingProject._id);
      expect(resolvedSibling?.pipeline).toEqual({
        enabled: true,
        mode: 'parallel',
        modelSource: 'default',
        tenantModelId: undefined,
        shortCircuit: {
          enabled: true,
          confidenceThreshold: 0.66,
        },
        toolFilter: {
          enabled: true,
          maxTools: 6,
        },
        keywordVeto: {
          enabled: true,
          keywords: [],
        },
        intentBridge: {
          enabled: true,
          programmaticThreshold: 0.85,
          guidedThreshold: 0.5,
          outOfScopeDecline: true,
          multiIntentSignal: true,
        },
      });

      const resolvedOriginalAfterSibling = await resolveProjectRuntimeConfig(
        admin.tenantId,
        admin.projectId,
      );
      expect(resolvedOriginalAfterSibling?.pipeline).toEqual(resolvedDowngraded?.pipeline);

      await expect(
        resolveProjectRuntimeConfig('wrong-tenant', admin.projectId),
      ).resolves.toBeUndefined();
    },
    SUITE_TIMEOUT_MS,
  );
});
