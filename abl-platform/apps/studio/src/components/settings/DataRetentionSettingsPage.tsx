'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Database, Loader2, RotateCcw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch } from '../../lib/api-client';
import { Button } from '../ui/Button';
import { Toggle } from '../ui/Toggle';

interface EvalRetentionSettings {
  evalConversationsTtlDays: number;
  evalScoresTtlDays: number;
  productionScoresTtlDays: number;
  syntheticTtlDays: number;
  hardDeleteExpiredRuns: boolean;
  scrubPiiOnStore: boolean;
}

interface TenantRetentionResponse {
  success: boolean;
  data?: {
    defaults: EvalRetentionSettings;
    effective: EvalRetentionSettings;
  };
  error?: {
    message?: string;
  };
}

const TTL_MIN_DAYS = 7;
const TTL_MAX_DAYS = 730;

function ttlLabel(value: number): string {
  return `${value} ${value === 1 ? 'day' : 'days'}`;
}

function RetentionSummaryItem({
  label,
  value,
  defaultValue,
}: {
  label: string;
  value: number;
  defaultValue: number;
}) {
  const isOverride = value !== defaultValue;

  return (
    <div className="rounded-lg border border-default bg-background-elevated p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {isOverride && (
          <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-medium text-accent">
            Override
          </span>
        )}
      </div>
      <div className="mt-3 text-2xl font-semibold text-foreground">{ttlLabel(value)}</div>
      <p className="mt-1 text-xs text-muted">Default: {ttlLabel(defaultValue)}</p>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <input
        className="mt-1 w-full rounded-md border border-default bg-background px-3 py-2 text-sm text-foreground outline-none transition-default focus:border-border-focus focus:ring-2 focus:ring-border-focus/20"
        min={TTL_MIN_DAYS}
        max={TTL_MAX_DAYS}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function DataRetentionSettingsPage() {
  const [defaults, setDefaults] = useState<EvalRetentionSettings | null>(null);
  const [form, setForm] = useState<EvalRetentionSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/tenant/retention');
      const data = (await res.json()) as TenantRetentionResponse;
      if (!res.ok || !data.success || !data.data) {
        throw new Error(data.error?.message ?? 'Failed to load retention settings');
      }
      setDefaults(data.data.defaults);
      setForm(data.data.effective);
    } catch {
      toast.error('Failed to load retention settings');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const validationError = useMemo(() => {
    if (!form) return null;
    const values = [
      form.evalConversationsTtlDays,
      form.evalScoresTtlDays,
      form.productionScoresTtlDays,
      form.syntheticTtlDays,
    ];
    if (values.some((value) => !Number.isFinite(value))) {
      return 'TTL values must be valid numbers.';
    }
    if (values.some((value) => value < TTL_MIN_DAYS || value > TTL_MAX_DAYS)) {
      return `TTL values must be between ${TTL_MIN_DAYS} and ${TTL_MAX_DAYS} days.`;
    }
    if (form.syntheticTtlDays >= form.evalConversationsTtlDays) {
      return 'Synthetic eval retention must be shorter than conversation retention.';
    }
    if (form.syntheticTtlDays >= form.evalScoresTtlDays) {
      return 'Synthetic eval retention must be shorter than eval score retention.';
    }
    return null;
  }, [form]);

  const updateForm = <Key extends keyof EvalRetentionSettings>(
    key: Key,
    value: EvalRetentionSettings[Key],
  ) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const handleReset = () => {
    if (defaults) {
      setForm(defaults);
    }
  };

  const handleSave = async () => {
    if (!form || validationError) return;

    setIsSaving(true);
    try {
      const res = await apiFetch('/api/tenant/retention', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = (await res.json()) as TenantRetentionResponse;
      if (!res.ok || !data.success || !data.data) {
        throw new Error(data.error?.message ?? 'Failed to save retention settings');
      }
      setDefaults(data.data.defaults);
      setForm(data.data.effective);
      toast.success('Retention settings saved');
    } catch {
      toast.error('Failed to save retention settings');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || !defaults || !form) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-foreground-muted" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-foreground-muted" />
            <h2 className="text-xl font-semibold text-foreground">Data Retention</h2>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Configure how long eval transcripts, eval scores, and production score rows remain
            available for this tenant.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            type="button"
            icon={<RotateCcw className="h-4 w-4" />}
            onClick={handleReset}
          >
            Reset
          </Button>
          <Button
            type="button"
            icon={<Save className="h-4 w-4" />}
            loading={isSaving}
            disabled={Boolean(validationError)}
            onClick={handleSave}
          >
            Save
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <RetentionSummaryItem
          label="Eval conversations"
          value={form.evalConversationsTtlDays}
          defaultValue={defaults.evalConversationsTtlDays}
        />
        <RetentionSummaryItem
          label="Eval scores"
          value={form.evalScoresTtlDays}
          defaultValue={defaults.evalScoresTtlDays}
        />
        <RetentionSummaryItem
          label="Production scores"
          value={form.productionScoresTtlDays}
          defaultValue={defaults.productionScoresTtlDays}
        />
        <RetentionSummaryItem
          label="Synthetic eval runs"
          value={form.syntheticTtlDays}
          defaultValue={defaults.syntheticTtlDays}
        />
      </div>

      <div className="rounded-lg border border-default bg-background-elevated p-5">
        <div className="mb-4 flex items-center gap-2">
          <Clock className="h-4 w-4 text-foreground-muted" />
          <h3 className="text-base font-medium text-foreground">Retention windows</h3>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <NumberField
            label="Eval conversation transcript TTL"
            value={form.evalConversationsTtlDays}
            onChange={(value) => updateForm('evalConversationsTtlDays', value)}
          />
          <NumberField
            label="Eval score TTL"
            value={form.evalScoresTtlDays}
            onChange={(value) => updateForm('evalScoresTtlDays', value)}
          />
          <NumberField
            label="Production score TTL"
            value={form.productionScoresTtlDays}
            onChange={(value) => updateForm('productionScoresTtlDays', value)}
          />
          <NumberField
            label="Synthetic eval TTL"
            value={form.syntheticTtlDays}
            onChange={(value) => updateForm('syntheticTtlDays', value)}
          />
        </div>
        {validationError && <p className="mt-3 text-sm text-error">{validationError}</p>}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-default bg-background-elevated p-5">
          <div className="mb-4 flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-foreground-muted" />
            <h3 className="text-base font-medium text-foreground">Expired run cleanup</h3>
          </div>
          <Toggle
            checked={form.hardDeleteExpiredRuns}
            onChange={(checked) => updateForm('hardDeleteExpiredRuns', checked)}
            label="Hard delete expired runs"
            description="When off, expired runs are archived and summaries stay visible."
          />
        </div>

        <div className="rounded-lg border border-default bg-background-elevated p-5">
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-foreground-muted" />
            <h3 className="text-base font-medium text-foreground">Eval definition storage</h3>
          </div>
          <Toggle
            checked={form.scrubPiiOnStore}
            onChange={(checked) => updateForm('scrubPiiOnStore', checked)}
            label="Scrub PII before storing eval prompts"
            description="Masks common emails, phones, SSNs, and cards in personas and scenarios."
          />
        </div>
      </div>
    </div>
  );
}
