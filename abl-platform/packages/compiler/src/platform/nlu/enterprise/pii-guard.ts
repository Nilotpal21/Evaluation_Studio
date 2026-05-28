/**
 * PII Guard
 *
 * Pipeline hook that redacts PII from user messages before LLM processing.
 * Context-aware: exempts PII types that match fields currently being gathered,
 * so entity extraction isn't blocked by redaction.
 *
 * XO migration note: This replaces XO's Sensitive:<streamId>:<userId> Redis key
 * pattern with NLUContext.missingFields, which already tracks active gather fields.
 */

import { createLogger } from '../../logger.js';
import type { NLUContext, NLUTask, EntityDefinition } from '../types.js';
import type { NLUConfig } from '../config.js';
import { detectPIISelective, type PIIType } from '../../security/pii-detector.js';
import { getDefaultPIIRecognizerRegistry } from '../../security/pii-recognizer-registry.js';
import type { PIIRecognizerRegistry } from '../../security/pii-recognizer-registry.js';

const log = createLogger('pii-guard');

/** Map field/entity names to PII types they represent */
const FIELD_NAME_TO_PII_TYPE: Record<string, PIIType> = {
  phone: 'phone',
  phone_number: 'phone',
  telephone: 'phone',
  mobile: 'phone',
  cell: 'phone',
  contact_phone: 'phone',
  email: 'email',
  email_address: 'email',
  contact_email: 'email',
  ssn: 'ssn',
  social_security: 'ssn',
  social_security_number: 'ssn',
  credit_card: 'credit_card',
  card_number: 'credit_card',
  cc_number: 'credit_card',
  ip: 'ip_address',
  ip_address: 'ip_address',
};

/** Map entity types to PII types */
const ENTITY_TYPE_TO_PII_TYPE: Record<string, PIIType> = {
  phone: 'phone',
  email: 'email',
  ssn: 'ssn',
  credit_card: 'credit_card',
};

/**
 * Resolve which PII types should be exempted based on active gather context.
 * Only exempts types for fields that are currently being gathered (in missingFields).
 */
export function resolveGatherExemptions(
  missingFields: string[] | undefined,
  declaredEntities: EntityDefinition[] | undefined,
): Set<PIIType> {
  const exempt = new Set<PIIType>();
  if (!missingFields?.length) return exempt;

  const entityMap = new Map<string, EntityDefinition>();
  if (declaredEntities) {
    for (const entity of declaredEntities) {
      entityMap.set(entity.name, entity);
    }
  }

  for (const fieldName of missingFields) {
    const normalized = fieldName.toLowerCase();

    // Check field name mapping
    const fromName = FIELD_NAME_TO_PII_TYPE[normalized];
    if (fromName) {
      exempt.add(fromName);
      continue;
    }

    // Check entity definition type mapping
    const entity = entityMap.get(fieldName);
    if (entity) {
      const fromEntityType = ENTITY_TYPE_TO_PII_TYPE[entity.type];
      if (fromEntityType) {
        exempt.add(fromEntityType);
      }
    }
  }

  return exempt;
}

/**
 * Create a beforeExecute hook that redacts PII from user messages.
 * Context-aware: exempts PII types matching active gather fields.
 */
export interface PIIGuardHookOptions {
  recognizerRegistry?: PIIRecognizerRegistry;
  /** Confidence floor — detections below the threshold are dropped. */
  confidenceThreshold?: number;
  /**
   * Optional latency callback — invoked synchronously after detection
   * with the wall-time in ms. The runtime caller wires this to
   * `recordPIIDetectLatency({ entry_point: 'nlu_guard', tier, ms })`;
   * the compiler package does not take a runtime → trace edge.
   */
  onDetectLatency?: (ms: number) => void;
}

export function createPIIGuardHook(
  config: NLUConfig,
  options?: PIIGuardHookOptions,
): (ctx: NLUContext, task: NLUTask) => Promise<NLUContext> {
  if (!config.piiRedaction.enabled || !config.piiRedaction.redactInput) {
    return async (ctx: NLUContext) => ctx;
  }

  const recognizerRegistry = options?.recognizerRegistry ?? getDefaultPIIRecognizerRegistry();
  const threshold = options?.confidenceThreshold;
  const onLatency = options?.onDetectLatency;

  return async (ctx: NLUContext): Promise<NLUContext> => {
    const exemptTypes = resolveGatherExemptions(ctx.missingFields, ctx.declaredEntities);

    const t0 = performance.now();
    const result = detectPIISelective(ctx.userMessage, exemptTypes, recognizerRegistry, {
      confidenceThreshold: threshold,
    });
    onLatency?.(performance.now() - t0);

    if (result.hasPII) {
      log.info('pii-detected', {
        types: result.detections.map((d) => d.type),
        exempted: result.exemptedTypes,
        redacted: result.redactedTypes,
      });
    }

    if (result.redacted === ctx.userMessage) {
      return ctx;
    }

    return {
      ...ctx,
      userMessage: result.redacted,
    };
  };
}
