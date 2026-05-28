/**
 * TemplateJsonEditor — Editable JSON textarea for template data.
 *
 * Debounced validation with maxLength limit.
 */

'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';

const MAX_JSON_LENGTH = 10_000;
const DEBOUNCE_MS = 300;

export interface TemplateJsonEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function TemplateJsonEditor({ value, onChange }: TemplateJsonEditorProps) {
  const t = useTranslations('templates');
  const [localValue, setLocalValue] = useState(value);
  const [validationError, setValidationError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync external value changes
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      if (newValue.length > MAX_JSON_LENGTH) return;
      setLocalValue(newValue);

      // Debounced validation and propagation
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        try {
          JSON.parse(newValue);
          setValidationError(null);
          onChange(newValue);
        } catch {
          setValidationError(t('invalid_json'));
        }
      }, DEBOUNCE_MS);
    },
    [onChange, t],
  );

  return (
    <div className="flex flex-col gap-1">
      <textarea
        className="h-48 w-full resize-y rounded border border-default bg-background p-3 font-mono text-xs text-foreground focus:border-border-focus focus:outline-none"
        value={localValue}
        onChange={handleChange}
        maxLength={MAX_JSON_LENGTH}
        spellCheck={false}
        aria-label={t('json_editor_label')}
      />
      {validationError && <span className="text-xs text-error">{validationError}</span>}
      <span className="text-xs text-muted">
        {localValue.length}/{MAX_JSON_LENGTH}
      </span>
    </div>
  );
}
