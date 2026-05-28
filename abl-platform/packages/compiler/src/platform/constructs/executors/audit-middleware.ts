/**
 * Tool Call Audit Middleware
 *
 * Builds an audit candidate for every tool invocation.
 * Runtime audit loggers may skip operational-only calls while preserving
 * credentialed, external-endpoint, and failed executions.
 * Audit failures never block tool execution.
 */

import type {
  ToolMiddleware,
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from './tool-middleware.js';
import { createLogger } from '../../logger.js';
import { createHash } from 'crypto';

const log = createLogger('audit-middleware');

export const AuditSource = {
  TEST: 'test',
  PRODUCTION: 'production',
  STAGING: 'staging',
} as const;

export type AuditSource = (typeof AuditSource)[keyof typeof AuditSource];

export interface ToolAuditEntry {
  timestamp: string;
  toolName: string;
  toolType?: string;
  sessionId?: string;
  tenantId?: string;
  userId?: string;
  workflowId?: string;
  workflowVersionId?: string;
  workflowVersion?: string;
  inputHash: string;
  success: boolean;
  latencyMs: number;
  errorMessage?: string;
  authType?: string;
  endpoint?: string;
  /** Execution source — distinguishes test runs from production traffic */
  source?: AuditSource;
  /** Caller identity context for compliance audit trails */
  callerContext?: {
    channel?: string;
    identityTier?: number;
    verificationMethod?: string;
    contactId?: string;
    customerId?: string;
  };
}

/**
 * Pluggable audit logger interface.
 * Implementations should be non-blocking — audit writes must not block tool execution.
 */
export interface ToolAuditLogger {
  logToolAudit(entry: ToolAuditEntry): Promise<void>;
}

/**
 * Compute SHA-256 hash of scrubbed input params for audit trail.
 * Raw params are never stored — only the hash for correlation.
 */
/** Set of valid AuditSource values for runtime validation */
const AUDIT_SOURCE_VALUES = new Set<string>(Object.values(AuditSource));

/** Type-safe validator — returns undefined for invalid values instead of blindly casting */
function toAuditSource(value: unknown): AuditSource | undefined {
  return typeof value === 'string' && AUDIT_SOURCE_VALUES.has(value)
    ? (value as AuditSource)
    : undefined;
}

function hashInput(params: Record<string, unknown>): string {
  const json = JSON.stringify(params, Object.keys(params).sort());
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Create audit middleware that submits an audit candidate for every tool invocation.
 * Audit failures are caught and logged — they never block execution.
 */
export function createAuditMiddleware(auditLogger: ToolAuditLogger): ToolMiddleware {
  return async (ctx: ToolCallContext, next: ToolMiddlewareNext): Promise<ToolCallResult> => {
    const start = Date.now();
    let success = false;
    let errorMessage: string | undefined;

    try {
      const result = await next(ctx);
      success = true;
      return result;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw error;
    } finally {
      const latencyMs = Date.now() - start;
      const entry: ToolAuditEntry = {
        timestamp: new Date().toISOString(),
        toolName: ctx.toolName,
        toolType: ctx.tool?.tool_type ?? (ctx.metadata?.tool_type as string | undefined),
        sessionId: ctx.metadata?.sessionId as string | undefined,
        tenantId: ctx.metadata?.tenantId as string | undefined,
        userId: ctx.metadata?.userId as string | undefined,
        workflowId: ctx.metadata?.workflow_id as string | undefined,
        workflowVersionId: ctx.metadata?.workflow_version_id as string | undefined,
        workflowVersion: ctx.metadata?.workflow_version as string | undefined,
        inputHash: hashInput(ctx.params),
        success,
        latencyMs,
        errorMessage,
        authType:
          ctx.tool?.http_binding?.auth?.type ?? (ctx.metadata?.auth_type as string | undefined),
        endpoint: ctx.tool?.http_binding?.endpoint,
        source: toAuditSource(ctx.metadata?.source),
        callerContext: ctx.metadata?.callerContext as ToolAuditEntry['callerContext'],
      };

      try {
        await auditLogger.logToolAudit(entry);
      } catch (auditError) {
        // Audit failure must NEVER block tool execution
        log.error('Failed to write audit log', {
          toolName: ctx.toolName,
          error: auditError instanceof Error ? auditError.message : 'Unknown audit error',
        });
      }
    }
  };
}
