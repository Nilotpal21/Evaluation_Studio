/**
 * Lookup Data CRUD Route
 *
 * Manages collection-backed lookup table entries.
 * Supports bulk upsert, paginated list, delete all, and CSV/JSON upload.
 *
 * Mount: /api/projects/:projectId/lookup-tables
 *
 * POST   /:tableName/entries   — Bulk upsert entries (max 1000)
 * GET    /:tableName/entries   — List entries (paginated)
 * DELETE /:tableName/entries   — Delete all entries for a table
 * POST   /:tableName/upload    — Upload CSV/JSON → parse → store as entries
 */

import { type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('lookup-data');

// =============================================================================
// CONSTANTS
// =============================================================================

const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const MAX_ENTRIES_PER_REQUEST = 1000;
const MAX_UPLOAD_VALUES = 10_000;
const MAX_UPLOAD_BYTES = 1_048_576; // 1MB
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;

// =============================================================================
// PURE PARSING FUNCTIONS (testable independently)
// =============================================================================

/**
 * Parse CSV content into an array of string values.
 * - Each line is treated as one value
 * - Blank lines and lines starting with `#` are skipped
 * - Quoted values like `"value with, comma"` are supported
 */
export function parseCSVValues(content: string): { values: string[]; errors: string[] } {
  const values: string[] = [];
  const errors: string[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    // Handle quoted values: "value with, comma"
    const match = line.match(/^"([^"]*)"/) || line.match(/^([^,]*)/);
    if (match && match[1].trim()) {
      values.push(match[1].trim());
    }
  }
  return { values, errors };
}

/**
 * Parse JSON content into an array of string values.
 * Accepts:
 * - Array of strings: `["a", "b", "c"]`
 * - Array of objects with a `value` field: `[{ "value": "a" }, { "value": "b" }]`
 * - Mixed arrays of both
 */
export function parseJSONValues(content: string): { values: string[]; errors: string[] } {
  const errors: string[] = [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const values = parsed
        .map((item, i) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && typeof item.value === 'string') return item.value;
          errors.push(`Item at index ${i} is not a string or {value: string}`);
          return null;
        })
        .filter((v): v is string => v !== null);
      return { values, errors };
    }
    return { values: [], errors: ['JSON must be an array'] };
  } catch {
    return { values: [], errors: ['Invalid JSON'] };
  }
}

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

function validateTableName(tableName: string, res: any): boolean {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_TABLE_NAME',
        message:
          'Table name must start with a lowercase letter or underscore and contain only lowercase alphanumeric characters and underscores',
      },
    });
    return false;
  }
  return true;
}

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const entrySchema = z.object({
  value: z.string().min(1),
  field: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const bulkUpsertBodySchema = z.object({
  entries: z.array(entrySchema).min(1).max(MAX_ENTRIES_PER_REQUEST),
});

// =============================================================================
// OPENAPI ROUTER
// =============================================================================

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/lookup-tables',
  tags: ['Lookup Data'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));

// =============================================================================
// POST /:tableName/entries — Bulk Upsert
// =============================================================================

openapi.route(
  'post',
  '/:tableName/entries',
  {
    summary: 'Bulk upsert lookup table entries',
    description:
      'Upsert up to 1000 entries into a lookup table. Entries are matched by (tenantId, projectId, tableName, value) and created or updated accordingly.',
    body: bulkUpsertBodySchema,
    response: z.object({
      success: z.literal(true),
      data: z.object({
        total: z.number(),
        upserted: z.number(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'lookup_data:write'))) return;

      const { tableName } = req.params;
      if (!validateTableName(tableName, res)) return;

      const tenantId = (req as any).tenantContext?.tenantId;
      const projectId = req.params.projectId;

      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: { code: 'TENANT_REQUIRED', message: 'Tenant access denied' },
        });
        return;
      }

      const parseResult = bulkUpsertBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_BODY',
            message: parseResult.error.errors.map((e) => e.message).join(', '),
          },
        });
        return;
      }

      const { entries } = parseResult.data;

      const { LookupEntry } = await import('@agent-platform/database/models');

      const ops = entries.map((entry) => ({
        updateOne: {
          filter: { tenantId, projectId, tableName, value: entry.value },
          update: {
            $set: {
              tenantId,
              projectId,
              tableName,
              value: entry.value,
              ...(entry.field !== undefined && { field: entry.field }),
              ...(entry.metadata !== undefined && { metadata: entry.metadata }),
            },
          },
          upsert: true,
        },
      }));

      const result = await LookupEntry.bulkWrite(ops);
      const upserted = (result.upsertedCount || 0) + (result.modifiedCount || 0);

      log.info('Lookup entries upserted', {
        tenantId,
        projectId,
        tableName,
        total: entries.length,
        upserted,
      });

      res.json({
        success: true,
        data: { total: entries.length, upserted },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to upsert lookup entries', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to upsert lookup entries' },
      });
    }
  },
);

// =============================================================================
// GET /:tableName/entries — List Entries (paginated)
// =============================================================================

openapi.route(
  'get',
  '/:tableName/entries',
  {
    summary: 'List lookup table entries',
    description:
      'List entries in a lookup table with pagination. Returns entries scoped to the tenant and project.',
    response: z.object({
      success: z.literal(true),
      data: z.object({
        entries: z.array(
          z.object({
            _id: z.string(),
            value: z.string(),
            field: z.string().optional(),
            metadata: z.record(z.unknown()).optional(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
        ),
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'lookup_data:read'))) return;

      const { tableName } = req.params;
      if (!validateTableName(tableName, res)) return;

      const tenantId = (req as any).tenantContext?.tenantId;
      const projectId = req.params.projectId;

      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: { code: 'TENANT_REQUIRED', message: 'Tenant access denied' },
        });
        return;
      }

      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit), 10) || DEFAULT_PAGE_LIMIT, 1),
        MAX_PAGE_LIMIT,
      );
      const offset = Math.max(parseInt(String(req.query.offset), 10) || 0, 0);

      const { LookupEntry } = await import('@agent-platform/database/models');

      const filter = { tenantId, projectId, tableName };
      const [entries, total] = await Promise.all([
        LookupEntry.find(filter).skip(offset).limit(limit).lean(),
        LookupEntry.countDocuments(filter),
      ]);

      res.json({
        success: true,
        data: { entries, total, limit, offset },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to list lookup entries', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to list lookup entries' },
      });
    }
  },
);

// =============================================================================
// DELETE /:tableName/entries — Delete All
// =============================================================================

openapi.route(
  'delete',
  '/:tableName/entries',
  {
    summary: 'Delete all entries in a lookup table',
    description:
      'Removes all entries for a given table within the tenant and project scope. This action cannot be undone.',
    response: z.object({
      success: z.literal(true),
      data: z.object({
        deleted: z.number(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'lookup_data:write'))) return;

      const { tableName } = req.params;
      if (!validateTableName(tableName, res)) return;

      const tenantId = (req as any).tenantContext?.tenantId;
      const projectId = req.params.projectId;

      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: { code: 'TENANT_REQUIRED', message: 'Tenant access denied' },
        });
        return;
      }

      const { LookupEntry } = await import('@agent-platform/database/models');

      const result = await LookupEntry.deleteMany({ tenantId, projectId, tableName });

      log.info('Lookup entries deleted', {
        tenantId,
        projectId,
        tableName,
        deleted: result.deletedCount,
      });

      res.json({
        success: true,
        data: { deleted: result.deletedCount },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to delete lookup entries', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete lookup entries' },
      });
    }
  },
);

// =============================================================================
// POST /:tableName/upload — CSV/JSON Upload
// =============================================================================

openapi.route(
  'post',
  '/:tableName/upload',
  {
    summary: 'Upload CSV or JSON to populate lookup table',
    description:
      'Accepts raw CSV (text/csv) or JSON (application/json) body and parses values into lookup table entries. CSV: one value per line, `#` comments skipped, quoted values supported. JSON: array of strings or `{value: string}` objects.',
    response: z.object({
      success: z.literal(true),
      data: z.object({
        total: z.number(),
        stored: z.number(),
        errors: z.array(z.string()).optional(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'lookup_data:write'))) return;

      const { tableName } = req.params;
      if (!validateTableName(tableName, res)) return;

      const tenantId = (req as any).tenantContext?.tenantId;
      const projectId = req.params.projectId;

      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: { code: 'TENANT_REQUIRED', message: 'Tenant access denied' },
        });
        return;
      }

      // Get body content — Express parses JSON via express.json() and CSV via express.text()
      const contentType = (req.headers['content-type'] || '').toLowerCase();
      let bodyContent: string;

      if (contentType.includes('text/csv')) {
        // express.text({ type: 'text/csv' }) sets req.body as a string
        if (typeof req.body === 'string') {
          bodyContent = req.body;
        } else {
          // Fallback to rawBody buffer if available
          const rawBody = (req as any).rawBody;
          if (!rawBody) {
            res.status(400).json({
              success: false,
              error: { code: 'EMPTY_BODY', message: 'Request body is empty' },
            });
            return;
          }
          bodyContent = rawBody.toString('utf-8');
        }
      } else if (contentType.includes('application/json')) {
        // For JSON, re-serialize from the already-parsed body
        bodyContent = JSON.stringify(req.body);
      } else {
        res.status(415).json({
          success: false,
          error: {
            code: 'UNSUPPORTED_CONTENT_TYPE',
            message: 'Content-Type must be text/csv or application/json',
          },
        });
        return;
      }

      // Check body size
      const bodyBytes = Buffer.byteLength(bodyContent, 'utf-8');
      if (bodyBytes > MAX_UPLOAD_BYTES) {
        res.status(413).json({
          success: false,
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Upload body exceeds maximum size of ${MAX_UPLOAD_BYTES} bytes`,
          },
        });
        return;
      }

      // Parse based on content type
      const parseResult = contentType.includes('text/csv')
        ? parseCSVValues(bodyContent)
        : parseJSONValues(bodyContent);

      // Check value count
      if (parseResult.values.length > MAX_UPLOAD_VALUES) {
        res.status(413).json({
          success: false,
          error: {
            code: 'TOO_MANY_VALUES',
            message: `Upload contains ${parseResult.values.length} values, maximum is ${MAX_UPLOAD_VALUES}`,
          },
        });
        return;
      }

      if (parseResult.values.length === 0) {
        res.json({
          success: true,
          data: {
            total: 0,
            stored: 0,
            ...(parseResult.errors.length > 0 && { errors: parseResult.errors }),
          },
        });
        return;
      }

      // Bulk insert entries
      const { LookupEntry } = await import('@agent-platform/database/models');

      const ops = parseResult.values.map((value) => ({
        updateOne: {
          filter: { tenantId, projectId, tableName, value },
          update: {
            $set: { tenantId, projectId, tableName, value },
          },
          upsert: true,
        },
      }));

      const result = await LookupEntry.bulkWrite(ops);
      const stored = (result.upsertedCount || 0) + (result.modifiedCount || 0);

      log.info('Lookup entries uploaded', {
        tenantId,
        projectId,
        tableName,
        total: parseResult.values.length,
        stored,
      });

      res.json({
        success: true,
        data: {
          total: parseResult.values.length,
          stored,
          ...(parseResult.errors.length > 0 && { errors: parseResult.errors }),
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to upload lookup entries', { error: message });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to upload lookup entries' },
      });
    }
  },
);

export default openapi.router;
