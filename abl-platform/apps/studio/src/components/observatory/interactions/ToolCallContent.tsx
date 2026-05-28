/**
 * ToolCallContent — Tool call step display.
 *
 * Three rendering modes based on tool type and status:
 * 1. HTTP tools (success) → Tabbed layout: Input | Output | Raw Events
 * 2. HTTP tools (failed)  → Header + inline error, expandable details
 * 3. Non-HTTP tools       → Compact one-line with result preview
 */

import { useState } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import { ChevronDown, ChevronRight, Check, Terminal, Copy } from 'lucide-react';
import clsx from 'clsx';
import { FlowStepContextLine } from './FlowStepContextLine';
import { formatDuration, truncate } from './format-utils';
import type { InteractionStep as InteractionStepData, ToolCallStepItem } from './types';

type ToolTab = 'input' | 'output' | 'raw';

interface RenderableToolCall extends ToolCallStepItem {
  events: InteractionStepData['events'];
}

function formatValue(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

// H3: truncate() moved to format-utils.ts to consolidate duplicates

/** Build a complete cURL command that replays the tool call. */
function buildCurl(toolCall: RenderableToolCall): string {
  const toolName = toolCall.tool;
  const input = toolCall.input ?? {};
  const url = toolCall.url;
  const method = toolCall.method;

  if (url) {
    const httpMethod = method ? String(method).toUpperCase() : 'POST';

    // Build URL with query params if present
    let fullUrl = String(url);
    const queryParams = toolCall.queryParams;
    if (queryParams && Object.keys(queryParams).length > 0) {
      const qs = Object.entries(queryParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      const sep = fullUrl.includes('?') ? '&' : '?';
      fullUrl = `${fullUrl}${sep}${qs}`;
    }

    // H4: Escape single quotes in URL to prevent shell injection
    const escapedUrl = fullUrl.replace(/'/g, "'\\''");
    const lines = [`curl -X ${httpMethod} '${escapedUrl}'`];
    lines.push(`  -H 'Content-Type: application/json'`);

    // Auth header based on auth type
    const authType = toolCall.authType;
    if (authType && authType !== 'none') {
      const headerName = toolCall.authHeaderName ?? 'Authorization';
      const prefix = toolCall.authHeaderPrefix;
      switch (authType) {
        case 'bearer':
          lines.push(`  -H '${headerName}: ${prefix ?? 'Bearer'} <YOUR_TOKEN>'`);
          break;
        case 'api_key':
          lines.push(`  -H '${headerName}: <YOUR_API_KEY>'`);
          break;
        case 'oauth2_client':
        case 'oauth2_user':
          lines.push(`  -H '${headerName}: Bearer <OAUTH_TOKEN>'`);
          break;
        default:
          lines.push(`  -H '${headerName}: <AUTH_VALUE>'`);
          break;
      }
    }

    // Custom headers (names only — values redacted since they may contain secrets)
    const headerNames = toolCall.headerNames;
    if (headerNames) {
      for (const name of headerNames) {
        // Skip Content-Type (already added) and auth headers (handled above)
        const lower = name.toLowerCase();
        if (lower === 'content-type') continue;
        lines.push(`  -H '${name}: <VALUE>'`);
      }
    }

    // Request body for non-GET methods
    const hasBody = input && typeof input === 'object' && Object.keys(input as object).length > 0;
    if (hasBody && ['POST', 'PUT', 'PATCH'].includes(httpMethod)) {
      const body = JSON.stringify(input, null, 2);
      lines.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
    }

    return lines.join(' \\\n');
  }

  // Non-HTTP tool — generic tool invocation payload
  // M5: Removed hardcoded localhost:3112 fallback (won't work in production)
  // cURL generation only supported for HTTP tools with explicit endpoints
  const sessionId = toolCall.events[0]?.sessionId ?? '<SESSION_ID>';
  const body = JSON.stringify({ tool: toolName, input }, null, 2);
  return [
    `# cURL generation not available for non-HTTP tools`,
    `# Tool: ${toolName}`,
    `# Session: ${sessionId}`,
    `# Input:`,
    body,
  ].join('\n');
}

interface ToolCallContentProps {
  step: InteractionStepData;
  styles: ReturnType<typeof getIntentStyles>;
}

export function ToolCallContent({ step, styles }: ToolCallContentProps) {
  const toolCalls = getRenderableToolCalls(step);

  if (toolCalls.length === 0) {
    return null;
  }

  if (toolCalls.length === 1) {
    return <ToolCallCard toolCall={toolCalls[0]} step={step} styles={styles} />;
  }

  return (
    <div className="space-y-2">
      <div
        className={clsx(
          'rounded-md border px-3 py-1.5 text-[10px]',
          styles.border,
          styles.bgSubtle,
        )}
      >
        <span className="font-medium text-foreground">{toolCalls.length} tool calls</span>
      </div>
      {toolCalls.map((toolCall) => (
        <ToolCallCard key={toolCall.id} toolCall={toolCall} step={step} styles={styles} />
      ))}
    </div>
  );
}

function ToolCallCard({
  toolCall,
  step,
  styles,
}: {
  toolCall: RenderableToolCall;
  step: InteractionStepData;
  styles: ReturnType<typeof getIntentStyles>;
}) {
  const inputObj =
    typeof toolCall.input === 'object' && toolCall.input !== null
      ? (toolCall.input as Record<string, unknown>)
      : null;
  const url = toolCall.url ?? getStringValue(inputObj?.url ?? inputObj?.endpoint ?? inputObj?.uri);
  const method = toolCall.method ?? getStringValue(inputObj?.method ?? inputObj?.httpMethod);
  const isHttpTool = Boolean(url || method);
  const isFailed = toolCall.status === 'failed';

  if (isHttpTool) {
    return isFailed ? (
      <HttpToolFailed toolCall={toolCall} step={step} styles={styles} url={url} method={method} />
    ) : (
      <HttpToolSuccess toolCall={toolCall} step={step} styles={styles} url={url} method={method} />
    );
  }

  return <CompactTool toolCall={toolCall} step={step} styles={styles} />;
}

// ============================================================================
// HTTP Tool — Success (Tabbed)
// ============================================================================

function HttpToolSuccess({
  toolCall,
  step,
  styles,
  url,
  method,
}: {
  toolCall: RenderableToolCall;
  step: InteractionStepData;
  styles: ReturnType<typeof getIntentStyles>;
  url?: string;
  method?: string;
}) {
  const [activeTab, setActiveTab] = useState<ToolTab>('input');
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const toolName = toolCall.tool;
  const httpMethod = method ? String(method).toUpperCase() : null;
  const hasInput = toolCall.input != null;
  const hasResult = toolCall.result != null;

  // H2: Add error handling for clipboard API (can fail in non-secure contexts)
  const handleCopyCurl = async () => {
    try {
      await navigator.clipboard.writeText(buildCurl(toolCall));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Clipboard write failed (likely non-secure context or user denied permission)
      // Silently fail - user will not see "Copied" feedback
      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.warn('Failed to copy cURL to clipboard:', err);
      }
    }
  };

  return (
    <div
      className={clsx('rounded-md border text-xs overflow-hidden', styles.border, styles.bgSubtle)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="font-medium text-foreground">{toolName}</span>
        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-success/10 text-success">
          OK
        </span>
        {httpMethod && (
          <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-foreground/5 text-foreground font-mono">
            {httpMethod}
          </span>
        )}
        {toolCall.durationMs != null && toolCall.durationMs > 0 && (
          <span className="text-[9px] text-foreground-subtle font-mono">
            {formatDuration(toolCall.durationMs)}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={handleCopyCurl}
          className="flex items-center gap-1 text-foreground-muted hover:text-foreground transition-colors"
          title="Copy as cURL"
        >
          {copied ? <Check className="w-3 h-3 text-success" /> : <Terminal className="w-3 h-3" />}
          <span className="text-[9px]">{copied ? 'Copied' : 'cURL'}</span>
        </button>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-foreground-muted hover:text-foreground transition-colors"
        >
          <span className="text-[9px]">{expanded ? 'Hide' : 'Details'}</span>
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
      </div>
      <FlowStepContextLine step={step} className="px-3 pb-1" />

      {/* Endpoint URL */}
      {url && (
        <div className="px-3 pb-1.5 text-[10px] font-mono text-foreground-subtle truncate">
          {url}
        </div>
      )}

      {/* Tabs + content (when expanded) */}
      {expanded && (
        <div>
          {/* Tab bar */}
          <div className="flex border-t border-border-muted">
            {hasInput && (
              <TabButton
                label="Input"
                active={activeTab === 'input'}
                onClick={() => setActiveTab('input')}
              />
            )}
            {hasResult && (
              <TabButton
                label="Output"
                active={activeTab === 'output'}
                onClick={() => setActiveTab('output')}
              />
            )}
            <TabButton
              label={`Raw Events (${toolCall.events.length})`}
              active={activeTab === 'raw'}
              onClick={() => setActiveTab('raw')}
            />
          </div>

          {/* Tab content */}
          <div className="px-3 py-2">
            {activeTab === 'input' && hasInput && <CodeBlock value={toolCall.input} />}
            {activeTab === 'output' && hasResult && <CodeBlock value={toolCall.result} />}
            {activeTab === 'raw' && (
              <div className="space-y-1.5">
                {toolCall.events.map((evt) => (
                  <RawEventInline key={evt.id} type={evt.type} data={evt.data} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// HTTP Tool — Failed (Inline error)
// ============================================================================

function HttpToolFailed({
  toolCall,
  step,
  styles,
  url,
  method,
}: {
  toolCall: RenderableToolCall;
  step: InteractionStepData;
  styles: ReturnType<typeof getIntentStyles>;
  url?: string;
  method?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const toolName = toolCall.tool;
  const httpMethod = method ? String(method).toUpperCase() : null;
  const hasInput = toolCall.input != null;
  const hasResult = toolCall.result != null;

  // H2: Add error handling for clipboard API (can fail in non-secure contexts)
  const handleCopyCurl = async () => {
    try {
      await navigator.clipboard.writeText(buildCurl(toolCall));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Clipboard write failed (likely non-secure context or user denied permission)
      // Silently fail - user will not see "Copied" feedback
      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.warn('Failed to copy cURL to clipboard:', err);
      }
    }
  };

  return (
    <div
      className={clsx('rounded-md border text-xs overflow-hidden', styles.border, styles.bgSubtle)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="font-medium text-foreground">{toolName}</span>
        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-error/10 text-error">
          FAILED
        </span>
        {httpMethod && (
          <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-foreground/5 text-foreground font-mono">
            {httpMethod}
          </span>
        )}
        {toolCall.durationMs != null && toolCall.durationMs > 0 && (
          <span className="text-[9px] text-foreground-subtle font-mono">
            {formatDuration(toolCall.durationMs)}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={handleCopyCurl}
          className="flex items-center gap-1 text-foreground-muted hover:text-foreground transition-colors"
          title="Copy as cURL"
        >
          {copied ? <Check className="w-3 h-3 text-success" /> : <Terminal className="w-3 h-3" />}
          <span className="text-[9px]">{copied ? 'Copied' : 'cURL'}</span>
        </button>
        {(hasInput || hasResult) && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-foreground-muted hover:text-foreground transition-colors"
          >
            <span className="text-[9px]">{expanded ? 'Hide' : 'Details'}</span>
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        )}
      </div>
      <FlowStepContextLine step={step} className="px-3 pb-1" />

      {/* Endpoint URL */}
      {url && (
        <div className="px-3 pb-1 text-[10px] font-mono text-foreground-subtle truncate">{url}</div>
      )}

      {/* Inline error message */}
      {toolCall.error != null && (
        <div className="mx-3 mb-1.5 px-2 py-1 rounded bg-error/5 text-[10px] text-error border border-error/10">
          {String(toolCall.error)}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1.5 border-t border-border-muted pt-2">
          {hasInput && (
            <div>
              <div className="text-[9px] text-foreground-muted font-medium mb-0.5">Input</div>
              <CodeBlock value={toolCall.input} />
            </div>
          )}
          {hasResult && (
            <div>
              <div className="text-[9px] text-foreground-muted font-medium mb-0.5">Output</div>
              <CodeBlock value={toolCall.result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Non-HTTP Tool — Compact
// ============================================================================

function CompactTool({
  toolCall,
  step,
  styles,
}: {
  toolCall: RenderableToolCall;
  step: InteractionStepData;
  styles: ReturnType<typeof getIntentStyles>;
}) {
  const [expanded, setExpanded] = useState(false);

  const toolName = toolCall.tool;
  const isFailed = toolCall.status === 'failed';
  const hasInput = toolCall.input != null;
  const hasResult = toolCall.result != null;
  const hasError = toolCall.error != null;
  const hasDetails = hasInput || hasResult || hasError;

  const resultPreview = hasResult ? truncate(formatValue(toolCall.result), 120) : null;

  return (
    <div
      className={clsx('rounded-md border text-xs overflow-hidden', styles.border, styles.bgSubtle)}
    >
      {/* Single-line header */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="font-medium text-foreground">{toolName}</span>
        <span
          className={clsx(
            'text-[9px] font-medium px-1.5 py-0.5 rounded',
            isFailed ? 'bg-error/10 text-error' : 'bg-success/10 text-success',
          )}
        >
          {isFailed ? 'FAILED' : 'OK'}
        </span>
        {toolCall.durationMs != null && toolCall.durationMs > 0 && (
          <span className="text-[9px] text-foreground-subtle font-mono">
            {formatDuration(toolCall.durationMs)}
          </span>
        )}

        {/* One-line result preview (only for success, when collapsed) */}
        {!isFailed && resultPreview && !expanded && (
          <>
            <span className="text-foreground-muted mx-0.5">&rarr;</span>
            <span className="text-[10px] font-mono text-foreground-subtle truncate min-w-0 flex-1">
              {resultPreview}
            </span>
          </>
        )}

        {(isFailed || !resultPreview) && <div className="flex-1" />}

        {hasDetails && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-foreground-muted hover:text-foreground transition-colors shrink-0"
          >
            <span className="text-[9px]">{expanded ? 'Hide' : 'Details'}</span>
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        )}
      </div>
      <FlowStepContextLine step={step} className="px-3 pb-1" />

      {/* Inline error for failed compact tools (when collapsed) */}
      {isFailed && hasError && !expanded && (
        <div className="mx-3 mb-1.5 text-[10px] text-error">{String(toolCall.error)}</div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1.5 border-t border-border-muted pt-1.5">
          {hasError && (
            <div>
              <div className="text-[9px] text-error font-medium mb-0.5">Error</div>
              <div className="bg-error/5 rounded p-2 text-[10px] font-mono text-error whitespace-pre-wrap break-words max-h-32 overflow-y-auto border border-error/10">
                {formatValue(toolCall.error)}
              </div>
            </div>
          )}
          {hasInput && (
            <div>
              <div className="text-[9px] text-foreground-muted font-medium mb-0.5">Input</div>
              <CodeBlock value={toolCall.input} />
            </div>
          )}
          {hasResult && (
            <div>
              <div className="text-[9px] text-foreground-muted font-medium mb-0.5">Output</div>
              <CodeBlock value={toolCall.result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Shared sub-components
// ============================================================================

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
        'px-3 py-1.5 text-[10px] font-medium transition-colors border-b-2',
        active
          ? 'border-foreground text-foreground'
          : 'border-transparent text-foreground-muted hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}

function CodeBlock({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = formatValue(value);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group">
      <div className="bg-background-elevated rounded p-2 text-[10px] font-mono text-foreground-subtle whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
        {text}
      </div>
      <button
        onClick={handleCopy}
        className="absolute top-1 right-1 p-1 rounded bg-background-elevated/80 text-foreground-muted hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        title={copied ? 'Copied!' : 'Copy'}
      >
        {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

function RawEventInline({ type, data }: { type: string; data: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  const json = formatValue(data);

  const handleCopy = () => {
    navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[9px] text-foreground-muted font-medium mb-0.5">
        <span>{type}</span>
        <div className="flex-1" />
        <button
          onClick={handleCopy}
          className="text-foreground-muted hover:text-foreground transition-colors"
          title={copied ? 'Copied!' : 'Copy JSON'}
        >
          {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
      <div className="bg-background-elevated rounded p-2 text-[10px] font-mono text-foreground-subtle whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
        {json}
      </div>
    </div>
  );
}

function getRenderableToolCalls(step: InteractionStepData): RenderableToolCall[] {
  const storedToolCalls = Array.isArray(step.data.toolCalls)
    ? (step.data.toolCalls as ToolCallStepItem[])
    : [];

  if (storedToolCalls.length > 0) {
    return storedToolCalls.map((toolCall) => ({
      ...toolCall,
      events:
        toolCall.eventIds.length > 0
          ? step.events.filter((event) => toolCall.eventIds.includes(event.id))
          : step.events,
    }));
  }

  return [
    {
      id: step.id,
      tool: String(step.data.tool ?? 'unknown'),
      input: step.data.input,
      result: step.data.result,
      status: step.data.status === 'failed' ? 'failed' : 'success',
      error: step.data.error,
      durationMs:
        typeof step.data.latencyMs === 'number' ? (step.data.latencyMs as number) : step.durationMs,
      url: getStringValue(step.data.url),
      method: getStringValue(step.data.method),
      authType: getStringValue(step.data.authType),
      authHeaderName: getStringValue(step.data.authHeaderName),
      authHeaderPrefix: getStringValue(step.data.authHeaderPrefix),
      headerNames: getStringArray(step.data.headerNames),
      queryParams: getStringRecord(step.data.queryParams),
      eventIds: step.events.map((event) => event.id),
      events: step.events,
    },
  ];
}

function getStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return items.length > 0 ? items : undefined;
}

function getStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
