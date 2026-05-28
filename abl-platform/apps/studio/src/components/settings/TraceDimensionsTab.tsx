/**
 * TraceDimensionsTab Component
 *
 * Configure which session values are auto-extracted as indexed ClickHouse dimensions.
 * Keys set via SDK `customAttributes`, DSL `SET _meta.*`, or REST injection are always included.
 * This setting controls additional keys from session.data.values to extract.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Tags, Loader2, Check, X, Plus, Info } from 'lucide-react';
import { clsx } from 'clsx';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { Button } from '../ui/Button';
import { toast } from 'sonner';

const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const MAX_KEYS = 50;

export function TraceDimensionsTab() {
  const t = useTranslations('settings.trace_dimensions');
  const { projectId } = useNavigationStore();
  const [dimensions, setDimensions] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/settings`);
      if (res.ok) {
        const data = await res.json();
        setDimensions(data.settings?.traceDimensions ?? []);
      }
    } catch {
      // Silent — use defaults
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const addKey = () => {
    const key = inputValue.trim();
    if (!key) {
      inputRef.current?.focus();
      return;
    }

    if (!KEY_PATTERN.test(key)) {
      setInputError(
        'Key must start with a letter and contain only letters, numbers, and underscores',
      );
      return;
    }
    if (dimensions.includes(key)) {
      setInputError('Key already added');
      return;
    }
    if (dimensions.length >= MAX_KEYS) {
      setInputError(`Maximum ${MAX_KEYS} keys allowed`);
      return;
    }

    setDimensions((prev) => [...prev, key]);
    setInputValue('');
    setInputError(null);
    setIsDirty(true);
  };

  const removeKey = (key: string) => {
    setDimensions((prev) => prev.filter((k) => k !== key));
    setIsDirty(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addKey();
    }
  };

  const save = async () => {
    if (!projectId) return;
    setIsSaving(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traceDimensions: dimensions }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to save trace dimensions');
        return;
      }

      setIsDirty(false);
      toast.success(t('saved'));
    } catch {
      toast.error('Failed to save trace dimensions');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Tags className="w-5 h-5 text-accent-primary mt-0.5 shrink-0" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
          <p className="text-xs text-muted mt-1">{t('description')}</p>
        </div>
        {isDirty && (
          <Button onClick={save} disabled={isSaving} size="sm" variant="primary">
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            {t('save')}
          </Button>
        )}
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-2 p-3 rounded-lg bg-info-subtle/50 border border-default">
        <Info className="w-4 h-4 text-info mt-0.5 shrink-0" />
        <p className="text-xs text-muted">{t('info')}</p>
      </div>

      {/* Tag input */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setInputError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('placeholder')}
            className={clsx(
              'flex-1 px-3 py-2 text-sm rounded-lg border bg-background',
              'text-foreground placeholder:text-muted',
              'focus:outline-none focus:ring-2 focus:ring-border-focus-primary/30 focus:border-border-focus-primary',
              inputError ? 'border-error' : 'border-default',
            )}
          />
          <Button onClick={addKey} size="sm" variant="secondary">
            <Plus className="w-4 h-4" />
          </Button>
        </div>
        {inputError && <p className="text-xs text-error">{inputError}</p>}
      </div>

      {/* Tags display */}
      {dimensions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {dimensions.map((key) => (
            <span
              key={key}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-background-elevated text-foreground border border-default"
            >
              {key}
              <button
                onClick={() => removeKey(key)}
                className="text-muted hover:text-error transition-default"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted italic py-4 text-center">{t('empty')}</p>
      )}

      {/* Count */}
      <p className="text-xs text-muted">
        {dimensions.length} / {MAX_KEYS} {t('keys_used')}
      </p>
    </div>
  );
}
