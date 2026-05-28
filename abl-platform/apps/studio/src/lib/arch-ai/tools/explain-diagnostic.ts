/**
 * explain_diagnostic tool — returns rich context for a diagnostic code.
 * Looks up the rule registry and optionally provides agent-specific context.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';

const log = createLogger('arch-ai:explain-diagnostic');

interface ExplainDiagnosticInput {
  code: string;
  agentName?: string;
}

interface ExplainDiagnosticResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export async function executeExplainDiagnostic(
  input: ExplainDiagnosticInput,
  ctx: ToolPermissionContext,
): Promise<ExplainDiagnosticResult> {
  const perm = await checkToolPermission('health_check', 'run_check', ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  try {
    const { getRule, getFixTemplate } = await import('@agent-platform/arch-ai');
    const rule = getRule(input.code);

    if (!rule) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_RULE',
          message: `Diagnostic code "${input.code}" is not recognized. Valid codes follow patterns: H-XX (handoff), CO-XX (completion), F-XX (flow), C-XX (constraint), T-XX (tool), G-XX (gather), M-XX (memory), E-XX (execution), GR-XX (guardrail), BP-XX (behavior profile), O-XX (other), SV-XX (semantic).`,
        },
      };
    }

    const fix = getFixTemplate(input.code);

    const explanation: Record<string, unknown> = {
      code: rule.code,
      description: rule.description,
      impact: rule.impact,
      severity: rule.severity,
      category: rule.category,
      fixEffort: rule.fixEffort,
    };

    if (fix) {
      explanation.fix = {
        description: fix.description,
        template: fix.template,
        effort: fix.effort,
      };
    }

    // If agentName provided, add agent-specific context
    if (input.agentName) {
      const agentContext = await getAgentContext(
        ctx.projectId,
        ctx.user.tenantId,
        input.agentName,
        input.code,
      );
      if (agentContext) {
        explanation.agentContext = agentContext;
      }
    }

    log.info('Explained diagnostic', { code: input.code, agentName: input.agentName });
    return { success: true, data: explanation };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Explain diagnostic failed', { code: input.code, error: message });
    return { success: false, error: { code: 'EXPLAIN_ERROR', message } };
  }
}

async function getAgentContext(
  projectId: string,
  tenantId: string,
  agentName: string,
  code: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { findProjectAgent } = await import('@/repos/project-repo');
    const agent = await findProjectAgent(projectId, agentName, tenantId);
    if (!agent) return null;

    const dsl = agent.dslContent as string | undefined;
    if (!dsl) return { note: 'Agent has no DSL content' };

    // Provide relevant section of the agent based on the diagnostic category
    const prefix = code.split('-')[0];
    const sectionHints: Record<string, string[]> = {
      H: ['HANDOFF:', 'DELEGATE:', 'PASS:', 'RETURN:'],
      CO: ['COMPLETE:', 'WHEN:', 'RESPOND:'],
      F: ['FLOW:', 'STEP:', 'THEN:'],
      C: ['CONSTRAINTS:', 'ON_FAIL:'],
      T: ['TOOLS:', 'HTTP:', 'MCP:'],
      G: ['GATHER:', 'DEPENDS_ON:', 'VALIDATION:'],
      M: ['MEMORY:', 'remember:', 'recall:', 'REMEMBER:', 'RECALL:'],
      GR: ['GUARDRAILS:', 'TIER:', 'CHECK:'],
      BP: ['BEHAVIOR_PROFILE:', 'WHEN:'],
      E: ['EXECUTION:', 'MODEL:', 'MAX_ITERATIONS:'],
    };

    const keywords = sectionHints[prefix] ?? [];
    const relevantLines =
      keywords.length > 0
        ? dsl
            .split('\n')
            .filter((line) => keywords.some((kw) => line.includes(kw)))
            .slice(0, 10)
        : [];

    return {
      agentName,
      relevantSections: relevantLines.length > 0 ? relevantLines : undefined,
      dslLength: dsl.length,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('getAgentContext failed', { projectId, agentName, code, error: message });
    return { agentName, note: 'context_unavailable' };
  }
}
