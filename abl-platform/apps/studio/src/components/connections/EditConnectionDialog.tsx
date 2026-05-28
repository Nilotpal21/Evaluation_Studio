/**
 * EditConnectionDialog Component
 *
 * Dialog for editing an agent-desktop connection's display name, auth profile,
 * and provider metadata. Password fields start empty — leaving them blank
 * preserves the existing secret value.
 */

'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import {
  createAuthProfile,
  deleteAuthProfile,
  fetchAuthProfile,
  updateAuthProfile,
  type AuthType,
} from '../../api/auth-profiles';
import { getConnection, updateConnection } from '../../api/connections';
import { getProviderDef } from './agent-desktop-registry';
import { sanitizeError } from '../../lib/sanitize-error';
import {
  buildAgentDesktopConnectionSetup,
  getAgentDesktopAuthProfileName,
  getAgentDesktopCredentialDefaults,
} from './agent-desktop-connection-utils';

interface EditConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  connectionId: string;
  providerId: string;
  onSaved: () => void;
}

export function EditConnectionDialog({
  open,
  onClose,
  projectId,
  connectionId,
  providerId,
  onSaved,
}: EditConnectionDialogProps) {
  const providerDef = getProviderDef(providerId);
  const [displayName, setDisplayName] = useState('');
  const [loadedDisplayName, setLoadedDisplayName] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authProfileId, setAuthProfileId] = useState<string | null>(null);
  const [existingAuthType, setExistingAuthType] = useState<AuthType | null>(null);
  const [existingSecretKeys, setExistingSecretKeys] = useState<Set<string>>(new Set());

  function reset() {
    setDisplayName('');
    setLoadedDisplayName('');
    setCredentials({});
    setLoading(false);
    setSaving(false);
    setError(null);
    setAuthProfileId(null);
    setExistingAuthType(null);
    setExistingSecretKeys(new Set());
  }

  function handleClose() {
    reset();
    onClose();
  }

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }

    if (!projectId || !connectionId || !providerDef) {
      return;
    }

    const resolvedProvider = providerDef;
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function loadConnectionState() {
      try {
        const connectionResult = await getConnection(projectId, connectionId);
        if (cancelled) return;

        const connection = connectionResult.data;
        const profileResult = await fetchAuthProfile(projectId, connection.authProfileId);
        if (cancelled) return;

        const profile = profileResult.data;
        setDisplayName(connection.displayName ?? '');
        setLoadedDisplayName(connection.displayName ?? '');
        setCredentials(getAgentDesktopCredentialDefaults(resolvedProvider, connection.metadata));
        setAuthProfileId(connection.authProfileId);
        setExistingAuthType(profile.authType);
        setExistingSecretKeys(new Set(Object.keys(profile.redactedSecrets ?? {})));
      } catch (err) {
        if (cancelled) return;
        setError(sanitizeError(err, 'Failed to load connection'));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadConnectionState();

    return () => {
      cancelled = true;
    };
  }, [open, projectId, connectionId, providerDef]);

  async function handleSave() {
    if (!providerDef) return;

    setSaving(true);
    setError(null);
    let createdAuthProfileId: string | null = null;

    try {
      const nextDisplayName = displayName.trim() || loadedDisplayName;
      if (!nextDisplayName) {
        throw new Error('Display Name is required');
      }

      if (!authProfileId || !existingAuthType) {
        throw new Error('Connection credentials are not loaded yet');
      }

      const setup = buildAgentDesktopConnectionSetup(providerDef, credentials, {
        existingSecretKeys,
      });
      let nextAuthProfileId = authProfileId;

      if (setup.authType !== existingAuthType) {
        const createdAuthProfile = await createAuthProfile(projectId, {
          name: getAgentDesktopAuthProfileName(nextDisplayName),
          authType: setup.authType,
          config: setup.config,
          secrets: setup.secrets,
          projectId,
          scope: 'project',
          visibility: 'shared',
          connectionMode: 'shared',
          connector: providerDef.id,
          category: 'agent_desktop',
        });
        createdAuthProfileId = createdAuthProfile.data.id;
        nextAuthProfileId = createdAuthProfile.data.id;
      } else {
        await updateAuthProfile(projectId, authProfileId, {
          name: getAgentDesktopAuthProfileName(nextDisplayName),
          config: setup.config,
          ...(Object.keys(setup.secrets).length > 0 ? { secrets: setup.secrets } : {}),
          connector: providerDef.id,
          category: 'agent_desktop',
        });
      }

      await updateConnection(projectId, connectionId, {
        displayName: nextDisplayName,
        authProfileId: nextAuthProfileId,
        metadata: setup.metadata,
      });
      handleClose();
      onSaved();
    } catch (err) {
      if (createdAuthProfileId) {
        try {
          await deleteAuthProfile(projectId, createdAuthProfileId);
        } catch {
          // Best-effort cleanup when replacing the auth profile fails partway through.
        }
      }
      setError(sanitizeError(err, 'Failed to update connection'));
    } finally {
      setSaving(false);
    }
  }

  if (!providerDef) {
    return null;
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="lg">
      <div>
        <div className="flex items-center gap-2 mb-2">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-background-muted">
            <providerDef.Icon className="w-4 h-4 text-muted" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">
            Edit {providerDef.label} Connection
          </h2>
        </div>

        {loading ? (
          <p className="text-sm text-muted py-4">Loading connection...</p>
        ) : (
          <div className="space-y-4">
            <Input
              label="Display Name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Enter a new display name"
            />
            {providerDef.fields.map((field) => {
              const hasExistingSecret =
                field.type === 'password' && existingSecretKeys.has(field.key);
              return (
                <div key={field.key}>
                  <Input
                    label={field.required ? field.label : `${field.label} (optional)`}
                    type={field.type === 'password' ? 'password' : 'text'}
                    value={credentials[field.key] ?? ''}
                    onChange={(e) =>
                      setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={
                      hasExistingSecret ? 'Leave blank to keep current value' : field.placeholder
                    }
                  />
                  {field.hint && <p className="text-xs text-muted mt-1">{field.hint}</p>}
                </div>
              );
            })}
            <Button
              variant="primary"
              onClick={handleSave}
              loading={saving}
              disabled={saving || loading}
              className="w-full"
            >
              Save Changes
            </Button>
            {error && <p className="text-sm text-error">{error}</p>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
