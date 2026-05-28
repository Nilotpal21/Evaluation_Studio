'use client';

/**
 * ScopeControlsPanel
 *
 * Left panel of the Scope+Filters split-pane. Contains filter controls:
 * sites, file types, dates, templates, folders, size, metadata, advanced.
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Input } from '../../ui/Input';
import { Button } from '../../ui/Button';
import type { DiscoveryData } from '../../../hooks/useConnectorDiscovery';
import type { FilterConfig } from '../../../hooks/useFilterPreview';
import { FilterTemplateSelector } from './FilterTemplateSelector';
import { CELExpressionEditor } from './CELExpressionEditor';
import { ConditionBuilder, type ConditionGroup } from './ConditionBuilder';

interface ScopeControlsPanelProps {
  indexId: string;
  connectorId: string;
  isDraftMode: boolean;
  discovery: DiscoveryData | null;
  filterConfig: FilterConfig;
  onFilterChange: (config: FilterConfig) => void;
}

const sectionHeaderClass =
  'flex items-center gap-2 text-xs font-semibold text-muted uppercase tracking-wider cursor-pointer select-none';

export function ScopeControlsPanel({
  isDraftMode,
  discovery,
  filterConfig,
  onFilterChange,
}: ScopeControlsPanelProps) {
  const t = useTranslations('search_ai.sharepoint.scopeFilters');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    sites: true,
    fileTypes: true,
    templates: true,
  });

  const toggleSection = useCallback((key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const updateFilter = useCallback(
    <K extends keyof FilterConfig>(key: K, value: FilterConfig[K]) => {
      onFilterChange({ ...filterConfig, [key]: value });
    },
    [filterConfig, onFilterChange],
  );

  // Derive available metadata fields from discovery data for advanced controls
  const advancedFields = useMemo<Array<{ name: string; type: string }>>(() => {
    if (!discovery?.metadataFields || discovery.metadataFields.length === 0)
      return [
        { name: 'contentType', type: 'string' },
        { name: 'author', type: 'string' },
        { name: 'lastModifiedBy', type: 'string' },
        { name: 'createdDate', type: 'date' },
        { name: 'size', type: 'number' },
      ];
    return discovery.metadataFields.map((f) => ({ name: f.fieldName, type: f.type }));
  }, [discovery]);

  const celFieldSuggestions = useMemo(() => {
    return advancedFields.map((f) => ({
      field: f.name,
      type: f.type,
    }));
  }, [advancedFields]);

  const SectionHeader = ({ id, label }: { id: string; label: string }) => (
    <button
      type="button"
      className={sectionHeaderClass}
      onClick={() => toggleSection(id)}
      aria-expanded={!!expandedSections[id]}
    >
      {expandedSections[id] ? (
        <ChevronDown className="w-3.5 h-3.5" />
      ) : (
        <ChevronRight className="w-3.5 h-3.5" />
      )}
      {label}
    </button>
  );

  return (
    <div className="space-y-5 overflow-y-auto">
      {/* Sites */}
      <div>
        <SectionHeader id="sites" label={t('sites_label')} />
        {expandedSections.sites && (
          <div className="mt-2 space-y-1.5">
            {isDraftMode ? (
              <p className="text-xs text-muted">{t('sites_all')}</p>
            ) : discovery?.sites && discovery.sites.length > 0 ? (
              discovery.sites.map((site) => (
                <label
                  key={site.siteId}
                  className="flex items-center gap-2 text-sm text-foreground cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={filterConfig.selectedSiteIds.includes(site.siteId)}
                    onChange={(e) => {
                      const siteIds = e.target.checked
                        ? [...filterConfig.selectedSiteIds, site.siteId]
                        : filterConfig.selectedSiteIds.filter((id) => id !== site.siteId);
                      updateFilter('selectedSiteIds', siteIds);
                    }}
                    className="rounded border-default"
                  />
                  <span className="truncate">{site.name}</span>
                  <span className="text-xs text-muted ml-auto shrink-0">
                    {site.fileCount} files
                  </span>
                </label>
              ))
            ) : (
              <p className="text-xs text-muted">{t('sites_all')}</p>
            )}
          </div>
        )}
      </div>

      {/* File Types */}
      <div>
        <SectionHeader id="fileTypes" label={t('file_types_label')} />
        {expandedSections.fileTypes && (
          <div className="mt-2 space-y-1.5">
            {discovery?.fileTypeProfile && discovery.fileTypeProfile.length > 0 ? (
              discovery.fileTypeProfile
                .filter((ft) => ft.indexable)
                .map((ft) => (
                  <label
                    key={ft.extension}
                    className="flex items-center gap-2 text-sm text-foreground cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={filterConfig.selectedFileTypes.includes(ft.extension)}
                      onChange={(e) => {
                        const types = e.target.checked
                          ? [...filterConfig.selectedFileTypes, ft.extension]
                          : filterConfig.selectedFileTypes.filter((t) => t !== ft.extension);
                        updateFilter('selectedFileTypes', types);
                      }}
                      className="rounded border-default"
                    />
                    <span>{ft.displayName || ft.extension}</span>
                    <span className="text-xs text-muted ml-auto shrink-0">{ft.count}</span>
                  </label>
                ))
            ) : (
              <p className="text-xs text-muted">{t('file_types_label')}</p>
            )}
          </div>
        )}
      </div>

      {/* Filter Templates */}
      <div>
        <SectionHeader id="templates" label={t('templates_label')} />
        {expandedSections.templates && (
          <div className="mt-2">
            <FilterTemplateSelector
              selected={filterConfig.filterTemplate}
              onSelect={(tpl) =>
                updateFilter('filterTemplate', tpl as FilterConfig['filterTemplate'])
              }
            />
          </div>
        )}
      </div>

      {/* Date Range */}
      <div>
        <SectionHeader id="dateRange" label={t('date_range_label')} />
        {expandedSections.dateRange && (
          <div className="mt-2 space-y-3">
            <Input
              label={t('date_after')}
              type="date"
              value={filterConfig.dateRange.modifiedAfter ?? ''}
              onChange={(e) =>
                updateFilter('dateRange', {
                  ...filterConfig.dateRange,
                  modifiedAfter: e.target.value || undefined,
                })
              }
            />
            <Input
              label={t('date_before')}
              type="date"
              value={filterConfig.dateRange.modifiedBefore ?? ''}
              onChange={(e) =>
                updateFilter('dateRange', {
                  ...filterConfig.dateRange,
                  modifiedBefore: e.target.value || undefined,
                })
              }
            />
          </div>
        )}
      </div>

      {/* Folder Rules */}
      <div>
        <SectionHeader id="folders" label={t('folders_label')} />
        {expandedSections.folders && (
          <div className="mt-2 space-y-3">
            <Input
              label={t('folders_include')}
              value={filterConfig.folderRules.include.join(', ')}
              onChange={(e) =>
                updateFilter('folderRules', {
                  ...filterConfig.folderRules,
                  include: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="/docs/*, /wiki/*"
            />
            <Input
              label={t('folders_exclude')}
              value={filterConfig.folderRules.exclude.join(', ')}
              onChange={(e) =>
                updateFilter('folderRules', {
                  ...filterConfig.folderRules,
                  exclude: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="/archive/*, /temp/*"
            />
          </div>
        )}
      </div>

      {/* Size Limits */}
      <div>
        <SectionHeader id="size" label={t('size_label')} />
        {expandedSections.size && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Input
              label={t('size_min')}
              type="number"
              value={filterConfig.sizeLimits.minBytes?.toString() ?? ''}
              onChange={(e) =>
                updateFilter('sizeLimits', {
                  ...filterConfig.sizeLimits,
                  minBytes: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              placeholder="0"
            />
            <Input
              label={t('size_max')}
              type="number"
              value={filterConfig.sizeLimits.maxBytes?.toString() ?? ''}
              onChange={(e) =>
                updateFilter('sizeLimits', {
                  ...filterConfig.sizeLimits,
                  maxBytes: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              placeholder="50000000"
            />
          </div>
        )}
      </div>

      {/* Advanced — Condition Builder + CEL Expression Editor */}
      <div>
        <SectionHeader id="advanced" label={t('advanced_label')} />
        {expandedSections.advanced && (
          <div className="mt-2 space-y-4">
            {/* Condition Builder */}
            <div>
              <p className="text-xs font-medium text-muted mb-2">{t('metadata_label')}</p>
              <ConditionBuilder
                groups={
                  filterConfig.conditionGroups.length > 0
                    ? (filterConfig.conditionGroups as ConditionGroup[])
                    : [{ logic: 'AND', conditions: [{ field: '', operator: 'equals', value: '' }] }]
                }
                onChange={(groups) => updateFilter('conditionGroups', groups)}
                fields={advancedFields}
                disabled={isDraftMode}
              />
            </div>

            {/* CEL Expression Editor */}
            <div>
              <p className="text-xs font-medium text-muted mb-2">{t('cel_label')}</p>
              <CELExpressionEditor
                value={filterConfig.celExpression ?? ''}
                onChange={(val) => updateFilter('celExpression', val)}
                onValidate={() => {
                  /* v1: client-side validation not yet implemented */
                }}
                fieldSuggestions={celFieldSuggestions}
                valueSuggestions={{}}
                disabled={isDraftMode}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
