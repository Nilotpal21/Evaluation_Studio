'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { apiFetch } from '@/lib/api-client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

const REDACTED_PII_MARKER_REGEX = /\[REDACTED(?:_[A-Z0-9_]+)?\]|\{\{PII:[^:}]+:[a-f0-9-]+\}\}/i;
const REVEAL_REASON_MAX_LENGTH = 1000;
const REVEAL_TICKET_MAX_LENGTH = 200;

export interface RevealedPIIToken {
  tokenId: string;
  token: string;
  piiType: string;
  patternName: string;
  value: string;
  source?: {
    surface?: string;
    messageId?: string;
    traceId?: string;
    spanId?: string;
    fieldPath?: string;
  };
}

export interface UnavailablePIIToken {
  tokenId: string;
  status: 'not_found' | 'not_revealable' | 'erased' | 'expired' | string;
  piiType?: string;
  patternName?: string;
}

interface PIIRevealResponse {
  success?: boolean;
  revealed?: RevealedPIIToken[];
  unavailable?: UnavailablePIIToken[];
  error?: { message?: string };
  errors?: Array<{ msg?: string; message?: string }>;
}

interface PIIRevealPermissionResponse {
  success?: boolean;
  canRevealPII?: boolean;
}

interface PIIRevealControlsProps {
  projectId?: string;
  sessionId?: string;
  messageId: string;
  messageContent: string;
  canRevealPII: boolean;
}

function extractRevealError(response: PIIRevealResponse): string | null {
  return (
    response.error?.message ?? response.errors?.[0]?.msg ?? response.errors?.[0]?.message ?? null
  );
}

async function readOptionalJson<T>(response: Response): Promise<T | Record<string, never>> {
  try {
    return (await response.json()) as T;
  } catch {
    return {};
  }
}

export function hasPIIRedactionMarker(content: string): boolean {
  return REDACTED_PII_MARKER_REGEX.test(content);
}

export function usePIIRevealPermission(projectId?: string): boolean {
  const [canRevealPII, setCanRevealPII] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setCanRevealPII(false);
      return;
    }

    let cancelled = false;
    setCanRevealPII(false);

    void (async () => {
      try {
        const response = await apiFetch(
          `/api/projects/${encodeURIComponent(projectId)}/permissions/pii-reveal`,
          { cache: 'no-store' },
        );
        const data = (await readOptionalJson<PIIRevealPermissionResponse>(
          response,
        )) as PIIRevealPermissionResponse;
        if (!cancelled) {
          setCanRevealPII(response.ok && data.success === true && data.canRevealPII === true);
        }
      } catch {
        if (!cancelled) {
          setCanRevealPII(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return canRevealPII;
}

export function PIIRevealControls({
  projectId,
  sessionId,
  messageId,
  messageContent,
  canRevealPII,
}: PIIRevealControlsProps) {
  const t = useTranslations('observatory.debug_tabs');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [revealed, setRevealed] = useState<RevealedPIIToken[]>([]);
  const [unavailable, setUnavailable] = useState<UnavailablePIIToken[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const canShowReveal = useMemo(
    () => Boolean(canRevealPII && projectId && sessionId && hasPIIRedactionMarker(messageContent)),
    [canRevealPII, messageContent, projectId, sessionId],
  );

  useEffect(() => {
    setOpen(false);
    setReason('');
    setTicketId('');
    setRevealed([]);
    setUnavailable([]);
    setError(null);
    setLoading(false);
    setAttempted(false);
  }, [messageId, sessionId]);

  if (!canShowReveal) {
    return null;
  }

  const clearRevealState = () => {
    setReason('');
    setTicketId('');
    setRevealed([]);
    setUnavailable([]);
    setError(null);
    setLoading(false);
    setAttempted(false);
  };

  const closeModal = () => {
    setOpen(false);
    clearRevealState();
  };

  const submitReveal = async () => {
    if (!projectId || !sessionId || !reason.trim()) {
      return;
    }

    setLoading(true);
    setError(null);
    setAttempted(false);
    setRevealed([]);
    setUnavailable([]);

    try {
      const response = await apiFetch(
        `/api/runtime/sessions/${encodeURIComponent(sessionId)}/pii/reveal?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason: reason.trim(),
            ...(ticketId.trim() ? { ticketId: ticketId.trim() } : {}),
            sourceRefs: [{ sourceMessageId: messageId }],
          }),
        },
      );
      const data = (await readOptionalJson<PIIRevealResponse>(response)) as PIIRevealResponse;
      if (!response.ok || data.success === false) {
        throw new Error(extractRevealError(data) ?? t('pii_reveal.error'));
      }

      setRevealed(data.revealed ?? []);
      setUnavailable(data.unavailable ?? []);
      setAttempted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pii_reveal.error'));
      setAttempted(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon={<Eye className="h-3.5 w-3.5" />}
        onClick={() => setOpen(true)}
        title={t('pii_reveal.open')}
        aria-label={t('pii_reveal.open')}
        data-testid={`pii-reveal-open-${messageId}`}
        className="shrink-0"
      />

      <Dialog
        open={open}
        onClose={closeModal}
        title={t('pii_reveal.title')}
        description={t('pii_reveal.description')}
        maxWidth="lg"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('pii_reveal.audit_warning')}</span>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground">{t('pii_reveal.reason')}</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={REVEAL_REASON_MAX_LENGTH}
              rows={3}
              className="w-full resize-none rounded border border-default bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground">{t('pii_reveal.ticket')}</span>
            <input
              value={ticketId}
              onChange={(event) => setTicketId(event.target.value)}
              maxLength={REVEAL_TICKET_MAX_LENGTH}
              className="w-full rounded border border-default bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
            />
          </label>

          {error && (
            <div className="rounded border border-error/30 bg-error/10 p-3 text-xs text-error">
              {error}
            </div>
          )}

          {revealed.length > 0 && (
            <div className="space-y-2" data-testid="pii-reveal-values">
              <div className="text-xs font-medium text-foreground">
                {t('pii_reveal.revealed_values')}
              </div>
              <div className="space-y-2">
                {revealed.map((item) => (
                  <div
                    key={item.tokenId}
                    className="rounded border border-default bg-background-subtle p-3"
                  >
                    <div className="mb-1 text-[11px] uppercase text-muted">{item.piiType}</div>
                    <code className="break-words text-sm text-foreground">{item.value}</code>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unavailable.length > 0 && (
            <div className="rounded border border-default bg-background-subtle p-3 text-xs text-muted">
              {t('pii_reveal.unavailable_count', { count: unavailable.length })}
            </div>
          )}

          {attempted && !loading && !error && revealed.length === 0 && (
            <div className="rounded border border-default bg-background-subtle p-3 text-xs text-muted">
              {t('pii_reveal.not_available')}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={closeModal}>
              {t('pii_reveal.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              loading={loading}
              disabled={!reason.trim()}
              onClick={submitReveal}
            >
              {t('pii_reveal.submit')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
