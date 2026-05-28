/**
 * HttpConfigForm Component
 *
 * Config form for HTTP tool type: endpoint, method, auth, headers, resilience.
 * Validates all fields client-side to match backend rules.
 */

import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff, Plus, Trash2, Wand2 } from 'lucide-react';
import { normalizeHttpAuthConfig } from '@agent-platform/shared/tools';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { Toggle } from '../ui/Toggle';
import { AuthProfilePicker } from '../auth-profiles/AuthProfilePicker';
import { useAuthProfiles } from '../../hooks/useAuthProfiles';
import type { AuthType } from '../../api/auth-profiles';
import type {
  HeaderEntry,
  QueryParamEntry,
  HttpConfig,
  HttpAuthConfig,
  BodyType,
  ParameterDefinition,
  Protocol,
  SoapVersion,
  OnSoapFault,
  HttpAuthType,
  RuntimeNumericValue,
} from './shared-types';
import { ParameterEditor } from './ParameterEditor';

export type { HttpConfig } from './shared-types';

interface HttpConfigFormProps {
  config: HttpConfig;
  onChange: (config: HttpConfig) => void;
  showTemplates?: boolean;
  projectId?: string | null;
}

const METHOD_OPTIONS = [
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'PATCH', label: 'PATCH' },
  { value: 'DELETE', label: 'DELETE' },
  { value: 'HEAD', label: 'HEAD' },
  { value: 'OPTIONS', label: 'OPTIONS' },
];

const BODY_TYPE_OPTIONS = [
  { value: 'json', label: 'JSON' },
  { value: 'form', label: 'Form Data' },
  { value: 'xml', label: 'XML' },
  { value: 'text', label: 'Plain Text' },
];

// Methods that support request body
const METHODS_WITH_BODY = ['POST', 'PUT', 'PATCH'];

// Body templates for different content types
const BODY_TEMPLATES = {
  json: `{
  "field1": "{{input.param1}}",
  "field2": "{{secrets.API_VALUE}}",
  "nested": {
    "key": "value"
  }
}`,
  form: `key1={{input.param1}}&key2={{secrets.VALUE}}&key3=static_value`,
  xml: `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <field1>{{input.param1}}</field1>
  <field2>{{secrets.API_VALUE}}</field2>
</request>`,
  text: `Plain text with {{input.param1}} and {{secrets.VALUE}} variables`,
  soap: `<ns:OperationRequest xmlns:ns="http://example.com/service">
  <ns:Parameter>{{input.param1}}</ns:Parameter>
</ns:OperationRequest>`,
};

const BLOCKED_PROTOCOLS = ['file:', 'gopher:', 'dict:'];
const EMPTY_AUTH_CONFIG: HttpAuthConfig = Object.freeze({});
const CONFIG_NUMERIC_TEMPLATE_RE = /^\{\{config\.[A-Za-z_][A-Za-z0-9_]*\}\}$/;
const INTEGER_DRAFT_RE = /^-?\d+$/;

interface CustomHeaderDraft extends HeaderEntry {
  id: string;
}

/** Validate a URL — returns error string or null. Handles template variables. */
function validateUrl(value: string, label: string): string | undefined {
  if (!value) return `${label} is required`;
  // Skip URL parse validation if the endpoint contains template variables —
  // {{input.X}}, {{secrets.X}}, etc. are resolved at runtime and break new URL().
  if (/\{\{.+?\}\}/.test(value)) {
    // Still check that it starts with http(s) before any templates
    if (!/^https?:\/\//.test(value)) {
      return `${label} must use http:// or https://`;
    }
    return undefined;
  }
  try {
    const url = new URL(value);
    if (BLOCKED_PROTOCOLS.includes(url.protocol)) {
      return `Blocked protocol: ${url.protocol}`;
    }
    if (!url.protocol.startsWith('http')) {
      return `${label} must use http:// or https://`;
    }
  } catch {
    return `${label} must be a valid URL`;
  }
  return undefined;
}

function isConfigNumericTemplate(value: unknown): value is Extract<RuntimeNumericValue, string> {
  return typeof value === 'string' && CONFIG_NUMERIC_TEMPLATE_RE.test(value);
}

function parseRuntimeNumericDraft(
  raw: string,
  fallback: number,
  options: { allowUndefined?: boolean } = {},
): RuntimeNumericValue | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return options.allowUndefined ? undefined : fallback;
  }
  if (CONFIG_NUMERIC_TEMPLATE_RE.test(trimmed)) {
    return trimmed as Extract<RuntimeNumericValue, string>;
  }
  if (INTEGER_DRAFT_RE.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed as Extract<RuntimeNumericValue, string>;
}

function runtimeNumericInputValue(
  value: RuntimeNumericValue | undefined,
  fallback?: number,
): string | number {
  return value ?? fallback ?? '';
}

function validateRuntimeNumericDraft(
  value: RuntimeNumericValue | undefined,
  options: {
    min?: number;
    max?: number;
    message: string;
    requiredMessage?: string;
  },
): string | undefined {
  if (value === undefined) {
    return options.requiredMessage;
  }
  if (typeof value === 'string') {
    return isConfigNumericTemplate(value)
      ? undefined
      : 'Must be a number or exact {{config.KEY}} placeholder';
  }
  if (options.min !== undefined && value < options.min) {
    return options.message;
  }
  if (options.max !== undefined && value > options.max) {
    return options.message;
  }
  return undefined;
}

const OAUTH2_CLIENT_AUTH_PROFILE_TYPES: AuthType[] = ['oauth2_client_credentials', 'azure_ad'];
const CUSTOM_AUTH_PROFILE_TYPES: AuthType[] = [
  'basic',
  'custom_header',
  'aws_iam',
  'mtls',
  'ssh_key',
  'digest',
  'kerberos',
  'saml',
  'hawk',
  'ws_security',
];

export function getAuthProfileTypeFilter(
  authType: HttpConfig['authType'] | undefined,
): AuthType[] | undefined {
  switch (authType) {
    case 'api_key':
      return ['api_key'];
    case 'bearer':
      return ['bearer'];
    case 'oauth2_client':
      return OAUTH2_CLIENT_AUTH_PROFILE_TYPES;
    case 'oauth2_user':
      return ['oauth2_app'];
    case 'custom':
      return CUSTOM_AUTH_PROFILE_TYPES;
    default:
      return undefined;
  }
}

/**
 * Extract all `{{input.paramName}}` references from HTTP config surfaces
 * (endpoint, body, headers, query params, authConfig values).
 *
 * Standard convention: all parameter references use the `{{input.X}}` namespace.
 */
export function extractInputReferences(config: HttpConfig): string[] {
  const refs = new Set<string>();
  const extract = (text: string | undefined) => {
    if (!text) return;
    for (const m of text.matchAll(/\{\{input\.(\w+)\}\}/g)) refs.add(m[1]);
  };

  extract(config.endpoint);
  extract(config.body);
  if (Array.isArray(config.headers)) {
    for (const h of config.headers) {
      extract(h.key);
      extract(h.value);
    }
  }
  if (Array.isArray(config.queryParams)) {
    for (const q of config.queryParams) {
      extract(q.key);
      extract(q.value);
    }
  }
  const authConfig = normalizeHttpAuthConfig(config.authType, config.authConfig, {
    authProfileRef: config.authProfileRef,
  });
  if (authConfig) {
    const { customHeaders, ...scalarFields } = authConfig;
    for (const value of Object.values(scalarFields)) {
      if (typeof value === 'string') extract(value);
    }
    if (customHeaders) {
      for (const v of Object.values(customHeaders)) extract(v);
    }
  }
  return [...refs];
}

/**
 * Parse `{{input.*}}` references into ParameterDefinition stubs.
 * Only creates new entries for references not already defined.
 */
export function parseParametersFromHttpConfig(config: HttpConfig): ParameterDefinition[] {
  const refs = extractInputReferences(config);
  const existing = new Set((config.parameters ?? []).map((p) => p.name));
  const newParams: ParameterDefinition[] = [];

  for (const name of refs) {
    if (!existing.has(name)) {
      newParams.push({
        name,
        type: 'string',
        description: '',
        required: true,
      });
    }
  }

  return [...(config.parameters ?? []), ...newParams];
}

/** Validate full HTTP config — returns map of field→error */
export function validateHttpConfig(config: HttpConfig): Record<string, string> {
  const errors: Record<string, string> = {};
  const endpointErr = validateUrl(config.endpoint || '', 'Endpoint URL');
  if (endpointErr) errors.endpoint = endpointErr;

  if (!config.method) errors.method = 'Method is required';

  const authProfileRef = config.authProfileRef?.trim() ?? '';
  const hasAuthProfileRef = authProfileRef.length > 0;
  if (config.authProfileRef !== undefined && config.authProfileRef.trim().length === 0) {
    errors.authProfileRef = 'Auth profile reference is required';
  }
  if (config.authJit && !hasAuthProfileRef) {
    errors.authProfileRef = 'Auth profile reference is required when JIT auth is enabled';
  }

  const ac = config.authConfig || {};
  if (!hasAuthProfileRef && config.authType === 'api_key') {
    if (!ac.headerName?.trim()) errors['authConfig.headerName'] = 'Header name is required';
    if (!ac.apiKey?.trim()) errors['authConfig.apiKey'] = 'API key is required';
  }
  if (!hasAuthProfileRef && config.authType === 'bearer') {
    if (!ac.token?.trim()) errors['authConfig.token'] = 'Token is required';
  }
  if (config.authType === 'oauth2_client') {
    if (!hasAuthProfileRef) {
      if (!ac.clientId?.trim()) errors['authConfig.clientId'] = 'Client ID is required';
      if (!ac.clientSecret?.trim()) errors['authConfig.clientSecret'] = 'Client secret is required';
      if (!ac.tokenUrl?.trim()) {
        errors['authConfig.tokenUrl'] = 'Token URL is required';
      } else {
        const tokenUrlErr = validateUrl(ac.tokenUrl, 'Token URL');
        if (tokenUrlErr) errors['authConfig.tokenUrl'] = tokenUrlErr;
      }
    }
  }
  if (!hasAuthProfileRef && config.authType === 'oauth2_user') {
    if (!ac.provider?.trim()) errors['authConfig.provider'] = 'OAuth provider is required';
  }

  // Check for auth header collisions with general headers
  if (config.headers?.length) {
    const generalHeaderKeys = new Set(
      config.headers.map((h) => h.key.toLowerCase()).filter(Boolean),
    );

    if (config.authType === 'api_key' && ac.headerName) {
      if (generalHeaderKeys.has(ac.headerName.toLowerCase())) {
        errors.headerCollision = `Header "${ac.headerName}" is already set by API Key auth — remove it from general headers to avoid conflicts`;
      }
    }
    if (config.authType === 'bearer' && generalHeaderKeys.has('authorization')) {
      errors.headerCollision =
        'Authorization header is already set by Bearer auth — remove it from general headers to avoid conflicts';
    }
    if (config.authType === 'custom' && ac.customHeaders) {
      const customKeys = Object.keys(ac.customHeaders).map((k) => k.toLowerCase());
      const colliding = customKeys.filter((k) => generalHeaderKeys.has(k));
      if (colliding.length > 0) {
        errors.headerCollision = `Header${colliding.length > 1 ? 's' : ''} "${colliding.join('", "')}" set in both custom auth and general headers — remove duplicates to avoid conflicts`;
      }
    }
  }

  // Validate body schema if using schema-based body
  if (config.useBodySchema && config.bodySchema && config.bodySchema.trim()) {
    try {
      const parsed = JSON.parse(config.bodySchema);
      if (!parsed.type || !parsed.properties) {
        errors.bodySchema = 'Body schema must have "type" and "properties" fields';
      }
    } catch {
      errors.bodySchema = 'Invalid JSON Schema format';
    }
  }

  // Validate body template if using schema
  if (config.useBodySchema && config.body && config.body.trim()) {
    try {
      JSON.parse(config.body);
    } catch {
      errors.body = 'Invalid JSON format in body template';
    }
  }

  const timeoutError = validateRuntimeNumericDraft(config.timeoutMs ?? 30000, {
    min: 100,
    max: 300000,
    message: 'Must be 100-300000ms',
  });
  if (timeoutError) errors.timeoutMs = timeoutError;

  const retryCountError = validateRuntimeNumericDraft(config.retryCount ?? 0, {
    min: 0,
    max: 10,
    message: 'Must be 0–10',
  });
  if (retryCountError) errors.retryCount = retryCountError;

  const retryDelayError = validateRuntimeNumericDraft(config.retryDelayMs ?? 1000, {
    min: 100,
    message: 'Min 100ms',
  });
  if (retryDelayError) errors.retryDelayMs = retryDelayError;

  const rateLimitError = validateRuntimeNumericDraft(config.rateLimitPerMinute, {
    min: 1,
    message: 'Must be at least 1',
  });
  if (rateLimitError) errors.rateLimitPerMinute = rateLimitError;

  if (config.circuitBreaker) {
    const thresholdError = validateRuntimeNumericDraft(config.circuitBreaker.threshold, {
      min: 1,
      message: 'Threshold must be at least 1',
      requiredMessage: 'Threshold is required',
    });
    if (thresholdError) errors.circuitBreakerThreshold = thresholdError;

    const resetMsError = validateRuntimeNumericDraft(config.circuitBreaker.resetMs, {
      min: 1000,
      message: 'Reset time must be at least 1000ms',
      requiredMessage: 'Reset time is required',
    });
    if (resetMsError) errors.circuitBreakerResetMs = resetMsError;
  }

  // Validate referenced parameters are defined
  const refs = extractInputReferences(config);
  if (refs.length > 0) {
    const defined = new Set((config.parameters ?? []).map((p) => p.name));
    const missing = refs.filter((r) => !defined.has(r));
    if (missing.length > 0) {
      errors.parameters = `Referenced parameters not defined: ${missing.join(', ')}. Add them in the Parameters section or use the Parse button.`;
    }
  }

  return errors;
}

/**
 * Format JSON that may contain {{…}} template variables.
 * Temporarily replaces variables with safe placeholders, formats, then restores.
 */
function formatJsonWithTemplates(raw: string): string {
  const placeholders: { original: string; quoted: boolean }[] = [];
  const safe = raw.replace(/"?\{\{[^}]+\}\}"?/g, (match) => {
    const quoted = match.startsWith('"') && match.endsWith('"');
    const original = quoted ? match.slice(1, -1) : match;
    const idx = placeholders.length;
    placeholders.push({ original, quoted });
    return `"__TPL_${idx}__"`;
  });

  try {
    let formatted = JSON.stringify(JSON.parse(safe), null, 2);
    placeholders.forEach(({ original, quoted }, i) => {
      const restore = quoted ? `"${original}"` : original;
      formatted = formatted.replace(`"__TPL_${i}__"`, restore);
    });
    return formatted;
  } catch {
    return raw;
  }
}

function normalizeCustomHeaders(raw: unknown): Record<string, string> {
  if (!raw) return {};

  // Handle legacy JSON-string format gracefully
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      }
    } catch {
      return {};
    }
  }

  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  }

  return {};
}

/** Stable serialization for identity comparison (not stored — only used for diffing). */
function stableCustomHeaderKey(record: Record<string, string>): string {
  return JSON.stringify(record);
}

function sharedAuthConfigToStudioAuthConfig(
  authConfig: ReturnType<typeof normalizeHttpAuthConfig>,
): HttpAuthConfig | undefined {
  if (!authConfig) return undefined;

  const studioAuthConfig: HttpAuthConfig = {};
  if (authConfig.token) studioAuthConfig.token = authConfig.token;
  if (authConfig.apiKey) studioAuthConfig.apiKey = authConfig.apiKey;
  if (authConfig.tokenUrl) studioAuthConfig.tokenUrl = authConfig.tokenUrl;
  if (authConfig.clientId) studioAuthConfig.clientId = authConfig.clientId;
  if (authConfig.clientSecret) studioAuthConfig.clientSecret = authConfig.clientSecret;
  if (authConfig.scopes) studioAuthConfig.scopes = authConfig.scopes;
  if (authConfig.headerName) studioAuthConfig.headerName = authConfig.headerName;
  if (authConfig.provider) studioAuthConfig.provider = authConfig.provider;
  if (authConfig.customHeaders) {
    studioAuthConfig.customHeaders = authConfig.customHeaders;
  }

  return Object.keys(studioAuthConfig).length > 0 ? studioAuthConfig : undefined;
}

function normalizeStudioAuthConfig(
  authType: HttpAuthType,
  authConfig: HttpConfig['authConfig'],
  authProfileRef: HttpConfig['authProfileRef'],
): HttpAuthConfig | undefined {
  return sharedAuthConfigToStudioAuthConfig(
    normalizeHttpAuthConfig(authType, authConfig, { authProfileRef }),
  );
}

function buildCustomHeaderRecord(drafts: CustomHeaderDraft[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const draft of drafts) {
    record[draft.key] = draft.value;
  }
  return record;
}

function reconcileCustomHeaderDrafts(
  drafts: CustomHeaderDraft[],
  entries: Array<[string, string]>,
  createDraft: (key: string, value: string) => CustomHeaderDraft,
): CustomHeaderDraft[] {
  if (drafts.length === 0) {
    return entries.map(([key, value]) => createDraft(key, value));
  }

  const incomingByKey = new Map(entries);
  const nextDrafts: CustomHeaderDraft[] = [];
  let changed = drafts.length !== entries.length;

  for (const draft of drafts) {
    if (!incomingByKey.has(draft.key)) {
      changed = true;
      continue;
    }

    const incomingValue = incomingByKey.get(draft.key) ?? '';
    if (incomingValue !== draft.value) {
      changed = true;
      nextDrafts.push({ ...draft, value: incomingValue });
    } else {
      nextDrafts.push(draft);
    }

    incomingByKey.delete(draft.key);
  }

  if (incomingByKey.size > 0) {
    changed = true;
    for (const [key, value] of entries) {
      if (!incomingByKey.has(key)) continue;
      nextDrafts.push(createDraft(key, value));
      incomingByKey.delete(key);
    }
  }

  return changed ? nextDrafts : drafts;
}

const TEXTAREA_CLASS =
  'w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm font-mono p-3 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus resize-y';

const KV_INPUT_CLASS =
  'flex-1 rounded-lg border bg-background-subtle text-foreground text-sm px-3 py-2 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus placeholder:text-subtle';

/** Reusable key-value row with consistent design tokens and a delete button. */
function KeyValueRow({
  keyValue,
  valueValue,
  keyPlaceholder,
  valuePlaceholder,
  onKeyChange,
  onValueChange,
  onRemove,
  keyError,
}: {
  keyValue: string;
  valueValue: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  onKeyChange: (v: string) => void;
  onValueChange: (v: string) => void;
  onRemove: () => void;
  keyError?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        placeholder={keyPlaceholder}
        value={keyValue}
        onChange={(e) => onKeyChange(e.target.value)}
        className={`${KV_INPUT_CLASS} ${keyError ? 'border-error' : 'border-default'}`}
      />
      <input
        placeholder={valuePlaceholder}
        value={valueValue}
        onChange={(e) => onValueChange(e.target.value)}
        className={`${KV_INPUT_CLASS} border-default`}
      />
      <Button variant="ghost" size="sm" onClick={onRemove} className="shrink-0">
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function HttpConfigForm({
  config,
  onChange,
  showTemplates = true,
  projectId,
}: HttpConfigFormProps) {
  const t = useTranslations('tools.http_config');
  const tc = useTranslations('tools.config');

  const AUTH_OPTIONS = useMemo(
    () => [
      { value: 'none', label: t('auth_none') },
      { value: 'api_key', label: t('auth_api_key') },
      { value: 'bearer', label: t('auth_bearer') },
      { value: 'oauth2_client', label: t('auth_oauth2') },
      { value: 'oauth2_user', label: t('auth_oauth2_user') },
      { value: 'custom', label: t('auth_custom') },
    ],
    [t],
  );
  const CONSENT_OPTIONS = useMemo(
    () => [
      { value: 'inline', label: t('consent_mode_inline') },
      { value: 'preflight', label: t('consent_mode_preflight') },
    ],
    [t],
  );
  const CONNECTION_OPTIONS = useMemo(
    () => [
      { value: 'shared', label: t('connection_mode_shared') },
      { value: 'per_user', label: t('connection_mode_per_user') },
    ],
    [t],
  );

  const update = (field: string, value: unknown) => {
    onChange({ ...config, [field]: value });
  };

  const authType = config.authType || 'none';
  const usesTemplatedAuthProfileRef = (config.authProfileRef?.includes('{{') ?? false) === true;
  const canUseAuthProfilePicker = Boolean(projectId) && !usesTemplatedAuthProfileRef;
  const { profiles: selectableProfiles } = useAuthProfiles(
    canUseAuthProfilePicker ? projectId! : null,
    {
      status: 'active',
      // ABLP-913 §8: HTTP tools may only reference Custom auth profiles.
      profileType: 'custom',
      limit: 200,
    },
  );
  const authProfileTypeFilter = useMemo(
    () => getAuthProfileTypeFilter(config.authType),
    [config.authType],
  );
  const selectedAuthProfileId = useMemo(() => {
    if (!canUseAuthProfilePicker) return null;
    const authProfileRef = config.authProfileRef?.trim();
    if (!authProfileRef) return null;
    const matchingProfiles = selectableProfiles.filter(
      (profile) => profile.name === authProfileRef,
    );
    if (matchingProfiles.length === 0) return null;
    const projectScoped = matchingProfiles.find((profile) => profile.scope === 'project');
    return (projectScoped ?? matchingProfiles[0]).id;
  }, [canUseAuthProfilePicker, config.authProfileRef, selectableProfiles]);

  // When the active-only resolution fails (profile revoked/expired), fetch
  // without status filter so the picker receives the real ID and can show
  // the correct status badge instead of a generic "Unavailable" label.
  const needsStaleResolution =
    canUseAuthProfilePicker && !!config.authProfileRef?.trim() && !selectedAuthProfileId;
  const { profiles: staleResolutionProfiles } = useAuthProfiles(
    needsStaleResolution ? projectId! : null,
    { profileType: 'custom', limit: 200 },
  );
  const resolvedStaleProfileId = useMemo(() => {
    if (!needsStaleResolution) return null;
    const authProfileRef = config.authProfileRef?.trim();
    if (!authProfileRef) return null;
    const matching = staleResolutionProfiles.filter((p) => p.name === authProfileRef);
    if (matching.length === 0) return null;
    const projectScoped = matching.find((p) => p.scope === 'project');
    return (projectScoped ?? matching[0]).id;
  }, [needsStaleResolution, config.authProfileRef, staleResolutionProfiles]);

  const authConfig = config.authConfig ?? EMPTY_AUTH_CONFIG;
  const updateAuthConfig = <K extends keyof HttpAuthConfig>(field: K, value: HttpAuthConfig[K]) => {
    update(
      'authConfig',
      normalizeStudioAuthConfig(authType, { ...authConfig, [field]: value }, config.authProfileRef),
    );
  };
  const updateAuthType = (value: string) => {
    const nextAuthType = value as HttpAuthType;
    // ABLP-913: clear any stale auth profile reference when the new authType
    // does not support one (e.g. switching to 'none'). Otherwise the runtime
    // tool middleware reads tool.auth_profile_ref and applies the bound profile
    // even though the UI shows no auth.
    const supportsProfileRef = getAuthProfileTypeFilter(nextAuthType) !== undefined;
    const nextProfileRef = supportsProfileRef ? config.authProfileRef : undefined;
    onChange({
      ...config,
      authType: nextAuthType,
      authProfileRef: nextProfileRef,
      authConfig: normalizeStudioAuthConfig(nextAuthType, authConfig, nextProfileRef),
    });
  };
  const hasAuthProfileRef = (config.authProfileRef?.trim().length ?? 0) > 0;
  const customHeaderIdRef = useRef(0);
  const nextCustomHeaderDraft = (key: string, value: string): CustomHeaderDraft => ({
    id: `custom-auth-header-${customHeaderIdRef.current++}`,
    key,
    value,
  });
  const [customHeaderDrafts, setCustomHeaderDrafts] = useState<CustomHeaderDraft[]>(() =>
    Object.entries(normalizeCustomHeaders(config.authConfig?.customHeaders)).map(([key, value]) =>
      nextCustomHeaderDraft(key, value),
    ),
  );
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});
  const lastCustomHeaderSerializedRef = useRef(
    stableCustomHeaderKey(normalizeCustomHeaders(config.authConfig?.customHeaders)),
  );
  const skipNextCustomHeaderSyncRef = useRef(false);

  const isSecretVisible = (key: string) => visibleSecrets[key] === true;
  const toggleSecretVisibility = (key: string) => {
    setVisibleSecrets((current) => ({ ...current, [key]: !current[key] }));
  };

  useEffect(() => {
    const incomingRecord = normalizeCustomHeaders(authConfig.customHeaders);
    const incomingEntries = Object.entries(incomingRecord);
    const incomingSerialized = stableCustomHeaderKey(incomingRecord);

    if (
      skipNextCustomHeaderSyncRef.current &&
      incomingSerialized === lastCustomHeaderSerializedRef.current
    ) {
      skipNextCustomHeaderSyncRef.current = false;
      return;
    }

    lastCustomHeaderSerializedRef.current = incomingSerialized;
    setCustomHeaderDrafts((currentDrafts) => {
      // Preserve local draft IDs even when an external update reorders keys.
      // Tool Detail state updates can send renamed headers back in a different
      // object order, and rebuilding rows would remount the focused input.
      return reconcileCustomHeaderDrafts(currentDrafts, incomingEntries, nextCustomHeaderDraft);
    });
  }, [authConfig]);

  const persistCustomHeaderDrafts = (nextDrafts: CustomHeaderDraft[]) => {
    const nextRecord = buildCustomHeaderRecord(nextDrafts);
    lastCustomHeaderSerializedRef.current = stableCustomHeaderKey(nextRecord);
    skipNextCustomHeaderSyncRef.current = true;
    updateAuthConfig('customHeaders', nextRecord);
  };

  // headers can come as an object {key: value} from DB or as HeaderEntry[] from the form
  const headers: HeaderEntry[] = Array.isArray(config.headers)
    ? config.headers
    : config.headers && typeof config.headers === 'object'
      ? Object.entries(config.headers).map(([key, value]) => ({ key, value: String(value) }))
      : [];

  const addHeader = () => {
    update('headers', [...headers, { key: '', value: '' }]);
  };

  const removeHeader = (index: number) => {
    update(
      'headers',
      headers.filter((_, i) => i !== index),
    );
  };

  const updateHeader = (index: number, field: 'key' | 'value', value: string) => {
    const updated = headers.map((h, i) => (i === index ? { ...h, [field]: value } : h));
    update('headers', updated);
  };

  // Query params handlers
  const queryParams: QueryParamEntry[] = Array.isArray(config.queryParams)
    ? config.queryParams
    : config.queryParams && typeof config.queryParams === 'object'
      ? Object.entries(config.queryParams).map(([key, value]) => ({ key, value: String(value) }))
      : [];

  const addQueryParam = () => {
    update('queryParams', [...queryParams, { key: '', value: '' }]);
  };

  const removeQueryParam = (index: number) => {
    update(
      'queryParams',
      queryParams.filter((_, i) => i !== index),
    );
  };

  const updateQueryParam = (index: number, field: 'key' | 'value', value: string) => {
    const updated = queryParams.map((q, i) => (i === index ? { ...q, [field]: value } : q));
    update('queryParams', updated);
  };

  const formatBody = useCallback(() => {
    update('body', formatJsonWithTemplates(config.body || ''));
  }, [config.body]);

  const formatSchema = useCallback(() => {
    update('bodySchema', formatJsonWithTemplates(config.bodySchema || ''));
  }, [config.bodySchema]);

  // Only show errors after user has interacted (field has a value)
  const touched = (val: string | undefined) => !!val && val.length > 0;
  const errors = validateHttpConfig(config);

  return (
    <div className="space-y-4">
      {/* Protocol toggle — must come first: selecting SOAP locks method + body type */}
      <Select
        label={t('protocol')}
        testid="http-config-protocol"
        options={[
          { value: 'rest', label: t('protocol_rest') },
          { value: 'soap', label: t('protocol_soap') },
        ]}
        value={config.protocol ?? 'rest'}
        onChange={(v) => {
          const proto = v as Protocol;
          const updates: Partial<HttpConfig> = { protocol: proto };
          if (proto === 'soap') {
            updates.method = 'POST';
            updates.bodyType = 'xml';
            if (!config.body) {
              updates.body = BODY_TEMPLATES.soap;
            }
            updates.soapVersion = config.soapVersion ?? '1.1';
          } else {
            updates.soapVersion = undefined;
            updates.soapAction = undefined;
            updates.onSoapFault = undefined;
          }
          onChange({ ...config, ...updates });
        }}
      />

      <Input
        label={t('endpoint_url_label')}
        placeholder={t('endpoint_url_placeholder')}
        value={config.endpoint || ''}
        onChange={(e) => update('endpoint', e.target.value)}
        error={touched(config.endpoint) ? errors.endpoint : undefined}
      />

      {/* SOAP-specific fields */}
      {config.protocol === 'soap' && (
        <div
          className="space-y-4 p-4 rounded-lg bg-background-subtle border border-default"
          data-testid="soap-fields"
        >
          <Select
            label={t('soap_version')}
            testid="soap-version-select"
            options={[
              { value: '1.1', label: 'SOAP 1.1' },
              { value: '1.2', label: 'SOAP 1.2' },
            ]}
            value={config.soapVersion ?? '1.1'}
            onChange={(v) => onChange({ ...config, soapVersion: v as SoapVersion })}
          />
          <Input
            label={t('soap_action')}
            placeholder={t('soap_action_placeholder')}
            value={config.soapAction ?? ''}
            onChange={(e) => onChange({ ...config, soapAction: e.target.value || undefined })}
          />
          <Select
            label={t('fault_handling')}
            testid="soap-fault-select"
            options={[
              { value: 'error', label: t('fault_handling_error') },
              { value: 'data', label: t('fault_handling_data') },
            ]}
            value={config.onSoapFault ?? 'error'}
            onChange={(v) => onChange({ ...config, onSoapFault: v as OnSoapFault })}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Select
          label={t('method_label')}
          testid="http-config-method"
          options={METHOD_OPTIONS}
          value={config.method || 'POST'}
          onChange={(v) => update('method', v)}
          disabled={config.protocol === 'soap'}
        />
        <Select
          label={t('authentication_label')}
          options={AUTH_OPTIONS}
          value={config.authType || 'none'}
          onChange={(v) => {
            const nextAuthType = v as HttpConfig['authType'];
            const next: Partial<HttpConfig> = { authType: nextAuthType };
            // Clear stale auth data when switching to a different auth type
            if (nextAuthType === 'none') {
              next.authConfig = undefined;
            } else if (nextAuthType !== config.authType) {
              // Switching between non-none types: reset authConfig to avoid
              // leaking fields from the previous type (e.g. customHeaders
              // from 'custom' lingering when switching to 'bearer')
              next.authConfig = {};
            }

            const currentAuthProfileRef = config.authProfileRef?.trim();
            if (currentAuthProfileRef) {
              const matchingProfiles = selectableProfiles.filter(
                (profile) => profile.name === currentAuthProfileRef,
              );
              const selectedProfile =
                matchingProfiles.find((profile) => profile.scope === 'project') ??
                matchingProfiles[0];
              const allowedAuthTypes = getAuthProfileTypeFilter(nextAuthType);
              const isCompatible =
                !selectedProfile ||
                !allowedAuthTypes ||
                allowedAuthTypes.includes(selectedProfile.authType);

              if (!isCompatible) {
                next.authProfileRef = undefined;
                next.authJit = undefined;
                next.consentMode = undefined;
                next.connectionMode = undefined;
              }
            }

            onChange({ ...config, ...next });
          }}
          testid="http-config-authentication"
        />
      </div>
      {config.protocol === 'soap' && (
        <p className="text-xs text-muted -mt-2">{t('method_locked_soap')}</p>
      )}

      <div className="space-y-3 pl-4 border-l-2 border-accent/30">
        {canUseAuthProfilePicker ? (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              {t('auth_profile_label')}
            </label>
            <AuthProfilePicker
              projectId={projectId!}
              value={selectedAuthProfileId ?? resolvedStaleProfileId}
              onChange={(profileId) => {
                if (!profileId) {
                  onChange({
                    ...config,
                    authProfileRef: undefined,
                    authJit: undefined,
                    consentMode: undefined,
                    connectionMode: undefined,
                  });
                  return;
                }
                const profile = selectableProfiles.find((entry) => entry.id === profileId);
                update('authProfileRef', profile?.name ?? undefined);
              }}
              filterAuthTypes={authProfileTypeFilter}
              filterProfileType="custom"
              consumerKind="http_tool"
              staleRefName={
                needsStaleResolution && !resolvedStaleProfileId
                  ? config.authProfileRef!.trim()
                  : undefined
              }
            />
            {touched(config.authProfileRef) && errors.authProfileRef && (
              <p className="mt-1 text-xs text-error">{errors.authProfileRef}</p>
            )}
          </div>
        ) : (
          <Input
            label={t('auth_profile_label')}
            placeholder={t('auth_profile_placeholder')}
            value={config.authProfileRef || ''}
            onChange={(e) => {
              const nextValue = e.target.value;
              if (nextValue.trim().length === 0) {
                onChange({
                  ...config,
                  authProfileRef: undefined,
                  authJit: undefined,
                  consentMode: undefined,
                  connectionMode: undefined,
                });
                return;
              }
              update('authProfileRef', nextValue);
            }}
            error={touched(config.authProfileRef) ? errors.authProfileRef : undefined}
          />
        )}
        <p className="text-xs text-muted">{t('auth_profile_hint')}</p>
        {hasAuthProfileRef && (
          <>
            <Input
              label={t('requested_scopes_label')}
              placeholder={t('requested_scopes_placeholder')}
              value={authConfig.scopes || ''}
              onChange={(e) => updateAuthConfig('scopes', e.target.value)}
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                label={t('consent_mode_label')}
                options={CONSENT_OPTIONS}
                value={config.consentMode || 'inline'}
                onChange={(value) => update('consentMode', value)}
              />
              <Select
                label={t('connection_mode_label')}
                options={CONNECTION_OPTIONS}
                value={config.connectionMode || 'shared'}
                onChange={(value) => update('connectionMode', value)}
              />
            </div>
            <Toggle
              checked={config.authJit || false}
              onChange={(checked) => update('authJit', checked)}
              label={t('jit_auth_label')}
            />
            <p className="text-xs text-muted">{t('auth_profile_runtime_hint')}</p>
          </>
        )}
      </div>

      {/* Auth config — contextual fields based on auth type */}
      {config.authType === 'api_key' && (
        <div className="space-y-3 pl-4 border-l-2 border-accent/30">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">
            {t('api_key_configuration')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('api_key_header_label')}
              placeholder={t('api_key_header_placeholder')}
              value={authConfig.headerName || ''}
              onChange={(e) => updateAuthConfig('headerName', e.target.value)}
              error={touched(authConfig.headerName) ? errors['authConfig.headerName'] : undefined}
            />
            <div className="space-y-1.5">
              <label
                htmlFor="http-auth-api-key"
                className="block text-sm font-medium text-foreground"
              >
                {t('api_key_value_label')}
              </label>
              <div className="relative">
                <input
                  id="http-auth-api-key"
                  type={isSecretVisible('apiKey') ? 'text' : 'password'}
                  value={authConfig.apiKey || ''}
                  onChange={(e) => updateAuthConfig('apiKey', e.target.value)}
                  placeholder={t('api_key_placeholder')}
                  className={`w-full rounded-lg border bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:ring-1 text-sm py-2 pl-3 pr-9 ${
                    touched(authConfig.apiKey) && errors['authConfig.apiKey']
                      ? 'border-error focus:border-error focus:ring-error'
                      : 'border-default focus:border-border-focus focus:ring-border-focus'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => toggleSecretVisibility('apiKey')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-default btn-press"
                  aria-label={isSecretVisible('apiKey') ? t('hide_value') : t('show_value')}
                >
                  {isSecretVisible('apiKey') ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
              {touched(authConfig.apiKey) && errors['authConfig.apiKey'] ? (
                <p className="text-xs text-error">{errors['authConfig.apiKey']}</p>
              ) : null}
            </div>
          </div>
          <p className="text-xs text-muted">
            {t.rich('secrets_hint', {
              code: (chunks) => (
                <code className="font-mono text-xs bg-background-muted px-1 rounded">{chunks}</code>
              ),
            })}
          </p>
        </div>
      )}

      {config.authType === 'bearer' && (
        <div className="space-y-3 pl-4 border-l-2 border-accent/30">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">
            {t('bearer_token_section')}
          </p>
          <div className="space-y-1.5">
            <label htmlFor="http-auth-token" className="block text-sm font-medium text-foreground">
              {t('token_label')}
            </label>
            <div className="relative">
              <input
                id="http-auth-token"
                type={isSecretVisible('token') ? 'text' : 'password'}
                value={authConfig.token || ''}
                onChange={(e) => updateAuthConfig('token', e.target.value)}
                placeholder={t('token_placeholder')}
                className={`w-full rounded-lg border bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:ring-1 text-sm py-2 pl-3 pr-9 ${
                  touched(authConfig.token) && errors['authConfig.token']
                    ? 'border-error focus:border-error focus:ring-error'
                    : 'border-default focus:border-border-focus focus:ring-border-focus'
                }`}
              />
              <button
                type="button"
                onClick={() => toggleSecretVisibility('token')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-default btn-press"
                aria-label={isSecretVisible('token') ? t('hide_value') : t('show_value')}
              >
                {isSecretVisible('token') ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
            {touched(authConfig.token) && errors['authConfig.token'] ? (
              <p className="text-xs text-error">{errors['authConfig.token']}</p>
            ) : null}
          </div>
          <p className="text-xs text-muted">
            {t.rich('secrets_hint', {
              code: (chunks) => (
                <code className="font-mono text-xs bg-background-muted px-1 rounded">{chunks}</code>
              ),
            })}
          </p>
        </div>
      )}

      {config.authType === 'oauth2_client' && !hasAuthProfileRef && (
        <div className="space-y-3 pl-4 border-l-2 border-accent/30">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">
            {t('oauth2_client_credentials')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('client_id_label')}
              placeholder={t('client_id_placeholder')}
              value={authConfig.clientId || ''}
              onChange={(e) => updateAuthConfig('clientId', e.target.value)}
              error={touched(authConfig.clientId) ? errors['authConfig.clientId'] : undefined}
            />
            <div className="space-y-1.5">
              <label
                htmlFor="http-auth-client-secret"
                className="block text-sm font-medium text-foreground"
              >
                {t('client_secret_label')}
              </label>
              <div className="relative">
                <input
                  id="http-auth-client-secret"
                  type={isSecretVisible('clientSecret') ? 'text' : 'password'}
                  value={authConfig.clientSecret || ''}
                  onChange={(e) => updateAuthConfig('clientSecret', e.target.value)}
                  placeholder={t('client_secret_placeholder')}
                  className={`w-full rounded-lg border bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:ring-1 text-sm py-2 pl-3 pr-9 ${
                    touched(authConfig.clientSecret) && errors['authConfig.clientSecret']
                      ? 'border-error focus:border-error focus:ring-error'
                      : 'border-default focus:border-border-focus focus:ring-border-focus'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => toggleSecretVisibility('clientSecret')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-default btn-press"
                  aria-label={isSecretVisible('clientSecret') ? t('hide_value') : t('show_value')}
                >
                  {isSecretVisible('clientSecret') ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
              {touched(authConfig.clientSecret) && errors['authConfig.clientSecret'] ? (
                <p className="text-xs text-error">{errors['authConfig.clientSecret']}</p>
              ) : null}
            </div>
          </div>
          <Input
            label={t('oauth2_token_url_label')}
            placeholder={t('oauth2_token_url_placeholder')}
            value={authConfig.tokenUrl || ''}
            onChange={(e) => updateAuthConfig('tokenUrl', e.target.value)}
            error={touched(authConfig.tokenUrl) ? errors['authConfig.tokenUrl'] : undefined}
          />
          <Input
            label={t('scopes_label')}
            placeholder={t('scopes_placeholder')}
            value={authConfig.scopes || ''}
            onChange={(e) => updateAuthConfig('scopes', e.target.value)}
          />
        </div>
      )}

      {config.authType === 'oauth2_user' && (
        <div className="space-y-3 pl-4 border-l-2 border-accent/30">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">
            {t('oauth2_user_section')}
          </p>
          <Input
            label={t('oauth2_provider_label')}
            placeholder={t('oauth2_provider_placeholder')}
            value={authConfig.provider || ''}
            onChange={(e) => updateAuthConfig('provider', e.target.value)}
            error={touched(authConfig.provider) ? errors['authConfig.provider'] : undefined}
          />
          <p className="text-xs text-muted">{t('oauth2_user_hint')}</p>
        </div>
      )}

      {config.authType === 'custom' && (
        <div className="space-y-3 pl-4 border-l-2 border-accent/30">
          <p className="text-xs font-medium text-muted uppercase tracking-wide">
            {t('custom_auth_section')}
          </p>
          <p className="text-xs text-muted">
            {t.rich('custom_auth_hint', {
              code: (chunks) => (
                <code className="font-mono text-xs bg-background-muted px-1 rounded">{chunks}</code>
              ),
            })}
          </p>
          {/* Custom auth headers key-value editor */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-medium text-muted">
                {t('custom_auth_headers_label')}
              </label>
              <Button
                variant="ghost"
                size="sm"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={() => {
                  setCustomHeaderDrafts((currentDrafts) => {
                    const nextDrafts = [
                      ...currentDrafts,
                      nextCustomHeaderDraft(`Header-${currentDrafts.length + 1}`, ''),
                    ];
                    persistCustomHeaderDrafts(nextDrafts);
                    return nextDrafts;
                  });
                }}
              >
                {t('add')}
              </Button>
            </div>
            {customHeaderDrafts.length === 0 ? (
              <p className="text-xs text-muted">{t('no_custom_auth_headers')}</p>
            ) : (
              <div className="space-y-2">
                {customHeaderDrafts.map((headerDraft) => (
                  <div key={headerDraft.id} className="flex items-center gap-2">
                    <input
                      placeholder="Header name"
                      value={headerDraft.key}
                      onChange={(e) => {
                        const nextValue = e.target.value;
                        setCustomHeaderDrafts((currentDrafts) => {
                          const nextDrafts = currentDrafts.map((draft) =>
                            draft.id === headerDraft.id ? { ...draft, key: nextValue } : draft,
                          );
                          persistCustomHeaderDrafts(nextDrafts);
                          return nextDrafts;
                        });
                      }}
                      className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground text-sm px-3 py-1.5 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                    />
                    <div className="relative flex-1">
                      <input
                        type={
                          isSecretVisible(`custom-header-${headerDraft.id}`) ? 'text' : 'password'
                        }
                        placeholder="{{secrets.MY_KEY}}"
                        value={headerDraft.value}
                        onChange={(e) => {
                          const nextValue = e.target.value;
                          setCustomHeaderDrafts((currentDrafts) => {
                            const nextDrafts = currentDrafts.map((draft) =>
                              draft.id === headerDraft.id ? { ...draft, value: nextValue } : draft,
                            );
                            persistCustomHeaderDrafts(nextDrafts);
                            return nextDrafts;
                          });
                        }}
                        className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm pl-3 pr-9 py-1.5 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                      />
                      <button
                        type="button"
                        onClick={() => toggleSecretVisibility(`custom-header-${headerDraft.id}`)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-default btn-press"
                        aria-label={
                          isSecretVisible(`custom-header-${headerDraft.id}`)
                            ? t('hide_value')
                            : t('show_value')
                        }
                      >
                        {isSecretVisible(`custom-header-${headerDraft.id}`) ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomHeaderDrafts((currentDrafts) => {
                          const nextDrafts = currentDrafts.filter(
                            (draft) => draft.id !== headerDraft.id,
                          );
                          persistCustomHeaderDrafts(nextDrafts);
                          return nextDrafts;
                        });
                      }}
                      className="p-1.5 text-muted hover:text-error transition-default"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Request Body (only for POST, PUT, PATCH) */}
      {METHODS_WITH_BODY.includes(config.method) && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-foreground">
              {t('request_body_label')}
            </label>
            <div className="flex items-center gap-2">
              <Select
                label=""
                options={BODY_TYPE_OPTIONS}
                testid="http-config-body-type"
                value={config.bodyType || 'json'}
                onChange={(v) => {
                  const type = v as BodyType;
                  // Auto-set Content-Type header if not already set
                  const contentTypeMap = {
                    json: 'application/json',
                    form: 'application/x-www-form-urlencoded',
                    xml: 'application/xml',
                    text: 'text/plain',
                  };
                  const existingHeaders = headers.filter(
                    (h) => h.key.toLowerCase() !== 'content-type',
                  );
                  onChange({
                    ...config,
                    bodyType: type,
                    headers: [
                      ...existingHeaders,
                      { key: 'Content-Type', value: contentTypeMap[type] },
                    ],
                  });
                }}
                disabled={config.protocol === 'soap'}
              />
              {config.protocol === 'soap' && (
                <p className="text-xs text-muted -mt-2">{t('body_type_locked_soap')}</p>
              )}
              {config.bodyType === 'json' && (
                <Toggle
                  checked={config.useBodySchema || false}
                  onChange={(checked) => update('useBodySchema', checked)}
                  label={t('use_schema')}
                />
              )}
              {showTemplates && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => update('body', BODY_TEMPLATES[config.bodyType || 'json'])}
                  title={t('load_template')}
                >
                  {t('load_template_button')}
                </Button>
              )}
            </div>
          </div>

          {/* Schema-based body (JSON only) */}
          {config.useBodySchema && config.bodyType === 'json' ? (
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-medium text-muted">
                    {t('body_json_schema_label')}
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Wand2 className="w-3.5 h-3.5" />}
                    onClick={formatSchema}
                    title="Format JSON"
                  >
                    Format
                  </Button>
                </div>
                <textarea
                  value={config.bodySchema || ''}
                  onChange={(e) => update('bodySchema', e.target.value)}
                  rows={8}
                  className={`${TEXTAREA_CLASS} ${errors.bodySchema && config.bodySchema ? 'border-error/50' : ''}`}
                  placeholder={`{
  "type": "object",
  "properties": {
    "field1": { "type": "string" },
    "field2": { "type": "number" }
  },
  "required": ["field1"]
}`}
                  spellCheck={false}
                />
                <p className="text-xs text-muted mt-1.5">{t('body_schema_hint')}</p>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-medium text-muted">
                    {t('body_template_label')}
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Wand2 className="w-3.5 h-3.5" />}
                    onClick={formatBody}
                    title="Format JSON"
                  >
                    Format
                  </Button>
                </div>
                <textarea
                  value={config.body || ''}
                  onChange={(e) => update('body', e.target.value)}
                  rows={6}
                  className={TEXTAREA_CLASS}
                  placeholder={`{
  "customer_email": "{{input.customer_email}}",
  "amount": {{input.amount}},
  "currency": "{{input.currency}}",
  "api_key": "{{secrets.PAYMENT_API_KEY}}"
}`}
                  spellCheck={false}
                />
                <p className="text-xs text-muted mt-1.5">
                  {t.rich('body_template_hint', {
                    inputCode: (chunks) => (
                      <code className="font-mono bg-background-muted px-1 rounded">{chunks}</code>
                    ),
                    secretsCode: (chunks) => (
                      <code className="font-mono bg-background-muted px-1 rounded">{chunks}</code>
                    ),
                  })}
                </p>
              </div>
            </div>
          ) : (
            // Free-form body
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-muted">
                  {t('request_body_label')}
                </label>
                {(config.bodyType || 'json') === 'json' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Wand2 className="w-3.5 h-3.5" />}
                    onClick={formatBody}
                    title="Format JSON"
                  >
                    Format
                  </Button>
                )}
              </div>
              <textarea
                value={config.body || ''}
                onChange={(e) => update('body', e.target.value)}
                rows={8}
                className={TEXTAREA_CLASS}
                placeholder={BODY_TEMPLATES[config.bodyType || 'json']}
                spellCheck={false}
              />
              <div className="text-xs text-muted space-y-1 mt-1.5">
                <p>
                  <strong>{t('template_variables')}</strong>
                </p>
                <ul className="list-disc list-inside space-y-0.5 ml-2">
                  <li>
                    <code className="font-mono bg-background-muted px-1 rounded">
                      {'{{input.paramName}}'}
                    </code>{' '}
                    - {t('template_input_params')}
                  </li>
                  <li>
                    <code className="font-mono bg-background-muted px-1 rounded">
                      {'{{secrets.KEY_NAME}}'}
                    </code>{' '}
                    - {t('template_project_secrets')}
                  </li>
                  <li>
                    <code className="font-mono bg-background-muted px-1 rounded">
                      {'{{_context.userId}}'}
                    </code>{' '}
                    - {t('template_context_vars')}
                  </li>
                  <li>
                    <code className="font-mono bg-background-muted px-1 rounded">
                      {'{{session.key}}'}
                    </code>{' '}
                    - {t('template_session_vars')}
                  </li>
                </ul>
                <p className="mt-2">{t('template_resolved_at_runtime')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Query Parameters */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-foreground">
            {t('query_parameters_label')}
          </label>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={addQueryParam}
          >
            {t('add')}
          </Button>
        </div>
        {queryParams.length === 0 ? (
          <p className="text-xs text-muted">
            {t('no_query_params')}
            <br />
            {t.rich('query_params_variables_hint', {
              inputCode: (chunks) => (
                <code className="font-mono text-xs bg-background-muted px-1 rounded">{chunks}</code>
              ),
              secretsCode: (chunks) => (
                <code className="font-mono text-xs bg-background-muted px-1 rounded">{chunks}</code>
              ),
            })}
          </p>
        ) : (
          <div className="space-y-2">
            {queryParams.map((param, index) => (
              <KeyValueRow
                key={index}
                keyValue={param.key}
                valueValue={param.value}
                keyPlaceholder={t('param_name_placeholder')}
                valuePlaceholder={t('param_value_placeholder')}
                onKeyChange={(v) => updateQueryParam(index, 'key', v)}
                onValueChange={(v) => updateQueryParam(index, 'value', v)}
                onRemove={() => removeQueryParam(index)}
                keyError={param.key === '' && param.value !== ''}
              />
            ))}
          </div>
        )}
      </div>

      {/* Headers */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-foreground">{t('headers_label')}</label>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={addHeader}
          >
            {t('add')}
          </Button>
        </div>
        {headers.length === 0 ? (
          <p className="text-xs text-muted">{t('no_custom_headers')}</p>
        ) : (
          <div className="space-y-2">
            {headers.map((header, index) => (
              <KeyValueRow
                key={index}
                keyValue={header.key}
                valueValue={header.value}
                keyPlaceholder={t('header_name_placeholder')}
                valuePlaceholder={t('header_value_placeholder')}
                onKeyChange={(v) => updateHeader(index, 'key', v)}
                onValueChange={(v) => updateHeader(index, 'value', v)}
                onRemove={() => removeHeader(index)}
                keyError={header.key === '' && header.value !== ''}
              />
            ))}
          </div>
        )}
        {errors.headerCollision && (
          <p className="text-xs text-warning mt-1.5">{errors.headerCollision}</p>
        )}
        <details className="group mt-2">
          <summary className="text-xs text-muted cursor-pointer hover:text-foreground transition-default select-none inline-flex items-center gap-1.5">
            <span className="transition-transform duration-200 group-open:rotate-90">&#9654;</span>
            {t('show_template_variables')}
          </summary>
          <div className="text-xs text-muted space-y-1 mt-2 ml-3">
            <ul className="list-disc list-inside space-y-0.5 ml-2">
              <li>
                <code className="font-mono bg-background-muted px-1 rounded">
                  {'{{secrets.KEY_NAME}}'}
                </code>{' '}
                — {t('template_project_secrets')}
              </li>
              <li>
                <code className="font-mono bg-background-muted px-1 rounded">
                  {'{{_context.userId}}'}
                </code>{' '}
                — {t('template_context_vars')}
              </li>
              <li>
                <code className="font-mono bg-background-muted px-1 rounded">
                  {'{{session.key}}'}
                </code>{' '}
                — {t('template_session_vars')}
              </li>
            </ul>
            <p className="mt-1">{t('template_resolved_at_runtime')}</p>
          </div>
        </details>
      </div>

      {/* Input Parameters */}
      <ParameterEditor
        parameters={config.parameters ?? []}
        onChange={(params) => update('parameters', params)}
        helpText={tc('parameter_help_text_http')}
        showParseButton
        onParseFromCode={() => {
          const parsed = parseParametersFromHttpConfig(config);
          if (parsed.length > 0) {
            update('parameters', parsed);
          }
        }}
      />

      {/* Advanced Settings — collapsible */}
      <details className="group">
        <summary className="text-sm font-medium text-muted cursor-pointer hover:text-foreground transition-default select-none flex items-center gap-1.5">
          <span className="transition-transform duration-200 group-open:rotate-90">&#9654;</span>
          Advanced Settings
        </summary>
        <div className="mt-4 space-y-4">
          {/* Return Type */}
          <div>
            <Input
              label={tc('return_type_label')}
              placeholder={tc('return_type_placeholder')}
              value={config.returnType || 'object'}
              onChange={(e) => update('returnType', e.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted mt-1">{tc('return_type_hint')}</p>
          </div>

          {/* Resilience settings */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <Input
              label={t('timeout_label')}
              inputMode="numeric"
              placeholder="{{config.HTTP_TIMEOUT_MS}}"
              value={runtimeNumericInputValue(config.timeoutMs, 30000)}
              onChange={(e) => update('timeoutMs', parseRuntimeNumericDraft(e.target.value, 30000))}
              error={errors.timeoutMs}
            />
            <Input
              label={t('retries_label')}
              inputMode="numeric"
              placeholder="{{config.HTTP_RETRY_COUNT}}"
              value={runtimeNumericInputValue(config.retryCount, 0)}
              onChange={(e) => update('retryCount', parseRuntimeNumericDraft(e.target.value, 0))}
              error={errors.retryCount}
            />
            <Input
              label={t('retry_delay_label')}
              inputMode="numeric"
              placeholder="{{config.HTTP_RETRY_DELAY_MS}}"
              value={runtimeNumericInputValue(config.retryDelayMs, 1000)}
              onChange={(e) =>
                update('retryDelayMs', parseRuntimeNumericDraft(e.target.value, 1000))
              }
              error={errors.retryDelayMs}
            />
            <Input
              label={t('rate_limit_label')}
              placeholder={t('rate_limit_unlimited')}
              inputMode="numeric"
              value={runtimeNumericInputValue(config.rateLimitPerMinute)}
              onChange={(e) =>
                update(
                  'rateLimitPerMinute',
                  parseRuntimeNumericDraft(e.target.value, 0, { allowUndefined: true }),
                )
              }
              error={errors.rateLimitPerMinute}
            />
          </div>

          {/* Circuit Breaker */}
          <div>
            <Toggle
              checked={!!config.circuitBreaker}
              onChange={(checked) => {
                if (checked) {
                  update('circuitBreaker', { threshold: 5, resetMs: 60000 });
                } else {
                  update('circuitBreaker', undefined);
                }
              }}
              label={t('circuit_breaker_label')}
              className="mb-2"
            />
            {config.circuitBreaker && (
              <div className="grid grid-cols-2 gap-3 pl-4 border-l-2 border-accent/30">
                <Input
                  label={t('failure_threshold_label')}
                  inputMode="numeric"
                  placeholder="{{config.HTTP_CB_THRESHOLD}}"
                  value={runtimeNumericInputValue(config.circuitBreaker.threshold, 5)}
                  onChange={(e) =>
                    update('circuitBreaker', {
                      ...config.circuitBreaker,
                      threshold: parseRuntimeNumericDraft(e.target.value, 5),
                    })
                  }
                  error={errors.circuitBreakerThreshold}
                />
                <Input
                  label={t('reset_time_label')}
                  inputMode="numeric"
                  placeholder="{{config.HTTP_CB_RESET_MS}}"
                  value={runtimeNumericInputValue(config.circuitBreaker.resetMs, 60000)}
                  onChange={(e) =>
                    update('circuitBreaker', {
                      ...config.circuitBreaker,
                      resetMs: parseRuntimeNumericDraft(e.target.value, 60000),
                    })
                  }
                  error={errors.circuitBreakerResetMs}
                />
                <p className="col-span-2 text-xs text-muted">{t('circuit_breaker_hint')}</p>
              </div>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
