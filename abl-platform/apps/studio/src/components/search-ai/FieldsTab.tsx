/**
 * FieldsTab Component (replaces SchemaTab)
 *
 * Three sections:
 * 1. My Fields — canonical fields with expandable connector sources
 * 2. Suggested Mappings — LLM suggestions pending review, grouped by connector
 * 3. Unmapped Fields — discovered connector fields without mappings
 *
 * Users see business-friendly names (aliases), not OpenSearch internals.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  Plus,
  Check,
  X,
  Edit2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Search,
  BookOpen,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../ui/Button';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { DataTable, type Column } from '../ui/DataTable';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import { EmptyState } from '../ui/EmptyState';
import { Tabs } from '../ui/Tabs';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useSearchAIMappings } from '../../hooks/useSearchAIMappings';
import { useFieldsTabStats } from '../../hooks/useFieldsTabStats';
import {
  updateCanonicalSchema,
  confirmMapping,
  rejectMapping,
  deleteMapping,
  patchMapping,
  bulkActionMappings,
  createManualMapping,
  getUnmappedFields,
  type CanonicalField,
  type CanonicalSchemaData,
  type FieldMappingData,
  type UnmappedField,
  MAPPING_STATUS,
} from '../../api/search-ai';
import { VocabularyReviewDialog } from './VocabularyReviewDialog';
import { ResponseFieldsDropdown } from './ResponseFieldsDropdown';
import { toast } from 'sonner';
import useSWR from 'swr';

interface FieldsTabProps {
  indexId: string;
  sources?: Array<{ _id: string; name: string; connectorType?: string }>;
}

// ─── User-friendly type labels ──────────────────────────────────────────

const TYPE_OPTIONS = [
  { value: '', label: 'All Types' },
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'array', label: 'List' },
];

/** Map connector field types → canonical types for auto-fill */
const TYPE_MAP: Record<string, string> = {
  string: 'string',
  keyword: 'string',
  text: 'string',
  number: 'number',
  float: 'number',
  integer: 'number',
  date: 'date',
  boolean: 'boolean',
  array: 'array',
};

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

const TRANSFORM_DISPLAY: Record<string, string> = {
  direct: 'Direct copy',
  lowercase: 'Lowercase',
  uppercase: 'Uppercase',
  split: 'Split into list',
  join: 'Join',
  parse_date: 'Date conversion',
  value_map: 'Value mapping',
  rename_value: 'Value mapping',
  date_format: 'Date conversion',
  coalesce: 'First available',
  extract: 'Regex extract',
  compute: 'Computed',
};

const confidenceVariant = (c: number): BadgeVariant => {
  if (c >= 0.8) return 'success';
  if (c >= 0.5) return 'warning';
  return 'error';
};

const confidenceLabel = (c: number): string => {
  if (c >= 0.8) return 'High';
  if (c >= 0.5) return 'Medium';
  return 'Low';
};

const confidenceRowStyle = (c: number): string => {
  if (c >= 0.8) return 'bg-success-subtle border-l-2 border-success';
  if (c >= 0.5) return 'bg-warning-subtle border-l-2 border-warning';
  return 'bg-background border-l-2 border-default';
};

// ─── Component ──────────────────────────────────────────────────────────

export function FieldsTab({ indexId, sources }: FieldsTabProps) {
  const t = useTranslations('search_ai.schema');

  // Data fetching — indexId is SearchIndex._id, used consistently across all backend queries
  const schemaLookupId = indexId;
  const { data: schemaData, mutate: mutateSchema } = useSWR<{ schema: CanonicalSchemaData }>(
    indexId ? `/api/search-ai/schemas/${schemaLookupId}` : null,
    { onError: () => {} },
  );
  const schema = schemaData?.schema ?? null;
  const schemaId = schema?._id ?? null;
  const { mappings, refresh: refreshMappings } = useSearchAIMappings(schemaId, {
    status: 'active',
    includeSystemFields: true,
  });

  // Tab stats
  const { stats, refresh: refreshStats } = useFieldsTabStats(indexId);

  // State
  const [activeTab, setActiveTab] = useState('my-fields');
  const [fieldDialogOpen, setFieldDialogOpen] = useState(false);
  const [editingField, setEditingField] = useState<CanonicalField | null>(null);
  const [removingMapping, setRemovingMapping] = useState<FieldMappingData | null>(null);
  const [expandedSuggestion, setExpandedSuggestion] = useState<string | null>(null);
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [editingMapping, setEditingMapping] = useState<FieldMappingData | null>(null);
  const [editAlias, setEditAlias] = useState('');
  const [editAliasError, setEditAliasError] = useState<string | null>(null);
  const [editEnumEntries, setEditEnumEntries] = useState<
    Array<{ source: string; display: string; canonical: string }>
  >([]);
  const [editMappingSaving, setEditMappingSaving] = useState(false);
  const [vocabReviewOpen, setVocabReviewOpen] = useState(false);
  const [vocabReviewFieldRef, setVocabReviewFieldRef] = useState('');
  const [vocabReviewFieldLabel, setVocabReviewFieldLabel] = useState('');
  const [myFieldsView, setMyFieldsView] = useState<'by-field' | 'by-connector'>('by-field');
  // Tracks collapsed groups — groups NOT in this set are expanded (default expanded)
  const [collapsedMyFields, setCollapsedMyFields] = useState<Set<string>>(new Set());

  // Field form state
  const [fieldName, setFieldName] = useState('');
  const [fieldLabel, setFieldLabel] = useState('');
  const [fieldType, setFieldType] = useState('string');
  const [fieldDescription, setFieldDescription] = useState('');
  const [fieldFilterable, setFieldFilterable] = useState(true);
  const [fieldSortable, setFieldSortable] = useState(false);
  const [fieldAggregatable, setFieldAggregatable] = useState(false);
  const [enumEntries, setEnumEntries] = useState<Array<{ display: string; stored: string }>>([]);
  const [fieldSaving, setFieldSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Smart-suggest: unmapped connector fields for Field Name dropdown
  const [allUnmappedFields, setAllUnmappedFields] = useState<UnmappedField[]>([]);
  const [unmappedFieldsLoading, setUnmappedFieldsLoading] = useState(false);
  const [fieldNameDropdownOpen, setFieldNameDropdownOpen] = useState(false);
  const [fieldNameSearch, setFieldNameSearch] = useState('');
  const [selectedUnmappedField, setSelectedUnmappedField] = useState<UnmappedField | null>(null);
  const [activeDropdownIndex, setActiveDropdownIndex] = useState(-1);
  const fieldNameDropdownRef = useRef<HTMLDivElement>(null);
  const dropdownSearchRef = useRef<HTMLInputElement>(null);

  // Derived data
  const suggestedMappings = useMemo(
    () => mappings.filter((m) => m.status === MAPPING_STATUS.SUGGESTED),
    [mappings],
  );
  const confirmedMappings = useMemo(
    () => mappings.filter((m) => m.status === MAPPING_STATUS.CONFIRMED),
    [mappings],
  );

  // Sort suggested by confidence (high first)
  const sortedSuggestions = useMemo(
    () => [...suggestedMappings].sort((a, b) => b.confidence - a.confidence),
    [suggestedMappings],
  );

  // High-confidence suggestions for bulk action bar
  const highConfidenceIds = useMemo(
    () => suggestedMappings.filter((m) => m.confidence >= 0.8).map((m) => m._id),
    [suggestedMappings],
  );

  // ─── Grouped views for My Fields ────────────────────────────────────

  /** By Field: group confirmed mappings by canonicalField */
  const byFieldGroups = useMemo(() => {
    const map = new Map<
      string,
      { alias: string; storageField: string; mappings: FieldMappingData[] }
    >();
    for (const m of confirmedMappings) {
      const key = m.canonicalField;
      if (!map.has(key)) {
        map.set(key, {
          alias: m.aliasLabel || m.aliasName || m.canonicalField,
          storageField: m.canonicalField,
          mappings: [],
        });
      }
      map.get(key)!.mappings.push(m);
    }
    // Sort groups alphabetically by alias
    return Array.from(map.entries())
      .sort(([, a], [, b]) => a.alias.localeCompare(b.alias))
      .map(([key, val]) => ({ key, ...val }));
  }, [confirmedMappings]);

  /** By Connector: group confirmed mappings by connectorId */
  const byConnectorGroups = useMemo(() => {
    const map = new Map<string, FieldMappingData[]>();
    for (const m of confirmedMappings) {
      if (!map.has(m.connectorId)) {
        map.set(m.connectorId, []);
      }
      map.get(m.connectorId)!.push(m);
    }
    return Array.from(map.entries()).map(([connectorId, mappings]) => ({
      connectorId,
      connectorType: mappings[0]?.connectorType ?? null,
      mappings: mappings.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
    }));
  }, [confirmedMappings]);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsedMyFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Connector type display names
  const CONNECTOR_TYPE_LABELS: Record<string, string> = {
    sharepoint: 'SharePoint',
    jira: 'Jira',
    confluence: 'Confluence',
    hubspot: 'HubSpot',
    servicenow: 'ServiceNow',
    salesforce: 'Salesforce',
    file_upload: 'File Upload',
  };

  /** Resolve connector display name from mapping data */
  const connectorName = useCallback(
    (connectorId: string, connectorType?: string | null) => {
      // Use enriched connectorType from backend
      if (connectorType) return CONNECTOR_TYPE_LABELS[connectorType] || connectorType;
      // Fallback: match against sources
      const source = sources?.find((s) => s._id === connectorId);
      if (source) return source.name;
      if (sources?.length === 1) return sources[0].name;
      return connectorId.slice(0, 8);
    },
    [sources],
  );

  // ─── Smart-suggest helpers ────────────────────────────────────────────

  /** Build dropdown fields from the canonical schema fields.
   *  These are the 78 fields discovered from the connector data
   *  (title, status, priority, etc.) that the user can pick from.
   */
  const loadAllUnmappedFields = useCallback(() => {
    if (!schema?.fields?.length) return;
    setUnmappedFieldsLoading(true);
    try {
      const all: UnmappedField[] = schema.fields.map((f) => ({
        path: f.storageField || f.name,
        label: f.label || f.name,
        type: f.type || 'string',
        isCustom: (f.storageField || f.name).startsWith('custom_'),
        sampleValues: undefined,
        enumValues: f.enumValues ? Object.keys(f.enumValues) : undefined,
      }));
      all.sort((a, b) => a.label.localeCompare(b.label));
      setAllUnmappedFields(all);
    } finally {
      setUnmappedFieldsLoading(false);
    }
  }, [schema?.fields]);

  /** Simple fuzzy match: substring, starts-with, word-starts-with */
  const fuzzyScore = useCallback((query: string, text: string): number => {
    if (!query || !text) return 0;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (t === q) return 3;
    if (t.startsWith(q)) return 2.5;
    if (t.includes(q)) return 2;
    const words = t.split(/[\s_.\-/]+/);
    for (const w of words) {
      if (w.startsWith(q)) return 1.5;
    }
    return 0;
  }, []);

  /** Type filter map: canonical type → connector types */
  const TYPE_FILTER_MAP: Record<string, string[]> = useMemo(
    () => ({
      string: ['string', 'keyword', 'text'],
      number: ['number', 'float', 'integer'],
      date: ['date'],
      boolean: ['boolean'],
      array: ['array'],
    }),
    [],
  );

  /** Filtered + scored unmapped fields for the dropdown */
  const filteredUnmappedFields = useMemo(() => {
    let fields = [...allUnmappedFields];

    // Filter by selected type
    if (fieldType) {
      const allowed = TYPE_FILTER_MAP[fieldType];
      if (allowed) {
        fields = fields.filter((f) => allowed.includes(f.type));
      }
    }

    // Filter by dropdown search query
    const sq = fieldNameSearch.toLowerCase();
    if (sq.length >= 1) {
      fields = fields.filter((f) => fuzzyScore(sq, f.label) > 0 || fuzzyScore(sq, f.path) > 0);
    }

    // Score by display name match for auto-suggest ordering
    const displayQ = fieldLabel.trim();
    if (displayQ.length >= 2) {
      fields = fields.map((f) => ({
        ...f,
        _autoScore: Math.max(fuzzyScore(displayQ, f.label) * 1.5, fuzzyScore(displayQ, f.path)),
      }));
      fields.sort((a, b) => {
        const sa = (a as UnmappedField & { _autoScore: number })._autoScore;
        const sb = (b as UnmappedField & { _autoScore: number })._autoScore;
        if (sb !== sa) return sb - sa;
        return a.label.localeCompare(b.label);
      });
    } else {
      fields.sort((a, b) => a.label.localeCompare(b.label));
    }

    return fields;
  }, [allUnmappedFields, fieldType, fieldNameSearch, fieldLabel, fuzzyScore, TYPE_FILTER_MAP]);

  /** Apply a field selection from dropdown or auto-suggest */
  const applyFieldSelection = useCallback((field: UnmappedField) => {
    setSelectedUnmappedField(field);
    setFieldName(field.path);

    // Auto-fill type
    const mapped = TYPE_MAP[field.type as keyof typeof TYPE_MAP] || field.type || 'string';
    setFieldType(mapped);

    // Auto-fill description
    setFieldDescription(field.label + ' field from connector data');

    // Auto-fill enum values
    if (field.enumValues && field.enumValues.length > 0) {
      setEnumEntries(
        field.enumValues.map((v) => ({
          display: v,
          stored: v.toLowerCase().replace(/\s+/g, '_'),
        })),
      );
    } else {
      setEnumEntries([]);
    }

    // Smart capability defaults
    if (field.enumValues && field.enumValues.length > 0) {
      setFieldFilterable(true);
      setFieldAggregatable(true);
    }
    if (field.type === 'number') setFieldSortable(true);
    if (field.type === 'date') {
      setFieldSortable(true);
      setFieldFilterable(true);
    }

    setFieldNameDropdownOpen(false);
  }, []);

  /** Auto-suggest: pick best matching field when display name changes */
  const autoSuggestFromLabel = useCallback(
    (label: string) => {
      if (label.trim().length < 2 || allUnmappedFields.length === 0) {
        // Clear auto-suggestion if it was one
        if (selectedUnmappedField) {
          setSelectedUnmappedField(null);
          setFieldName('');
          setFieldType(''); // Reset to "All Types"
          setFieldDescription('');
          setEnumEntries([]);
        }
        return;
      }

      // Find best match
      let bestField: UnmappedField | null = null;
      let bestScore = 0;
      const allowed = fieldType ? TYPE_FILTER_MAP[fieldType] : null;

      for (const f of allUnmappedFields) {
        if (allowed && !allowed.includes(f.type)) continue;
        const score = Math.max(
          fuzzyScore(label.trim(), f.label) * 1.5,
          fuzzyScore(label.trim(), f.path),
        );
        if (score > bestScore) {
          bestScore = score;
          bestField = f;
        }
      }

      if (bestField && bestScore >= 1.5) {
        applyFieldSelection(bestField);
      } else if (selectedUnmappedField) {
        setSelectedUnmappedField(null);
        setFieldName('');
        setFieldType(''); // Reset to "All Types"
        setFieldDescription('');
        setEnumEntries([]);
      }
    },
    [
      allUnmappedFields,
      fieldType,
      fuzzyScore,
      selectedUnmappedField,
      TYPE_FILTER_MAP,
      applyFieldSelection,
    ],
  );

  /** Load unmapped fields when dialog opens (avoids stale closure in openAddField) */
  useEffect(() => {
    if (fieldDialogOpen && !editingField) {
      loadAllUnmappedFields();
    }
  }, [fieldDialogOpen, editingField, loadAllUnmappedFields]);

  /** Close dropdown when clicking outside */
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        fieldNameDropdownRef.current &&
        !fieldNameDropdownRef.current.contains(e.target as Node)
      ) {
        setFieldNameDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ─── Actions ──────────────────────────────────────────────────────────

  const openAddField = useCallback(() => {
    setEditingField(null);
    setFieldName('');
    setFieldLabel('');
    setFieldType(''); // Empty = show all types in dropdown
    setFieldDescription('');
    setFieldFilterable(true);
    setFieldSortable(false);
    setFieldAggregatable(false);
    setEnumEntries([]);
    setFieldError(null);
    setSelectedUnmappedField(null);
    setFieldNameSearch('');
    setFieldNameDropdownOpen(false);
    setActiveDropdownIndex(-1);
    setFieldDialogOpen(true);
  }, []);

  const openEditField = useCallback((field: CanonicalField) => {
    setEditingField(field);
    setFieldName(field.name);
    setFieldLabel(field.label);
    setFieldType(field.type);
    setFieldDescription(field.description || '');
    setFieldFilterable(field.filterable);
    setFieldSortable(field.sortable || false);
    setFieldAggregatable(field.aggregatable);
    // Convert enumValues Record to array
    if (field.enumValues && typeof field.enumValues === 'object') {
      setEnumEntries(
        Object.entries(field.enumValues).map(([display, stored]) => ({
          display,
          stored: String(stored),
        })),
      );
    } else {
      setEnumEntries([]);
    }
    setFieldError(null);
    setFieldDialogOpen(true);
  }, []);

  const handleSaveField = async () => {
    if (!fieldName.trim() || !fieldLabel.trim()) {
      setFieldError('Name and label are required');
      return;
    }
    if (!schema) return;

    const trimmedName = fieldName.trim();

    // Default to 'string' if type wasn't explicitly chosen (add-mode starts with empty)
    const resolvedType = fieldType || 'string';

    setFieldSaving(true);
    setFieldError(null);

    try {
      // Build enum values Record from entries
      const enumValues: Record<string, unknown> | undefined =
        enumEntries.length > 0
          ? Object.fromEntries(
              enumEntries.map((e) => [
                e.display,
                isNaN(Number(e.stored)) ? e.stored : Number(e.stored),
              ]),
            )
          : undefined;

      // Check if field already exists in schema (user selected from dropdown to map it)
      const existingField = !editingField
        ? schema.fields.find((f) => f.name === trimmedName)
        : null;

      const newField: CanonicalField = {
        name: trimmedName,
        label: fieldLabel.trim(),
        type: resolvedType,
        description: fieldDescription.trim() || undefined,
        storageField: existingField?.storageField || editingField?.storageField || trimmedName,
        indexed: true,
        filterable: fieldFilterable,
        aggregatable: fieldAggregatable,
        sortable: fieldSortable,
        enumValues,
      };

      let updatedFields: CanonicalField[];
      if (editingField) {
        // Editing an existing field: replace it
        updatedFields = schema.fields.map((f) => (f.name === editingField.name ? newField : f));
      } else if (existingField) {
        // User selected an existing schema field from dropdown — update & activate it
        updatedFields = schema.fields.map((f) => (f.name === trimmedName ? newField : f));
      } else {
        // Truly new field
        updatedFields = [...schema.fields, newField];
      }

      await updateCanonicalSchema(schema.knowledgeBaseId, {
        fields: updatedFields,
        status: 'active',
        // Mark the field active so it appears in My Fields immediately
        activeFields: !editingField ? [trimmedName] : undefined,
      });
      mutateSchema();
      refreshMappings();
      refreshStats();
      setFieldDialogOpen(false);
      toast.success(
        editingField ? 'Field updated' : existingField ? 'Field mapped' : 'Field added',
      );
    } catch (err) {
      const msg = sanitizeError(err, 'Failed to save field');
      setFieldError(msg);
      toast.error(msg);
    } finally {
      setFieldSaving(false);
    }
  };

  const handleConfirmMapping = useCallback(
    async (id: string) => {
      try {
        await confirmMapping(id);
        refreshMappings();
        toast.success('Mapping confirmed');
      } catch {
        toast.error('Failed to confirm mapping');
      }
    },
    [refreshMappings],
  );

  const handleRejectMapping = useCallback(
    async (id: string) => {
      try {
        await rejectMapping(id);
        refreshMappings();
        toast.success('Mapping rejected');
      } catch {
        toast.error('Failed to reject mapping');
      }
    },
    [refreshMappings],
  );

  const handleRemoveMapping = useCallback(async () => {
    if (!removingMapping) return;
    try {
      await deleteMapping(removingMapping._id);
      refreshMappings();
      refreshStats();
      toast.success('Mapping removed');
    } catch (err) {
      toast.error(sanitizeError(err, 'Failed to remove mapping'));
    } finally {
      setRemovingMapping(null);
    }
  }, [removingMapping, refreshMappings, refreshStats]);

  const handleBulkConfirm = useCallback(async () => {
    if (highConfidenceIds.length === 0) return;
    setBulkConfirming(true);
    try {
      await bulkActionMappings('confirm', highConfidenceIds);
      refreshMappings();
      refreshStats();
      toast.success(`${highConfidenceIds.length} mappings confirmed`);
    } catch (err) {
      toast.error(sanitizeError(err, 'Failed to confirm mappings'));
    } finally {
      setBulkConfirming(false);
    }
  }, [highConfidenceIds, refreshMappings, refreshStats]);

  // ─── Edit Mapping Dialog (Stories 3.5 + 3.6) ──────────────────────────

  const openEditMapping = useCallback((mapping: FieldMappingData) => {
    setEditingMapping(mapping);
    setEditAlias(mapping.aliasName || mapping.aliasLabel || '');
    setEditAliasError(null);
    // Pre-fill enum entries from transform.valueMap if it exists
    if (mapping.transform.type === 'value_map' && mapping.transform.valueMap) {
      setEditEnumEntries(
        Object.entries(mapping.transform.valueMap).map(([source, canonical]) => ({
          source,
          display: source, // default display = source
          canonical: String(canonical),
        })),
      );
    } else {
      setEditEnumEntries([]);
    }
  }, []);

  const handleSaveMapping = useCallback(async () => {
    if (!editingMapping) return;

    // Validate alias
    const alias = editAlias.trim();
    if (alias && (alias.length > 64 || !/^[\w ]+$/.test(alias))) {
      setEditAliasError('Alias must be 1-64 chars, alphanumeric/underscore/space only');
      return;
    }

    setEditMappingSaving(true);
    setEditAliasError(null);

    try {
      const patchData: Parameters<typeof patchMapping>[1] = {};

      if (alias && alias !== (editingMapping.aliasName || '')) {
        patchData.alias = alias;
      }

      // Build enumValueMap if enum entries exist
      if (editEnumEntries.length > 0) {
        patchData.enumValueMap = Object.fromEntries(
          editEnumEntries
            .filter((e) => e.source && e.canonical)
            .map((e) => [e.source, e.canonical]),
        );
      }

      if (Object.keys(patchData).length > 0) {
        await patchMapping(editingMapping._id, patchData);
        refreshMappings();
        mutateSchema();
      }

      setEditingMapping(null);
      toast.success('Mapping updated');
    } catch (err) {
      toast.error(sanitizeError(err, 'Failed to update mapping'));
    } finally {
      setEditMappingSaving(false);
    }
  }, [editingMapping, editAlias, editEnumEntries, refreshMappings, mutateSchema]);

  const addEnumEntry = () => {
    setEnumEntries([...enumEntries, { display: '', stored: '' }]);
  };

  const updateEnumEntry = (index: number, field: 'display' | 'stored', value: string) => {
    const updated = [...enumEntries];
    updated[index] = { ...updated[index], [field]: value };
    // Auto-fill stored with display for text fields
    if (field === 'display' && fieldType === 'string' && !updated[index].stored) {
      updated[index].stored = value.toLowerCase().replace(/\s+/g, '_');
    }
    setEnumEntries(updated);
  };

  const removeEnumEntry = (index: number) => {
    setEnumEntries(enumEntries.filter((_, i) => i !== index));
  };

  // ─── My Fields table columns ─────────────────────────────────────────

  const myFieldsColumns: Column<FieldMappingData>[] = useMemo(
    () => [
      {
        key: 'sourcePath',
        label: 'Source Field',
        sortable: true,
        sortValue: (m) => m.sourcePath,
        render: (m) => (
          <div>
            <span className="font-mono text-xs">{m.sourcePath}</span>
            <div className="text-xs text-subtle">
              {connectorName(m.connectorId, m.connectorType)}
            </div>
          </div>
        ),
      },
      {
        key: 'canonicalField',
        label: 'Canonical Field',
        sortable: true,
        sortValue: (m) => m.aliasLabel || m.canonicalField,
        render: (m) => (
          <div>
            <span className="font-medium">{m.aliasLabel || m.aliasName || m.canonicalField}</span>
            {m.aliasLabel && (
              <span className="ml-1.5 text-xs text-muted font-mono">({m.canonicalField})</span>
            )}
          </div>
        ),
      },
      {
        key: 'confidence',
        label: 'Confidence',
        sortable: true,
        sortValue: (m) => m.confidence,
        render: (m) => (
          <Badge variant={confidenceVariant(m.confidence)} className="text-xs">
            {Math.round(m.confidence * 100)}%
          </Badge>
        ),
        width: 'w-[100px]',
      },
      {
        key: 'actions',
        label: '',
        render: (m) => (
          <div className="flex gap-1">
            <button
              onClick={() => openEditMapping(m)}
              className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default"
              title="Edit mapping"
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            {m.aliasName && (
              <button
                onClick={() => {
                  setVocabReviewFieldRef(m.aliasName!);
                  setVocabReviewFieldLabel(m.aliasLabel || m.aliasName!);
                  setVocabReviewOpen(true);
                }}
                className="p-1.5 text-muted hover:text-accent rounded-lg transition-default"
                title="Review vocabulary"
              >
                <BookOpen className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => setRemovingMapping(m)}
              className="p-1.5 text-muted hover:text-error rounded-lg transition-default"
              title="Remove"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ),
        width: 'w-[110px]',
      },
    ],
    [connectorName, openEditMapping],
  );

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Response Fields — multi-select dropdown for configuring which fields are returned */}
      <ResponseFieldsDropdown indexId={indexId} schema={schema} />

      <Tabs
        tabs={[
          { id: 'my-fields', label: 'My Fields', count: stats.confirmedCount },
          { id: 'suggested', label: 'Suggested', count: stats.suggestedCount },
          { id: 'unmapped', label: 'Unmapped', count: stats.unmappedCount },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        layoutId="fields-tab-indicator"
      />

      {/* ─── My Fields Tab ───────────────────────────────────────────── */}
      {activeTab === 'my-fields' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold text-foreground">My Fields</h3>
              {/* Segmented toggle */}
              {confirmedMappings.length > 0 && (
                <div className="inline-flex rounded-lg bg-surface-secondary p-0.5">
                  <button
                    onClick={() => setMyFieldsView('by-field')}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-default ${
                      myFieldsView === 'by-field'
                        ? 'bg-surface text-foreground shadow-sm'
                        : 'text-muted hover:text-foreground'
                    }`}
                  >
                    By Field
                  </button>
                  <button
                    onClick={() => setMyFieldsView('by-connector')}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-default ${
                      myFieldsView === 'by-connector'
                        ? 'bg-surface text-foreground shadow-sm'
                        : 'text-muted hover:text-foreground'
                    }`}
                  >
                    By Connector
                  </button>
                </div>
              )}
            </div>
            {schema && (
              <Button size="sm" icon={<Plus className="w-4 h-4" />} onClick={openAddField}>
                Add Field
              </Button>
            )}
          </div>

          {confirmedMappings.length === 0 ? (
            <EmptyState
              icon={<Check className="w-3.5 h-3.5" />}
              title="No mapped fields yet"
              description="Review suggestions in the 'Suggested' tab to start mapping fields."
            />
          ) : myFieldsView === 'by-field' ? (
            /* ── View A: By Field (canonical-centric) ─────────────────── */
            <div className="space-y-2">
              {byFieldGroups.map((group) => {
                const isExpanded = !collapsedMyFields.has(group.key);
                return (
                  <div
                    key={group.key}
                    className="rounded-xl border border-default bg-surface overflow-hidden"
                  >
                    {/* Group header */}
                    <button
                      onClick={() => toggleCollapsed(group.key)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-secondary transition-default"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-muted flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-muted flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-foreground">{group.alias}</span>
                        {group.alias !== group.storageField && (
                          <span className="ml-2 font-mono text-xs text-muted">
                            {group.storageField}
                          </span>
                        )}
                      </div>
                      <Badge variant="default" className="text-xs flex-shrink-0">
                        {group.mappings.length} source{group.mappings.length !== 1 ? 's' : ''}
                      </Badge>
                    </button>

                    {/* Source mappings */}
                    {isExpanded && (
                      <div className="border-t border-default">
                        {group.mappings.map((m, idx) => (
                          <div
                            key={m._id}
                            className={`flex items-center gap-3 px-4 py-2.5 pl-11 ${
                              idx < group.mappings.length - 1 ? 'border-b border-default' : ''
                            }`}
                          >
                            <div className="flex-1 min-w-0 text-sm">
                              <span className="text-xs text-muted">
                                {connectorName(m.connectorId, m.connectorType)}:
                              </span>{' '}
                              <span className="font-mono text-xs text-foreground">
                                {m.sourcePath}
                              </span>
                            </div>
                            <Badge variant={confidenceVariant(m.confidence)} className="text-xs">
                              {Math.round(m.confidence * 100)}%
                            </Badge>
                            <div className="flex gap-1 flex-shrink-0">
                              <button
                                onClick={() => openEditMapping(m)}
                                className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default"
                                title="Edit mapping"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              {m.aliasName && (
                                <button
                                  onClick={() => {
                                    setVocabReviewFieldRef(m.aliasName!);
                                    setVocabReviewFieldLabel(m.aliasLabel || m.aliasName!);
                                    setVocabReviewOpen(true);
                                  }}
                                  className="p-1.5 text-muted hover:text-accent rounded-lg transition-default"
                                  title="Review vocabulary"
                                >
                                  <BookOpen className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                onClick={() => setRemovingMapping(m)}
                                className="p-1.5 text-muted hover:text-error rounded-lg transition-default"
                                title="Remove"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            /* ── View B: By Connector (source-centric) ────────────────── */
            <div className="space-y-2">
              {byConnectorGroups.map((group) => {
                const isExpanded = !collapsedMyFields.has(group.connectorId);
                const name = connectorName(group.connectorId, group.connectorType);
                return (
                  <div
                    key={group.connectorId}
                    className="rounded-xl border border-default bg-surface overflow-hidden"
                  >
                    {/* Connector header */}
                    <button
                      onClick={() => toggleCollapsed(group.connectorId)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-secondary transition-default"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-muted flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-muted flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-foreground">{name}</span>
                        <span className="ml-2 font-mono text-xs text-muted">
                          ({group.connectorId.slice(0, 12)})
                        </span>
                      </div>
                      <Badge variant="default" className="text-xs flex-shrink-0">
                        {group.mappings.length} field{group.mappings.length !== 1 ? 's' : ''}
                      </Badge>
                    </button>

                    {/* Field mappings */}
                    {isExpanded && (
                      <div className="border-t border-default">
                        {group.mappings.map((m, idx) => (
                          <div
                            key={m._id}
                            className={`flex items-center gap-3 px-4 py-2.5 pl-11 ${
                              idx < group.mappings.length - 1 ? 'border-b border-default' : ''
                            }`}
                          >
                            <div className="flex-1 min-w-0 text-sm">
                              <span className="font-mono text-xs text-foreground">
                                {m.sourcePath}
                              </span>
                              <span className="mx-2 text-muted">→</span>
                              <span className="text-sm font-medium text-foreground">
                                {m.aliasLabel || m.aliasName || m.canonicalField}
                              </span>
                              {(m.aliasLabel || m.aliasName) &&
                                (m.aliasLabel || m.aliasName) !== m.canonicalField && (
                                  <span className="ml-1.5 font-mono text-xs text-muted">
                                    ({m.canonicalField})
                                  </span>
                                )}
                            </div>
                            <Badge variant={confidenceVariant(m.confidence)} className="text-xs">
                              {Math.round(m.confidence * 100)}%
                            </Badge>
                            <div className="flex gap-1 flex-shrink-0">
                              <button
                                onClick={() => openEditMapping(m)}
                                className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default"
                                title="Edit mapping"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              {m.aliasName && (
                                <button
                                  onClick={() => {
                                    setVocabReviewFieldRef(m.aliasName!);
                                    setVocabReviewFieldLabel(m.aliasLabel || m.aliasName!);
                                    setVocabReviewOpen(true);
                                  }}
                                  className="p-1.5 text-muted hover:text-accent rounded-lg transition-default"
                                  title="Review vocabulary"
                                >
                                  <BookOpen className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                onClick={() => setRemovingMapping(m)}
                                className="p-1.5 text-muted hover:text-error rounded-lg transition-default"
                                title="Remove"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─── Suggested Mappings Tab ──────────────────────────────────── */}
      {activeTab === 'suggested' && (
        <div className="space-y-4">
          {suggestedMappings.length === 0 ? (
            <EmptyState
              icon={<Check className="w-3.5 h-3.5" />}
              title="All suggestions reviewed"
              description="Check 'Unmapped Fields' for any remaining fields."
            />
          ) : (
            <>
              {/* Bulk action bar */}
              {highConfidenceIds.length > 0 && (
                <div className="sticky top-0 z-10 flex items-center justify-between bg-success-subtle border border-success-muted p-4 rounded-xl">
                  <span className="text-sm font-medium text-foreground">
                    {highConfidenceIds.length} high-confidence suggestion
                    {highConfidenceIds.length !== 1 ? 's' : ''} ready to accept
                  </span>
                  <Button size="sm" onClick={handleBulkConfirm} loading={bulkConfirming}>
                    Accept All High-Confidence ({highConfidenceIds.length})
                  </Button>
                </div>
              )}

              {/* Suggestion rows sorted by confidence */}
              <div className="space-y-2">
                {sortedSuggestions.map((m) => {
                  const isExpanded = expandedSuggestion === m._id;
                  return (
                    <div
                      key={m._id}
                      className={`rounded-lg p-3 ${confidenceRowStyle(m.confidence)} transition-default`}
                    >
                      <div className="flex items-start gap-3">
                        <button
                          onClick={() => setExpandedSuggestion(isExpanded ? null : m._id)}
                          className="p-0.5 text-muted hover:text-foreground mt-0.5"
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </button>

                        <div className="flex-1 min-w-0 text-sm">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-muted">{m.sourcePath}</span>
                            <span className="text-muted">→</span>
                            <span className="font-medium text-foreground">
                              {m.aliasLabel || m.aliasName || m.canonicalField}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 mt-1">
                            <Badge variant={confidenceVariant(m.confidence)} className="text-xs">
                              <span className="font-mono font-semibold">
                                {m.confidence.toFixed(2)}
                              </span>
                              <span className="ml-1">{confidenceLabel(m.confidence)}</span>
                            </Badge>
                            <Badge variant="default" className="text-xs">
                              {TRANSFORM_DISPLAY[m.transform.type] || m.transform.type}
                            </Badge>
                            <span className="text-xs text-subtle">
                              {connectorName(m.connectorId, m.connectorType)}
                            </span>
                          </div>
                        </div>

                        <div className="flex gap-1 flex-shrink-0">
                          <button
                            onClick={() => handleConfirmMapping(m._id)}
                            className="p-1.5 text-success hover:bg-success-subtle rounded-lg transition-default"
                            title="Accept"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleRejectMapping(m._id)}
                            className="p-1.5 text-error hover:bg-error-subtle rounded-lg transition-default"
                            title="Reject"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Expanded details */}
                      {isExpanded && (
                        <div className="mt-3 ml-7 text-xs space-y-1 text-muted">
                          <div>
                            <span className="font-medium">Connector:</span>{' '}
                            {connectorName(m.connectorId, m.connectorType)}
                          </div>
                          <div>
                            <span className="font-medium">Transform:</span>{' '}
                            {TRANSFORM_DISPLAY[m.transform.type] || m.transform.type}
                            {m.transform.type === 'value_map' && m.transform.valueMap && (
                              <span className="ml-1">
                                (
                                {Object.entries(m.transform.valueMap)
                                  .slice(0, 3)
                                  .map(([k, v]) => `${k}→${v}`)
                                  .join(', ')}
                                {Object.keys(m.transform.valueMap).length > 3 ? '...' : ''})
                              </span>
                            )}
                          </div>
                          <div>
                            <span className="font-medium">Storage Field:</span>{' '}
                            <span className="font-mono">{m.canonicalField}</span>
                          </div>
                          {m.aliasLabel && (
                            <div>
                              <span className="font-medium">Display Label:</span> {m.aliasLabel}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── Unmapped Fields Tab ─────────────────────────────────────── */}
      {activeTab === 'unmapped' && sources && sources.length > 0 && schema && (
        <UnmappedFieldsSection
          knowledgeBaseId={schema.knowledgeBaseId}
          canonicalSchemaId={schema._id}
          canonicalFields={schema.fields}
          sources={sources}
          onMappingCreated={() => {
            refreshMappings();
            refreshStats();
          }}
        />
      )}

      {/* ─── Remove Mapping Confirmation ─────────────────────────────── */}
      <ConfirmDialog
        open={!!removingMapping}
        onClose={() => setRemovingMapping(null)}
        onConfirm={handleRemoveMapping}
        title="Remove Field Mapping"
        description={`Remove mapping for "${removingMapping?.sourcePath}" → "${removingMapping?.aliasLabel || removingMapping?.canonicalField}"? This cannot be undone.`}
        confirmLabel="Remove"
        variant="danger"
      />

      {/* ─── Edit Mapping Dialog (Story 3.5 + 3.6) ──────────────────── */}
      <Dialog
        open={!!editingMapping}
        onClose={() => setEditingMapping(null)}
        title="Edit Field Mapping"
        maxWidth="sm"
      >
        {editingMapping && (
          <div className="space-y-4">
            {/* Read-only mapping info */}
            <div className="space-y-2 rounded-lg bg-background-muted p-3">
              <div className="text-xs">
                <span className="font-medium text-muted">Source Field:</span>{' '}
                <span className="font-mono text-foreground">{editingMapping.sourcePath}</span>
              </div>
              <div className="text-xs">
                <span className="font-medium text-muted">Canonical Field:</span>{' '}
                <span className="font-mono text-foreground">{editingMapping.canonicalField}</span>
              </div>
              <div className="text-xs">
                <span className="font-medium text-muted">Confidence:</span>{' '}
                <Badge variant={confidenceVariant(editingMapping.confidence)} className="text-xs">
                  {Math.round(editingMapping.confidence * 100)}%
                </Badge>
              </div>
              {(() => {
                const cf = schema?.fields?.find(
                  (f) => f.storageField === editingMapping.canonicalField,
                );
                if (!cf) return null;
                return (
                  <div className="text-xs flex items-center gap-2">
                    <span className="font-medium text-muted">Type:</span>
                    <Badge variant="default" className="text-xs">
                      {TYPE_DISPLAY[cf.type] || cf.type}
                    </Badge>
                    {cf.filterable && (
                      <Badge variant="info" className="text-xs">
                        Filter
                      </Badge>
                    )}
                    {cf.sortable && (
                      <Badge variant="info" className="text-xs">
                        Sort
                      </Badge>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Alias Name (Story 3.5) */}
            <div>
              <Input
                label="Alias Name"
                value={editAlias}
                onChange={(e) => {
                  setEditAlias(e.target.value);
                  setEditAliasError(null);
                }}
                placeholder="e.g., Priority Level"
              />
              {editAliasError && <p className="text-xs text-error mt-1">{editAliasError}</p>}
              <p className="text-xs text-subtle mt-1">
                How this field appears to users and AI agents.
              </p>
            </div>

            {/* Enum Value Mapping (Story 3.6) */}
            {editingMapping.transform.type === 'value_map' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-foreground">Enum Value Mappings</label>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setEditEnumEntries([
                        ...editEnumEntries,
                        { source: '', display: '', canonical: '' },
                      ])
                    }
                  >
                    + Add row
                  </Button>
                </div>
                {editEnumEntries.length > 0 && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-[1fr_1fr_32px] gap-2 text-xs text-muted">
                      <span>Source Value</span>
                      <span>Canonical Value</span>
                      <span />
                    </div>
                    {editEnumEntries.map((entry, i) => (
                      <div key={i} className="grid grid-cols-[1fr_1fr_32px] gap-2">
                        <Input
                          value={entry.source}
                          onChange={(e) => {
                            const updated = [...editEnumEntries];
                            updated[i] = { ...updated[i], source: e.target.value };
                            setEditEnumEntries(updated);
                          }}
                          placeholder="draft"
                        />
                        <Input
                          value={entry.canonical}
                          onChange={(e) => {
                            const updated = [...editEnumEntries];
                            updated[i] = { ...updated[i], canonical: e.target.value };
                            setEditEnumEntries(updated);
                          }}
                          placeholder="pending"
                        />
                        <button
                          onClick={() =>
                            setEditEnumEntries(editEnumEntries.filter((_, j) => j !== i))
                          }
                          className="p-1.5 text-muted hover:text-error rounded transition-default"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    {/* Preview */}
                    {editEnumEntries.some((e) => e.source && e.canonical) && (
                      <div className="rounded-lg bg-background-muted p-2 text-xs text-muted space-y-0.5">
                        <div className="font-medium">Preview:</div>
                        {editEnumEntries
                          .filter((e) => e.source && e.canonical)
                          .slice(0, 5)
                          .map((e, i) => (
                            <div key={i}>
                              &quot;{e.source}&quot; → &quot;{e.canonical}&quot;
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                variant="secondary"
                onClick={() => setEditingMapping(null)}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button onClick={handleSaveMapping} loading={editMappingSaving} className="flex-1">
                Save Changes
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* ─── Add/Edit Field Dialog ────────────────────────────────────── */}
      <Dialog
        open={fieldDialogOpen}
        onClose={() => setFieldDialogOpen(false)}
        title={editingField ? 'Edit Field' : 'Add Field'}
        maxWidth="sm"
      >
        <div className="space-y-4">
          {editingField ? (
            <>
              {/* Edit mode: original inputs */}
              <Input
                label="Field Name"
                value={fieldName}
                onChange={(e) => setFieldName(e.target.value)}
                placeholder="e.g., priority_level"
                disabled
              />
              <Input
                label="Display Label"
                value={fieldLabel}
                onChange={(e) => setFieldLabel(e.target.value)}
                placeholder="e.g., Priority Level"
              />
            </>
          ) : (
            <>
              {/* Add mode: Display Name + searchable Field Name dropdown */}
              <Input
                label="Display Name"
                value={fieldLabel}
                onChange={(e) => {
                  setFieldLabel(e.target.value);
                  autoSuggestFromLabel(e.target.value);
                }}
                placeholder="e.g., Urgency, Priority Level, Status"
              />

              {/* Field Name — searchable dropdown of unmapped connector fields */}
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-foreground">
                  Field Name
                  {selectedUnmappedField && (
                    <span className="ml-2 text-xs font-normal text-success">
                      <Check className="w-3 h-3 inline -mt-0.5 mr-0.5" />
                      auto-suggested
                    </span>
                  )}
                </label>
                <div className="relative" ref={fieldNameDropdownRef}>
                  <button
                    type="button"
                    onClick={() => {
                      setFieldNameDropdownOpen(!fieldNameDropdownOpen);
                      setFieldNameSearch('');
                      setActiveDropdownIndex(-1);
                      if (!fieldNameDropdownOpen) {
                        setTimeout(() => dropdownSearchRef.current?.focus(), 50);
                      }
                    }}
                    className="w-full flex items-center justify-between rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 text-left transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                  >
                    <span
                      className={fieldName ? 'font-mono text-xs text-foreground' : 'text-subtle'}
                    >
                      {fieldName || 'Select a connector schema field...'}
                    </span>
                    <ChevronDown
                      className={`w-4 h-4 text-muted transition-transform ${fieldNameDropdownOpen ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {/* Dropdown list */}
                  {fieldNameDropdownOpen && (
                    <div className="absolute z-[101] top-[calc(100%+4px)] left-0 right-0 bg-background-elevated border border-default rounded-xl shadow-xl max-h-[280px] overflow-hidden flex flex-col">
                      {/* Search input */}
                      <div className="p-2 border-b border-default">
                        <input
                          ref={dropdownSearchRef}
                          type="text"
                          value={fieldNameSearch}
                          onChange={(e) => {
                            setFieldNameSearch(e.target.value);
                            setActiveDropdownIndex(-1);
                          }}
                          onKeyDown={(e) => {
                            if (filteredUnmappedFields.length === 0) return;
                            if (e.key === 'ArrowDown') {
                              e.preventDefault();
                              setActiveDropdownIndex((prev) =>
                                Math.min(prev + 1, filteredUnmappedFields.length - 1),
                              );
                            } else if (e.key === 'ArrowUp') {
                              e.preventDefault();
                              setActiveDropdownIndex((prev) => Math.max(prev - 1, 0));
                            } else if (e.key === 'Enter' && activeDropdownIndex >= 0) {
                              e.preventDefault();
                              applyFieldSelection(filteredUnmappedFields[activeDropdownIndex]);
                            } else if (e.key === 'Escape') {
                              setFieldNameDropdownOpen(false);
                            }
                          }}
                          placeholder="Search fields..."
                          className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus"
                        />
                      </div>

                      {/* Items */}
                      <div className="overflow-y-auto flex-1">
                        {unmappedFieldsLoading ? (
                          <div className="p-4 text-xs text-muted text-center">
                            Loading connector fields...
                          </div>
                        ) : filteredUnmappedFields.length === 0 ? (
                          <div className="p-4 text-xs text-muted text-center">
                            No fields match your criteria
                          </div>
                        ) : (
                          <>
                            {(() => {
                              const displayQ = fieldLabel.trim();
                              const hasAutoMatches =
                                displayQ.length >= 2 &&
                                filteredUnmappedFields.some(
                                  (f) =>
                                    (f as UnmappedField & { _autoScore?: number })._autoScore &&
                                    (f as UnmappedField & { _autoScore?: number })._autoScore! > 0,
                                );
                              let passedAuto = false;

                              return filteredUnmappedFields.map((field, i) => {
                                const autoScore = (field as UnmappedField & { _autoScore?: number })
                                  ._autoScore;
                                const isAutoMatch = hasAutoMatches && autoScore && autoScore > 0;
                                const displayType = TYPE_DISPLAY[field.type] || field.type;

                                let separator = null;
                                if (hasAutoMatches && !passedAuto && !isAutoMatch) {
                                  passedAuto = true;
                                  separator = (
                                    <div
                                      key={`sep-${i}`}
                                      className="px-3 py-1 text-[10px] text-muted bg-background-muted border-b border-default"
                                    >
                                      All fields
                                    </div>
                                  );
                                }

                                return (
                                  <div key={`${field.path}-${i}`}>
                                    {i === 0 && hasAutoMatches && isAutoMatch && (
                                      <div className="px-3 py-1 text-[10px] text-muted bg-background-muted border-b border-default">
                                        Best matches for &quot;{displayQ}&quot;
                                      </div>
                                    )}
                                    {separator}
                                    <button
                                      type="button"
                                      onClick={() => applyFieldSelection(field)}
                                      className={`w-full flex items-center gap-2 px-3 py-2 text-left border-b border-default/50 transition-colors cursor-pointer ${
                                        i === activeDropdownIndex
                                          ? 'bg-accent-subtle'
                                          : isAutoMatch
                                            ? 'bg-success-subtle/30 border-l-2 border-l-success'
                                            : 'hover:bg-background-muted'
                                      }`}
                                    >
                                      <div className="flex-1 min-w-0">
                                        <div className="font-mono text-xs text-foreground truncate">
                                          {field.path}
                                        </div>
                                        <div className="text-[11px] text-muted truncate">
                                          {field.label}
                                          {field.enumValues && field.enumValues.length > 0 && (
                                            <span> &middot; {field.enumValues.length} values</span>
                                          )}
                                        </div>
                                      </div>
                                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-background-muted text-muted uppercase tracking-wide shrink-0">
                                        {displayType}
                                      </span>
                                    </button>
                                  </div>
                                );
                              });
                            })()}
                            <div className="px-3 py-1.5 text-[10px] text-muted text-center bg-background-muted border-t border-default sticky bottom-0">
                              {filteredUnmappedFields.length} of {allUnmappedFields.length} fields
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                {/* Source path indicator */}
                {selectedUnmappedField && (
                  <div className="flex items-center gap-1 text-[11px] text-muted mt-1">
                    <span>Connector path:</span>
                    <span className="font-mono text-subtle">{selectedUnmappedField.path}</span>
                  </div>
                )}
              </div>
            </>
          )}

          <Select
            label="Type"
            options={TYPE_OPTIONS}
            value={fieldType}
            onChange={(val) => {
              setFieldType(val);
              // Re-trigger auto-suggest with new type filter
              if (!editingField && fieldLabel.trim().length >= 2) {
                // Delay to let state update
                setTimeout(() => autoSuggestFromLabel(fieldLabel), 0);
              }
            }}
          />
          <Input
            label="Description"
            value={fieldDescription}
            onChange={(e) => setFieldDescription(e.target.value)}
            placeholder="Helps the AI understand what this field means"
          />

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Capabilities</label>
            <div className="space-y-2">
              <Toggle
                checked={fieldFilterable}
                onChange={setFieldFilterable}
                label="Can be used as filter"
              />
              <Toggle
                checked={fieldSortable}
                onChange={setFieldSortable}
                label="Can be used for sorting"
              />
              <Toggle
                checked={fieldAggregatable}
                onChange={setFieldAggregatable}
                label="Can be used for grouping"
              />
            </div>
          </div>

          {/* Enum Values Editor */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">
                Values <span className="text-muted font-normal">(optional)</span>
              </label>
              <Button size="sm" variant="secondary" onClick={addEnumEntry}>
                + Add value
              </Button>
            </div>
            {enumEntries.length > 0 && (
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_1fr_32px] gap-2 text-xs text-muted">
                  <span>Display Name</span>
                  <span>Stored Value</span>
                  <span />
                </div>
                {enumEntries.map((entry, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_32px] gap-2">
                    <Input
                      value={entry.display}
                      onChange={(e) => updateEnumEntry(i, 'display', e.target.value)}
                      placeholder="High"
                    />
                    <Input
                      value={entry.stored}
                      onChange={(e) => updateEnumEntry(i, 'stored', e.target.value)}
                      placeholder="0.8"
                    />
                    <button
                      onClick={() => removeEnumEntry(i)}
                      className="p-1.5 text-muted hover:text-error rounded transition-default"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {fieldError && <p className="text-sm text-error">{fieldError}</p>}

          <div className="flex gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={() => setFieldDialogOpen(false)}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button onClick={handleSaveField} loading={fieldSaving} className="flex-1">
              {editingField
                ? 'Update Field'
                : schema?.fields.some((f) => f.name === fieldName.trim())
                  ? 'Map Field'
                  : 'Add Field'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* ─── Vocabulary Review Dialog (Story 4.5) ──────────────────── */}
      <VocabularyReviewDialog
        open={vocabReviewOpen}
        onClose={() => setVocabReviewOpen(false)}
        indexId={indexId}
        fieldRef={vocabReviewFieldRef}
        fieldLabel={vocabReviewFieldLabel}
      />
    </div>
  );
}

// ─── Unmapped Fields Sub-Component ──────────────────────────────────────

function UnmappedFieldsSection({
  knowledgeBaseId,
  canonicalSchemaId,
  canonicalFields,
  sources,
  onMappingCreated,
}: {
  knowledgeBaseId: string;
  canonicalSchemaId: string;
  canonicalFields: CanonicalField[];
  sources: Array<{ _id: string; name: string; connectorType?: string }>;
  onMappingCreated: () => void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [unmappedData, setUnmappedData] = useState<
    Map<string, { fields: UnmappedField[]; total: number; mapped: number }>
  >(new Map());
  const [searchQuery, setSearchQuery] = useState('');
  const [mappingField, setMappingField] = useState<{
    field: UnmappedField;
    connectorId: string;
  } | null>(null);
  const [selectedCanonicalField, setSelectedCanonicalField] = useState('');
  const [manualMappingSaving, setManualMappingSaving] = useState(false);

  const loadUnmapped = async (connectorId: string) => {
    setLoading(connectorId);
    try {
      const result = await getUnmappedFields(knowledgeBaseId, connectorId);
      setUnmappedData((prev) => {
        const next = new Map(prev);
        next.set(connectorId, {
          fields: result.unmappedFields,
          total: result.totalFields,
          mapped: result.mappedCount,
        });
        return next;
      });
    } catch {
      toast.error('Failed to load unmapped fields');
    } finally {
      setLoading(null);
    }
  };

  const handleManualMap = async () => {
    if (!mappingField || !selectedCanonicalField) return;
    setManualMappingSaving(true);
    try {
      await createManualMapping({
        sourcePath: mappingField.field.path,
        canonicalField: selectedCanonicalField,
        connectorId: mappingField.connectorId,
        canonicalSchemaId,
        transform: { type: 'direct' },
      });
      onMappingCreated();
      // Remove the mapped field from local state
      setUnmappedData((prev) => {
        const next = new Map(prev);
        const connData = next.get(mappingField.connectorId);
        if (connData) {
          next.set(mappingField.connectorId, {
            ...connData,
            fields: connData.fields.filter((f) => f.path !== mappingField.field.path),
            mapped: connData.mapped + 1,
          });
        }
        return next;
      });
      setMappingField(null);
      setSelectedCanonicalField('');
      toast.success('Field mapped successfully');
    } catch (err) {
      toast.error(sanitizeError(err, 'Failed to create mapping'));
    } finally {
      setManualMappingSaving(false);
    }
  };

  const totalUnmapped = Array.from(unmappedData.values()).reduce(
    (sum, d) => sum + d.fields.length,
    0,
  );

  const lowerSearch = searchQuery.toLowerCase();

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-foreground">
          Unmapped Fields
          {totalUnmapped > 0 && (
            <Badge variant="default" className="ml-2">
              {totalUnmapped}
            </Badge>
          )}
        </h3>
      </div>

      {/* Search filter */}
      {totalUnmapped > 0 && (
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by field name..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-default bg-background text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-border-focus"
          />
        </div>
      )}

      <div className="space-y-3">
        {sources.map((source) => {
          const data = unmappedData.get(source._id);
          const isLoading = loading === source._id;
          const filteredFields = data?.fields.filter(
            (f) => !searchQuery || f.path.toLowerCase().includes(lowerSearch),
          );

          return (
            <div
              key={source._id}
              className="rounded-xl border border-default bg-background-elevated p-4"
            >
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <span className="font-medium text-foreground">{source.name}</span>
                  {data && (
                    <span className="text-muted ml-2">
                      {data.fields.length} unmapped of {data.total}
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />}
                  onClick={() => loadUnmapped(source._id)}
                  loading={isLoading}
                >
                  {data ? 'Refresh' : 'Load'}
                </Button>
              </div>

              {filteredFields && filteredFields.length > 0 && (
                <div className="mt-3 space-y-1">
                  {filteredFields.slice(0, 20).map((field) => (
                    <div
                      key={field.path}
                      className="flex items-center gap-3 text-xs py-1.5 px-2 rounded hover:bg-background-muted"
                    >
                      <span className="font-mono text-muted flex-1">{field.path}</span>
                      <Badge variant="default" className="text-xs">
                        {TYPE_DISPLAY[field.type] || field.type}
                      </Badge>
                      {field.label && (
                        <span className="text-subtle truncate max-w-[150px]">{field.label}</span>
                      )}
                      {field.isCustom && (
                        <Badge variant="warning" className="text-xs">
                          Custom
                        </Badge>
                      )}
                      <button
                        onClick={() => {
                          setMappingField({ field, connectorId: source._id });
                          setSelectedCanonicalField('');
                        }}
                        className="px-2 py-0.5 text-xs text-accent hover:bg-accent-subtle rounded transition-default"
                      >
                        Map
                      </button>
                    </div>
                  ))}
                  {filteredFields.length > 20 && (
                    <div className="text-xs text-subtle px-2 py-1">
                      +{filteredFields.length - 20} more fields
                    </div>
                  )}
                </div>
              )}

              {data && data.fields.length === 0 && (
                <div className="mt-2 text-xs text-muted">All fields are mapped.</div>
              )}

              {data && data.fields.length > 0 && filteredFields && filteredFields.length === 0 && (
                <div className="mt-2 text-xs text-muted">
                  No fields match &quot;{searchQuery}&quot;
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Manual Mapping Dialog */}
      <Dialog
        open={!!mappingField}
        onClose={() => setMappingField(null)}
        title="Map Field Manually"
        maxWidth="sm"
      >
        {mappingField && (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-muted uppercase tracking-wide">
                Source Field
              </label>
              <div className="mt-1 font-mono text-sm text-foreground">
                {mappingField.field.path}
              </div>
              <div className="text-xs text-subtle mt-0.5">
                Type: {TYPE_DISPLAY[mappingField.field.type] || mappingField.field.type}
              </div>
            </div>

            <Select
              label="Map to Canonical Field"
              options={canonicalFields.map((f) => ({
                value: f.storageField,
                label: `${f.label} (${f.storageField})`,
              }))}
              value={selectedCanonicalField}
              onChange={(value) => setSelectedCanonicalField(value)}
            />

            <div className="flex gap-3 pt-2">
              <Button variant="secondary" onClick={() => setMappingField(null)} className="flex-1">
                Cancel
              </Button>
              <Button
                onClick={handleManualMap}
                loading={manualMappingSaving}
                disabled={!selectedCanonicalField}
                className="flex-1"
              >
                Create Mapping
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
