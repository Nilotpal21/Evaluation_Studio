/**
 * TemplateUploadDialog Component
 *
 * Multi-step dialog for uploading a project export zip to create a new template.
 * Steps: upload -> validating -> metadata -> success
 *
 * Follows the ImportDialog pattern for zip extraction with fflate.
 */

import { useState, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import clsx from 'clsx';
import { Upload, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';

// =============================================================================
// CONSTANTS
// =============================================================================

// Client-side limits — aligned with template-store server validation
const MAX_ZIP_SIZE = 4 * 1024 * 1024; // 4MB compressed input
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB per file
const MAX_FILE_COUNT = 500;
const MAX_DECOMPRESSED_SIZE = 4 * 1024 * 1024; // 4MB total decompressed

const COMPLEXITY_OPTIONS = [
  { value: 'starter', label: 'Starter' },
  { value: 'standard', label: 'Standard' },
  { value: 'advanced', label: 'Advanced' },
];

const CATEGORY_OPTIONS = [
  { value: 'general', label: 'General' },
  { value: 'customer-service', label: 'Customer Service' },
  { value: 'sales', label: 'Sales' },
  { value: 'operations', label: 'Operations' },
  { value: 'hr', label: 'Human Resources' },
  { value: 'finance', label: 'Finance' },
  { value: 'healthcare', label: 'Healthcare' },
  { value: 'education', label: 'Education' },
  { value: 'other', label: 'Other' },
];

// =============================================================================
// TYPES
// =============================================================================

type Step = 'upload' | 'validating' | 'metadata' | 'success';

interface UploadResult {
  id: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  category: string;
  tags: string[];
  complexity: string;
  type: string;
}

interface TemplateUploadDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TemplateUploadDialog({ open, onClose, onSuccess }: TemplateUploadDialogProps) {
  const t = useTranslations('admin');
  const [step, setStep] = useState<Step>('upload');
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Template data from upload response
  const [templateData, setTemplateData] = useState<UploadResult | null>(null);

  // Editable metadata
  const [name, setName] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [longDescription, setLongDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [tags, setTags] = useState('');
  const [complexity, setComplexity] = useState('standard');

  // ---------------------------------------------------------------------------
  // RESET
  // ---------------------------------------------------------------------------

  const reset = useCallback(() => {
    setStep('upload');
    setDragging(false);
    setLoading(false);
    setError(null);
    setTemplateData(null);
    setName('');
    setShortDescription('');
    setLongDescription('');
    setCategory('general');
    setTags('');
    setComplexity('standard');
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const handleClose = () => {
    reset();
    onClose();
  };

  // ---------------------------------------------------------------------------
  // ZIP EXTRACTION + UPLOAD
  // ---------------------------------------------------------------------------

  /**
   * Sanitize a ZIP entry path: strip path traversal sequences and leading slashes.
   * Returns null if the path is unsafe after sanitization.
   */
  const sanitizePath = (entryPath: string): string | null => {
    if (entryPath.includes('\0')) return null;
    let safe = entryPath.replace(/\\/g, '/');
    safe = safe.replace(/^(\.\/|\/)+/, '');
    if (safe.includes('..')) return null;
    if (!safe || safe.endsWith('/')) return null;
    return safe;
  };

  const stripCommonPrefix = (paths: string[]): Record<string, string> => {
    if (paths.length === 0) return {};

    // Find common prefix among all directory components
    const splits = paths.map((p) => p.split('/'));
    let prefixLen = 0;
    if (splits.length > 1 && splits[0] !== undefined) {
      outer: for (let i = 0; i < splits[0].length - 1; i++) {
        const segment = splits[0][i];
        for (let j = 1; j < splits.length; j++) {
          if (splits[j]?.[i] !== segment) break outer;
        }
        prefixLen = i + 1;
      }
    } else if (splits.length === 1 && (splits[0]?.length ?? 0) > 1) {
      // Single file with directory — strip prefix dir
      prefixLen = (splits[0]?.length ?? 1) - 1;
    }

    const mapping: Record<string, string> = {};
    for (const path of paths) {
      const parts = path.split('/');
      mapping[path] = parts.slice(prefixLen).join('/');
    }
    return mapping;
  };

  const handleFiles = async (fileList: FileList) => {
    if (fileList.length === 0) return;

    const file = fileList[0];
    if (!file || !file.name.endsWith('.zip')) {
      toast.error(t('template_manager.dropzone'));
      return;
    }

    if (file.size > MAX_ZIP_SIZE) {
      toast.error(t('template_manager.fileTooLarge'));
      return;
    }

    setStep('validating');
    setLoading(true);
    setError(null);

    try {
      // Extract zip with fflate
      const { unzip, strFromU8 } = await import('fflate');
      const zipData = new Uint8Array(await file.arrayBuffer());
      const extracted = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
        unzip(
          zipData,
          {
            filter: (f) =>
              !f.name.endsWith('/') &&
              ['.abl', '.json', '.yaml', '.yml', '.txt', '.md'].some((ext) => f.name.endsWith(ext)),
          },
          (err, result) => (err ? reject(err) : resolve(result)),
        );
      });

      // Validate
      const entries = Object.entries(extracted);
      if (entries.length > MAX_FILE_COUNT) {
        throw new Error(`Too many files (max ${MAX_FILE_COUNT})`);
      }

      const parsed: Record<string, string> = {};
      let totalDecompressed = 0;

      for (const [entryPath, data] of entries) {
        const safePath = sanitizePath(entryPath);
        if (!safePath) continue;
        if (data.byteLength > MAX_FILE_SIZE) continue;

        totalDecompressed += data.byteLength;
        if (totalDecompressed > MAX_DECOMPRESSED_SIZE) {
          throw new Error('Total decompressed size exceeds 4MB');
        }

        parsed[safePath] = strFromU8(data);
      }

      if (Object.keys(parsed).length === 0) {
        throw new Error('No valid files found in archive');
      }

      // Strip common path prefix
      const pathMapping = stripCommonPrefix(Object.keys(parsed));
      const normalizedFiles: Record<string, string> = {};
      for (const [originalPath, content] of Object.entries(parsed)) {
        const mappedPath = pathMapping[originalPath];
        if (mappedPath) {
          normalizedFiles[mappedPath] = content;
        }
      }

      // Send to template-store API
      const res = await apiFetch('/api/template-store/admin/templates/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: normalizedFiles }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? body.error ?? 'Upload failed');
      }

      const result = await res.json();
      const envelope = result.data ?? result;
      // The upload API returns { template, version, extracted, warnings }
      // Template fields are nested under `template`, with `_id` as the ID field
      const tpl = envelope.template ?? envelope;

      // Populate editable fields from server response
      setTemplateData({
        id: tpl._id ?? tpl.id ?? '',
        name: tpl.name ?? '',
        shortDescription: tpl.shortDescription ?? '',
        longDescription: tpl.longDescription ?? '',
        category: tpl.category ?? 'general',
        tags: Array.isArray(tpl.tags) ? tpl.tags : [],
        complexity: tpl.complexity ?? 'standard',
        type: tpl.type ?? 'agent',
      });
      setName(tpl.name ?? '');
      setShortDescription(tpl.shortDescription ?? '');
      setLongDescription(tpl.longDescription ?? '');
      setCategory(tpl.category ?? 'general');
      setTags(Array.isArray(tpl.tags) ? tpl.tags.join(', ') : '');
      setComplexity(tpl.complexity ?? 'standard');
      setStep('metadata');
    } catch (err) {
      setError(sanitizeError(err, 'Failed to process template'));
      setStep('upload');
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // METADATA UPDATE
  // ---------------------------------------------------------------------------

  const handleSubmitMetadata = async () => {
    if (!templateData?.id) return;

    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(`/api/template-store/admin/templates/${templateData.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          shortDescription: shortDescription.trim(),
          longDescription: longDescription.trim(),
          category,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          complexity,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? body.error ?? 'Failed to update template');
      }

      setStep('success');
    } catch (err) {
      setError(sanitizeError(err, 'Failed to update template'));
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // DRAG + DROP
  // ---------------------------------------------------------------------------

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      void handleFiles(e.dataTransfer.files);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void handleFiles(e.target.files);
    }
  };

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('template_manager.uploadTitle')}
      maxWidth="lg"
    >
      {/* Upload step */}
      {step === 'upload' && (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('template_manager.uploadDescription')}</p>

          {error && (
            <div className="rounded-lg border border-error/30 bg-error-subtle/30 p-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-error shrink-0" />
                <span className="text-sm text-error">{error}</span>
              </div>
            </div>
          )}

          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={clsx(
              'flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 cursor-pointer transition-default',
              dragging
                ? 'border-accent bg-accent-subtle/30'
                : 'border-default hover:border-accent/50 hover:bg-background-muted',
            )}
          >
            <Upload className="w-8 h-8 text-muted mb-3" />
            <p className="text-sm font-medium text-foreground">
              {dragging ? t('template_manager.dropzoneActive') : t('template_manager.dropzone')}
            </p>
            <p className="text-xs text-muted mt-1">{t('template_manager.dropzoneHint')}</p>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={handleInputChange}
          />

          <div className="flex justify-end">
            <Button variant="ghost" onClick={handleClose}>
              {t('template_manager.cancel')}
            </Button>
          </div>
        </div>
      )}

      {/* Validating step */}
      {step === 'validating' && (
        <div className="flex flex-col items-center justify-center py-10 space-y-3">
          <Loader2 className="w-8 h-8 text-muted animate-spin" />
          <p className="text-sm text-muted">{t('template_manager.validating')}</p>
        </div>
      )}

      {/* Metadata step */}
      {step === 'metadata' && (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('template_manager.metadataDescription')}</p>

          {error && (
            <div className="rounded-lg border border-error/30 bg-error-subtle/30 p-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-error shrink-0" />
                <span className="text-sm text-error">{error}</span>
              </div>
            </div>
          )}

          <Input
            label={t('template_manager.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />

          <Input
            label={t('template_manager.shortDescription')}
            value={shortDescription}
            onChange={(e) => setShortDescription(e.target.value)}
          />

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('template_manager.longDescription')}
            </label>
            <textarea
              value={longDescription}
              onChange={(e) => setLongDescription(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-default bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-default resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Select
              label={t('template_manager.category')}
              options={CATEGORY_OPTIONS}
              value={category}
              onChange={setCategory}
            />
            <Select
              label={t('template_manager.complexity')}
              options={COMPLEXITY_OPTIONS}
              value={complexity}
              onChange={setComplexity}
            />
          </div>

          <Input
            label={t('template_manager.tags')}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t('template_manager.tagsPlaceholder')}
          />

          <div className="flex justify-between pt-2">
            <Button variant="ghost" onClick={() => setStep('upload')}>
              {t('template_manager.back')}
            </Button>
            <Button
              variant="primary"
              loading={loading}
              disabled={!name.trim()}
              onClick={handleSubmitMetadata}
            >
              {t('template_manager.submit')}
            </Button>
          </div>
        </div>
      )}

      {/* Success step */}
      {step === 'success' && (
        <div className="space-y-5 text-center py-4">
          <div className="flex justify-center">
            <div className="w-12 h-12 rounded-full bg-success-subtle flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-success" />
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{t('template_manager.success')}</p>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              reset();
              onSuccess();
            }}
          >
            {t('template_manager.done')}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
