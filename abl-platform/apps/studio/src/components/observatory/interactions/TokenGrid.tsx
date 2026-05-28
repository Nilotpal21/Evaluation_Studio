/**
 * TokenGrid — Per-LLM-call token breakdown with Request/Response tabs.
 *
 * Displays: token summary, request JSON, response JSON.
 */

import { useState } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import { Copy, Check } from 'lucide-react';
import clsx from 'clsx';
import { ContextWindowBar } from './ContextWindowBar';
import { FlowStepContextLine } from './FlowStepContextLine';
import type { InteractionStep } from './types';

interface TokenGridProps {
  step: InteractionStep;
}

type TabId = 'summary' | 'request' | 'response';

export function TokenGrid({ step }: TokenGridProps) {
  const [activeTab, setActiveTab] = useState<TabId>('summary');
  const styles = getIntentStyles('purple');

  const tokensIn = Number(step.data.tokensIn ?? 0);
  const tokensOut = Number(step.data.tokensOut ?? 0);
  const totalTokens = tokensIn + tokensOut;
  const cost = Number(step.data.cost ?? 0);
  const model = String(step.data.model ?? 'unknown');
  const contextWindowSize = Number(step.data.contextWindowSize ?? 0);

  // Extract request and response data
  const requestData = extractRequestData(step);
  const responseData = extractResponseData(step);

  return (
    <div
      className={clsx(
        'rounded-md border px-3 py-2 text-xs space-y-2',
        styles.border,
        styles.bgSubtle,
      )}
    >
      {/* Model name row */}
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">{model}</span>
        {step.durationMs != null && step.durationMs > 0 && (
          <span className="text-foreground-subtle font-mono">
            {step.durationMs < 1000
              ? `${Math.round(step.durationMs)}ms`
              : `${(step.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>
      <FlowStepContextLine step={step} />

      {/* Tab buttons */}
      <div className="flex gap-1 border-b border-border-muted pb-1">
        <TabButton
          label="Summary"
          active={activeTab === 'summary'}
          onClick={() => setActiveTab('summary')}
        />
        <TabButton
          label="Request"
          active={activeTab === 'request'}
          onClick={() => setActiveTab('request')}
        />
        <TabButton
          label="Response"
          active={activeTab === 'response'}
          onClick={() => setActiveTab('response')}
        />
      </div>

      {/* Tab content */}
      {activeTab === 'summary' && (
        <SummaryTab
          tokensIn={tokensIn}
          tokensOut={tokensOut}
          totalTokens={totalTokens}
          cost={cost}
          contextWindowSize={contextWindowSize}
        />
      )}

      {activeTab === 'request' && (
        <JsonTab data={requestData} label="request" emptyMessage="No request data available" />
      )}

      {activeTab === 'response' && (
        <JsonTab data={responseData} label="response" emptyMessage="No response data available" />
      )}
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'px-2 py-1 text-[10px] font-medium rounded transition-colors',
        active
          ? 'bg-background-elevated text-foreground'
          : 'text-foreground-muted hover:text-foreground hover:bg-background-elevated/50',
      )}
    >
      {label}
    </button>
  );
}

// =============================================================================
// SUMMARY TAB
// =============================================================================

function SummaryTab({
  tokensIn,
  tokensOut,
  totalTokens,
  cost,
  contextWindowSize,
}: {
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  cost: number;
  contextWindowSize: number;
}) {
  return (
    <div className="space-y-2">
      {/* Token grid */}
      <div className="grid grid-cols-3 gap-2">
        <TokenCell label="Input" value={tokensIn} />
        <TokenCell label="Output" value={tokensOut} />
        <TokenCell label="Total" value={totalTokens} highlight />
      </div>

      {/* Cost */}
      {cost > 0 && (
        <div className="text-foreground-subtle">
          Cost: <span className="font-medium text-foreground">${cost.toFixed(4)}</span>
        </div>
      )}

      {/* Context window bar */}
      {contextWindowSize > 0 && (
        <ContextWindowBar tokensUsed={totalTokens} contextLimit={contextWindowSize} />
      )}
    </div>
  );
}

function TokenCell({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className="bg-background-elevated rounded px-2 py-1.5">
      <div className="text-[9px] text-foreground-subtle">{label}</div>
      <div
        className={clsx(
          'font-mono font-medium',
          highlight ? 'text-foreground' : 'text-foreground-muted',
        )}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

// =============================================================================
// JSON TAB (shared by Request and Response)
// =============================================================================

function JsonTab({
  data,
  label,
  emptyMessage,
}: {
  data: Record<string, unknown> | null;
  label: string;
  emptyMessage: string;
}) {
  const [copied, setCopied] = useState(false);

  if (!data || Object.keys(data).length === 0) {
    return <div className="text-foreground-subtle text-center py-4">{emptyMessage}</div>;
  }

  const jsonString = JSON.stringify(data, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write can fail silently in non-secure contexts — no action needed
    }
  };

  return (
    <div className="relative">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded bg-background hover:bg-background-muted text-foreground-muted hover:text-foreground transition-colors z-10"
        aria-label={`Copy ${label} JSON`}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
      <div
        role="region"
        aria-label={`LLM ${label} data`}
        className="bg-background-elevated rounded p-2 text-[10px] font-mono text-foreground-muted whitespace-pre-wrap break-words max-h-80 overflow-y-auto"
      >
        {jsonString}
      </div>
    </div>
  );
}

// =============================================================================
// DATA EXTRACTION
// =============================================================================

/**
 * Extract request data sent to LLM from step events.
 * Looks for: messages, systemPrompt, tools, model.
 */
function extractRequestData(step: InteractionStep): Record<string, unknown> | null {
  // Look for the first event that has request-like data
  for (const event of step.events) {
    const d = event.data;

    // Build request object from available fields
    const request: Record<string, unknown> = {};

    // Core request fields from runtime trace
    if (d.messages) request.messages = d.messages;
    if (d.systemPrompt) request.systemPrompt = d.systemPrompt;
    if (d.tools) request.tools = d.tools;
    if (d.model) request.model = d.model;

    // Additional fields if present
    if (d.temperature !== undefined) request.temperature = d.temperature;
    if (d.maxTokens !== undefined) request.maxTokens = d.maxTokens;
    if (d.toolChoice) request.toolChoice = d.toolChoice;

    // Legacy field names (fallback)
    if (!request.systemPrompt && d.prompt) request.prompt = d.prompt;
    if (!request.systemPrompt && d.systemMessage) request.systemMessage = d.systemMessage;

    if (Object.keys(request).length > 0) {
      return request;
    }
  }

  return null;
}

/**
 * Extract response data received from LLM from step events.
 * Looks for: response (text), toolCalls, stopReason, usage.
 */
function extractResponseData(step: InteractionStep): Record<string, unknown> | null {
  // Look for completion/response events
  for (const event of step.events) {
    const d = event.data;

    const responseData: Record<string, unknown> = {};

    // Core response fields from runtime trace
    if (d.response) responseData.response = d.response;
    if (d.toolCalls) responseData.toolCalls = d.toolCalls;
    if (d.stopReason) responseData.stopReason = d.stopReason;
    if (d.usage) responseData.usage = d.usage;

    // Additional response fields
    if (d.hasToolCalls !== undefined) responseData.hasToolCalls = d.hasToolCalls;
    if (d.toolCallCount !== undefined) responseData.toolCallCount = d.toolCallCount;
    if (d.streaming !== undefined) responseData.streaming = d.streaming;

    // Legacy field names (fallback)
    if (!responseData.response && d.completion) responseData.completion = d.completion;
    if (!responseData.response && d.text) responseData.text = d.text;
    if (!responseData.response && d.content) responseData.content = d.content;
    if (d.choices) responseData.choices = d.choices;
    if (d.message) responseData.message = d.message;
    if (d.finishReason) responseData.finishReason = d.finishReason;

    if (Object.keys(responseData).length > 0) {
      return responseData;
    }
  }

  return null;
}
