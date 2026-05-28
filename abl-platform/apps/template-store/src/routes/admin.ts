/**
 * Admin Routes
 *
 * Protected CRUD API for template management.
 * All endpoints require authentication via `requireAuth` middleware (mounted at app level).
 *
 * Ownership model:
 *   - Super-admins manage platform-scoped templates (publisherTenantId = 'platform')
 *   - Workspace admins manage tenant-scoped templates (publisherTenantId = their tenantId)
 *
 * Endpoints:
 *   POST   /templates/upload  — Upload and create a template from a project bundle
 *   GET    /templates         — List templates for admin management
 *   GET    /templates/:id     — Get a single template by ID (admin detail)
 *   PATCH  /templates/:id     — Update template metadata
 *   DELETE /templates/:id     — Soft-delete (archive) a template
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { createLogger } from '@agent-platform/shared-observability';
import { readFolderV2, validateAgentSyntax } from '@agent-platform/project-io/import';
import type { TenantContextData, AuthUser } from '@agent-platform/shared-auth';
import {
  findTemplatesForAdmin,
  findTemplateByIdForAdmin,
  updateTemplate,
  archiveTemplate,
  createTemplate,
  createTemplateVersion,
  findTemplateBySlugUnfiltered,
} from '../repos/template-repo.js';

const log = createLogger('admin-routes');

// ─── Constants ─────────────────────────────────────────────────────────────

/** Maximum bundle size in bytes (4MB) */
const MAX_BUNDLE_SIZE_BYTES = 4 * 1024 * 1024;

// ─── Validation Schemas ────────────────────────────────────────────────────

// Coerce empty/whitespace-only strings to undefined before validation so .optional() accepts them
const coerceEmpty = (val: unknown) =>
  typeof val === 'string' && val.trim() === '' ? undefined : val;

const UploadBodySchema = z.object({
  files: z.record(z.string(), z.string()),
  metadata: z
    .object({
      name: z.preprocess(coerceEmpty, z.string().min(1).max(100).optional()),
      shortDescription: z.preprocess(coerceEmpty, z.string().max(500).optional()),
      longDescription: z.preprocess(coerceEmpty, z.string().max(5000).optional()),
      category: z.preprocess(coerceEmpty, z.string().min(1).max(50).optional()),
      tags: z.array(z.string()).max(20).optional(),
      complexity: z.preprocess(coerceEmpty, z.enum(['starter', 'standard', 'advanced']).optional()),
      type: z.preprocess(coerceEmpty, z.enum(['agent', 'project']).optional()),
    })
    .optional(),
  // Explicit publisherTenantId override — used by superadmin BFF to force 'platform' scope.
  // When provided, overrides the auth-derived tenant context.
  publisherTenantId: z.string().min(1).optional(),
});

const AdminListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['published', 'draft', 'archived']).optional(),
  // Explicit publisherTenantId override — used by superadmin BFF to force 'platform' scope
  publisherTenantId: z.string().min(1).optional(),
});

const UpdateBodySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  shortDescription: z.string().max(500).optional(),
  longDescription: z.string().max(5000).optional(),
  category: z.string().min(1).max(50).optional(),
  tags: z.array(z.string()).max(20).optional(),
  complexity: z.enum(['starter', 'standard', 'advanced']).optional(),
  demoConversation: z
    .array(
      z.object({
        role: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
  featuredOrder: z.number().nullable().optional(),
  status: z.enum(['published', 'draft', 'archived']).optional(),
  reviewStatus: z.enum(['approved', 'pending', 'rejected']).optional(),
});

const IdParamSchema = z.object({
  id: z.string().min(1),
});

// ─── Types ─────────────────────────────────────────────────────────────────

interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  tenantContext?: TenantContextData;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Generate a URL-safe slug from a name.
 */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

/**
 * Generate a unique slug by appending a short random suffix if needed.
 */
async function generateUniqueSlug(name: string): Promise<string> {
  const baseSlug = generateSlug(name);
  const existing = await findTemplateBySlugUnfiltered(baseSlug);
  if (!existing) {
    return baseSlug;
  }
  // Append short random suffix for uniqueness
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${baseSlug}-${suffix}`;
}

/**
 * Resolve the publisherTenantId from the request auth context.
 * Super-admins publish to 'platform'; others publish to their tenantId.
 */
function resolvePublisherTenantId(tenantContext: TenantContextData | undefined): string | null {
  if (!tenantContext) return null;
  if (tenantContext.isSuperAdmin) return 'platform';
  return tenantContext.tenantId ?? null;
}

/**
 * Safely parse project.json manifest from a files bundle.
 */
function parseManifest(files: Record<string, string>): Record<string, unknown> | null {
  const manifestContent = files['project.json'];
  if (!manifestContent) return null;
  try {
    return JSON.parse(manifestContent) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract agent info from the manifest's agents section.
 */
function extractAgentsFromManifest(
  manifest: Record<string, unknown>,
): Array<{ name: string; description?: string }> {
  const agents: Array<{ name: string; description?: string }> = [];
  const agentsSection = manifest.agents as Record<string, unknown> | undefined;
  if (!agentsSection || typeof agentsSection !== 'object') return agents;

  for (const [name, meta] of Object.entries(agentsSection)) {
    const desc =
      meta && typeof meta === 'object' && 'description' in meta
        ? String((meta as Record<string, unknown>).description)
        : undefined;
    agents.push({ name, description: desc });
  }
  return agents;
}

/**
 * Extract tool names from the manifest.
 */
function extractToolsFromManifest(manifest: Record<string, unknown>): string[] {
  const tools = manifest.tools as Record<string, unknown> | undefined;
  if (!tools || typeof tools !== 'object') return [];
  return Object.keys(tools);
}

/**
 * Extract environment variable names from manifest metadata.
 */
function extractEnvVarsFromManifest(manifest: Record<string, unknown>): string[] {
  const metadata = manifest.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== 'object') return [];

  // Check for required_env_vars or env_vars in metadata
  const envVars = metadata.required_env_vars ?? metadata.env_vars;
  if (Array.isArray(envVars)) {
    return envVars.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

// ─── Router ────────────────────────────────────────────────────────────────

const router: RouterType = Router();

/**
 * POST /templates/upload — Upload and create a template from a project bundle
 */
router.post('/templates/upload', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;

    // 1. Parse and validate body
    const parsed = UploadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parsed.error.issues,
        },
      });
      return;
    }

    const { files, metadata, publisherTenantId: explicitPublisherTenantId } = parsed.data;

    // 2. Validate bundle size
    const bundleSize = JSON.stringify(files).length;
    if (bundleSize > MAX_BUNDLE_SIZE_BYTES) {
      res.status(400).json({
        success: false,
        error: {
          code: 'BUNDLE_TOO_LARGE',
          message: `Bundle size ${bundleSize} bytes exceeds maximum of ${MAX_BUNDLE_SIZE_BYTES} bytes`,
        },
      });
      return;
    }

    // 3. Validate folder structure via readFolderV2
    const fileMap = new Map(Object.entries(files));
    const folderResult = readFolderV2(fileMap);
    const warnings: string[] = [...folderResult.warnings];

    if (!folderResult.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_BUNDLE',
          message: 'Bundle validation failed',
          details: folderResult.errors,
        },
      });
      return;
    }

    // 4. Validate agent syntax for each agent file
    const syntaxErrors: Array<{ file: string; errors: Array<{ line: number; message: string }> }> =
      [];
    for (const [path, content] of folderResult.agentFiles) {
      const errors = validateAgentSyntax(path, content);
      if (errors.length > 0) {
        syntaxErrors.push({ file: path, errors });
      }
    }

    if (syntaxErrors.length > 0) {
      res.status(400).json({
        success: false,
        error: {
          code: 'SYNTAX_ERROR',
          message: 'Agent files contain syntax errors',
          details: syntaxErrors,
        },
      });
      return;
    }

    // 5. Parse manifest to auto-extract metadata
    const manifest = parseManifest(files);
    const agents = manifest ? extractAgentsFromManifest(manifest) : [];
    const tools = manifest ? extractToolsFromManifest(manifest) : [];
    const envVars = manifest ? extractEnvVarsFromManifest(manifest) : [];

    const manifestName = manifest?.name ?? manifest?.project_name;
    const templateName =
      metadata?.name ??
      (typeof manifestName === 'string' ? manifestName : null) ??
      'Untitled Template';

    const manifestDescription = manifest?.description;
    const templateDescription =
      metadata?.shortDescription ??
      (typeof manifestDescription === 'string' && manifestDescription
        ? manifestDescription
        : null) ??
      `Template based on ${templateName}`;

    const entryAgent = typeof manifest?.entry_agent === 'string' ? manifest.entry_agent : undefined;

    // 6. Determine type
    let templateType: 'agent' | 'project';
    if (metadata?.type) {
      templateType = metadata.type;
    } else if (agents.length > 1) {
      templateType = 'project';
    } else {
      templateType = 'agent';
    }

    // 7. Resolve publisher context
    // Explicit override (from superadmin BFF) takes priority over auth-derived context
    const publisherTenantId =
      explicitPublisherTenantId ?? resolvePublisherTenantId(authReq.tenantContext);
    if (!publisherTenantId) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Unable to resolve publisher context',
        },
      });
      return;
    }

    const publisherId = authReq.user?.id ?? authReq.tenantContext?.userId ?? 'unknown';
    const publisherName = authReq.user?.name ?? authReq.user?.email ?? 'Unknown Publisher';

    // 8. Generate unique slug
    const slug = await generateUniqueSlug(templateName);

    // 9. Build prerequisites from manifest
    const prerequisites = {
      envVars,
      connectors: [] as string[],
      mcpServers: [] as string[],
      authProfiles: [] as string[],
      models: [] as string[],
    };

    // 10. Create Template document
    const template = await createTemplate({
      slug,
      name: templateName,
      shortDescription: templateDescription,
      longDescription: metadata?.longDescription || templateDescription,
      type: templateType,
      category: metadata?.category ?? 'general',
      tags: metadata?.tags ?? [],
      complexity: metadata?.complexity ?? 'standard',
      publisherId,
      publisherTenantId,
      publisherName,
      publisherVerified: publisherTenantId === 'platform',
      visibility: 'public',
      status: 'published',
      reviewStatus: 'approved',
      prerequisites,
    });

    // 11. Create TemplateVersion
    const version = await createTemplateVersion({
      templateId: template._id,
      version: '1.0.0',
      changelog: 'Initial version',
      manifest: manifest ?? {},
      files,
      status: 'published',
      publishedAt: new Date(),
      createdBy: publisherId,
    });

    log.info('Template uploaded', {
      templateId: template._id,
      slug,
      name: templateName,
      type: templateType,
      publisherTenantId,
      agentCount: agents.length,
      toolCount: tools.length,
      versionId: version._id,
    });

    res.status(201).json({
      success: true,
      data: {
        template,
        version: {
          _id: version._id,
          version: version.version,
          status: version.status,
        },
        extracted: {
          agents,
          tools,
          envVars,
          entryAgent,
        },
        warnings,
      },
    });
  } catch (err) {
    log.error('Template upload failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to upload template' },
    });
  }
});

/**
 * GET /templates — List templates for admin management
 */
router.get('/templates', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;

    const parsed = AdminListQuerySchema.safeParse(req.query);
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

    const { page, limit, status, publisherTenantId: explicitPtid } = parsed.data;

    // Explicit override (from superadmin BFF) takes priority
    const publisherTenantId = explicitPtid ?? resolvePublisherTenantId(authReq.tenantContext);
    if (!publisherTenantId) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Unable to resolve publisher context',
        },
      });
      return;
    }

    const { templates, total } = await findTemplatesForAdmin({
      publisherTenantId,
      status,
      page,
      limit,
    });

    const hasMore = page * limit < total;

    res.json({
      success: true,
      data: {
        templates,
        total,
        page,
        limit,
        hasMore,
      },
    });
  } catch (err) {
    log.error('Admin list templates failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list templates' },
    });
  }
});

/**
 * GET /templates/:id — Get a single template by ID (admin detail view)
 */
router.get('/templates/:id', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;

    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid template ID' },
      });
      return;
    }

    const { id } = paramParsed.data;

    const publisherTenantId = resolvePublisherTenantId(authReq.tenantContext);
    if (!publisherTenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Unable to resolve publisher context' },
      });
      return;
    }

    const template = await findTemplateByIdForAdmin(id, publisherTenantId);
    if (!template) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Template not found' },
      });
      return;
    }

    res.json({
      success: true,
      data: { template },
    });
  } catch (err) {
    log.error('Admin get template detail failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get template' },
    });
  }
});

/**
 * PATCH /templates/:id — Update template metadata
 */
router.patch('/templates/:id', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;

    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid template ID',
        },
      });
      return;
    }

    const bodyParsed = UpdateBodySchema.safeParse(req.body);
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

    const { id } = paramParsed.data;
    const updates = bodyParsed.data;

    const publisherTenantId = resolvePublisherTenantId(authReq.tenantContext);
    if (!publisherTenantId) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Unable to resolve publisher context',
        },
      });
      return;
    }

    // Verify template exists and ownership matches
    const existing = await findTemplateByIdForAdmin(id, publisherTenantId);
    if (!existing) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Template not found' },
      });
      return;
    }

    // Build the update payload
    const updatePayload: Record<string, unknown> = { ...updates };

    // If name changed, update the slug
    if (updates.name && updates.name !== existing.name) {
      updatePayload.slug = await generateUniqueSlug(updates.name);
    }

    // If status changed to 'published', set publishedAt
    if (updates.status === 'published' && existing.status !== 'published') {
      updatePayload.publishedAt = new Date();
    }

    const updated = await updateTemplate(id, publisherTenantId, updatePayload);

    if (!updated) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Template not found' },
      });
      return;
    }

    log.info('Template updated', {
      templateId: id,
      fields: Object.keys(updates),
      publisherTenantId,
    });

    res.json({
      success: true,
      data: { template: updated },
    });
  } catch (err) {
    log.error('Template update failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update template' },
    });
  }
});

/**
 * DELETE /templates/:id — Soft-delete (archive) a template
 */
router.delete('/templates/:id', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;

    const paramParsed = IdParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid template ID',
        },
      });
      return;
    }

    const { id } = paramParsed.data;

    const publisherTenantId = resolvePublisherTenantId(authReq.tenantContext);
    if (!publisherTenantId) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Unable to resolve publisher context',
        },
      });
      return;
    }

    // Verify template exists and ownership matches
    const existing = await findTemplateByIdForAdmin(id, publisherTenantId);
    if (!existing) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Template not found' },
      });
      return;
    }

    const archived = await archiveTemplate(id, publisherTenantId);

    if (!archived) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Template not found' },
      });
      return;
    }

    log.info('Template archived', {
      templateId: id,
      slug: existing.slug,
      publisherTenantId,
    });

    res.json({
      success: true,
      data: { archived: true },
    });
  } catch (err) {
    log.error('Template archive failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to archive template' },
    });
  }
});

export default router;
