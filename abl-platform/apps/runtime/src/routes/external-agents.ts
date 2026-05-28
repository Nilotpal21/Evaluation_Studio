/**
 * External Agent Registry API Routes
 *
 * CRUD and connection-test endpoints for external agent configurations.
 * Mounted at /api/projects/:projectId/external-agents
 *
 * POST   /                     Create external agent config
 * GET    /                     List external agent configs
 * POST   /:id/test-connection  Test connection to external agent
 * GET    /:id                  Get external agent config
 * PATCH  /:id                  Update external agent config
 * DELETE /:id                  Delete external agent config
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { toErrorResponse, errorToResponse } from '@agent-platform/shared-kernel';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { createLogger } from '@abl/compiler/platform';
import {
  findExternalAgentConfigById,
  findExternalAgentConfigsByProject,
  createExternalAgentConfig,
  updateExternalAgentConfig,
  deleteExternalAgentConfig,
  patchExternalAgentConnectionStatus,
  testExternalAgentConnection,
} from '@agent-platform/shared/repos';
import type {
  ExternalAgentAuthConfig,
  ExternalAgentConfigView,
  NormalizedExternalAgentConfig,
  TestConnectionDeps,
  UpdateExternalAgentInput,
} from '@agent-platform/shared/repos';
import {
  SsrfEndpointValidator,
  discoverAgent,
  createA2AClient,
  createA2AClientWithAuth,
} from '@agent-platform/a2a';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { decryptForTenantAuto } from '@agent-platform/shared/encryption';

const log = createLogger('external-agents-route');

/**
 * Build TestConnectionDeps for testExternalAgentConnection.
 * The repo interface uses loose types (e.g. `unknown`) to avoid circular deps
 * between @agent-platform/shared and @agent-platform/a2a. We cast the real
 * implementations to match.
 */
function buildTestConnectionDeps(): TestConnectionDeps {
  return {
    discoverAgent: discoverAgent as TestConnectionDeps['discoverAgent'],
    createValidator: () => new SsrfEndpointValidator(),
    createClient: createA2AClient as TestConnectionDeps['createClient'],
    // Auth-aware factory used by `testExternalAgentConnection` when the caller
    // composes an `authConfig` from the persisted `encryptedAuthConfig`.
    createClientWithAuth: createA2AClientWithAuth as NonNullable<
      TestConnectionDeps['createClientWithAuth']
    >,
  };
}

/**
 * Compose the auth config passed to `testExternalAgentConnection` from a
 * persisted ExternalAgentConfig document.
 *
 * The DB stores `{value, header?}` (encrypted) plus a separate `authType` field;
 * the helper expects the union shape `{type, value, header?}`. This function
 * stitches them back together — and falls back to undefined for any of:
 *
 *   - `EXTERNAL_AGENT_TEST_AUTH=false` env-var rollback (one-line hotfix that
 *     restores the legacy unauthenticated test_connection behaviour)
 *   - `authType === 'none'` (no credentials configured)
 *   - missing or unparseable encryptedAuthConfig (logged, treated as no auth)
 */
export async function composeAuthConfigForTest(
  doc: NormalizedExternalAgentConfig,
  tenantId: string,
): Promise<ExternalAgentAuthConfig | undefined> {
  if (process.env.EXTERNAL_AGENT_TEST_AUTH === 'false') {
    log.warn(
      'External agent test_connection bypassing auth via EXTERNAL_AGENT_TEST_AUTH=false rollback',
      { tenantId, externalAgentId: doc.id },
    );
    return undefined;
  }
  if (doc.authType === 'none' || !doc.encryptedAuthConfig) {
    return undefined;
  }
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(doc.encryptedAuthConfig) as unknown;
    } catch {
      const decrypted = await decryptForTenantAuto(doc.encryptedAuthConfig, tenantId, {
        resourceType: 'external_agent_configs',
        fieldName: 'encryptedAuthConfig',
      });
      parsed = JSON.parse(decrypted) as unknown;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      log.warn('encryptedAuthConfig did not decode to an object', {
        tenantId,
        externalAgentId: doc.id,
      });
      return undefined;
    }
    const obj = parsed as { value?: unknown; header?: unknown };
    if (typeof obj.value !== 'string' || obj.value.length === 0) {
      log.warn('encryptedAuthConfig parsed but missing value field', {
        tenantId,
        externalAgentId: doc.id,
      });
      return undefined;
    }
    const header = typeof obj.header === 'string' ? obj.header : undefined;
    return { type: doc.authType, value: obj.value, header };
  } catch (err) {
    log.warn('Failed to parse encryptedAuthConfig for test_connection', {
      tenantId,
      externalAgentId: doc.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

const router: RouterType = Router({ mergeParams: true });

// Middleware chain
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

export const externalAgentCreateBodySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Name must be a valid ABL identifier'),
    displayName: z.string().max(256).optional().nullable(),
    endpoint: z.string().url('Endpoint must be a valid URL'),
    protocol: z.enum(['a2a', 'rest']),
    authType: z.enum(['none', 'bearer', 'api_key']),
    authConfig: z
      .object({ value: z.string().min(1), header: z.string().optional() })
      .optional()
      .nullable(),
  })
  .strict();

export const externalAgentUpdateBodySchema = z
  .object({
    displayName: z.string().max(256).optional().nullable(),
    endpoint: z.string().url().optional(),
    protocol: z.enum(['a2a', 'rest']).optional(),
    authType: z.enum(['none', 'bearer', 'api_key']).optional(),
    authConfig: z
      .object({ value: z.string().min(1), header: z.string().optional() })
      .optional()
      .nullable(),
  })
  .strict();

const projectIdParam = z.object({
  projectId: z.string().min(1),
});

const agentIdParam = z.object({
  projectId: z.string().min(1),
  id: z.string().min(1),
});

// =============================================================================
// HELPERS
// =============================================================================

function getAuthContext(req: Express.Request) {
  const tc = (req as any).tenantContext;
  if (!tc?.tenantId || !tc?.userId) {
    return null;
  }
  return { tenantId: tc.tenantId as string, userId: tc.userId as string };
}

/**
 * Strip encryptedAuthConfig from the response and add authConfigured flag.
 * NormalizedExternalAgentConfig already has id (not _id) and createdAt/updatedAt as strings.
 *
 * `ExternalAgentConfigView` is defined in `@agent-platform/shared/types/external-agent.ts`
 * and re-exported via `@agent-platform/shared/repos` so Studio executor + chat widgets
 * can share the wire shape.
 */
export function maskExternalAgentResponse(
  doc: NormalizedExternalAgentConfig,
): ExternalAgentConfigView {
  return {
    id: doc.id,
    name: doc.name,
    displayName: doc.displayName,
    endpoint: doc.endpoint,
    protocol: doc.protocol,
    authType: doc.authType,
    authConfigured: doc.encryptedAuthConfig !== null,
    lastDiscoveredCard: doc.lastDiscoveredCard,
    lastConnectionStatus: doc.lastConnectionStatus,
    lastConnectionAt: doc.lastConnectionAt?.toISOString() ?? null,
    lastConnectionLatencyMs: doc.lastConnectionLatencyMs,
    lastConnectionError: doc.lastConnectionError,
    createdBy: doc.createdBy,
    modifiedBy: doc.modifiedBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Validate an endpoint URL against SSRF rules.
 * Returns true if valid, false if blocked (and sends 400 response).
 */
function validateEndpointSsrf(endpoint: string, res: import('express').Response): boolean {
  try {
    const { allowLocalhost, allowPrivateRanges } = getDevSSRFOptions();
    const allowPrivate = (allowLocalhost || allowPrivateRanges) ?? false;
    new SsrfEndpointValidator().validate(endpoint, allowPrivate);
    return true;
  } catch (err: unknown) {
    res.status(400).json(toErrorResponse('SSRF_REJECTED', 'Endpoint URL is not allowed'));
    return false;
  }
}

// =============================================================================
// CREATE
// =============================================================================

/**
 * POST /
 * Create a new external agent configuration.
 */
router.post('/', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'external_agent:create'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const parsedParams = projectIdParam.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsedParams.error.message));
      return;
    }

    const parsed = externalAgentCreateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsed.error.message));
      return;
    }

    const { projectId } = parsedParams.data;
    const body = parsed.data;

    // SSRF validate endpoint
    if (!validateEndpointSsrf(body.endpoint, res)) return;

    const doc = await createExternalAgentConfig({
      tenantId: auth.tenantId,
      projectId,
      name: body.name,
      displayName: body.displayName,
      endpoint: body.endpoint,
      protocol: body.protocol,
      authType: body.authType,
      encryptedAuthConfig: body.authConfig ? JSON.stringify(body.authConfig) : null,
      createdBy: auth.userId,
    });

    // Non-blocking background card fetch — exercises the same auth-aware path
    // as the explicit POST /:id/test-connection so `lastConnectionStatus`
    // reflects the real reachability from the very first record.
    void (async () => {
      try {
        const { allowLocalhost, allowPrivateRanges } = getDevSSRFOptions();
        const allowPrivate = (allowLocalhost || allowPrivateRanges) ?? false;
        const authConfig = await composeAuthConfigForTest(doc, auth.tenantId);
        const result = await testExternalAgentConnection(
          doc.endpoint,
          auth.tenantId,
          allowPrivate,
          buildTestConnectionDeps(),
          authConfig,
        );
        await patchExternalAgentConnectionStatus(doc.id, auth.tenantId, projectId, {
          lastConnectionStatus: result.reachable ? 'connected' : 'failed',
          lastConnectionAt: new Date(),
          lastConnectionLatencyMs: result.latencyMs,
          lastDiscoveredCard: (result.agentCard as object) ?? null,
          lastConnectionError: result.error ?? null,
        });
      } catch (err: unknown) {
        log.error('Background card fetch failed', {
          error: err instanceof Error ? err.message : String(err),
          externalAgentId: doc.id,
        });
      }
    })();

    res.status(201).json({ success: true, data: maskExternalAgentResponse(doc) });
  } catch (err: unknown) {
    // Handle duplicate key (unique index on tenantId+projectId+name)
    if (typeof err === 'object' && err !== null && 'code' in err && (err as any).code === 11000) {
      res
        .status(409)
        .json(
          toErrorResponse(
            'DUPLICATE_NAME',
            'An external agent with this name already exists in the project',
          ),
        );
      return;
    }
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to create external agent config', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

// =============================================================================
// LIST
// =============================================================================

/**
 * GET /
 * List external agent configurations for a project.
 */
router.get('/', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'external_agent:read'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const parsedParams = projectIdParam.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsedParams.error.message));
      return;
    }

    const { projectId } = parsedParams.data;
    const docs = await findExternalAgentConfigsByProject(auth.tenantId, projectId);

    res.json({ success: true, data: docs.map(maskExternalAgentResponse) });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to list external agent configs', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

// =============================================================================
// TEST CONNECTION (registered BEFORE /:id to avoid Express param capture)
// =============================================================================

/**
 * POST /:id/test-connection
 * Test connectivity to an external agent endpoint.
 */
router.post('/:id/test-connection', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'external_agent:update'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const parsedParams = agentIdParam.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsedParams.error.message));
      return;
    }

    const { projectId, id } = parsedParams.data;
    const doc = await findExternalAgentConfigById(id, auth.tenantId, projectId);
    if (!doc) {
      res.status(404).json(toErrorResponse('NOT_FOUND', 'External agent config not found'));
      return;
    }

    const { allowLocalhost, allowPrivateRanges } = getDevSSRFOptions();
    const allowPrivate = (allowLocalhost || allowPrivateRanges) ?? false;
    const authConfig = await composeAuthConfigForTest(doc, auth.tenantId);

    const result = await testExternalAgentConnection(
      doc.endpoint,
      auth.tenantId,
      allowPrivate,
      buildTestConnectionDeps(),
      authConfig,
    );

    const updated = await patchExternalAgentConnectionStatus(id, auth.tenantId, projectId, {
      lastConnectionStatus: result.reachable ? 'connected' : 'failed',
      lastConnectionAt: new Date(),
      lastConnectionLatencyMs: result.latencyMs,
      lastDiscoveredCard: (result.agentCard as object) ?? null,
      lastConnectionError: result.error ?? null,
    });

    if (!updated) {
      res.status(404).json(toErrorResponse('NOT_FOUND', 'External agent config not found'));
      return;
    }

    res.json({ success: true, data: maskExternalAgentResponse(updated) });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to test external agent connection', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

// =============================================================================
// GET SINGLE
// =============================================================================

/**
 * GET /:id
 * Get a single external agent configuration.
 */
router.get('/:id', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'external_agent:read'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const parsedParams = agentIdParam.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsedParams.error.message));
      return;
    }

    const { projectId, id } = parsedParams.data;
    const doc = await findExternalAgentConfigById(id, auth.tenantId, projectId);
    if (!doc) {
      res.status(404).json(toErrorResponse('NOT_FOUND', 'External agent config not found'));
      return;
    }

    res.json({ success: true, data: maskExternalAgentResponse(doc) });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to get external agent config', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

// =============================================================================
// UPDATE
// =============================================================================

/**
 * PATCH /:id
 * Update an external agent configuration.
 */
router.patch('/:id', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'external_agent:update'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const parsedParams = agentIdParam.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsedParams.error.message));
      return;
    }

    const parsed = externalAgentUpdateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsed.error.message));
      return;
    }

    const { projectId, id } = parsedParams.data;
    const body = parsed.data;

    // SSRF re-validate if endpoint is being changed
    if (body.endpoint && !validateEndpointSsrf(body.endpoint, res)) return;

    // Build the update patch
    const patch: UpdateExternalAgentInput = {
      modifiedBy: auth.userId,
    };
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.endpoint !== undefined) patch.endpoint = body.endpoint;
    if (body.protocol !== undefined) patch.protocol = body.protocol;
    if (body.authType !== undefined) patch.authType = body.authType;
    if (body.authConfig === null) {
      patch.encryptedAuthConfig = null;
    } else if (body.authConfig !== undefined) {
      patch.encryptedAuthConfig = JSON.stringify(body.authConfig);
    }

    const updated = await updateExternalAgentConfig(id, auth.tenantId, projectId, patch);
    if (!updated) {
      res.status(404).json(toErrorResponse('NOT_FOUND', 'External agent config not found'));
      return;
    }

    res.json({ success: true, data: maskExternalAgentResponse(updated) });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to update external agent config', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

// =============================================================================
// DELETE
// =============================================================================

/**
 * DELETE /:id
 * Delete an external agent configuration.
 */
router.delete('/:id', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'external_agent:delete'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const parsedParams = agentIdParam.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsedParams.error.message));
      return;
    }

    const { projectId, id } = parsedParams.data;
    const deleted = await deleteExternalAgentConfig(id, auth.tenantId, projectId);
    if (!deleted) {
      res.status(404).json(toErrorResponse('NOT_FOUND', 'External agent config not found'));
      return;
    }

    res.status(204).send();
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to delete external agent config', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

export default router;
