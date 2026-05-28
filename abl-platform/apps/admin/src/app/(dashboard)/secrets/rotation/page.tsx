'use client';

import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useApi } from '../../../../hooks/use-swr-fetch';
import { SkeletonTable } from '../../../../components/ui/skeleton';
import { EmptyState } from '../../../../components/ui/empty-state';
import { Badge } from '../../../../components/ui/badge';
import type { RotationResponse, SecretsResponse } from '../../../../types/api';

const SCOPES = ['shared', 'infra', 'runtime', 'studio'];
const ENVIRONMENTS = ['dev', 'staging', 'prod'];

function relativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;

  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Toast Feedback ─────────────────────────────────────────────────────────

type ToastVariant = 'success' | 'error';

interface ToastState {
  message: string;
  variant: ToastVariant;
}

function Toast({ message, variant, onDismiss }: ToastState & { onDismiss: () => void }) {
  return (
    <div
      className={`fixed top-4 right-4 z-[60] px-4 py-3 rounded-[var(--radius-md)] text-sm font-medium shadow-lg transition-all ${
        variant === 'success'
          ? 'bg-success-subtle text-success border border-success'
          : 'bg-error-subtle text-error border border-error'
      }`}
    >
      <div className="flex items-center gap-2">
        <span>{message}</span>
        <button onClick={onDismiss} className="ml-2 text-current opacity-60 hover:opacity-100">
          &times;
        </button>
      </div>
    </div>
  );
}

// ─── Rotate Confirmation Dialog ─────────────────────────────────────────────

function RotateSecretDialog({
  open,
  secretName,
  scope,
  environment,
  onClose,
  onRotated,
}: {
  open: boolean;
  secretName: string;
  scope: string;
  environment: string;
  onClose: () => void;
  onRotated: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRotate = async () => {
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/secrets/rotation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secretName, scope, environment }),
      });
      const data = await res.json();
      if (res.ok && data.success !== false) {
        onRotated();
        onClose();
      } else {
        setError(data.error || `Request failed with status ${res.status}`);
      }
    } catch {
      setError('Failed to connect to server');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      setError(null);
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-overlay" onClick={handleClose} />
      <div className="relative z-50 w-full max-w-md rounded-lg border border-border bg-background-subtle p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-foreground mb-2">Rotate Secret</h2>
        <p className="text-sm text-muted mb-4">
          This will generate a new value for{' '}
          <span className="font-mono font-medium text-foreground">{secretName}</span> in{' '}
          <span className="font-medium text-foreground">{environment.toUpperCase()}</span>.
          Continue?
        </p>

        {error && <p className="text-sm text-error mt-3">{error}</p>}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={handleClose}
            disabled={submitting}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-background-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleRotate}
            disabled={submitting}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Rotating...' : 'Rotate Now'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Rotation History Page ──────────────────────────────────────────────────

export default function RotationHistoryPage() {
  const { data, loading, error, refetch } = useApi<RotationResponse>('/api/secrets/rotation');

  const [scope, setScope] = useState('shared');
  const [env, setEnv] = useState('dev');
  const { data: secretsData } = useApi<SecretsResponse>(`/api/secrets?scope=${scope}&env=${env}`);

  const [rotateTarget, setRotateTarget] = useState<{
    name: string;
    scope: string;
    environment: string;
  } | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = (message: string, variant: ToastVariant) => {
    setToast({ message, variant });
    setTimeout(() => setToast(null), 4000);
  };

  return (
    <div>
      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}

      <div className="flex items-center gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Rotation History</h2>
          <p className="text-sm text-muted mt-1">Secret rotation events and manual triggers</p>
        </div>
        <a
          href="/secrets"
          className="ml-auto px-4 py-2 bg-background-muted border border-default rounded-[var(--radius-md)] text-sm text-muted hover:text-foreground transition-default"
        >
          Back to Secrets
        </a>
      </div>

      {/* Rotate Now Section */}
      <div className="mb-8 p-4 bg-background-muted border border-default rounded-[var(--radius-xl)]">
        <h3 className="text-sm font-semibold text-foreground mb-3">Trigger Manual Rotation</h3>
        <div className="flex gap-2 mb-3">
          <div className="flex gap-1">
            {SCOPES.map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium capitalize transition-default ${
                  s === scope
                    ? 'bg-accent text-accent-foreground'
                    : 'border border-default text-muted hover:text-foreground hover:bg-background-muted'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-1">
            {ENVIRONMENTS.map((e) => (
              <button
                key={e}
                onClick={() => setEnv(e)}
                className={`px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs font-medium uppercase transition-default ${
                  e === env
                    ? 'bg-accent text-accent-foreground'
                    : 'border border-default text-muted hover:text-foreground hover:bg-background-muted'
                }`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        {secretsData && secretsData.secrets.length > 0 ? (
          <div className="space-y-1">
            {secretsData.secrets.map((secret) => (
              <div
                key={secret.name}
                className="flex items-center justify-between px-3 py-2 rounded-[var(--radius-md)] hover:bg-background-subtle transition-default"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-foreground">{secret.name}</span>
                  <Badge variant="info">{secret.environment}</Badge>
                </div>
                <button
                  onClick={() =>
                    setRotateTarget({
                      name: secret.name,
                      scope: secret.scope,
                      environment: secret.environment,
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium bg-accent text-accent-foreground hover:opacity-90 transition-default"
                >
                  <RotateCw size={12} />
                  Rotate Now
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted py-2">
            No secrets found for {scope} / {env.toUpperCase()}.
          </p>
        )}
      </div>

      {/* Rotation History Table */}
      <h3 className="text-lg font-semibold text-foreground mb-3">History</h3>

      {loading ? (
        <SkeletonTable rows={5} />
      ) : error ? (
        <EmptyState
          title="Failed to load rotation history"
          description={error}
          action={
            <button
              onClick={refetch}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm btn-press"
            >
              Retry
            </button>
          }
        />
      ) : data && data.rotations.length > 0 ? (
        <div className="bg-background-muted border border-default rounded-[var(--radius-xl)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-background-subtle text-subtle border-b border-border-muted">
                <th className="text-left px-4 py-3 font-medium">Timestamp</th>
                <th className="text-left px-4 py-3 font-medium">Secret</th>
                <th className="text-left px-4 py-3 font-medium">Actor</th>
                <th className="text-left px-4 py-3 font-medium">Environment</th>
                <th className="text-left px-4 py-3 font-medium">IP Address</th>
              </tr>
            </thead>
            <tbody>
              {data.rotations.map((rotation, i) => (
                <tr
                  key={i}
                  className="border-b border-border-muted last:border-b-0 table-row-hover"
                >
                  <td
                    className="px-4 py-3 text-xs text-muted"
                    title={new Date(rotation.timestamp).toLocaleString()}
                  >
                    {relativeTime(rotation.timestamp)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground">{rotation.secret}</td>
                  <td className="px-4 py-3 text-xs text-muted">{rotation.actor}</td>
                  <td className="px-4 py-3">
                    <Badge variant="info">{rotation.environment ?? 'unknown'}</Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-subtle">{rotation.ipAddress ?? '---'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No rotation history" description="No secrets have been rotated yet." />
      )}

      <RotateSecretDialog
        open={!!rotateTarget}
        secretName={rotateTarget?.name ?? ''}
        scope={rotateTarget?.scope ?? scope}
        environment={rotateTarget?.environment ?? env}
        onClose={() => setRotateTarget(null)}
        onRotated={() => {
          refetch();
          showToast(`Secret "${rotateTarget?.name}" rotated successfully`, 'success');
        }}
      />
    </div>
  );
}
