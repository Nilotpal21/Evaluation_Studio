/**
 * CreateConnectionModal Component
 *
 * Three-step modal for creating a new connection:
 * 1. Pick connector — search + category grouping
 * 2. Configure — name + auth profile selection (auth-profile-only, no inline credentials)
 * 3. Success — confirmation animation
 *
 * Auth is always delegated to auth profiles. The picker groups integration-specific
 * profiles first, then general profiles not attached to any integration.
 */

'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ArrowLeft, Check, Search } from 'lucide-react';
import { useAvailableConnectors, type ConnectorSummary } from '../../hooks/useAvailableConnectors';
import { createConnection } from '../../api/connections';
import type { ConnectionSummary } from '../../api/connections';
import { getConnectorCategory, getCategoryLabel, CATEGORY_ORDER } from './connector-categories';
import { ConnectorLogo } from './ConnectorLogo';
import { OAuthFlowDialog } from './OAuthFlowDialog';
import { AuthProfilePicker } from '../auth-profiles/AuthProfilePicker';
import type { AuthType, AuthProfileSummary } from '../../api/auth-profiles';
import { sanitizeError } from '../../lib/sanitize-error';
import { useAuthProfiles } from '../../hooks/useAuthProfiles';

/** Map connector catalog auth types to compatible auth profile types */
function mapConnectorAuthTypeToProfileAuthType(connectorAuthType: string): AuthType | null {
  switch (connectorAuthType) {
    case 'oauth2':
      return 'oauth2_app';
    case 'oauth2_client_credentials':
      return 'oauth2_client_credentials';
    case 'azure_ad':
      return 'azure_ad';
    case 'api_key':
      return 'api_key';
    case 'bearer':
      return 'bearer';
    case 'basic':
      return 'basic';
    case 'custom_header':
      return 'custom_header';
    case 'aws_iam':
      return 'aws_iam';
    case 'mtls':
      return 'mtls';
    default:
      return null;
  }
}

function getCompatibleAuthTypes(
  availableAuthTypes?: string[],
  connectorAuthType?: string,
): AuthType[] | undefined {
  const authTypes = availableAuthTypes && availableAuthTypes.length > 0 ? availableAuthTypes : [];
  if (authTypes.length === 0 && connectorAuthType) {
    authTypes.push(connectorAuthType);
  }

  const mappedTypes = authTypes
    .map(mapConnectorAuthTypeToProfileAuthType)
    .filter((authType): authType is AuthType => authType !== null);

  return mappedTypes.length > 0 ? Array.from(new Set(mappedTypes)) : undefined;
}

interface CreateConnectionModalProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: () => void;
  preselectedConnector?: string | null;
  /** Existing connections — used to prevent duplicate auth profile usage per connector */
  existingConnections?: ConnectionSummary[];
}

type Step = 'pick' | 'configure' | 'success';
type OAuthConnectionConfigField = NonNullable<
  NonNullable<ConnectorSummary['oauth2']>['connectionConfig']
>[string];

function getDefaultOAuthConnectionConfig(
  fields?: NonNullable<ConnectorSummary['oauth2']>['connectionConfig'],
): Record<string, string> {
  if (!fields) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, field]) => field.default !== undefined)
      .map(([key, field]) => [key, String(field.default)]),
  );
}

function getOAuthConnectionConfigLabel(key: string, field: OAuthConnectionConfigField): string {
  return field.title ?? key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function getOAuthConnectionConfigInputType(
  key: string,
  field: OAuthConnectionConfigField,
): 'password' | 'text' {
  if (field.format === 'password' || /password|secret|token|subscription.?key/i.test(key)) {
    return 'password';
  }

  return 'text';
}

function getOAuthConnectionConfigHint(field: OAuthConnectionConfigField): string | null {
  if (field.description) {
    return field.description;
  }

  if (field.enum && field.enum.length > 0) {
    return `Allowed values: ${field.enum.join(', ')}`;
  }

  if (field.prefix) {
    return `Prefix: ${field.prefix}`;
  }

  return null;
}

export function CreateConnectionModal({
  open,
  onClose,
  projectId,
  onCreated,
  preselectedConnector,
  existingConnections = [],
}: CreateConnectionModalProps) {
  const { connectors } = useAvailableConnectors(projectId);
  const [step, setStep] = useState<Step>('pick');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ConnectorSummary | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthConnector, setOauthConnector] = useState<{
    name: string;
    authorizationUrl: string;
    displayName: string;
    connectionConfig?: Record<string, string>;
  } | null>(null);
  const [oauthConnectionConfig, setOAuthConnectionConfig] = useState<Record<string, string>>({});
  const [authProfileId, setAuthProfileId] = useState<string | null>(null);

  const compatibleAuthTypes = useMemo(
    () => getCompatibleAuthTypes(selected?.availableAuthTypes, selected?.authType),
    [selected],
  );

  const { profiles: selectableProfiles } = useAuthProfiles(projectId, {
    status: 'active',
    authType: compatibleAuthTypes,
    limit: 100,
  });

  const selectedAuthProfile = useMemo(
    () => selectableProfiles.find((profile) => profile.id === authProfileId) ?? null,
    [selectableProfiles, authProfileId],
  );

  function reset() {
    setStep('pick');
    setSearch('');
    setSelected(null);
    setName('');
    setOAuthConnectionConfig({});
    setCreating(false);
    setError(null);
    setAuthProfileId(null);
    preselectedRef.current = null;
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleSelect(connector: ConnectorSummary) {
    setSelected(connector);
    setName(`My ${connector.displayName}`);
    setOAuthConnectionConfig(getDefaultOAuthConnectionConfig(connector.oauth2?.connectionConfig));
    setError(null);
    setAuthProfileId(null);
    setStep('configure');
  }

  const preselectedRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      preselectedConnector &&
      connectors.length > 0 &&
      preselectedRef.current !== preselectedConnector
    ) {
      preselectedRef.current = preselectedConnector;
      const connector = connectors.find((c) => c.name === preselectedConnector);
      if (connector) {
        handleSelect(connector);
      }
    }
  }, [preselectedConnector, connectors]); // eslint-disable-line react-hooks/exhaustive-deps

  const isNoAuthConnector = selected?.authType === 'none';

  async function handleCreate() {
    if (!selected) return;
    // Auth-less connectors (Docling, HTTP) have no credentials to attach. The
    // connection itself is the enable/disable binding — same shape the
    // workflow-engine's auto-bridge uses, so the runtime/test paths can
    // short-circuit on `metadata.authType === 'none'`.
    const effectiveAuthProfileId = isNoAuthConnector
      ? `system-${selected.name}-none`
      : authProfileId;
    if (!effectiveAuthProfileId) return;
    setCreating(true);
    setError(null);
    try {
      await createConnection(projectId, {
        connectorName: selected.name,
        displayName: name,
        authProfileId: effectiveAuthProfileId,
        ...(isNoAuthConnector ? { metadata: { authType: 'none', synthetic: true } } : {}),
      });
      setStep('success');
      onCreated();
    } catch (err) {
      setError(sanitizeError(err, 'Failed to create connection'));
    } finally {
      setCreating(false);
    }
  }

  // Auth profile IDs already used by connections for the selected connector
  const excludeProfileIds = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(
      existingConnections
        .filter((c) => c.connectorName === selected.name && c.authProfileId)
        .map((c) => c.authProfileId),
    );
  }, [existingConnections, selected]);

  // Group connectors by category
  const grouped = useMemo(() => {
    const filtered = (connectors ?? []).filter(
      (c) =>
        !search ||
        c.displayName.toLowerCase().includes(search.toLowerCase()) ||
        c.name.toLowerCase().includes(search.toLowerCase()),
    );
    const groups = new Map<string, ConnectorSummary[]>();
    for (const c of filtered) {
      const cat = getConnectorCategory(c.name);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(c);
    }
    return CATEGORY_ORDER.filter((cat) => groups.has(cat)).map((cat) => ({
      category: cat,
      label: getCategoryLabel(cat),
      connectors: groups.get(cat)!,
    }));
  }, [connectors, search]);

  // Dual-auth connectors (zendesk, servicenow, shopify) may carry oauth2 metadata even when the
  // user picks a non-OAuth auth profile. Respect the selected profile's authType over the connector
  // catalog — only route through OAuth when the profile itself is oauth2_app AND is not yet active.
  // When the auth profile is already active, OAuth was completed at the auth-profile level and the
  // connection can be created directly without re-authorizing.
  const isOAuthConnector =
    !!selected?.oauth2?.authorizationUrl &&
    (selectedAuthProfile === null ||
      (selectedAuthProfile.authType === 'oauth2_app' && selectedAuthProfile.status !== 'active'));

  const oauthConnectionConfigFields = useMemo(
    () =>
      Object.entries(selected?.oauth2?.connectionConfig ?? {}).filter(
        ([, field]) => field.automated !== true,
      ),
    [selected],
  );
  const hasMissingRequiredOAuthConnectionConfig = oauthConnectionConfigFields.some(
    ([key, field]) => field.optional !== true && !(oauthConnectionConfig[key]?.trim() ?? ''),
  );

  return (
    <>
      <Dialog open={open} onClose={handleClose} maxWidth="lg">
        <AnimatePresence mode="wait">
          {step === 'pick' && (
            <motion.div
              key="pick"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              <h2 className="text-lg font-semibold text-foreground mb-4">New Connection</h2>
              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
                <input
                  type="text"
                  placeholder="Search connectors..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-lg border border-default bg-background pl-10 pr-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus"
                  autoFocus
                />
              </div>
              <div className="max-h-[60vh] overflow-y-auto space-y-5">
                {grouped.map(({ category, label, connectors: cats }) => (
                  <div key={category}>
                    <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
                      {label}
                    </h3>
                    <div className="grid grid-cols-4 gap-2">
                      {cats.map((c) => (
                        <button
                          key={c.name}
                          onClick={() => handleSelect(c)}
                          className="group flex flex-col items-center gap-1.5 rounded-lg border border-default p-3 hover:border-accent transition-colors duration-150"
                        >
                          <ConnectorLogo name={c.name} className="h-10 w-10" />
                          <span className="text-xs text-foreground text-center leading-tight">
                            {c.displayName}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {grouped.length === 0 && (
                  <p className="text-sm text-muted text-center py-8">
                    No connectors match &ldquo;{search}&rdquo;
                  </p>
                )}
              </div>
            </motion.div>
          )}

          {step === 'configure' && selected && (
            <motion.div
              key="configure"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.2 }}
            >
              <div className="flex items-center gap-2 mb-4">
                <button
                  onClick={() => setStep('pick')}
                  className="text-muted hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <h2 className="text-lg font-semibold text-foreground">
                  Connect {selected.displayName}
                </h2>
              </div>

              <div className="flex items-center gap-3 mb-6">
                <ConnectorLogo name={selected.name} className="h-12 w-12" />
                <div>
                  <p className="text-sm font-medium text-foreground">{selected.displayName}</p>
                  <p className="text-xs text-muted">
                    {selected.actions?.length ?? 0} actions, {selected.triggers?.length ?? 0}{' '}
                    triggers
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <Input
                  label="Connection name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />

                {/* OAuth connection config fields (e.g. subdomain, instance) */}
                {isOAuthConnector &&
                  oauthConnectionConfigFields.map(([key, field]) => (
                    <div key={key}>
                      <Input
                        label={
                          field.optional === true
                            ? `${getOAuthConnectionConfigLabel(key, field)} (optional)`
                            : getOAuthConnectionConfigLabel(key, field)
                        }
                        type={getOAuthConnectionConfigInputType(key, field)}
                        value={oauthConnectionConfig[key] ?? ''}
                        onChange={(e) =>
                          setOAuthConnectionConfig((prev) => ({
                            ...prev,
                            [key]: e.target.value,
                          }))
                        }
                        placeholder={
                          typeof field.example === 'string'
                            ? field.example
                            : (field.prefix ?? undefined)
                        }
                      />
                      {getOAuthConnectionConfigHint(field) && (
                        <p className="text-xs text-muted mt-1">
                          {getOAuthConnectionConfigHint(field)}
                        </p>
                      )}
                    </div>
                  ))}

                {/* Auth Profile Picker — hidden for auth-less connectors (Docling, HTTP).
                    For those, the connection itself is the enable/disable binding;
                    selecting credentials would be meaningless. */}
                {isNoAuthConnector ? (
                  <div className="rounded-md border border-default bg-background-muted p-3">
                    <p className="text-sm text-foreground">No authentication required</p>
                    <p className="mt-1 text-xs text-muted">
                      {selected.displayName} runs against an internal service. Creating this
                      connection enables it for this project; disconnecting disables it.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-foreground">
                      Auth Profile
                    </label>
                    <AuthProfilePicker
                      projectId={projectId}
                      value={authProfileId}
                      onChange={setAuthProfileId}
                      consumerKind="raw_connection"
                      connectorName={selected.name}
                      filterAuthTypes={compatibleAuthTypes}
                      excludeProfileIds={excludeProfileIds}
                      placeholder="Select an auth profile..."
                    />
                    <p className="mt-1 text-xs text-muted">
                      Selecting an auth profile attaches it to this raw connection. Some auth types,
                      such as AWS IAM signing and mTLS transport auth, still require a downstream
                      consumer that explicitly honors them.
                    </p>
                    {excludeProfileIds.size > 0 && (
                      <p className="text-xs text-muted mt-1">
                        Auth profiles already used by other {selected.displayName} connections are
                        hidden.
                      </p>
                    )}
                  </div>
                )}

                {/* Action button */}
                {isOAuthConnector ? (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setOauthConnector({
                        name: selected.name,
                        authorizationUrl: selected.oauth2!.authorizationUrl,
                        displayName: name,
                        connectionConfig: Object.fromEntries(
                          Object.entries(oauthConnectionConfig).filter(
                            ([, value]) => value.trim().length > 0,
                          ),
                        ),
                      });
                    }}
                    disabled={
                      !authProfileId || hasMissingRequiredOAuthConnectionConfig || !name.trim()
                    }
                    className="w-full"
                  >
                    Create Connection
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={handleCreate}
                    loading={creating}
                    disabled={(!isNoAuthConnector && !authProfileId) || !name.trim()}
                    className="w-full"
                  >
                    Create Connection
                  </Button>
                )}

                {error && <p className="text-sm text-error">{error}</p>}
              </div>

              {/* Preview */}
              {(selected.actions?.length ?? 0) > 0 && (
                <div className="mt-6 border-t border-default pt-4">
                  <h4 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
                    What you&apos;ll get
                  </h4>
                  <p className="text-xs text-muted">
                    Actions:{' '}
                    {selected.actions
                      ?.slice(0, 3)
                      .map((a) => a.displayName)
                      .join(', ')}
                    {(selected.actions?.length ?? 0) > 3 &&
                      `, +${(selected.actions?.length ?? 0) - 3} more`}
                  </p>
                  {(selected.triggers?.length ?? 0) > 0 && (
                    <p className="text-xs text-muted mt-1">
                      Triggers:{' '}
                      {selected.triggers
                        ?.slice(0, 3)
                        .map((t) => t.displayName)
                        .join(', ')}
                      {(selected.triggers?.length ?? 0) > 3 &&
                        `, +${(selected.triggers?.length ?? 0) - 3} more`}
                    </p>
                  )}
                </div>
              )}
            </motion.div>
          )}

          {step === 'success' && (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center py-8"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{
                  delay: 0.1,
                  type: 'spring',
                  stiffness: 200,
                  damping: 15,
                }}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-success-subtle"
              >
                <Check className="h-6 w-6 text-success" />
              </motion.div>
              <p className="mt-4 text-base font-medium text-foreground">
                {selected?.displayName} connected
              </p>
              <p className="mt-1 text-sm text-muted">Connection verified</p>
              <Button variant="primary" size="sm" onClick={handleClose} className="mt-6">
                Done
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </Dialog>

      {oauthConnector && (
        <OAuthFlowDialog
          open
          connector={oauthConnector}
          projectId={projectId}
          authProfileId={authProfileId}
          onSuccess={async () => {
            setOauthConnector(null);
            // After OAuth completes, create the connection binding
            if (selected && authProfileId) {
              try {
                await createConnection(projectId, {
                  connectorName: selected.name,
                  displayName: name,
                  authProfileId,
                });
                setStep('success');
                onCreated();
              } catch (err) {
                setError(sanitizeError(err, 'OAuth succeeded but failed to create connection'));
              }
            }
          }}
          onClose={() => setOauthConnector(null)}
        />
      )}
    </>
  );
}
