'use client';

/**
 * LLMCallsTab Component
 *
 * Main tab for viewing all LLM calls with compact inline metrics.
 * Designed for ~400px narrow panel.
 */

import { useState, useCallback } from 'react';
import { Bot, Copy, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { LLMCallCard } from './LLMCallCard';
import { useLLMCalls } from '../../hooks/useLLMCalls';
import { formatCost, serializeLLMCallForCopy } from '../../utils/llm-cost';

export function LLMCallsTab() {
  const t = useTranslations('observatory.llm_tab');
  const { calls, metrics } = useLLMCalls();
  const [copied, setCopied] = useState(false);

  const handleCopyAll = useCallback(async () => {
    const data = calls.map(serializeLLMCallForCopy);
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [calls]);

  if (calls.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-subtle gap-3">
        <Bot className="w-12 h-12 text-subtle" />
        <div className="text-sm">{t('empty_title')}</div>
        <div className="text-xs text-subtle">{t('empty_hint')}</div>
      </div>
    );
  }

  const totalTokens = metrics.totalInputTokens + metrics.totalOutputTokens;

  return (
    <div className="h-full flex flex-col">
      {/* Compact metrics strip */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-default bg-background-muted">
        <div className="flex items-center justify-between">
          {/* Inline metrics */}
          <div className="flex items-center gap-1 text-xs text-muted flex-wrap">
            <span className="font-semibold text-purple">{metrics.totalCalls}</span>
            <span>{metrics.totalCalls === 1 ? 'call' : 'calls'}</span>
            <span className="text-border">·</span>
            <span className="font-semibold text-info">{totalTokens.toLocaleString()}</span>
            <span>tokens</span>
            <span className="text-border">·</span>
            <span className="font-semibold text-warning">{Math.round(metrics.avgLatencyMs)}ms</span>
            <span className="text-border">·</span>
            <span className="font-semibold text-success">{formatCost(metrics.totalCost)}</span>
          </div>

          {/* Copy all button */}
          <button
            onClick={handleCopyAll}
            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-default hover:bg-background-elevated transition-colors text-muted hover:text-foreground flex-shrink-0"
          >
            {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
            {copied ? t('copied') : t('copy_all', { count: calls.length })}
          </button>
        </div>

        {/* Token breakdown - second line */}
        <div className="text-xs text-subtle mt-0.5">
          {metrics.totalInputTokens.toLocaleString()} in /{' '}
          {metrics.totalOutputTokens.toLocaleString()} out
        </div>
      </div>

      {/* LLM calls list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {calls.map((call) => (
          <LLMCallCard key={call.id} call={call} />
        ))}

        {/* Show message if there are more than 100 calls */}
        {metrics.totalCalls > 100 && (
          <div className="text-xs text-subtle text-center py-2">
            {t('showing_recent', { total: metrics.totalCalls })}
          </div>
        )}
      </div>
    </div>
  );
}
