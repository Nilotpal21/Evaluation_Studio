'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { JsonViewer } from '../../../ui/JsonViewer';

// =============================================================================
// Types
// =============================================================================

interface HttpRequest {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

interface HttpResponse {
  statusCode?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface HttpStepDetailProps {
  request?: HttpRequest;
  response?: HttpResponse;
  error?: {
    code: string;
    message: string;
    httpStatus?: number;
    responseBody?: unknown;
  };
  metrics?: {
    responseTimeMs?: number;
    processingTimeMs?: number;
  };
  /** Whether the step is currently executing */
  isRunning?: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-success/10 text-success',
  POST: 'bg-accent/10 text-accent',
  PUT: 'bg-warning/10 text-warning',
  PATCH: 'bg-warning/10 text-warning',
  DELETE: 'bg-error/10 text-error',
};

function StatusBadge({ statusCode }: { statusCode: number }) {
  const color =
    statusCode < 300
      ? 'bg-success/10 text-success'
      : statusCode < 400
        ? 'bg-warning/10 text-warning'
        : 'bg-error/10 text-error';
  return (
    <span className={clsx('text-xs font-mono font-medium px-1.5 py-0.5 rounded', color)}>
      {statusCode}
    </span>
  );
}

// =============================================================================
// Component
// =============================================================================

export function HttpStepDetail({
  request,
  response,
  error,
  metrics,
  isRunning,
}: HttpStepDetailProps) {
  // Default to request tab when response is not yet available (still running)
  const hasResponse = response != null || error != null;
  const [activeTab, setActiveTab] = useState<'request' | 'response'>(
    hasResponse ? 'response' : 'request',
  );

  const statusCode = response?.statusCode ?? error?.httpStatus;
  const respBody = response?.body ?? error?.responseBody;

  return (
    <div className="space-y-2">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-default">
        <button
          type="button"
          className={clsx(
            'text-xs px-2 py-1 -mb-px transition-colors',
            activeTab === 'request'
              ? 'border-b-2 border-accent text-accent font-medium'
              : 'text-muted hover:text-foreground',
          )}
          onClick={() => setActiveTab('request')}
        >
          Request
        </button>
        <button
          type="button"
          className={clsx(
            'text-xs px-2 py-1 -mb-px transition-colors',
            activeTab === 'response'
              ? 'border-b-2 border-accent text-accent font-medium'
              : 'text-muted hover:text-foreground',
          )}
          onClick={() => setActiveTab('response')}
        >
          Response
        </button>
      </div>

      {activeTab === 'request' && !request && isRunning && (
        <div className="flex items-center gap-2 py-3 px-3 rounded-md border border-default bg-background">
          <Loader2 className="w-3 h-3 text-accent animate-spin shrink-0" />
          <span className="text-xs text-muted">Resolving request parameters...</span>
        </div>
      )}

      {activeTab === 'request' && request && (
        <div className="space-y-2">
          {/* Method + URL */}
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                'text-xs font-mono font-bold px-1.5 py-0.5 rounded',
                METHOD_COLORS[request.method ?? 'GET'] ?? 'bg-muted/10 text-muted',
              )}
            >
              {request.method ?? 'GET'}
            </span>
            <span className="text-xs font-mono text-foreground-muted truncate">{request.url}</span>
          </div>
          {/* Headers */}
          {request.headers && Object.keys(request.headers).length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">
                Headers
              </p>
              <div className="rounded-md border border-default bg-background p-2 max-h-[120px] overflow-y-auto">
                <JsonViewer data={request.headers} copyable />
              </div>
            </div>
          )}
          {/* Body */}
          {request.body != null && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">
                Body
              </p>
              <div className="rounded-md border border-default bg-background p-2 max-h-[150px] overflow-y-auto">
                <JsonViewer data={request.body} copyable />
              </div>
            </div>
          )}
          {/* Timeout */}
          {request.timeout != null && (
            <div className="text-xs">
              <span className="text-muted">Timeout: </span>
              <span className="font-mono text-foreground-muted">{request.timeout}ms</span>
            </div>
          )}
        </div>
      )}

      {activeTab === 'response' && (
        <div className="space-y-2">
          {/* Loading state — step is running, no response yet */}
          {!hasResponse && isRunning && (
            <div className="flex items-center gap-2 py-3 px-3 rounded-md border border-default bg-background">
              <Loader2 className="w-3 h-3 text-accent animate-spin shrink-0" />
              <span className="text-xs text-muted">Waiting for response...</span>
            </div>
          )}
          {/* Status code */}
          {statusCode != null && <StatusBadge statusCode={statusCode} />}
          {/* Response body */}
          {respBody != null && (
            <div className="rounded-md border border-default bg-background p-2 max-h-[200px] overflow-y-auto">
              {typeof respBody === 'object' ? (
                <JsonViewer data={respBody} copyable />
              ) : (
                <pre className="text-xs text-foreground-muted whitespace-pre-wrap break-all">
                  {String(respBody)}
                </pre>
              )}
            </div>
          )}
          {/* Metrics */}
          {metrics && (
            <div className="flex gap-4 text-xs">
              {metrics.responseTimeMs !== undefined && (
                <div>
                  <span className="text-muted">API Response</span>
                  <p className="font-mono text-foreground-muted">{metrics.responseTimeMs}ms</p>
                </div>
              )}
              {metrics.processingTimeMs !== undefined && (
                <div>
                  <span className="text-muted">Processing</span>
                  <p className="font-mono text-foreground-muted">{metrics.processingTimeMs}ms</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
