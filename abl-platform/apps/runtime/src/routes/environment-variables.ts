/**
 * Environment Variables CRUD Route
 *
 * Manages per-environment key-value configuration variables for projects.
 * Values are encrypted with tenant-scoped AES-256-GCM keys.
 * Referenced in ABL agent definitions as {{env.KEY}} placeholders.
 *
 * Mounted at /api/projects/:projectId/env-vars
 */

import { Router, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { requireProjectPermission } from '../middleware/rbac.js';
import {
  createLogger,
  MAX_ENV_VARS_PER_PROJECT,
  MAX_VARIABLE_NAMESPACES_PER_VARIABLE,
} from '@abl/compiler/platform';
import { VALID_ENVIRONMENTS, VALID_ENVIRONMENTS_WITH_GLOBAL } from '@agent-platform/config';
import {
  createEnvironmentVariable,
  findEnvironmentVariables,
  countEnvironmentVariables,
  findEnvironmentVariableById,
  findEnvironmentVariableByKey,
  updateEnvironmentVariable,
  deleteEnvironmentVariable,
  bulkUpsertEnvironmentVariables,
} from '../repos/security-repo.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import {
  addVariableNamespaceMemberships,
  deleteAllVariableNamespaceMembershipsForVariable,
  findVariableNamespaceMembershipsByVariableIds,
  findVariableNamespaceMembershipsByVariable,
} from '../repos/variable-namespace-membership-repo.js';
import {
  findDefaultVariableNamespace,
  getOrCreateDefaultNamespace,
  findVariableNamespaces,
  findVariableNamespaceById,
} from '../repos/variable-namespace-repo.js';

const log = createLogger('env-variables-route');

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/env-vars',
  tags: ['Environment Variables'],
});
const router: RouterType = openapi.router;

/** Maximum allowed length for variable values */
const MAX_VALUE_LENGTH = 16384; // 16KB
/** Maximum allowed length for variable keys */
const MAX_KEY_LENGTH = 256;
/** Maximum allowed length for descriptions */
const MAX_DESCRIPTION_LENGTH = 1024;
/** Valid key pattern: must start with a letter, then letters/digits/underscores only */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Normalize environment for API responses.
 * Internally we store 'global' for base/shared values, but the public API
 * uses null to represent environment-agnostic (base) variables.
 */
function envForResponse(env: string | null | undefined): string | null {
  return env === 'global' ? null : (env ?? null);
}

// All env-var routes require authentication + project scope
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

/**
 * POST /api/projects/:projectId/env-vars
 * Create a new environment variable.
 */
openapi.route(
  'post',
  '/',
  {
    summary: 'Create an environment variable',
    description: 'Create a new encrypted environment variable for a specific environment.',
    body: z.object({
      environment: z
        .enum(VALID_ENVIRONMENTS_WITH_GLOBAL)
        .nullable()
        .default('global')
        .describe('Target environment, "global" or null for shared base value'),
      key: z.string().max(MAX_KEY_LENGTH).describe('Variable key'),
      value: z.string().max(MAX_VALUE_LENGTH).describe('Variable value'),
      isSecret: z.boolean().optional().describe('Whether value should be masked in UI'),
      description: z
        .string()
        .max(MAX_DESCRIPTION_LENGTH)
        .optional()
        .describe('Human-readable description'),
    }),
    response: z.object({
      success: z.boolean(),
      variable: z.object({
        id: z.string(),
        key: z.string(),
        environment: z.string().nullable(),
        isSecret: z.boolean(),
        description: z.string().nullable(),
        createdAt: z.string(),
      }),
    }),
    successStatus: 201,
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!(await requireProjectPermission(req, res, 'env_var:create'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId;
      const { projectId } = req.params;
      const { key, value, isSecret, description } = req.body;
      // Accept null as a synonym for 'global' (base/shared value)
      const environment: string =
        req.body.environment === null || req.body.environment === undefined
          ? 'global'
          : req.body.environment;

      if (!key || value === undefined || value === null) {
        res
          .status(400)
          .json({ success: false, error: 'Missing required fields: environment, key, value' });
        return;
      }

      if (!VALID_ENVIRONMENTS_WITH_GLOBAL.includes(environment as any)) {
        res.status(400).json({
          success: false,
          error: `Invalid environment "${environment}". Must be one of: ${VALID_ENVIRONMENTS_WITH_GLOBAL.join(', ')}`,
        });
        return;
      }

      // Normalize to uppercase for case-insensitive uniqueness
      const normalizedKey = key.toUpperCase();

      if (!KEY_PATTERN.test(normalizedKey)) {
        res.status(400).json({
          success: false,
          error: 'Key must start with a letter and contain only letters, digits, and underscores',
        });
        return;
      }

      if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) {
        res.status(400).json({
          success: false,
          error: `Value exceeds maximum length of ${MAX_VALUE_LENGTH} characters`,
        });
        return;
      }

      if (String(key).length > MAX_KEY_LENGTH) {
        res
          .status(400)
          .json({ success: false, error: `Key must not exceed ${MAX_KEY_LENGTH} characters` });
        return;
      }

      // Check count limit
      const count = await countEnvironmentVariables({
        tenantId,
        projectId,
        environment,
      });
      if (count >= MAX_ENV_VARS_PER_PROJECT) {
        res.status(400).json({
          success: false,
          error: `Maximum of ${MAX_ENV_VARS_PER_PROJECT} environment variables per project reached`,
        });
        return;
      }

      // Plugin encrypts encryptedValue transparently in pre-save hook
      const variable = await createEnvironmentVariable({
        tenantId,
        projectId,
        environment,
        key: normalizedKey,
        encryptedValue: value,
        isSecret: isSecret ?? false,
        description: description ?? null,
        createdBy: userId,
      });

      // Create namespace memberships
      const variableNamespaceIds: string[] = req.body.variableNamespaceIds ?? [];
      if (variableNamespaceIds.length > MAX_VARIABLE_NAMESPACES_PER_VARIABLE) {
        res.status(400).json({
          success: false,
          error: `Cannot assign to more than ${MAX_VARIABLE_NAMESPACES_PER_VARIABLE} namespaces`,
        });
        return;
      }

      if (variableNamespaceIds.length > 0) {
        // Validate all variableNamespaceIds exist in this project
        for (const nsId of variableNamespaceIds) {
          const ns = await findVariableNamespaceById(nsId, tenantId);
          if (!ns || ns.projectId !== projectId) {
            res.status(400).json({
              success: false,
              error: `Namespace ${nsId} not found in this project`,
            });
            return;
          }
        }
        for (const nsId of variableNamespaceIds) {
          await addVariableNamespaceMemberships(tenantId, projectId, nsId, [
            { variableId: variable.id, variableType: 'env' },
          ]);
        }
      } else {
        // Default: auto-create default namespace if missing, then add membership
        const defaultNs = await getOrCreateDefaultNamespace(tenantId, projectId, userId);
        await addVariableNamespaceMemberships(tenantId, projectId, defaultNs._id, [
          { variableId: variable.id, variableType: 'env' },
        ]);
      }

      log.info('Environment variable created', {
        key: normalizedKey,
        environment,
        tenantId,
        requestId,
      });
      writeAuditLog({
        action: 'env-variable:create',
        tenantId,
        userId,
        metadata: { key: normalizedKey, environment, projectId, requestId },
      });

      res.status(201).json({
        success: true,
        variable: {
          id: variable.id,
          key: variable.key,
          environment: envForResponse(variable.environment),
          isSecret: variable.isSecret,
          description: variable.description,
          createdAt: variable.createdAt,
        },
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        res.status(409).json({
          success: false,
          error: 'Variable already exists for this environment/key combination',
        });
        return;
      }
      log.error('Failed to create environment variable', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to create environment variable' });
    }
  },
);

/**
 * GET /api/projects/:projectId/env-vars
 * List environment variables for an environment (metadata only, no values).
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'List environment variables',
    description:
      'List environment variables for an environment. Returns metadata only — no values. Query params: environment (required), page, limit.',
    response: z.object({
      success: z.boolean(),
      variables: z.array(
        z.object({
          id: z.string(),
          key: z.string(),
          environment: z.string().nullable(),
          isSecret: z.boolean(),
          description: z.string().nullable(),
          createdBy: z.string(),
          updatedBy: z.string().nullable(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      ),
      pagination: z.object({
        page: z.number(),
        limit: z.number(),
        total: z.number(),
        totalPages: z.number(),
      }),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!(await requireProjectPermission(req, res, 'env_var:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const environmentParam =
        req.query.environment !== undefined ? String(req.query.environment) : undefined;

      const where: Record<string, unknown> = { tenantId, projectId };
      if (environmentParam) {
        where.environment = environmentParam;
      }

      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
      const skip = (page - 1) * limit;

      // Optional namespace filtering
      const namespaceId = req.query.namespaceId ? String(req.query.namespaceId) : undefined;

      let filtered: any[];
      let total: number;

      if (namespaceId) {
        // Use aggregation pipeline for correct namespace-scoped pagination
        const { EnvironmentVariable } = await import('@agent-platform/database/models');
        const pipeline: any[] = [
          { $match: where },
          {
            $lookup: {
              from: 'variable_namespace_memberships',
              let: { varId: '$_id' },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ['$variableId', '$$varId'] },
                    variableType: 'env',
                    namespaceId: namespaceId,
                  },
                },
                { $limit: 1 },
              ],
              as: '_nsMembership',
            },
          },
          { $match: { '_nsMembership.0': { $exists: true } } },
          {
            $project: {
              _id: true,
              key: true,
              environment: true,
              isSecret: true,
              description: true,
              createdBy: true,
              updatedBy: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        ];

        const facetResult = await EnvironmentVariable.aggregate([
          ...pipeline,
          {
            $facet: {
              data: [{ $skip: skip }, { $limit: limit }],
              count: [{ $count: 'total' }],
            },
          },
        ]);

        filtered = facetResult[0]?.data ?? [];
        total = facetResult[0]?.count?.[0]?.total ?? 0;
      } else {
        const [variables, count] = await Promise.all([
          findEnvironmentVariables(
            where as { tenantId: string; projectId: string; environment?: string },
            {
              select: {
                _id: true,
                key: true,
                environment: true,
                isSecret: true,
                description: true,
                createdBy: true,
                updatedBy: true,
                createdAt: true,
                updatedAt: true,
              },
              skip,
              take: limit,
            },
          ),
          countEnvironmentVariables(
            where as { tenantId: string; projectId: string; environment?: string },
          ),
        ]);
        filtered = variables;
        total = count;
      }

      // Enrich with namespace list
      const varIds = filtered.map((v: any) => String(v._id));
      const allMemberships =
        varIds.length > 0
          ? await findVariableNamespaceMembershipsByVariableIds(tenantId, varIds)
          : [];
      const nsMembershipMap = new Map<string, string[]>();
      for (const m of allMemberships) {
        const vid = String(m.variableId);
        if (!nsMembershipMap.has(vid)) nsMembershipMap.set(vid, []);
        nsMembershipMap.get(vid)!.push(String(m.namespaceId));
      }

      log.info('Listed environment variables', {
        tenantId,
        environment: environmentParam ?? null,
        count: filtered.length,
        requestId,
      });

      res.json({
        success: true,
        variables: filtered.map((v: any) => ({
          id: v._id ?? v.id,
          key: v.key,
          environment: envForResponse(v.environment),
          isSecret: v.isSecret,
          description: v.description,
          createdBy: v.createdBy,
          updatedBy: v.updatedBy,
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
          variableNamespaceIds: nsMembershipMap.get(String(v._id)) ?? [],
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error: any) {
      log.error('Failed to list environment variables', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to list environment variables' });
    }
  },
);

/**
 * GET /api/projects/:projectId/env-vars/diff
 * Compare variables between two environments.
 */
openapi.route(
  'get',
  '/diff',
  {
    summary: 'Diff environment variables between environments',
    description:
      'Compare variables between source and target environments. Returns added, removed, changed, and unchanged keys.',
    query: z.object({
      source: z.enum(VALID_ENVIRONMENTS_WITH_GLOBAL).describe('Source environment'),
      target: z.enum(VALID_ENVIRONMENTS_WITH_GLOBAL).describe('Target environment'),
    }),
    response: z.object({
      success: z.boolean(),
      diff: z.object({
        added: z.array(z.string()).describe('Keys in target but not in source'),
        removed: z.array(z.string()).describe('Keys in source but not in target'),
        changed: z.array(z.string()).describe('Keys in both but with different values'),
        unchanged: z.array(z.string()).describe('Keys in both with identical values'),
      }),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!(await requireProjectPermission(req, res, 'env_var:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const source = String(req.query.source);
      const target = String(req.query.target);

      if (!source || !target) {
        res
          .status(400)
          .json({ success: false, error: 'Missing required query params: source, target' });
        return;
      }

      if (source === target) {
        res.status(400).json({ success: false, error: 'Source and target must be different' });
        return;
      }

      // Include tenantId + ire fields so the encryption plugin can decrypt
      const decryptSelect = { key: true, encryptedValue: true, tenantId: true, ire: true };

      const [sourceVars, targetVars] = await Promise.all([
        findEnvironmentVariables(
          { tenantId, projectId, environment: source },
          { select: decryptSelect },
        ),
        findEnvironmentVariables(
          { tenantId, projectId, environment: target },
          { select: decryptSelect },
        ),
      ]);

      const sourceMap = new Map<string, string>(
        sourceVars.map((v: any) => [v.key, v.encryptedValue]),
      );
      const targetMap = new Map<string, string>(
        targetVars.map((v: any) => [v.key, v.encryptedValue]),
      );

      const added: string[] = [];
      const removed: string[] = [];
      const changed: string[] = [];
      const unchanged: string[] = [];

      for (const [key, value] of sourceMap) {
        if (!targetMap.has(key)) {
          removed.push(key);
        } else if (targetMap.get(key) !== value) {
          changed.push(key);
        } else {
          unchanged.push(key);
        }
      }
      for (const key of targetMap.keys()) {
        if (!sourceMap.has(key)) {
          added.push(key);
        }
      }

      log.info('Diffed environment variables', {
        tenantId,
        source,
        target,
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        unchanged: unchanged.length,
        requestId,
      });

      res.json({ success: true, diff: { added, removed, changed, unchanged } });
    } catch (error: any) {
      log.error('Failed to diff environment variables', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to diff environment variables' });
    }
  },
);

/**
 * POST /api/projects/:projectId/env-vars/export
 * Export all variables for an environment as decrypted JSON.
 */
openapi.route(
  'post',
  '/export',
  {
    summary: 'Export environment variables',
    description: 'Export all variables for an environment as decrypted JSON.',
    body: z.object({
      environment: z.enum(VALID_ENVIRONMENTS_WITH_GLOBAL).describe('Environment to export'),
    }),
    response: z.object({
      success: z.boolean(),
      variables: z.array(
        z.object({
          key: z.string(),
          value: z.string(),
          isSecret: z.boolean(),
          description: z.string().nullable(),
        }),
      ),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!(await requireProjectPermission(req, res, 'env_var:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId;
      const { projectId } = req.params;
      const { environment } = req.body;

      // Include tenantId + ire fields so the encryption plugin can decrypt
      const selectFields = {
        key: true,
        encryptedValue: true,
        isSecret: true,
        description: true,
        tenantId: true,
        ire: true,
      };

      const variables = await findEnvironmentVariables(
        { tenantId, projectId, environment },
        { select: selectFields },
      );

      log.info('Exported environment variables', {
        tenantId,
        environment,
        count: variables.length,
        requestId,
      });
      writeAuditLog({
        action: 'env-variable:export',
        tenantId,
        userId,
        metadata: { environment, projectId, count: variables.length, requestId },
      });

      res.json({
        success: true,
        variables: variables.map((v) => ({
          key: v.key,
          value: v.encryptedValue,
          isSecret: v.isSecret,
          description: v.description,
        })),
      });
    } catch (error: any) {
      log.error('Failed to export environment variables', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to export environment variables' });
    }
  },
);

/**
 * POST /api/projects/:projectId/env-vars/import
 * Bulk import variables into an environment.
 */
openapi.route(
  'post',
  '/import',
  {
    summary: 'Import environment variables',
    description:
      'Bulk import variables into an environment. Use overwrite=true to replace existing values.',
    body: z.object({
      environment: z.enum(VALID_ENVIRONMENTS_WITH_GLOBAL).describe('Target environment'),
      variables: z.array(
        z.object({
          key: z.string().max(MAX_KEY_LENGTH).describe('Variable key'),
          value: z.string().max(MAX_VALUE_LENGTH).describe('Variable value'),
          isSecret: z.boolean().optional().describe('Whether value should be masked in UI'),
          description: z
            .string()
            .max(MAX_DESCRIPTION_LENGTH)
            .optional()
            .describe('Human-readable description'),
        }),
      ),
      overwrite: z.boolean().default(false).describe('Replace existing variables if true'),
    }),
    response: z.object({
      success: z.boolean(),
      imported: z.number(),
      skipped: z.number(),
      errors: z.array(z.string()),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!(await requireProjectPermission(req, res, 'env_var:create'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId;
      const { projectId } = req.params;
      const { environment, variables, overwrite } = req.body;

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const variable of variables) {
        const normalizedKey = variable.key.toUpperCase();

        if (!KEY_PATTERN.test(normalizedKey)) {
          errors.push(`Invalid key format: ${variable.key}`);
          continue;
        }

        try {
          const existing = await findEnvironmentVariableByKey(
            tenantId,
            projectId,
            environment,
            normalizedKey,
          );

          if (existing && !overwrite) {
            skipped++;
            continue;
          }

          if (existing) {
            await updateEnvironmentVariable(existing.id, tenantId, projectId, {
              encryptedValue: variable.value,
              isSecret: variable.isSecret ?? existing.isSecret,
              description: variable.description ?? existing.description,
              updatedBy: userId,
            });
          } else {
            const created = await createEnvironmentVariable({
              tenantId,
              projectId,
              environment,
              key: normalizedKey,
              encryptedValue: variable.value,
              isSecret: variable.isSecret ?? false,
              description: variable.description ?? null,
              createdBy: userId,
            });

            // Auto-assign to default namespace
            const defaultNs = await getOrCreateDefaultNamespace(tenantId, projectId, userId);
            await addVariableNamespaceMemberships(tenantId, projectId, defaultNs._id, [
              { variableId: created.id, variableType: 'env' },
            ]);
          }
          imported++;
        } catch (err: any) {
          errors.push(
            `Failed to import ${variable.key}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      log.info('Imported environment variables', {
        tenantId,
        environment,
        imported,
        skipped,
        errors: errors.length,
        requestId,
      });
      writeAuditLog({
        action: 'env-variable:import',
        tenantId,
        userId,
        metadata: { environment, projectId, imported, skipped, requestId },
      });

      res.json({ success: true, imported, skipped, errors });
    } catch (error: any) {
      log.error('Failed to import environment variables', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to import environment variables' });
    }
  },
);

/**
 * GET /api/projects/:projectId/env-vars/:id/value
 * Get decrypted value for a single variable.
 */
openapi.route(
  'get',
  '/:id/value',
  {
    summary: 'Get environment variable value',
    description: 'Get the decrypted value of a single environment variable.',
    response: z.object({
      success: z.boolean(),
      variable: z.object({
        id: z.string(),
        key: z.string(),
        value: z.string(),
      }),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!(await requireProjectPermission(req, res, 'env_var:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const existing = await findEnvironmentVariableById(
        req.params.id,
        tenantId,
        req.params.projectId,
      );

      if (!existing) {
        res.status(404).json({ success: false, error: 'Environment variable not found' });
        return;
      }

      // Plugin decrypts encryptedValue transparently in post-find hook
      res.json({
        success: true,
        variable: {
          id: existing.id,
          key: existing.key,
          value: existing.encryptedValue,
        },
      });
    } catch (error: any) {
      log.error('Failed to get environment variable value', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to get environment variable value' });
    }
  },
);

/**
 * PUT /api/projects/:projectId/env-vars/:id
 * Update an environment variable.
 */
openapi.route(
  'put',
  '/:id',
  {
    summary: 'Update an environment variable',
    description: 'Update the value, isSecret flag, or description of an environment variable.',
    body: z.object({
      value: z.string().max(MAX_VALUE_LENGTH).optional().describe('New value'),
      isSecret: z.boolean().optional().describe('Whether value should be masked'),
      description: z
        .string()
        .max(MAX_DESCRIPTION_LENGTH)
        .nullable()
        .optional()
        .describe('Description'),
    }),
    response: z.object({
      success: z.boolean(),
      variable: z.object({
        id: z.string(),
        key: z.string(),
        environment: z.string().nullable(),
        isSecret: z.boolean(),
        description: z.string().nullable(),
        updatedAt: z.string(),
      }),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!(await requireProjectPermission(req, res, 'env_var:update'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId;

      const existing = await findEnvironmentVariableById(
        req.params.id,
        tenantId,
        req.params.projectId,
      );

      if (!existing) {
        res.status(404).json({ success: false, error: 'Environment variable not found' });
        return;
      }

      const updateData: Record<string, unknown> = { updatedBy: userId };
      const { value, isSecret, description } = req.body;

      if (value !== undefined) {
        if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) {
          res.status(400).json({
            success: false,
            error: `Value exceeds maximum length of ${MAX_VALUE_LENGTH} characters`,
          });
          return;
        }
        // Plugin encrypts encryptedValue transparently in pre-save hook
        updateData.encryptedValue = value;
      }

      if (isSecret !== undefined) updateData.isSecret = isSecret;
      if (description !== undefined) updateData.description = description;

      const updated = await updateEnvironmentVariable(
        req.params.id,
        tenantId,
        req.params.projectId,
        updateData,
      );

      if (!updated) {
        res.status(404).json({ success: false, error: 'Environment variable not found' });
        return;
      }

      // Handle namespace membership replacement if variableNamespaceIds provided
      const variableNamespaceIds: string[] | undefined = req.body.variableNamespaceIds;
      if (variableNamespaceIds !== undefined) {
        if (!Array.isArray(variableNamespaceIds)) {
          res.status(400).json({ success: false, error: 'variableNamespaceIds must be an array' });
          return;
        }
        if (variableNamespaceIds.length > MAX_VARIABLE_NAMESPACES_PER_VARIABLE) {
          res.status(400).json({
            success: false,
            error: `Cannot assign to more than ${MAX_VARIABLE_NAMESPACES_PER_VARIABLE} namespaces`,
          });
          return;
        }

        const { projectId } = req.params;

        if (variableNamespaceIds.length === 0) {
          // Move to default namespace only (auto-create if missing)
          await deleteAllVariableNamespaceMembershipsForVariable(req.params.id, 'env');
          const defaultNs = await getOrCreateDefaultNamespace(tenantId, projectId, userId);
          await addVariableNamespaceMemberships(tenantId, projectId, defaultNs._id, [
            { variableId: req.params.id, variableType: 'env' },
          ]);
        } else {
          // Validate all variableNamespaceIds exist in this project
          for (const nsId of variableNamespaceIds) {
            const ns = await findVariableNamespaceById(nsId, tenantId);
            if (!ns || ns.projectId !== projectId) {
              res.status(400).json({
                success: false,
                error: `Namespace ${nsId} not found in this project`,
              });
              return;
            }
          }
          // Replace: delete old, create new
          await deleteAllVariableNamespaceMembershipsForVariable(req.params.id, 'env');
          for (const nsId of variableNamespaceIds) {
            await addVariableNamespaceMemberships(tenantId, projectId, nsId, [
              { variableId: req.params.id, variableType: 'env' },
            ]);
          }
        }
      }

      log.info('Environment variable updated', {
        id: req.params.id,
        key: existing.key,
        tenantId,
        requestId,
      });
      writeAuditLog({
        action: 'env-variable:update',
        tenantId,
        userId,
        metadata: { variableId: req.params.id, key: existing.key, requestId },
      });

      res.json({
        success: true,
        variable: {
          id: updated.id,
          key: updated.key,
          environment: envForResponse(updated.environment),
          isSecret: updated.isSecret,
          description: updated.description,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (error: any) {
      log.error('Failed to update environment variable', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to update environment variable' });
    }
  },
);

/**
 * DELETE /api/projects/:projectId/env-vars/:id
 * Delete an environment variable.
 */
openapi.route(
  'delete',
  '/:id',
  {
    summary: 'Delete an environment variable',
    description: 'Permanently delete an environment variable.',
    response: z.object({
      success: z.boolean(),
      deleted: z.string(),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!(await requireProjectPermission(req, res, 'env_var:delete'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId;

      const existing = await findEnvironmentVariableById(
        req.params.id,
        tenantId,
        req.params.projectId,
      );

      if (!existing) {
        res.status(404).json({ success: false, error: 'Environment variable not found' });
        return;
      }

      await deleteEnvironmentVariable(req.params.id, tenantId, req.params.projectId);
      await deleteAllVariableNamespaceMembershipsForVariable(req.params.id, 'env');

      log.info('Environment variable deleted', {
        id: req.params.id,
        key: existing.key,
        tenantId,
        requestId,
      });
      writeAuditLog({
        action: 'env-variable:delete',
        tenantId,
        userId,
        metadata: { variableId: req.params.id, key: existing.key, requestId },
      });

      res.json({ success: true, deleted: req.params.id });
    } catch (error: any) {
      log.error('Failed to delete environment variable', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to delete environment variable' });
    }
  },
);

/**
 * POST /api/projects/:projectId/env-vars/copy
 * Copy variables from one environment to another.
 */
openapi.route(
  'post',
  '/copy',
  {
    summary: 'Copy environment variables between environments',
    description: 'Copy all variables from a source environment to a target environment.',
    body: z.object({
      sourceEnvironment: z.enum(VALID_ENVIRONMENTS_WITH_GLOBAL).describe('Source environment'),
      targetEnvironment: z.enum(VALID_ENVIRONMENTS_WITH_GLOBAL).describe('Target environment'),
      overwrite: z.boolean().optional().describe('Overwrite existing variables with same key'),
    }),
    response: z.object({
      success: z.boolean(),
      copied: z.number(),
      skipped: z.number(),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!(await requireProjectPermission(req, res, 'env_var:create'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const userId = req.tenantContext!.userId;
      const { projectId } = req.params;
      const { sourceEnvironment, targetEnvironment, overwrite } = req.body;

      if (!sourceEnvironment || !targetEnvironment) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: sourceEnvironment, targetEnvironment',
        });
        return;
      }

      if (sourceEnvironment === targetEnvironment) {
        res
          .status(400)
          .json({ success: false, error: 'Source and target environments must be different' });
        return;
      }

      // Load source variables — include tenantId + encryption metadata so
      // the Mongoose encryption plugin can decrypt in the post-find hook.
      // tenantId MUST be in the projection: the post-find hook reads it from
      // the returned document and nulls encrypted fields when it's missing.
      const sourceVars = await findEnvironmentVariables(
        { tenantId, projectId, environment: sourceEnvironment },
        {
          select: {
            tenantId: true,
            key: true,
            encryptedValue: true,
            isSecret: true,
            description: true,
            ire: true,
            iv: true,
            cek: true,
            fieldsToEncrypt: true,
          },
        },
      );

      if (sourceVars.length === 0) {
        res.json({ success: true, copied: 0, skipped: 0, decryptionFailed: 0 });
        return;
      }

      // Filter out variables where decryption failed (encryptedValue is null).
      // This happens with legacy v1/v2 docs missing encryption metadata.
      const decryptable = sourceVars.filter(
        (v: any) => v.encryptedValue !== null && v.encryptedValue !== undefined,
      );
      const decryptionFailed = sourceVars.length - decryptable.length;
      if (decryptionFailed > 0) {
        const failedKeys = sourceVars
          .filter((v: any) => v.encryptedValue === null || v.encryptedValue === undefined)
          .map((v: any) => v.key);
        log.warn('Some variables could not be decrypted for copy', {
          failedKeys,
          sourceEnvironment,
          tenantId,
          requestId,
        });
      }

      if (decryptable.length === 0) {
        res.json({ success: true, copied: 0, skipped: 0, decryptionFailed });
        return;
      }

      const result = await bulkUpsertEnvironmentVariables(
        tenantId,
        projectId,
        targetEnvironment,
        decryptable.map((v: any) => ({
          key: String(v.key).toUpperCase(),
          encryptedValue: v.encryptedValue,
          isSecret: v.isSecret,
          description: v.description,
        })),
        userId,
        overwrite ?? false,
      );

      log.info('Environment variables copied', {
        sourceEnvironment,
        targetEnvironment,
        upserted: result.upserted,
        matched: result.matched,
        tenantId,
        requestId,
      });
      writeAuditLog({
        action: 'env-variable:copy',
        tenantId,
        userId,
        metadata: {
          sourceEnvironment,
          targetEnvironment,
          count: sourceVars.length,
          overwrite: overwrite ?? false,
          requestId,
        },
      });

      res.json({
        success: true,
        copied: result.upserted,
        skipped: result.matched,
        ...(decryptionFailed > 0 && { decryptionFailed }),
      });
    } catch (error: any) {
      log.error('Failed to copy environment variables', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to copy environment variables' });
    }
  },
);

/**
 * POST /api/projects/:projectId/env-vars/validate
 * Scan agent IRs for {{env.KEY}} references and report missing/defined.
 */
openapi.route(
  'post',
  '/validate',
  {
    summary: 'Validate environment variable references',
    description:
      'Scan agent IRs for {{env.KEY}} references and return which are missing vs defined.',
    body: z.object({
      environment: z
        .enum(VALID_ENVIRONMENTS_WITH_GLOBAL)
        .describe('Environment to validate against'),
      agentNames: z.array(z.string()).optional().describe('Agent names to scan (all if omitted)'),
    }),
    response: z.object({
      success: z.boolean(),
      missing: z.array(z.string()),
      defined: z.array(z.string()),
    }),
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      if (!(await requireProjectPermission(req, res, 'env_var:read'))) return;

      const tenantId = req.tenantContext!.tenantId;
      const { projectId } = req.params;
      const { environment, agentNames } = req.body;

      if (!environment) {
        res.status(400).json({ success: false, error: 'Missing required field: environment' });
        return;
      }

      // Load agent IRs from latest versions
      const referencedKeys = new Set<string>();
      try {
        const { findProjectAgentsForProject, findLatestAgentVersion } =
          await import('../repos/project-repo.js');
        const allAgents = await findProjectAgentsForProject(projectId, { tenantId });
        const targetAgents = agentNames?.length
          ? (allAgents as any[]).filter((a: any) => agentNames.includes(a.name))
          : (allAgents as any[]);

        const envVarPattern = /\{\{env\.(\w+)\}\}/g;

        for (const agent of targetAgents) {
          const version = await findLatestAgentVersion(agent.id ?? agent._id);
          if (version?.irContent) {
            let match;
            while ((match = envVarPattern.exec(version.irContent)) !== null) {
              referencedKeys.add(match[1]);
            }
          }
        }
      } catch (err) {
        log.warn('Failed to scan agent IRs for env var references', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Load defined variables for this environment + global fallback
      const envQueries = [
        findEnvironmentVariables({ tenantId, projectId, environment }, { select: { key: true } }),
      ];
      if (environment !== 'global') {
        envQueries.push(
          findEnvironmentVariables(
            { tenantId, projectId, environment: 'global' },
            { select: { key: true } },
          ),
        );
      }
      const results = await Promise.all(envQueries);
      const definedKeys = new Set(results.flatMap((vars) => vars.map((v) => v.key)));

      const missing = [...referencedKeys].filter((k) => !definedKeys.has(k));
      const defined = [...referencedKeys].filter((k) => definedKeys.has(k));

      res.json({ success: true, missing, defined });
    } catch (error: any) {
      log.error('Failed to validate environment variables', { error: error?.message, requestId });
      res.status(500).json({ success: false, error: 'Failed to validate environment variables' });
    }
  },
);

export default router;
