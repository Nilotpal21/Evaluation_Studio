import {
  buildNLUConfig,
  createLogger,
  PIIRecognizerRegistry,
  PIIVault,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
  renderValueForPIIBoundary,
  type Environment,
  type PIIBoundaryContext,
  type PIIPatternConfig,
  type PIIRenderMode,
  type PIIType,
} from '@abl/compiler/platform';
import mongoose from 'mongoose';

const log = createLogger('pipeline-pii-boundary');
const PIPELINE_PII_CONTEXT_TTL_MS = 60_000;
const MAX_PIPELINE_PII_CONTEXT_CACHE = 500;
const CUSTOM_PII_TYPE = 'custom';
const MAX_CUSTOM_TYPE_SEGMENT_LENGTH = 64;

interface ProjectPIIRedactionConfig {
  enabled?: boolean;
  redact_input?: boolean;
  redact_output?: boolean;
}

interface PIIPatternRecord {
  _id?: unknown;
  name?: unknown;
  piiType?: unknown;
  regex?: unknown;
  validate?: unknown;
  redaction?: {
    type?: unknown;
    label?: unknown;
    maskConfig?: unknown;
    randomConfig?: unknown;
  };
  consumerAccess?: Array<{ consumer?: unknown; renderMode?: unknown }>;
  defaultRenderMode?: unknown;
  enabled?: unknown;
  builtinOverride?: unknown;
}

interface PipelinePIISnapshot {
  piiRedactionConfig: {
    enabled: boolean;
    redactInput: boolean;
    redactOutput: boolean;
  };
  piiPatternConfigs: PIIPatternConfig[];
  recognizerRegistry?: PIIRecognizerRegistry;
}

const pipelinePIIContextCache = new Map<
  string,
  { expiresAt: number; snapshot: PipelinePIISnapshot }
>();

function isMongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

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

function buildDefaultPIIRedactionConfig(
  environment?: Environment,
): PipelinePIISnapshot['piiRedactionConfig'] {
  const config = buildNLUConfig({
    environment: environment ?? 'dev',
    envVars: process.env as Record<string, string>,
  });
  return config.piiRedaction;
}

function mapProjectPIIRedactionConfig(
  pii: ProjectPIIRedactionConfig | undefined,
  environment?: Environment,
): PipelinePIISnapshot['piiRedactionConfig'] {
  const defaults = buildDefaultPIIRedactionConfig(environment);
  if (!pii) {
    return defaults;
  }
  return {
    enabled: pii.enabled ?? defaults.enabled,
    redactInput: pii.redact_input ?? defaults.redactInput,
    redactOutput: pii.redact_output ?? defaults.redactOutput,
  };
}

function createRecognizerRegistry(): PIIRecognizerRegistry {
  const registry = new PIIRecognizerRegistry();
  registerBuiltInRecognizers(registry);
  return registry;
}

function clonePatternConfigs(patternConfigs: PIIPatternConfig[]): PIIPatternConfig[] {
  return patternConfigs.map((patternConfig) => ({
    ...patternConfig,
    consumerAccess: patternConfig.consumerAccess.map((rule) => ({ ...rule })),
    ...(patternConfig.maskConfig ? { maskConfig: { ...patternConfig.maskConfig } } : {}),
    ...(patternConfig.randomConfig ? { randomConfig: { ...patternConfig.randomConfig } } : {}),
  }));
}

function cloneSnapshot(snapshot: PipelinePIISnapshot): PipelinePIISnapshot {
  return {
    piiRedactionConfig: { ...snapshot.piiRedactionConfig },
    piiPatternConfigs: clonePatternConfigs(snapshot.piiPatternConfigs),
    recognizerRegistry: snapshot.recognizerRegistry,
  };
}

function purgeExpiredCache(now: number): void {
  for (const [key, entry] of pipelinePIIContextCache) {
    if (entry.expiresAt <= now) {
      pipelinePIIContextCache.delete(key);
    }
  }
}

function getCachedSnapshot(cacheKey: string): PipelinePIISnapshot | undefined {
  const now = Date.now();
  purgeExpiredCache(now);
  const cached = pipelinePIIContextCache.get(cacheKey);
  if (!cached || cached.expiresAt <= now) {
    if (cached) {
      pipelinePIIContextCache.delete(cacheKey);
    }
    return undefined;
  }
  return cloneSnapshot(cached.snapshot);
}

function setCachedSnapshot(cacheKey: string, snapshot: PipelinePIISnapshot): void {
  const now = Date.now();
  purgeExpiredCache(now);
  if (
    !pipelinePIIContextCache.has(cacheKey) &&
    pipelinePIIContextCache.size >= MAX_PIPELINE_PII_CONTEXT_CACHE
  ) {
    const oldestKey = pipelinePIIContextCache.keys().next().value;
    if (oldestKey) {
      pipelinePIIContextCache.delete(oldestKey);
    }
  }
  pipelinePIIContextCache.set(cacheKey, {
    expiresAt: now + PIPELINE_PII_CONTEXT_TTL_MS,
    snapshot: cloneSnapshot(snapshot),
  });
}

function buildSandboxedValidator(expression: string): (value: string) => boolean {
  const regex = new RegExp(expression);
  return (value: string) => regex.test(value);
}

async function loadProjectPIIPatternConfigs(
  tenantId: string,
  projectId: string,
  registry: PIIRecognizerRegistry,
): Promise<PIIPatternConfig[]> {
  try {
    if (!isMongoReady()) {
      return [];
    }
    const { PIIPattern } = await import('@agent-platform/database/models');
    const patterns = (await PIIPattern.find({ tenantId, projectId })
      .sort({ name: 1 })
      .lean()) as PIIPatternRecord[];
    const configs: PIIPatternConfig[] = [];

    for (const pattern of patterns) {
      if (pattern.builtinOverride) {
        if (pattern.enabled === false && typeof pattern.piiType === 'string') {
          registry.disableType(pattern.piiType as PIIType);
          continue;
        }
      } else if (pattern.enabled === false) {
        continue;
      }

      const runtimePIIType = resolveRuntimePIIType(pattern);
      if (!pattern.builtinOverride && typeof pattern.regex === 'string' && pattern.regex.trim()) {
        try {
          registry.register(
            new RegexPIIRecognizer(
              `custom-${String(pattern.name ?? runtimePIIType)}`,
              [runtimePIIType],
              new RegExp(pattern.regex, 'g'),
              runtimePIIType,
              typeof pattern.validate === 'string' && pattern.validate.trim()
                ? buildSandboxedValidator(pattern.validate)
                : undefined,
              'custom',
            ),
          );
        } catch (err) {
          log.warn('pipeline-pii-custom-recognizer-failed', {
            tenantId,
            projectId,
            patternName: pattern.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      configs.push({
        patternName: runtimePIIType,
        defaultRenderMode: (pattern.defaultRenderMode as PIIRenderMode | undefined) ?? 'redacted',
        consumerAccess: (pattern.consumerAccess ?? []).map((rule) => ({
          consumer: String(rule.consumer ?? ''),
          renderMode: (rule.renderMode as PIIRenderMode | undefined) ?? 'redacted',
        })),
        maskConfig:
          pattern.redaction?.type === 'masked'
            ? (pattern.redaction.maskConfig as PIIPatternConfig['maskConfig'])
            : undefined,
        randomConfig:
          pattern.redaction?.type === 'random'
            ? (pattern.redaction.randomConfig as PIIPatternConfig['randomConfig'])
            : undefined,
        redactionLabel:
          pattern.redaction?.type === 'predefined'
            ? typeof pattern.redaction.label === 'string' && pattern.redaction.label.trim()
              ? pattern.redaction.label
              : '[REDACTED]'
            : undefined,
      });
    }

    return configs;
  } catch (err) {
    log.warn('pipeline-pii-pattern-load-failed', {
      tenantId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function resolvePipelinePIISnapshot(params: {
  tenantId: string;
  projectId?: string;
  environment?: Environment;
}): Promise<PipelinePIISnapshot> {
  const cacheKey = `${params.tenantId}:${params.projectId ?? ''}:${params.environment ?? 'dev'}`;
  const cached = getCachedSnapshot(cacheKey);
  if (cached) {
    return cached;
  }

  let projectPii: ProjectPIIRedactionConfig | undefined;
  if (params.projectId && isMongoReady()) {
    try {
      const { ProjectRuntimeConfig } = await import('@agent-platform/database/models');
      const doc = await ProjectRuntimeConfig.findOne(
        { tenantId: params.tenantId, projectId: params.projectId },
        { pii_redaction: 1 },
      ).lean();
      projectPii = doc?.pii_redaction as ProjectPIIRedactionConfig | undefined;
    } catch (err) {
      log.warn('pipeline-pii-config-load-failed', {
        tenantId: params.tenantId,
        projectId: params.projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const piiRedactionConfig = mapProjectPIIRedactionConfig(projectPii, params.environment);
  if (!piiRedactionConfig.enabled) {
    const disabledSnapshot = { piiRedactionConfig, piiPatternConfigs: [] };
    setCachedSnapshot(cacheKey, disabledSnapshot);
    return cloneSnapshot(disabledSnapshot);
  }

  const recognizerRegistry = createRecognizerRegistry();
  const piiPatternConfigs = params.projectId
    ? await loadProjectPIIPatternConfigs(params.tenantId, params.projectId, recognizerRegistry)
    : [];
  const snapshot = { piiRedactionConfig, piiPatternConfigs, recognizerRegistry };
  setCachedSnapshot(cacheKey, snapshot);
  return cloneSnapshot(snapshot);
}

export async function buildPipelinePIIContext(params: {
  tenantId: string;
  projectId?: string;
  environment?: Environment;
}): Promise<PIIBoundaryContext> {
  const snapshot = await resolvePipelinePIISnapshot(params);
  return {
    piiRedactionConfig: snapshot.piiRedactionConfig,
    piiPatternConfigs: snapshot.piiPatternConfigs,
    piiVault: snapshot.recognizerRegistry
      ? new PIIVault({ recognizerRegistry: snapshot.recognizerRegistry })
      : undefined,
  };
}

export async function renderPipelineReadValue<T>(
  value: T,
  params: { tenantId: string; projectId?: string; role?: string },
): Promise<T> {
  const context = await buildPipelinePIIContext(params);
  return renderValueForPIIBoundary(value, context, {
    consumer: 'pipeline_read',
    role: params.role,
  });
}

export async function renderPipelineLLMValue<T>(
  value: T,
  params: { tenantId: string; projectId?: string; role?: string },
): Promise<T> {
  const context = await buildPipelinePIIContext(params);
  return renderValueForPIIBoundary(value, context, {
    consumer: 'pipeline_llm',
    role: params.role,
  });
}

export async function renderPipelineActionValue<T>(
  value: T,
  params: { tenantId: string; projectId?: string; role?: string },
): Promise<T> {
  const context = await buildPipelinePIIContext(params);
  return renderValueForPIIBoundary(value, context, {
    consumer: 'pipeline_action',
    role: params.role,
  });
}

export function resetPipelinePIIContextCacheForTest(): void {
  pipelinePIIContextCache.clear();
}
