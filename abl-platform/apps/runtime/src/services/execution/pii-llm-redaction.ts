import type {
  PIIPatternConfig,
  PIIRenderMode,
  PIIVault,
} from '@abl/compiler/platform/security/index.js';
import type { TraceStoreInterface } from '../trace-store.js';
import { recordPIIDetectLatency } from '../../observability/pii-telemetry.js';

interface PIIRedactionConfig {
  enabled: boolean;
  redactInput: boolean;
  /** Detection tier label for telemetry dimensions. Optional — older sessions may pre-date the field. */
  tier?: string;
  /** Confidence floor forwarded into vault tokenization. */
  confidenceThreshold?: number;
}

export interface LLMPIIRedactionContext {
  /** Stable session identifier — required only when telemetry is wired. */
  id?: string;
  piiRedactionConfig?: PIIRedactionConfig;
  piiVault?: PIIVault;
  piiPatternConfigs?: PIIPatternConfig[];
  /**
   * Optional trace channel for `pii.detect.latency_ms` emission with
   * `entry_point: 'vault_tokenize'`. When undefined, redaction runs without
   * telemetry — preserves legacy callers that don't yet thread the trace store.
   */
  traceStore?: TraceStoreInterface;
}

const LLM_CONSUMER = 'llm';
const TOKENIZED_RENDER_MODE: PIIRenderMode = 'tokenized';
function normalizeLLMRenderMode(renderMode: PIIRenderMode): PIIRenderMode {
  return renderMode === TOKENIZED_RENDER_MODE ? renderMode : TOKENIZED_RENDER_MODE;
}

export function resolveLLMPatternConfigs(
  patternConfigs: PIIPatternConfig[] | undefined,
): PIIPatternConfig[] | undefined {
  if (!patternConfigs || patternConfigs.length === 0) {
    return patternConfigs;
  }

  return patternConfigs.map((config) => {
    const llmRule = config.consumerAccess.find((rule) => rule.consumer === LLM_CONSUMER);
    if (!llmRule) {
      return {
        ...config,
        consumerAccess: [
          ...config.consumerAccess,
          { consumer: LLM_CONSUMER, renderMode: TOKENIZED_RENDER_MODE },
        ],
      };
    }

    const normalizedMode = normalizeLLMRenderMode(llmRule.renderMode);
    if (normalizedMode === llmRule.renderMode) {
      return config;
    }

    return {
      ...config,
      consumerAccess: config.consumerAccess.map((rule) =>
        rule.consumer === LLM_CONSUMER ? { ...rule, renderMode: normalizedMode } : rule,
      ),
    };
  });
}

export function renderTextForLLMWithPIIRedaction(
  context: LLMPIIRedactionContext,
  text: string,
): string {
  if (!context.piiRedactionConfig?.enabled || !context.piiRedactionConfig.redactInput) {
    return text;
  }
  if (!context.piiVault) {
    return text;
  }

  const t0 = context.traceStore && context.id !== undefined ? performance.now() : undefined;
  const tokenized = context.piiVault.tokenize(text, undefined, {
    confidenceThreshold: context.piiRedactionConfig.confidenceThreshold,
  });
  if (t0 !== undefined && context.traceStore && context.id !== undefined) {
    recordPIIDetectLatency(context.traceStore, context.id, {
      entry_point: 'vault_tokenize',
      tier: context.piiRedactionConfig.tier ?? 'basic',
      ms: performance.now() - t0,
    });
  }
  if (tokenized.tokens.length === 0) {
    return text;
  }

  return context.piiVault.renderForConsumer(
    tokenized.text,
    LLM_CONSUMER,
    resolveLLMPatternConfigs(context.piiPatternConfigs),
  );
}
