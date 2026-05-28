/**
 * Prompt Library API Routes
 *
 * CRUD, lifecycle, test, and reference endpoints for prompt library.
 * Mounted at /api/projects/:projectId/prompt-library
 *
 * POST   /test                                      Execute multi-pane test
 * GET    /prompts                                    List prompts
 * POST   /prompts                                    Create prompt
 * GET    /prompts/:promptId                          Get prompt detail
 * PATCH  /prompts/:promptId                          Update prompt
 * DELETE /prompts/:promptId                          Delete prompt
 * GET    /prompts/:promptId/versions                 List versions
 * POST   /prompts/:promptId/versions                 Create version
 * GET    /prompts/:promptId/versions/:versionId      Get version detail
 * PATCH  /prompts/:promptId/versions/:versionId      Update version (description only)
 * POST   /prompts/:promptId/versions/:versionId/promote   Promote to active
 * POST   /prompts/:promptId/versions/:versionId/archive   Archive version
 * GET    /prompts/:promptId/references               Reverse references
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { AppError, toErrorResponse, errorToResponse } from '@agent-platform/shared-kernel';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { createLogger } from '@abl/compiler/platform';
import { getPromptLibraryService } from '../services/prompt-library/prompt-library-service.js';
import {
  getPromptLibraryTestService,
  type TestStreamEvent,
} from '../services/prompt-library/prompt-library-test-service.js';
import {
  auditPromptCreated,
  auditPromptVersionCreated,
  auditPromptVersionPromoted,
  auditPromptVersionArchived,
} from '../services/audit-helpers.js';

const log = createLogger('prompt-library-route');

const router: RouterType = Router({ mergeParams: true });

// Middleware chain
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const createPromptBody = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(512).optional(),
    tags: z.array(z.string().min(1).max(64)).max(20).optional(),
    initialVersion: z
      .object({
        template: z.string().min(1),
        variables: z.array(z.string().min(1).max(64)).max(20).optional(),
        description: z.string().max(512).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const updatePromptBody = z
  .object({
    name: z.string().min(1).max(128).optional(),
    description: z.string().max(512).optional(),
    tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict();

const createVersionBody = z
  .object({
    template: z.string().min(1),
    variables: z.array(z.string().min(1).max(64)).max(20).optional(),
    description: z.string().max(512).optional(),
  })
  .strict();

const updateVersionBody = z
  .object({
    template: z.string().min(1).optional(),
    variables: z.array(z.string().min(1).max(64)).max(20).optional(),
    description: z.string().max(512).optional(),
  })
  .strict();

const testBody = z
  .object({
    panes: z
      .array(
        z
          .object({
            promptVersionId: z.string().min(1),
            tenantModelId: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    variables: z
      .record(z.string().max(4096))
      .refine((v) => Object.keys(v).length <= 20, { message: 'Too many variable values (max 20)' })
      .optional(),
    userMessage: z.string().max(32768).optional(),
  })
  .strict();

const listQuery = z
  .object({
    status: z.enum(['active', 'archived']).optional(),
    tag: z.string().optional(),
    limit: z.string().transform(Number).pipe(z.number().int().positive().max(200)).optional(),
    offset: z.string().transform(Number).pipe(z.number().int().nonnegative()).optional(),
  })
  .strict();

const projectIdParam = z.object({
  projectId: z.string().min(1),
});

const promptIdParam = z.object({
  projectId: z.string().min(1),
  promptId: z.string().min(1),
});

const versionIdParam = promptIdParam.extend({
  versionId: z.string().min(1),
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

// =============================================================================
// TEST ENDPOINT (registered BEFORE /:promptId to avoid Express capture)
// =============================================================================

/**
 * POST /test
 * Execute multi-pane prompt test against LLM models.
 */
router.post('/test', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:test'))) return;

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

    const parsed = testBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsed.error.message));
      return;
    }

    const { projectId } = parsedParams.data;
    const testService = getPromptLibraryTestService();

    const result = await testService.executeTest({
      tenantId: auth.tenantId,
      projectId,
      panes: parsed.data.panes,
      variables: parsed.data.variables,
      userMessage: parsed.data.userMessage,
    });

    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Prompt test failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

// =============================================================================
// STREAMING TEST ENDPOINT (registered BEFORE /:promptId to avoid Express capture)
// =============================================================================

/**
 * POST /test/stream
 * Execute multi-pane prompt test with SSE streaming response.
 */
router.post('/test/stream', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:test'))) return;

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

    const parsed = testBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsed.error.message));
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    const write = (event: TestStreamEvent) => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const { projectId } = parsedParams.data;
    const testService = getPromptLibraryTestService();

    try {
      const stream = testService.streamTest({
        tenantId: auth.tenantId,
        projectId,
        panes: parsed.data.panes,
        variables: parsed.data.variables,
        userMessage: parsed.data.userMessage,
        abortSignal: abortController.signal,
      });

      for await (const event of stream) {
        write(event);
      }
    } catch (err: unknown) {
      log.error('Prompt stream test failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.destroyed) {
        write({
          type: 'pane_error',
          paneIndex: -1,
          tenantModelId: '',
          error: { code: 'STREAM_ERROR', message: 'Stream failed' },
        });
      }
    } finally {
      if (!res.destroyed) res.end();
    }
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Prompt stream test setup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Headers may have already been sent; only respond if they haven't
    if (!res.headersSent) {
      res.status(statusCode).json(body);
    } else if (!res.destroyed) {
      res.end();
    }
  }
});

// =============================================================================
// PROMPT CRUD
// =============================================================================

/**
 * GET /prompts
 * List prompt library items with optional filters.
 */
router.get('/prompts', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:read'))) return;

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

    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', query.error.message));
      return;
    }

    const { projectId } = parsedParams.data;
    const service = getPromptLibraryService();
    const result = await service.listPrompts({
      tenantId: auth.tenantId,
      projectId,
      status: query.data.status,
      tag: query.data.tag,
      limit: query.data.limit,
      offset: query.data.offset,
    });

    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to list prompts', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

/**
 * POST /prompts
 * Create a new prompt library item.
 */
router.post('/prompts', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:create'))) return;

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

    const parsed = createPromptBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsed.error.message));
      return;
    }

    const { projectId } = parsedParams.data;
    const service = getPromptLibraryService();
    const item = await service.createPrompt({
      tenantId: auth.tenantId,
      projectId,
      name: parsed.data.name,
      description: parsed.data.description,
      tags: parsed.data.tags,
      createdBy: auth.userId,
      initialVersion: parsed.data.initialVersion,
    });

    // Fire-and-forget audit
    auditPromptCreated(item, auth.userId).catch((err: unknown) => {
      log.error('Failed to emit prompt created audit', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    res.status(201).json({ success: true, data: item });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to create prompt', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

/**
 * GET /prompts/:promptId
 * Get prompt detail.
 */
router.get('/prompts/:promptId', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:read'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const params = promptIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', params.error.message));
      return;
    }

    const service = getPromptLibraryService();
    const item = await service.getPrompt(params.data.promptId, {
      tenantId: auth.tenantId,
      projectId: params.data.projectId,
    });

    if (!item) {
      res.status(404).json(toErrorResponse('NOT_FOUND', 'Prompt not found'));
      return;
    }

    res.json({ success: true, data: item });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to get prompt', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

/**
 * PATCH /prompts/:promptId
 * Update prompt metadata (name, description, tags).
 */
router.patch('/prompts/:promptId', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:update'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const params = promptIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', params.error.message));
      return;
    }

    const parsed = updatePromptBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsed.error.message));
      return;
    }

    const service = getPromptLibraryService();
    const item = await service.updatePrompt(params.data.promptId, parsed.data, {
      tenantId: auth.tenantId,
      projectId: params.data.projectId,
    });

    res.json({ success: true, data: item });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to update prompt', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

/**
 * DELETE /prompts/:promptId
 * Delete a prompt and all its versions (if no references).
 */
router.delete('/prompts/:promptId', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:delete'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const params = promptIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', params.error.message));
      return;
    }

    const service = getPromptLibraryService();
    await service.deletePrompt(params.data.promptId, {
      tenantId: auth.tenantId,
      projectId: params.data.projectId,
    });

    res.json({ success: true, data: { deleted: true } });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to delete prompt', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

// =============================================================================
// VERSION CRUD
// =============================================================================

/**
 * GET /prompts/:promptId/versions
 * List all versions for a prompt.
 */
router.get('/prompts/:promptId/versions', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:read'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const params = promptIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', params.error.message));
      return;
    }

    const service = getPromptLibraryService();
    const versions = await service.listVersions(params.data.promptId, {
      tenantId: auth.tenantId,
      projectId: params.data.projectId,
    });

    res.json({ success: true, data: { versions } });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to list versions', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

/**
 * POST /prompts/:promptId/versions
 * Create a new version for a prompt.
 */
router.post('/prompts/:promptId/versions', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:create'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const params = promptIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', params.error.message));
      return;
    }

    const parsed = createVersionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsed.error.message));
      return;
    }

    const service = getPromptLibraryService();
    const version = await service.createVersion(params.data.promptId, {
      tenantId: auth.tenantId,
      projectId: params.data.projectId,
      template: parsed.data.template,
      variables: parsed.data.variables,
      description: parsed.data.description,
      createdBy: auth.userId,
    });

    // Fire-and-forget audit
    auditPromptVersionCreated(version, auth.userId).catch((err: unknown) => {
      log.error('Failed to emit version created audit', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    res.status(201).json({ success: true, data: version });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to create version', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

/**
 * GET /prompts/:promptId/versions/:versionId
 * Get version detail.
 */
router.get('/prompts/:promptId/versions/:versionId', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:read'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const params = versionIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', params.error.message));
      return;
    }

    const service = getPromptLibraryService();
    const version = await service.getVersion(params.data.promptId, params.data.versionId, {
      tenantId: auth.tenantId,
      projectId: params.data.projectId,
    });

    if (!version) {
      res.status(404).json(toErrorResponse('NOT_FOUND', 'Version not found'));
      return;
    }

    res.json({ success: true, data: version });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to get version', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

/**
 * PATCH /prompts/:promptId/versions/:versionId
 * Update draft version fields: template, variables, and/or description.
 */
router.patch('/prompts/:promptId/versions/:versionId', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:update'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const params = versionIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', params.error.message));
      return;
    }

    const parsed = updateVersionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', parsed.error.message));
      return;
    }

    const service = getPromptLibraryService();
    const version = await service.updateVersion(
      params.data.promptId,
      params.data.versionId,
      {
        template: parsed.data.template,
        variables: parsed.data.variables,
        description: parsed.data.description,
      },
      { tenantId: auth.tenantId, projectId: params.data.projectId },
    );

    res.json({ success: true, data: version });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to update version', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

// =============================================================================
// VERSION LIFECYCLE
// =============================================================================

/**
 * POST /prompts/:promptId/versions/:versionId/promote
 * Promote a draft version to active.
 */
router.post('/prompts/:promptId/versions/:versionId/promote', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:promote'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const params = versionIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', params.error.message));
      return;
    }

    const service = getPromptLibraryService();
    const result = await service.promoteVersion(params.data.promptId, params.data.versionId, {
      tenantId: auth.tenantId,
      projectId: params.data.projectId,
      userId: auth.userId,
    });

    // Fire-and-forget audit
    auditPromptVersionPromoted(result.version, auth.userId).catch((err: unknown) => {
      log.error('Failed to emit version promoted audit', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to promote version', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

/**
 * POST /prompts/:promptId/versions/:versionId/archive
 * Archive a version.
 */
router.post('/prompts/:promptId/versions/:versionId/archive', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:update'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const params = versionIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', params.error.message));
      return;
    }

    const service = getPromptLibraryService();
    const version = await service.archiveVersion(params.data.promptId, params.data.versionId, {
      tenantId: auth.tenantId,
      projectId: params.data.projectId,
    });

    // Fire-and-forget audit
    auditPromptVersionArchived(version, auth.userId).catch((err: unknown) => {
      log.error('Failed to emit version archived audit', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    res.json({ success: true, data: version });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to archive version', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

// =============================================================================
// REFERENCES
// =============================================================================

/**
 * GET /prompts/:promptId/references
 * Get agent versions that reference this prompt.
 */
router.get('/prompts/:promptId/references', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'prompt:read'))) return;

    const auth = getAuthContext(req);
    if (!auth) {
      res.status(401).json(toErrorResponse('UNAUTHORIZED', 'Authentication required'));
      return;
    }

    const params = promptIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json(toErrorResponse('VALIDATION_ERROR', params.error.message));
      return;
    }

    const service = getPromptLibraryService();
    const refs = await service.getReferences(params.data.promptId, {
      tenantId: auth.tenantId,
      projectId: params.data.projectId,
    });

    res.json({ success: true, data: refs });
  } catch (err: unknown) {
    const { statusCode, body } = errorToResponse(err);
    log.error('Failed to get references', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(statusCode).json(body);
  }
});

export default router;
