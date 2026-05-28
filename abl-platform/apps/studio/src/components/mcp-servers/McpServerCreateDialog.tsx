/**
 * McpServerCreateDialog Component
 *
 * Modal dialog for registering (or editing) an MCP server.
 * Grouped into Connection, Authentication, and Environment sections.
 */

import { useState, useMemo, useReducer, useCallback } from 'react';
import { clsx } from 'clsx';
import { Loader2, Plus, Trash2, Lock, ChevronRight, Server } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { useMcpServerStore, type McpServer } from '../../store/mcp-server-store';
import { useProjectStore } from '../../store/project-store';
import {
  createMcpServer,
  updateMcpServer,
  type McpTransportType,
  type McpAuthType,
} from '../../api/mcp-servers';
import { sanitizeError } from '../../lib/sanitize-error';
import { AuthProfilePicker } from '../auth-profiles/AuthProfilePicker';
import { AuthProfileToggle } from '../auth-profiles/AuthProfileToggle';

// ─── Types ────────────────────────────────────────────────────────────────────

interface McpServerCreateDialogProps {
  onClose: () => void;
  onCreated: (server: McpServer) => void;
  editServer?: McpServer;
}

interface KeyValuePair {
  key: string;
  value: string;
}

interface FormState {
  name: string;
  transport: McpTransportType;
  url: string;
  authType: McpAuthType;
  authToken: string;
  authHeaderName: string;
  authHeaderValue: string;
  authCustomHeaders: KeyValuePair[];
  oauthClientId: string;
  oauthClientSecret: string;
  oauthTokenEndpoint: string;
  oauthScope: string;
  envPairs: Array<KeyValuePair & { existing?: boolean }>;
  replacingAuth: boolean;
  replacingEnv: boolean;
  useAuthProfile: boolean;
  authProfileId: string | null;
}

type FormAction =
  | { type: 'SET_FIELD'; field: keyof FormState; value: unknown }
  | { type: 'SET_AUTH_TYPE'; value: McpAuthType }
  | { type: 'ADD_ENV' }
  | { type: 'REMOVE_ENV'; index: number }
  | { type: 'UPDATE_ENV'; index: number; field: 'key' | 'value'; value: string }
  | { type: 'ADD_CUSTOM_HEADER' }
  | { type: 'REMOVE_CUSTOM_HEADER'; index: number }
  | { type: 'UPDATE_CUSTOM_HEADER'; index: number; field: 'key' | 'value'; value: string }
  | { type: 'START_REPLACING_AUTH' }
  | { type: 'START_REPLACING_ENV' }
  | { type: 'TOGGLE_AUTH_PROFILE' }
  | { type: 'SET_AUTH_PROFILE_ID'; value: string | null };

function resetInlineAuthFields(state: FormState): FormState {
  return {
    ...state,
    authToken: '',
    authHeaderName: 'X-API-Key',
    authHeaderValue: '',
    authCustomHeaders: [],
    oauthClientId: '',
    oauthClientSecret: '',
    oauthTokenEndpoint: '',
    oauthScope: '',
  };
}

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value };
    case 'SET_AUTH_TYPE':
      if (state.authType === action.value) return state;
      return {
        ...resetInlineAuthFields(state),
        authType: action.value,
      };
    case 'ADD_ENV':
      return { ...state, envPairs: [...state.envPairs, { key: '', value: '' }] };
    case 'REMOVE_ENV':
      return { ...state, envPairs: state.envPairs.filter((_, i) => i !== action.index) };
    case 'UPDATE_ENV': {
      const envPairs = [...state.envPairs];
      envPairs[action.index] = {
        ...envPairs[action.index],
        [action.field]: action.value,
        existing: false,
      };
      return { ...state, envPairs };
    }
    case 'ADD_CUSTOM_HEADER':
      return { ...state, authCustomHeaders: [...state.authCustomHeaders, { key: '', value: '' }] };
    case 'REMOVE_CUSTOM_HEADER':
      return {
        ...state,
        authCustomHeaders: state.authCustomHeaders.filter((_, i) => i !== action.index),
      };
    case 'UPDATE_CUSTOM_HEADER': {
      const headers = [...state.authCustomHeaders];
      headers[action.index] = { ...headers[action.index], [action.field]: action.value };
      return { ...state, authCustomHeaders: headers };
    }
    case 'START_REPLACING_AUTH':
      return { ...state, replacingAuth: true };
    case 'START_REPLACING_ENV':
      return { ...state, replacingEnv: true, envPairs: [] };
    case 'TOGGLE_AUTH_PROFILE':
      if (!state.useAuthProfile) {
        return {
          ...resetInlineAuthFields(state),
          useAuthProfile: true,
          authProfileId: null,
          authType: 'none',
          replacingAuth: true,
        };
      }
      return {
        ...state,
        useAuthProfile: false,
        authProfileId: null,
        replacingAuth: true,
      };
    case 'SET_AUTH_PROFILE_ID':
      if (!action.value) {
        return { ...state, authProfileId: null };
      }
      return {
        ...resetInlineAuthFields(state),
        authProfileId: action.value,
        useAuthProfile: true,
        authType: 'none',
        replacingAuth: true,
      };
    default:
      return state;
  }
}

function createInitialState(editServer?: McpServer): FormState {
  return {
    name: editServer?.name || '',
    transport: editServer?.transport || 'sse',
    url: editServer?.url || '',
    authType: editServer?.authType || 'none',
    authToken: '',
    authHeaderName: 'X-API-Key',
    authHeaderValue: '',
    authCustomHeaders: [],
    oauthClientId: '',
    oauthClientSecret: '',
    oauthTokenEndpoint: '',
    oauthScope: '',
    envPairs: [],
    replacingAuth: false,
    replacingEnv: false,
    useAuthProfile:
      typeof editServer?.authProfileId === 'string' && editServer.authProfileId.length > 0,
    authProfileId:
      typeof editServer?.authProfileId === 'string' && editServer.authProfileId.length > 0
        ? editServer.authProfileId
        : null,
  };
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function FormSection({
  title,
  icon,
  hint,
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  hint?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  if (collapsible) {
    return (
      <details className="group" open={defaultOpen || undefined}>
        <summary className="flex items-center gap-2 cursor-pointer select-none py-1.5">
          <ChevronRight className="w-3.5 h-3.5 text-muted transition-transform group-open:rotate-90" />
          {icon}
          <span className="text-sm font-medium text-foreground">{title}</span>
          {hint && <span className="text-xs text-muted ml-auto">{hint}</span>}
        </summary>
        <div className="mt-4 space-y-4 pl-6">{children}</div>
      </details>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <span className="text-sm font-medium text-foreground">{title}</span>
        {hint && <span className="text-xs text-muted ml-auto">{hint}</span>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

// ─── Encrypted banner (for edit mode) ─────────────────────────────────────────

function EncryptedBanner({
  label,
  onReplace,
  replaceLabel,
}: {
  label: string;
  onReplace: () => void;
  replaceLabel: string;
}) {
  return (
    <div className="flex items-center justify-between p-2.5 rounded-lg bg-background-muted border border-default">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Lock className="w-3.5 h-3.5" />
        <span>{label}</span>
      </div>
      <button
        type="button"
        onClick={onReplace}
        className="text-xs text-accent hover:text-accent/80 font-medium transition-default"
      >
        {replaceLabel}
      </button>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function McpServerCreateDialog({
  onClose,
  onCreated,
  editServer,
}: McpServerCreateDialogProps) {
  const t = useTranslations('mcp.create_dialog');
  const { currentProject } = useProjectStore();
  const { addServer, updateServerInList } = useMcpServerStore();
  const projectId = currentProject?.id;

  const [form, dispatch] = useReducer(formReducer, editServer, createInitialState);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const TRANSPORT_OPTIONS = useMemo(
    () => [
      { value: 'sse', label: t('transport_sse') },
      { value: 'http', label: t('transport_http') },
    ],
    [t],
  );

  const AUTH_TYPE_OPTIONS = useMemo(
    () => [
      { value: 'none', label: t('auth_none') },
      { value: 'bearer', label: t('auth_bearer') },
      { value: 'api_key', label: t('auth_api_key') },
      { value: 'custom_headers', label: t('auth_custom_headers') },
      { value: 'oauth2_client_credentials', label: t('auth_oauth2') },
    ],
    [t],
  );

  // ─── Validation ───────────────────────────────────────────────────────

  const nameError = (() => {
    if (form.name.length === 0) return undefined;
    if (!form.name.trim()) return t('name_error');
    if (form.name.trim().length < 2) return t('name_min_length');
    return undefined;
  })();

  const urlError = (() => {
    if (form.url.length === 0) return undefined;
    if (!form.url.trim()) return t('url_error');
    const trimmed = form.url.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))
      return t('url_protocol_error');
    return undefined;
  })();

  const isValid = useCallback(() => {
    if (!form.name.trim() || form.name.trim().length < 2) return false;
    if (!form.url.trim()) return false;
    const trimmed = form.url.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;
    if (form.useAuthProfile && (!form.authProfileId || form.authProfileId.trim().length === 0))
      return false;
    return true;
  }, [form.authProfileId, form.name, form.url, form.useAuthProfile]);

  // ─── Submit ───────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!projectId || !isValid()) return;

    setSaving(true);
    setError(null);

    try {
      // Build env payload
      let envPayload: Record<string, string> | undefined;
      if (!editServer || form.replacingEnv) {
        const env: Record<string, string> = {};
        for (const pair of form.envPairs) {
          if (pair.key.trim() && !pair.existing) {
            env[pair.key.trim()] = pair.value;
          }
        }
        envPayload = Object.keys(env).length > 0 ? env : undefined;
      }

      const existingAuthProfileId =
        typeof editServer?.authProfileId === 'string' && editServer.authProfileId.trim().length > 0
          ? editServer.authProfileId.trim()
          : null;
      const selectedAuthProfileId =
        form.useAuthProfile && typeof form.authProfileId === 'string'
          ? form.authProfileId.trim() || null
          : null;

      // Build auth payload
      let authPayload: { authType?: McpAuthType; authConfig?: Record<string, unknown> } = {};
      if (form.useAuthProfile) {
        const shouldResetInlineAuth =
          !editServer || form.replacingAuth || (editServer.authType || 'none') !== 'none';
        if (shouldResetInlineAuth) {
          authPayload.authType = 'none';
        }
      } else if (!editServer || form.replacingAuth) {
        if (form.authType !== 'none') {
          authPayload.authType = form.authType;
          switch (form.authType) {
            case 'bearer':
              authPayload.authConfig = { token: form.authToken };
              break;
            case 'api_key':
              authPayload.authConfig = {
                headerName: form.authHeaderName,
                value: form.authHeaderValue,
              };
              break;
            case 'custom_headers':
              authPayload.authConfig = {
                headers: Object.fromEntries(
                  form.authCustomHeaders
                    .filter((h) => h.key.trim())
                    .map((h) => [h.key.trim(), h.value]),
                ),
              };
              break;
            case 'oauth2_client_credentials':
              authPayload.authConfig = {
                clientId: form.oauthClientId,
                clientSecret: form.oauthClientSecret,
                tokenEndpoint: form.oauthTokenEndpoint,
                ...(form.oauthScope ? { scope: form.oauthScope } : {}),
              };
              break;
          }
        } else if (editServer) {
          authPayload.authType = 'none';
        }
      }

      const authProfilePatch: { authProfileId?: string | null } = {};
      if (form.useAuthProfile) {
        authProfilePatch.authProfileId = selectedAuthProfileId;
      } else if (editServer && existingAuthProfileId) {
        authProfilePatch.authProfileId = null;
      }

      const payload = {
        name: form.name.trim(),
        transport: form.transport,
        url: form.url.trim(),
        env: envPayload,
        ...authPayload,
        ...authProfilePatch,
      };

      if (editServer) {
        const result = await updateMcpServer(projectId, editServer.id, payload);
        updateServerInList(editServer.id, result.server);
        onCreated(result.server);
      } else {
        const result = await createMcpServer(projectId, payload);
        addServer(result.server);
        onCreated(result.server);
      }
    } catch (err: unknown) {
      const msg = sanitizeError(err, '');
      if (msg.includes('409') || msg.includes('already exists')) {
        setError(t('error_duplicate'));
      } else {
        setError(sanitizeError(err, t('save_error')));
      }
    } finally {
      setSaving(false);
    }
  };

  // ─── Auth sub-forms ───────────────────────────────────────────────────

  const renderAuthFields = () => {
    switch (form.authType) {
      case 'bearer':
        return (
          <Input
            label={t('token_label')}
            type="password"
            placeholder={t('token_placeholder')}
            value={form.authToken}
            onChange={(e) =>
              dispatch({ type: 'SET_FIELD', field: 'authToken', value: e.target.value })
            }
          />
        );
      case 'api_key':
        return (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('header_name_label')}
              placeholder="X-API-Key"
              value={form.authHeaderName}
              onChange={(e) =>
                dispatch({ type: 'SET_FIELD', field: 'authHeaderName', value: e.target.value })
              }
            />
            <Input
              label={t('header_value_label')}
              type="password"
              placeholder={t('api_key_placeholder')}
              value={form.authHeaderValue}
              onChange={(e) =>
                dispatch({ type: 'SET_FIELD', field: 'authHeaderValue', value: e.target.value })
              }
            />
          </div>
        );
      case 'custom_headers':
        return (
          <div className="space-y-3">
            {form.authCustomHeaders.map((h, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-2 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                  placeholder="Header-Name"
                  value={h.key}
                  onChange={(e) =>
                    dispatch({
                      type: 'UPDATE_CUSTOM_HEADER',
                      index: i,
                      field: 'key',
                      value: e.target.value,
                    })
                  }
                />
                <input
                  type="password"
                  className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-2 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                  placeholder="value"
                  value={h.value}
                  onChange={(e) =>
                    dispatch({
                      type: 'UPDATE_CUSTOM_HEADER',
                      index: i,
                      field: 'value',
                      value: e.target.value,
                    })
                  }
                />
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'REMOVE_CUSTOM_HEADER', index: i })}
                  className="p-1.5 rounded-md border border-default text-muted hover:text-error hover:border-error/30 transition-default"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => dispatch({ type: 'ADD_CUSTOM_HEADER' })}
              className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 font-medium transition-default"
            >
              <Plus className="w-3.5 h-3.5" /> {t('add_header')}
            </button>
          </div>
        );
      case 'oauth2_client_credentials':
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input
                label={t('client_id_label')}
                placeholder={t('client_id_placeholder')}
                value={form.oauthClientId}
                onChange={(e) =>
                  dispatch({ type: 'SET_FIELD', field: 'oauthClientId', value: e.target.value })
                }
              />
              <Input
                label={t('client_secret_label')}
                type="password"
                placeholder={t('client_secret_placeholder')}
                value={form.oauthClientSecret}
                onChange={(e) =>
                  dispatch({ type: 'SET_FIELD', field: 'oauthClientSecret', value: e.target.value })
                }
              />
            </div>
            <Input
              label={t('token_endpoint_label')}
              placeholder={t('token_endpoint_placeholder')}
              value={form.oauthTokenEndpoint}
              onChange={(e) =>
                dispatch({ type: 'SET_FIELD', field: 'oauthTokenEndpoint', value: e.target.value })
              }
            />
            <Input
              label={t('scope_label')}
              placeholder={t('scope_placeholder')}
              value={form.oauthScope}
              onChange={(e) =>
                dispatch({ type: 'SET_FIELD', field: 'oauthScope', value: e.target.value })
              }
            />
          </div>
        );
      default:
        return null;
    }
  };

  const authConfiguredLabels: Record<string, string> = {
    bearer: t('auth_bearer_configured'),
    api_key: t('auth_api_key_configured'),
    custom_headers: t('auth_custom_configured'),
    oauth2_client_credentials: t('auth_oauth2_configured'),
  };
  const authConfiguredLabel = editServer ? authConfiguredLabels[editServer.authType] || null : null;

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <Dialog
      open
      onClose={onClose}
      title={editServer ? t('title_edit') : t('title_create')}
      description={editServer ? undefined : t('dialog_description')}
      maxWidth="2xl"
    >
      <div className="space-y-6">
        {error && (
          <div className="p-3 rounded-lg bg-error-subtle border border-error/20 text-sm text-error">
            {error}
          </div>
        )}

        {/* ── Auth Profile ──────────────────────────────────────────── */}
        <FormSection
          title={t('section_auth_profile')}
          icon={<Server className="w-4 h-4 text-muted" />}
        >
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
            <Input
              label={t('name_label')}
              placeholder={t('name_placeholder')}
              value={form.name}
              onChange={(e) =>
                dispatch({ type: 'SET_FIELD', field: 'name', value: e.target.value })
              }
              error={nameError}
              disabled={!!editServer}
            />
            <Select
              label={t('transport_label')}
              options={TRANSPORT_OPTIONS}
              value={form.transport}
              onChange={(v) => dispatch({ type: 'SET_FIELD', field: 'transport', value: v })}
            />
          </div>
          <Input
            label={t('url_label')}
            placeholder={
              form.transport === 'sse' ? t('url_placeholder_sse') : t('url_placeholder_http')
            }
            value={form.url}
            onChange={(e) => dispatch({ type: 'SET_FIELD', field: 'url', value: e.target.value })}
            error={urlError}
          />
        </FormSection>

        <hr className="border-default" />

        {/* ── Authentication ────────────────────────────────────────── */}
        <FormSection
          title={t('auth_label')}
          icon={<Lock className="w-4 h-4 text-muted" />}
          hint={t('auth_encrypted_hint')}
          collapsible
          defaultOpen={editServer ? editServer.authType !== 'none' : false}
        >
          {editServer && editServer.authType !== 'none' && !form.replacingAuth ? (
            <EncryptedBanner
              label={authConfiguredLabel || ''}
              onReplace={() => {
                dispatch({ type: 'START_REPLACING_AUTH' });
                dispatch({ type: 'SET_AUTH_TYPE', value: editServer.authType });
              }}
              replaceLabel={t('replace')}
            />
          ) : (
            <div className="space-y-3">
              {/* Auth Profile toggle */}
              <AuthProfileToggle
                enabled={form.useAuthProfile}
                label={t('use_auth_profile')}
                onToggle={() => dispatch({ type: 'TOGGLE_AUTH_PROFILE' })}
              />
              {form.useAuthProfile ? (
                <AuthProfilePicker
                  projectId={projectId!}
                  value={form.authProfileId}
                  onChange={(id) => dispatch({ type: 'SET_AUTH_PROFILE_ID', value: id })}
                  filterAuthTypes={[
                    'api_key',
                    'bearer',
                    'basic',
                    'custom_header',
                    'oauth2_app',
                    'oauth2_token',
                    'oauth2_client_credentials',
                    'azure_ad',
                    'mtls',
                    'kerberos',
                    'saml',
                  ]}
                  // ABLP-913 §8: MCP servers may only reference Custom auth profiles.
                  filterProfileType="custom"
                  placeholder={t('auth_profile_placeholder')}
                />
              ) : (
                <>
                  <Select
                    options={AUTH_TYPE_OPTIONS}
                    value={form.authType}
                    onChange={(v) => dispatch({ type: 'SET_AUTH_TYPE', value: v as McpAuthType })}
                  />
                  {renderAuthFields()}
                </>
              )}
            </div>
          )}
        </FormSection>

        {/* ── Environment Variables ─────────────────────────────────── */}
        <FormSection
          title={t('env_label')}
          icon={<Lock className="w-4 h-4 text-muted" />}
          hint={t('env_encrypted_hint')}
          collapsible
          defaultOpen={false}
        >
          {editServer && !form.replacingEnv ? (
            <EncryptedBanner
              label={t('env_configured')}
              onReplace={() => dispatch({ type: 'START_REPLACING_ENV' })}
              replaceLabel={t('replace_all')}
            />
          ) : (
            <div className="space-y-3">
              {form.envPairs.length === 0 && <p className="text-xs text-muted">{t('env_empty')}</p>}
              {form.envPairs.map((pair, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-2 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                    placeholder={t('env_key_placeholder')}
                    value={pair.key}
                    onChange={(e) =>
                      dispatch({
                        type: 'UPDATE_ENV',
                        index: i,
                        field: 'key',
                        value: e.target.value,
                      })
                    }
                    disabled={pair.existing}
                  />
                  <input
                    type="password"
                    className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-2 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                    placeholder={t('env_value_placeholder')}
                    value={pair.value}
                    onChange={(e) =>
                      dispatch({
                        type: 'UPDATE_ENV',
                        index: i,
                        field: 'value',
                        value: e.target.value,
                      })
                    }
                  />
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'REMOVE_ENV', index: i })}
                    className="p-1.5 rounded-md border border-default text-muted hover:text-error hover:border-error/30 transition-default"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => dispatch({ type: 'ADD_ENV' })}
                className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 font-medium transition-default"
              >
                <Plus className="w-3.5 h-3.5" /> {t('env_add')}
              </button>
            </div>
          )}
        </FormSection>

        {/* ── Footer ───────────────────────────────────────────────── */}
        <div className="flex justify-end gap-3 pt-4 border-t border-default">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!isValid() || saving}
            loading={saving}
            icon={saving ? <Loader2 className="w-4 h-4 animate-spin" /> : undefined}
          >
            {editServer ? t('save_changes') : t('register_server')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
