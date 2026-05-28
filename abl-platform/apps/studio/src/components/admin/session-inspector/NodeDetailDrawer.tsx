'use client';

import { X, Loader2 } from 'lucide-react';
import { useSessionInspectorStore } from '@/store/session-inspector-store';
import { formatDuration, formatCost, formatTimestamp } from '@/components/analytics/shared';
import { PayloadViewer } from './PayloadViewer';

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground flex-shrink-0">{label}</span>
      <span className={`text-xs text-foreground truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

export function NodeDetailDrawer() {
  const { drawerEventId, drawerPayload, drawerLoading, treeEvents, closeDrawer } =
    useSessionInspectorStore();

  if (!drawerEventId) return null;

  const event = treeEvents.filter((e) => e.eventId === drawerEventId)[0];
  if (!event) return null;

  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h4 className="text-sm font-medium text-foreground truncate">{event.summary}</h4>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={closeDrawer}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="border-b border-border p-3 space-y-2">
          <DetailRow label="Category" value={event.category} />
          <DetailRow label="Severity" value={event.severity} />
          <DetailRow label="Span Kind" value={event.spanKind || '—'} />
          <DetailRow label="Time" value={formatTimestamp(event.timestamp)} />
          {event.durationMs != null && event.durationMs > 0 && (
            <DetailRow label="Duration" value={formatDuration(event.durationMs)} />
          )}
          {event.tokens && (
            <>
              <DetailRow label="Tokens" value={`${event.tokens.total} total`} />
              <DetailRow label="Cost" value={formatCost(event.tokens.estimatedCost)} />
            </>
          )}
          {event.specialist && <DetailRow label="Specialist" value={event.specialist} />}
          {event.phase && <DetailRow label="Phase" value={event.phase} />}
          {event.turnId && <DetailRow label="Turn ID" value={event.turnId} mono />}
          {event.parentEventId && <DetailRow label="Parent" value={event.parentEventId} mono />}
          {event.retryOf && (
            <DetailRow label="Retry Of" value={`${event.retryOf} (#${event.retryIndex})`} mono />
          )}
        </div>

        <div className="border-b border-border p-3">
          <div className="text-xs font-medium text-muted-foreground mb-1">Detail</div>
          <pre className="text-xs font-mono text-foreground whitespace-pre-wrap bg-muted/30 rounded p-2 max-h-48 overflow-y-auto">
            {JSON.stringify(event.detail, null, 2)}
          </pre>
        </div>

        {drawerLoading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {drawerPayload && (
          <div className="h-64">
            <PayloadViewer
              content={drawerPayload.content}
              payloadType={drawerPayload.payloadType}
            />
          </div>
        )}
      </div>
    </div>
  );
}
