/**
 * TestRoutingPanel — Panel for testing which flow matches a sample document.
 *
 * Lets the user specify MIME type, file extension, file name, and size,
 * then calls the `testFlowSelection` API to see which flow would handle
 * the document.
 */

'use client';

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { X, CheckCircle, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { testFlowSelection } from '../../../../api/pipelines';
import type { PipelineDefinition, FlowSelectionResult } from '../../../../api/pipelines';

export interface TestRoutingPanelProps {
  open: boolean;
  onClose: () => void;
  definition: PipelineDefinition;
  projectId: string;
  knowledgeBaseId: string;
}

const COMMON_MIME_TYPES = [
  { value: 'application/pdf', label: 'application/pdf' },
  { value: 'text/html', label: 'text/html' },
  { value: 'text/plain', label: 'text/plain' },
  {
    value: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  { value: 'image/png', label: 'image/png' },
  { value: 'image/jpeg', label: 'image/jpeg' },
  { value: 'application/json', label: 'application/json' },
  { value: 'text/csv', label: 'text/csv' },
];

export function TestRoutingPanel({
  open,
  onClose,
  definition,
  projectId,
  knowledgeBaseId,
}: TestRoutingPanelProps) {
  const t = useTranslations('search_ai.pipeline');

  const [mimeType, setMimeType] = useState('application/pdf');
  const [extension, setExtension] = useState('pdf');
  const [size, setSize] = useState('1024');
  const [fileName, setFileName] = useState('document.pdf');
  const [isTesting, setIsTesting] = useState(false);
  const [result, setResult] = useState<FlowSelectionResult | null>(null);

  const mimeOptions = useMemo(() => COMMON_MIME_TYPES, []);

  const handleTest = useCallback(async () => {
    setIsTesting(true);
    setResult(null);
    try {
      const res = await testFlowSelection(projectId, knowledgeBaseId, definition._id, {
        extension,
        mimeType,
        size: parseInt(size, 10) || 0,
        name: fileName,
      });
      setResult(res);
    } catch (err: unknown) {
      setResult({
        success: false,
        error: err instanceof Error ? err.message : t('v2_test_routing_error'),
      });
    } finally {
      setIsTesting(false);
    }
  }, [projectId, knowledgeBaseId, definition._id, extension, mimeType, size, fileName]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute right-0 top-0 z-40 flex h-full w-[340px] flex-col border-l border-default bg-background-elevated shadow-xl"
          initial={{ x: 340, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 340, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-default px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">{t('v2_test_routing_title')}</h3>
            <button
              onClick={onClose}
              className="rounded-lg p-1 text-muted transition-default hover:bg-background-muted hover:text-foreground"
              aria-label={t('v2_test_routing_title')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {/* MIME type selector */}
            <Select
              label={t('v2_test_routing_mime')}
              options={mimeOptions}
              value={mimeType}
              onChange={setMimeType}
            />

            {/* File extension input */}
            <Input
              label={t('v2_test_routing_extension')}
              value={extension}
              onChange={(e) => setExtension(e.target.value)}
              placeholder="pdf"
            />

            {/* File name input */}
            <Input
              label={t('v2_test_routing_name')}
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="document.pdf"
            />

            {/* File size input */}
            <Input
              label={t('v2_test_routing_size')}
              value={size}
              onChange={(e) => setSize(e.target.value)}
              placeholder="1024"
              type="number"
            />

            {/* Test button */}
            <Button
              variant="primary"
              size="sm"
              onClick={handleTest}
              loading={isTesting}
              disabled={isTesting}
              className="w-full"
            >
              {isTesting ? t('v2_test_routing_testing') : t('v2_test_routing_test')}
            </Button>

            {/* Result */}
            {result !== null && (
              <div className="rounded-lg border border-default p-3">
                {result.success && result.selectedFlow ? (
                  <div className="flex items-start gap-2">
                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {t('v2_test_routing_result', { name: result.selectedFlow.name })}
                      </p>
                      {result.details && (
                        <p className="mt-1 text-xs text-muted">
                          {JSON.stringify(result.details, null, 2)}
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <p className="text-sm text-muted">{t('v2_test_routing_no_match')}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
