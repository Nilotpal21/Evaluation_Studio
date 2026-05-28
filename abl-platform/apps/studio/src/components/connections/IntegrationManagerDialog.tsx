/**
 * IntegrationManagerDialog
 *
 * Per-connector operational manager for catalog tiles whose configuration
 * doesn't fit the standard "create an auth profile" flow.
 *
 *   - docling                         (auth.type: 'none')
 *       → no credentials to set; the connection itself is the enable/disable
 *         binding. Renders `DoclingQuotaView` (rate-limit info) plus
 *         Enable/Disable buttons that drive the workflow-engine BFF.
 *
 * Azure DI was previously handled here with a usage + cost-cap admin panel,
 * but the panel was removed per product call: credentials live on the
 * auth profile, so the Azure DI catalog tile now uses the default
 * `routes-to-auth-profiles` CTA like other api_key connectors.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { DoclingQuotaView } from '../projects/DoclingQuotaView';

interface IntegrationManagerDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Currently only `docling`. Kept generic for future auth.type='none' connectors. */
  connectorName: string | null;
  /** Display name for the title bar. */
  connectorDisplayName?: string;
  /** Called after Enable/Disable succeeds so the catalog re-fetches profile counts. */
  onChanged?: () => void;
}

interface DoclingQuotaSnapshot {
  binding: boolean;
  enabled: boolean;
  limitPerMinute: number;
}

interface QuotaResponse {
  success: boolean;
  data?: DoclingQuotaSnapshot;
  error?: { code?: string; message: string };
}

export function IntegrationManagerDialog({
  open,
  onClose,
  projectId,
  connectorName,
  connectorDisplayName,
  onChanged,
}: IntegrationManagerDialogProps) {
  const [doclingBinding, setDoclingBinding] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-hydrate Docling binding state whenever the dialog opens for it. Cheap
  // call (cached via SWR-like behavior would be nicer, but the underlying
  // `apiFetch` doesn't memoize and this is a single GET per open).
  useEffect(() => {
    if (!open || connectorName !== 'docling') {
      setDoclingBinding(null);
      return;
    }
    let cancelled = false;
    setError(null);
    apiFetch(`/api/projects/${projectId}/integrations/docling/quota`)
      .then((res) => res.json() as Promise<QuotaResponse>)
      .then((parsed) => {
        if (cancelled) return;
        if (parsed.success && parsed.data) {
          setDoclingBinding(parsed.data.binding);
        } else {
          setError('Failed to load Docling status.');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(sanitizeError(err, 'Failed to load Docling status.'));
      });
    return () => {
      cancelled = true;
    };
  }, [open, connectorName, projectId]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setError(null);
      const action = next ? 'enable' : 'disable';
      try {
        const res = await apiFetch(`/api/projects/${projectId}/integrations/docling/${action}`, {
          method: 'POST',
        });
        if (!res.ok) {
          // BFF + workflow-engine both surface `{ error: { code, message } }`
          // on failure. Pull the upstream code so the user sees, e.g.,
          // FEATURE_DISABLED rather than a generic "Failed to enable".
          const body = (await res.json().catch(() => ({}))) as {
            error?: { code?: string; message?: string } | string;
          };
          const upstream =
            typeof body.error === 'string' ? { code: undefined, message: body.error } : body.error;
          const code = upstream?.code;
          const message = upstream?.message;
          const friendly =
            code === 'FEATURE_DISABLED'
              ? 'Docling extraction is disabled for this workspace. Ask an administrator to enable WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED on the workflow-engine.'
              : code === 'SERVICE_UNAVAILABLE'
                ? 'Workflow-engine is unreachable. Confirm the abl-workflow-engine container is up and healthy.'
                : code === 'BAD_GATEWAY'
                  ? 'Workflow-engine returned a non-JSON response. Check abl-workflow-engine logs.'
                  : res.status >= 500
                    ? `Workflow-engine error (HTTP ${res.status}). Try again, then check the abl-workflow-engine logs.`
                    : res.status === 403
                      ? 'You do not have permission to change the Docling binding for this project.'
                      : null;
          setError(
            friendly
              ? `${friendly}${message ? ` — ${message}` : ''}`
              : (message ?? `Failed to ${action} Docling (HTTP ${res.status}).`),
          );
          return;
        }
        setDoclingBinding(next);
        onChanged?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/Failed to fetch|NetworkError|TypeError: fetch/.test(message)) {
          setError(
            `Could not reach Studio's BFF for ${action} (${message}). Network or proxy issue — retry, or check the abl-studio process.`,
          );
        } else {
          setError(sanitizeError(err, `Failed to ${action} Docling.`));
        }
      } finally {
        setBusy(false);
      }
    },
    [projectId, onChanged],
  );

  if (!open || !connectorName) return null;

  const title = `Manage ${connectorDisplayName ?? connectorName}`;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md">
      <div className="space-y-4">
        <header>
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        </header>

        {connectorName === 'docling' && (
          <>
            <div className="rounded-md border border-default bg-background-muted p-3">
              <p className="text-sm text-foreground">No authentication required</p>
              <p className="mt-1 text-xs text-muted">
                Docling runs against the platform&apos;s internal extraction service. Enable it to
                allow workflows in this project to call <code>docling.extract_document</code>.
              </p>
            </div>

            <DoclingQuotaView projectId={projectId} />

            <div className="flex items-center gap-2 border-t border-default pt-4">
              {doclingBinding === false && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleToggle(true)}
                  loading={busy}
                >
                  Enable Docling
                </Button>
              )}
              {doclingBinding === true && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void handleToggle(false)}
                  loading={busy}
                >
                  Disable Docling
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}

        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
