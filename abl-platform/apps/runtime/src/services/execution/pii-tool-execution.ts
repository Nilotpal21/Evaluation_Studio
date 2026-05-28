import { createHash } from 'node:crypto';
import type { PIIToken, PIIRenderMode } from '@abl/compiler/platform/security/pii-vault.js';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { RuntimeSession } from './types.js';
import { getPIIAuditLogger } from './pii-audit-singleton.js';

const log = createLogger('pii-tool-execution');

export type ToolPIIAccess = 'original' | 'tools' | 'user' | 'logs' | 'llm';

/**
 * Audit context for PII plaintext dispense tracking.
 * When provided and `piiAccess === 'original'`, the function emits
 * `pii_plaintext_dispensed` events internally — callers no longer
 * need to handle audit emission themselves.
 */
export interface PIIAuditContext {
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
  toolName: string;
  agentId?: string;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
}

export interface ToolPIIRenderOptions {
  piiAccess?: ToolPIIAccess;
  auditContext?: PIIAuditContext;
}

/** Result of `restorePIITokensForToolExecution` — carries both the rendered
 *  value and the set of PII tokens that were actually substituted. */
export interface PIIRestorationResult {
  value: unknown;
  dispensedTokens: PIIToken[];
}

function normalizeToolPIIAccess(value: unknown): ToolPIIAccess {
  return value === 'original' ||
    value === 'user' ||
    value === 'logs' ||
    value === 'llm' ||
    value === 'tools'
    ? value
    : 'tools';
}

export function getToolPIIAccess(session: RuntimeSession, toolName: string): ToolPIIAccess {
  const tools = session.agentIR?.tools;
  if (!Array.isArray(tools)) {
    return 'tools';
  }

  const tool = tools.find((candidate) => candidate?.name === toolName);
  return normalizeToolPIIAccess((tool as { pii_access?: unknown } | undefined)?.pii_access);
}

export function restorePIITokensForToolExecution(
  session: RuntimeSession,
  value: unknown,
  options: ToolPIIRenderOptions = {},
): PIIRestorationResult {
  if (!session.piiVault) {
    return { value, dispensedTokens: [] };
  }

  const piiAccess = normalizeToolPIIAccess(options.piiAccess);

  const result = restoreValue(session, value, piiAccess, options);

  // Choke-point audit emission: when auditContext is provided and tokens
  // were dispensed as plaintext ('original'), emit audit events here.
  // This removes the "callers must remember to emit" anti-pattern (F-1).
  const { auditContext } = options;
  if (auditContext && piiAccess === 'original' && result.dispensedTokens.length > 0) {
    emitPIIAuditEvents(result.dispensedTokens, auditContext, session);
  }

  // F-11: Warn when pattern-level overrides suppress a tool's 'original' access.
  // This means the tool requested plaintext but a pattern config forced a different
  // render mode (e.g., redacted). The tool silently receives non-plaintext — warn.
  if (auditContext && result.suppressedPatterns.length > 0) {
    for (const suppression of result.suppressedPatterns) {
      auditContext.onTraceEvent?.({
        type: 'pii_pattern_override_suppressed_original',
        data: {
          toolName: auditContext.toolName,
          entityType: suppression.patternName,
          requestedMode: 'original',
          actualMode: suppression.actualMode,
          agentId: auditContext.agentId ?? '',
          sessionId: auditContext.sessionId || session.id || '',
        },
      });
    }
    log.warn('pii-pattern-override-suppressed-original', {
      toolName: auditContext.toolName,
      suppressedCount: result.suppressedPatterns.length,
      patterns: result.suppressedPatterns.map((s) => s.patternName),
    });
  }

  return result;
}

/** Internal result type — extends PIIRestorationResult with suppression info for F-11. */
interface InternalRestorationResult extends PIIRestorationResult {
  suppressedPatterns: Array<{ patternName: string; actualMode: PIIRenderMode }>;
}

/** Internal recursive walk that accumulates dispensed tokens across all leaves. */
function restoreValue(
  session: RuntimeSession,
  value: unknown,
  piiAccess: ToolPIIAccess,
  options: ToolPIIRenderOptions,
): InternalRestorationResult {
  if (typeof value === 'string') {
    // The vault's renderForConsumerWithTrace handles both {{PII:...}} tokens
    // AND bare UUIDs (LLM-stripped wrappers). Skip only when there are no tokens to match.
    if (!value.includes('{{PII:') && !session.piiVault!.getTokenCount()) {
      return { value, dispensedTokens: [], suppressedPatterns: [] };
    }

    const { text, renderedTokens, suppressedPatterns } =
      session.piiVault!.renderForConsumerWithTrace(value, piiAccess, session.piiPatternConfigs);
    return { value: text, dispensedTokens: renderedTokens, suppressedPatterns };
  }

  if (Array.isArray(value)) {
    const allDispensed: PIIToken[] = [];
    const allSuppressed: Array<{ patternName: string; actualMode: PIIRenderMode }> = [];
    const mapped = value.map((entry) => {
      const {
        value: restored,
        dispensedTokens,
        suppressedPatterns,
      } = restoreValue(session, entry, piiAccess, options);
      allDispensed.push(...dispensedTokens);
      allSuppressed.push(...suppressedPatterns);
      return restored;
    });
    return { value: mapped, dispensedTokens: allDispensed, suppressedPatterns: allSuppressed };
  }

  if (value && typeof value === 'object') {
    const allDispensed: PIIToken[] = [];
    const allSuppressed: Array<{ patternName: string; actualMode: PIIRenderMode }> = [];
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      const {
        value: restored,
        dispensedTokens,
        suppressedPatterns,
      } = restoreValue(session, entry, piiAccess, options);
      allDispensed.push(...dispensedTokens);
      allSuppressed.push(...suppressedPatterns);
      return [key, restored] as const;
    });
    return {
      value: Object.fromEntries(entries),
      dispensedTokens: allDispensed,
      suppressedPatterns: allSuppressed,
    };
  }

  return { value, dispensedTokens: [], suppressedPatterns: [] };
}

/**
 * Emit pii_plaintext_dispensed audit events for each unique token dispensed.
 *
 * F-5: Dedup across nested leaves — a Map keyed by token.id ensures that
 * the same PII token appearing in multiple leaves emits exactly ONE event.
 *
 * F-10: When tenantId is falsy (empty string or undefined), use the
 * '__internal__' sentinel so audit data is never silently lost, and emit
 * a pii_audit_missing_tenant warning event for investigation.
 */
function emitPIIAuditEvents(
  dispensedTokens: PIIToken[],
  ctx: PIIAuditContext,
  session: RuntimeSession,
): void {
  // Dedup by token ID — same token in multiple leaves → 1 audit event
  const uniqueTokens = new Map<string, PIIToken>();
  for (const token of dispensedTokens) {
    if (!uniqueTokens.has(token.id)) {
      uniqueTokens.set(token.id, token);
    }
  }

  const tenantId = ctx.tenantId || session.tenantId || '';
  const projectId = ctx.projectId || session.projectId || '';
  const sessionId = ctx.sessionId || session.id || '';

  // F-10: warn when tenantId is falsy
  const effectiveTenantId = tenantId || '__internal__';
  if (!tenantId && ctx.onTraceEvent) {
    ctx.onTraceEvent({
      type: 'pii_audit_missing_tenant',
      data: {
        toolName: ctx.toolName,
        agentId: ctx.agentId ?? '',
        sessionId,
        message: 'tenantId is empty — using __internal__ sentinel for audit continuity',
      },
    });
    log.warn('pii-audit-missing-tenant', {
      toolName: ctx.toolName,
      sessionId,
    });
  }

  for (const token of uniqueTokens.values()) {
    const entityHash = createHash('sha256').update(token.original).digest('hex');

    ctx.onTraceEvent?.({
      type: 'pii_plaintext_dispensed',
      data: {
        tenantId: effectiveTenantId,
        projectId,
        sessionId,
        toolName: ctx.toolName,
        entityType: token.type,
        entityHash,
        agentId: ctx.agentId ?? '',
        piiAccess: 'original',
      },
    });

    getPIIAuditLogger().log({
      tenantId: effectiveTenantId,
      projectId,
      sessionId,
      tokenId: token.id,
      piiType: token.type,
      consumer: 'original',
      action: 'plaintext_dispensed',
      metadata: { toolName: ctx.toolName, entityHash },
    });
  }
}

export function restorePIITokensForToolExecutionText(
  session: RuntimeSession,
  value: string,
  options?: ToolPIIRenderOptions,
): string {
  const { value: result } = restorePIITokensForToolExecution(session, value, options);
  return result as string;
}

export function restorePIITokensForTrustedInternalExecution(
  session: RuntimeSession,
  value: unknown,
): unknown {
  if (!session.piiVault) {
    return value;
  }

  if (typeof value === 'string') {
    if (!value.includes('{{PII:') && !session.piiVault.getTokenCount()) {
      return value;
    }
    return session.piiVault.renderForConsumer(value, 'original');
  }

  if (Array.isArray(value)) {
    return value.map((entry) => restorePIITokensForTrustedInternalExecution(session, entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        restorePIITokensForTrustedInternalExecution(session, entry),
      ]),
    );
  }

  return value;
}

export function restorePIITokensForTrustedInternalExecutionText(
  session: RuntimeSession,
  value: string,
): string {
  return restorePIITokensForTrustedInternalExecution(session, value) as string;
}
