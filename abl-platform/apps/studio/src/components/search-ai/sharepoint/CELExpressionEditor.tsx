'use client';

/**
 * CEL Expression Editor
 *
 * v1: Textarea with monospace font, field autocomplete on "resource.",
 * value autocomplete on '== "', validation button with error display.
 */

import { useState, useRef, useCallback, useMemo, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Textarea } from '../../ui/Textarea';
import { Button } from '../../ui/Button';

// ─── Types ──────────────────────────────────────────────────────────────

interface CELExpressionEditorProps {
  value: string;
  onChange: (value: string) => void;
  onValidate: () => void;
  validationResult?: {
    valid: boolean;
    error?: { position: number; description: string; suggestion?: string };
  };
  fieldSuggestions: Array<{ field: string; type: string; sampleValues?: string[] }>;
  valueSuggestions: Record<string, Array<{ value: string; docCount: number }>>;
  disabled?: boolean;
}

interface SuggestionItem {
  label: string;
  detail?: string;
}

// ─── Component ──────────────────────────────────────────────────────────

export function CELExpressionEditor({
  value,
  onChange,
  onValidate,
  validationResult,
  fieldSuggestions,
  valueSuggestions,
  disabled = false,
}: CELExpressionEditorProps) {
  const t = useTranslations('search_ai.sharepoint');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [suggestionType, setSuggestionType] = useState<'field' | 'value'>('field');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Build field suggestion items
  const fieldItems = useMemo<SuggestionItem[]>(
    () => fieldSuggestions.map((f) => ({ label: f.field, detail: f.type })),
    [fieldSuggestions],
  );

  // Detect autocomplete triggers in the current value
  const detectSuggestions = useCallback(
    (text: string, cursorPos: number) => {
      const textBefore = text.slice(0, cursorPos);

      // Check for "resource." trigger
      const resourceMatch = textBefore.match(/resource\.(\w*)$/);
      if (resourceMatch) {
        const partial = resourceMatch[1].toLowerCase();
        const filtered = fieldItems.filter((f) => f.label.toLowerCase().startsWith(partial));
        if (filtered.length > 0) {
          setSuggestions(filtered);
          setSuggestionType('field');
          setSelectedSuggestionIndex(0);
          setShowSuggestions(true);
          return;
        }
      }

      // Check for value trigger: field == " or field != "
      const valueMatch = textBefore.match(/resource\.(\w+)\s*(?:==|!=)\s*"([^"]*)$/);
      if (valueMatch) {
        const fieldName = valueMatch[1];
        const partial = valueMatch[2].toLowerCase();
        const fieldValues = valueSuggestions[fieldName];
        if (fieldValues && fieldValues.length > 0) {
          const filtered = fieldValues
            .filter((v) => v.value.toLowerCase().startsWith(partial))
            .map((v) => ({ label: v.value, detail: `${v.docCount} docs` }));
          if (filtered.length > 0) {
            setSuggestions(filtered);
            setSuggestionType('value');
            setSelectedSuggestionIndex(0);
            setShowSuggestions(true);
            return;
          }
        }
      }

      setShowSuggestions(false);
    },
    [fieldItems, valueSuggestions],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      onChange(newValue);
      detectSuggestions(newValue, e.target.selectionStart ?? newValue.length);
    },
    [onChange, detectSuggestions],
  );

  const applySuggestion = useCallback(
    (item: SuggestionItem) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const cursorPos = textarea.selectionStart ?? value.length;
      const textBefore = value.slice(0, cursorPos);
      const textAfter = value.slice(cursorPos);

      let newValue: string;
      if (suggestionType === 'field') {
        // Replace the partial after "resource."
        const match = textBefore.match(/resource\.(\w*)$/);
        if (match) {
          const prefix = textBefore.slice(0, textBefore.length - match[1].length);
          newValue = prefix + item.label + textAfter;
        } else {
          newValue = textBefore + item.label + textAfter;
        }
      } else {
        // Replace the partial value after the quote
        const match = textBefore.match(/(resource\.\w+\s*(?:==|!=)\s*")([^"]*)$/);
        if (match) {
          const prefix = textBefore.slice(0, textBefore.length - match[2].length);
          newValue = prefix + item.label + textAfter;
        } else {
          newValue = textBefore + item.label + textAfter;
        }
      }

      onChange(newValue);
      setShowSuggestions(false);
    },
    [value, onChange, suggestionType],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!showSuggestions || suggestions.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedSuggestionIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedSuggestionIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applySuggestion(suggestions[selectedSuggestionIndex]);
      } else if (e.key === 'Escape') {
        setShowSuggestions(false);
      }
    },
    [showSuggestions, suggestions, selectedSuggestionIndex, applySuggestion],
  );

  return (
    <div className="space-y-3">
      <div className="relative">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            // Delay hiding so click on suggestion can register
            setTimeout(() => setShowSuggestions(false), 200);
          }}
          disabled={disabled}
          className="font-mono text-sm min-h-[120px]"
          placeholder={t('cel_editor_placeholder')}
          aria-label={t('cel_editor_aria_label')}
        />

        {/* Autocomplete dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div
            className="absolute left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto rounded-lg border border-default bg-background-elevated shadow-xl"
            role="listbox"
            aria-label={t('cel_editor_suggestions_label')}
          >
            {suggestions.map((item, index) => (
              <button
                key={item.label}
                type="button"
                role="option"
                aria-selected={index === selectedSuggestionIndex}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left cursor-pointer transition-default ${
                  index === selectedSuggestionIndex
                    ? 'bg-background-muted text-foreground'
                    : 'text-foreground-muted hover:bg-background-muted'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySuggestion(item);
                }}
              >
                <span className="font-mono">{item.label}</span>
                {item.detail && <span className="text-xs text-muted ml-2">{item.detail}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Validate button */}
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={onValidate} disabled={disabled || !value}>
          {t('cel_editor_validate')}
        </Button>

        {/* Validation result */}
        {validationResult && (
          <div className="flex items-center gap-2 text-sm">
            {validationResult.valid ? (
              <span className="text-success">{t('cel_editor_valid')}</span>
            ) : validationResult.error ? (
              <span className="text-error">
                {t('cel_editor_error_at_position', {
                  position: validationResult.error.position,
                  description: validationResult.error.description,
                })}
                {validationResult.error.suggestion && (
                  <span className="text-muted ml-1">
                    {t('cel_editor_suggestion', {
                      suggestion: validationResult.error.suggestion,
                    })}
                  </span>
                )}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
