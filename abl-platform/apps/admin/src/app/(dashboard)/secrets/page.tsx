'use client';

import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { useApi } from '../../../hooks/use-swr-fetch';
import { SkeletonTable } from '../../../components/ui/skeleton';
import { EmptyState } from '../../../components/ui/empty-state';
import { Badge } from '../../../components/ui/badge';
import type { SecretsResponse, SecretEntry } from '../../../types/api';

const SCOPES = ['shared', 'infra', 'runtime', 'studio'];
const ENVIRONMENTS = ['dev', 'staging', 'prod'];

const inputClass =
  'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
const selectClass =
  'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
const labelClass = 'block text-xs font-medium text-foreground-muted mb-1';

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

// ─── Create Secret Dialog ───────────────────────────────────────────────────

interface CreateSecretForm {
  name: string;
  value: string;
  scope: string;
  environment: string;
}

const INITIAL_CREATE_FORM: CreateSecretForm = {
  name: '',
  value: '',
  scope: 'shared',
  environment: 'dev',
};

function CreateSecretDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [formData, setFormData] = useState<CreateSecretForm>(INITIAL_CREATE_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.value.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (res.ok && data.success !== false) {
        setFormData(INITIAL_CREATE_FORM);
        onCreated();
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
      setFormData(INITIAL_CREATE_FORM);
      setError(null);
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-overlay" onClick={handleClose} />
      <div className="relative z-50 w-full max-w-lg rounded-lg border border-border bg-background-subtle p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-foreground mb-4">Create Secret</h2>
        <div className="space-y-3">
          <div>
            <label htmlFor="secret-name" className={labelClass}>
              Name
            </label>
            <input
              id="secret-name"
              type="text"
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="e.g. API_KEY"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="secret-value" className={labelClass}>
              Value
            </label>
            <input
              id="secret-value"
              type="password"
              value={formData.value}
              onChange={(e) => setFormData((prev) => ({ ...prev, value: e.target.value }))}
              placeholder="Enter secret value"
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="secret-scope" className={labelClass}>
                Scope
              </label>
              <select
                id="secret-scope"
                value={formData.scope}
                onChange={(e) => setFormData((prev) => ({ ...prev, scope: e.target.value }))}
                className={selectClass}
              >
                {SCOPES.map((s) => (
                  <option key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="secret-env" className={labelClass}>
                Environment
              </label>
              <select
                id="secret-env"
                value={formData.environment}
                onChange={(e) => setFormData((prev) => ({ ...prev, environment: e.target.value }))}
                className={selectClass}
              >
                {ENVIRONMENTS.map((e) => (
                  <option key={e} value={e}>
                    {e.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

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
            onClick={handleSubmit}
            disabled={submitting || !formData.name.trim() || !formData.value.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating...' : 'Create Secret'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Edit Secret Dialog ─────────────────────────────────────────────────────

interface EditSecretForm {
  name: string;
  value: string;
  scope: string;
  environment: string;
}

function EditSecretDialog({
  open,
  secret,
  onClose,
  onUpdated,
}: {
  open: boolean;
  secret: SecretEntry | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!secret || !value.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/secrets', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: secret.name,
          value,
          scope: secret.scope,
          environment: secret.environment,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success !== false) {
        setValue('');
        onUpdated();
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
      setValue('');
      setError(null);
      onClose();
    }
  };

  if (!open || !secret) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-overlay" onClick={handleClose} />
      <div className="relative z-50 w-full max-w-lg rounded-lg border border-border bg-background-subtle p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-foreground mb-4">Edit Secret</h2>
        <div className="space-y-3">
          <div>
            <label htmlFor="edit-secret-name" className={labelClass}>
              Name
            </label>
            <input
              id="edit-secret-name"
              type="text"
              value={secret.name}
              disabled
              className={`${inputClass} opacity-60 cursor-not-allowed`}
            />
          </div>
          <div>
            <label htmlFor="edit-secret-value" className={labelClass}>
              Current Value (masked)
            </label>
            <input
              id="edit-secret-current"
              type="text"
              value={secret.value}
              disabled
              className={`${inputClass} opacity-60 cursor-not-allowed font-mono text-xs`}
            />
          </div>
          <div>
            <label htmlFor="edit-secret-new-value" className={labelClass}>
              New Value
            </label>
            <input
              id="edit-secret-new-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter new secret value"
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Scope</label>
              <input
                type="text"
                value={secret.scope}
                disabled
                className={`${inputClass} opacity-60 cursor-not-allowed capitalize`}
              />
            </div>
            <div>
              <label className={labelClass}>Environment</label>
              <input
                type="text"
                value={secret.environment.toUpperCase()}
                disabled
                className={`${inputClass} opacity-60 cursor-not-allowed`}
              />
            </div>
          </div>
        </div>

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
            onClick={handleSubmit}
            disabled={submitting || !value.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Updating...' : 'Update Secret'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete Confirmation Dialog ─────────────────────────────────────────────

function DeleteSecretDialog({
  open,
  secret,
  onClose,
  onDeleted,
}: {
  open: boolean;
  secret: SecretEntry | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!secret) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/secrets', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: secret.name,
          scope: secret.scope,
          environment: secret.environment,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success !== false) {
        onDeleted();
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

  if (!open || !secret) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-overlay" onClick={handleClose} />
      <div className="relative z-50 w-full max-w-md rounded-lg border border-border bg-background-subtle p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-foreground mb-2">Delete Secret</h2>
        <p className="text-sm text-muted mb-1">
          Are you sure you want to delete{' '}
          <span className="font-mono font-medium text-foreground">{secret.name}</span>?
        </p>
        <p className="text-sm text-muted mb-4">This action cannot be undone.</p>

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
            onClick={handleDelete}
            disabled={submitting}
            className="rounded-md bg-error px-4 py-2 text-sm font-medium text-error-foreground hover:bg-error-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Deleting...' : 'Delete Secret'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Secrets Page ───────────────────────────────────────────────────────────

export default function SecretsPage() {
  const [scope, setScope] = useState('shared');
  const [env, setEnv] = useState('dev');
  const { data, loading, error, refetch } = useApi<SecretsResponse>(
    `/api/secrets?scope=${scope}&env=${env}`,
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [editSecret, setEditSecret] = useState<SecretEntry | null>(null);
  const [deleteSecret, setDeleteSecret] = useState<SecretEntry | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = (message: string, variant: ToastVariant) => {
    setToast({ message, variant });
    setTimeout(() => setToast(null), 4000);
  };

  return (
    <div>
      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}

      <div className="flex items-center justify-between mb-2">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Secrets</h2>
          <p className="text-sm text-muted mt-1">Manage secrets across scopes and environments</p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 transition-colors"
        >
          <Plus size={16} />
          Create Secret
        </button>
      </div>

      <div className="mb-4 px-4 py-3 bg-info-subtle border border-info-muted rounded-[var(--radius-md)] text-sm text-info">
        Secrets are managed via External Secrets Operator. Rotation history is logged below.
      </div>

      <div className="flex gap-4 mb-6">
        <div className="flex gap-2">
          {SCOPES.map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`px-4 py-2 rounded-[var(--radius-md)] text-sm font-medium capitalize transition-default ${
                s === scope
                  ? 'bg-accent text-accent-foreground'
                  : 'border border-default text-muted hover:text-foreground hover:bg-background-muted'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          {ENVIRONMENTS.map((e) => (
            <button
              key={e}
              onClick={() => setEnv(e)}
              className={`px-3 py-2 rounded-[var(--radius-md)] text-xs font-medium uppercase transition-default ${
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

      {loading ? (
        <SkeletonTable rows={5} />
      ) : error ? (
        <EmptyState
          title="Failed to load secrets"
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
      ) : data && data.secrets.length > 0 ? (
        <div className="bg-background-muted border border-default rounded-[var(--radius-xl)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-background-subtle text-subtle border-b border-border-muted">
                <th className="text-left px-4 py-3 font-medium">Secret Name</th>
                <th className="text-left px-4 py-3 font-medium">Value</th>
                <th className="text-left px-4 py-3 font-medium">Environment</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.secrets.map((secret) => (
                <tr
                  key={secret.name}
                  className="border-b border-border-muted last:border-b-0 table-row-hover"
                >
                  <td className="px-4 py-3 font-mono text-xs text-foreground">{secret.name}</td>
                  <td className="px-4 py-3">
                    <span className="text-subtle font-mono text-xs">{secret.value}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="info">{secret.environment}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        onClick={() => setEditSecret(secret)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs font-medium border border-default text-muted hover:text-foreground hover:bg-background-muted transition-default"
                        title="Edit secret"
                      >
                        <Pencil size={12} />
                        Edit
                      </button>
                      <button
                        onClick={() => setDeleteSecret(secret)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs font-medium border border-error text-error hover:text-error hover:bg-error-subtle transition-default"
                        title="Delete secret"
                      >
                        <Trash2 size={12} />
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title={`No secrets for "${scope}" in ${env.toUpperCase()}`}
          description="This scope has no secrets configured for the selected environment."
        />
      )}

      <div className="mt-4">
        <a href="/secrets/rotation" className="text-accent hover:underline text-sm">
          View rotation history
        </a>
      </div>

      <CreateSecretDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          refetch();
          showToast('Secret created successfully', 'success');
        }}
      />

      <EditSecretDialog
        open={!!editSecret}
        secret={editSecret}
        onClose={() => setEditSecret(null)}
        onUpdated={() => {
          refetch();
          showToast('Secret updated successfully', 'success');
        }}
      />

      <DeleteSecretDialog
        open={!!deleteSecret}
        secret={deleteSecret}
        onClose={() => setDeleteSecret(null)}
        onDeleted={() => {
          refetch();
          showToast('Secret deleted successfully', 'success');
        }}
      />
    </div>
  );
}
