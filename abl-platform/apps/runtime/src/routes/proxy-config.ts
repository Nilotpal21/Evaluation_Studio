/**
 * Proxy Config Admin CRUD Routes
 *
 * REST API for managing organization-level proxy/gateway configurations.
 * All routes require authenticated tenant context + RBAC permissions.
 *
 * Actions: create, list, update, delete (hard delete).
 * Proxy credentials are encrypted at rest with tenant-scoped AES-256-GCM keys.
 */

import { Router, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import {
  createOrgProxyConfig,
  findOrgProxyConfigs,
  countOrgProxyConfigs,
  findOrgProxyConfigById,
  updateOrgProxyConfig,
  deleteOrgProxyConfig,
} from '@agent-platform/shared/repos';
import { writeAuditLog } from '../repos/auth-repo.js';
import { assertUrlSafeForSSRF, getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { tenantRateLimit } from '../middleware/rate-limiter.js';

const log = createLogger('proxy-config-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/proxy-configs',
  tags: ['Proxy Configs'],
});
const router: RouterType = openapi.router;

/** Maximum allowed length for PEM certificates (S8) */
const MAX_CERT_LENGTH = 65536; // 64KB
/** Maximum allowed length for name/pattern fields */
const MAX_FIELD_LENGTH = 1024;

// All proxy config routes require authentication + rate limiting
router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// ============================================================================
// Zod Schemas for Request/Response Validation
// ============================================================================

/**
 * Shared proxy config schema fields (read-only properties)
 */
const ProxyConfigMetadata = z.object({
  id: z.string().describe('Unique proxy config identifier'),
  name: z.string().describe('Configuration name'),
  proxyAuthType: z.enum(['none', 'basic', 'bearer', 'custom']).describe('Authentication type'),
  urlPatterns: z
    .string()
    .describe('URL patterns this config applies to (comma-separated or wildcard)'),
  bypassPatterns: z.string().nullable().describe('Patterns to bypass proxy (comma-separated)'),
  environment: z.string().describe('Environment (dev, staging, prod)'),
  priority: z.number().describe('Priority order for proxy selection'),
  enabled: z.boolean().describe('Whether this config is active'),
  createdAt: z.string().describe('ISO 8601 creation timestamp'),
  updatedAt: z.string().optional().describe('ISO 8601 last update timestamp'),
  createdBy: z.string().optional().describe('User ID who created this config'),
});

/**
 * Proxy config metadata with certificate flags
 */
const ProxyConfigMetadataWithCerts = ProxyConfigMetadata.extend({
  hasCaCertificate: z.boolean().describe('Whether CA certificate is present'),
  hasClientCert: z.boolean().describe('Whether client certificate is present'),
});

/**
 * POST /api/proxy-configs request body
 */
const CreateProxyConfigSchema = z
  .object({
    name: z.string().max(MAX_FIELD_LENGTH).describe('Configuration name'),
    proxyUrl: z.string().url().describe('Proxy server URL'),
    proxyAuthType: z
      .enum(['none', 'basic', 'bearer', 'custom'])
      .optional()
      .describe('Authentication type (default: none)'),
    username: z.string().optional().describe('Proxy username (for basic auth)'),
    password: z.string().optional().describe('Proxy password (for basic auth)'),
    token: z.string().optional().describe('Bearer token (for bearer auth)'),
    caCertificate: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('CA certificate in PEM format'),
    clientCert: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('Client certificate in PEM format'),
    clientKey: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('Client private key in PEM format'),
    urlPatterns: z.string().optional().describe('URL patterns this config applies to (default: *)'),
    bypassPatterns: z.string().optional().describe('Patterns to bypass proxy'),
    environment: z.string().optional().describe('Environment (default: dev)'),
    priority: z.number().int().optional().describe('Priority order (default: 0)'),
    enabled: z.boolean().optional().describe('Whether config is active (default: true)'),
  })
  .describe('Create proxy config request');

/**
 * PUT /api/proxy-configs/:id request body (all fields optional)
 */
const UpdateProxyConfigSchema = z
  .object({
    name: z.string().max(MAX_FIELD_LENGTH).optional().describe('Configuration name'),
    proxyUrl: z.string().url().optional().describe('Proxy server URL'),
    proxyAuthType: z
      .enum(['none', 'basic', 'bearer', 'custom'])
      .optional()
      .describe('Authentication type'),
    username: z.string().optional().describe('Proxy username (for basic auth)'),
    password: z.string().optional().describe('Proxy password (for basic auth)'),
    token: z.string().optional().describe('Bearer token (for bearer auth)'),
    caCertificate: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('CA certificate in PEM format'),
    clientCert: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('Client certificate in PEM format'),
    clientKey: z
      .string()
      .max(MAX_CERT_LENGTH)
      .optional()
      .describe('Client private key in PEM format'),
    urlPatterns: z.string().optional().describe('URL patterns this config applies to'),
    bypassPatterns: z.string().optional().describe('Patterns to bypass proxy'),
    priority: z.number().int().optional().describe('Priority order'),
    enabled: z.boolean().optional().describe('Whether config is active'),
  })
  .describe('Update proxy config request');

/**
 * POST /api/proxy-configs response
 */
const CreateProxyConfigResponseSchema = z
  .object({
    success: z.boolean(),
    config: ProxyConfigMetadataWithCerts.extend({
      proxyUrl: z.string().describe('Proxy server URL'),
    }),
  })
  .describe('Create proxy config response');

/**
 * GET /api/proxy-configs response
 */
const ListProxyConfigsResponseSchema = z
  .object({
    success: z.boolean(),
    configs: z.array(
      ProxyConfigMetadataWithCerts.extend({
        proxyUrl: z.string().describe('Proxy origin URL (masked for security)'),
      }),
    ),
    pagination: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  })
  .describe('List proxy configs response');

/**
 * PUT /api/proxy-configs/:id response
 */
const UpdateProxyConfigResponseSchema = z
  .object({
    success: z.boolean(),
    config: ProxyConfigMetadata.extend({
      proxyUrl: z.string().describe('Proxy server URL'),
    }),
  })
  .describe('Update proxy config response');

/**
 * DELETE /api/proxy-configs/:id response
 */
const DeleteProxyConfigResponseSchema = z
  .object({
    success: z.boolean(),
    deleted: z.string().describe('ID of deleted proxy config'),
  })
  .describe('Delete proxy config response');

/**
 * POST /api/proxy-configs — Create a new proxy configuration
 *
 * Requires 'proxy:write' permission (E1).
 * Proxy credentials are encrypted at rest with tenant-scoped AES-256-GCM keys.
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create a new proxy configuration',
    description:
      'Create a new organization-level proxy/gateway configuration. Proxy credentials are encrypted at rest. Requires proxy:write permission.',
    body: CreateProxyConfigSchema,
    response: CreateProxyConfigResponseSchema,
    successStatus: 201,
  },
  requirePermission('proxy:write'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const userId = req.tenantContext.userId;

      const {
        name,
        proxyUrl,
        proxyAuthType,
        username,
        password,
        token,
        caCertificate,
        clientCert,
        clientKey,
        urlPatterns,
        bypassPatterns,
        environment,
        priority,
        enabled,
      } = req.body;

      if (!name || !proxyUrl) {
        res.status(400).json({ success: false, error: 'Missing required fields: name, proxyUrl' });
        return;
      }

      // S8: Input length limits
      if (String(name).length > MAX_FIELD_LENGTH) {
        res.status(400).json({
          success: false,
          error: `Name exceeds maximum length of ${MAX_FIELD_LENGTH} characters`,
        });
        return;
      }
      if (caCertificate && String(caCertificate).length > MAX_CERT_LENGTH) {
        res.status(400).json({
          success: false,
          error: `CA certificate exceeds maximum length of ${MAX_CERT_LENGTH} characters`,
        });
        return;
      }
      if (clientCert && String(clientCert).length > MAX_CERT_LENGTH) {
        res
          .status(400)
          .json({ success: false, error: `Client certificate exceeds maximum length` });
        return;
      }
      if (clientKey && String(clientKey).length > MAX_CERT_LENGTH) {
        res.status(400).json({ success: false, error: `Client key exceeds maximum length` });
        return;
      }

      // Validate proxy URL for SSRF
      try {
        assertUrlSafeForSSRF(proxyUrl, getDevSSRFOptions());
      } catch (error: any) {
        res.status(400).json({ success: false, error: 'Invalid proxy URL' });
        return;
      }

      // Plugin encrypts all encrypted* fields transparently in pre-save hook
      const data = {
        tenantId,
        name,
        proxyUrl,
        proxyAuthType: proxyAuthType ?? 'none',
        urlPatterns: urlPatterns ?? '*',
        bypassPatterns: bypassPatterns ?? null,
        environment: environment ?? 'dev',
        priority: priority ?? 0,
        enabled: enabled ?? true,
        createdBy: userId,
        encryptedProxyUsername: username ?? undefined,
        encryptedProxyPassword: password ?? undefined,
        encryptedProxyToken: token ?? undefined,
        encryptedCaCertificate: caCertificate ?? undefined,
        encryptedClientCert: clientCert ?? undefined,
        encryptedClientKey: clientKey ?? undefined,
      };

      const config = await createOrgProxyConfig(data);

      log.info('Proxy config created', { name, tenantId, requestId });
      writeAuditLog({
        action: 'proxy-config:create',
        tenantId,
        userId,
        metadata: { name, environment: environment ?? 'dev', requestId },
      });

      res.status(201).json({
        success: true,
        config: {
          id: config.id,
          name: config.name,
          // S5: Only show proxyUrl hostname (not full URL) in response for non-admin
          proxyUrl: config.proxyUrl,
          proxyAuthType: config.proxyAuthType,
          urlPatterns: config.urlPatterns,
          bypassPatterns: config.bypassPatterns,
          environment: config.environment,
          priority: config.priority,
          enabled: config.enabled,
          hasCaCertificate: !!config.encryptedCaCertificate,
          hasClientCert: !!config.encryptedClientCert,
          createdAt: config.createdAt,
        },
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        res
          .status(409)
          .json({ success: false, error: 'Proxy config already exists for this name/environment' });
        return;
      }
      log.error('Failed to create proxy config', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to create proxy config' });
    }
  },
);

/**
 * GET /api/proxy-configs — List proxy configs (metadata only, no credentials)
 *
 * Query: { environment?, page?, limit? }
 * tenantId scoped from auth context.
 * Requires 'proxy:read' permission (E1).
 * S5: proxyUrl is always masked to origin-only (defense in depth).
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List proxy configurations',
    description:
      'List proxy configurations with optional filtering by environment. Metadata only, no credentials returned. proxyUrl is masked to origin for security. Supports pagination via query params.',
    response: ListProxyConfigsResponseSchema,
  },
  requirePermission('proxy:read'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const { environment } = req.query;

      const where = {
        tenantId,
        ...(environment ? { environment: String(environment) } : {}),
      };

      // U2: pagination
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10) || 25));
      const skip = (page - 1) * limit;

      const [configs, total] = await Promise.all([
        findOrgProxyConfigs(where, {
          select: {
            id: true,
            name: true,
            proxyUrl: true,
            proxyAuthType: true,
            urlPatterns: true,
            bypassPatterns: true,
            environment: true,
            priority: true,
            enabled: true,
            encryptedCaCertificate: true,
            encryptedClientCert: true,
            createdBy: true,
            createdAt: true,
            updatedAt: true,
          },
          skip,
          take: limit,
        }),
        countOrgProxyConfigs(where),
      ]);

      // Redact encrypted fields — only show boolean indicators
      // S5: Always mask proxyUrl to origin-only (no special super-admin override)
      const redacted = configs.map((c: any) => {
        let displayUrl: string;
        try {
          displayUrl = new URL(c.proxyUrl).origin;
        } catch {
          displayUrl = '[invalid-url]';
        }
        return {
          id: c.id,
          name: c.name,
          proxyUrl: displayUrl,
          proxyAuthType: c.proxyAuthType,
          urlPatterns: c.urlPatterns,
          bypassPatterns: c.bypassPatterns,
          environment: c.environment,
          priority: c.priority,
          enabled: c.enabled,
          hasCaCertificate: !!c.encryptedCaCertificate,
          hasClientCert: !!c.encryptedClientCert,
          createdBy: c.createdBy,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        };
      });

      log.info('Listed proxy configs', { tenantId, count: configs.length, requestId });

      res.json({
        success: true,
        configs: redacted,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      log.error('Failed to list proxy configs', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to list proxy configs' });
    }
  },
);

/**
 * PUT /api/proxy-configs/:id — Update a proxy config
 *
 * Requires 'proxy:write' permission (E1).
 * All fields are optional for partial updates.
 */
openapi.route(
  'put',
  '/:id',
  {
    summary: 'Update a proxy configuration',
    description:
      'Update an existing proxy configuration. All fields are optional for partial updates. Proxy credentials are re-encrypted if provided. Requires proxy:write permission.',
    body: UpdateProxyConfigSchema,
    response: UpdateProxyConfigResponseSchema,
  },
  requirePermission('proxy:write'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const userId = req.tenantContext.userId;

      const existing = await findOrgProxyConfigById(req.params.id, tenantId);

      if (!existing) {
        res.status(404).json({ success: false, error: 'Proxy config not found' });
        return;
      }

      const {
        name,
        proxyUrl,
        proxyAuthType,
        username,
        password,
        token,
        caCertificate,
        clientCert,
        clientKey,
        urlPatterns,
        bypassPatterns,
        priority,
        enabled,
      } = req.body;

      // S8: Input length limits
      if (caCertificate && String(caCertificate).length > MAX_CERT_LENGTH) {
        res.status(400).json({ success: false, error: 'CA certificate exceeds maximum length' });
        return;
      }

      // Validate new proxy URL if changed
      if (proxyUrl) {
        try {
          assertUrlSafeForSSRF(proxyUrl, getDevSSRFOptions());
        } catch {
          res.status(400).json({ success: false, error: 'Invalid proxy URL' });
          return;
        }
      }

      // Plugin encrypts all encrypted* fields transparently in pre-save hook
      const data: Record<string, unknown> = {};

      if (name !== undefined) data.name = name;
      if (proxyUrl !== undefined) data.proxyUrl = proxyUrl;
      if (proxyAuthType !== undefined) data.proxyAuthType = proxyAuthType;
      if (urlPatterns !== undefined) data.urlPatterns = urlPatterns;
      if (bypassPatterns !== undefined) data.bypassPatterns = bypassPatterns;
      if (priority !== undefined) data.priority = priority;
      if (enabled !== undefined) data.enabled = enabled;

      if (username !== undefined) data.encryptedProxyUsername = username || null;
      if (password !== undefined) data.encryptedProxyPassword = password || null;
      if (token !== undefined) data.encryptedProxyToken = token || null;
      if (caCertificate !== undefined) data.encryptedCaCertificate = caCertificate || null;
      if (clientCert !== undefined) data.encryptedClientCert = clientCert || null;
      if (clientKey !== undefined) data.encryptedClientKey = clientKey || null;

      const updated = await updateOrgProxyConfig(req.params.id, tenantId, data);

      if (!updated) {
        res.status(404).json({ success: false, error: 'Proxy config not found after update' });
        return;
      }

      log.info('Proxy config updated', { id: req.params.id, tenantId, requestId });
      writeAuditLog({
        action: 'proxy-config:update',
        tenantId,
        userId,
        metadata: { configId: req.params.id, name: existing.name, requestId },
      });

      res.json({
        success: true,
        config: {
          id: updated.id,
          name: updated.name,
          proxyUrl: updated.proxyUrl,
          proxyAuthType: updated.proxyAuthType,
          urlPatterns: updated.urlPatterns,
          environment: updated.environment,
          priority: updated.priority,
          enabled: updated.enabled,
          createdAt: updated.createdAt,
        },
      });
    } catch (error: any) {
      log.error('Failed to update proxy config', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to update proxy config' });
    }
  },
);

/**
 * DELETE /api/proxy-configs/:id — Delete a proxy config (hard delete, U3 fix)
 * Requires 'proxy:delete' permission (E1).
 */
openapi.route(
  'delete',
  '/:id',
  {
    summary: 'Delete a proxy configuration',
    description:
      'Permanently delete a proxy configuration. This action cannot be undone. Requires proxy:delete permission.',
    response: DeleteProxyConfigResponseSchema,
  },
  requirePermission('proxy:delete'),
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!req.tenantContext) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const tenantId = req.tenantContext.tenantId;
      const userId = req.tenantContext.userId;

      const existing = await findOrgProxyConfigById(req.params.id, tenantId);

      if (!existing) {
        res.status(404).json({ success: false, error: 'Proxy config not found' });
        return;
      }

      // U3: Hard delete instead of ambiguous soft-delete
      await deleteOrgProxyConfig(req.params.id, tenantId);

      log.info('Proxy config deleted', { id: req.params.id, tenantId, requestId });
      writeAuditLog({
        action: 'proxy-config:delete',
        tenantId,
        userId,
        metadata: { configId: req.params.id, name: existing.name, requestId },
      });

      res.json({ success: true, deleted: req.params.id });
    } catch (error: any) {
      log.error('Failed to delete proxy config', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to delete proxy config' });
    }
  },
);

export default router;
