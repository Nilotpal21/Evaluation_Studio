/**
 * Output Guardrail Checker
 *
 * Evaluates output-kind guardrails on finalized response text before delivery.
 * Extracted as a pure helper to be reusable across reasoning and flow executors.
 */

import type {
  Guardrail,
  GuardrailActionType,
  GuardrailContext,
  GuardrailPipelineResult,
  PipelinePolicy,
  LLMEvalFunction,
} from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import {
  createGuardrailPipeline,
  ensureTenantProvidersLoaded,
} from '../guardrails/pipeline-factory.js';
import { emitDecisionEvent } from './trace-helpers.js';
import type { RuntimeSession } from './types.js';
import { getSessionGuardrailCacheScopeKey } from './session-policy.js';

const log = createLogger('output-guardrails');

export interface OutputGuardrailResult {
  passed: boolean;
  text: string;
  /** Modified content from redact/fix/filter actions (set when actions modify the output) */
  modifiedContent?: string;
  violation?: {
    guardrailName: string;
    action: GuardrailActionType;
    message: string;
    /** Forwarded from `GuardrailViolation.presetKey` for trace-event correlation. */
    presetKey?: string;
  };
  pipelineResult?: GuardrailPipelineResult;
}

export async function checkOutputGuardrails(
  text: string,
  guardrails: Guardrail[] | undefined,
  context: GuardrailContext,
  policy?: PipelinePolicy,
  llmEval?: LLMEvalFunction,
  tenantId?: string,
  session?: RuntimeSession,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): Promise<OutputGuardrailResult> {
  // Pipeline merges additionalGuardrails internally — pass DSL guardrails only
  const dslGuardrails = guardrails ?? [];

  if (!text || (dslGuardrails.length === 0 && !policy?.additionalGuardrails?.length)) {
    return { passed: true, text };
  }

  try {
    if (tenantId) {
      await ensureTenantProvidersLoaded(tenantId);
    }
    const pipeline = createGuardrailPipeline(llmEval, tenantId, session?.projectId, {
      policy,
      piiRecognizerRegistry: session?.piiRecognizerRegistry,
      cacheScopeKey: session ? getSessionGuardrailCacheScopeKey(session) : undefined,
    });
    const result = await pipeline.execute(
      dslGuardrails,
      text,
      'output',
      context,
      undefined,
      policy,
    );

    if (session) {
      emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'guardrail_check', {
        outcome: result.passed ? 'pass' : (result.primaryViolation?.action ?? 'block'),
        matched: result.passed,
        trigger: result.primaryViolation
          ? { guardrail: result.primaryViolation.name, tier: result.primaryViolation.tier }
          : undefined,
      });
    }

    if (!result.passed && result.primaryViolation) {
      const violation = result.primaryViolation;
      log.warn('Output guardrail violation', {
        guardrail: violation.name,
        action: violation.action,
        message: violation.message,
      });

      return {
        passed: false,
        text,
        modifiedContent: result.modifiedContent,
        violation: {
          guardrailName: violation.name,
          action: violation.action,
          message: violation.message,
          presetKey: violation.presetKey,
        },
        pipelineResult: result,
      };
    }

    // Even when passed, modifiedContent may be set (e.g. redact action that doesn't block)
    return {
      passed: true,
      text: result.modifiedContent ?? text,
      modifiedContent: result.modifiedContent,
      pipelineResult: result,
    };
  } catch (err) {
    log.warn('Output guardrail evaluation failed (fail-open)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { passed: true, text };
  }
}
