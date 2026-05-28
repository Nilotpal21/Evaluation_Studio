/**
 * AuthProfileSlideOver — Create/Edit Auth Profile
 *
 * Uses Framer Motion slide-over pattern (VersionsSlideOver style).
 * Step 1 (create only): Type selector organized by category.
 * Step 2: Dynamic form driven by auth-type-metadata field definitions.
 */

'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  X,
  ArrowLeft,
  KeyRound,
  Shield,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Eye,
  EyeOff,
  Copy,
  Check,
  ShieldCheck,
  Plus,
  Trash2,
  Search,
  ChevronDown as ChevronDownIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { springs, transitions } from '../../lib/animation';
import { OVERLAY_BACKDROP } from '@agent-platform/design-tokens';
import { useAuthProfile } from '../../hooks/useAuthProfiles';
import {
  createAuthProfile,
  updateAuthProfile,
  validateAuthProfile,
  createWorkspaceAuthProfile,
  updateWorkspaceAuthProfile,
  validateWorkspaceAuthProfile,
  fetchWorkspaceAuthProfile,
} from '../../api/auth-profiles';
import type { AuthProfileUsageMode, AuthType, IntegrationProvider } from '../../api/auth-profiles';
import { ConnectorLogo } from '../connections/ConnectorLogo';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import { Badge } from '../ui/Badge';
import { sanitizeError } from '../../lib/sanitize-error';
import { getAllowedConfigKeys } from '@agent-platform/shared/validation';
import {
  resolveConnectionConfigTemplate,
  extractConnectionConfigFields,
} from '../../lib/connection-config-utils';
import {
  AUTH_PROFILE_USAGE_MODE_OPTIONS,
  AUTH_TYPE_METADATA,
  AUTH_TYPE_CATEGORIES,
  AUTH_TYPE_USAGE_MODES,
  SUPPORTED_AUTH_TYPES,
  getDefaultUsageMode,
  getAuthTypeShortLabel,
  type FormFieldDef,
} from './auth-type-metadata';
import { AuthProfileStatusBadge } from './AuthProfileStatusBadge';
import { AuthProfileAuthorizationBadge } from './AuthProfileAuthorizationBadge';
import { AuthProfileOAuthDialog } from './AuthProfileOAuthDialog';
import { RevokeProfileConfirm } from './RevokeProfileConfirm';
import { RevokeUserTokensConfirm } from './RevokeUserTokensConfirm';
import { ActivityTabPanel } from './ActivityTabPanel';
import { showSensitiveFieldAdvisory } from './SensitiveFieldChangeAdvisory';
import { Tabs } from '../ui/Tabs';

// =============================================================================
// CONSTANTS
// =============================================================================

const PANEL_WIDTH = 'w-[520px]';

// ENVIRONMENT_OPTIONS are computed inside the component to support i18n

// =============================================================================
// PROPS
// =============================================================================

export interface PreselectedConnector {
  connectorName: string;
  displayName: string;
  availableAuthTypes: string[];
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    defaultScopes: string[];
    pkce: boolean;
    scopeSeparator?: string;
    authorizationParams?: Record<string, string>;
    tokenParams?: Record<string, string>;
    connectionConfigFields?: string[];
  };
  /** Nango connection_config metadata — field definitions for API_KEY/custom providers */
  connectionConfig?: Record<
    string,
    {
      type: string;
      title?: string;
      description?: string;
      pattern?: string;
      example?: string;
      default?: string | number | boolean;
    }
  >;
  /** Pre-filled API key configuration from Nango proxy headers */
  apiKeyConfig?: {
    headerName: string;
    prefix?: string;
    additionalHeaders?: Array<{
      headerName: string;
      fieldKey: string;
      fieldMeta: {
        type: string;
        title?: string;
        description?: string;
        pattern?: string;
        example?: string;
        default?: string | number | boolean;
      };
      defaultValue?: string;
    }>;
  };
  /**
   * Per-auth-type config pre-fill from CONNECTOR_AUTH_PREFILL. When the user
   * picks a specific auth type for this connector, the matching entry's keys
   * are merged into the config form (e.g. AWS S3 → { service: 's3' }, Azure
   * Outlook → { endpoint, resource }). Keys not in the auth type's
   * configFields are ignored by the form renderer.
   */
  authPrefill?: Partial<Record<AuthType, Record<string, unknown>>>;
}

interface AuthProfileSlideOverProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  projectId: string;
  editProfileId: string | null;
  /** Pre-select auth type when opening from connector setup */
  preselectedAuthType?: AuthType;
  /** Pre-fill from integration provider (Nango) data */
  preselectedConnector?: PreselectedConnector;
  /**
   * Connector catalog. When provided in a create flow (no edit, no preselected
   * connector), the slide-over starts at a connector-picker step so the user
   * can choose an integration in the same panel.
   */
  providers?: IntegrationProvider[];
}

function getFieldDefaults(fields: FormFieldDef[]): {
  config: Record<string, unknown>;
  profile: Record<string, unknown>;
} {
  const defaults: {
    config: Record<string, unknown>;
    profile: Record<string, unknown>;
  } = {
    config: {},
    profile: {},
  };

  for (const field of fields) {
    if (field.defaultValue === undefined) {
      continue;
    }

    if (field.target === 'profile') {
      defaults.profile[field.key] = field.defaultValue;
      continue;
    }

    defaults.config[field.key] = field.defaultValue;
  }

  return defaults;
}

function normalizeConfigForEditor(
  type: AuthType,
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (type === 'oauth2_token') {
    const normalized = { ...value };
    delete normalized.linkedAppProfileId;
    return normalized;
  }

  if (type !== 'oauth2_app') {
    return { ...value };
  }

  const normalized = { ...value };
  const defaultScopes = Array.isArray(normalized.defaultScopes)
    ? normalized.defaultScopes
    : undefined;
  const legacyScopes = Array.isArray(normalized.scopes) ? normalized.scopes : undefined;

  delete normalized.scopes;

  if (defaultScopes !== undefined) {
    return normalized;
  }

  if (legacyScopes !== undefined) {
    return {
      ...normalized,
      defaultScopes: legacyScopes,
    };
  }

  return normalized;
}

function normalizeProfileFieldsForEditor(
  type: AuthType,
  value:
    | {
        linkedAppProfileId?: string | null;
      }
    | null
    | undefined,
): Record<string, unknown> {
  if (
    type !== 'oauth2_token' ||
    typeof value?.linkedAppProfileId !== 'string' ||
    value.linkedAppProfileId.length === 0
  ) {
    return {};
  }

  return {
    linkedAppProfileId: value.linkedAppProfileId,
  };
}

/** Render a Record<string,string> as a multiline `key: value` block for textarea editing. */
function recordToMultiline(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entryValue]) => `${key}: ${String(entryValue ?? '')}`)
    .join('\n');
}

/** Parse the multiline `key: value` (or `key=value`) textarea back into a Record. */
function parseRecordInput(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const sepColon = line.indexOf(':');
    const sepEq = line.indexOf('=');
    const separatorIndex =
      sepColon >= 0 && (sepEq < 0 || sepColon < sepEq) ? sepColon : sepEq >= 0 ? sepEq : -1;
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const val = line.slice(separatorIndex + 1).trim();
    if (key) {
      result[key] = val;
    }
  }
  return result;
}

/** Key/value row editor for record-typed config fields (e.g. oauth2_app authorizationParams). */
interface RecordEditorProps {
  label: string;
  value: unknown;
  helpText?: string;
  disabled?: boolean;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  fieldError?: string;
}
function RecordEditor({
  label,
  value,
  helpText,
  disabled,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  fieldError,
}: RecordEditorProps) {
  // Per-row IDs must NOT include the typed key — otherwise every keystroke mints a new ID,
  // React unmounts/remounts the input, and the user loses focus. Stable counter-based IDs only.
  const idCounter = useRef(0);
  const buildRowsFromValue = useCallback((v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return [] as Array<{ id: string; key: string; value: string }>;
    }
    return Object.entries(v as Record<string, unknown>).map(([k, val]) => ({
      id: `row-${idCounter.current++}`,
      key: k,
      value: typeof val === 'string' ? val : String(val ?? ''),
    }));
  }, []);

  const [rows, setRows] = useState(() => buildRowsFromValue(value));
  // Tracks the last record we ourselves persisted; lets us distinguish external resyncs
  // (e.g. opening an existing profile in edit mode) from our own writes.
  const lastPersistedRef = useRef<string>(JSON.stringify(value ?? {}));

  useEffect(() => {
    const incoming = JSON.stringify(value ?? {});
    if (incoming !== lastPersistedRef.current) {
      lastPersistedRef.current = incoming;
      setRows(buildRowsFromValue(value));
    }
  }, [value, buildRowsFromValue]);

  const persist = useCallback(
    (nextRows: Array<{ id: string; key: string; value: string }>) => {
      const record: Record<string, string> = {};
      for (const r of nextRows) {
        const k = r.key.trim();
        if (k) record[k] = r.value;
      }
      lastPersistedRef.current = JSON.stringify(record);
      onChange(record);
    },
    [onChange],
  );

  const update = (id: string, patch: Partial<{ key: string; value: string }>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setRows(next);
    persist(next);
  };
  const add = () => {
    setRows((prev) => [...prev, { id: `row-${idCounter.current++}`, key: '', value: '' }]);
    // Don't persist empty rows — empty keys are filtered out anyway.
  };
  const remove = (id: string) => {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    persist(next);
  };

  const inputClass = clsx(
    'w-full min-w-0 rounded-lg border bg-background-subtle text-foreground placeholder:text-subtle',
    'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
    'text-sm py-2 px-3 font-mono border-default',
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="block text-sm font-medium text-foreground">{label}</label>
        <Button
          variant="ghost"
          size="xs"
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={add}
          disabled={disabled}
        >
          Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">No entries. Click Add to create one.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="flex items-stretch gap-2">
              <input
                type="text"
                value={row.key}
                onChange={(e) => update(row.id, { key: e.target.value })}
                placeholder={keyPlaceholder}
                disabled={disabled}
                className={clsx(inputClass, 'flex-1 min-w-0')}
              />
              <input
                type="text"
                value={row.value}
                onChange={(e) => update(row.id, { value: e.target.value })}
                placeholder={valuePlaceholder}
                disabled={disabled}
                className={clsx(inputClass, 'flex-1 min-w-0')}
              />
              <Button
                variant="ghost"
                size="xs"
                icon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={() => remove(row.id)}
                disabled={disabled}
                aria-label="Remove row"
              />
            </div>
          ))}
        </div>
      )}
      {fieldError && <p className="text-xs text-error">{fieldError}</p>}
      {helpText && !fieldError && <p className="text-xs text-muted">{helpText}</p>}
    </div>
  );
}

/**
 * Unified editor for `custom_header` auth type. Combines `config.headers` (name → label) and
 * `secrets.headerValues` (name → value) into a single rows view so the user only enters each header
 * once. Always keeps the two records in sync.
 */
interface CustomHeaderEditorProps {
  headerNames: unknown;
  headerValues: unknown;
  helpText?: string;
  disabled?: boolean;
  onChange: (next: {
    headers: Record<string, string>;
    headerValues: Record<string, string>;
  }) => void;
  fieldError?: string;
}
function CustomHeaderEditor({
  headerNames,
  headerValues,
  helpText,
  disabled,
  onChange,
  fieldError,
}: CustomHeaderEditorProps) {
  // Stable row IDs that do NOT include the typed name — focus stays put while typing.
  const idCounter = useRef(0);
  const buildRowsFromValue = useCallback((names: unknown, values: unknown) => {
    const n =
      names && typeof names === 'object' && !Array.isArray(names)
        ? (names as Record<string, unknown>)
        : {};
    const v =
      values && typeof values === 'object' && !Array.isArray(values)
        ? (values as Record<string, unknown>)
        : {};
    const keys = Array.from(new Set([...Object.keys(n), ...Object.keys(v)]));
    return keys.map((k) => ({
      id: `hdr-${idCounter.current++}`,
      name: k,
      value: typeof v[k] === 'string' ? (v[k] as string) : '',
    }));
  }, []);

  const [rows, setRows] = useState(() => buildRowsFromValue(headerNames, headerValues));
  // Track what we last persisted so we can ignore the round-trip back through props.
  const lastPersistedRef = useRef<string>(
    JSON.stringify({ headers: headerNames ?? {}, headerValues: headerValues ?? {} }),
  );

  useEffect(() => {
    const incoming = JSON.stringify({
      headers: headerNames ?? {},
      headerValues: headerValues ?? {},
    });
    if (incoming !== lastPersistedRef.current) {
      lastPersistedRef.current = incoming;
      setRows(buildRowsFromValue(headerNames, headerValues));
    }
  }, [headerNames, headerValues, buildRowsFromValue]);

  const persist = useCallback(
    (nextRows: Array<{ id: string; name: string; value: string }>) => {
      const headers: Record<string, string> = {};
      const values: Record<string, string> = {};
      for (const r of nextRows) {
        const n = r.name.trim();
        if (n) {
          headers[n] = n;
          values[n] = r.value;
        }
      }
      lastPersistedRef.current = JSON.stringify({ headers, headerValues: values });
      onChange({ headers, headerValues: values });
    },
    [onChange],
  );

  const update = (id: string, patch: Partial<{ name: string; value: string }>) => {
    setRows((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, ...patch } : r));
      persist(next);
      return next;
    });
  };
  const add = () => {
    setRows((prev) => [...prev, { id: `hdr-${idCounter.current++}`, name: '', value: '' }]);
  };
  const remove = (id: string) => {
    setRows((prev) => {
      const next = prev.filter((r) => r.id !== id);
      persist(next);
      return next;
    });
  };

  const inputClass = clsx(
    'w-full min-w-0 rounded-lg border bg-background-subtle text-foreground placeholder:text-subtle',
    'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
    'text-sm py-2 px-3 font-mono border-default',
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="block text-sm font-medium text-foreground">Headers</label>
        <Button
          variant="ghost"
          size="xs"
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={add}
          disabled={disabled}
        >
          Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">No headers. Click Add to create one.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className="space-y-2 rounded-lg border border-default bg-background-subtle/40 p-2"
            >
              <input
                type="text"
                value={row.name}
                onChange={(e) => update(row.id, { name: e.target.value })}
                placeholder="X-API-Key"
                disabled={disabled}
                className={inputClass}
              />
              <div className="flex items-stretch gap-2">
                <input
                  type="password"
                  value={row.value}
                  onChange={(e) => update(row.id, { value: e.target.value })}
                  placeholder="header value"
                  disabled={disabled}
                  className={inputClass}
                />
                <Button
                  variant="ghost"
                  size="xs"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={() => remove(row.id)}
                  disabled={disabled}
                  aria-label="Remove header"
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {fieldError && <p className="text-xs text-error">{fieldError}</p>}
      {helpText && !fieldError && <p className="text-xs text-muted">{helpText}</p>}
    </div>
  );
}

/**
 * Map provider `availableAuthTypes` to our internal AuthType values.
 *
 * Two vocabularies flow into `availableAuthTypes`:
 *   - Nango-vocab strings (`oauth2`, `api_key`, `basic`) derived from provider
 *     authMode by `deriveAvailableAuthTypesFromProviders`.
 *   - Platform-vocab strings (`aws_iam`, `azure_ad`, `oauth2_client_credentials`)
 *     returned by `CONNECTOR_AUTH_TYPE_OVERRIDES` for connectors that need a
 *     specific platform auth type (AWS SigV4, Azure AD client-credentials, etc.).
 *
 * Platform-vocab values are already valid AuthType — pass them through
 * untouched. Only translate the Nango-vocab ones.
 */
const PLATFORM_AUTH_TYPE_PASSTHROUGH: ReadonlySet<string> = new Set<AuthType>([
  'none',
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_token',
  'oauth2_client_credentials',
  'basic',
  'custom_header',
  'aws_iam',
  'azure_ad',
  'mtls',
  'ssh_key',
  'digest',
  'kerberos',
  'saml',
  'hawk',
  'ws_security',
]);

function mapProviderAuthType(providerType: string): AuthType {
  if (PLATFORM_AUTH_TYPE_PASSTHROUGH.has(providerType)) {
    return providerType as AuthType;
  }
  switch (providerType) {
    case 'oauth2':
      return 'oauth2_app';
    default:
      return 'api_key';
  }
}

/** Build config pre-fill for a connector based on auth type */
function buildConnectorPrefillConfig(
  selectedAuthType: AuthType,
  connector: PreselectedConnector,
): Record<string, unknown> {
  const defaults = getFieldDefaults(AUTH_TYPE_METADATA[selectedAuthType]?.configFields ?? []);
  const prefillConfig: Record<string, unknown> = { ...defaults.config };

  // Only apply OAuth prefill for OAuth auth types
  if (selectedAuthType === 'oauth2_app' && connector.oauth2) {
    const oauth = connector.oauth2;
    prefillConfig.authorizationUrl = oauth.authorizationUrl;
    prefillConfig.tokenUrl = oauth.tokenUrl;
    if (oauth.refreshUrl) {
      prefillConfig.refreshUrl = oauth.refreshUrl;
    }
    prefillConfig.defaultScopes = oauth.defaultScopes;
    prefillConfig.pkceRequired = oauth.pkce;
    if (oauth.authorizationParams) {
      prefillConfig.authorizationParams = oauth.authorizationParams;
    }
    if (oauth.tokenParams) {
      prefillConfig.tokenParams = oauth.tokenParams;
    }
  }

  if (selectedAuthType === 'oauth2_client_credentials' && connector.oauth2) {
    const oauth = connector.oauth2;
    prefillConfig.tokenUrl = oauth.tokenUrl;
    if (oauth.defaultScopes.length > 0) {
      prefillConfig.scopes = oauth.defaultScopes;
    }
    if (typeof oauth.tokenParams?.audience === 'string') {
      prefillConfig.audience = oauth.tokenParams.audience;
    }
  }

  // Apply API key pre-fill from Nango proxy headers
  if (selectedAuthType === 'api_key' && connector.apiKeyConfig) {
    prefillConfig.headerName = connector.apiKeyConfig.headerName;
    prefillConfig.placement = 'header';
    if (connector.apiKeyConfig.prefix) {
      prefillConfig.prefix = connector.apiKeyConfig.prefix;
    }
    // Pre-fill additional header defaults (e.g. anthropic-version)
    if (connector.apiKeyConfig.additionalHeaders) {
      const additionalHeaderValues: Record<string, string> = {};
      for (const h of connector.apiKeyConfig.additionalHeaders) {
        additionalHeaderValues[h.fieldKey] = String(
          h.fieldMeta.default ?? h.defaultValue ?? h.fieldMeta.example ?? '',
        );
      }
      prefillConfig.additionalHeaders = additionalHeaderValues;
    }
  }

  // Per-connector-per-auth-type prefill from CONNECTOR_AUTH_PREFILL. Applied
  // last so it can override OAuth/API-key defaults for connectors that need
  // bespoke values (e.g. AWS S3 needs service='s3', Azure Outlook needs the
  // graph.microsoft.com resource).
  const typePrefill = connector.authPrefill?.[selectedAuthType];
  if (typePrefill) {
    for (const [key, value] of Object.entries(typePrefill)) {
      prefillConfig[key] = value;
    }
  }

  return prefillConfig;
}

// =============================================================================
// TAGS / CHIP INPUT
// =============================================================================

/**
 * Chip-based multi-value input. Each committed value becomes a removable chip;
 * the underlying state stays as `string[]` so callers and the persisted shape
 * don't change.
 *
 * Commit triggers: Enter, comma, space, blur. Paste with whitespace/comma
 * auto-splits and commits in one go. Backspace with empty input removes the
 * last chip.
 *
 * Replaces the prior "plain Input + split on every keystroke" approach which
 * normalised the user's typing buffer on every render — making it impossible
 * to type spaces or commas without immediately losing the trailing character
 * (you could only paste, not type, multi-value scopes).
 */
interface TagsChipInputProps {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  helpText?: string;
  error?: string;
  disabled?: boolean;
}

function TagsChipInput({
  label,
  value,
  onChange,
  placeholder,
  helpText,
  error,
  disabled,
}: TagsChipInputProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const tags = Array.isArray(value) ? value : [];

  const commitDraft = useCallback(
    (raw: string) => {
      const parts = raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length === 0) {
        setDraft('');
        return;
      }
      const merged = [...tags];
      for (const p of parts) {
        if (!merged.includes(p)) merged.push(p);
      }
      onChange(merged);
      setDraft('');
    },
    [tags, onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (draft.trim()) commitDraft(draft);
    } else if (e.key === ' ') {
      // Always swallow space — either commit the pending draft, or just
      // prevent a leading space from polluting the input.
      e.preventDefault();
      if (draft.trim()) commitDraft(draft);
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      e.preventDefault();
      onChange(tags.slice(0, -1));
    }
    // Tab falls through; the browser moves focus and onBlur commits the draft.
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!pasted) return;
    if (/[,\s]/.test(pasted)) {
      e.preventDefault();
      commitDraft(draft + pasted);
    }
  };

  const handleBlur = () => {
    if (draft.trim()) commitDraft(draft);
  };

  const removeAt = (idx: number) => {
    if (disabled) return;
    onChange(tags.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-foreground">{label}</label>
      <div
        role="group"
        aria-label={label}
        onClick={() => inputRef.current?.focus()}
        className={clsx(
          'flex flex-wrap items-center gap-1.5 rounded-lg border bg-background-subtle px-2 py-1.5 min-h-[38px]',
          'transition-default focus-within:border-border-focus focus-within:ring-1 focus-within:ring-border-focus',
          error ? 'border-error' : 'border-default',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        {tags.map((tag, idx) => (
          <span
            key={`${tag}-${idx}`}
            className="inline-flex items-center gap-1 rounded-md border border-default bg-background-elevated px-2 py-0.5 text-xs text-foreground"
          >
            <span className="break-all font-mono">{tag}</span>
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAt(idx);
                }}
                className="text-muted hover:text-foreground transition-default"
                aria-label={`Remove ${tag}`}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={handleBlur}
          placeholder={tags.length === 0 ? placeholder : ''}
          disabled={disabled}
          className="min-w-[120px] flex-1 bg-transparent text-sm text-foreground placeholder:text-subtle focus:outline-none disabled:cursor-not-allowed"
        />
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
      {helpText && !error && <p className="text-xs text-muted">{helpText}</p>}
    </div>
  );
}

// =============================================================================
// REDIRECT URI HELPER
// =============================================================================

function RedirectUriField() {
  const [copied, setCopied] = useState(false);
  const url =
    typeof window !== 'undefined' ? `${window.location.origin}/oauth/auth-profile-callback` : '';

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Clipboard API unavailable in non-secure contexts
      });
  }, [url]);

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-muted uppercase tracking-wider">
        Authorized Redirect URI
      </label>
      <p className="text-xs text-muted">
        Copy this URL and add it to your OAuth provider&apos;s authorized redirect URIs (e.g. Google
        Cloud Console, GitHub OAuth Apps).
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={url}
          className="flex-1 rounded-lg border border-default bg-background-subtle px-3 py-2 text-sm text-foreground font-mono select-all"
          onClick={(e) => (e.target as HTMLInputElement).select()}
        />
        <button
          type="button"
          className={clsx(
            'shrink-0 rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
            'inline-flex items-center gap-1.5',
            copied
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-default bg-background-subtle text-foreground hover:bg-background-muted',
          )}
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" />
              Copied
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AuthProfileSlideOver({
  open,
  onClose,
  onSaved,
  projectId,
  editProfileId,
  preselectedAuthType,
  preselectedConnector: externalPreselectedConnector,
  providers,
}: AuthProfileSlideOverProps) {
  const t = useTranslations('auth_profiles.slide_over');
  const tAdvisory = useTranslations('auth_profiles.advisory');
  const tTabs = useTranslations('auth_profiles.slide_over_tabs');
  const isEdit = Boolean(editProfileId);
  const ENVIRONMENT_OPTIONS = useMemo(
    () => [
      { value: '', label: t('env_all') },
      { value: 'development', label: t('env_development') },
      { value: 'staging', label: t('env_staging') },
      { value: 'production', label: t('env_production') },
    ],
    [t],
  );

  const isWorkspaceScope = projectId === '_workspace';
  const {
    profile,
    isLoading: profileLoading,
    errorStatus: profileErrorStatus,
    refresh: refreshProjectProfile,
  } = useAuthProfile(
    isEdit && !isWorkspaceScope ? projectId : null,
    isWorkspaceScope ? null : editProfileId,
  );

  // For workspace scope, fetch profile via workspace API
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- workspace profile fetched via untyped API response
  const [workspaceProfile, setWorkspaceProfile] = useState<any>(null);
  const [workspaceProfileLoading, setWorkspaceProfileLoading] = useState(false);
  const loadWorkspaceProfile = useCallback(() => {
    if (!editProfileId) return;
    setWorkspaceProfileLoading(true);
    fetchWorkspaceAuthProfile(editProfileId)
      .then((res) => setWorkspaceProfile(res.data))
      .catch(() => setWorkspaceProfile(null))
      .finally(() => setWorkspaceProfileLoading(false));
  }, [editProfileId]);
  useEffect(() => {
    if (!open || !isEdit || !isWorkspaceScope || !editProfileId) {
      setWorkspaceProfile(null);
      return;
    }
    loadWorkspaceProfile();
  }, [open, isEdit, isWorkspaceScope, editProfileId, loadWorkspaceProfile]);

  // Re-fetch the currently displayed profile from whichever endpoint backs it.
  // Used after OAuth dialog success to refresh the authorization badge + lastAuthorizedAt.
  const refreshResolvedProfile = useCallback(() => {
    if (isWorkspaceScope) loadWorkspaceProfile();
    else refreshProjectProfile();
  }, [isWorkspaceScope, loadWorkspaceProfile, refreshProjectProfile]);

  useEffect(() => {
    if (isEdit && profileErrorStatus === 404) {
      onClose();
    }
  }, [isEdit, profileErrorStatus, onClose]);

  // Form state
  const [step, setStep] = useState<'select-connector' | 'select-type' | 'form'>('select-type');
  const [connectorSearch, setConnectorSearch] = useState('');
  const [internalPreselectedConnector, setInternalPreselectedConnector] = useState<
    PreselectedConnector | undefined
  >(undefined);
  // Shadow the destructured prop so downstream code (memos, handlers, render)
  // reads the merged value transparently. The external prop wins; otherwise
  // we fall back to a connector picked inside the slide-over picker step.
  const preselectedConnector = externalPreselectedConnector ?? internalPreselectedConnector;
  // Picker step: a card click sets the highlighted provider; the user advances
  // explicitly via the Continue button (or double-click).
  const [pickerSelectedProvider, setPickerSelectedProvider] = useState<
    IntegrationProvider | undefined
  >(undefined);
  const [authType, setAuthType] = useState<AuthType | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [environment, setEnvironment] = useState('');
  const [visibility, setVisibility] = useState<'shared' | 'personal'>('shared');
  const [connectionMode, setConnectionMode] = useState<'shared' | 'per_user'>('shared');
  const [usageMode, setUsageMode] = useState<AuthProfileUsageMode>('preconfigured');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [profileFields, setProfileFields] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, unknown>>({});
  const [secretsUnchanged, setSecretsUnchanged] = useState<Set<string>>(new Set());
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [connector, setConnector] = useState<string>('');
  const [connectionConfig, setConnectionConfig] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    valid: boolean;
    message?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /**
   * Dirty flag. False on open / after load / after successful save. Flipped
   * to true by any change handler that mutates form state. Used to disable
   * Save until something has actually changed (edit mode only).
   */
  const [isDirty, setIsDirty] = useState(false);

  // ABLP-913: New state for Authorize CTA, Activity tab, and revoke modals
  const [slideOverTab, setSlideOverTab] = useState<'details' | 'activity'>('details');
  const [oauthDialogOpen, setOauthDialogOpen] = useState(false);
  const [revokeProfileOpen, setRevokeProfileOpen] = useState(false);
  const [revokeTokensOpen, setRevokeTokensOpen] = useState(false);
  const [revokeMenuOpen, setRevokeMenuOpen] = useState(false);
  // Post-create authorize handoff: when a new OAuth profile is created (with
  // OR without a connector), hand the user straight into the Authorize popup
  // flow instead of closing the slide-over (the prior UX silently dropped them
  // back at the list with the profile in "To be Authorized" state).
  const [pendingAuthorizeProfile, setPendingAuthorizeProfile] = useState<{
    id: string;
    connector?: string;
    name: string;
  } | null>(null);

  const resolvedProfile = isWorkspaceScope ? workspaceProfile : profile;
  const resolvedProfileLoading = isWorkspaceScope ? workspaceProfileLoading : profileLoading;
  const legacyMigration = isEdit ? (resolvedProfile?.migration ?? null) : null;
  const isLegacyCreateFlow = !isEdit && authType === 'oauth2_token';
  const isLegacyReadOnly =
    legacyMigration?.status === 'legacy_read_only' || isLegacyCreateFlow === true;
  const legacyReadOnlyMessage = legacyMigration?.message ?? t('legacy_create_blocked');

  // Connector picker step — filter the providers list by search text
  const filteredProviders = useMemo(() => {
    if (!providers) return [];
    const q = connectorSearch.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter(
      (p) => p.displayName.toLowerCase().includes(q) || p.connectorName.toLowerCase().includes(q),
    );
  }, [providers, connectorSearch]);

  // Pick a connector in the in-panel picker step. Mirrors the external-prefill
  // useEffect branch, then transitions to the form step.
  const handleConnectorPick = useCallback((provider: IntegrationProvider) => {
    const adapted: PreselectedConnector = {
      connectorName: provider.connectorName,
      displayName: provider.displayName,
      availableAuthTypes: provider.availableAuthTypes,
      oauth2: provider.oauth2,
      connectionConfig: provider.connectionConfig,
      apiKeyConfig: provider.apiKeyConfig,
      authPrefill: provider.authPrefill,
    };
    const firstType = adapted.availableAuthTypes[0];
    const inferredAuthType: AuthType = firstType ? mapProviderAuthType(firstType) : 'oauth2_app';
    const prefillConfig = buildConnectorPrefillConfig(inferredAuthType, adapted);
    const defaults = getFieldDefaults(AUTH_TYPE_METADATA[inferredAuthType]?.configFields ?? []);
    setInternalPreselectedConnector(adapted);
    setAuthType(inferredAuthType);
    setConfig(prefillConfig);
    setProfileFields(defaults.profile);
    setSecrets({});
    setSecretsUnchanged(new Set());
    setUsageMode(getDefaultUsageMode(inferredAuthType));
    setConnector(adapted.connectorName);
    setConnectionConfig({});
    setStep('form');
  }, []);

  // Reset on open/close
  useEffect(() => {
    if (open) {
      setError(null);
      setFieldErrors({});
      setTestResult(null);
      setSlideOverTab('details');
      setRevokeMenuOpen(false);
      setIsDirty(false);
      // Picker-related state must be cleared on every fresh open. Otherwise an
      // earlier integration pick would leak into a later custom-profile open,
      // making downstream memos (`connConfigFields`, integration auth-type
      // dropdown, api-key apiKeyConfig branch) read stale connector context.
      setInternalPreselectedConnector(undefined);
      setPickerSelectedProvider(undefined);
      setConnectorSearch('');
      if (isEdit && resolvedProfile) {
        // Profile loaded — populate the form
        setStep('form');
        setAuthType(resolvedProfile.authType);
        setName(resolvedProfile.name);
        setDescription(resolvedProfile.description ?? '');
        setEnvironment(resolvedProfile.environment ?? '');
        setVisibility(resolvedProfile.visibility);
        setConnectionMode(
          resolvedProfile.connectionMode ??
            (resolvedProfile.visibility === 'personal' ? 'per_user' : 'shared'),
        );
        setUsageMode(resolvedProfile.usageMode ?? getDefaultUsageMode(resolvedProfile.authType));
        setConfig(normalizeConfigForEditor(resolvedProfile.authType, resolvedProfile.config));
        setProfileFields(
          normalizeProfileFieldsForEditor(resolvedProfile.authType, {
            linkedAppProfileId: resolvedProfile.linkedAppProfileId,
          }),
        );
        setSecrets({});
        setSecretsUnchanged(new Set(Object.keys(resolvedProfile.redactedSecrets ?? {})));
        setConnector(resolvedProfile.connector ?? '');
        // Pre-fill `connectionConfig` from the persisted profile so edit-mode
        // can show + update fields like Azure DI's endpoint / apiVersion.
        // Without this the form opens blank and the save path can wipe the
        // saved connectionConfig when the user clicks Update.
        const savedConnectionConfig = (resolvedProfile.config as Record<string, unknown> | null)
          ?.connectionConfig;
        if (savedConnectionConfig && typeof savedConnectionConfig === 'object') {
          const stringified: Record<string, string> = {};
          for (const [key, value] of Object.entries(
            savedConnectionConfig as Record<string, unknown>,
          )) {
            if (
              typeof value === 'string' ||
              typeof value === 'number' ||
              typeof value === 'boolean'
            ) {
              stringified[key] = String(value);
            }
          }
          setConnectionConfig(stringified);
        } else {
          setConnectionConfig({});
        }
      } else if (isEdit && !resolvedProfile) {
        // Still loading or failed — don't reset, just wait for profile to arrive
        setStep('form');
      } else if (externalPreselectedConnector) {
        // Pre-fill from integration provider (Nango) data.
        // The first entry in availableAuthTypes is the connector's preferred
        // auth type — either a Nango-vocab string (translated) or a platform
        // auth type from CONNECTOR_AUTH_TYPE_OVERRIDES (passed through).
        // For non-OAuth connectors (Azure DI, etc.) the fallback was
        // historically 'oauth2_app' which pulled up the OAuth form; with the
        // CONNECTOR_AUTH_TYPE_OVERRIDES override placing 'api_key' first in
        // availableAuthTypes for Azure DI, that case no longer hits — but if
        // a connector has zero entries we still default to 'api_key' (safer
        // than 'oauth2_app' for a credential-based connector).
        const firstType = externalPreselectedConnector.availableAuthTypes[0];
        const inferredAuthType: AuthType = firstType ? mapProviderAuthType(firstType) : 'api_key';
        const prefillConfig = buildConnectorPrefillConfig(
          inferredAuthType,
          externalPreselectedConnector,
        );
        const defaults = getFieldDefaults(AUTH_TYPE_METADATA[inferredAuthType]?.configFields ?? []);
        setStep('form');
        setAuthType(inferredAuthType);
        setName('');
        setDescription('');
        setEnvironment('');
        setVisibility('shared');
        setConnectionMode('shared');
        setUsageMode(getDefaultUsageMode(inferredAuthType));
        setConfig(prefillConfig);
        setProfileFields(defaults.profile);
        setSecrets({});
        setSecretsUnchanged(new Set());
        setConnector(externalPreselectedConnector.connectorName);
        // Pre-fill connectionConfig field defaults from provider metadata so
        // fields like Azure DI's `apiVersion` open with their sensible default
        // already in the input. Only coerce primitive defaults to string —
        // unset / object / undefined defaults stay blank.
        const connectionConfigDefaults: Record<string, string> = {};
        for (const [key, meta] of Object.entries(
          externalPreselectedConnector.connectionConfig ?? {},
        )) {
          if (
            meta?.default !== undefined &&
            (typeof meta.default === 'string' ||
              typeof meta.default === 'number' ||
              typeof meta.default === 'boolean')
          ) {
            connectionConfigDefaults[key] = String(meta.default);
          }
        }
        setConnectionConfig(connectionConfigDefaults);
      } else if (providers && providers.length > 0) {
        // Connector picker step (no external preselection — user will pick one).
        setStep('select-connector');
        setConnectorSearch('');
        setPickerSelectedProvider(undefined);
        setInternalPreselectedConnector(undefined);
        setAuthType(null);
        setName('');
        setDescription('');
        setEnvironment('');
        setVisibility('shared');
        setConnectionMode('shared');
        setUsageMode('preconfigured');
        setConfig({});
        setProfileFields({});
        setSecrets({});
        setSecretsUnchanged(new Set());
        setConnector('');
        setConnectionConfig({});
      } else if (preselectedAuthType) {
        const defaults = getFieldDefaults(AUTH_TYPE_METADATA[preselectedAuthType].configFields);
        setStep('form');
        setAuthType(preselectedAuthType);
        setName('');
        setDescription('');
        setEnvironment('');
        setVisibility('shared');
        setUsageMode(getDefaultUsageMode(preselectedAuthType));
        setConfig(defaults.config);
        setProfileFields(defaults.profile);
        setSecrets({});
        setSecretsUnchanged(new Set());
        setConnector('');
        setConnectionConfig({});
      } else {
        setStep('select-type');
        setAuthType(null);
        setName('');
        setDescription('');
        setEnvironment('');
        setVisibility('shared');
        setConnectionMode('shared');
        setUsageMode('preconfigured');
        setConfig({});
        setProfileFields({});
        setSecrets({});
        setSecretsUnchanged(new Set());
        setConnector('');
        setConnectionConfig({});
      }
    }
  }, [open, isEdit, resolvedProfile, preselectedAuthType, externalPreselectedConnector, providers]);

  const meta = authType ? AUTH_TYPE_METADATA[authType] : null;

  // Connection config fields: OAuth uses only URL-template fields; API key uses
  // non-automated Nango connectionConfig fields (automated fields have defaults
  // and are not meant for user input, e.g. github-pat "version").
  const connConfigFields = useMemo(() => {
    if (!preselectedConnector) return [];
    // OAuth: only show fields referenced in authorizationUrl / tokenUrl templates
    if (authType === 'oauth2_app' || authType === 'oauth2_token') {
      return preselectedConnector.oauth2?.connectionConfigFields ?? [];
    }
    // API key / other: show non-automated connectionConfig fields from Nango
    if (preselectedConnector.connectionConfig) {
      return Object.keys(preselectedConnector.connectionConfig);
    }
    return [];
  }, [preselectedConnector, authType]);

  // Full connection config field metadata (from Nango) for rendering labels/descriptions
  const connConfigMeta = useMemo(() => {
    return preselectedConnector?.connectionConfig ?? {};
  }, [preselectedConnector]);

  // Resolved URL previews based on connection config values
  const resolvedUrls = useMemo(() => {
    if (!preselectedConnector?.oauth2 || connConfigFields.length === 0) return null;
    const oauth = preselectedConnector.oauth2;
    try {
      const authUrl = resolveConnectionConfigTemplate(oauth.authorizationUrl, connectionConfig);
      const tokenUrlResolved = resolveConnectionConfigTemplate(oauth.tokenUrl, connectionConfig);
      return { authorizationUrl: authUrl, tokenUrl: tokenUrlResolved };
    } catch {
      return null;
    }
  }, [preselectedConnector, connConfigFields, connectionConfig]);

  // Handle type selection
  const handleTypeSelect = useCallback((type: AuthType) => {
    setAuthType(type);
    const defaults = getFieldDefaults(AUTH_TYPE_METADATA[type].configFields);
    setUsageMode(getDefaultUsageMode(type));
    setConfig(defaults.config);
    setProfileFields(defaults.profile);
    setSecrets({});
    setStep('form');
    // Switching auth type during create flow is a meaningful user mutation;
    // mirror integration-flow handler so Save dirtiness stays consistent.
    setIsDirty(true);
  }, []);

  // Handle auth type change within integration connector flow
  const handleIntegrationAuthTypeChange = useCallback(
    (providerType: string) => {
      if (!preselectedConnector) return;
      const newAuthType = mapProviderAuthType(providerType);
      setAuthType(newAuthType);
      setConfig(buildConnectorPrefillConfig(newAuthType, preselectedConnector));
      const defaults = getFieldDefaults(AUTH_TYPE_METADATA[newAuthType]?.configFields ?? []);
      setProfileFields(defaults.profile);
      setUsageMode(getDefaultUsageMode(newAuthType));
      setSecrets({});
      setSecretsUnchanged(new Set());
      setFieldErrors({});
      setTestResult(null);
      setError(null);
      // Auth-type change replaces config + secrets + profileFields. From the
      // user's POV this is the most meaningful mutation possible — Save must
      // become enabled even though no individual field handler fired.
      setIsDirty(true);
    },
    [preselectedConnector],
  );

  // Field change handlers
  const handleConfigChange = useCallback((key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleProfileFieldChange = useCallback((key: string, value: unknown) => {
    setProfileFields((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleConnectionConfigChange = useCallback(
    (key: string, value: string) => {
      setIsDirty(true);
      setConnectionConfig((prev) => {
        const next = { ...prev, [key]: value };
        // Only inject resolved OAuth URLs into config when the auth type
        // accepts them. Strict Zod schemas for api_key, aws_iam, azure_ad,
        // basic, oauth2_client_credentials, etc. reject authorizationUrl /
        // tokenUrl keys — leaking them here causes save VALIDATION_ERROR.
        if (
          preselectedConnector?.oauth2 &&
          (authType === 'oauth2_app' || authType === 'oauth2_token')
        ) {
          const oauth = preselectedConnector.oauth2;
          try {
            const resolvedAuthUrl = resolveConnectionConfigTemplate(oauth.authorizationUrl, next);
            setConfig((prevConfig) => ({ ...prevConfig, authorizationUrl: resolvedAuthUrl }));
          } catch {
            // Template not fully resolved yet — keep existing value
          }
          try {
            const resolvedTokenUrl = resolveConnectionConfigTemplate(oauth.tokenUrl, next);
            setConfig((prevConfig) => ({ ...prevConfig, tokenUrl: resolvedTokenUrl }));
          } catch {
            // Template not fully resolved yet — keep existing value
          }
        }
        return next;
      });
    },
    [preselectedConnector, authType],
  );

  const handleSecretChange = useCallback((key: string, value: unknown) => {
    setSecrets((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
    setSecretsUnchanged((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Client-side validation
  const validate = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('name_required');
    if (meta) {
      for (const field of meta.configFields) {
        const fieldValue =
          field.target === 'profile' ? profileFields[field.key] : config[field.key];
        if (field.required && !fieldValue) {
          errors[field.key] = t('field_required', { label: field.label });
        }
      }
      for (const field of meta.secretFields) {
        if (field.required && !isEdit && !secrets[field.key]) {
          errors[field.key] = t('field_required', { label: field.label });
        }
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [name, meta, config, profileFields, secrets, isEdit]);

  // Save
  const handleSave = useCallback(async () => {
    if (!authType || isLegacyReadOnly || !validate()) return;
    setSaving(true);
    setError(null);
    try {
      const linkedAppProfileId =
        authType === 'oauth2_token' && typeof profileFields.linkedAppProfileId === 'string'
          ? profileFields.linkedAppProfileId.trim() || undefined
          : undefined;

      // Build the save payload as a schema-driven projection. The Zod
      // `*ConfigSchema` for the chosen auth type is the single source of
      // truth — any UI state key not in the schema's `.shape` is silently
      // dropped before send. This prevents leaks (OAuth URLs into api_key,
      // raw connectionConfig into aws_iam, etc.) regardless of how those
      // keys ended up in component state (prefill, auth-type toggle,
      // connection-config helper, future fields).
      //
      // Type-aware composition steps happen AFTER projection so they only
      // write keys the schema accepts:
      //   - OAuth: inline resolved authorizationUrl / tokenUrl
      //   - oauth2_client_credentials: resolve `${connectionConfig.x}`
      //     templates inside tokenUrl
      //   - schemas declaring `connectionConfig`: forward the raw blob
      const buildSaveConfig = (): Record<string, unknown> => {
        const allowed = getAllowedConfigKeys(authType);
        // No schema entry for this auth type → pass config through unchanged
        // (defensive — every shipped auth type has a registered schema).
        if (allowed.size === 0) return { ...config };

        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(config)) {
          if (allowed.has(key)) result[key] = value;
        }

        // OAuth: inline resolved URLs so the saved row has concrete values
        // (the backend stores the rendered URL, not the template).
        if (resolvedUrls && (authType === 'oauth2_app' || authType === 'oauth2_token')) {
          if (allowed.has('authorizationUrl')) {
            result.authorizationUrl = resolvedUrls.authorizationUrl;
          }
          if (allowed.has('tokenUrl')) result.tokenUrl = resolvedUrls.tokenUrl;
        }
        // Client-credentials: resolve any `${connectionConfig.x}` template
        // in tokenUrl against the user-entered connectionConfig before
        // sending — otherwise the backend gets a literal template string.
        if (
          authType === 'oauth2_client_credentials' &&
          typeof config.tokenUrl === 'string' &&
          allowed.has('tokenUrl')
        ) {
          const template = config.tokenUrl;
          if (template.includes('${connectionConfig.')) {
            try {
              result.tokenUrl = resolveConnectionConfigTemplate(template, connectionConfig);
            } catch {
              // Missing config value — leave the template; backend will
              // surface the missing field as a validation error.
            }
          }
        }
        // Forward the raw connectionConfig blob only when the schema
        // declares it (api_key / bearer / oauth2_app today).
        if (allowed.has('connectionConfig')) {
          result.connectionConfig = connectionConfig;
        }
        return result;
      };

      if (isEdit && editProfileId) {
        const changedSecrets: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(secrets)) {
          if (!secretsUnchanged.has(key) && val) {
            changedSecrets[key] = val;
          }
        }
        const saveConfig = buildSaveConfig();
        const updatePayload = {
          name,
          description: description || undefined,
          config: saveConfig,
          secrets: Object.keys(changedSecrets).length > 0 ? changedSecrets : undefined,
          environment: environment || null,
          visibility,
          connectionMode,
          usageMode,
          linkedAppProfileId,
          connector: connector || undefined,
        };
        if (isWorkspaceScope) {
          const result = await updateWorkspaceAuthProfile(editProfileId, updatePayload);
          // ABLP-913 FR-25: Show advisory if sensitive fields changed
          const sensitiveFields = (result.data as unknown as Record<string, unknown>)
            ?.sensitiveFieldsChanged as string[] | undefined;
          if (sensitiveFields && sensitiveFields.length > 0) {
            showSensitiveFieldAdvisory(tAdvisory, sensitiveFields);
          }
        } else {
          const result = await updateAuthProfile(projectId, editProfileId, updatePayload);
          // ABLP-913 FR-25: Show advisory if sensitive fields changed
          const sensitiveFields = (result.data as unknown as Record<string, unknown>)
            ?.sensitiveFieldsChanged as string[] | undefined;
          if (sensitiveFields && sensitiveFields.length > 0) {
            showSensitiveFieldAdvisory(tAdvisory, sensitiveFields);
          }
        }
      } else {
        const createConfig = buildSaveConfig();
        const created = isWorkspaceScope
          ? await createWorkspaceAuthProfile({
              name,
              description: description || undefined,
              authType,
              config: createConfig,
              secrets,
              environment: environment || null,
              visibility,
              connectionMode,
              usageMode,
              linkedAppProfileId,
              connector: connector || undefined,
            })
          : await createAuthProfile(projectId, {
              name,
              description: description || undefined,
              authType,
              config: createConfig,
              secrets,
              projectId,
              scope: 'project',
              environment: environment || null,
              visibility,
              connectionMode,
              usageMode,
              linkedAppProfileId,
              connector: connector || undefined,
            });

        // Post-create authorize handoff: oauth2_app profiles need a user-consent
        // grant before they're usable. Workspace OAuth endpoints exist
        // (/api/admin/auth-profiles/oauth/*), so handoff applies to both scopes.
        // Custom profiles without a connector still get the handoff — connector
        // is optional. (oauth2_client_credentials is already authorized inline
        // by the create handler, so it's not part of this handoff.)
        if (authType === 'oauth2_app' && created.data?.id) {
          setPendingAuthorizeProfile({
            id: created.data.id,
            connector: connector || undefined,
            name,
          });
          setSaving(false);
          return;
        }
      }
      setIsDirty(false);
      onSaved();
    } catch (err) {
      setError(sanitizeError(err, t('save_failed')));
    } finally {
      setSaving(false);
    }
  }, [
    authType,
    validate,
    isEdit,
    isWorkspaceScope,
    editProfileId,
    projectId,
    name,
    description,
    config,
    profileFields,
    secrets,
    secretsUnchanged,
    environment,
    visibility,
    connectionMode,
    usageMode,
    connector,
    connectionConfig,
    connConfigFields,
    onSaved,
    isLegacyReadOnly,
    tAdvisory,
  ]);

  // Test / verify credentials. Dispatches between two paths:
  //   - Edit mode → validate by profileId (real grant lookup, last-validated update)
  //   - Create mode → verify-draft against the current {authType, config, secrets}
  //     payload so users can sanity-check (especially CC token URL + secrets)
  //     before saving for the first time.
  const handleTest = useCallback(async () => {
    if (!editProfileId || isLegacyReadOnly) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = isWorkspaceScope
        ? await validateWorkspaceAuthProfile(editProfileId)
        : await validateAuthProfile(projectId, editProfileId);
      setTestResult(result.data);
    } catch (err) {
      setTestResult({ valid: false, message: sanitizeError(err, t('validation_failed')) });
    } finally {
      setTesting(false);
    }
  }, [projectId, editProfileId, isWorkspaceScope, isLegacyReadOnly]);

  // Render a form field from metadata
  const renderField = useCallback(
    (field: FormFieldDef, isSecret: boolean) => {
      const key = field.key;

      // custom_header: render unified name+value editor once (on the `headers` config field).
      // Suppress the `headerValues` secret field so we don't show two separate sections.
      if (authType === 'custom_header') {
        if (isSecret && key === 'headerValues') return null;
        if (!isSecret && key === 'headers') {
          return (
            <CustomHeaderEditor
              key={key}
              headerNames={config.headers}
              headerValues={secrets.headerValues}
              helpText="Each row defines a header name and its value. Both are required."
              disabled={isLegacyReadOnly}
              fieldError={fieldErrors.headers ?? fieldErrors.headerValues}
              onChange={({ headers, headerValues }) => {
                handleConfigChange('headers', headers);
                handleSecretChange('headerValues', headerValues);
              }}
            />
          );
        }
      }

      const value = isSecret
        ? (secrets[key] ?? '')
        : field.target === 'profile'
          ? profileFields[key]
          : config[key];
      const fieldError = fieldErrors[key];
      // headerName is read-only when pre-filled from Nango proxy headers
      const isFieldDisabled =
        isLegacyReadOnly || (key === 'headerName' && !!preselectedConnector?.apiKeyConfig);

      if (isSecret && isEdit && secretsUnchanged.has(key)) {
        return (
          <div key={key} className="space-y-1.5">
            <label className="block text-sm font-medium text-foreground">{field.label}</label>
            <div className="flex items-center gap-2">
              <div className="flex-1 rounded-lg border border-default bg-background-subtle px-3 py-2 text-sm text-muted font-mono">
                {resolvedProfile?.redactedSecrets?.[key] ?? '••••••••'}
              </div>
              {!isLegacyReadOnly && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setSecretsUnchanged((prev) => {
                      const next = new Set(prev);
                      next.delete(key);
                      return next;
                    });
                  }}
                >
                  {t('change')}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted">{t('value_unchanged')}</p>
          </div>
        );
      }

      switch (field.type) {
        case 'text':
        case 'url':
          return (
            <Input
              key={key}
              label={field.label}
              type="text"
              value={String(value ?? '')}
              onChange={(e) =>
                isSecret
                  ? handleSecretChange(key, e.target.value)
                  : field.target === 'profile'
                    ? handleProfileFieldChange(key, e.target.value)
                    : handleConfigChange(key, e.target.value)
              }
              placeholder={field.placeholder}
              error={fieldError}
              disabled={isFieldDisabled}
              required={field.required}
              optional={!field.required}
            />
          );
        case 'password': {
          const show = showSecrets[key];
          return (
            <div key={key} className="space-y-1.5">
              <label className="block text-sm font-medium text-foreground">
                {field.label}
                {field.required ? (
                  <span aria-hidden className="ml-1 text-[11px] font-semibold text-error">
                    *
                  </span>
                ) : (
                  <span aria-hidden className="ml-1 text-[11px] font-normal text-muted">
                    (Optional)
                  </span>
                )}
              </label>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  value={String(value ?? '')}
                  onChange={(e) =>
                    isSecret
                      ? handleSecretChange(key, e.target.value)
                      : field.target === 'profile'
                        ? handleProfileFieldChange(key, e.target.value)
                        : handleConfigChange(key, e.target.value)
                  }
                  disabled={isFieldDisabled}
                  placeholder={field.placeholder}
                  className={clsx(
                    'w-full rounded-lg border bg-background-subtle text-foreground placeholder:text-subtle',
                    'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
                    'text-sm py-2 pl-3 pr-9',
                    fieldError ? 'border-error' : 'border-default',
                  )}
                />
                <button
                  type="button"
                  onClick={() => setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }))}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-default btn-press"
                  aria-label={show ? t('hide_value') : t('show_value')}
                  disabled={isFieldDisabled}
                >
                  {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {fieldError && <p className="text-xs text-error">{fieldError}</p>}
              {field.helpText && !fieldError && (
                <p className="text-xs text-muted">{field.helpText}</p>
              )}
            </div>
          );
        }
        case 'select':
          return (
            <Select
              key={key}
              label={field.label}
              options={field.options ?? []}
              value={String(value ?? field.defaultValue ?? '')}
              onChange={(v) =>
                isSecret
                  ? handleSecretChange(key, v)
                  : field.target === 'profile'
                    ? handleProfileFieldChange(key, v)
                    : handleConfigChange(key, v)
              }
              error={fieldError}
              disabled={isFieldDisabled}
            />
          );
        case 'toggle':
          return (
            <Toggle
              key={key}
              label={field.label}
              description={field.helpText}
              checked={Boolean(value ?? field.defaultValue)}
              onChange={(checked) =>
                field.target === 'profile'
                  ? handleProfileFieldChange(key, checked)
                  : handleConfigChange(key, checked)
              }
              disabled={isFieldDisabled}
            />
          );
        case 'tags':
          return (
            <TagsChipInput
              key={key}
              label={field.label}
              value={Array.isArray(value) ? (value as string[]) : []}
              onChange={(next) => {
                if (field.target === 'profile') {
                  handleProfileFieldChange(key, next);
                } else {
                  handleConfigChange(key, next);
                }
              }}
              placeholder={field.placeholder}
              helpText={field.helpText}
              error={fieldError}
              disabled={isFieldDisabled}
            />
          );
        case 'textarea':
          return (
            <div key={key} className="space-y-1.5">
              <label className="block text-sm font-medium text-foreground">{field.label}</label>
              <textarea
                value={String(value ?? '')}
                onChange={(e) =>
                  isSecret
                    ? handleSecretChange(key, e.target.value)
                    : field.target === 'profile'
                      ? handleProfileFieldChange(key, e.target.value)
                      : handleConfigChange(key, e.target.value)
                }
                placeholder={field.placeholder}
                disabled={isFieldDisabled}
                required={field.required}
                rows={5}
                className={clsx(
                  'w-full rounded-lg border bg-background-subtle text-foreground placeholder:text-subtle',
                  'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
                  'text-sm px-3 py-2 font-mono',
                  fieldError ? 'border-error' : 'border-default',
                )}
              />
              {fieldError && <p className="text-xs text-error">{fieldError}</p>}
              {field.helpText && !fieldError && (
                <p className="text-xs text-muted">{field.helpText}</p>
              )}
            </div>
          );
        case 'record': {
          const [kPlaceholder, vPlaceholder] = (() => {
            const ph = field.placeholder ?? '';
            const colonIdx = ph.indexOf(':');
            const eqIdx = ph.indexOf('=');
            const sep = colonIdx >= 0 && (eqIdx < 0 || colonIdx < eqIdx) ? colonIdx : eqIdx;
            if (sep > 0) return [ph.slice(0, sep).trim(), ph.slice(sep + 1).trim()];
            return [ph || 'key', 'value'];
          })();
          return (
            <RecordEditor
              key={key}
              label={field.label}
              value={value}
              helpText={field.helpText}
              disabled={isFieldDisabled}
              keyPlaceholder={kPlaceholder}
              valuePlaceholder={vPlaceholder}
              fieldError={fieldError}
              onChange={(record) => {
                if (isSecret) {
                  handleSecretChange(key, record);
                } else if (field.target === 'profile') {
                  handleProfileFieldChange(key, record);
                } else {
                  handleConfigChange(key, record);
                }
              }}
            />
          );
        }
        default:
          return null;
      }
    },
    [
      authType,
      config,
      profileFields,
      secrets,
      secretsUnchanged,
      fieldErrors,
      showSecrets,
      isEdit,
      isLegacyReadOnly,
      preselectedConnector,
      handleConfigChange,
      handleProfileFieldChange,
      handleSecretChange,
    ],
  );

  // Integration auth type options. Shown whenever a connector declares any
  // auth type so the user always sees which mode they are configuring; the
  // selector becomes a confirmation hint for single-type connectors and a
  // choice for multi-type ones (e.g. Microsoft can do Azure AD client
  // credentials or OAuth 2.0 App user-delegated).
  const integrationAuthTypeOptions = useMemo(() => {
    if (!preselectedConnector || preselectedConnector.availableAuthTypes.length === 0) return [];
    const labelMap: Record<string, string> = {
      // Nango-vocab labels
      oauth2: 'OAuth 2.0',
      api_key: 'API Key',
      bearer: 'Bearer Token',
      basic: 'Basic Auth',
      custom: 'Custom',
      // Platform-vocab labels surfaced by CONNECTOR_AUTH_TYPE_OVERRIDES
      oauth2_app: 'OAuth 2.0 (User Delegated)',
      oauth2_token: 'OAuth 2.0 Token',
      oauth2_client_credentials: 'OAuth 2.0 Client Credentials',
      aws_iam: 'AWS IAM (SigV4)',
      azure_ad: 'Azure AD (Service Principal)',
      custom_header: 'Custom Header',
      mtls: 'mTLS',
    };
    return preselectedConnector.availableAuthTypes.map((t) => ({
      value: t,
      label: labelMap[t] ?? t,
    }));
  }, [preselectedConnector]);

  // Reverse map current authType to whichever value the integration dropdown
  // expects. Platform-vocab options match authType directly; Nango-vocab
  // option `oauth2` corresponds to the `oauth2_app` internal state.
  const currentProviderAuthType = useMemo(() => {
    if (!authType) return '';
    const optionValues = integrationAuthTypeOptions.map((o) => o.value);
    if (optionValues.includes(authType)) return authType;
    if (authType === 'oauth2_app' && optionValues.includes('oauth2')) return 'oauth2';
    return authType;
  }, [authType, integrationAuthTypeOptions]);

  // Group Phase 1 types by category
  const typesByCategory = useMemo(() => {
    return AUTH_TYPE_CATEGORIES.map((cat) => ({
      ...cat,
      types: SUPPORTED_AUTH_TYPES.filter((t) => AUTH_TYPE_METADATA[t].category === cat.key),
    }));
  }, []);

  const usageModeOptions = useMemo(
    () =>
      authType
        ? AUTH_TYPE_USAGE_MODES[authType]
            .filter((mode) => {
              // jit and preflight require project scope — disable at workspace level
              if (isWorkspaceScope && (mode === 'jit' || mode === 'preflight')) return false;
              return true;
            })
            .map((mode) => ({
              value: mode,
              label: AUTH_PROFILE_USAGE_MODE_OPTIONS[mode].label,
            }))
        : [],
    [authType, isWorkspaceScope],
  );

  const usageModeDescription = usageMode
    ? AUTH_PROFILE_USAGE_MODE_OPTIONS[usageMode]?.description
    : undefined;

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="auth-profile-backdrop"
            className={OVERLAY_BACKDROP}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitions.backdrop}
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            key="auth-profile-panel"
            className={clsx(
              'fixed top-0 right-0 z-50 h-full',
              PANEL_WIDTH,
              'bg-background-elevated border-l border-default shadow-xl',
              'flex flex-col',
            )}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={springs.gentle}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-default shrink-0">
              <div className="flex items-center gap-2">
                {step === 'form' && !isEdit && !preselectedConnector && (
                  <button
                    type="button"
                    onClick={() => {
                      setStep('select-type');
                      setAuthType(null);
                    }}
                    className="p-1 rounded-md text-muted hover:text-foreground hover:bg-background-muted transition-default btn-press"
                    aria-label={t('back_to_type_selection')}
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                )}
                <KeyRound className="w-4 h-4 text-info" />
                <h2 className="text-sm font-semibold text-foreground">
                  {isEdit
                    ? t('title_edit')
                    : preselectedConnector
                      ? `${preselectedConnector.displayName} — ${t('title_new')}`
                      : t('title_new')}
                </h2>
                {authType && meta && <Badge variant="accent">{meta.shortLabel}</Badge>}
                {isEdit && resolvedProfile?.status && (
                  <AuthProfileStatusBadge status={resolvedProfile.status} />
                )}
              </div>
              <button
                type="button"
                aria-label={t('close_panel')}
                onClick={onClose}
                className="p-1.5 rounded-md transition-default btn-press text-muted hover:text-foreground hover:bg-background-muted"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* ABLP-913: Tabs (Details + Activity) hidden for now — Activity is
                deferred. Keeping the slideOverTab state lets us re-enable the
                bar without a refactor when the audit feed graduates. */}

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {(() => {
                // Force details branch: Activity tab is intentionally inert
                // until the bar is re-enabled.
                void slideOverTab;
                return (
                  <AnimatePresence mode="wait">
                    {resolvedProfileLoading && isEdit ? (
                      <motion.div
                        key="loading"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="flex items-center justify-center py-12"
                      >
                        <Loader2 className="w-6 h-6 text-info animate-spin" />
                      </motion.div>
                    ) : step === 'select-connector' ? (
                      /* Connector Picker — step 0 for the integration profile flow */
                      <motion.div
                        key="select-connector"
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        transition={springs.gentle}
                        className="space-y-4"
                      >
                        <div>
                          <label className="block text-xs font-medium text-foreground mb-1.5">
                            Search integrations
                          </label>
                          <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
                            <input
                              type="text"
                              placeholder="Slack, Salesforce, GitHub…"
                              value={connectorSearch}
                              onChange={(e) => setConnectorSearch(e.target.value)}
                              autoFocus
                              className={clsx(
                                'w-full rounded-md border border-default bg-background py-2 pl-9 pr-3 text-sm text-foreground',
                                'placeholder-subtle focus:outline-none focus:ring-1 focus:ring-foreground/20 focus:border-foreground/30',
                              )}
                            />
                          </div>
                        </div>

                        <p className="text-[10px] font-semibold uppercase tracking-wider text-subtle">
                          {connectorSearch.trim()
                            ? `${filteredProviders.length} match${filteredProviders.length !== 1 ? 'es' : ''}`
                            : 'Suggested'}
                        </p>

                        {filteredProviders.length > 0 ? (
                          <div className="grid grid-cols-2 gap-2">
                            {filteredProviders.map((provider) => {
                              const isSelected =
                                pickerSelectedProvider?.connectorName === provider.connectorName;
                              return (
                                <button
                                  key={provider.connectorName}
                                  type="button"
                                  onClick={() => setPickerSelectedProvider(provider)}
                                  onDoubleClick={() => handleConnectorPick(provider)}
                                  className={clsx(
                                    'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-default',
                                    isSelected
                                      ? 'border-accent/60 bg-accent-subtle/20 ring-1 ring-accent/30'
                                      : 'border-default hover:border-foreground/20 hover:bg-background-muted/50',
                                  )}
                                >
                                  <ConnectorLogo
                                    name={provider.connectorName}
                                    className="h-7 w-7 shrink-0"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-medium text-foreground truncate">
                                      {provider.displayName}
                                    </p>
                                    <p className="text-[10px] text-subtle truncate mt-0.5">
                                      {provider.profileCount > 0
                                        ? `${provider.profileCount} profile${provider.profileCount !== 1 ? 's' : ''} · `
                                        : ''}
                                      {provider.availableAuthTypes
                                        .slice(0, 2)
                                        .map((t) => getAuthTypeShortLabel(t))
                                        .join(' · ')}
                                      {provider.availableAuthTypes.length > 2
                                        ? ` +${provider.availableAuthTypes.length - 2}`
                                        : ''}
                                    </p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="py-8 text-center text-sm text-subtle">
                            No integrations found
                          </div>
                        )}
                      </motion.div>
                    ) : step === 'select-type' ? (
                      /* Type Selector */
                      <motion.div
                        key="select-type"
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        transition={springs.gentle}
                        className="space-y-5"
                      >
                        <p className="text-sm text-muted">{t('choose_type')}</p>
                        {typesByCategory.map((cat) => (
                          <div key={cat.key}>
                            <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
                              {cat.label}
                            </h3>
                            <div className="space-y-1.5">
                              {cat.types.map((type) => {
                                const m = AUTH_TYPE_METADATA[type];
                                const Icon = m.icon;
                                return (
                                  <button
                                    key={type}
                                    type="button"
                                    onClick={() => handleTypeSelect(type)}
                                    className={clsx(
                                      'w-full flex items-center gap-3 p-3 rounded-lg border border-default',
                                      'hover:border-accent hover:bg-accent-subtle/30 transition-default btn-press text-left',
                                    )}
                                  >
                                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-background-muted shrink-0">
                                      <Icon className="h-4 w-4 text-muted" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <p className="text-sm font-medium text-foreground">
                                        {m.label}
                                      </p>
                                      <p className="text-xs text-muted">{m.description}</p>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </motion.div>
                    ) : meta ? (
                      /* Dynamic Form */
                      <motion.div
                        key="form"
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                        transition={springs.gentle}
                        className="space-y-5"
                      >
                        {/* Profile Actions — edit mode only */}
                        {isEdit && editProfileId && (
                          <div className="rounded-lg border border-default bg-background-muted/40 p-4 space-y-4">
                            {/* Authorization status + Authorize CTA.
                                Shown for any oauth2_app profile (custom OR connector-backed);
                                also shown for oauth2_client_credentials only when a connector
                                is set, since custom CC profiles authorize inline at create time
                                and have no Re-authorize concept. */}
                            {(resolvedProfile?.authType === 'oauth2_app' ||
                              (resolvedProfile?.authType === 'oauth2_client_credentials' &&
                                !!resolvedProfile?.connector)) && (
                              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <div>
                                    <h4 className="text-xs font-medium text-foreground">
                                      Authorization
                                    </h4>
                                    <p className="text-xs text-muted mt-0.5">
                                      Grant OAuth access to the connected service.
                                    </p>
                                  </div>
                                  {(resolvedProfile?.status === 'active' ||
                                    resolvedProfile?.status === 'pending_authorization') && (
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => setOauthDialogOpen(true)}
                                      disabled={saving}
                                      icon={<ShieldCheck className="w-3.5 h-3.5" />}
                                    >
                                      {resolvedProfile.isAuthorized ? 'Re-authorize' : 'Authorize'}
                                    </Button>
                                  )}
                                </div>
                                <AuthProfileAuthorizationBadge
                                  isAuthorized={resolvedProfile.isAuthorized}
                                  authorizedEmail={resolvedProfile.lastAuthorizedBy}
                                />
                              </div>
                            )}

                            {/* Test Credentials — inline result */}
                            {resolvedProfile?.status !== 'revoked' &&
                              resolvedProfile?.status !== 'expired' && (
                                <div className="space-y-2">
                                  <h4 className="text-xs font-medium text-foreground">
                                    Validation
                                  </h4>
                                  <p className="text-xs text-muted">
                                    Verify that the stored credentials can authenticate
                                    successfully.
                                  </p>
                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      onClick={handleTest}
                                      loading={testing}
                                      disabled={saving || isLegacyReadOnly}
                                    >
                                      {t('test_credentials')}
                                    </Button>
                                    {testResult && (
                                      <span
                                        className={clsx(
                                          'inline-flex items-center gap-1.5 text-xs font-medium',
                                          testResult.valid ? 'text-success' : 'text-error',
                                        )}
                                      >
                                        {testResult.valid ? (
                                          <CheckCircle className="w-3.5 h-3.5" />
                                        ) : (
                                          <AlertTriangle className="w-3.5 h-3.5" />
                                        )}
                                        {testResult.valid
                                          ? t('credentials_valid')
                                          : (testResult.message ?? t('validation_failed'))}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              )}

                            {/* Revoke actions — separated with a border */}
                            {resolvedProfile?.status === 'active' && !isLegacyReadOnly && (
                              <>
                                <div className="border-t border-default" />
                                <div className="space-y-2">
                                  <h4 className="text-xs font-medium text-foreground">Revoke</h4>
                                  <p className="text-xs text-muted">
                                    Deactivate credentials or invalidate user tokens. These actions
                                    affect running integrations.
                                  </p>
                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => setRevokeProfileOpen(true)}
                                      disabled={saving}
                                      title="Permanently deactivate this credential. All agents and workflows using it will lose access."
                                    >
                                      Revoke Profile
                                    </Button>
                                    {/* User tokens only exist for OAuth (oauth2_app / oauth2_token).
                                        api_key / basic / bearer / aws_iam / mtls / none profiles
                                        have no per-user token storage — hide the button rather
                                        than offering a no-op. */}
                                    {(authType === 'oauth2_app' || authType === 'oauth2_token') && (
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => setRevokeTokensOpen(true)}
                                        disabled={saving}
                                        title="Invalidate all end-user OAuth tokens. Users will need to re-consent."
                                      >
                                        Revoke User Tokens
                                      </Button>
                                    )}
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        )}

                        {/* Auth type selector for integrations with multiple auth types */}
                        {integrationAuthTypeOptions.length > 0 && (
                          <Select
                            label={t('auth_type_label')}
                            options={integrationAuthTypeOptions}
                            value={currentProviderAuthType}
                            onChange={handleIntegrationAuthTypeChange}
                          />
                        )}

                        <Input
                          label={t('profile_name')}
                          value={name}
                          onChange={(e) => {
                            setName(e.target.value);
                            setIsDirty(true);
                            setFieldErrors((prev) => {
                              const next = { ...prev };
                              delete next.name;
                              return next;
                            });
                          }}
                          placeholder={`e.g. ${meta.label} - Production`}
                          error={fieldErrors.name}
                          disabled={isLegacyReadOnly}
                          required
                        />
                        <Input
                          label={t('description_label')}
                          value={description}
                          onChange={(e) => {
                            setDescription(e.target.value);
                            setIsDirty(true);
                          }}
                          placeholder={t('description_placeholder')}
                          disabled={isLegacyReadOnly}
                          optional
                        />

                        <Select
                          label={t('environment_label')}
                          options={ENVIRONMENT_OPTIONS}
                          value={environment}
                          onChange={(v) => {
                            setEnvironment(v);
                            setIsDirty(true);
                          }}
                          disabled={isLegacyReadOnly}
                        />

                        <div className="space-y-1.5">
                          <Select
                            label={t('usage_mode_label')}
                            options={usageModeOptions}
                            value={usageMode}
                            onChange={(value) => {
                              setUsageMode(value as AuthProfileUsageMode);
                              setIsDirty(true);
                            }}
                            disabled={isLegacyReadOnly || usageModeOptions.length <= 1}
                          />
                          {usageModeDescription && (
                            <p className="text-xs text-muted">{usageModeDescription}</p>
                          )}
                          {isWorkspaceScope &&
                            authType &&
                            AUTH_TYPE_USAGE_MODES[authType].some(
                              (m) => m === 'jit' || m === 'preflight',
                            ) && (
                              <p className="text-xs text-warning">{t('jit_disabled_workspace')}</p>
                            )}
                        </div>

                        {usageMode === 'preconfigured' && authType === 'oauth2_app' && (
                          <Toggle
                            label={t('connection_mode_label')}
                            description={
                              connectionMode === 'shared'
                                ? t('connection_mode_shared_description')
                                : t('connection_mode_per_user_description')
                            }
                            checked={connectionMode === 'shared'}
                            onChange={(checked) => {
                              setConnectionMode(checked ? 'shared' : 'per_user');
                              setIsDirty(true);
                            }}
                            disabled={isLegacyReadOnly}
                          />
                        )}

                        <Toggle
                          label={t('shared_label')}
                          description={
                            visibility === 'shared'
                              ? t('shared_description_on')
                              : t('shared_description_off')
                          }
                          checked={visibility === 'shared'}
                          onChange={(checked) => {
                            setVisibility(checked ? 'shared' : 'personal');
                            setIsDirty(true);
                          }}
                          disabled={isLegacyReadOnly}
                        />

                        {/* Connection Config Fields (template variables from Nango or provider metadata) */}
                        {connConfigFields.length > 0 && (
                          <div className="space-y-3">
                            <h3 className="text-xs font-medium text-muted uppercase tracking-wider">
                              {t('connection_config_heading')}
                            </h3>
                            {connConfigFields.map((fieldName) => {
                              const fieldMeta = connConfigMeta[fieldName];
                              const label = fieldMeta?.title ?? fieldName;
                              const placeholder = fieldMeta?.example ?? fieldName;
                              return (
                                <div key={fieldName} className="space-y-1.5">
                                  <Input
                                    label={label}
                                    type="text"
                                    value={connectionConfig[fieldName] ?? ''}
                                    onChange={(e) =>
                                      handleConnectionConfigChange(fieldName, e.target.value)
                                    }
                                    placeholder={placeholder}
                                  />
                                  {fieldMeta?.description && (
                                    <p className="text-xs text-muted">{fieldMeta.description}</p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {isLegacyReadOnly && (
                          <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-subtle p-3">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                            <div className="space-y-1">
                              <p className="text-sm font-medium text-foreground">
                                {t('legacy_readonly_title')}
                              </p>
                              <p className="text-sm text-foreground">{legacyReadOnlyMessage}</p>
                              {legacyMigration?.replacementAuthProfileId && (
                                <p className="text-xs text-muted">
                                  {t('legacy_linked_app', {
                                    profileId: legacyMigration.replacementAuthProfileId,
                                  })}
                                </p>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Integration API key: grouped header sections */}
                        {preselectedConnector?.apiKeyConfig && authType === 'api_key' ? (
                          <>
                            {preselectedConnector.apiKeyConfig?.additionalHeaders &&
                            preselectedConnector.apiKeyConfig.additionalHeaders.length > 0 ? (
                              /* Multiple headers — Configuration heading outside, each header grouped */
                              <div className="space-y-3">
                                <h3 className="text-xs font-medium text-muted uppercase tracking-wider">
                                  {t('configuration_heading')}
                                </h3>

                                {/* Primary API key header group */}
                                <div className="space-y-3 rounded-lg border border-default p-4">
                                  {meta.configFields
                                    .filter((field) => {
                                      if (field.key === 'placement') return false;
                                      if (
                                        field.key === 'prefix' &&
                                        !preselectedConnector.apiKeyConfig?.prefix
                                      ) {
                                        return false;
                                      }
                                      return true;
                                    })
                                    .map((field) => renderField(field, false))}
                                  <div className="border-t border-default pt-3 space-y-3">
                                    <h3 className="text-xs font-medium text-muted uppercase tracking-wider flex items-center gap-1.5">
                                      <Shield className="w-3 h-3" />
                                      {t('secrets_heading')}
                                    </h3>
                                    <p className="text-xs text-muted">{t('secrets_description')}</p>
                                    {meta.secretFields.map((field) => renderField(field, true))}
                                  </div>
                                </div>

                                {/* Additional header groups */}
                                {preselectedConnector.apiKeyConfig.additionalHeaders.map((h) => {
                                  const val =
                                    (
                                      config.additionalHeaders as Record<string, string> | undefined
                                    )?.[h.fieldKey] ?? '';
                                  return (
                                    <div
                                      key={h.fieldKey}
                                      className="space-y-3 rounded-lg border border-default p-4"
                                    >
                                      <Input
                                        label={t('additional_header_name')}
                                        type="text"
                                        value={h.headerName}
                                        disabled
                                        title={h.fieldMeta.description || h.headerName}
                                      />
                                      <Input
                                        label={t('additional_header_value')}
                                        type="text"
                                        value={String(val)}
                                        onChange={(e) => {
                                          const prev =
                                            (config.additionalHeaders as Record<string, string>) ??
                                            {};
                                          handleConfigChange('additionalHeaders', {
                                            ...prev,
                                            [h.fieldKey]: e.target.value,
                                          });
                                        }}
                                        placeholder={h.fieldMeta.example ?? h.defaultValue ?? ''}
                                        title={h.fieldMeta.description ?? ''}
                                      />
                                      {h.fieldMeta.description && (
                                        <p className="text-xs text-muted">
                                          {h.fieldMeta.description}
                                        </p>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              /* Single header — simple layout without nested groups */
                              <div className="space-y-3 rounded-lg border border-default p-4">
                                <h3 className="text-xs font-medium text-muted uppercase tracking-wider">
                                  {t('configuration_heading')}
                                </h3>
                                {meta.configFields
                                  .filter((field) => {
                                    if (field.key === 'placement') return false;
                                    if (
                                      field.key === 'prefix' &&
                                      !preselectedConnector.apiKeyConfig?.prefix
                                    ) {
                                      return false;
                                    }
                                    return true;
                                  })
                                  .map((field) => renderField(field, false))}
                                <div className="border-t border-default pt-3 space-y-3">
                                  <h3 className="text-xs font-medium text-muted uppercase tracking-wider flex items-center gap-1.5">
                                    <Shield className="w-3 h-3" />
                                    {t('secrets_heading')}
                                  </h3>
                                  <p className="text-xs text-muted">{t('secrets_description')}</p>
                                  {meta.secretFields.map((field) => renderField(field, true))}
                                </div>
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {meta.configFields.length > 0 && (
                              <div className="space-y-3">
                                <h3 className="text-xs font-medium text-muted uppercase tracking-wider">
                                  {t('configuration_heading')}
                                </h3>
                                {meta.configFields.map((field) => renderField(field, false))}
                                {authType === 'oauth2_app' && <RedirectUriField />}
                              </div>
                            )}

                            {meta.secretFields.length > 0 && (
                              <div className="space-y-3">
                                <h3 className="text-xs font-medium text-muted uppercase tracking-wider flex items-center gap-1.5">
                                  <Shield className="w-3 h-3" />
                                  {t('secrets_heading')}
                                </h3>
                                <p className="text-xs text-muted">{t('secrets_description')}</p>
                                {meta.secretFields.map((field) => renderField(field, true))}
                              </div>
                            )}
                          </>
                        )}

                        {error && <p className="text-sm text-error">{error}</p>}
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                );
              })()}
            </div>

            {/* Picker footer — Continue only. Close via the header X.
                Continue is enabled once a connector is selected. */}
            {step === 'select-connector' && (
              <div className="shrink-0 px-5 py-4 border-t border-default flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    if (pickerSelectedProvider) handleConnectorPick(pickerSelectedProvider);
                  }}
                  disabled={!pickerSelectedProvider}
                >
                  Continue
                </Button>
              </div>
            )}

            {/* Footer
                Left:  Re-authorize / Authorize (OAuth profiles in edit mode only).
                Right: optional Test result chip, Test button, Save Changes (or
                       Create Profile in create mode). Save is disabled until
                       the form is dirty so accidental empty saves are avoided.
                Revoke lives on the list-page row kebab — not in the slide-over.*/}
            {step === 'form' && meta && (
              <div className="shrink-0 px-5 py-4 border-t border-default flex items-center justify-between gap-2">
                {/* Left cluster */}
                <div className="flex items-center gap-2">
                  {isEdit &&
                    editProfileId &&
                    (resolvedProfile?.authType === 'oauth2_app' ||
                      (resolvedProfile?.authType === 'oauth2_client_credentials' &&
                        !!resolvedProfile?.connector)) &&
                    (resolvedProfile?.status === 'active' ||
                      resolvedProfile?.status === 'pending_authorization' ||
                      resolvedProfile?.status === 'revoked') && (
                      <Button
                        variant={
                          resolvedProfile?.status === 'pending_authorization' ||
                          resolvedProfile?.status === 'revoked'
                            ? 'primary'
                            : 'secondary'
                        }
                        size="sm"
                        onClick={() => setOauthDialogOpen(true)}
                        disabled={saving}
                        icon={<ShieldCheck className="w-3.5 h-3.5" />}
                      >
                        {resolvedProfile.isAuthorized &&
                        resolvedProfile?.status !== 'pending_authorization'
                          ? 'Re-authorize'
                          : 'Authorize'}
                      </Button>
                    )}
                </div>

                {/* Right cluster */}
                <div className="flex items-center gap-2">
                  {/* Test result chip — inline, next to Test button */}
                  {testResult && (
                    <span
                      className={clsx(
                        'inline-flex items-center gap-1.5 text-xs font-medium',
                        testResult.valid ? 'text-success' : 'text-error',
                      )}
                    >
                      {testResult.valid ? (
                        <CheckCircle className="w-3.5 h-3.5" />
                      ) : (
                        <AlertTriangle className="w-3.5 h-3.5" />
                      )}
                      {testResult.valid
                        ? t('credentials_valid')
                        : (testResult.message ?? t('validation_failed'))}
                    </span>
                  )}
                  {/* Test Credentials — non-OAuth types only (Authorize IS the
                      test for OAuth). Hidden for revoked/expired since the
                      validate endpoint rejects those statuses. */}
                  {isEdit &&
                    resolvedProfile?.authType !== 'oauth2_app' &&
                    resolvedProfile?.authType !== 'oauth2_token' &&
                    resolvedProfile?.status !== 'revoked' &&
                    resolvedProfile?.status !== 'expired' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleTest}
                        loading={testing}
                        disabled={saving || isLegacyReadOnly}
                      >
                        {t('test_credentials')}
                      </Button>
                    )}
                  {/* Back to picker — only when creating via the in-panel picker
                      flow (not edit, no external preselection, internal pick exists).*/}
                  {!isEdit && !externalPreselectedConnector && internalPreselectedConnector && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setStep('select-connector');
                        setInternalPreselectedConnector(undefined);
                        setAuthType(null);
                      }}
                    >
                      <ArrowLeft className="w-3.5 h-3.5 mr-1" />
                      Back
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={handleSave}
                    loading={saving}
                    disabled={isLegacyReadOnly || (isEdit && !isDirty)}
                    title={isEdit && !isDirty ? 'No changes to save' : undefined}
                  >
                    {isEdit ? t('save_changes') : t('create_profile')}
                  </Button>
                </div>
              </div>
            )}
          </motion.div>
        </>
      )}

      {/* ABLP-913: OAuth dialog for Authorize CTA (edit mode).
          Renders for both connector-backed and custom oauth2_app profiles. */}
      {editProfileId &&
        resolvedProfile &&
        (resolvedProfile.authType === 'oauth2_app' ||
          (resolvedProfile.authType === 'oauth2_client_credentials' &&
            !!resolvedProfile.connector)) && (
          <AuthProfileOAuthDialog
            open={oauthDialogOpen}
            scope={isWorkspaceScope ? 'workspace' : 'project'}
            {...(isWorkspaceScope ? {} : { projectId })}
            authProfileId={editProfileId}
            connectorName={resolvedProfile.connector || undefined}
            displayName={resolvedProfile.name ?? resolvedProfile.connector ?? 'OAuth'}
            onSuccess={() => {
              setOauthDialogOpen(false);
              // Re-fetch so the badge and lastAuthorizedAt reflect the new grant.
              refreshResolvedProfile();
              onSaved();
            }}
            onClose={() => setOauthDialogOpen(false)}
          />
        )}

      {/* ABLP-913: Post-create authorize handoff. Auto-opens after a new
          OAuth profile is created so the user lands directly in the
          authorize popup instead of needing a second click in the list. */}
      {pendingAuthorizeProfile && (
        <AuthProfileOAuthDialog
          open
          scope={isWorkspaceScope ? 'workspace' : 'project'}
          {...(isWorkspaceScope ? {} : { projectId })}
          authProfileId={pendingAuthorizeProfile.id}
          connectorName={pendingAuthorizeProfile.connector}
          displayName={pendingAuthorizeProfile.name}
          onSuccess={() => {
            setPendingAuthorizeProfile(null);
            // Refresh the slide-over's displayed profile if it happens to match,
            // so the badge updates immediately rather than on next open.
            refreshResolvedProfile();
            onSaved();
          }}
          onClose={() => {
            // User dismissed without authorizing — still treat as saved so
            // the list refreshes; the profile lands in "To be Authorized".
            setPendingAuthorizeProfile(null);
            onSaved();
          }}
        />
      )}

      {/* ABLP-913: Revoke Profile modal */}
      {editProfileId && (
        <RevokeProfileConfirm
          open={revokeProfileOpen}
          onClose={() => setRevokeProfileOpen(false)}
          onRevoked={() => {
            setRevokeProfileOpen(false);
            onSaved();
          }}
          projectId={projectId}
          profileId={editProfileId}
          profileName={resolvedProfile?.name ?? ''}
        />
      )}

      {/* ABLP-913: Revoke User Tokens modal */}
      {editProfileId && (
        <RevokeUserTokensConfirm
          open={revokeTokensOpen}
          onClose={() => setRevokeTokensOpen(false)}
          onRevoked={() => {
            setRevokeTokensOpen(false);
            onSaved();
          }}
          projectId={projectId}
          profileId={editProfileId}
          profileName={resolvedProfile?.name ?? ''}
        />
      )}
    </AnimatePresence>
  );
}
