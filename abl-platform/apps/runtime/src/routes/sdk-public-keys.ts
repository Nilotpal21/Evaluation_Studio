/**
 * SDK Public API Keys Route (Project-Scoped)
 *
 * Mounted at /api/projects/:projectId/sdk-public-keys
 *
 * GET    /         List SDK public keys for a project
 * POST   /         Create a new SDK public key (returns raw key once)
 * DELETE /:keyId   Revoke an SDK public key (soft delete)
 */

import crypto from 'crypto';
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { createLogger } from '@abl/compiler/platform';
import {
  createPublicApiKey,
  findPublicApiKey,
  findPublicApiKeys,
  updatePublicApiKey,
} from '../repos/channel-repo.js';
import { writeAuditLog } from '../repos/auth-repo.js';

const log = createLogger('sdk-public-keys-route');

const router: RouterType = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  allowedOrigins: z.array(z.string().url()).max(50).optional(),
  permissions: z
    .object({
      chat: z.boolean().default(true),
      voice: z.boolean().default(false),
    })
    .optional(),
  expiresAt: z.string().datetime().optional(),
});

function parseStringArray(value: unknown): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parsePermissions(value: unknown): Record<string, boolean> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, boolean>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, boolean>) : null;
}

function formatKey(doc: Record<string, unknown>, rawKey?: string) {
  return {
    id: doc.id || doc._id,
    projectId: doc.projectId,
    tenantId: doc.tenantId || null,
    keyPrefix: doc.keyPrefix,
    name: doc.name,
    allowedOrigins: parseStringArray(doc.allowedOrigins),
    permissions: parsePermissions(doc.permissions),
    isActive: doc.isActive ?? true,
    lastUsedAt: doc.lastUsedAt ?? null,
    createdAt: doc.createdAt ?? null,
    expiresAt: doc.expiresAt ?? null,
    ...(rawKey ? { key: rawKey } : {}),
  };
}

router.get('/', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'credential:read'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const keys = await findPublicApiKeys({ projectId, tenantId });

    res.json({
      success: true,
      keys: keys.map((key) => formatKey(key as unknown as Record<string, unknown>)),
    });
  } catch (err: unknown) {
    log.error('Failed to list SDK public keys', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'LIST_FAILED', message: 'Failed to list SDK public keys' },
    });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'credential:write'))) return;

    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Invalid request body' },
        details: parsed.error.issues,
      });
      return;
    }

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const rawKey = `pk_${crypto.randomBytes(24).toString('hex')}`;
    const keyPrefix = rawKey.slice(0, 11);
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const key = await createPublicApiKey({
      projectId,
      tenantId,
      keyPrefix,
      keyHash,
      name: parsed.data.name.trim(),
      allowedOrigins: parsed.data.allowedOrigins ?? null,
      permissions: parsed.data.permissions ?? { chat: true, voice: false },
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    });

    writeAuditLog({
      action: 'sdk-public-key:create',
      userId: req.tenantContext!.userId,
      tenantId,
      metadata: {
        projectId,
        keyId: key.id,
        keyPrefix,
      },
    });

    res.status(201).json({
      success: true,
      key: formatKey(key as unknown as Record<string, unknown>, rawKey),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: number }).code === 11000
    ) {
      res.status(409).json({
        success: false,
        error: { code: 'DUPLICATE_KEY', message: 'Generated key collided, retry request' },
      });
      return;
    }

    log.error('Failed to create SDK public key', { error: message });
    res.status(500).json({
      success: false,
      error: { code: 'CREATE_FAILED', message: 'Failed to create SDK public key' },
    });
  }
});

router.delete('/:keyId', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'credential:write'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const { keyId } = req.params;

    const existing = await findPublicApiKey({ id: keyId, projectId, tenantId });
    if (!existing) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'SDK public key not found' },
      });
      return;
    }

    const updated = await updatePublicApiKey(keyId, projectId, { isActive: false }, tenantId);
    if (!updated) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'SDK public key not found' },
      });
      return;
    }

    writeAuditLog({
      action: 'sdk-public-key:revoke',
      userId: req.tenantContext!.userId,
      tenantId,
      metadata: {
        projectId,
        keyId,
      },
    });

    res.json({ success: true });
  } catch (err: unknown) {
    log.error('Failed to revoke SDK public key', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'REVOKE_FAILED', message: 'Failed to revoke SDK public key' },
    });
  }
});

export default router;
