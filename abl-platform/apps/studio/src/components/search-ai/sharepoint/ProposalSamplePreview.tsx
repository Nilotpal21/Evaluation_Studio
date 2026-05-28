'use client';

/**
 * ProposalSamplePreview
 *
 * Displays a sample of documents that will be synced based on current filters.
 * Shows document count, total estimate, and a table of sample documents.
 */

import { FileText } from 'lucide-react';

interface SampleDocument {
  name?: string;
  type?: string;
  sizeBytes?: number;
}

interface ProposalSamplePreviewProps {
  sampleDocuments: SampleDocument[];
  sampleCount: number;
  totalEstimate: number;
  labels: {
    sample_title: string;
    total_estimate: string;
    no_samples: string;
    col_name: string;
    col_type: string;
    col_size: string;
  };
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function ProposalSamplePreview({
  sampleDocuments,
  sampleCount,
  totalEstimate,
  labels,
}: ProposalSamplePreviewProps) {
  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-accent flex-shrink-0" />
          <span className="text-sm text-muted">{labels.sample_title}:</span>
          <span className="text-sm font-medium text-foreground">{sampleCount}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">{labels.total_estimate}:</span>
          <span className="text-sm font-medium text-foreground">{totalEstimate}</span>
        </div>
      </div>

      {/* Sample table */}
      {sampleDocuments.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-default">
                <th className="text-left py-2 px-3 text-xs font-medium text-muted">
                  {labels.col_name}
                </th>
                <th className="text-left py-2 px-3 text-xs font-medium text-muted">
                  {labels.col_type}
                </th>
                <th className="text-right py-2 px-3 text-xs font-medium text-muted">
                  {labels.col_size}
                </th>
              </tr>
            </thead>
            <tbody>
              {sampleDocuments.map((doc, idx) => (
                <tr key={idx} className="border-b border-default last:border-b-0">
                  <td className="py-2 px-3 text-foreground">{doc.name ?? '-'}</td>
                  <td className="py-2 px-3 text-muted">{doc.type ?? '-'}</td>
                  <td className="py-2 px-3 text-muted text-right">
                    {doc.sizeBytes !== undefined ? formatFileSize(doc.sizeBytes) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted">{labels.no_samples}</p>
      )}
    </div>
  );
}
