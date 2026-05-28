/**
 * AI4W Internal Discovery & Provisioning Routes
 *
 * Provides service-to-service APIs for AI4W to discover ABL tenants/projects
 * and auto-provision channel connections. Protected by dual-layer auth:
 * AI4W JWT + X-Service-Token header.
 *
 * GET    /tenants/by-membership?email={email}                             Tenants accessible to the email
 * GET    /tenants/:tenantId/projects/discoverable                         Projects the caller can access
 * POST   /channel-connections/provision                                    Project-level auto-provisioning
 * POST   /channel-connections/:connectionId/deactivate                     Soft-disable an ai4w connection
 * DELETE /channel-connections/:connectionId                                Hard-remove an ai4w connection
 *
 * NOTE: GET /connections/:connectionId/info was moved to
 *       `GET /api/v1/channels/ai4w/:connectionId/info` (public namespace,
 *       HMAC + JWT auth — see apps/runtime/src/routes/ai4w-channel.ts).
 *
 * Gated by AI4W_INTERNAL_API_ENABLED env var in server.ts.
 */

import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { verifyAI4WJWT, getAI4WAuthHealth } from '../channels/adapters/ai4w-auth.js';
import { generateConnectionId, generateConnectionSecret } from '../channels/adapters/ai4w-types.js';
import type { AI4WJWTClaims } from '../channels/adapters/ai4w-types.js';
import {
  assertAllowedCallbackUrl,
  CallbackUrlError,
} from '../channels/security/callback-url-policy.js';
import { isTenantEncryptionReady } from '@agent-platform/shared/encryption';
import { VALID_ENVIRONMENTS } from '@agent-platform/config';
import { findDeploymentById } from '../repos/deployment-repo.js';

const log = createLogger('ai4w-internal-discovery');

const DEFAULT_PROJECT_PAGE_SIZE = 50;
const MAX_PROJECT_PAGE_SIZE = 200;

// =============================================================================
// REQUEST EXTENSION
// =============================================================================

interface AI4WServiceRequest extends Request {
  ai4wClaims: AI4WJWTClaims;
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

// `email` is optional — when supplied it MUST match the JWT claim (we use it
// only for cross-checking and tracing). The lookup itself always uses the
// verified JWT claim, never the query parameter.
const EmailQuerySchema = z.object({
  email: z.string().email().optional(),
});

const TenantIdParamSchema = z.object({
  tenantId: z.string().min(1),
});

const ConnectionIdParamSchema = z.object({
  connectionId: z.string().min(1),
});

const ProjectsDiscoverableQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PROJECT_PAGE_SIZE).optional(),
  cursor: z.string().min(1).optional(),
  q: z.string().min(1).max(200).optional(),
  sort: z.enum(['name', 'recent']).optional(),
});

const ProvisionBodySchema = z
  .object({
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    connectionName: z.string().min(1).max(100).optional(),
    environment: z.enum(VALID_ENVIRONMENTS).optional(),
    deploymentId: z.string().min(1).optional(),
    callbackBaseUrl: z.string().url().max(2048),
    responseMode: z.enum(['sync', 'stream', 'async']).optional(),
  })
  .strict()
  .refine((v) => !(v.environment && v.deploymentId), {
    message: '`environment` and `deploymentId` are mutually exclusive',
    path: ['environment'],
  });

// =============================================================================
// SERVICE AUTH MIDDLEWARE
// =============================================================================

/**
 * Verify AI4W service authentication: X-Service-Token + JWT.
 *
 * 1. Timing-safe comparison of X-Service-Token against AI4W_SERVICE_TOKEN env var
 * 2. JWT verification via verifyAI4WJWT (JWKS-backed)
 * 3. Attaches JWT claims to req.ai4wClaims
 */
export async function verifyAI4WServiceAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const serviceToken = req.headers['x-service-token'];
  const expectedToken = process.env.AI4W_SERVICE_TOKEN;

  if (!expectedToken) {
    log.error('AI4W_SERVICE_TOKEN env var not configured');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Service authentication not configured' },
    });
    return;
  }

  if (typeof serviceToken !== 'string' || serviceToken.length === 0) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing service token' },
    });
    return;
  }

  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  const receivedBuf = Buffer.from(serviceToken, 'utf8');

  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid service token' },
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing authorization header' },
    });
    return;
  }

  const jwtToken = authHeader.slice(7);
  try {
    const claims = await verifyAI4WJWT(jwtToken);
    (req as AI4WServiceRequest).ai4wClaims = claims;
    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('AI4W JWT verification failed on internal API', { error: message });
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired JWT' },
    });
  }
}

// =============================================================================
// PAGINATION HELPERS (keyset on (name, _id))
// =============================================================================

interface ProjectCursor {
  name: string;
  id: string;
}

function encodeCursor(cursor: ProjectCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): ProjectCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.name === 'string' && typeof parsed?.id === 'string') {
      return { name: parsed.name, id: parsed.id };
    }
  } catch {
    // fall through
  }
  return null;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =============================================================================
// ROUTER
// =============================================================================

const router: ReturnType<typeof Router> = Router();

// =============================================================================
// GET /auth/health  —  service-token-only (no JWT required)
// =============================================================================
//
// Operational visibility for the lazy-issuer registry. The point of this
// endpoint is to diagnose JWT verification outages, so it CANNOT depend on
// JWT verification itself. We require only the service token (the same
// shared secret that gates the rest of the internal API surface).
router.get('/auth/health', (req: Request, res: Response) => {
  const expectedToken = process.env.AI4W_SERVICE_TOKEN;
  if (!expectedToken) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Service authentication not configured' },
    });
    return;
  }

  const serviceToken = req.headers['x-service-token'];
  if (typeof serviceToken !== 'string' || serviceToken.length === 0) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing service token' },
    });
    return;
  }

  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  const receivedBuf = Buffer.from(serviceToken, 'utf8');
  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid service token' },
    });
    return;
  }

  res.status(200).json({ success: true, data: getAI4WAuthHealth() });
});

// Apply service+JWT auth to all subsequent routes
router.use(verifyAI4WServiceAuth);

// =============================================================================
// GET /tenants/by-membership?email={email}
// =============================================================================

router.get('/tenants/by-membership', async (req: Request, res: Response) => {
  const parsed = EmailQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid email query parameter' },
    });
    return;
  }

  const claims = (req as AI4WServiceRequest).ai4wClaims;
  const queryEmail = parsed.data.email;

  // Identity is the verified JWT claim — never the query string. The query
  // parameter is preserved for trace correlation only; if supplied it must
  // match the JWT claim exactly (case-insensitive) so a misbehaving caller
  // cannot probe other users' tenant memberships behind a valid token.
  if (queryEmail && queryEmail.toLowerCase() !== claims.email.toLowerCase()) {
    log.warn('AI4W by-membership email/JWT mismatch', {
      jwtEmail: claims.email,
      queryEmail,
    });
    res.status(403).json({
      success: false,
      error: {
        code: 'EMAIL_MISMATCH',
        message: 'Query email does not match authenticated identity',
      },
    });
    return;
  }

  try {
    const { User, TenantMember, Tenant } = await import('@agent-platform/database/models');
    const user = await User.findOne({ email: claims.email }).lean();

    if (!user) {
      res.json({ success: true, data: { tenants: [] } });
      return;
    }

    const memberships = await TenantMember.find({
      userId: user._id,
      status: 'active',
    }).lean();

    if (memberships.length === 0) {
      res.json({ success: true, data: { tenants: [] } });
      return;
    }

    const tenantIds = memberships.map((m: { tenantId: string }) => m.tenantId);

    const tenants = await Tenant.find({
      _id: { $in: tenantIds },
      status: 'active',
    })
      .select('_id name')
      .sort({ name: 1 })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    const tenantList = tenants.map((t: { _id: string; name: string }) => ({
      id: t._id,
      name: t.name,
    }));

    res.json({ success: true, data: { tenants: tenantList } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to query tenant memberships', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to query tenant memberships' },
    });
  }
});

// =============================================================================
// GET /tenants/:tenantId/projects/discoverable
// =============================================================================

router.get('/tenants/:tenantId/projects/discoverable', async (req: Request, res: Response) => {
  const paramParsed = TenantIdParamSchema.safeParse(req.params);
  if (!paramParsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Valid tenantId parameter is required' },
    });
    return;
  }

  const queryParsed = ProjectsDiscoverableQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid query parameters',
        details: queryParsed.error.issues,
      },
    });
    return;
  }

  const { tenantId } = paramParsed.data;
  const { limit: rawLimit, cursor: cursorRaw, q, sort } = queryParsed.data;
  const limit = rawLimit ?? DEFAULT_PROJECT_PAGE_SIZE;
  const sortMode = sort ?? 'name';
  const claims = (req as AI4WServiceRequest).ai4wClaims;

  try {
    const { User, TenantMember, ProjectMember, Project, ProjectAgent } =
      await import('@agent-platform/database/models');

    const user = await User.findOne({ email: claims.email }).lean();
    if (!user) {
      res.json({ success: true, data: { projects: [], nextCursor: null } });
      return;
    }

    const membership = await TenantMember.findOne({
      tenantId,
      userId: user._id,
      status: 'active',
    }).lean();

    if (!membership) {
      res.json({ success: true, data: { projects: [], nextCursor: null } });
      return;
    }

    const memberRole = (membership as { role?: string }).role;
    const isTenantAdmin = memberRole === 'ADMIN' || memberRole === 'OWNER';

    const projectFilter: Record<string, unknown> = { tenantId };

    if (!isTenantAdmin) {
      // Scope to tenantId — a dual-tenant user must only see memberships
      // for the tenant being queried.
      const projectMemberships = await ProjectMember.find({
        userId: user._id,
        tenantId,
      }).lean();
      if (projectMemberships.length === 0) {
        res.json({ success: true, data: { projects: [], nextCursor: null } });
        return;
      }
      projectFilter._id = {
        $in: projectMemberships.map((pm: { projectId: string }) => pm.projectId),
      };
    }

    if (q) {
      const pattern = escapeRegex(q);
      projectFilter.$or = [
        { name: { $regex: pattern, $options: 'i' } },
        { description: { $regex: pattern, $options: 'i' } },
      ];
    }

    // Keyset pagination on (name, _id) for sortMode === 'name'; on (updatedAt, _id) for 'recent'
    let cursor: ProjectCursor | null = null;
    if (cursorRaw) {
      cursor = decodeCursor(cursorRaw);
      if (!cursor) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid cursor' },
        });
        return;
      }
    }

    if (cursor) {
      if (sortMode === 'name') {
        projectFilter.$and = [
          ...((projectFilter.$and as unknown[] | undefined) ?? []),
          {
            $or: [{ name: { $gt: cursor.name } }, { name: cursor.name, _id: { $gt: cursor.id } }],
          },
        ];
      } else {
        // sortMode 'recent' — cursor.name holds ISO updatedAt string
        projectFilter.$and = [
          ...((projectFilter.$and as unknown[] | undefined) ?? []),
          {
            $or: [
              { updatedAt: { $lt: new Date(cursor.name) } },
              { updatedAt: new Date(cursor.name), _id: { $gt: cursor.id } },
            ],
          },
        ];
      }
    }

    const sortSpec: Record<string, 1 | -1> =
      sortMode === 'name' ? { name: 1, _id: 1 } : { updatedAt: -1, _id: 1 };

    const projects = await Project.find(projectFilter)
      .select('_id name description updatedAt')
      .sort(sortSpec)
      .collation({ locale: 'en', strength: 2 })
      .limit(limit + 1)
      .lean();

    const hasMore = projects.length > limit;
    const page = hasMore ? projects.slice(0, limit) : projects;

    // Live agentCount per project — count of agents (ProjectAgent documents) in each project
    const projectIds = page.map((p: { _id: string }) => p._id);
    const counts = projectIds.length
      ? await ProjectAgent.aggregate([
          { $match: { tenantId, projectId: { $in: projectIds } } },
          { $group: { _id: '$projectId', count: { $sum: 1 } } },
        ])
      : [];
    const countByProject = new Map<string, number>(
      counts.map((c: { _id: string; count: number }) => [c._id, c.count]),
    );

    const projectList = page.map(
      (p: { _id: string; name: string; description: string | null }) => ({
        id: p._id,
        name: p.name,
        description: p.description ?? '',
        agentCount: countByProject.get(p._id) ?? 0,
      }),
    );

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = page[page.length - 1] as {
        _id: string;
        name: string;
        updatedAt?: Date;
      };
      nextCursor =
        sortMode === 'name'
          ? encodeCursor({ name: last.name, id: last._id })
          : encodeCursor({
              name: (last.updatedAt ?? new Date(0)).toISOString(),
              id: last._id,
            });
    }

    res.json({ success: true, data: { projects: projectList, nextCursor } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to query discoverable projects', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to query discoverable projects' },
    });
  }
});

// =============================================================================
// GET /tenants/:tenantId/projects/:projectId/environments
// =============================================================================

const ProjectIdParamSchema = z.object({
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
});

router.get(
  '/tenants/:tenantId/projects/:projectId/environments',
  async (req: Request, res: Response) => {
    const paramParsed = ProjectIdParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Valid tenantId and projectId parameters are required',
        },
      });
      return;
    }

    const { tenantId, projectId } = paramParsed.data;
    const claims = (req as AI4WServiceRequest).ai4wClaims;

    try {
      const { User, TenantMember, ProjectMember, Project, Deployment } =
        await import('@agent-platform/database/models');

      const user = await User.findOne({ email: claims.email }).lean();
      if (!user) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'User not found' },
        });
        return;
      }

      const membership = await TenantMember.findOne({
        tenantId,
        userId: user._id,
        status: 'active',
      }).lean();

      if (!membership) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'No access to specified tenant' },
        });
        return;
      }

      const memberRole = (membership as { role?: string }).role;
      const isTenantAdmin = memberRole === 'ADMIN' || memberRole === 'OWNER';

      const project = await Project.findOne({ _id: projectId, tenantId }).select('_id').lean();
      if (!project) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Project not found in tenant' },
        });
        return;
      }

      if (!isTenantAdmin) {
        const projectMembership = await ProjectMember.findOne({
          tenantId,
          projectId,
          userId: user._id,
        }).lean();
        if (!projectMembership) {
          res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'No access to specified project' },
          });
          return;
        }
      }

      const envNames: string[] = await Deployment.distinct('environment', {
        tenantId,
        projectId,
      });

      const environments = envNames
        .filter((e): e is string => typeof e === 'string' && e.length > 0)
        .sort();

      res.json({
        success: true,
        data: { environments },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to query project environments', { error: message, tenantId, projectId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to query project environments' },
      });
    }
  },
);

// =============================================================================
// POST /channel-connections/provision
// =============================================================================

router.post('/channel-connections/provision', async (req: Request, res: Response) => {
  const parsed = ProvisionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid provisioning request',
        details: parsed.error.issues,
      },
    });
    return;
  }

  const {
    tenantId,
    projectId,
    connectionName,
    environment,
    deploymentId,
    callbackBaseUrl,
    responseMode,
  } = parsed.data;

  try {
    const isProduction = process.env.NODE_ENV === 'production';
    await assertAllowedCallbackUrl(callbackBaseUrl, isProduction);
  } catch (err: unknown) {
    if (err instanceof CallbackUrlError) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_CALLBACK_URL', message: 'Callback URL failed SSRF validation' },
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('Unexpected error during callback URL validation', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to validate callback URL' },
    });
    return;
  }

  try {
    const claims = (req as AI4WServiceRequest).ai4wClaims;
    const { User, TenantMember, ProjectMember, Project, ChannelConnection } =
      await import('@agent-platform/database/models');

    const user = await User.findOne({ email: claims.email }).lean();
    if (!user) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'User not found' },
      });
      return;
    }

    const membership = await TenantMember.findOne({
      tenantId,
      userId: user._id,
      status: 'active',
    }).lean();

    if (!membership) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'No access to specified tenant' },
      });
      return;
    }
    const memberRole = (membership as { role?: string }).role;
    const isTenantAdmin = memberRole === 'ADMIN' || memberRole === 'OWNER';

    // Confirm the project actually belongs to the tenant
    const project = await Project.findOne({ _id: projectId, tenantId }).select('_id name').lean();
    if (!project) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Project not found in tenant' },
      });
      return;
    }

    if (!isTenantAdmin) {
      const projectMembership = await ProjectMember.findOne({
        tenantId,
        projectId,
        userId: user._id,
      }).lean();
      if (!projectMembership) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'No access to specified project' },
        });
        return;
      }
    }

    if (deploymentId) {
      const deployment = await findDeploymentById(deploymentId, projectId, tenantId);
      if (!deployment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Deployment not found in project' },
        });
        return;
      }
    }

    // Default connectionName → "Connection <N+1>" based on existing ai4w connections in this project
    let displayName = connectionName;
    if (!displayName) {
      const existingCount = await ChannelConnection.countDocuments({
        tenantId,
        projectId,
        channelType: 'ai4w',
      });
      displayName = `Connection ${existingCount + 1}`;
    }

    // Fail-fast on provisioning when tenant encryption isn't ready — a
    // connection persisted with null credentials can never authenticate,
    // producing silently broken rows. Return 503 so AI4W can retry.
    if (!isTenantEncryptionReady()) {
      log.error('Tenant encryption not ready during AI4W provision', {
        tenantId,
        projectId,
      });
      res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Tenant encryption not ready — please retry',
        },
      });
      return;
    }

    const connectionId = generateConnectionId();
    const connectionSecret = generateConnectionSecret();
    const externalIdentifier = crypto.randomUUID();

    const connection = await ChannelConnection.create({
      tenantId,
      projectId,
      agentId: null,
      deploymentId: deploymentId ?? null,
      environment: deploymentId ? null : (environment ?? null),
      channelType: 'ai4w',
      connectionId,
      displayName,
      externalIdentifier,
      // ChannelConnection's encryption plugin encrypts this field on save.
      encryptedCredentials: JSON.stringify({ connectionSecret }),
      status: 'active',
      config: {
        callbackBaseUrl,
        responseMode: responseMode ?? 'stream',
        ai4wAccountId: null,
        provisionedBy: 'api',
        lastUsedAt: null,
      },
    });

    log.info('AI4W connection provisioned', {
      connectionId,
      tenantId,
      projectId,
      deploymentId: deploymentId ?? null,
      environment: deploymentId ? null : (environment ?? null),
      connectionDbId: connection._id,
    });

    res.status(201).json({
      success: true,
      data: {
        connectionId,
        connectionSecret,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to provision AI4W connection', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to provision connection' },
    });
  }
});

// Note: /connections/:connectionId/info was moved to the public channel
// namespace — it now lives at `GET /api/v1/channels/ai4w/:connectionId/info`
// and uses HMAC + JWT auth (same as /message). The move lets callers that
// hold the connection credentials fetch metadata without the internal
// service token. See apps/runtime/src/routes/ai4w-channel.ts.

// =============================================================================
// Shared: service-auth + tenant-membership check (for lifecycle endpoints)
// =============================================================================

async function assertTenantAccessOnConnection(
  req: Request,
  res: Response,
  connectionId: string,
): Promise<{ tenantId: string; connection: any } | null> {
  const claims = (req as AI4WServiceRequest).ai4wClaims;
  const { User, TenantMember, ChannelConnection } = await import('@agent-platform/database/models');

  const connection = await ChannelConnection.findOne({
    connectionId,
    channelType: 'ai4w',
  }).lean();

  if (!connection) {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Connection not found' },
    });
    return null;
  }

  const user = await User.findOne({ email: claims.email }).lean();
  if (!user) {
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'User not found' },
    });
    return null;
  }

  const membership = await TenantMember.findOne({
    tenantId: connection.tenantId,
    userId: user._id,
    $or: [{ status: 'active' }, { status: { $exists: false } }],
  }).lean();

  if (!membership) {
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to the connection tenant' },
    });
    return null;
  }

  return { tenantId: connection.tenantId, connection };
}

// =============================================================================
// POST /channel-connections/:connectionId/deactivate
// =============================================================================

router.post(
  '/channel-connections/:connectionId/deactivate',
  async (req: Request, res: Response) => {
    const parsed = ConnectionIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Valid connectionId parameter is required' },
      });
      return;
    }

    const { connectionId } = parsed.data;

    try {
      const access = await assertTenantAccessOnConnection(req, res, connectionId);
      if (!access) return;

      const { ChannelConnection } = await import('@agent-platform/database/models');
      const result = await ChannelConnection.updateOne(
        { connectionId, channelType: 'ai4w', tenantId: access.tenantId },
        { $set: { status: 'inactive' } },
      );

      log.info('AI4W connection deactivated', {
        connectionId,
        tenantId: access.tenantId,
        matched: result.matchedCount ?? result.n,
      });

      res.json({ success: true, data: { status: 'inactive' } });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to deactivate AI4W connection', { error: message, connectionId });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to deactivate connection' },
      });
    }
  },
);

// =============================================================================
// DELETE /channel-connections/:connectionId
// =============================================================================

router.delete('/channel-connections/:connectionId', async (req: Request, res: Response) => {
  const parsed = ConnectionIdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Valid connectionId parameter is required' },
    });
    return;
  }

  const { connectionId } = parsed.data;

  try {
    const access = await assertTenantAccessOnConnection(req, res, connectionId);
    if (!access) return;

    const { ChannelConnection } = await import('@agent-platform/database/models');
    const result = await ChannelConnection.deleteOne({
      connectionId,
      channelType: 'ai4w',
      tenantId: access.tenantId,
    });

    log.info('AI4W connection deleted', {
      connectionId,
      tenantId: access.tenantId,
      deletedCount: result.deletedCount ?? result.n,
    });

    res.json({ success: true, data: { deleted: true } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to delete AI4W connection', { error: message, connectionId });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete connection' },
    });
  }
});

export default router;
