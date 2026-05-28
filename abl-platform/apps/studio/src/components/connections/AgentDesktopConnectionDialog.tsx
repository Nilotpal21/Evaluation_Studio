'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Info } from 'lucide-react';
import { createConnection, type ConnectionSummary } from '../../api/connections';
import { createAuthProfile, deleteAuthProfile } from '../../api/auth-profiles';
import { sanitizeError } from '../../lib/sanitize-error';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import {
  CONNECTION_BACKED_AGENT_DESKTOP_PROVIDERS,
  type AgentDesktopProvider,
  type AgentDesktopProviderDef,
} from './agent-desktop-registry';
import {
  buildAgentDesktopConnectionSetup,
  getAgentDesktopAuthProfileName,
} from './agent-desktop-connection-utils';

interface AgentDesktopConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (connection: ConnectionSummary) => void;
  preselectedProviderId?: AgentDesktopProvider | null;
}

export function AgentDesktopConnectionDialog({
  open,
  onClose,
  projectId,
  onCreated,
  preselectedProviderId = null,
}: AgentDesktopConnectionDialogProps) {
  const [provider, setProvider] = useState<AgentDesktopProviderDef | null>(null);
  const [name, setName] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setProvider(null);
    setName('');
    setCredentials({});
    setCreating(false);
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function selectProvider(nextProvider: AgentDesktopProviderDef) {
    setProvider(nextProvider);
    setName(`My ${nextProvider.label}`);
    setCredentials({});
    setError(null);
  }

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }

    if (!preselectedProviderId) {
      return;
    }

    const preselectedProvider = CONNECTION_BACKED_AGENT_DESKTOP_PROVIDERS.find(
      (candidate) => candidate.id === preselectedProviderId,
    );

    if (preselectedProvider) {
      setProvider(preselectedProvider);
      setName(`My ${preselectedProvider.label}`);
      setCredentials({});
      setError(null);
    }
  }, [open, preselectedProviderId]);

  async function handleCreate() {
    if (!provider) return;

    setCreating(true);
    setError(null);
    let createdAuthProfileId: string | null = null;

    try {
      const connectionName = name.trim();
      if (!connectionName) {
        throw new Error('Connection Name is required');
      }

      const setup = buildAgentDesktopConnectionSetup(provider, credentials);
      const authProfile = await createAuthProfile(projectId, {
        name: getAgentDesktopAuthProfileName(connectionName),
        authType: setup.authType,
        config: setup.config,
        secrets: setup.secrets,
        projectId,
        scope: 'project',
        visibility: 'shared',
        connectionMode: 'shared',
        connector: provider.id,
        category: 'agent_desktop',
      });
      createdAuthProfileId = authProfile.data.id;

      const result = await createConnection(projectId, {
        connectorName: provider.id,
        displayName: connectionName,
        authProfileId: createdAuthProfileId,
        metadata: setup.metadata,
      });

      handleClose();
      onCreated(result.data);
    } catch (err) {
      if (createdAuthProfileId) {
        try {
          await deleteAuthProfile(projectId, createdAuthProfileId);
        } catch {
          // Best-effort cleanup when connection creation fails after auth profile creation.
        }
      }

      setError(sanitizeError(err, 'Failed to create connection'));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xl">
      {!provider ? (
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-1">
            Add Agent Desktop Connection
          </h2>
          <p className="text-sm text-muted mb-5">
            Choose a provider to route agent transfers through a shared project connection.
          </p>
          <div className="grid grid-cols-1 gap-2">
            {CONNECTION_BACKED_AGENT_DESKTOP_PROVIDERS.map((currentProvider) => (
              <button
                key={currentProvider.id}
                onClick={() => selectProvider(currentProvider)}
                className="flex items-center gap-4 rounded-lg border border-default p-4 hover:border-accent hover:bg-background-muted transition-default text-left"
              >
                <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-background-muted shrink-0">
                  <currentProvider.Icon className="w-5 h-5 text-muted" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{currentProvider.label}</p>
                  <p className="text-xs text-muted mt-0.5">{currentProvider.description}</p>
                </div>
                <span className="text-[10px] uppercase tracking-wider text-muted font-medium px-2 py-0.5 rounded bg-background-muted shrink-0">
                  {currentProvider.authType === 'api_key'
                    ? 'API Key'
                    : currentProvider.authType === 'oauth2'
                      ? 'OAuth 2.0'
                      : 'Custom'}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={() => setProvider(null)}
              className="text-muted hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-background-muted">
              <provider.Icon className="w-4 h-4 text-muted" />
            </div>
            <h2 className="text-lg font-semibold text-foreground">Connect {provider.label}</h2>
          </div>

          {provider.setupHint && (
            <div className="flex items-start gap-2 p-3 mb-5 rounded-lg bg-info-subtle/50 border border-border-subtle">
              <Info className="w-4 h-4 text-info mt-0.5 shrink-0" />
              <p className="text-xs text-foreground-muted leading-relaxed">{provider.setupHint}</p>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <Input
                label="Connection Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <p className="text-xs text-muted mt-1">A friendly name to identify this connection</p>
            </div>
            {provider.fields.map((field) => (
              <div key={field.key}>
                <Input
                  label={field.required ? field.label : `${field.label} (optional)`}
                  type={field.type === 'password' ? 'password' : 'text'}
                  value={credentials[field.key] ?? ''}
                  onChange={(event) =>
                    setCredentials((previous) => ({
                      ...previous,
                      [field.key]: event.target.value,
                    }))
                  }
                  placeholder={field.placeholder}
                />
                {field.hint && <p className="text-xs text-muted mt-1">{field.hint}</p>}
              </div>
            ))}
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={creating}
              disabled={
                !name.trim() ||
                provider.fields.some((field) => field.required && !credentials[field.key]?.trim())
              }
              className="w-full"
            >
              Create Connection
            </Button>
            {error && <p className="text-sm text-error">{error}</p>}
          </div>
        </div>
      )}
    </Dialog>
  );
}
