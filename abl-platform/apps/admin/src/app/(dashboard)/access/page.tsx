'use client';

import { useEffect, useState } from 'react';
import { AtSign, Loader2, Mail, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';

interface DomainRow {
  id?: string;
  domain: string;
  source?: 'default' | 'custom';
}

interface AdminRow {
  id: string;
  email: string;
  userId: string | null;
  addedByUserId: string;
  createdAt: string;
}

interface AccessRequestRow {
  id: string;
  email: string;
  domain: string;
  name: string | null;
  message: string | null;
  requestCount: number;
  lastRequestedAt: string;
  createdAt: string;
}

interface AllowedEmailRow {
  id: string;
  email: string;
  addedByUserId: string;
  createdAt: string;
}

interface AccessPolicyResponse {
  defaultDomains: string[];
  customDomains: Array<{ id: string; domain: string; createdAt: string; addedByUserId: string }>;
  allowedEmails: AllowedEmailRow[];
  platformAdmins: AdminRow[];
  pendingAccessRequests: AccessRequestRow[];
}

type ApiErrorResponse = { error?: string | { message?: string } };

function getApiErrorMessage(data: ApiErrorResponse, fallback: string): string {
  if (typeof data.error === 'string') {
    return data.error;
  }

  return data.error?.message || fallback;
}

export default function AccessPage() {
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [allowedEmails, setAllowedEmails] = useState<AllowedEmailRow[]>([]);
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [requests, setRequests] = useState<AccessRequestRow[]>([]);
  const [domain, setDomain] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'domain' | 'email' | 'admin' | 'delete' | null>(null);
  const [error, setError] = useState('');

  const applyPolicy = (policy: AccessPolicyResponse) => {
    setDomains([
      ...policy.defaultDomains.map((value) => ({ domain: value, source: 'default' as const })),
      ...policy.customDomains.map((row) => ({
        id: row.id,
        domain: row.domain,
        source: 'custom' as const,
      })),
    ]);
    setAllowedEmails(policy.allowedEmails ?? []);
    setAdmins(policy.platformAdmins);
    setRequests(policy.pendingAccessRequests);
  };

  const loadPolicy = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/access/admins');
      const data = (await response.json()) as AccessPolicyResponse & ApiErrorResponse;
      if (!response.ok) {
        throw new Error(getApiErrorMessage(data, 'Failed to load access policy.'));
      }
      applyPolicy(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load access policy.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPolicy();
  }, []);

  const addDomain = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving('domain');
    setError('');
    try {
      const response = await fetch('/api/access/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      const data = (await response.json()) as AccessPolicyResponse & ApiErrorResponse;
      if (!response.ok) {
        throw new Error(getApiErrorMessage(data, 'Failed to add domain.'));
      }
      applyPolicy(data);
      setDomain('');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to add domain.');
    } finally {
      setSaving(null);
    }
  };

  const removeDomain = async (value: string) => {
    setSaving('delete');
    setError('');
    try {
      const response = await fetch(`/api/access/domains?domain=${encodeURIComponent(value)}`, {
        method: 'DELETE',
      });
      const data = (await response.json()) as AccessPolicyResponse & ApiErrorResponse;
      if (!response.ok) {
        throw new Error(getApiErrorMessage(data, 'Failed to remove domain.'));
      }
      applyPolicy(data);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to remove domain.');
    } finally {
      setSaving(null);
    }
  };

  const addAdmin = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving('admin');
    setError('');
    try {
      const response = await fetch('/api/access/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: adminEmail }),
      });
      const data = (await response.json()) as AccessPolicyResponse & ApiErrorResponse;
      if (!response.ok) {
        throw new Error(getApiErrorMessage(data, 'Failed to add platform admin.'));
      }
      applyPolicy(data);
      setAdminEmail('');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to add platform admin.');
    } finally {
      setSaving(null);
    }
  };

  const removeAdmin = async (email: string) => {
    setSaving('delete');
    setError('');
    try {
      const response = await fetch(`/api/access/admins?email=${encodeURIComponent(email)}`, {
        method: 'DELETE',
      });
      const data = (await response.json()) as AccessPolicyResponse & ApiErrorResponse;
      if (!response.ok) {
        throw new Error(getApiErrorMessage(data, 'Failed to remove platform admin.'));
      }
      applyPolicy(data);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : 'Failed to remove platform admin.',
      );
    } finally {
      setSaving(null);
    }
  };

  const addEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving('email');
    setError('');
    try {
      const response = await fetch('/api/access/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail }),
      });
      const data = (await response.json()) as AccessPolicyResponse & ApiErrorResponse;
      if (!response.ok) {
        throw new Error(getApiErrorMessage(data, 'Failed to add email.'));
      }
      applyPolicy(data);
      setNewEmail('');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to add email.');
    } finally {
      setSaving(null);
    }
  };

  const removeEmail = async (email: string) => {
    setSaving('delete');
    setError('');
    try {
      const response = await fetch(`/api/access/emails?email=${encodeURIComponent(email)}`, {
        method: 'DELETE',
      });
      const data = (await response.json()) as AccessPolicyResponse & ApiErrorResponse;
      if (!response.ok) {
        throw new Error(getApiErrorMessage(data, 'Failed to remove email.'));
      }
      applyPolicy(data);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to remove email.');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Access Control</h1>
          <p className="text-sm text-muted mt-1">Manage signup domains and platform admins</p>
        </div>
        {loading && <Loader2 className="h-5 w-5 animate-spin text-muted" />}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-error/25 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-background-subtle p-5">
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">Allowed Domains</h2>
          </div>

          <form onSubmit={addDomain} className="mb-4 flex gap-2">
            <input
              type="text"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus"
              placeholder="example.com"
            />
            <button
              type="submit"
              disabled={saving !== null || !domain.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving === 'domain' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Add
            </button>
          </form>

          <div className="divide-y divide-border rounded-md border border-border">
            {domains.map((row) => (
              <div
                key={`${row.source}-${row.domain}`}
                className="flex items-center justify-between px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{row.domain}</p>
                  <p className="text-xs text-subtle">
                    {row.source === 'default' ? 'Default' : 'Custom'}
                  </p>
                </div>
                {row.source === 'custom' && (
                  <button
                    type="button"
                    onClick={() => removeDomain(row.domain)}
                    disabled={saving !== null}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-error/30 text-error hover:bg-error/10 disabled:opacity-50"
                    title="Remove domain"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Allowed Emails */}
        <section className="rounded-lg border border-border bg-background-subtle p-5">
          <div className="mb-4 flex items-center gap-2">
            <AtSign className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">Allowed Emails</h2>
          </div>

          <form onSubmit={addEmail} className="mb-4 flex gap-2">
            <input
              type="email"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus"
              placeholder="user@gmail.com"
            />
            <button
              type="submit"
              disabled={saving !== null || !newEmail.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving === 'email' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Add
            </button>
          </form>

          <div className="divide-y divide-border rounded-md border border-border">
            {allowedEmails.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted">
                No individual emails added. Users must have an allowlisted domain to sign up.
              </div>
            ) : (
              allowedEmails.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{row.email}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeEmail(row.email)}
                    disabled={saving !== null}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-error/30 text-error hover:bg-error/10 disabled:opacity-50"
                    title="Remove email"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-background-subtle p-5">
          <div className="mb-4 flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">Platform Admins</h2>
          </div>

          <form onSubmit={addAdmin} className="mb-4 flex gap-2">
            <input
              type="email"
              value={adminEmail}
              onChange={(event) => setAdminEmail(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus"
              placeholder="admin@example.com"
            />
            <button
              type="submit"
              disabled={saving !== null || !adminEmail.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving === 'admin' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Add
            </button>
          </form>

          <div className="divide-y divide-border rounded-md border border-border">
            {admins.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted">
                No DB-managed admins yet.
              </div>
            ) : (
              admins.map((admin) => (
                <div key={admin.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{admin.email}</p>
                    <p className="truncate text-xs text-subtle">
                      {admin.userId ? `Linked user ${admin.userId}` : 'Pending first sign-in'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAdmin(admin.email)}
                    disabled={saving !== null}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-error/30 text-error hover:bg-error/10 disabled:opacity-50"
                    title="Remove platform admin"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-background-subtle p-5">
          <div className="mb-4 flex items-center gap-2">
            <Mail className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">Pending Access Requests</h2>
          </div>

          <div className="divide-y divide-border rounded-md border border-border">
            {requests.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted">
                No pending access requests.
              </div>
            ) : (
              requests.map((request) => (
                <div
                  key={request.id}
                  className="grid gap-2 px-3 py-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{request.email}</p>
                    <p className="truncate text-xs text-subtle">
                      {request.name || 'No name provided'}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">{request.domain}</p>
                    <p className="truncate text-xs text-subtle">
                      {request.message || 'No message provided'}
                    </p>
                  </div>
                  <div className="text-left text-xs text-subtle md:text-right">
                    Requested {request.requestCount} time{request.requestCount === 1 ? '' : 's'}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
