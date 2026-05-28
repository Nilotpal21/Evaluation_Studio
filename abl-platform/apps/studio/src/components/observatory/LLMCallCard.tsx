'use client';

/**
 * LLMCallCard Component
 *
 * Compact 2-line card for displaying LLM calls in a narrow (~400px) panel.
 * Line 1: purpose + model + timestamp + actions
 * Line 2: agent + metric pills
 */

import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, Zap, Copy, Check, ChevronsUpDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCost, getModelDisplayName, serializeLLMCallForCopy } from '../../utils/llm-cost';
import { JsonViewer } from '../ui/JsonViewer';
import type { LLMCall } from '../../hooks/useLLMCalls';
import { formatAbsoluteTime } from './format-time';

interface LLMCallCardProps {
  call: LLMCall;
}

export function LLMCallCard({ call }: LLMCallCardProps) {
  const t = useTranslations('observatory.llm_card');
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expandAllFields, setExpandAllFields] = useState(false);
  const [expandAllKey, setExpandAllKey] = useState(0);

  const modelDisplayName = getModelDisplayName(call.model);
  const hasToolCalls = call.toolCalls && call.toolCalls.length > 0;

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const data = serializeLLMCallForCopy(call);
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    },
    [call],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-purple-subtle border border-purple/40 rounded-lg overflow-hidden"
    >
      {/* Collapsed view - 2-line compact layout */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-2.5 py-2 text-left hover:bg-background-elevated/50 transition-colors"
      >
        {/* Line 1: chevron + purpose + model + spacer + timestamp + copy */}
        <div className="flex items-center gap-1.5">
          <div className="flex-shrink-0 text-muted">
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </div>

          {call.purpose && (
            <span className="flex-shrink-0 px-1.5 py-px text-xs font-medium bg-accent-subtle text-accent rounded">
              {call.purpose}
            </span>
          )}

          <span className="text-xs font-semibold text-purple truncate">{modelDisplayName}</span>

          <div className="flex-1" />

          <span className="text-xs text-subtle flex-shrink-0 tabular-nums">
            {formatAbsoluteTime(call.timestamp)}
          </span>

          <button
            onClick={handleCopy}
            className="flex-shrink-0 p-0.5 rounded hover:bg-background-muted transition-colors"
            title={t('copy_llm_call')}
          >
            {copied ? (
              <Check className="w-3 h-3 text-success" />
            ) : (
              <Copy className="w-3 h-3 text-subtle hover:text-foreground" />
            )}
          </button>
        </div>

        {/* Line 2: agent + metrics pills */}
        <div className="flex items-center gap-1.5 mt-1 ml-5">
          <span className="text-xs text-muted truncate max-w-[120px]" title={call.agentName}>
            {call.agentName}
          </span>

          {/* Metric pills */}
          {(call.inputTokens > 0 || call.outputTokens > 0) && (
            <span className="px-1.5 py-px text-xs bg-info-subtle text-info rounded tabular-nums">
              {call.inputTokens}&rarr;{call.outputTokens}
            </span>
          )}

          {call.latencyMs > 0 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-px text-xs bg-warning-subtle text-warning rounded tabular-nums">
              <Zap className="w-2.5 h-2.5" />
              {call.latencyMs}ms
            </span>
          )}

          {call.cost > 0 && (
            <span className="px-1.5 py-px text-xs bg-success-subtle text-success rounded tabular-nums">
              {formatCost(call.cost)}
            </span>
          )}

          {hasToolCalls && (
            <span className="px-1.5 py-px text-xs bg-warning-subtle text-warning rounded">
              {t('tools_count', { count: call.toolCalls?.length ?? 0 })}
            </span>
          )}
        </div>
      </button>

      {/* Expanded view - Full details */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-purple/30"
          >
            <div className="px-2.5 py-2 space-y-2">
              {/* Metadata grid - 2 cols for narrow panel */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <MetaField
                  label={t('agent')}
                  value={call.agentName}
                  title={call.agentName}
                  truncate
                />
                <MetaField label={t('model')} value={call.model} title={call.model} mono truncate />
                {call.provider && <MetaField label={t('provider')} value={call.provider} />}
                <MetaField
                  label={t('tokens_in_out')}
                  value={`${call.inputTokens} / ${call.outputTokens}`}
                />
                <MetaField label={t('latency')} value={`${call.latencyMs}ms`} />
                <MetaField label={t('est_cost')} value={formatCost(call.cost)} />
              </div>

              {/* LLM Options */}
              {call.llmOptions && <LLMOptionsRow llmOptions={call.llmOptions} t={t} />}

              {/* Actions */}
              <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-muted hover:text-foreground bg-background-muted rounded transition-colors"
                >
                  {copied ? (
                    <Check className="w-3 h-3 text-success" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  {copied ? t('copied') : t('copy_llm_call')}
                </button>
                <button
                  onClick={() => {
                    setExpandAllFields((prev) => !prev);
                    setExpandAllKey((prev) => prev + 1);
                  }}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-muted hover:text-foreground bg-background-muted rounded transition-colors"
                >
                  <ChevronsUpDown className="w-3 h-3" />
                  {expandAllFields ? t('collapse_all') : t('expand_all')}
                </button>
              </div>

              {/* Raw Request Payload */}
              <PayloadSection
                label={t('raw_request_payload')}
                badge={call.rawRequest ? t('actual_api_request') : undefined}
                expandAllKey={expandAllKey}
                expandAll={expandAllFields}
                data={
                  call.rawRequest || {
                    model: call.model,
                    system: call.systemPrompt,
                    messages: call.messages,
                    ...(call.tools?.length && { tools: call.tools }),
                    ...(call.llmOptions && { options: call.llmOptions }),
                  }
                }
              />

              {/* Raw Response Payload */}
              <PayloadSection
                label={t('raw_response_payload')}
                badge={call.rawResponse ? t('actual_api_response') : undefined}
                expandAllKey={expandAllKey}
                expandAll={expandAllFields}
                data={
                  call.rawResponse || {
                    content: call.response,
                    ...(hasToolCalls && { tool_calls: call.toolCalls }),
                    usage: {
                      input_tokens: call.inputTokens,
                      output_tokens: call.outputTokens,
                    },
                    latency_ms: call.latencyMs,
                  }
                }
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** Compact metadata field for the expanded detail grid. */
function MetaField({
  label,
  value,
  title,
  mono,
  truncate,
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-subtle text-xs leading-tight">{label}</div>
      <div
        className={`text-foreground leading-tight ${truncate ? 'truncate' : ''} ${mono ? 'font-mono text-xs' : ''}`}
        title={title}
      >
        {value}
      </div>
    </div>
  );
}

/** Collapsible payload section with JSON viewer. */
function PayloadSection({
  label,
  badge,
  expandAllKey,
  expandAll,
  data,
}: {
  label: string;
  badge?: string;
  expandAllKey: number;
  expandAll: boolean;
  data: unknown;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-muted mb-1">
        {label}
        {badge && <span className="ml-1.5 text-success">{badge}</span>}
      </div>
      <div className="bg-background-subtle border border-default rounded p-2 overflow-auto max-h-80 font-mono text-xs">
        <JsonViewer
          key={`payload-${expandAllKey}`}
          data={data}
          maxDepth={Infinity}
          copyable
          expandAll={expandAll}
        />
      </div>
    </div>
  );
}

/** Displays LLM call options as compact badges. */
function LLMOptionsRow({
  llmOptions,
  t,
}: {
  llmOptions: NonNullable<LLMCall['llmOptions']>;
  t: (key: string) => string;
}) {
  const toolChoiceLabel = (() => {
    if (!llmOptions.toolChoice) return null;
    if (typeof llmOptions.toolChoice === 'string') return llmOptions.toolChoice;
    const tc = llmOptions.toolChoice as Record<string, unknown>;
    if (tc.name) return String(tc.name);
    if (tc.type) return String(tc.type);
    return JSON.stringify(tc);
  })();

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-subtle">{t('llm_options')}</span>
      {llmOptions.disableParallelToolUse && (
        <span className="px-1.5 py-px text-xs font-medium bg-warning-subtle text-warning rounded">
          {t('no_parallel_tools')}
        </span>
      )}
      {toolChoiceLabel && (
        <span className="px-1.5 py-px text-xs font-medium bg-info-subtle text-info rounded font-mono">
          {t('tool_choice')}: {toolChoiceLabel}
        </span>
      )}
    </div>
  );
}
