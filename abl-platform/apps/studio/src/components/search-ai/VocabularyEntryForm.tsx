/**
 * VocabularyEntryForm Component
 *
 * Form for creating and editing vocabulary entries.
 * Uses React Hook Form + Zod validation with Studio components.
 * Field Reference uses a searchable dropdown of canonical schema fields.
 */

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import useSWR from 'swr';
import { ChevronDown, Check } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import { Checkbox } from '../ui/Checkbox';
import { Toggle } from '../ui/Toggle';
import { RadioGroup } from '../ui/RadioGroup';
import { Alert } from '../ui/Alert';
import { sanitizeError } from '@/lib/sanitize-error';
import {
  createVocabularyEntry,
  updateVocabularyEntry,
  type VocabularyEntry,
  type CreateVocabularyEntryInput,
  type UpdateVocabularyEntryInput,
  type CanonicalSchemaData,
} from '../../api/search-ai';

// Type display labels
const TYPE_DISPLAY: Record<string, string> = {
  string: 'Text',
  keyword: 'Text',
  text: 'Text',
  number: 'Number',
  float: 'Number',
  integer: 'Number',
  date: 'Date',
  boolean: 'Boolean',
  array: 'List',
};

// Validation schema
const vocabularyEntrySchema = z.object({
  term: z
    .string()
    .min(2, 'Term must be at least 2 characters')
    .max(50, 'Term must be at most 50 characters'),
  aliases: z.string().optional(),
  description: z.string().max(500, 'Description must be at most 500 characters').optional(),
  fieldRef: z.string().min(1, 'Field reference is required'),
  capabilities: z
    .object({
      canFilter: z.boolean(),
      canDisplay: z.boolean(),
      canAggregate: z.boolean(),
      canSort: z.boolean(),
    })
    .refine((caps) => caps.canFilter || caps.canDisplay || caps.canAggregate || caps.canSort, {
      message: 'At least one capability must be enabled',
    }),
  displayWith: z.string().optional(),
  aggregateWith: z.string().optional(),
  enabled: z.boolean(),
  generatedBy: z.enum(['auto', 'manual']),
});

type FormValues = z.infer<typeof vocabularyEntrySchema>;

interface VocabularyEntryFormProps {
  indexId: string;
  entry?: VocabularyEntry; // If provided, edit mode
  onSuccess: () => void;
  onCancel: () => void;
}

export function VocabularyEntryForm({
  indexId,
  entry,
  onSuccess,
  onCancel,
}: VocabularyEntryFormProps) {
  const t = useTranslations('search_ai.vocabulary');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Fetch canonical schema fields for the dropdown
  const { data: schemaData } = useSWR<{ schema: CanonicalSchemaData }>(
    indexId ? `/api/search-ai/schemas/${indexId}` : null,
    { onError: () => {} },
  );
  const schemaFields = schemaData?.schema?.fields ?? [];

  // Field Reference dropdown state
  const [fieldRefDropdownOpen, setFieldRefDropdownOpen] = useState(false);
  const [fieldRefSearch, setFieldRefSearch] = useState('');
  const [activeFieldRefIndex, setActiveFieldRefIndex] = useState(-1);
  const fieldRefDropdownRef = useRef<HTMLDivElement>(null);
  const fieldRefSearchInputRef = useRef<HTMLInputElement>(null);

  const isEditMode = !!entry;

  // Initialize form
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
    watch,
    setValue,
  } = useForm<FormValues>({
    resolver: zodResolver(vocabularyEntrySchema),
    defaultValues: {
      term: entry?.term || '',
      aliases: entry?.aliases.join(', ') || '',
      description: entry?.description || '',
      fieldRef: entry?.fieldRef || '',
      capabilities: {
        canFilter: entry?.capabilities.canFilter || false,
        canDisplay: entry?.capabilities.canDisplay || true,
        canAggregate: entry?.capabilities.canAggregate || false,
        canSort: entry?.capabilities.canSort || false,
      },
      displayWith: entry?.relatedFields.displayWith.join(', ') || '',
      aggregateWith: entry?.relatedFields.aggregateWith.join(', ') || '',
      enabled: entry?.enabled ?? true,
      generatedBy: entry?.generatedBy || 'manual',
    },
  });

  const capabilities = watch('capabilities');
  const currentFieldRef = watch('fieldRef');

  // Fuzzy match helper
  const fuzzyScore = useCallback((query: string, text: string): number => {
    if (!query || !text) return 0;
    const q = query.toLowerCase();
    const tt = text.toLowerCase();
    if (tt === q) return 3;
    if (tt.startsWith(q)) return 2.5;
    if (tt.includes(q)) return 2;
    const words = tt.split(/[\s_.\-/]+/);
    for (const w of words) {
      if (w.startsWith(q)) return 1.5;
    }
    return 0;
  }, []);

  // Filtered schema fields for dropdown
  const filteredSchemaFields = useMemo(() => {
    if (!schemaFields.length) return [];
    let fields = [...schemaFields];
    const sq = fieldRefSearch.toLowerCase();
    if (sq.length >= 1) {
      fields = fields.filter((f) => fuzzyScore(sq, f.label) > 0 || fuzzyScore(sq, f.name) > 0);
    }
    fields.sort((a, b) => {
      if (sq.length >= 1) {
        const sa = Math.max(fuzzyScore(sq, a.label), fuzzyScore(sq, a.name));
        const sb = Math.max(fuzzyScore(sq, b.label), fuzzyScore(sq, b.name));
        if (sb !== sa) return sb - sa;
      }
      return a.label.localeCompare(b.label);
    });
    return fields;
  }, [schemaFields, fieldRefSearch, fuzzyScore]);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (fieldRefDropdownRef.current && !fieldRefDropdownRef.current.contains(e.target as Node)) {
        setFieldRefDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Select a field from the dropdown
  const selectField = useCallback(
    (fieldName: string) => {
      setValue('fieldRef', fieldName, { shouldValidate: true });
      setFieldRefDropdownOpen(false);
      setFieldRefSearch('');

      // Auto-set capabilities based on field properties
      const field = schemaFields.find((f) => f.name === fieldName);
      if (field) {
        setValue('capabilities.canFilter', field.filterable, { shouldValidate: true });
        setValue('capabilities.canSort', field.sortable, { shouldValidate: true });
        setValue('capabilities.canAggregate', field.aggregatable, { shouldValidate: true });
        setValue('capabilities.canDisplay', true, { shouldValidate: true });
      }
    },
    [schemaFields, setValue],
  );

  // Auto-suggest: pick the best matching field when term changes
  const autoSuggestFromTerm = useCallback(
    (term: string) => {
      if (term.trim().length < 2 || schemaFields.length === 0) {
        // Clear auto-suggestion
        if (currentFieldRef) {
          setValue('fieldRef', '', { shouldValidate: false });
        }
        return;
      }

      let bestField: (typeof schemaFields)[0] | null = null;
      let bestScore = 0;
      for (const f of schemaFields) {
        const score = Math.max(
          fuzzyScore(term.trim(), f.label) * 1.5,
          fuzzyScore(term.trim(), f.name),
        );
        if (score > bestScore) {
          bestScore = score;
          bestField = f;
        }
      }

      if (bestField && bestScore >= 1.5) {
        selectField(bestField.name);
      } else if (currentFieldRef) {
        setValue('fieldRef', '', { shouldValidate: false });
      }
    },
    [schemaFields, fuzzyScore, currentFieldRef, selectField, setValue],
  );

  // Get the display label for the currently selected field
  const selectedFieldLabel = useMemo(() => {
    if (!currentFieldRef) return null;
    const field = schemaFields.find((f) => f.name === currentFieldRef);
    return field ? field.label : null;
  }, [currentFieldRef, schemaFields]);

  // Form submission
  const onSubmit = async (data: FormValues) => {
    setSaving(true);
    setFormError(null);

    try {
      // Parse comma-separated strings into arrays
      const aliases = data.aliases
        ? data.aliases
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean)
        : [];
      const displayWith = data.displayWith
        ? data.displayWith
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean)
        : [];
      const aggregateWith = data.aggregateWith
        ? data.aggregateWith
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean)
        : [];

      if (isEditMode && entry) {
        // Update existing entry
        const updateData: UpdateVocabularyEntryInput = {
          aliases,
          description: data.description || undefined,
          capabilities: data.capabilities,
          relatedFields: {
            displayWith,
            aggregateWith,
          },
          enabled: data.enabled,
        };
        await updateVocabularyEntry(indexId, entry.id, updateData);
        toast.success(t('toast_updated'));
      } else {
        // Create new entry
        const createData: CreateVocabularyEntryInput = {
          term: data.term,
          aliases,
          description: data.description || undefined,
          fieldRef: data.fieldRef,
          capabilities: data.capabilities,
          relatedFields: {
            displayWith,
            aggregateWith,
          },
          enabled: data.enabled,
          generatedBy: data.generatedBy,
        };
        await createVocabularyEntry(indexId, createData);
        toast.success(t('toast_created'));
      }

      onSuccess();
    } catch (err) {
      const msg = sanitizeError(err, isEditMode ? t('error_update') : t('error_create'));
      setFormError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Term */}
      <div>
        <Controller
          name="term"
          control={control}
          render={({ field }) => (
            <Input
              label={t('field_term')}
              placeholder={t('field_term_placeholder')}
              disabled={isEditMode}
              error={errors.term?.message}
              value={field.value}
              onChange={(e) => {
                field.onChange(e);
                // Auto-suggest field reference as user types the term
                if (!isEditMode) {
                  autoSuggestFromTerm(e.target.value);
                }
              }}
              onBlur={field.onBlur}
              name={field.name}
              ref={field.ref}
            />
          )}
        />
        {isEditMode && <p className="text-xs text-muted mt-1">{t('field_term_readonly')}</p>}
      </div>

      {/* Aliases */}
      <div>
        <Input
          label={t('field_aliases')}
          placeholder={t('field_aliases_placeholder')}
          error={errors.aliases?.message}
          {...register('aliases')}
        />
        <p className="text-xs text-muted mt-1">{t('field_aliases_hint')}</p>
      </div>

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">
          {t('field_description')}
        </label>
        <Textarea
          placeholder={t('field_description_placeholder')}
          rows={3}
          error={errors.description?.message}
          {...register('description')}
        />
      </div>

      {/* Field Reference — searchable dropdown */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">
          {t('field_field_ref')}
          {selectedFieldLabel && (
            <span className="ml-2 text-xs font-normal text-success">
              <Check className="w-3 h-3 inline -mt-0.5 mr-0.5" />
              {selectedFieldLabel}
            </span>
          )}
        </label>
        {isEditMode ? (
          <>
            <Input
              placeholder={t('field_field_ref_placeholder')}
              disabled
              error={errors.fieldRef?.message}
              {...register('fieldRef')}
            />
            <p className="text-xs text-muted mt-1">{t('field_field_ref_readonly')}</p>
          </>
        ) : (
          <div className="relative" ref={fieldRefDropdownRef}>
            <button
              type="button"
              onClick={() => {
                setFieldRefDropdownOpen(!fieldRefDropdownOpen);
                setFieldRefSearch('');
                setActiveFieldRefIndex(-1);
                if (!fieldRefDropdownOpen) {
                  setTimeout(() => fieldRefSearchInputRef.current?.focus(), 50);
                }
              }}
              className="w-full flex items-center justify-between rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 text-left transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
            >
              <span
                className={currentFieldRef ? 'font-mono text-xs text-foreground' : 'text-subtle'}
              >
                {currentFieldRef || 'Select a schema field...'}
              </span>
              <ChevronDown
                className={`w-4 h-4 text-muted transition-transform ${fieldRefDropdownOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {/* Dropdown */}
            {fieldRefDropdownOpen && (
              <div className="absolute z-[101] top-[calc(100%+4px)] left-0 right-0 bg-background-elevated border border-default rounded-xl shadow-xl max-h-[280px] overflow-hidden flex flex-col">
                {/* Search input */}
                <div className="p-2 border-b border-default">
                  <input
                    ref={fieldRefSearchInputRef}
                    type="text"
                    value={fieldRefSearch}
                    onChange={(e) => {
                      setFieldRefSearch(e.target.value);
                      setActiveFieldRefIndex(-1);
                    }}
                    onKeyDown={(e) => {
                      if (filteredSchemaFields.length === 0) return;
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setActiveFieldRefIndex((prev) =>
                          Math.min(prev + 1, filteredSchemaFields.length - 1),
                        );
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setActiveFieldRefIndex((prev) => Math.max(prev - 1, 0));
                      } else if (e.key === 'Enter' && activeFieldRefIndex >= 0) {
                        e.preventDefault();
                        selectField(filteredSchemaFields[activeFieldRefIndex].name);
                      } else if (e.key === 'Escape') {
                        setFieldRefDropdownOpen(false);
                      }
                    }}
                    placeholder="Search fields..."
                    className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus"
                  />
                </div>

                {/* Field items */}
                <div className="overflow-y-auto flex-1">
                  {filteredSchemaFields.length === 0 ? (
                    <div className="p-4 text-xs text-muted text-center">
                      {schemaFields.length === 0
                        ? 'Loading schema fields...'
                        : 'No fields match your search'}
                    </div>
                  ) : (
                    <>
                      {filteredSchemaFields.map((field, i) => {
                        const displayType = TYPE_DISPLAY[field.type] || field.type;
                        const isSelected = currentFieldRef === field.name;
                        return (
                          <button
                            key={field.name}
                            type="button"
                            onClick={() => selectField(field.name)}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-left border-b border-default/50 transition-colors cursor-pointer ${
                              i === activeFieldRefIndex
                                ? 'bg-accent-subtle'
                                : isSelected
                                  ? 'bg-success-subtle/30'
                                  : 'hover:bg-background-muted'
                            }`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="font-mono text-xs text-foreground truncate">
                                {field.storageField || field.name}
                              </div>
                              <div className="text-[11px] text-muted truncate">{field.label}</div>
                            </div>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-background-muted text-muted uppercase tracking-wide shrink-0">
                              {displayType}
                            </span>
                            {isSelected && <Check className="w-3.5 h-3.5 text-success shrink-0" />}
                          </button>
                        );
                      })}
                      <div className="px-3 py-1.5 text-[10px] text-muted text-center bg-background-muted border-t border-default sticky bottom-0">
                        {filteredSchemaFields.length} of {schemaFields.length} fields
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {errors.fieldRef?.message && (
              <p className="text-sm text-error mt-1">{errors.fieldRef.message}</p>
            )}
          </div>
        )}
      </div>

      {/* Capabilities */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-3">
          {t('field_capabilities')}
        </label>
        <div className="space-y-2.5">
          <Controller
            name="capabilities.canFilter"
            control={control}
            render={({ field }) => (
              <Checkbox
                checked={field.value}
                onChange={field.onChange}
                label={t('cap_filter')}
                description={t('cap_filter_desc')}
              />
            )}
          />
          <Controller
            name="capabilities.canDisplay"
            control={control}
            render={({ field }) => (
              <Checkbox
                checked={field.value}
                onChange={field.onChange}
                label={t('cap_display')}
                description={t('cap_display_desc')}
              />
            )}
          />
          <Controller
            name="capabilities.canAggregate"
            control={control}
            render={({ field }) => (
              <Checkbox
                checked={field.value}
                onChange={field.onChange}
                label={t('cap_aggregate')}
                description={t('cap_aggregate_desc')}
              />
            )}
          />
          <Controller
            name="capabilities.canSort"
            control={control}
            render={({ field }) => (
              <Checkbox
                checked={field.value}
                onChange={field.onChange}
                label={t('cap_sort')}
                description={t('cap_sort_desc')}
              />
            )}
          />
        </div>
        {errors.capabilities?.message && (
          <p className="text-sm text-error mt-2">{errors.capabilities.message}</p>
        )}
      </div>

      {/* Related Fields - Display With */}
      {capabilities.canDisplay && (
        <div>
          <Input
            label={t('field_display_with')}
            placeholder={t('field_display_with_placeholder')}
            error={errors.displayWith?.message}
            {...register('displayWith')}
          />
          <p className="text-xs text-muted mt-1">{t('field_display_with_hint')}</p>
        </div>
      )}

      {/* Related Fields - Aggregate With */}
      {capabilities.canAggregate && (
        <div>
          <Input
            label={t('field_aggregate_with')}
            placeholder={t('field_aggregate_with_placeholder')}
            error={errors.aggregateWith?.message}
            {...register('aggregateWith')}
          />
          <p className="text-xs text-muted mt-1">{t('field_aggregate_with_hint')}</p>
        </div>
      )}

      {/* Generated By (create mode only) */}
      {!isEditMode && (
        <Controller
          name="generatedBy"
          control={control}
          render={({ field }) => (
            <RadioGroup
              label={t('field_generated_by')}
              options={[
                { value: 'manual', label: t('source_manual') },
                { value: 'auto', label: t('source_auto') },
              ]}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
      )}

      {/* Enabled Toggle */}
      <Controller
        name="enabled"
        control={control}
        render={({ field }) => (
          <Toggle
            checked={field.value}
            onChange={field.onChange}
            label={t('field_enabled')}
            description={t('field_enabled_desc')}
          />
        )}
      />

      {/* Form Error */}
      {formError && (
        <Alert variant="error" title={t('form_error_title')}>
          {formError}
        </Alert>
      )}

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
          {t('cancel')}
        </Button>
        <Button type="submit" loading={saving} className="flex-1">
          {isEditMode ? t('save_changes') : t('create_entry')}
        </Button>
      </div>
    </form>
  );
}
