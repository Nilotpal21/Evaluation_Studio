/**
 * PII Pattern Loader
 *
 * Loads custom PII patterns from the database at session init and registers
 * them in the recognizer registry. Returns consumer access configs for vault
 * rendering.
 */

import {
  createLogger,
  RegexPIIRecognizer,
  type PIIRecognizerRegistry,
  type PIIPatternConfig,
  type PIIRenderMode,
  type PIIConsumerAccessRule,
  type PIIType,
} from '@abl/compiler/platform';
import { registerPacks } from '@abl/compiler/platform/security';
import type { PackName } from '@agent-platform/shared/validation';
import { isDatabaseReady } from '../../db/index.js';
import { findAll } from '../../repos/pii-pattern-repo.js';
import { CATASTROPHIC_BACKTRACKING_PATTERNS } from './pattern-service.js';

const log = createLogger('pii-pattern-loader');

/** Timeout for sandboxed validator expressions (ms) */
const SANDBOX_TIMEOUT_MS = 50;
const CUSTOM_PII_TYPE = 'custom';
const MAX_CUSTOM_TYPE_SEGMENT_LENGTH = 64;

interface PIIPatternConsumerAccess {
  consumer: string;
  renderMode: string;
}

interface PIIPatternRedaction {
  type?: string;
  label?: string;
  maskConfig?: PIIPatternConfig['maskConfig'];
  randomConfig?: PIIPatternConfig['randomConfig'];
}

/**
 * Repository-shaped PII pattern record. The DB layer (`pii-pattern-repo`)
 * returns Mongoose lean docs typed as `unknown`; this interface is the
 * runtime contract this loader actually consumes. Fields are conservatively
 * optional because legacy documents may lack them.
 */
type PIIPatternRecord = {
  _id?: unknown;
  name?: string;
  piiType?: string;
  enabled?: boolean;
  builtinOverride?: boolean;
  regex?: string;
  validate?: string;
  defaultRenderMode?: string;
  consumerAccess?: PIIPatternConsumerAccess[];
  redaction?: PIIPatternRedaction;
};

function sanitizePIITypeSegment(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_CUSTOM_TYPE_SEGMENT_LENGTH);
}

function resolveRuntimePIIType(pattern: PIIPatternRecord): PIIType {
  const configuredType = typeof pattern.piiType === 'string' ? pattern.piiType.trim() : '';
  if (configuredType && configuredType !== CUSTOM_PII_TYPE) {
    return configuredType as PIIType;
  }

  const nameSegment = sanitizePIITypeSegment(pattern.name) || CUSTOM_PII_TYPE;
  const idSegment = sanitizePIITypeSegment(pattern._id).slice(0, 16);
  return `${CUSTOM_PII_TYPE}_${nameSegment}${idSegment ? `_${idSegment}` : ''}` as PIIType;
}

/**
 * Load PII patterns from the database for a tenant + project,
 * register custom recognizers in the registry, and return consumer access
 * configs for vault rendering.
 */
export async function loadProjectPIIPatterns(
  tenantId: string,
  projectId: string,
  registry: PIIRecognizerRegistry,
  options?: {
    enabledRecognizerPacks?: readonly PackName[];
    onPackDegraded?: (reason: 'unknown_pack', name: string) => void;
  },
): Promise<PIIPatternConfig[]> {
  // Order: built-ins (already registered by the caller via createRecognizerRegistry)
  // → enabled packs → custom patterns. Custom patterns retain their priority
  // (`tier: 'custom'` = priority 0, lowest numeric = highest in removeOverlaps).
  if (options?.enabledRecognizerPacks && options.enabledRecognizerPacks.length > 0) {
    registerPacks(options.enabledRecognizerPacks, registry, {
      onDegraded: options.onPackDegraded,
    });
  }

  if (!isDatabaseReady()) {
    log.debug('pii-pattern-load-skipped-db-unavailable', {
      tenantId,
      projectId,
    });
    return [];
  }

  let patterns: PIIPatternRecord[];
  try {
    patterns = (await findAll(tenantId, projectId)) as PIIPatternRecord[];
  } catch (err) {
    log.error('pii-pattern-load-failed', {
      tenantId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (patterns.length === 0) {
    return [];
  }

  const configs: PIIPatternConfig[] = [];

  for (const pattern of patterns) {
    if (pattern.builtinOverride) {
      if (pattern.enabled === false) {
        registry.disableType(pattern.piiType as PIIType);
        log.info('pii-builtin-recognizer-disabled', {
          name: pattern.name,
          piiType: pattern.piiType,
          tenantId,
          projectId,
        });
        continue;
      }
    } else if (pattern.enabled === false) {
      continue;
    }

    const runtimePIIType = resolveRuntimePIIType(pattern);

    // Register recognizer for custom patterns (non-builtin-override with regex)
    if (!pattern.builtinOverride && pattern.regex) {
      try {
        const regex = new RegExp(pattern.regex, 'g');
        const validator = pattern.validate ? buildSandboxedValidator(pattern.validate) : undefined;

        const recognizer = new RegexPIIRecognizer(
          `custom-${pattern.name}`,
          [runtimePIIType],
          regex,
          runtimePIIType,
          validator,
          'custom',
        );

        registry.register(recognizer);

        log.info('pii-custom-recognizer-registered', {
          name: pattern.name,
          piiType: pattern.piiType,
          runtimePIIType,
          tenantId,
          projectId,
        });
      } catch (err) {
        log.warn('pii-custom-recognizer-failed', {
          name: pattern.name,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue — still include the config for vault rendering
      }
    }

    // Collect consumer access config for vault rendering
    const consumerAccess: PIIConsumerAccessRule[] = (pattern.consumerAccess ?? []).map(
      (ca: { consumer: string; renderMode: string }) => ({
        consumer: ca.consumer,
        renderMode: ca.renderMode as PIIRenderMode,
      }),
    );

    const config: PIIPatternConfig = {
      patternName: runtimePIIType,
      defaultRenderMode: pattern.defaultRenderMode as PIIRenderMode,
      consumerAccess,
      maskConfig: pattern.redaction?.maskConfig,
      randomConfig: pattern.redaction?.randomConfig,
      redactionLabel:
        pattern.redaction?.type === 'predefined'
          ? typeof pattern.redaction?.label === 'string' && pattern.redaction.label.trim() !== ''
            ? pattern.redaction.label
            : '[REDACTED]'
          : undefined,
    };

    configs.push(config);
  }

  log.info('pii-patterns-loaded', {
    tenantId,
    projectId,
    total: patterns.length,
    custom: patterns.filter((p) => !p.builtinOverride).length,
    overrides: patterns.filter((p) => p.builtinOverride).length,
  });

  return configs;
}

/**
 * Check if a regex pattern has catastrophic backtracking risk.
 */
function hasCatastrophicBacktracking(pattern: string): boolean {
  return CATASTROPHIC_BACKTRACKING_PATTERNS.some((cp) => cp.test(pattern));
}

/**
 * Build a safe regex-only validator function from a user-provided expression.
 *
 * Only allows valid regex patterns — no arbitrary JS expressions.
 * The `validate` field is documented as a regex pattern; arbitrary JS
 * expressions are unnecessary and dangerous (vm.Script sandbox escapes).
 *
 * @returns A function that tests the regex against a matched value
 */
export function buildSandboxedValidator(expression: string): (value: string) => boolean {
  // Only allow regex patterns — no arbitrary JS
  let regex: RegExp;
  try {
    regex = new RegExp(expression);
  } catch {
    throw new Error(
      `Invalid validator expression: must be a valid regex pattern. Got: ${expression}`,
    );
  }

  // Check for catastrophic backtracking
  if (hasCatastrophicBacktracking(expression)) {
    throw new Error('Validator regex rejected: potential catastrophic backtracking');
  }

  return (value: string): boolean => {
    const startTime = performance.now();
    const result = regex.test(value);
    const elapsed = performance.now() - startTime;
    if (elapsed > SANDBOX_TIMEOUT_MS) {
      log.warn('PII validator regex took too long', { expression, elapsed });
    }
    return result;
  };
}
