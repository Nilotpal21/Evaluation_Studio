/**
 * ApiStageConfig — inline config form for the API stage type.
 *
 * Renders inside the DetailPanel's StageConfigMode (not as an overlay).
 * Sections: Endpoint, Authentication, Headers, Request Body, Response Mapping, Settings.
 *
 * i18n keys used (search_ai.pipeline namespace):
 *   v2_api_url, v2_api_url_placeholder, v2_api_method, v2_api_auth, v2_api_auth_none,
 *   v2_api_auth_bearer, v2_api_auth_api_key, v2_api_auth_basic,
 *   v2_api_auth_token, v2_api_auth_key_header, v2_api_auth_key_value,
 *   v2_api_auth_username, v2_api_auth_password,
 *   v2_api_headers, v2_api_add_header, v2_api_header_key, v2_api_header_value,
 *   v2_api_body, v2_api_body_placeholder,
 *   v2_api_response_mapping, v2_api_json_path, v2_api_target_field, v2_api_add_mapping,
 *   v2_api_timeout, v2_api_retries, v2_api_on_error,
 *   v2_api_section_endpoint, v2_api_section_auth, v2_api_section_headers,
 *   v2_api_section_body, v2_api_section_response, v2_api_section_settings
 */

'use client';

import { useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { Input } from '../../../../ui/Input';
import { Select } from '../../../../ui/Select';
import { Textarea } from '../../../../ui/Textarea';
import { Button } from '../../../../ui/Button';

// =============================================================================
// TYPES
// =============================================================================

interface Header {
  key: string;
  value: string;
}

interface AuthConfig {
  type: 'none' | 'bearer' | 'api-key' | 'basic';
  token?: string;
  apiKeyHeader?: string;
  apiKeyValue?: string;
  username?: string;
  password?: string;
}

interface ResponseMapping {
  jsonPath: string;
  targetField: string;
}

interface ApiStageConfigProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const CANONICAL_FIELD_OPTIONS = [
  { value: 'title', label: 'Title' },
  { value: 'content_summary', label: 'Content Summary' },
  { value: 'source_type', label: 'Source Type' },
  { value: 'source_url', label: 'Source URL' },
  { value: 'author', label: 'Author' },
  { value: 'category', label: 'Category' },
  { value: 'status', label: 'Status' },
  { value: 'tags', label: 'Tags' },
  { value: 'priority', label: 'Priority' },
  { value: 'department', label: 'Department' },
  { value: 'project', label: 'Project' },
  { value: 'language', label: 'Language' },
  { value: 'mime_type', label: 'MIME Type' },
  { value: 'description', label: 'Description' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'reporter', label: 'Reporter' },
];

const DEFAULT_AUTH: AuthConfig = { type: 'none' };

// =============================================================================
// HELPERS
// =============================================================================

function getHeaders(config: Record<string, unknown>): Header[] {
  return Array.isArray(config.headers) ? (config.headers as Header[]) : [];
}

function getAuth(config: Record<string, unknown>): AuthConfig {
  if (config.auth && typeof config.auth === 'object') {
    return config.auth as AuthConfig;
  }
  return DEFAULT_AUTH;
}

function getMappings(config: Record<string, unknown>): ResponseMapping[] {
  return Array.isArray(config.responseMapping) ? (config.responseMapping as ResponseMapping[]) : [];
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ApiStageConfig({ config, onChange }: ApiStageConfigProps) {
  const t = useTranslations('search_ai.pipeline');

  const url = (config.url as string) ?? '';
  const method = (config.method as string) ?? 'GET';
  const auth = getAuth(config);
  const headers = getHeaders(config);
  const body = (config.body as string) ?? '';
  const timeout = (config.timeout as number) ?? 30000;
  const retries = (config.retries as number) ?? 0;
  const onError = (config.onError as string) ?? 'fail';
  const mappings = getMappings(config);

  const showBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

  const update = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...config, [key]: value });
    },
    [config, onChange],
  );

  // --- Auth helpers ---
  const updateAuth = useCallback(
    (key: string, value: unknown) => {
      const current = getAuth(config);
      onChange({ ...config, auth: { ...current, [key]: value } });
    },
    [config, onChange],
  );

  // --- Header helpers ---
  const addHeader = useCallback(() => {
    const current = getHeaders(config);
    onChange({ ...config, headers: [...current, { key: '', value: '' }] });
  }, [config, onChange]);

  const removeHeader = useCallback(
    (idx: number) => {
      const current = getHeaders(config);
      onChange({ ...config, headers: current.filter((_, i) => i !== idx) });
    },
    [config, onChange],
  );

  const updateHeader = useCallback(
    (idx: number, field: 'key' | 'value', val: string) => {
      const current = getHeaders(config);
      onChange({
        ...config,
        headers: current.map((h, i) => (i === idx ? { ...h, [field]: val } : h)),
      });
    },
    [config, onChange],
  );

  // --- Response mapping helpers ---
  const addMapping = useCallback(() => {
    const current = getMappings(config);
    onChange({
      ...config,
      responseMapping: [...current, { jsonPath: '', targetField: '' }],
    });
  }, [config, onChange]);

  const removeMapping = useCallback(
    (idx: number) => {
      const current = getMappings(config);
      onChange({
        ...config,
        responseMapping: current.filter((_, i) => i !== idx),
      });
    },
    [config, onChange],
  );

  const updateMapping = useCallback(
    (idx: number, field: 'jsonPath' | 'targetField', val: string) => {
      const current = getMappings(config);
      onChange({
        ...config,
        responseMapping: current.map((m, i) => (i === idx ? { ...m, [field]: val } : m)),
      });
    },
    [config, onChange],
  );

  const methodOptions = useMemo(
    () => [
      { value: 'GET', label: 'GET' },
      { value: 'POST', label: 'POST' },
      { value: 'PUT', label: 'PUT' },
      { value: 'PATCH', label: 'PATCH' },
    ],
    [],
  );

  const authOptions = useMemo(
    () => [
      { value: 'none', label: t('v2_api_auth_none') },
      { value: 'bearer', label: t('v2_api_auth_bearer') },
      { value: 'api-key', label: t('v2_api_auth_api_key') },
      { value: 'basic', label: t('v2_api_auth_basic') },
    ],
    [t],
  );

  const onErrorOptions = useMemo(
    () => [
      { value: 'fail', label: t('v2_config_on_error_fail') },
      { value: 'continue', label: t('v2_config_on_error_continue') },
    ],
    [t],
  );

  return (
    <div className="space-y-5">
      {/* ── Endpoint ── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          {t('v2_api_section_endpoint')}
        </h3>
        <Input
          label={t('v2_api_url')}
          value={url}
          onChange={(e) => update('url', e.target.value)}
          placeholder={t('v2_api_url_placeholder')}
        />
        <Select
          label={t('v2_api_method')}
          value={method}
          onChange={(v) => update('method', v)}
          options={methodOptions}
        />
      </section>

      {/* ── Authentication ── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          {t('v2_api_section_auth')}
        </h3>
        <Select
          label={t('v2_api_auth')}
          value={auth.type}
          onChange={(v) => updateAuth('type', v)}
          options={authOptions}
        />
        {auth.type === 'bearer' && (
          <Input
            label={t('v2_api_auth_token')}
            type="password"
            value={auth.token ?? ''}
            onChange={(e) => updateAuth('token', e.target.value)}
          />
        )}
        {auth.type === 'api-key' && (
          <>
            <Input
              label={t('v2_api_auth_key_header')}
              value={auth.apiKeyHeader ?? ''}
              onChange={(e) => updateAuth('apiKeyHeader', e.target.value)}
              placeholder="X-API-Key"
            />
            <Input
              label={t('v2_api_auth_key_value')}
              type="password"
              value={auth.apiKeyValue ?? ''}
              onChange={(e) => updateAuth('apiKeyValue', e.target.value)}
            />
          </>
        )}
        {auth.type === 'basic' && (
          <>
            <Input
              label={t('v2_api_auth_username')}
              value={auth.username ?? ''}
              onChange={(e) => updateAuth('username', e.target.value)}
            />
            <Input
              label={t('v2_api_auth_password')}
              type="password"
              value={auth.password ?? ''}
              onChange={(e) => updateAuth('password', e.target.value)}
            />
          </>
        )}
      </section>

      {/* ── Headers ── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t('v2_api_section_headers')}
          </h3>
          <Button size="xs" variant="ghost" onClick={addHeader} icon={<Plus className="h-3 w-3" />}>
            {t('v2_api_add_header')}
          </Button>
        </div>
        {headers.map((header, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <Input
              value={header.key}
              onChange={(e) => updateHeader(idx, 'key', e.target.value)}
              placeholder={t('v2_api_header_key')}
              className="flex-1"
            />
            <Input
              value={header.value}
              onChange={(e) => updateHeader(idx, 'value', e.target.value)}
              placeholder={t('v2_api_header_value')}
              className="flex-1"
            />
            <button
              onClick={() => removeHeader(idx)}
              className="shrink-0 rounded p-1 text-muted hover:text-error"
              aria-label={t('v2_api_add_header')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </section>

      {/* ── Request Body (POST/PUT/PATCH only) ── */}
      {showBody && (
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t('v2_api_section_body')}
          </h3>
          <Textarea
            label={t('v2_api_body')}
            value={body}
            onChange={(e) => update('body', e.target.value)}
            rows={5}
            className="font-mono text-xs"
            placeholder={t('v2_api_body_placeholder')}
          />
        </section>
      )}

      {/* ── Response Mapping ── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t('v2_api_section_response')}
          </h3>
          <Button
            size="xs"
            variant="ghost"
            onClick={addMapping}
            icon={<Plus className="h-3 w-3" />}
          >
            {t('v2_api_add_mapping')}
          </Button>
        </div>
        {mappings.map((mapping, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <Input
              value={mapping.jsonPath}
              onChange={(e) => updateMapping(idx, 'jsonPath', e.target.value)}
              placeholder={t('v2_api_json_path')}
              className="flex-1"
            />
            <span className="shrink-0 text-xs text-muted">&rarr;</span>
            <Select
              value={mapping.targetField}
              onChange={(v) => updateMapping(idx, 'targetField', v)}
              options={CANONICAL_FIELD_OPTIONS}
              placeholder={t('v2_api_target_field')}
              className="flex-1"
            />
            <button
              onClick={() => removeMapping(idx)}
              className="shrink-0 rounded p-1 text-muted hover:text-error"
              aria-label={t('v2_api_add_mapping')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </section>

      {/* ── Settings ── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          {t('v2_api_section_settings')}
        </h3>
        <Input
          label={t('v2_api_timeout')}
          type="number"
          value={String(timeout)}
          onChange={(e) => update('timeout', Number(e.target.value))}
          min={1000}
          max={300000}
        />
        <Input
          label={t('v2_api_retries')}
          type="number"
          value={String(retries)}
          onChange={(e) => update('retries', Math.min(5, Math.max(0, Number(e.target.value))))}
          min={0}
          max={5}
        />
        <Select
          label={t('v2_api_on_error')}
          value={onError}
          onChange={(v) => update('onError', v)}
          options={onErrorOptions}
        />
      </section>
    </div>
  );
}
