/**
 * PII Pattern Service
 *
 * Validation, business logic, and regex testing for PII patterns.
 * Handles regex compilation checks, catastrophic backtracking detection,
 * length limits, and name uniqueness within a project.
 */

import {
  applyMask,
  createLogger,
  generateRandomReplacement,
  maskValue,
  type MaskConfig,
  type PIIRenderMode,
  type PIIType,
  type RandomRedactionConfig,
} from '@abl/compiler/platform';
import { getDefaultPIIRecognizerRegistry } from '@abl/compiler/platform/security/pii-recognizer-registry.js';
import * as piiPatternRepo from '../../repos/pii-pattern-repo.js';
import { buildSandboxedValidator } from './pattern-loader.js';

const log = createLogger('pii-pattern-service');

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_REGEX_LENGTH = 2048;
const MAX_VALIDATOR_LENGTH = 1024;
const DEFAULT_MASK_CHAR = '*';
const DEFAULT_MASK_SUFFIX_LENGTH = 4;
const FALLBACK_REDACTION_LABEL = '[REDACTED]';
const LLM_CONSUMER = 'llm';
const TOKENIZED_RENDER_MODE: PIIRenderMode = 'tokenized';
const ORIGINAL_RENDER_MODE: PIIRenderMode = 'original';
const VALID_RENDER_MODES = new Set<PIIRenderMode>([
  'original',
  'masked',
  'redacted',
  'tokenized',
  'random',
]);
const BUILTIN_PII_TYPES = new Set<PIIType>(['email', 'phone', 'ssn', 'credit_card', 'ip_address']);

/**
 * Patterns that indicate catastrophic backtracking risk.
 * Matches nested quantifiers on capturing groups, e.g. (.+)+, (.*)*,
 * (.+)*, (.*)+, and deeper nesting variants.
 */
export const CATASTROPHIC_BACKTRACKING_PATTERNS = [
  /\([^)]*[+*][^)]*\)[+*]/,
  /\(\.\+\)\+/,
  /\(\.\*\)\*/,
  /\(\.\+\)\*/,
  /\(\.\*\)\+/,
];

// ─── Validation Types ───────────────────────────────────────────────────────

export interface PatternValidationResult {
  valid: boolean;
  errors: string[];
}

export interface PatternTestResult {
  detections: Array<{
    match: string;
    index: number;
    length: number;
    /**
     * Detection confidence in [0,1]. For regex previews this defaults to 1.0
     * since custom user regexes have no calibrated baseline. For built-in
     * recognizers the value flows from the underlying `PIIDetection`.
     */
    confidence: number;
    /**
     * Originating recognizer name (e.g. `core-email`, `eu-iban`). Absent when
     * the preview was driven by a free-form user regex with no recognizer
     * provenance.
     */
    recognizer?: string;
  }>;
  consumerPreviews: Record<string, string>;
}

export function isBuiltinPIIType(piiType?: string): piiType is PIIType {
  return typeof piiType === 'string' && BUILTIN_PII_TYPES.has(piiType as PIIType);
}

export function normalizePatternConsumerAccess(
  consumerAccess: unknown,
  defaultRenderMode: unknown,
): Array<{ consumer: string; renderMode: string }> {
  const normalized = Array.isArray(consumerAccess)
    ? consumerAccess.map((rule) => {
        const record =
          typeof rule === 'object' && rule !== null ? (rule as Record<string, unknown>) : {};
        const rawConsumer =
          typeof record.consumer === 'string'
            ? record.consumer.trim()
            : String(record.consumer ?? '');
        const consumer = rawConsumer.toLowerCase() === LLM_CONSUMER ? LLM_CONSUMER : rawConsumer;
        const renderMode = typeof record.renderMode === 'string' ? record.renderMode : 'redacted';

        if (consumer.toLowerCase() === LLM_CONSUMER && renderMode === ORIGINAL_RENDER_MODE) {
          return { consumer, renderMode: TOKENIZED_RENDER_MODE };
        }

        return { consumer, renderMode };
      })
    : [];

  const hasLlmRule = normalized.some((rule) => rule.consumer.toLowerCase() === LLM_CONSUMER);
  if (!hasLlmRule && defaultRenderMode === ORIGINAL_RENDER_MODE) {
    return [...normalized, { consumer: LLM_CONSUMER, renderMode: TOKENIZED_RENDER_MODE }];
  }

  return normalized;
}

export function normalizePatternPayloadForStorage(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...payload,
    consumerAccess: normalizePatternConsumerAccess(
      payload.consumerAccess,
      payload.defaultRenderMode,
    ),
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a PII pattern payload before create or update.
 *
 * Checks:
 * - Required fields (name, piiType, redaction, defaultRenderMode)
 * - Regex compilation
 * - Max regex length (2048 chars)
 * - Catastrophic backtracking detection
 * - Validator length (max 1024 chars)
 * - Name uniqueness within project (skips if excludeId is provided and matches)
 */
export async function validatePattern(
  data: Record<string, unknown>,
  tenantId: string,
  projectId: string,
  excludeId?: string,
): Promise<PatternValidationResult> {
  const errors: string[] = [];

  // Required fields
  const requiredFields = ['name', 'piiType', 'redaction', 'defaultRenderMode'];
  for (const field of requiredFields) {
    if (data[field] === undefined || data[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Regex validation (required for non-builtin-override patterns)
  const regex = data.regex as string | undefined;
  if (regex !== undefined && regex !== null) {
    // Length check
    if (regex.length > MAX_REGEX_LENGTH) {
      errors.push(`Regex exceeds maximum length of ${MAX_REGEX_LENGTH} characters`);
    }

    // Compilation check
    try {
      new RegExp(regex);
    } catch {
      errors.push('Invalid regex: failed to compile');
    }

    // Catastrophic backtracking detection
    for (const pattern of CATASTROPHIC_BACKTRACKING_PATTERNS) {
      if (pattern.test(regex)) {
        errors.push(
          'Regex contains patterns that may cause catastrophic backtracking (nested quantifiers on groups)',
        );
        break;
      }
    }
  }

  // Validator length check
  const validate = data.validate as string | undefined;
  if (validate !== undefined && validate !== null && validate.length > MAX_VALIDATOR_LENGTH) {
    errors.push(`Validator exceeds maximum length of ${MAX_VALIDATOR_LENGTH} characters`);
  }

  // Name uniqueness within project — applies only to CUSTOM patterns. Built-in
  // overrides are keyed by `(projectId, piiType)`, so two patterns can share a
  // name as long as one is the built-in override and the other is custom. The
  // route handler upserts built-in overrides by piiType, so concurrent POSTs
  // converge on a single record without ever hitting this check.
  const name = data.name as string | undefined;
  const isBuiltinOverride = data.builtinOverride === true;
  if (name && !isBuiltinOverride) {
    try {
      const existing = await piiPatternRepo.findByName(tenantId, projectId, name);
      // Reject if a same-named pattern exists AND it is NOT the one being
      // edited (excludeId) AND it is NOT a built-in override (which lives in
      // a separate uniqueness namespace).
      if (existing && existing._id !== excludeId && existing.builtinOverride !== true) {
        errors.push('A pattern with this name already exists in this project');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to check name uniqueness', { error: message });
      errors.push('Unable to verify name uniqueness');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Test ───────────────────────────────────────────────────────────────────

/**
 * Test a regex against sample text and return detections + consumer previews.
 *
 * The consumer preview shows how each consumer would see the text after
 * redaction is applied (based on redaction config and consumer access rules).
 */
export function testPattern(
  regex: string | undefined,
  text: string,
  validate?: string,
  redaction?: Record<string, unknown>,
  consumerAccess?: Array<{ consumer: string; renderMode: string }>,
  defaultRenderMode?: string,
  piiType?: string,
): PatternTestResult {
  if (regex) {
    const detections = detectRegexMatches(regex, text, validate);
    if (!detections) {
      return { detections: [], consumerPreviews: {} };
    }

    return buildPatternTestResult(
      text,
      detections,
      redaction,
      consumerAccess,
      defaultRenderMode,
      piiType,
    );
  }

  if (isBuiltinPIIType(piiType)) {
    return buildPatternTestResult(
      text,
      detectBuiltinMatches(text, piiType),
      redaction,
      consumerAccess,
      defaultRenderMode,
      piiType,
    );
  }

  return { detections: [], consumerPreviews: {} };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function detectRegexMatches(
  regex: string,
  text: string,
  validate?: string,
): PatternTestResult['detections'] | null {
  const detections: PatternTestResult['detections'] = [];

  let compiledRegex: RegExp;
  try {
    compiledRegex = new RegExp(regex, 'g');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Test regex failed to compile', { error: message });
    return null;
  }

  let match: RegExpExecArray | null;
  const maxDetections = 100;
  while ((match = compiledRegex.exec(text)) !== null) {
    detections.push({
      match: match[0],
      index: match.index,
      length: match[0].length,
      confidence: 1.0,
    });
    if (detections.length >= maxDetections) break;
    if (match[0].length === 0) {
      compiledRegex.lastIndex++;
    }
  }

  if (validate && detections.length > 0) {
    try {
      const validator = buildSandboxedValidator(validate);
      const filtered = detections.filter((d) => validator(d.match));
      detections.length = 0;
      detections.push(...filtered);
    } catch {
      // Validator regex invalid or rejected (e.g. catastrophic backtracking) — skip filtering
    }
  }

  return detections;
}

function detectBuiltinMatches(text: string, piiType: PIIType): PatternTestResult['detections'] {
  const registry = getDefaultPIIRecognizerRegistry();
  // Recognizer name migration `builtin-*` → `core-*` happened in the tiered
  // recognizers sub-feature; legacy `builtin-*` names retained as a thin shim.
  // Match either prefix so this preview keeps working through the rename.
  const recognizerMetadata = registry
    .listRecognizers()
    .find(
      (entry) =>
        (entry.name.startsWith('core-') || entry.name.startsWith('builtin-')) &&
        entry.types.includes(piiType),
    );

  if (!recognizerMetadata) {
    log.warn('Built-in PII recognizer metadata not found for preview', { piiType });
    return [];
  }

  const recognizer = registry.get(recognizerMetadata.name);
  if (!recognizer) {
    log.warn('Built-in PII recognizer missing for preview', {
      piiType,
      recognizer: recognizerMetadata.name,
    });
    return [];
  }

  return recognizer
    .detect(text)
    .filter((detection) => detection.type === piiType)
    .map((detection) => ({
      match: text.slice(detection.start, detection.end),
      index: detection.start,
      length: detection.end - detection.start,
      confidence: detection.confidence,
      recognizer: detection.recognizer ?? recognizerMetadata.name,
    }));
}

function buildPatternTestResult(
  text: string,
  detections: PatternTestResult['detections'],
  redaction?: Record<string, unknown>,
  consumerAccess?: Array<{ consumer: string; renderMode: string }>,
  defaultRenderMode?: string,
  piiType?: string,
): PatternTestResult {
  const consumerPreviews: Record<string, string> = {};
  const previewRenderContext: PreviewRenderContext = {
    piiType: normalizePreviewPIIType(piiType),
    tokenType: normalizePreviewTokenType(piiType),
    randomReplacementCache: new Map<string, string>(),
  };

  consumerPreviews['default'] = buildPreviewText(
    text,
    detections,
    redaction,
    defaultRenderMode,
    previewRenderContext,
  );

  if (consumerAccess && consumerAccess.length > 0) {
    for (const access of consumerAccess) {
      consumerPreviews[access.consumer] = buildPreviewText(
        text,
        detections,
        redaction,
        access.renderMode,
        previewRenderContext,
      );
    }
  }

  return { detections, consumerPreviews };
}

/**
 * Replace all detected spans in text with a render-mode-specific preview.
 * Falls back to redacted mode for unsupported values and accepts legacy
 * `plain` as an alias for `original`.
 */
function buildPreviewText(
  text: string,
  detections: PatternTestResult['detections'],
  redaction: Record<string, unknown> | undefined,
  renderMode: string | undefined,
  context: PreviewRenderContext,
): string {
  if (detections.length === 0) return text;

  const normalizedRenderMode = normalizePreviewRenderMode(renderMode);
  const orderedDetections = detections
    .map((detection, order) => ({ detection, order }))
    .sort((left, right) => right.detection.index - left.detection.index);
  let result = text;
  for (const { detection, order } of orderedDetections) {
    const replacement = buildPreviewReplacement(
      detection,
      order,
      redaction,
      normalizedRenderMode,
      context,
    );
    result =
      result.slice(0, detection.index) +
      replacement +
      result.slice(detection.index + detection.length);
  }
  return result;
}

/**
 * Compute the replacement string for a single detection based on render mode.
 */
function buildPreviewReplacement(
  detection: PatternTestResult['detections'][number],
  order: number,
  redaction: Record<string, unknown> | undefined,
  renderMode: PIIRenderMode,
  context: PreviewRenderContext,
): string {
  const matchText = detection.match;

  switch (renderMode) {
    case 'original':
      return matchText;
    case 'masked': {
      const maskConfig = getMaskConfig(redaction);
      if (maskConfig) {
        return applyMask(matchText, maskConfig);
      }
      if (context.piiType) {
        return maskValue(matchText, context.piiType);
      }
      return buildGenericMaskedText(matchText);
    }
    case 'redacted':
      return getRedactedReplacementString(redaction, FALLBACK_REDACTION_LABEL);
    case 'tokenized':
      return buildPreviewToken(order, context.tokenType);
    case 'random':
      return getRandomPreviewReplacement(detection, redaction, context);
    default:
      return getConfiguredReplacementString(matchText, redaction, FALLBACK_REDACTION_LABEL);
  }
}

function getRedactedReplacementString(
  redaction: Record<string, unknown> | undefined,
  defaultLabel: string,
): string {
  return redaction?.type === 'predefined'
    ? (redaction.label as string) || defaultLabel
    : defaultLabel;
}

/**
 * Compute the configured redaction replacement for a single detection.
 */
function getConfiguredReplacementString(
  matchText: string,
  redaction: Record<string, unknown> | undefined,
  defaultLabel: string,
): string {
  if (!redaction) return defaultLabel;
  const type = redaction.type as string | undefined;
  if (type === 'predefined') {
    return (redaction.label as string) || defaultLabel;
  }

  if (type === 'masked') {
    const maskConfig = getMaskConfig(redaction);
    return maskConfig ? applyMask(matchText, maskConfig) : defaultLabel;
  }

  if (type === 'random') {
    return generateRandomReplacement(
      getRandomConfig(redaction, matchText.length),
      matchText.length,
    );
  }

  return defaultLabel;
}

interface PreviewRenderContext {
  piiType?: PIIType;
  tokenType: string;
  randomReplacementCache: Map<string, string>;
}

function normalizePreviewRenderMode(renderMode?: string): PIIRenderMode {
  const normalized = renderMode === 'plain' ? 'original' : renderMode;
  return VALID_RENDER_MODES.has(normalized as PIIRenderMode)
    ? (normalized as PIIRenderMode)
    : 'redacted';
}

function normalizePreviewPIIType(piiType?: string): PIIType | undefined {
  return piiType && BUILTIN_PII_TYPES.has(piiType as PIIType) ? (piiType as PIIType) : undefined;
}

function normalizePreviewTokenType(piiType?: string): string {
  if (!piiType) {
    return 'preview';
  }

  const normalized = piiType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_');
  return normalized.length > 0 ? normalized : 'preview';
}

function getMaskConfig(redaction: Record<string, unknown> | undefined): MaskConfig | undefined {
  const maskConfig = redaction?.maskConfig as Partial<MaskConfig> | undefined;
  if (!maskConfig) {
    return undefined;
  }

  return {
    showFirst: typeof maskConfig.showFirst === 'number' ? maskConfig.showFirst : 0,
    showLast: typeof maskConfig.showLast === 'number' ? maskConfig.showLast : 0,
    maskChar:
      typeof maskConfig.maskChar === 'string' && maskConfig.maskChar.length > 0
        ? maskConfig.maskChar
        : DEFAULT_MASK_CHAR,
  };
}

function buildGenericMaskedText(matchText: string): string {
  if (matchText.length === 0) {
    return matchText;
  }
  if (matchText.length <= DEFAULT_MASK_SUFFIX_LENGTH) {
    return DEFAULT_MASK_CHAR.repeat(matchText.length);
  }

  return applyMask(matchText, {
    showFirst: 0,
    showLast: DEFAULT_MASK_SUFFIX_LENGTH,
    maskChar: DEFAULT_MASK_CHAR,
  });
}

function buildPreviewToken(order: number, tokenType: string): string {
  return `{{PII:${tokenType}:preview-${order + 1}}}`;
}

function getRandomPreviewReplacement(
  detection: PatternTestResult['detections'][number],
  redaction: Record<string, unknown> | undefined,
  context: PreviewRenderContext,
): string {
  const cacheKey = `${detection.index}:${detection.length}:${detection.match}`;
  const cached = context.randomReplacementCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const replacement = generateRandomReplacement(
    getRandomConfig(redaction, detection.match.length),
    detection.match.length,
  );
  context.randomReplacementCache.set(cacheKey, replacement);
  return replacement;
}

function getRandomConfig(
  redaction: Record<string, unknown> | undefined,
  matchLength: number,
): RandomRedactionConfig {
  const randomConfig = redaction?.randomConfig as Partial<RandomRedactionConfig> | undefined;
  const length =
    typeof randomConfig?.length === 'number' && randomConfig.length > 0
      ? randomConfig.length
      : matchLength;

  if (randomConfig?.charset === 'custom') {
    return {
      charset: 'custom',
      customChars:
        typeof randomConfig.customChars === 'string' && randomConfig.customChars.length > 0
          ? randomConfig.customChars
          : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      length,
    };
  }

  if (
    randomConfig?.charset === 'alphanumeric' ||
    randomConfig?.charset === 'alphabetic' ||
    randomConfig?.charset === 'numeric'
  ) {
    return {
      charset: randomConfig.charset,
      length,
    };
  }

  return {
    charset: 'alphanumeric',
    length,
  };
}
