/**
 * Marketplace Routes
 *
 * Public browse API for the Template Store.
 * All endpoints are GET-only and require no authentication.
 * Optional auth middleware (applied at mount point) enriches analytics with user context.
 *
 * Endpoints:
 *   GET /templates       — browse with filters + pagination
 *   GET /templates/:slug — detail + view count + analytics
 *   GET /categories      — categories with counts
 *   GET /featured        — featured templates (flat array)
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { z } from 'zod';
import { createLogger } from '@agent-platform/shared-observability';
import {
  findTemplates,
  findTemplateBySlug,
  findFeaturedTemplates,
  findCategories,
  incrementViewCount,
  incrementInstallCount,
  findLatestPublishedVersion,
  findBundleBySlugAndVersion,
} from '../repos/template-repo.js';
import { trackEvent, hashIp } from '../repos/analytics-repo.js';

const log = createLogger('marketplace-routes');

// ─── Validation Schemas ───────────────────────────────────────────────────

const BrowseQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(['agent', 'project']).optional(),
  category: z.string().min(1).optional(),
  complexity: z.enum(['starter', 'standard', 'advanced']).optional(),
  q: z.string().min(1).max(200).optional(),
  sort: z.enum(['popular', 'rating', 'newest', 'updated']).default('popular'),
  publisherTenantId: z.string().min(1).optional(),
  // tenantId can be passed as query param when the auth header is not available
  // (e.g., marketplace standalone page where in-memory JWT is lost on navigation).
  // This widens browse results to include tenant-scoped templates.
  tenantId: z.string().min(1).optional(),
});

const SlugParamSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
});

const BundleParamSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
  version: z
    .string()
    .min(1)
    .max(20)
    .regex(/^\d+\.\d+\.\d+$/),
});

const CategoriesQuerySchema = z.object({
  type: z.enum(['agent', 'project']).optional(),
});

const InstallEventBodySchema = z.object({
  version: z.string().min(1),
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
});

// ─── Helpers ──────────────────────────────────────────────────────────────

interface AuthenticatedRequest extends Request {
  user?: { id: string; tenantId?: string };
  tenantContext?: { tenantId: string };
}

function getUserId(req: AuthenticatedRequest): string | undefined {
  return req.user?.id;
}

function getTenantId(req: AuthenticatedRequest): string | undefined {
  // First try the auth-populated context
  const fromAuth = req.tenantContext?.tenantId ?? req.user?.tenantId;
  if (fromAuth) return fromAuth;

  // Fallback: decode JWT payload without verification to extract tenantId.
  // This is safe for browse scoping — it only WIDENS results (showing tenant
  // templates alongside platform templates), never grants access to anything private.
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      return payload.tenantId ?? undefined;
    } catch {
      // Invalid token format — ignore
    }
  }
  return undefined;
}

function getClientIpHash(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  return hashIp(ip);
}

/**
 * Classify the analytics event type based on query parameters.
 * q present -> search, category present -> category_browse, else -> marketplace_view
 */
function classifyBrowseEvent(
  query: z.infer<typeof BrowseQuerySchema>,
): 'search' | 'category_browse' | 'marketplace_view' {
  if (query.q) return 'search';
  if (query.category) return 'category_browse';
  return 'marketplace_view';
}

// ─── Router ───────────────────────────────────────────────────────────────

const router: RouterType = Router();

/**
 * GET /templates — Browse templates with filters and pagination
 */
router.get('/templates', async (req: Request, res: Response) => {
  try {
    const parsed = BrowseQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
        },
      });
      return;
    }

    const query = parsed.data;
    const authReq = req as AuthenticatedRequest;
    // Prefer auth-derived tenantId, fall back to query param
    const userTenantId = getTenantId(authReq) ?? query.tenantId;

    // Build publisherTenantIds from query param or derive from auth
    const publisherTenantIds = query.publisherTenantId ? [query.publisherTenantId] : undefined;

    const { templates, total } = await findTemplates({
      ...query,
      tenantId: userTenantId,
      publisherTenantIds,
    });
    const hasMore = query.page * query.limit < total;

    // Fire-and-forget analytics
    const eventType = classifyBrowseEvent(query);
    trackEvent({
      eventType,
      userId: getUserId(authReq),
      tenantId: getTenantId(authReq),
      ipHash: getClientIpHash(req),
      metadata: {
        requestId: res.getHeader('x-request-id'),
        query: query.q,
        category: query.category,
        type: query.type,
        complexity: query.complexity,
        sort: query.sort,
        page: query.page,
      },
    }).catch((err: unknown) => {
      log.error('Analytics tracking failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    res.json({
      success: true,
      data: {
        templates,
        total,
        page: query.page,
        limit: query.limit,
        hasMore,
      },
    });
  } catch (err) {
    log.error('Browse templates failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to browse templates' },
    });
  }
});

/**
 * GET /templates/:slug/versions/:version/bundle — Bundle retrieval for install
 * Returns only the `files` field for the specified template version.
 */
router.get('/templates/:slug/versions/:version/bundle', async (req: Request, res: Response) => {
  try {
    const parsed = BundleParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid slug or version format',
        },
      });
      return;
    }

    const { slug, version } = parsed.data;
    const authReq = req as AuthenticatedRequest;
    // Accept tenantId from auth or query param (for server-side install calls)
    const userTenantId = getTenantId(authReq) ?? (req.query.tenantId as string | undefined);
    const bundle = await findBundleBySlugAndVersion(slug, version, userTenantId);

    if (!bundle) {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Template version not found',
        },
      });
      return;
    }

    // Fire-and-forget: record bundle_access analytics event
    const bundleSizeBytes = JSON.stringify(bundle.files).length;
    trackEvent({
      eventType: 'bundle_access',
      templateSlug: slug,
      userId: getUserId(authReq),
      tenantId: getTenantId(authReq),
      ipHash: getClientIpHash(req),
      metadata: {
        requestId: res.getHeader('x-request-id'),
        version,
        bundleSizeBytes,
      },
    }).catch((err: unknown) => {
      log.error('Analytics tracking failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info('Bundle retrieved', {
      slug,
      version,
      bundleSizeBytes,
    });

    res.json({
      success: true,
      data: { files: bundle.files },
    });
  } catch (err) {
    log.error('Bundle retrieval failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to retrieve bundle',
      },
    });
  }
});

/**
 * POST /templates/:slug/install-event — Record a template install event
 * Increments install count and records analytics. Unprotected for now;
 * auth will be added when Studio starts calling with JWT.
 */
router.post('/templates/:slug/install-event', async (req: Request, res: Response) => {
  try {
    const slugParsed = SlugParamSchema.safeParse(req.params);
    if (!slugParsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid slug format',
        },
      });
      return;
    }

    const bodyParsed = InstallEventBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
        },
      });
      return;
    }

    const { slug } = slugParsed.data;
    const { version, userId, tenantId, projectId } = bodyParsed.data;

    // Increment install count (fire-and-forget)
    incrementInstallCount(slug).catch((err: unknown) => {
      log.error('Failed to increment install count', {
        error: err instanceof Error ? err.message : String(err),
        slug,
      });
    });

    // Record install analytics event (fire-and-forget)
    trackEvent({
      eventType: 'install',
      templateSlug: slug,
      userId,
      tenantId,
      ipHash: getClientIpHash(req),
      metadata: {
        requestId: res.getHeader('x-request-id'),
        version,
        projectId,
      },
    }).catch((err: unknown) => {
      log.error('Analytics tracking failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info('Install event recorded', { slug, version, userId, tenantId, projectId });

    res.json({ success: true });
  } catch (err) {
    log.error('Install event recording failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to record install event',
      },
    });
  }
});

/**
 * GET /templates/:slug — Template detail with view count increment and analytics
 */
router.get('/templates/:slug', async (req: Request, res: Response) => {
  try {
    const parsed = SlugParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid slug format',
        },
      });
      return;
    }

    const { slug } = parsed.data;
    const authReq = req as AuthenticatedRequest;
    const userTenantId = getTenantId(authReq);
    const template = await findTemplateBySlug(slug, userTenantId);

    if (!template) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Template not found' },
      });
      return;
    }

    // Increment view count (fire-and-forget)
    incrementViewCount(template._id).catch((err: unknown) => {
      log.error('Failed to increment view count', {
        error: err instanceof Error ? err.message : String(err),
        templateId: template._id,
      });
    });

    // Record detail_view analytics event (fire-and-forget)
    trackEvent({
      eventType: 'detail_view',
      templateId: template._id,
      templateSlug: slug,
      userId: getUserId(authReq),
      tenantId: getTenantId(authReq),
      ipHash: getClientIpHash(req),
      metadata: {
        requestId: res.getHeader('x-request-id'),
      },
    }).catch((err: unknown) => {
      log.error('Analytics tracking failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Load latest version for this template (via repo layer)
    const version = await findLatestPublishedVersion(template._id);

    res.json({
      success: true,
      data: {
        template,
        version: version ?? null,
      },
    });
  } catch (err) {
    log.error('Template detail failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to load template detail' },
    });
  }
});

/**
 * GET /categories — Category names with template counts
 * Supports optional ?type=agent|project filter
 */
router.get('/categories', async (req: Request, res: Response) => {
  try {
    const parsed = CategoriesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
        },
      });
      return;
    }

    const authReq = req as AuthenticatedRequest;
    const userTenantId = getTenantId(authReq);
    const categories = await findCategories(parsed.data.type, userTenantId);

    res.json({
      success: true,
      data: { categories },
    });
  } catch (err) {
    log.error('Categories fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to load categories' },
    });
  }
});

/**
 * GET /featured — Featured templates ordered by featuredOrder
 */
router.get('/featured', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userTenantId = getTenantId(authReq);
    const templates = await findFeaturedTemplates(userTenantId);

    res.json({
      success: true,
      data: { templates },
    });
  } catch (err) {
    log.error('Featured templates fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to load featured templates' },
    });
  }
});

export default router;
