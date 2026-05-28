/**
 * ActivityTabPanel (FR-31)
 *
 * Paginated list (cursor + 50/page) of audit events from GET /audit-events.
 * Renders event-type-specific summaries; expandable detail panel per event.
 * Filter dropdown for eventType.
 */

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Trash2,
  Pencil,
  Key,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { getAuditEvents } from '../../api/auth-profiles';
import type {
  AuthProfileAuditEvent,
  AuthProfileAuditEventType,
  AuditEventsParams,
} from '../../api/auth-profiles';

// =============================================================================
// CONSTANTS
// =============================================================================

const PAGE_SIZE = 50;

const EVENT_TYPE_OPTIONS: AuthProfileAuditEventType[] = [
  'authorized',
  'authorize_failed',
  'token_refreshed',
  'token_refresh_failed',
  'profile_revoked',
  'tokens_revoked',
  'profile_updated',
  'sensitive_field_changed',
  'profile_deleted',
  'scope_insufficient_detected',
];

const EVENT_ICONS: Record<string, React.ElementType> = {
  authorized: ShieldCheck,
  authorize_failed: ShieldAlert,
  token_refreshed: RefreshCw,
  token_refresh_failed: AlertTriangle,
  profile_revoked: Trash2,
  tokens_revoked: Key,
  profile_updated: Pencil,
  sensitive_field_changed: AlertTriangle,
  profile_deleted: Trash2,
  scope_insufficient_detected: ShieldAlert,
};

// =============================================================================
// PROPS
// =============================================================================

interface ActivityTabPanelProps {
  projectId: string;
  profileId: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ActivityTabPanel({ projectId, profileId }: ActivityTabPanelProps) {
  const t = useTranslations('auth_profiles.activity');
  const [events, setEvents] = useState<AuthProfileAuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<AuthProfileAuditEventType | ''>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const initialLoadDone = useRef(false);

  const loadEvents = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params: AuditEventsParams = { limit: PAGE_SIZE };
        if (filterType) params.eventType = filterType;
        if (cursor) params.cursor = cursor;
        const res = await getAuditEvents(projectId, profileId, params);
        if (cursor) {
          setEvents((prev) => [...prev, ...res.data.events]);
        } else {
          setEvents(res.data.events);
        }
        setNextCursor(res.data.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [projectId, profileId, filterType],
  );

  // Initial load + reload on filter change
  useEffect(() => {
    initialLoadDone.current = true;
    loadEvents();
  }, [loadEvents]);

  const handleLoadMore = useCallback(() => {
    if (nextCursor) {
      loadEvents(nextCursor);
    }
  }, [nextCursor, loadEvents]);

  const handleFilterChange = useCallback((value: string) => {
    setFilterType(value as AuthProfileAuditEventType | '');
    setEvents([]);
    setNextCursor(null);
  }, []);

  const toggleExpanded = useCallback((eventId: string) => {
    setExpandedId((prev) => (prev === eventId ? null : eventId));
  }, []);

  const getEventLabel = useCallback(
    (eventType: AuthProfileAuditEventType): string => {
      const key = `event_${eventType}` as const;
      return t(key);
    },
    [t],
  );

  const formatTime = useCallback((dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, []);

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="flex items-center gap-2">
        <select
          value={filterType}
          onChange={(e) => handleFilterChange(e.target.value)}
          aria-label={t('filter_label')}
          className={clsx(
            'rounded-lg border border-default bg-background-subtle px-3 py-1.5 text-sm text-foreground',
            'focus:outline-none focus:ring-1 focus:ring-border-focus',
          )}
        >
          <option value="">{t('filter_all')}</option>
          {EVENT_TYPE_OPTIONS.map((type) => (
            <option key={type} value={type}>
              {getEventLabel(type)}
            </option>
          ))}
        </select>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-error-subtle p-3 text-sm text-error">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t('load_failed')}
        </div>
      )}

      {/* Loading initial */}
      {loading && events.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted" />
          <span className="ml-2 text-sm text-muted">{t('loading')}</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && events.length === 0 && !error && (
        <div className="py-8 text-center">
          <p className="text-sm font-medium text-foreground">{t('empty_state')}</p>
          <p className="mt-1 text-xs text-muted">{t('empty_state_description')}</p>
        </div>
      )}

      {/* Event list */}
      {events.length > 0 && (
        <div className="space-y-1">
          {events.map((event) => {
            const Icon = EVENT_ICONS[event.eventType] ?? AlertTriangle;
            const isExpanded = expandedId === event._id;

            return (
              <div
                key={event._id}
                className="rounded-lg border border-default bg-background-subtle"
              >
                <button
                  type="button"
                  onClick={() => toggleExpanded(event._id)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-default hover:bg-background-muted"
                  aria-expanded={isExpanded}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-foreground">
                      {getEventLabel(event.eventType)}
                    </span>
                    {event.actorUserId && (
                      <span className="ml-1.5 text-muted">
                        {t('event_by', { actor: event.actorUserId })}
                      </span>
                    )}
                    {!event.actorUserId && event.actorContext?.source === 'system' && (
                      <span className="ml-1.5 text-muted">
                        {t('event_by', { actor: t('event_system') })}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted">{formatTime(event.createdAt)}</span>
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />
                  )}
                </button>

                {/* Expandable details */}
                {isExpanded && (
                  <div className="border-t border-default px-3 py-2.5">
                    <pre className="whitespace-pre-wrap break-all text-xs text-muted font-mono">
                      {JSON.stringify(event.eventPayload, null, 2)}
                    </pre>
                    {event.actorContext && (
                      <div className="mt-2 text-xs text-muted">
                        <span className="font-medium">Source: {event.actorContext.source}</span>
                        {event.actorContext.requestId && (
                          <span className="ml-2">Request: {event.actorContext.requestId}</span>
                        )}
                        {event.actorContext.sessionId && (
                          <span className="ml-2">Session: {event.actorContext.sessionId}</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Load more */}
      {nextCursor && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleLoadMore}
            loading={loading}
            disabled={loading}
          >
            {t('load_more')}
          </Button>
        </div>
      )}
    </div>
  );
}
