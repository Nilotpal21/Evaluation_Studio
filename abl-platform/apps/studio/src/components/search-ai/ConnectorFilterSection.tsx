/**
 * ConnectorFilterSection
 *
 * Comprehensive filter configuration UI for enterprise connectors.
 * Replaces the old flat filter section with the new structured schema:
 * - Standard filters (content categories, file extensions, size, dates)
 * - Scope filters (site/library selection, folder paths)
 * - Advanced filters (field/operator/value conditions)
 * - Filter templates (quick-apply presets)
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  Check,
  Sparkles,
  Plus,
  Trash2,
  FileText,
  Globe,
  FolderTree,
  SlidersHorizontal,
  Eye,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Toggle } from '../ui/Toggle';
import type { EnterpriseConnector, FilterTemplate } from '../../api/search-ai';
import {
  updateConnectorConfig,
  getFilterTemplates,
  applyFilterTemplate,
  previewFilters,
} from '../../api/search-ai';

// ─── Types ──────────────────────────────────────────────────────────────

interface ConnectorFilterSectionProps {
  connector: EnterpriseConnector;
  indexId: string;
  connectorId: string;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
}

interface ScopeConfig {
  siteMode: 'all' | 'selected' | 'excluded';
  siteIds: string[];
  sitePatterns: string[];
  libraryMode: 'all' | 'selected' | 'excluded';
  libraryNames: string[];
  libraryPatterns: string[];
  folderPaths: { include: string[]; exclude: string[] };
}

interface AdvancedCondition {
  field: string;
  operator: string;
  value: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function getScope(connector: EnterpriseConnector): ScopeConfig {
  const scope = connector.filterConfig.scope as Partial<ScopeConfig> | undefined;
  return {
    siteMode: scope?.siteMode ?? 'all',
    siteIds: scope?.siteIds ?? [],
    sitePatterns: scope?.sitePatterns ?? [],
    libraryMode: scope?.libraryMode ?? 'all',
    libraryNames: scope?.libraryNames ?? [],
    libraryPatterns: scope?.libraryPatterns ?? [],
    folderPaths: scope?.folderPaths ?? { include: [], exclude: [] },
  };
}

// ─── Shared Styles ──────────────────────────────────────────────────────

const textareaClass =
  'w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 font-mono placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus';

const sectionHeaderClass =
  'flex items-center gap-2 text-xs font-semibold text-muted uppercase tracking-wider mb-2 mt-4';

const modeButtonClass = (active: boolean) =>
  `px-3 py-1.5 rounded-lg text-xs border transition-default ${
    active
      ? 'border-accent bg-accent/10 text-accent'
      : 'border-default bg-background-subtle text-muted hover:text-foreground'
  }`;

// ─── Component ──────────────────────────────────────────────────────────

export function ConnectorFilterSection({
  connector,
  indexId,
  connectorId,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaved,
}: ConnectorFilterSectionProps) {
  const t = useTranslations('search_ai.connector_filters');

  // ─── Localized Constants ──────────────────────────────────────────────

  const CONTENT_CATEGORIES = useMemo(
    () => [
      { id: 'files', label: t('cat_files'), description: t('cat_files_desc') },
      { id: 'pages', label: t('cat_pages'), description: t('cat_pages_desc') },
    ],
    [t],
  );

  const OPERATOR_OPTIONS = useMemo(
    () => [
      { value: 'eq', label: t('op_eq') },
      { value: 'ne', label: t('op_ne') },
      { value: 'gt', label: t('op_gt') },
      { value: 'lt', label: t('op_lt') },
      { value: 'ge', label: t('op_ge') },
      { value: 'le', label: t('op_le') },
      { value: 'contains', label: t('op_contains') },
      { value: 'startsWith', label: t('op_starts_with') },
      { value: 'endsWith', label: t('op_ends_with') },
    ],
    [t],
  );

  const FIELD_OPTIONS = useMemo(
    () => [
      { value: 'name', label: t('field_name') },
      { value: 'contentType', label: t('field_content_type') },
      { value: 'sizeBytes', label: t('field_size') },
      { value: 'modifiedAt', label: t('field_modified_date') },
      { value: 'createdAt', label: t('field_created_date') },
      { value: 'metadata.sharepoint.createdBy', label: t('field_created_by') },
      { value: 'metadata.sharepoint.lastModifiedBy', label: t('field_modified_by') },
      { value: 'metadata.sharepoint.siteName', label: t('field_site_name') },
      { value: 'metadata.sharepoint.driveName', label: t('field_library_name') },
    ],
    [t],
  );

  const MODE_OPTIONS = useMemo(
    () => [
      { value: 'all', label: t('mode_all') },
      { value: 'selected', label: t('mode_selected') },
      { value: 'excluded', label: t('mode_excluded') },
    ],
    [t],
  );

  // ─── Edit State ─────────────────────────────────────────────────────

  const std = connector.filterConfig.standard;
  const scope = getScope(connector);
  const adv = connector.filterConfig.advancedFilters;

  const [categories, setCategories] = useState<string[]>(std.contentCategories);
  const [extMode, setExtMode] = useState<'allowlist' | 'denylist'>(
    std.fileExtensions?.mode ?? 'allowlist',
  );
  const [extensions, setExtensions] = useState(std.fileExtensions?.extensions.join(', ') ?? '');
  const [maxSize, setMaxSize] = useState(
    std.maxFileSizeBytes ? String(std.maxFileSizeBytes / (1024 * 1024)) : '',
  );
  const [modifiedAfter, setModifiedAfter] = useState(
    std.modifiedAfter ? std.modifiedAfter.slice(0, 10) : '',
  );

  const [siteMode, setSiteMode] = useState(scope.siteMode);
  const [sitePatterns, setSitePatterns] = useState(scope.sitePatterns.join('\n'));
  const [libMode, setLibMode] = useState(scope.libraryMode);
  const [libNames, setLibNames] = useState(scope.libraryNames.join('\n'));
  const [excludeFolders, setExcludeFolders] = useState(scope.folderPaths.exclude.join('\n'));

  const [advEnabled, setAdvEnabled] = useState(adv.enabled);
  const [advConditions, setAdvConditions] = useState<AdvancedCondition[]>(
    adv.conditions.map((c) => ({
      field: c.field,
      operator: c.operator,
      value: String(c.value ?? ''),
    })),
  );

  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<FilterTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [applyingTemplate, setApplyingTemplate] = useState<string | null>(null);

  // ─── Actions ────────────────────────────────────────────────────────

  const toggleCategory = (cat: string) => {
    setCategories((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  };

  const addCondition = () => {
    setAdvConditions((prev) => [...prev, { field: 'name', operator: 'contains', value: '' }]);
  };

  const removeCondition = (index: number) => {
    setAdvConditions((prev) => prev.filter((_, i) => i !== index));
  };

  const updateCondition = (index: number, updates: Partial<AdvancedCondition>) => {
    setAdvConditions((prev) => prev.map((c, i) => (i === index ? { ...c, ...updates } : c)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const extList = extensions
        .split(',')
        .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
        .filter(Boolean);

      const filterConfig = {
        standard: {
          contentCategories: categories,
          fileExtensions: extList.length > 0 ? { mode: extMode, extensions: extList } : null,
          maxFileSizeBytes: maxSize ? Number(maxSize) * 1024 * 1024 : null,
          minFileSizeBytes: null,
          modifiedAfter: modifiedAfter ? new Date(modifiedAfter).toISOString() : null,
          modifiedBefore: null,
          createdAfter: null,
          createdBefore: null,
        },
        scope: {
          siteMode,
          siteIds: [] as string[],
          sitePatterns: sitePatterns
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          libraryMode: libMode,
          libraryNames: libNames
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          libraryPatterns: [] as string[],
          folderPaths: {
            include: [] as string[],
            exclude: excludeFolders
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          },
        },
        advancedFilters: {
          enabled: advEnabled && advConditions.length > 0,
          rootOperator: 'AND' as const,
          conditions: advConditions
            .filter((c) => c.field && c.value)
            .map((c) => ({ field: c.field, operator: c.operator, value: c.value })),
          groups: [],
        },
        version: (connector.filterConfig.version ?? 0) + 1,
      };

      await updateConnectorConfig(indexId, connectorId, { filterConfig });
      toast.success(t('toast_saved'));
      onSaved();
    } catch (err) {
      toast.error(sanitizeError(err, t('error_save')));
    } finally {
      setSaving(false);
    }
  };

  const loadTemplates = useCallback(async () => {
    try {
      const result = await getFilterTemplates(connectorId);
      setTemplates(result.data);
      setShowTemplates(true);
    } catch (err) {
      toast.error(sanitizeError(err, t('error_load_templates')));
    }
  }, [connectorId]);

  const handleApplyTemplate = async (templateId: string) => {
    setApplyingTemplate(templateId);
    try {
      await applyFilterTemplate(connectorId, templateId, true);
      toast.success(t('toast_template_applied'));
      onSaved();
    } catch (err) {
      toast.error(sanitizeError(err, t('error_apply_template')));
    } finally {
      setApplyingTemplate(null);
    }
  };

  // ─── Read-Only View ─────────────────────────────────────────────────

  if (!editing) {
    return (
      <div className="space-y-2 text-sm">
        {/* Content Categories */}
        <div className="flex justify-between items-center">
          <span className="text-muted">{t('label_content')}</span>
          <div className="flex gap-1">
            {std.contentCategories.map((cat) => (
              <Badge key={cat} variant="info">
                {cat}
              </Badge>
            ))}
            {std.contentCategories.length === 0 && (
              <span className="text-xs text-muted italic">{t('all_content')}</span>
            )}
          </div>
        </div>

        {/* File Extensions */}
        {std.fileExtensions && (
          <div>
            <span className="text-muted text-xs">
              {t('label_file_extensions', { mode: std.fileExtensions.mode })}
            </span>
            <div className="flex flex-wrap gap-1 mt-1">
              {std.fileExtensions.extensions.slice(0, 10).map((ext) => (
                <Badge key={ext} variant="default">
                  .{ext}
                </Badge>
              ))}
              {std.fileExtensions.extensions.length > 10 && (
                <Badge variant="default">
                  {t('more_count', { count: std.fileExtensions.extensions.length - 10 })}
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* Size Limit */}
        {std.maxFileSizeBytes && (
          <div className="flex justify-between">
            <span className="text-muted">{t('label_max_size')}</span>
            <span>{Math.round(std.maxFileSizeBytes / (1024 * 1024))} MB</span>
          </div>
        )}

        {/* Date Filter */}
        {std.modifiedAfter && (
          <div className="flex justify-between">
            <span className="text-muted">{t('label_modified_after')}</span>
            <span>{new Date(std.modifiedAfter).toLocaleDateString()}</span>
          </div>
        )}

        {/* Site Scope */}
        {scope.siteMode !== 'all' && (
          <div>
            <span className="text-muted text-xs">{t('label_sites', { mode: scope.siteMode })}</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {scope.sitePatterns.map((p) => (
                <Badge key={p} variant="default">
                  {p}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Library Scope */}
        {scope.libraryMode !== 'all' && (
          <div>
            <span className="text-muted text-xs">
              {t('label_libraries', { mode: scope.libraryMode })}
            </span>
            <div className="flex flex-wrap gap-1 mt-1">
              {scope.libraryNames.map((n) => (
                <Badge key={n} variant="default">
                  {n}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Folder Excludes */}
        {scope.folderPaths.exclude.length > 0 && (
          <div>
            <span className="text-muted text-xs">{t('label_excluded_folders')}</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {scope.folderPaths.exclude.map((p) => (
                <Badge key={p} variant="warning">
                  {p}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Advanced Filters */}
        {adv.enabled && adv.conditions.length > 0 && (
          <div>
            <span className="text-muted text-xs">
              {t('label_advanced', { count: adv.conditions.length })}
            </span>
            <div className="space-y-1 mt-1">
              {adv.conditions.map((c, i) => (
                <div key={i} className="text-xs font-mono bg-background-subtle rounded px-2 py-1">
                  {c.field} {c.operator} {String(c.value)}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty State */}
        {!std.fileExtensions &&
          !std.maxFileSizeBytes &&
          !std.modifiedAfter &&
          scope.siteMode === 'all' &&
          scope.libraryMode === 'all' &&
          scope.folderPaths.exclude.length === 0 &&
          !adv.enabled && <p className="text-xs text-muted italic">{t('no_filters')}</p>}
      </div>
    );
  }

  // ─── Edit Mode ──────────────────────────────────────────────────────

  return (
    <div className="space-y-1">
      {/* ─── Templates Quick-Apply ─────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3">
        <Button
          size="sm"
          variant="secondary"
          icon={<Sparkles className="w-3.5 h-3.5" />}
          onClick={loadTemplates}
        >
          {t('btn_templates')}
        </Button>
      </div>

      {showTemplates && templates.length > 0 && (
        <div className="border border-default rounded-lg p-3 mb-3 bg-background-subtle space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted uppercase tracking-wider">
              {t('quick_apply')}
            </span>
            <button
              onClick={() => setShowTemplates(false)}
              className="text-muted hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {templates.map((tmpl) => (
              <button
                key={tmpl.id}
                onClick={() => handleApplyTemplate(tmpl.id)}
                disabled={applyingTemplate !== null}
                className="text-left p-2 rounded-lg border border-default hover:border-accent hover:bg-accent/5 transition-default"
              >
                <div className="text-xs font-medium text-foreground">{tmpl.name}</div>
                <div className="text-xs text-muted mt-0.5 line-clamp-2">{tmpl.description}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── Content Categories ────────────────────────────────────────── */}
      <div className={sectionHeaderClass}>
        <FileText className="w-3.5 h-3.5" />
        {t('section_content')}
      </div>
      <div className="flex gap-2">
        {CONTENT_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => toggleCategory(cat.id)}
            className={modeButtonClass(categories.includes(cat.id))}
          >
            <div>{cat.label}</div>
            <div className="text-xs opacity-70">{cat.description}</div>
          </button>
        ))}
      </div>

      {/* ─── Site Selection ────────────────────────────────────────────── */}
      <div className={sectionHeaderClass}>
        <Globe className="w-3.5 h-3.5" />
        {t('section_sites')}
      </div>
      <div className="flex gap-1.5 mb-2">
        {MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setSiteMode(opt.value as ScopeConfig['siteMode'])}
            className={modeButtonClass(siteMode === opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {siteMode !== 'all' && (
        <textarea
          value={sitePatterns}
          onChange={(e) => setSitePatterns(e.target.value)}
          placeholder={t('placeholder_sites')}
          rows={3}
          className={textareaClass}
        />
      )}

      {/* ─── Library Selection ─────────────────────────────────────────── */}
      <div className={sectionHeaderClass}>
        <FolderTree className="w-3.5 h-3.5" />
        {t('section_libraries')}
      </div>
      <div className="flex gap-1.5 mb-2">
        {MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setLibMode(opt.value as ScopeConfig['libraryMode'])}
            className={modeButtonClass(libMode === opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {libMode !== 'all' && (
        <textarea
          value={libNames}
          onChange={(e) => setLibNames(e.target.value)}
          placeholder={t('placeholder_libraries')}
          rows={2}
          className={textareaClass}
        />
      )}

      {/* ─── Folder Path Exclusions ────────────────────────────────────── */}
      <div className={sectionHeaderClass}>
        <FolderTree className="w-3.5 h-3.5" />
        {t('section_exclude_folders')}
      </div>
      <textarea
        value={excludeFolders}
        onChange={(e) => setExcludeFolders(e.target.value)}
        placeholder={t('placeholder_exclude_folders')}
        rows={3}
        className={textareaClass}
      />

      {/* ─── File Extensions ───────────────────────────────────────────── */}
      <div className={sectionHeaderClass}>
        <FileText className="w-3.5 h-3.5" />
        {t('section_extensions')}
      </div>
      <div className="flex gap-1.5 mb-2">
        {(['allowlist', 'denylist'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setExtMode(mode)}
            className={modeButtonClass(extMode === mode)}
          >
            {mode === 'allowlist' ? t('ext_allowlist') : t('ext_denylist')}
          </button>
        ))}
      </div>
      <Input
        value={extensions}
        onChange={(e) => setExtensions(e.target.value)}
        placeholder={t('placeholder_extensions')}
      />
      <p className="text-xs text-muted mt-1">{t('ext_help')}</p>

      {/* ─── Size & Date ───────────────────────────────────────────────── */}
      <div className={sectionHeaderClass}>
        <SlidersHorizontal className="w-3.5 h-3.5" />
        {t('section_size_date')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input
          label={t('label_max_size_mb')}
          value={maxSize}
          onChange={(e) => setMaxSize(e.target.value)}
          placeholder={t('placeholder_size')}
          type="number"
        />
        <Input
          label={t('label_modified_after_input')}
          value={modifiedAfter}
          onChange={(e) => setModifiedAfter(e.target.value)}
          type="date"
        />
      </div>

      {/* ─── Advanced Filters ──────────────────────────────────────────── */}
      <div className={sectionHeaderClass}>
        <SlidersHorizontal className="w-3.5 h-3.5" />
        {t('section_advanced')}
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Toggle checked={advEnabled} onChange={setAdvEnabled} />
        <span className="text-xs text-muted">
          {advEnabled ? t('toggle_enabled') : t('toggle_disabled')}
        </span>
      </div>

      {advEnabled && (
        <div className="space-y-2">
          {advConditions.map((cond, idx) => (
            <div key={idx} className="flex gap-1.5 items-start">
              <select
                value={cond.field}
                onChange={(e) => updateCondition(idx, { field: e.target.value })}
                className="rounded-lg border border-default bg-background-subtle text-foreground text-xs py-1.5 px-2 min-w-0 flex-1"
              >
                {FIELD_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
              <select
                value={cond.operator}
                onChange={(e) => updateCondition(idx, { operator: e.target.value })}
                className="rounded-lg border border-default bg-background-subtle text-foreground text-xs py-1.5 px-2 min-w-0 w-28"
              >
                {OPERATOR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                value={cond.value}
                onChange={(e) => updateCondition(idx, { value: e.target.value })}
                placeholder={t('placeholder_value')}
                className="rounded-lg border border-default bg-background-subtle text-foreground text-xs py-1.5 px-2 min-w-0 flex-1"
              />
              <button
                onClick={() => removeCondition(idx)}
                className="p-1.5 text-muted hover:text-error transition-default"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="w-3 h-3" />}
            onClick={addCondition}
          >
            {t('btn_add_condition')}
          </Button>
        </div>
      )}

      {/* ─── Save / Cancel ─────────────────────────────────────────────── */}
      <div className="flex gap-2 pt-3 border-t border-default mt-3">
        <Button size="sm" variant="secondary" onClick={onCancelEdit}>
          {t('btn_cancel')}
        </Button>
        <Button
          size="sm"
          icon={<Check className="w-3.5 h-3.5" />}
          loading={saving}
          onClick={handleSave}
        >
          {t('btn_save')}
        </Button>
      </div>
    </div>
  );
}
