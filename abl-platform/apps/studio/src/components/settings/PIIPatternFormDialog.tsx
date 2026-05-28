/**
 * PIIPatternFormDialog Component
 *
 * Modal form for creating/editing PII patterns with live regex testing.
 * Supports full creation (custom patterns) and built-in override mode
 * (redaction + consumer access only).
 */

import { useState, useCallback } from 'react';
import { clsx } from 'clsx';
import { Toggle } from '../ui/Toggle';
import { useTranslations } from 'next-intl';
import { Plus, Trash2, FlaskConical, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';
import { Select } from '../ui/Select';
import { RadioGroup } from '../ui/RadioGroup';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { toast } from 'sonner';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PIIPatternRedaction {
  type: 'predefined' | 'masked' | 'random';
  label?: string;
  maskConfig?: { showFirst: number; showLast: number; maskChar: string };
  randomConfig?: {
    charset: 'alphanumeric' | 'alphabetic' | 'numeric' | 'custom';
    customChars?: string;
    length?: number;
  };
}

interface PIIPatternConsumerAccess {
  consumer: string;
  renderMode: string;
}

export interface IPIIPattern {
  _id: string;
  name: string;
  description?: string;
  piiType: string;
  regex?: string;
  validate?: string;
  redaction: PIIPatternRedaction;
  consumerAccess: PIIPatternConsumerAccess[];
  defaultRenderMode: string;
  enabled: boolean;
  builtinOverride: boolean;
}

export interface PIIPatternFormDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: () => void;
  projectId: string;
  pattern?: IPIIPattern;
  builtinOverride?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const PII_TYPES = [
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'ssn', label: 'SSN' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'ip_address', label: 'IP Address' },
  { value: 'custom', label: 'Custom' },
];

const RENDER_MODES = [
  { value: 'original', label: 'Original (plaintext)' },
  { value: 'masked', label: 'Masked' },
  { value: 'redacted', label: 'Redacted' },
  { value: 'tokenized', label: 'Tokenized' },
  { value: 'random', label: 'Random replacement' },
];

const CHARSETS = [
  { value: 'alphanumeric', label: 'Alphanumeric' },
  { value: 'alphabetic', label: 'Alphabetic' },
  { value: 'numeric', label: 'Numeric' },
  { value: 'custom', label: 'Custom' },
];

const BUILTIN_PII_LABEL_KEYS: Record<string, string> = {
  email: 'builtin_email_name',
  phone: 'builtin_phone_name',
  ssn: 'builtin_ssn_name',
  credit_card: 'builtin_credit_card_name',
  ip_address: 'builtin_ip_name',
};

/** Sample plaintext values used by the live mask preview, per PII type.
 *  The preview applies the user's showFirst/showLast/maskChar to this
 *  sample so they see exactly what runtime masking will produce. */
const MASK_PREVIEW_SAMPLES: Record<string, string> = {
  email: 'alice@example.com',
  ssn: '123-45-6789',
  phone: '+1-555-867-5309',
  credit_card: '4111-1111-1111-1111',
  ip_address: '192.168.1.42',
};

const MASK_PREVIEW_FALLBACK = '1234567890ABCDEF';

/** Compute the live mask preview, mirroring `applyMask` in
 *  `@abl/compiler/platform/security/pii-vault.ts`. Inlined here to avoid
 *  pulling a server-only compiler import into a Studio UI component. */
function previewMask(value: string, showFirst: number, showLast: number, maskChar: string): string {
  const char = maskChar || '*';
  // Email-aware: preserve @domain so the masked sample stays readable.
  const atIdx = value.indexOf('@');
  if (atIdx > 0) {
    const local = value.slice(0, atIdx);
    const domain = value.slice(atIdx);
    if (showFirst + showLast >= local.length) return local + domain;
    const prefix = local.slice(0, showFirst);
    const suffix = showLast > 0 ? local.slice(-showLast) : '';
    return prefix + char.repeat(local.length - showFirst - showLast) + suffix + domain;
  }
  if (showFirst + showLast >= value.length) return value;
  const prefix = value.slice(0, showFirst);
  const suffix = showLast > 0 ? value.slice(-showLast) : '';
  return prefix + char.repeat(value.length - showFirst - showLast) + suffix;
}

const HIGH_RISK_PII_TYPES = new Set(['ssn', 'credit_card']);
const LLM_CONSUMER = 'llm';

function hasPersistedPatternId(
  pattern?: Pick<IPIIPattern, '_id'>,
): pattern is Pick<IPIIPattern, '_id'> & { _id: string } {
  return typeof pattern?._id === 'string' && pattern._id.trim().length > 0;
}

function normalizeConsumerAccessForSave(
  accessRules: PIIPatternConsumerAccess[],
  fallbackRenderMode: string,
): PIIPatternConsumerAccess[] {
  const normalized = accessRules.map((rule) => {
    const rawConsumer = rule.consumer.trim();
    const consumer = rawConsumer.toLowerCase() === LLM_CONSUMER ? LLM_CONSUMER : rawConsumer;
    if (consumer.toLowerCase() === LLM_CONSUMER && rule.renderMode === 'original') {
      return { ...rule, consumer, renderMode: 'tokenized' };
    }
    return { ...rule, consumer };
  });

  const hasLlmRule = normalized.some((rule) => rule.consumer.toLowerCase() === LLM_CONSUMER);
  if (!hasLlmRule && fallbackRenderMode === 'original') {
    return [...normalized, { consumer: LLM_CONSUMER, renderMode: 'tokenized' }];
  }

  return normalized;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function PIIPatternFormDialog({
  open,
  onClose,
  onSave,
  projectId,
  pattern,
  builtinOverride = false,
}: PIIPatternFormDialogProps) {
  const t = useTranslations('settings.pii_protection.form');
  const tSettings = useTranslations('settings.pii_protection');
  const isEdit = hasPersistedPatternId(pattern);

  // ── Basics ──
  const [name, setName] = useState(pattern?.name || '');
  const [description, setDescription] = useState(pattern?.description || '');
  const [enabled, setEnabled] = useState(pattern?.enabled ?? true);

  // ── Detection ──
  const [regex, setRegex] = useState(pattern?.regex || '');
  const [piiType, setPiiType] = useState(pattern?.piiType || 'custom');
  const [validate, setValidate] = useState(pattern?.validate || '');

  // ── Redaction ──
  const [redactionType, setRedactionType] = useState<'predefined' | 'masked' | 'random'>(
    pattern?.redaction?.type || 'predefined',
  );
  const [redactionLabel, setRedactionLabel] = useState(pattern?.redaction?.label || '[REDACTED]');
  const [maskShowFirst, setMaskShowFirst] = useState(
    pattern?.redaction?.maskConfig?.showFirst ?? 0,
  );
  const [maskShowLast, setMaskShowLast] = useState(pattern?.redaction?.maskConfig?.showLast ?? 0);
  const [maskChar, setMaskChar] = useState(pattern?.redaction?.maskConfig?.maskChar || '*');
  const [randomCharset, setRandomCharset] = useState<
    'alphanumeric' | 'alphabetic' | 'numeric' | 'custom'
  >(pattern?.redaction?.randomConfig?.charset || 'alphanumeric');
  const [randomCustomChars, setRandomCustomChars] = useState(
    pattern?.redaction?.randomConfig?.customChars || '',
  );
  const [randomLength, setRandomLength] = useState<number | undefined>(
    pattern?.redaction?.randomConfig?.length,
  );

  // ── Consumer Access ──
  const [defaultRenderMode, setDefaultRenderMode] = useState(
    pattern?.defaultRenderMode || 'redacted',
  );
  const [consumerAccess, setConsumerAccess] = useState<PIIPatternConsumerAccess[]>(
    pattern?.consumerAccess || [],
  );

  // ── Live Test ──
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<{
    detections: Array<{ match: string; index: number; length: number }>;
    consumerPreviews: Record<string, string>;
  } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // ── Form state ──
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Helpers ──

  const inputClasses =
    'w-full rounded-lg border border-default bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-border-focus/30 focus:border-border-focus transition-default';

  const labelClasses = 'block text-sm font-medium text-foreground mb-1.5';
  const effectiveRegex = builtinOverride ? pattern?.regex?.trim() || '' : regex.trim();
  const effectivePiiType = builtinOverride && pattern?.piiType ? pattern.piiType : piiType;
  const effectiveValidate = builtinOverride && pattern?.validate ? pattern.validate : validate;
  const canTestPattern = Boolean(effectiveRegex) || (builtinOverride && Boolean(effectivePiiType));
  const builtinDisplayName =
    builtinOverride && pattern?.piiType && BUILTIN_PII_LABEL_KEYS[pattern.piiType]
      ? tSettings(BUILTIN_PII_LABEL_KEYS[pattern.piiType])
      : pattern?.name || t('builtin_pattern');
  const showHighRiskDisableWarning = !enabled && HIGH_RISK_PII_TYPES.has(effectivePiiType);

  const buildRedaction = useCallback((): PIIPatternRedaction => {
    const base: PIIPatternRedaction = { type: redactionType };
    if (redactionType === 'predefined') {
      base.label = redactionLabel;
    } else if (redactionType === 'masked') {
      base.maskConfig = {
        showFirst: maskShowFirst,
        showLast: maskShowLast,
        maskChar: maskChar || '*',
      };
    } else if (redactionType === 'random') {
      base.randomConfig = {
        charset: randomCharset,
        ...(randomCharset === 'custom' && randomCustomChars
          ? { customChars: randomCustomChars }
          : {}),
        ...(randomLength !== undefined ? { length: randomLength } : {}),
      };
    }
    return base;
  }, [
    redactionType,
    redactionLabel,
    maskShowFirst,
    maskShowLast,
    maskChar,
    randomCharset,
    randomCustomChars,
    randomLength,
  ]);

  const buildPayload = useCallback(() => {
    const normalizedConsumerAccess = normalizeConsumerAccessForSave(
      consumerAccess,
      defaultRenderMode,
    );
    const payload: Record<string, unknown> = {
      name,
      description: description || undefined,
      enabled,
      redaction: buildRedaction(),
      consumerAccess: normalizedConsumerAccess,
      defaultRenderMode,
    };

    if (!builtinOverride) {
      payload.piiType = piiType;
      payload.regex = regex;
      if (validate) payload.validate = validate;
      payload.builtinOverride = false;
    } else {
      // Preserve original detection fields for built-in overrides
      if (pattern) {
        payload.piiType = pattern.piiType;
        payload.regex = pattern.regex;
        payload.validate = pattern.validate;
        payload.builtinOverride = true;
      }
    }

    return payload;
  }, [
    name,
    description,
    enabled,
    buildRedaction,
    consumerAccess,
    defaultRenderMode,
    builtinOverride,
    piiType,
    regex,
    validate,
    pattern,
  ]);

  // ── Handlers ──

  const handleSave = async () => {
    setError('');

    if (!name.trim()) {
      setError(t('error_name_required'));
      return;
    }

    if (!builtinOverride && !regex.trim()) {
      setError(t('error_regex_required'));
      return;
    }

    // Validate regex compiles
    if (!builtinOverride && regex) {
      try {
        new RegExp(regex);
      } catch {
        setError(t('error_invalid_regex'));
        return;
      }
    }

    setSaving(true);
    try {
      const payload = buildPayload();
      const url = isEdit
        ? `/api/projects/${projectId}/pii-patterns/${pattern!._id}`
        : `/api/projects/${projectId}/pii-patterns`;

      const res = await apiFetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message || t('save_failed'));
        return;
      }

      toast.success(isEdit ? t('pattern_updated') : t('pattern_created'));
      onSave();
    } catch (err) {
      setError(sanitizeError(err, t('save_failed')));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!canTestPattern || !testText.trim()) return;

    const normalizedConsumerAccess = normalizeConsumerAccessForSave(
      consumerAccess,
      defaultRenderMode,
    );
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/pii-patterns/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(effectiveRegex ? { regex: effectiveRegex } : {}),
          text: testText,
          validate: effectiveValidate || undefined,
          redaction: buildRedaction(),
          consumerAccess: normalizedConsumerAccess,
          defaultRenderMode,
          piiType: effectivePiiType,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setTestResult(data.data);
      } else {
        toast.error(data?.error?.message || t('test_failed'));
      }
    } catch (err) {
      toast.error(sanitizeError(err, t('test_failed')));
    } finally {
      setTestLoading(false);
    }
  };

  const addConsumerRow = () => {
    setConsumerAccess((prev) => [...prev, { consumer: '', renderMode: 'redacted' }]);
  };

  const updateConsumerRow = (index: number, field: 'consumer' | 'renderMode', value: string) => {
    setConsumerAccess((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  };

  const removeConsumerRow = (index: number) => {
    setConsumerAccess((prev) => prev.filter((_, i) => i !== index));
  };

  // ── Render ──

  const dialogTitle = builtinOverride
    ? t('configure_builtin_title', { name: builtinDisplayName })
    : isEdit
      ? t('edit_title')
      : t('create_title');

  return (
    <Dialog open={open} onClose={onClose} title={dialogTitle} maxWidth="lg">
      <div className="space-y-6">
        {/* ── Section 1: Basics ── */}
        <section className="space-y-4">
          <h4 className="text-sm font-semibold text-foreground border-b border-default pb-2">
            {t('section_basics')}
          </h4>

          <div>
            <label className={labelClasses}>
              {t('name_label')} <span className="text-error">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('name_placeholder')}
              className={inputClasses}
              disabled={builtinOverride}
            />
          </div>

          <div>
            <label className={labelClasses}>{t('description_label')}</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('description_placeholder')}
              className={inputClasses}
            />
          </div>

          <Toggle checked={enabled} onChange={setEnabled} label={t('enabled_label')} />

          {showHighRiskDisableWarning && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning-subtle p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-xs text-warning">{t('high_risk_disable_warning')}</p>
            </div>
          )}
        </section>

        {/* ── Section 2: Detection (hidden for built-in overrides) ── */}
        {!builtinOverride && (
          <section className="space-y-4">
            <h4 className="text-sm font-semibold text-foreground border-b border-default pb-2">
              {t('section_detection')}
            </h4>

            <div>
              <label className={labelClasses}>
                {t('regex_label')} <span className="text-error">*</span>
              </label>
              <input
                type="text"
                value={regex}
                onChange={(e) => setRegex(e.target.value)}
                placeholder={t('regex_placeholder')}
                className={clsx(inputClasses, 'font-mono text-xs')}
              />
            </div>

            <div>
              <Select
                label={t('pii_type_label')}
                options={PII_TYPES}
                value={piiType}
                onChange={setPiiType}
              />
            </div>

            <div>
              <label className={labelClasses}>{t('validator_label')}</label>
              <input
                type="text"
                value={validate}
                onChange={(e) => setValidate(e.target.value)}
                placeholder={t('validator_placeholder')}
                className={clsx(inputClasses, 'font-mono text-xs')}
              />
              <p className="text-xs text-muted mt-1">{t('validator_hint')}</p>
            </div>
          </section>
        )}

        {/* ── Section 3: Redaction ── */}
        <section className="space-y-4">
          <h4 className="text-sm font-semibold text-foreground border-b border-default pb-2">
            {t('section_redaction')}
          </h4>

          <RadioGroup
            options={[
              { value: 'predefined', label: t('redaction_predefined') },
              { value: 'masked', label: t('redaction_masked') },
              { value: 'random', label: t('redaction_random') },
            ]}
            value={redactionType}
            onChange={(v) => setRedactionType(v as 'predefined' | 'masked' | 'random')}
          />

          {redactionType === 'predefined' && (
            <div>
              <label className={labelClasses}>{t('redaction_label')}</label>
              <input
                type="text"
                value={redactionLabel}
                onChange={(e) => setRedactionLabel(e.target.value)}
                placeholder="[REDACTED]"
                className={clsx(inputClasses, 'font-mono text-xs')}
              />
              <p className="text-xs text-muted mt-1">{t('redaction_label_hint')}</p>
            </div>
          )}

          {redactionType === 'masked' && (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className={labelClasses}>{t('show_first')}</label>
                  <input
                    type="number"
                    min={0}
                    value={maskShowFirst}
                    onChange={(e) => setMaskShowFirst(Number(e.target.value))}
                    className={inputClasses}
                  />
                </div>
                <div>
                  <label className={labelClasses}>{t('show_last')}</label>
                  <input
                    type="number"
                    min={0}
                    value={maskShowLast}
                    onChange={(e) => setMaskShowLast(Number(e.target.value))}
                    className={inputClasses}
                  />
                </div>
                <div>
                  <label className={labelClasses}>{t('mask_character')}</label>
                  <input
                    type="text"
                    maxLength={1}
                    value={maskChar}
                    onChange={(e) => setMaskChar(e.target.value)}
                    className={clsx(inputClasses, 'font-mono text-center')}
                  />
                </div>
              </div>
              <p className="text-xs text-muted font-mono">
                {t('mask_preview_label')}{' '}
                {previewMask(
                  MASK_PREVIEW_SAMPLES[effectivePiiType] ?? MASK_PREVIEW_FALLBACK,
                  maskShowFirst,
                  maskShowLast,
                  maskChar || '*',
                )}
              </p>
            </div>
          )}

          {redactionType === 'random' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Select
                  label={t('charset')}
                  options={CHARSETS}
                  value={randomCharset}
                  onChange={(v) =>
                    setRandomCharset(v as 'alphanumeric' | 'alphabetic' | 'numeric' | 'custom')
                  }
                />
              </div>
              <div>
                <label className={labelClasses}>{t('length_label')}</label>
                <input
                  type="number"
                  min={1}
                  value={randomLength ?? ''}
                  onChange={(e) =>
                    setRandomLength(e.target.value ? Number(e.target.value) : undefined)
                  }
                  placeholder={t('length_placeholder')}
                  className={inputClasses}
                />
              </div>
              {randomCharset === 'custom' && (
                <div className="col-span-2">
                  <label className={labelClasses}>{t('custom_characters')}</label>
                  <input
                    type="text"
                    value={randomCustomChars}
                    onChange={(e) => setRandomCustomChars(e.target.value)}
                    placeholder="e.g., ABC123!@#"
                    className={clsx(inputClasses, 'font-mono text-xs')}
                  />
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Section 4: Consumer Access ── */}
        <section className="space-y-4">
          <h4 className="text-sm font-semibold text-foreground border-b border-default pb-2">
            {t('section_consumer_access')}
          </h4>

          <div className="flex items-start gap-2 rounded-lg border border-info/20 bg-info-subtle/50 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-info" />
            <p className="text-xs text-muted">{t('llm_original_notice')}</p>
          </div>

          <div>
            <Select
              label={t('default_render_mode')}
              options={RENDER_MODES}
              value={defaultRenderMode}
              onChange={setDefaultRenderMode}
            />
          </div>

          {/* Per-consumer overrides */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">
                {t('per_consumer_overrides')}
              </label>
              <button
                type="button"
                onClick={addConsumerRow}
                className="inline-flex items-center gap-1 text-xs text-info hover:opacity-80 transition-default"
              >
                <Plus className="w-3 h-3" />
                {t('add_consumer')}
              </button>
            </div>

            {consumerAccess.length === 0 ? (
              <p className="text-xs text-muted italic py-2">{t('no_consumer_overrides')}</p>
            ) : (
              <div className="space-y-2">
                {consumerAccess.map((row, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={row.consumer}
                      onChange={(e) => updateConsumerRow(idx, 'consumer', e.target.value)}
                      placeholder={t('consumer_name_placeholder')}
                      className={clsx(inputClasses, 'flex-1')}
                    />
                    <div className="w-48">
                      <Select
                        options={RENDER_MODES}
                        value={row.renderMode}
                        onChange={(v) => updateConsumerRow(idx, 'renderMode', v)}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeConsumerRow(idx)}
                      className="p-1.5 text-muted hover:text-error rounded transition-default"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ── Section 5: Live Test ── */}
        <section className="space-y-3">
          <h4 className="text-sm font-semibold text-foreground border-b border-default pb-2">
            {t('section_live_test')}
          </h4>

          <Textarea
            label={t('sample_text_label')}
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder={t('sample_text_placeholder')}
            rows={3}
          />

          <Button
            onClick={handleTest}
            variant="secondary"
            size="sm"
            disabled={testLoading || !testText.trim() || !canTestPattern}
            loading={testLoading}
            icon={<FlaskConical className="w-3.5 h-3.5" />}
          >
            {t('test_button')}
          </Button>

          {testResult && (
            <div className="rounded-lg border border-default bg-background-muted p-3 space-y-3">
              {/* Detections */}
              <div>
                <p className="text-xs font-medium text-foreground mb-1">
                  {t('detections_count', { count: testResult.detections.length })}
                </p>
                {testResult.detections.length === 0 ? (
                  <p className="text-xs text-muted italic">{t('no_matches')}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {testResult.detections.map((det, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-warning-subtle text-warning text-xs font-mono"
                      >
                        <CheckCircle2 className="w-3 h-3" />
                        {det.match}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Consumer Previews */}
              {Object.keys(testResult.consumerPreviews).length > 0 && (
                <div>
                  <p className="text-xs font-medium text-foreground mb-1">
                    {t('consumer_previews')}
                  </p>
                  <div className="space-y-1.5">
                    {Object.entries(testResult.consumerPreviews).map(([consumer, preview]) => (
                      <div key={consumer} className="text-xs">
                        <span className="font-medium text-muted">{consumer}:</span>{' '}
                        <span className="font-mono text-foreground">{preview}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Error ── */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-error-subtle border border-error/20">
            <AlertTriangle className="w-4 h-4 text-error mt-0.5 shrink-0" />
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        {/* ── Actions ── */}
        <div className="flex justify-end gap-3 pt-2 border-t border-default">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            {builtinOverride || isEdit ? t('save_changes') : t('create_pattern')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
