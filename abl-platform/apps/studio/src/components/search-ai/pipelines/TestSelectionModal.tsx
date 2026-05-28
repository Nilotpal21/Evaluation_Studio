/**
 * Test Selection Modal
 *
 * Allows users to test which flow would be selected for a given document.
 * Uses the POST /test-selection API endpoint.
 *
 * Reference: docs/searchai/pipelines/design/frontend/UX-PIPELINE-CONFIGURATION.md
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePipelineStore } from '../../../store/pipeline-store';
import { testFlowSelection, type FlowSelectionResult } from '../../../api/pipelines';

const SAMPLE_DOCUMENTS = [
  { name: 'report.pdf', extension: 'pdf', mimeType: 'application/pdf', size: 5_242_880 },
  {
    name: 'data.xlsx',
    extension: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 1_048_576,
  },
  {
    name: 'presentation.pptx',
    extension: 'pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 3_145_728,
  },
  { name: 'readme.md', extension: 'md', mimeType: 'text/markdown', size: 4_096 },
  { name: 'page.html', extension: 'html', mimeType: 'text/html', size: 32_768 },
  { name: 'image.png', extension: 'png', mimeType: 'image/png', size: 2_097_152 },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function TestSelectionModal() {
  const { draft, projectId, knowledgeBaseId, closeTestSelection } = usePipelineStore();
  const t = useTranslations('search_ai.pipeline');

  const [selectedSample, setSelectedSample] = useState(0);
  const [customDoc, setCustomDoc] = useState({
    name: '',
    extension: '',
    mimeType: '',
    size: 0,
  });
  const [useCustom, setUseCustom] = useState(false);
  const [result, setResult] = useState<FlowSelectionResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!draft || !projectId || !knowledgeBaseId) return null;

  const handleTest = async () => {
    const doc = useCustom ? customDoc : SAMPLE_DOCUMENTS[selectedSample];
    setTesting(true);
    setError(null);
    setResult(null);

    try {
      const res = await testFlowSelection(projectId, knowledgeBaseId, draft._id, doc);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('test_failed'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-overlay backdrop-blur-sm" onClick={closeTestSelection} />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-background border border-default rounded-lg shadow-xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-default">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-foreground">{t('test_title')}</h3>
            <button
              className="p-1 text-muted hover:text-foreground rounded"
              onClick={closeTestSelection}
            >
              ✕
            </button>
          </div>
          <p className="text-xs text-muted mt-1">{t('test_description')}</p>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Mode toggle */}
          <div className="flex gap-1 p-0.5 bg-background-muted rounded-md w-fit">
            <button
              className={`px-3 py-1 text-xs rounded ${!useCustom ? 'bg-background-elevated text-foreground shadow-sm' : 'text-muted'}`}
              onClick={() => setUseCustom(false)}
            >
              {t('test_mode_samples')}
            </button>
            <button
              className={`px-3 py-1 text-xs rounded ${useCustom ? 'bg-background-elevated text-foreground shadow-sm' : 'text-muted'}`}
              onClick={() => setUseCustom(true)}
            >
              {t('test_mode_custom')}
            </button>
          </div>

          {!useCustom ? (
            /* Sample documents */
            <div className="space-y-1">
              {SAMPLE_DOCUMENTS.map((doc, i) => (
                <button
                  key={i}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm ${
                    selectedSample === i
                      ? 'bg-background-elevated border border-foreground/20'
                      : 'hover:bg-background-muted border border-transparent'
                  }`}
                  onClick={() => setSelectedSample(i)}
                >
                  <span className="font-medium text-foreground">{doc.name}</span>
                  <span className="text-xs text-muted ml-2">
                    ({formatSize(doc.size)}, {doc.mimeType})
                  </span>
                </button>
              ))}
            </div>
          ) : (
            /* Custom document */
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-muted mb-1">{t('test_custom_name')}</label>
                <input
                  type="text"
                  value={customDoc.name}
                  onChange={(e) => setCustomDoc({ ...customDoc, name: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-default rounded bg-background-elevated text-foreground"
                  placeholder="document.pdf"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-muted mb-1">
                    {t('test_custom_extension')}
                  </label>
                  <input
                    type="text"
                    value={customDoc.extension}
                    onChange={(e) => setCustomDoc({ ...customDoc, extension: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-default rounded bg-background-elevated text-foreground"
                    placeholder="pdf"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">{t('test_custom_size')}</label>
                  <input
                    type="number"
                    value={customDoc.size}
                    onChange={(e) =>
                      setCustomDoc({ ...customDoc, size: parseInt(e.target.value, 10) || 0 })
                    }
                    className="w-full px-2 py-1.5 text-sm border border-default rounded bg-background-elevated text-foreground"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">{t('test_custom_mime')}</label>
                <input
                  type="text"
                  value={customDoc.mimeType}
                  onChange={(e) => setCustomDoc({ ...customDoc, mimeType: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border border-default rounded bg-background-elevated text-foreground"
                  placeholder="application/pdf"
                />
              </div>
            </div>
          )}

          {/* Result */}
          {result && (
            <div
              className={`p-3 rounded-md border ${
                result.success ? 'bg-success-subtle border-success' : 'bg-error-subtle border-error'
              }`}
            >
              {result.success && result.selectedFlow ? (
                <>
                  <p className="text-sm font-medium text-success">
                    {t('test_match', { name: result.selectedFlow.name })}
                  </p>
                  <p className="text-xs text-success/80 mt-0.5">
                    {t('test_match_details', {
                      stages: result.selectedFlow.stages.length,
                      priority: result.selectedFlow.priority,
                    })}
                  </p>
                </>
              ) : (
                <p className="text-sm font-medium text-error">
                  {t('test_no_match')}
                  {result.error && `: ${result.error}`}
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="p-3 rounded-md bg-error-subtle border border-error">
              <p className="text-sm text-error">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-default flex justify-end gap-2">
          <button
            className="px-4 py-2 text-sm text-muted hover:text-foreground"
            onClick={closeTestSelection}
          >
            {t('test_close')}
          </button>
          <button
            className="px-4 py-2 text-sm bg-foreground text-background rounded-md hover:opacity-90 disabled:opacity-50"
            onClick={handleTest}
            disabled={testing}
          >
            {testing ? t('test_testing') : t('test_run')}
          </button>
        </div>
      </div>
    </div>
  );
}
