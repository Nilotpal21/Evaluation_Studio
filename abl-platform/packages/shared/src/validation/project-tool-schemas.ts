/**
 * Zod Validation Schemas for Project Tools (API Layer)
 *
 * Discriminated union schemas for tool creation/update. These validate
 * HTTP request bodies before reaching the service layer.
 *
 * Uses the same validation constants as `tool-validation.ts` and the same
 * SSRF check from `../security/`.
 */

import { z } from 'zod';
import { MAX_DESCRIPTION_LENGTH, MAX_CODE_SIZE } from './tool-validation.js';
import { validateUrlForSSRF, getDevSSRFOptions } from '../security/index.js';

// ─── Constants ──────────────────────────────────────────────────────────

export const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/;
export const MAX_DSL_SIZE = 512 * 1024; // 512KB
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/**
 * Inline HTTP auth types for authored tools.
 *
 * Deprecated aliases retained for backward compatibility:
 * - `oauth2_client` -> `oauth2_client_credentials`
 * - `oauth2_user` -> `oauth2_token`
 * - `custom` -> `custom_header`
 */
const HTTP_AUTH_TYPES = [
  'none',
  'api_key',
  'bearer',
  'oauth2_client',
  'oauth2_user',
  'custom',
] as const;
const HTTP_CONSENT_MODES = ['preflight', 'inline'] as const;
const HTTP_CONNECTION_MODES = ['per_user', 'shared'] as const;
const SANDBOX_RUNTIMES = ['javascript', 'python'] as const;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;
const MIN_MEMORY_MB = 128;
const MAX_MEMORY_MB = 4096;
const CONFIG_NUMERIC_TEMPLATE_RE = /^\{\{config\.[A-Za-z_][A-Za-z0-9_]*\}\}$/;

function RuntimeNumericSchema(base: z.ZodNumber): z.ZodUnion<[z.ZodNumber, z.ZodString]> {
  return z.union([
    base,
    z.string().regex(CONFIG_NUMERIC_TEMPLATE_RE, {
      message: 'Must be a number or exact {{config.KEY}} placeholder',
    }),
  ]);
}

// ─── Parameter Schema ───────────────────────────────────────────────────

const ToolParameterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_]\w*$/),
  type: z.string().min(1).max(64),
  description: z.string().min(1, 'Description is required for LLM context').max(256),
  required: z.boolean().default(true),
  enumValues: z.array(z.string().min(1)).optional(),
  defaultValue: z.string().max(256).optional(),
  objectSchema: z.string().max(MAX_DSL_SIZE).optional(),
});

// ─── Auth Config Schema ─────────────────────────────────────────────────

const AuthConfigSchema = z
  .object({
    token: z.string().optional(),
    apiKey: z.string().optional(),
    tokenUrl: z.string().url().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    scopes: z.string().optional(),
    headerName: z.string().optional(),
    provider: z.string().optional(),
    customHeaders: z.record(z.string()).optional(),
  })
  .optional();

// ─── Base Fields ────────────────────────────────────────────────────────

const ToolFormBaseSchema = z.object({
  name: z.string().min(2).max(64).regex(TOOL_NAME_REGEX, {
    message: 'Must start with lowercase letter, contain only a-z, 0-9, underscore',
  }),
  description: z.string().min(1, 'Tool description is required').max(MAX_DESCRIPTION_LENGTH),
  parameters: z.array(ToolParameterSchema).max(20).default([]),
  returnType: z.string().max(256).default('object'),
  variableNamespaceIds: z.array(z.string().min(1)).max(20).optional(),
});

// ─── HTTP Tool ──────────────────────────────────────────────────────────

export const CreateHttpToolSchema = ToolFormBaseSchema.extend({
  toolType: z.literal('http'),
  endpoint: z
    .string()
    .min(1)
    .refine(
      (val) => {
        // Allow {{env.X}} / {{secrets.X}} / {{config.X}} template placeholders.
        if (/\{\{(env|secrets|config)\.\w+\}\}/.test(val)) return true;
        try {
          new URL(val);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Must be a valid URL or contain {{env.X}}/{{secrets.X}} placeholders' },
    ),
  method: z.enum(HTTP_METHODS),
  auth: z.enum(HTTP_AUTH_TYPES).default('none'),
  authConfig: AuthConfigSchema,
  authProfileRef: z.string().min(1).max(255).optional(),
  authJit: z.boolean().optional(),
  consentMode: z.enum(HTTP_CONSENT_MODES).optional(),
  connectionMode: z.enum(HTTP_CONNECTION_MODES).optional(),
  headers: z.array(z.object({ key: z.string().min(1), value: z.string() })).optional(),
  queryParams: z.array(z.object({ key: z.string().min(1), value: z.string() })).optional(),
  body: z.string().max(MAX_DSL_SIZE).optional(),
  bodyType: z.enum(['json', 'form', 'xml', 'text']).optional(),
  bodySchema: z.string().max(MAX_DSL_SIZE).optional(),
  useBodySchema: z.boolean().optional(),
  timeout: RuntimeNumericSchema(z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS)).default(
    30_000,
  ),
  retry: RuntimeNumericSchema(z.number().int().min(0).max(10)).default(0),
  retryDelay: RuntimeNumericSchema(z.number().int().min(0).max(60_000)).default(1000),
  rateLimit: RuntimeNumericSchema(z.number().int().min(1)).optional(),
  circuitBreaker: z
    .object({
      threshold: RuntimeNumericSchema(z.number().int().min(1)),
      resetMs: RuntimeNumericSchema(z.number().int().min(1000)),
    })
    .optional(),
  protocol: z.enum(['rest', 'soap']).default('rest'),
  soapVersion: z.enum(['1.1', '1.2']).optional(),
  soapAction: z.string().max(2048).optional(),
  onSoapFault: z.enum(['error', 'data']).default('error'),
  onHttpError: z.enum(['error', 'data']).default('data'),
});

/**
 * Validate HTTP tool endpoint for SSRF protection.
 * Call this after schema validation in API route handlers.
 * Handles {{env.X}} / {{secrets.X}} / {{config.X}} template placeholders:
 * validates the literal URL prefix for SSRF while allowing unresolved placeholders.
 */
export function validateHttpToolEndpoint(endpoint: string): { safe: boolean; message?: string } {
  const placeholderRe = /\{\{[^}]+\}\}/g;
  const match = placeholderRe.exec(endpoint);
  placeholderRe.lastIndex = 0;
  if (match) {
    const prefix = endpoint.slice(0, match.index);
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(prefix)) {
      return { safe: true };
    }
    const sanitized = endpoint.replace(placeholderRe, 'placeholder');
    placeholderRe.lastIndex = 0;
    const result = validateUrlForSSRF(sanitized, getDevSSRFOptions());
    return result.safe
      ? { safe: true }
      : { safe: false, message: 'Endpoint blocked by SSRF protection' };
  }
  const result = validateUrlForSSRF(endpoint, getDevSSRFOptions());
  return result.safe
    ? { safe: true }
    : { safe: false, message: 'Endpoint blocked by SSRF protection' };
}

// ─── Sandbox Tool ───────────────────────────────────────────────────────

export const CreateSandboxToolSchema = ToolFormBaseSchema.extend({
  toolType: z.literal('sandbox'),
  runtime: z.enum(SANDBOX_RUNTIMES),
  code: z.string().min(1).max(MAX_CODE_SIZE),
  memoryMb: RuntimeNumericSchema(z.number().int().min(MIN_MEMORY_MB).max(MAX_MEMORY_MB)).default(
    MIN_MEMORY_MB,
  ),
  timeout: RuntimeNumericSchema(z.number().int().min(MIN_TIMEOUT_MS).max(60_000)).default(5000),
});

// ─── MCP Tool ───────────────────────────────────────────────────────────

export const CreateMcpToolSchema = ToolFormBaseSchema.extend({
  toolType: z.literal('mcp'),
  server: z.string().min(1),
  serverTool: z.string().min(1).optional(),
  transportType: z.string().optional(),
  headers: z.array(z.object({ key: z.string().min(1), value: z.string() })).optional(),
});

// ─── Workflow Tool ─────────────────────────────────────────────────────

export const CreateWorkflowToolSchema = ToolFormBaseSchema.extend({
  toolType: z.literal('workflow'),
  workflowId: z.string().min(1),
  workflowVersionId: z.string().min(1).optional(),
  workflowVersion: z.string().min(1).optional(),
  triggerId: z.string().min(1),
  mode: z.enum(['sync', 'async']).default('sync'),
  timeoutMs: RuntimeNumericSchema(z.number().int().min(1000).max(600_000)).optional(),
  paramMapping: z.record(z.string(), z.string()).optional(),
});

export type CreateWorkflowToolInput = z.infer<typeof CreateWorkflowToolSchema>;

// ─── SearchAI Tool ───────────────────────────────────────────────────────

export const CreateSearchAIToolSchema = ToolFormBaseSchema.extend({
  toolType: z.literal('searchai'),
  indexId: z.string().min(1),
  kbName: z.string().min(1).max(MAX_DESCRIPTION_LENGTH).optional(),
});

// ─── Discriminated Union ────────────────────────────────────────────────

export const CreateProjectToolSchema = z
  .discriminatedUnion('toolType', [
    CreateHttpToolSchema,
    CreateSandboxToolSchema,
    CreateMcpToolSchema,
    CreateWorkflowToolSchema,
    CreateSearchAIToolSchema,
  ])
  .superRefine((data, ctx) => {
    if (data.toolType !== 'http') return;
    if (data.protocol === 'soap' && !data.soapVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['soapVersion'],
        message: 'soapVersion is required when protocol is soap',
      });
    }
    if (data.protocol !== 'soap' && data.soapAction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['soapAction'],
        message: 'soapAction can only be set when protocol is soap',
      });
    }
    if (data.protocol === 'soap' && data.method && data.method !== 'POST') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['method'],
        message: 'method must be POST when protocol is soap',
      });
    }
  });

export type CreateProjectToolInput = z.infer<typeof CreateProjectToolSchema>;

// ─── Update Schema (partial — name not changeable) ──────────────────────

export const UpdateProjectToolSchema = z
  .object({
    name: z
      .string()
      .min(2)
      .max(64)
      .regex(TOOL_NAME_REGEX, {
        message: 'Must start with lowercase letter, contain only a-z, 0-9, underscore',
      })
      .optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).nullable().optional(),
    dslContent: z.string().min(1).max(MAX_DSL_SIZE).optional(),
    variableNamespaceIds: z.array(z.string().min(1)).max(20).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });

export type UpdateProjectToolInput = z.infer<typeof UpdateProjectToolSchema>;
