/**
 * Structured Data Schema Dialog
 *
 * Shows detected schema from CSV/Excel analysis with column types,
 * confidence scores, and quality warnings. Allows user to edit schema
 * before finalizing ingestion.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { AlertCircle, CheckCircle, Info, Edit2, X } from 'lucide-react';
import type { AnalyzeResponse } from '../../api/search-ai';

interface StructuredDataSchemaDialogProps {
  isOpen: boolean;
  onClose: () => void;
  analysis: AnalyzeResponse;
  onConfirm: (schema: {
    tableName: string;
    displayName: string;
    description: string;
    columns: Array<{
      name: string;
      type: string;
      description?: string;
      isEmbeddable: boolean;
      isFilterable: boolean;
    }>;
    primaryKey: string | null;
  }) => void;
  isSubmitting?: boolean;
}

import { getBadgeIntentStyles } from '@agent-platform/design-tokens';
import type { SemanticIntent } from '@agent-platform/design-tokens';

const TYPE_INTENT: Record<string, SemanticIntent> = {
  string: 'info',
  integer: 'success',
  number: 'success',
  boolean: 'purple',
  date: 'orange',
  enum: 'accent',
};

function getTypeColor(type: string): string {
  const intent = TYPE_INTENT[type];
  if (!intent) return 'bg-background-muted text-foreground-muted border-default';
  return getBadgeIntentStyles(intent).badge;
}

export function StructuredDataSchemaDialog({
  isOpen,
  onClose,
  analysis,
  onConfirm,
  isSubmitting = false,
}: StructuredDataSchemaDialogProps) {
  const t = useTranslations('search_ai.structured_schema');
  const [editMode, setEditMode] = useState(false);
  const [tableName, setTableName] = useState(analysis.schema.tableName);
  const [displayName, setDisplayName] = useState(
    analysis.schema.tableName
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' '),
  );
  const [description, setDescription] = useState('');
  const [editedColumns, setEditedColumns] = useState(
    analysis.schema.columns.map((col) => ({
      name: col.name,
      type: col.type,
      isEmbeddable: col.isEmbeddable,
      isFilterable: col.isFilterable,
      description: '',
    })),
  );

  const handleConfirm = () => {
    onConfirm({
      tableName,
      displayName,
      description,
      columns: editedColumns,
      primaryKey: analysis.schema.primaryKey,
    });
  };

  const toggleEmbeddable = (index: number) => {
    const updated = [...editedColumns];
    updated[index].isEmbeddable = !updated[index].isEmbeddable;
    setEditedColumns(updated);
  };

  const toggleFilterable = (index: number) => {
    const updated = [...editedColumns];
    updated[index].isFilterable = !updated[index].isFilterable;
    setEditedColumns(updated);
  };

  return (
    <Dialog open={isOpen} onClose={onClose} title={t('title')} maxWidth="4xl">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto">
        <p className="text-sm text-muted">{t('description')}</p>

        <div className="flex-1 overflow-y-auto space-y-4 p-4">
          {/* Quality Summary */}
          <div className="rounded-lg border border-default bg-background-subtle p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">{t('detection_quality')}</h3>
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-success" />
                <span className="text-sm font-medium text-foreground">
                  {t('confidence_percent', {
                    percent: Math.round(analysis.quality.overallConfidence * 100),
                  })}
                </span>
              </div>
            </div>

            {analysis.quality.warnings.length > 0 && (
              <div className="space-y-1">
                {analysis.quality.warnings.map((warning, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-warning">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>{warning}</span>
                  </div>
                ))}
              </div>
            )}

            {analysis.quality.recommendations.length > 0 && (
              <div className="space-y-1">
                {analysis.quality.recommendations.map((rec, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-info">
                    <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>{rec}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Table Info */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">{t('table_information')}</h3>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditMode(!editMode)}
                className="h-7"
              >
                {editMode ? (
                  <>
                    <X className="w-3.5 h-3.5 mr-1.5" />
                    {t('cancel')}
                  </>
                ) : (
                  <>
                    <Edit2 className="w-3.5 h-3.5 mr-1.5" />
                    {t('edit')}
                  </>
                )}
              </Button>
            </div>

            {editMode ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">
                    {t('table_name')}
                  </label>
                  <Input
                    value={tableName}
                    onChange={(e) => setTableName(e.target.value)}
                    placeholder={t('table_name_placeholder')}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">
                    {t('display_name')}
                  </label>
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={t('display_name_placeholder')}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">
                    {t('description_label')}
                  </label>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('description_placeholder')}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted">{t('table_name')}:</span>
                  <span className="ml-2 font-mono text-foreground">{tableName}</span>
                </div>
                <div>
                  <span className="text-muted">{t('display_name')}:</span>
                  <span className="ml-2 text-foreground">{displayName}</span>
                </div>
                <div>
                  <span className="text-muted">{t('rows')}:</span>
                  <span className="ml-2 font-medium text-foreground">
                    {analysis.schema.rowCount.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="text-muted">{t('columns')}:</span>
                  <span className="ml-2 font-medium text-foreground">
                    {analysis.schema.columns.length}
                  </span>
                </div>
                {analysis.schema.primaryKey && (
                  <div>
                    <span className="text-muted">{t('primary_key')}:</span>
                    <span className="ml-2 font-mono text-foreground">
                      {analysis.schema.primaryKey}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Columns */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">
              {t('columns_count', { count: analysis.schema.columns.length })}
            </h3>
            <div className="border border-default rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-background-subtle border-b border-default">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-muted">
                        {t('col_name')}
                      </th>
                      <th className="text-left px-3 py-2 font-medium text-muted">
                        {t('col_type')}
                      </th>
                      <th className="text-center px-3 py-2 font-medium text-muted">
                        {t('col_confidence')}
                      </th>
                      <th className="text-center px-3 py-2 font-medium text-muted">
                        {t('col_embeddable')}
                      </th>
                      <th className="text-center px-3 py-2 font-medium text-muted">
                        {t('col_filterable')}
                      </th>
                      <th className="text-left px-3 py-2 font-medium text-muted">
                        {t('col_sample_values')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-default">
                    {analysis.schema.columns.map((col, index) => (
                      <tr key={col.name} className="hover:bg-background-subtle/50">
                        <td className="px-3 py-2 font-mono text-foreground">{col.name}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${getTypeColor(col.type)}`}
                          >
                            {col.type}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span
                            className={
                              col.confidence >= 0.9
                                ? 'text-success'
                                : col.confidence >= 0.7
                                  ? 'text-warning'
                                  : 'text-error'
                            }
                          >
                            {Math.round(col.confidence * 100)}%
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={() => toggleEmbeddable(index)}
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                              editedColumns[index].isEmbeddable
                                ? 'bg-accent border-accent text-accent-foreground'
                                : 'border-default hover:border-accent/50'
                            }`}
                          >
                            {editedColumns[index].isEmbeddable && (
                              <CheckCircle className="w-3 h-3" />
                            )}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={() => toggleFilterable(index)}
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                              editedColumns[index].isFilterable
                                ? 'bg-accent border-accent text-accent-foreground'
                                : 'border-default hover:border-accent/50'
                            }`}
                          >
                            {editedColumns[index].isFilterable && (
                              <CheckCircle className="w-3 h-3" />
                            )}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-muted">
                          {col.sampleValues.slice(0, 2).map(String).join(', ')}
                          {col.sampleValues.length > 2 && '...'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Cost Estimates */}
          <div className="rounded-lg border border-default bg-background-subtle p-4">
            <h3 className="text-sm font-semibold text-foreground mb-3">
              {t('ingestion_estimates')}
            </h3>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-muted">{t('embedding_tokens')}:</span>
                <span className="ml-2 font-medium text-foreground">
                  {analysis.estimates.embeddingTokens.toLocaleString()}
                </span>
              </div>
              <div>
                <span className="text-muted">{t('estimated_cost')}:</span>
                <span className="ml-2 font-medium text-foreground">
                  ${analysis.estimates.embeddingCost.toFixed(6)}
                </span>
              </div>
              <div>
                <span className="text-muted">{t('storage')}:</span>
                <span className="ml-2 font-medium text-foreground">
                  {(analysis.estimates.storageBytes / 1024).toFixed(1)} KB
                </span>
              </div>
              <div>
                <span className="text-muted">{t('processing_time')}:</span>
                <span className="ml-2 font-medium text-foreground">
                  ~{analysis.estimates.processingTimeSeconds}s
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-4 border-t border-default">
        <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>
          {t('cancel')}
        </Button>
        <Button onClick={handleConfirm} disabled={isSubmitting || !tableName.trim()}>
          {isSubmitting ? t('ingesting') : t('confirm_and_ingest')}
        </Button>
      </div>
    </Dialog>
  );
}
