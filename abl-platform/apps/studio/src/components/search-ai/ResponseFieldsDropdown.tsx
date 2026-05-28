/**
 * ResponseFieldsDropdown — multi-select dropdown for configuring
 * which metadata fields are included in search results sent to the LLM agent.
 *
 * Lives in the Fields tab (Intelligence section). Reads/writes to
 * SearchIndex.searchDefaults.responseFields via the search-ai engine API.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useSWRConfig } from 'swr';
import {
  updateSearchDefaults,
  getIndex,
  type CanonicalSchemaData,
  type SearchAIIndex,
} from '../../api/search-ai';
import { toast } from 'sonner';

const DEFAULT_RESPONSE_FIELDS = ['title', 'content'];

const CORE_FIELD_OPTIONS: Array<{ storageField: string; label: string }> = [
  { storageField: 'title', label: 'Title' },
  { storageField: 'content', label: 'Content' },
  { storageField: 'content_summary', label: 'Content Summary' },
  { storageField: 'source_type', label: 'Source Type' },
  { storageField: 'source_url', label: 'Source URL' },
  { storageField: 'created_date', label: 'Created Date' },
  { storageField: 'modified_date', label: 'Modified Date' },
  { storageField: 'author', label: 'Author' },
  { storageField: 'access_level', label: 'Access Level' },
  { storageField: 'language', label: 'Language' },
  { storageField: 'mime_type', label: 'MIME Type' },
  { storageField: 'status', label: 'Status' },
  { storageField: 'category', label: 'Category' },
];

interface ResponseFieldsDropdownProps {
  indexId: string;
  schema: CanonicalSchemaData | null;
}

export function ResponseFieldsDropdown({ indexId, schema }: ResponseFieldsDropdownProps) {
  const { mutate } = useSWRConfig();
  const [open, setOpen] = useState(false);
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [indexData, setIndexData] = useState<SearchAIIndex | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!indexId) return;
    let cancelled = false;
    getIndex(indexId)
      .then((res) => {
        if (cancelled) return;
        setIndexData(res.index);
        const saved = res.index.searchDefaults.responseFields;
        setSelectedFields(Array.isArray(saved) ? saved : DEFAULT_RESPONSE_FIELDS);
      })
      .catch((err) => {
        console.warn(
          '[ResponseFields] Failed to load index:',
          err instanceof Error ? err.message : String(err),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [indexId]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const availableFields = useMemo(() => {
    const schemaFields: Array<{ storageField: string; label: string }> =
      schema?.fields?.map((f) => ({
        storageField: f.storageField,
        label: f.label || f.name,
      })) ?? [];

    const coreKeys = new Set(schemaFields.map((f) => f.storageField));
    const missing = CORE_FIELD_OPTIONS.filter((f) => !coreKeys.has(f.storageField));
    return [...missing, ...schemaFields];
  }, [schema?.fields]);

  const handleToggle = useCallback(
    async (field: string) => {
      if (!indexData) return;
      const next = selectedFields.includes(field)
        ? selectedFields.filter((f) => f !== field)
        : [...selectedFields, field];
      setSelectedFields(next);
      setSaving(true);
      try {
        const res = await updateSearchDefaults(indexData._id, {
          topK: indexData.searchDefaults.topK,
          similarityThreshold: indexData.searchDefaults.similarityThreshold,
          includeMetadata: indexData.searchDefaults.includeMetadata,
          includeContent: indexData.searchDefaults.includeContent,
          responseFields: next,
        });
        if (res.index) {
          setIndexData(res.index);
          setSelectedFields(res.index.searchDefaults.responseFields ?? next);
          mutate([`/indexes/${indexId}`, indexId]);
        }
      } catch (err) {
        setSelectedFields(selectedFields);
        toast.error('Failed to update response fields');
      } finally {
        setSaving(false);
      }
    },
    [selectedFields, indexData],
  );

  const selectedLabels = useMemo(() => {
    const labels: string[] = [];
    for (const f of selectedFields.slice(0, 3)) {
      const match = availableFields.filter((af) => af.storageField === f)[0];
      labels.push(match?.label ?? f);
    }
    return labels;
  }, [selectedFields, availableFields]);

  if (!indexData) return null;

  return (
    <div
      className="rounded-xl border border-default bg-surface p-4"
      data-testid="response-fields-section"
    >
      <div className="flex items-center justify-between mb-2">
        <div>
          <h4 className="text-sm font-medium text-foreground">Response Fields</h4>
          <p className="text-xs text-muted mt-0.5">
            Metadata fields included with each result sent to the LLM agent.
          </p>
        </div>
        <span className="text-xs text-muted" data-testid="response-fields-count">
          {selectedFields.length}/{availableFields.length}
        </span>
      </div>

      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2.5 px-3 text-left transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
          data-testid="response-fields-trigger"
        >
          <span className="text-sm text-foreground truncate">
            {selectedFields.length === 0
              ? 'Select fields...'
              : `${selectedLabels.join(', ')}${selectedFields.length > 3 ? ` +${selectedFields.length - 3} more` : ''}`}
          </span>
          <ChevronDown
            className={`w-4 h-4 text-muted transition-transform flex-shrink-0 ml-2 ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {open && (
          <div
            className="absolute z-[101] top-[calc(100%+4px)] left-0 right-0 bg-background-elevated border border-default rounded-xl shadow-xl max-h-[260px] overflow-y-auto"
            data-testid="response-fields-dropdown"
          >
            {availableFields.map((field) => {
              const isSelected = selectedFields.includes(field.storageField);
              return (
                <button
                  key={field.storageField}
                  type="button"
                  onClick={() => handleToggle(field.storageField)}
                  disabled={saving}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors border-b border-default/30 last:border-b-0 ${
                    isSelected ? 'bg-success-subtle' : 'hover:bg-background-muted'
                  } ${saving ? 'opacity-60' : ''}`}
                  data-testid={`response-field-option-${field.storageField}`}
                >
                  <div
                    className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                      isSelected ? 'bg-success border-success' : 'border-default'
                    }`}
                  >
                    {isSelected && <Check className="w-3 h-3 text-surface" />}
                  </div>
                  <span className="flex-1 truncate">{field.label}</span>
                  <span className="font-mono text-xs text-muted">{field.storageField}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
