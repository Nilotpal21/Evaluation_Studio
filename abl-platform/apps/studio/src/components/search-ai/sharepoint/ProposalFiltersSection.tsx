'use client';

/**
 * ProposalFiltersSection
 *
 * Displays filter configuration summary: template, file types, max file size.
 * In simplified view, provides inline editing capabilities.
 */

import { useState, useCallback } from 'react';
import { Filter } from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Input } from '../../ui/Input';
import { Button } from '../../ui/Button';

interface ProposalFiltersSectionProps {
  template: string;
  fileTypes: string[];
  maxFileSize: number;
  excludePatterns: string[];
  simplifiedView: boolean;
  onModify?: (data: Record<string, unknown>) => void;
  labels: {
    template_label: string;
    file_types_label: string;
    max_size_label: string;
    exclude_patterns_label: string;
    no_patterns: string;
    save_changes: string;
  };
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function ProposalFiltersSection({
  template,
  fileTypes,
  maxFileSize,
  excludePatterns,
  simplifiedView,
  onModify,
  labels,
}: ProposalFiltersSectionProps) {
  const [editing, setEditing] = useState(false);
  const [editMaxSize, setEditMaxSize] = useState(String(maxFileSize / 1_000_000));

  const handleSave = useCallback(() => {
    const sizeBytes = Number(editMaxSize) * 1_000_000;
    onModify?.({
      template,
      fileTypes,
      maxFileSize: sizeBytes,
      excludePatterns,
    });
    setEditing(false);
  }, [editMaxSize, template, fileTypes, excludePatterns, onModify]);

  return (
    <div className="space-y-3">
      {/* Template */}
      <div className="flex items-center gap-2">
        <Filter className="w-4 h-4 text-accent flex-shrink-0" />
        <span className="text-sm text-muted">{labels.template_label}:</span>
        <span className="text-sm font-medium text-foreground">{template}</span>
      </div>

      {/* File types */}
      <div className="space-y-1">
        <span className="text-sm text-muted">{labels.file_types_label}:</span>
        <div className="flex flex-wrap gap-1.5">
          {fileTypes.map((ft) => (
            <Badge key={ft} variant="default">
              {ft}
            </Badge>
          ))}
        </div>
      </div>

      {/* Max file size */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">{labels.max_size_label}:</span>
        {editing && simplifiedView ? (
          <div className="flex items-center gap-2">
            <Input
              value={editMaxSize}
              onChange={(e) => setEditMaxSize(e.target.value)}
              className="w-24"
            />
            <span className="text-sm text-muted">MB</span>
            <Button variant="primary" size="xs" onClick={handleSave}>
              {labels.save_changes}
            </Button>
          </div>
        ) : (
          <span className="text-sm font-medium text-foreground">{formatFileSize(maxFileSize)}</span>
        )}
        {simplifiedView && !editing && (
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
            {labels.save_changes}
          </Button>
        )}
      </div>

      {/* Exclude patterns */}
      <div className="space-y-1">
        <span className="text-sm text-muted">{labels.exclude_patterns_label}:</span>
        {excludePatterns.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {excludePatterns.map((p) => (
              <Badge key={p} variant="warning">
                {p}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-subtle">{labels.no_patterns}</span>
        )}
      </div>
    </div>
  );
}
