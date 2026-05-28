'use client';

/**
 * ProfilePanel Component
 *
 * Slide-out panel showing user profile details with inline name editing.
 */

import { useState, useEffect } from 'react';
import { User as UserIcon, Mail, Building2, Pencil, Loader2, Check, X, Copy } from 'lucide-react';
import { SlidePanel } from '../ui/SlidePanel';
import { Avatar } from '../ui/Avatar';
import { useAuthStore } from '../../store/auth-store';
import { apiFetch } from '../../lib/api-client';

interface ProfilePanelProps {
  open: boolean;
  onClose: () => void;
}

export function ProfilePanel({ open, onClose }: ProfilePanelProps) {
  const { user, tenantId } = useAuthStore();
  const setUser = useAuthStore((s) => s.setUser);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset edit state when panel opens/closes
  useEffect(() => {
    if (!open) {
      setEditing(false);
      setError(null);
    }
  }, [open]);

  if (!user) return null;

  const handleStartEdit = () => {
    setEditName(user.name || '');
    setEditing(true);
    setError(null);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setError(null);
  };

  const handleSave = async () => {
    const trimmedName = editName.trim();
    if (!trimmedName) return;
    if (trimmedName === user.name) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const res = await apiFetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body.error?.message || body.error || 'Failed to update profile';
        throw new Error(typeof msg === 'string' ? msg : 'Failed to update profile');
      }

      // Update the auth store with the new name
      setUser({ ...user, name: trimmedName });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SlidePanel open={open} onClose={onClose} title="Profile" width="sm">
      <div className="flex flex-col items-center text-center mb-8">
        <Avatar name={user.name || user.email} src={user.avatarUrl} size="lg" />
        <h2 className="text-lg font-semibold text-foreground mt-4">{user.name || 'User'}</h2>
        <p className="text-sm text-muted">{user.email}</p>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-error-subtle border border-error text-error text-sm">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <ProfileField
          icon={<UserIcon className="w-4 h-4" />}
          label="User ID"
          value={user.id}
          copyable
        />
        <ProfileField icon={<Mail className="w-4 h-4" />} label="Email" value={user.email} />

        {/* Editable display name */}
        <div className="flex items-start gap-3 p-3 rounded-lg bg-background-muted border border-default">
          <span className="text-muted shrink-0 mt-0.5">
            <UserIcon className="w-4 h-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted font-medium mb-1">Display Name</p>
            {editing ? (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSave();
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                  className="flex-1 text-sm bg-background border border-default rounded px-2 py-1 text-foreground focus:outline-none focus:border-border-focus transition-default"
                  autoFocus
                  disabled={saving}
                />
                <button
                  onClick={handleSave}
                  disabled={saving || !editName.trim()}
                  className="p-1 rounded text-success hover:bg-background transition-default disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  onClick={handleCancelEdit}
                  disabled={saving}
                  className="p-1 rounded text-muted hover:text-foreground hover:bg-background transition-default disabled:opacity-50"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <p className="text-sm text-foreground truncate">
                  {user.name || <span className="text-muted italic">Not set</span>}
                </p>
                <button
                  onClick={handleStartEdit}
                  className="p-0.5 rounded text-muted hover:text-foreground transition-default shrink-0"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        </div>

        {tenantId && (
          <ProfileField
            icon={<Building2 className="w-4 h-4" />}
            label="Workspace ID"
            value={tenantId}
            copyable
          />
        )}
      </div>
    </SlidePanel>
  );
}

function ProfileField({
  icon,
  label,
  value,
  copyable,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may fail in insecure contexts
    }
  };

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-background-muted border border-default">
      <span className="text-muted shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted font-medium">{label}</p>
        <div className="flex items-center gap-1.5">
          <p className="text-sm text-foreground truncate">{value}</p>
          {copyable && (
            <button
              onClick={handleCopy}
              className="p-0.5 rounded text-muted hover:text-foreground transition-default shrink-0"
              title="Copy to clipboard"
            >
              {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
