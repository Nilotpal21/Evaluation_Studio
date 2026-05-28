/**
 * FileUploadDialog Component
 *
 * Multi-file upload dialog with drag-and-drop, metadata fields (from upload hints),
 * inline source creation, and per-file upload progress tracking.
 */

import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import {
  Upload,
  FileText,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Info,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import useSWR from 'swr';
import { sanitizeError } from '@/lib/sanitize-error';
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILE_SIZE,
  getExtension,
  getDisplayType,
  formatBytes,
  getSourceDisplayName,
} from '@/lib/upload-constants';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import {
  uploadDocument,
  fetchUploadHints,
  addSource,
  fetchJsonSchemaPreview,
  saveJsonFieldConfig,
  type SearchAISource,
  type UploadFieldHint,
  type JsonSchemaPreviewResponse,
} from '../../../api/search-ai';
import { JsonFieldSelectionDialog } from './JsonFieldSelectionDialog';

// ─── Constants ─────────────────────────────────────────────────────────────────

const ACCEPT_STRING = ACCEPTED_EXTENSIONS.join(',');

const DEFAULT_FIELDS = ['author', 'category', 'tags', 'department'];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getInputType(fieldType: string): string {
  if (fieldType === 'date') return 'date';
  if (fieldType === 'float' || fieldType === 'integer') return 'number';
  return 'text';
}

// ─── Types ─────────────────────────────────────────────────────────────────────

type FileUploadStatus = 'pending' | 'uploading' | 'done' | 'error' | 'cancelled';

interface FileUploadDialogProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  /** Pre-selected source (from AddSourceButton flow or filter bar). Can be undefined. */
  sourceId?: string;
  sourceName?: string;
  /** All available sources — for source selector dropdown (filter to manual type) */
  sources: SearchAISource[];
  onUploadComplete?: () => void;
  /** Pre-populate with files from an external drop zone (e.g., SetupGuide) */
  initialFiles?: File[];
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function FileUploadDialog({
  open,
  onClose,
  indexId,
  sourceId,
  sourceName,
  sources,
  onUploadComplete,
  initialFiles,
}: FileUploadDialogProps) {
  const t = useTranslations('search_ai.upload');

  // ─── State ─────────────────────────────────────────────────────────────
  const [files, setFiles] = useState<File[]>([]);
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const [advancedJson, setAdvancedJson] = useState('');
  const [showMoreFields, setShowMoreFields] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, FileUploadStatus>>({});
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState(sourceId ?? '');
  const [creatingSource, setCreatingSource] = useState(false);
  const [newSourceName, setNewSourceName] = useState('');
  const [sourceSubmitting, setSourceSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [localSources, setLocalSources] = useState<SearchAISource[]>([]);
  const [jsonFieldDialogOpen, setJsonFieldDialogOpen] = useState(false);
  const [jsonPreviewData, setJsonPreviewData] = useState<JsonSchemaPreviewResponse | null>(null);
  const [jsonPreviewLoading, setJsonPreviewLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // ─── Reset on open/close ───────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setFiles(initialFiles && initialFiles.length > 0 ? initialFiles : []);
      setMetadata({});
      setAdvancedJson('');
      setShowMoreFields(false);
      setShowAdvanced(false);
      setUploadProgress({});
      setUploading(false);
      setFormError(null);
      // Don't reset selectedSourceId here if sourceId is undefined - let auto-select handle it
      if (sourceId) {
        setSelectedSourceId(sourceId);
      } else {
        setSelectedSourceId(''); // Will be auto-selected by useEffect below
      }
      setCreatingSource(false);
      setNewSourceName('');
      setLocalSources([]);
      abortControllerRef.current = null;
    } else {
      // Cleanup on close — abort any in-flight upload
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceId, initialFiles]);

  // ─── Derived ───────────────────────────────────────────────────────────
  const manualSources = useMemo(() => {
    // Include both 'manual' and 'file' source types — both support file uploads
    const fromProps = sources.filter((s) => s.sourceType === 'manual' || s.sourceType === 'file');
    const fromLocal = localSources.filter((ls) => !fromProps.some((ps) => ps._id === ls._id));
    return [...fromProps, ...fromLocal];
  }, [sources, localSources]);

  // ─── Auto-select (or auto-create) source when dialog opens ─────────────
  useEffect(() => {
    if (!open) return;

    // If sourceId is explicitly provided by parent, ensure it stays selected
    if (sourceId && !selectedSourceId) {
      setSelectedSourceId(sourceId);
      return;
    }

    // Already have a selection — nothing to do
    if (selectedSourceId) return;

    // Auto-select an existing manual source
    if (manualSources.length > 0) {
      const documentUploadSource =
        manualSources.find((s) => s.name === 'File Directory') ||
        manualSources.find((s) => s.name === 'Document Upload') ||
        manualSources.find((s) => s.name === 'Default') ||
        manualSources[0];

      if (documentUploadSource) {
        setSelectedSourceId(documentUploadSource._id);
      }
      return;
    }

    // No sources at all — eagerly create "File Directory" so the
    // dropdown is never empty when the user first sees it.
    if (!sourceId) {
      let cancelled = false;
      (async () => {
        try {
          const { source } = await addSource(indexId, {
            name: 'File Directory',
            sourceType: 'manual',
          });
          if (!cancelled) {
            setLocalSources((prev) => [...prev, source]);
            setSelectedSourceId(source._id);
          }
        } catch {
          // Non-fatal — user can still create a source manually via the dialog
        }
      })();
      return () => {
        cancelled = true;
      };
    }
  }, [open, sourceId, manualSources, selectedSourceId, indexId]);

  // ─── Upload Hints (SWR) ────────────────────────────────────────────────
  const { data: hintsData } = useSWR(open ? `upload-hints-${indexId}` : null, () =>
    fetchUploadHints(indexId),
  );

  const topFields = useMemo(() => {
    if (hintsData?.recentFields && hintsData.recentFields.length > 0) {
      return hintsData.recentFields;
    }
    return DEFAULT_FIELDS;
  }, [hintsData]);

  const remainingFields = useMemo(() => {
    if (!hintsData?.allFields) return [];
    const topSet = new Set(topFields);
    return hintsData.allFields.filter((f) => !topSet.has(f.storageField));
  }, [hintsData, topFields]);

  const fieldHintMap = useMemo(() => {
    const map: Record<string, UploadFieldHint> = {};
    if (hintsData?.allFields) {
      for (const f of hintsData.allFields) {
        map[f.storageField] = f;
      }
    }
    return map;
  }, [hintsData]);

  // ─── File Validation ───────────────────────────────────────────────────
  const validateAndAddFiles = useCallback(
    (incoming: FileList | File[]) => {
      const valid: File[] = [];
      for (const file of Array.from(incoming)) {
        const ext = getExtension(file.name);
        if (!ACCEPTED_EXTENSIONS.includes(ext)) {
          toast.error(t('error_unsupported_type', { name: file.name }));
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          toast.error(t('error_file_too_large', { name: file.name }));
          continue;
        }
        valid.push(file);
      }
      if (valid.length > 0) {
        setFiles((prev) => {
          // Deduplicate: same name + same size = duplicate
          const deduped: File[] = [];
          for (const file of valid) {
            const isDuplicate =
              prev.some((p) => p.name === file.name && p.size === file.size) ||
              deduped.some((d) => d.name === file.name && d.size === file.size);
            if (isDuplicate) {
              toast.warning(t('duplicate_file_warning', { name: file.name }));
            } else {
              deduped.push(file);
            }
          }
          return deduped.length > 0 ? [...prev, ...deduped] : prev;
        });
      }
    },
    [t],
  );

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ─── Resolve or create default source ──────────────────────────────────
  const resolveSourceId = useCallback(async (): Promise<string | null> => {
    if (selectedSourceId) return selectedSourceId;

    // Find an existing manual source to use as default
    const existing = manualSources[0];
    if (existing) {
      setSelectedSourceId(existing._id);
      return existing._id;
    }

    // Auto-create a "File Directory" source on first use
    try {
      const { source } = await addSource(indexId, {
        name: 'File Directory',
        sourceType: 'manual',
      });
      setLocalSources((prev) => [...prev, source]);
      setSelectedSourceId(source._id);
      return source._id;
    } catch (err: unknown) {
      setFormError(sanitizeError(err, t('error_source_create_failed')));
      return null;
    }
  }, [selectedSourceId, manualSources, indexId, t]);

  // ─── Per-file Retry ─────────────────────────────────────────────────
  const handleRetryFile = useCallback(
    async (fileIndex: number) => {
      // Chrome caches ERR_UPLOAD_FILE_CHANGED on the original File reference.
      // Re-selecting the file via a fresh file picker creates a new File object
      // that Chrome will read cleanly. Simply retrying with the stale reference
      // will always fail.
      const oldFile = files[fileIndex];
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = ACCEPT_STRING;
      input.onchange = async () => {
        const newFile = input.files?.[0];
        if (!newFile) return;

        // Replace the old file reference with the fresh one
        setFiles((prev) => prev.map((f, i) => (i === fileIndex ? newFile : f)));

        const targetSourceId = await resolveSourceId();
        if (!targetSourceId) return;

        setUploadProgress((prev) => ({ ...prev, [String(fileIndex)]: 'uploading' }));

        try {
          let finalMetadata: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(metadata)) {
            if (value.trim()) {
              finalMetadata[key] = value.trim();
            }
          }
          if (advancedJson.trim()) {
            try {
              finalMetadata = { ...finalMetadata, ...JSON.parse(advancedJson.trim()) };
            } catch {
              /* noop */
            }
          }
          const uploadResult = await uploadDocument(
            indexId,
            targetSourceId,
            newFile,
            Object.keys(finalMetadata).length > 0 ? finalMetadata : undefined,
          );
          setUploadProgress((prev) => ({ ...prev, [String(fileIndex)]: 'done' }));

          // Trigger field selection for JSON files
          if (
            uploadResult.status === 'pending_field_selection' &&
            newFile.name.toLowerCase().endsWith('.json')
          ) {
            setJsonPreviewLoading(true);
            try {
              const preview = await fetchJsonSchemaPreview(indexId, newFile);
              setJsonPreviewData(preview);
              setJsonFieldDialogOpen(true);
            } catch {
              // Non-fatal — field selection can be done later from the data tab
            } finally {
              setJsonPreviewLoading(false);
            }
          }
        } catch (err: unknown) {
          setUploadProgress((prev) => ({ ...prev, [String(fileIndex)]: 'error' }));
          const errMsg =
            err instanceof TypeError && String(err).includes('ERR_UPLOAD_FILE_CHANGED')
              ? t('error_file_changed', { name: newFile.name })
              : sanitizeError(err, t('error_upload_failed', { name: newFile.name }));
          toast.error(errMsg);
        }
      };
      input.click();
    },
    [files, resolveSourceId, metadata, advancedJson, indexId, t],
  );

  // ─── Drag & Drop ──────────────────────────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        validateAndAddFiles(e.dataTransfer.files);
      }
    },
    [validateAndAddFiles],
  );

  // ─── Source Creation ───────────────────────────────────────────────────
  const handleCreateSource = useCallback(async () => {
    const name = newSourceName.trim();
    if (!name) {
      toast.error(t('source_name_required'));
      return;
    }
    setSourceSubmitting(true);
    try {
      const { source } = await addSource(indexId, {
        name,
        sourceType: 'manual',
      });
      setLocalSources((prev) => [...prev, source]);
      setSelectedSourceId(source._id);
      setCreatingSource(false);
      setNewSourceName('');
      toast.success(t('toast_source_created', { name }));
    } catch (err: unknown) {
      toast.error(sanitizeError(err, t('error_source_create_failed')));
    } finally {
      setSourceSubmitting(false);
    }
  }, [indexId, newSourceName, t]);

  // ─── Metadata ──────────────────────────────────────────────────────────
  const updateMetadataField = useCallback((field: string, value: string) => {
    setMetadata((prev) => ({ ...prev, [field]: value }));
  }, []);

  // ─── Upload ────────────────────────────────────────────────────────────
  const handleUpload = useCallback(async () => {
    setFormError(null);

    if (files.length === 0) {
      setFormError(t('error_no_files'));
      return;
    }

    // Build metadata from structured fields + advanced JSON
    let finalMetadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (value.trim()) {
        finalMetadata[key] = value.trim();
      }
    }

    if (advancedJson.trim()) {
      try {
        const parsed = JSON.parse(advancedJson.trim());
        finalMetadata = { ...finalMetadata, ...parsed };
      } catch {
        setFormError(t('error_invalid_json'));
        return;
      }
    }

    setUploading(true);

    // Resolve or auto-create the target source
    const targetSourceId = await resolveSourceId();
    if (!targetSourceId) {
      setUploading(false);
      return;
    }

    // Create AbortController for this upload session
    const controller = new AbortController();
    abortControllerRef.current = controller;
    // Key progress by index to avoid collisions when multiple files share the same name
    const progress: Record<string, FileUploadStatus> = {};
    for (let i = 0; i < files.length; i++) {
      progress[String(i)] = 'pending';
    }
    setUploadProgress({ ...progress });

    let successCount = 0;
    let errorCount = 0;
    let cancelled = false;
    let needsFieldSelection = false;
    const jsonFilesNeedingSelection: File[] = [];

    for (let i = 0; i < files.length; i++) {
      // Check abort before starting each file
      if (controller.signal.aborted) {
        cancelled = true;
        // Mark remaining files as cancelled
        for (let j = i; j < files.length; j++) {
          progress[String(j)] = 'cancelled';
        }
        setUploadProgress({ ...progress });
        break;
      }

      const file = files[i];
      progress[String(i)] = 'uploading';
      setUploadProgress({ ...progress });

      try {
        const uploadResult = await uploadDocument(
          indexId,
          targetSourceId,
          file,
          Object.keys(finalMetadata).length > 0 ? finalMetadata : undefined,
          controller.signal,
        );
        progress[String(i)] = 'done';
        successCount++;

        // If a JSON file was paused for field selection, trigger the field selection dialog
        if (
          uploadResult.status === 'pending_field_selection' &&
          file.name.toLowerCase().endsWith('.json')
        ) {
          needsFieldSelection = true;
          jsonFilesNeedingSelection.push(file);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          cancelled = true;
          progress[String(i)] = 'cancelled';
          // Mark remaining files as cancelled
          for (let j = i + 1; j < files.length; j++) {
            progress[String(j)] = 'cancelled';
          }
          setUploadProgress({ ...progress });
          break;
        }
        progress[String(i)] = 'error';
        errorCount++;
        // Chrome throws ERR_UPLOAD_FILE_CHANGED when the file is modified after
        // being selected in the file picker (macOS xattr updates, antivirus scans,
        // Spotlight indexing). Provide a clear message to re-select the file.
        const errMsg =
          err instanceof TypeError && String(err).includes('ERR_UPLOAD_FILE_CHANGED')
            ? t('error_file_changed', { name: file.name })
            : sanitizeError(err, t('error_upload_failed', { name: file.name }));
        toast.error(errMsg);
      }
      setUploadProgress({ ...progress });
    }

    setUploading(false);
    abortControllerRef.current = null;

    if (cancelled) {
      toast.info(t('upload_cancelled', { uploaded: successCount, total: files.length }));
      if (successCount > 0) {
        onUploadComplete?.();
      }
    } else if (needsFieldSelection && jsonFilesNeedingSelection.length > 0) {
      // Use the first JSON file for the field selection dialog.
      // Once fields are configured, all pending JSON files will be processed.
      const jsonFile = jsonFilesNeedingSelection[0];
      setJsonPreviewLoading(true);
      try {
        const preview = await fetchJsonSchemaPreview(indexId, jsonFile);

        if (preview.allFieldsKnown && preview.existingConfig) {
          // All fields match existing config — auto-save to trigger processing,
          // then show the dialog so the user can review the auto-populated fields.
          const existingFields = preview.existingConfig.fields;

          await saveJsonFieldConfig(indexId, {
            fields: existingFields.map((f) => ({
              fieldPath: f.fieldPath,
              fieldType: f.fieldType,
              selected: f.selected,
              sampleValues: f.sampleValues,
            })),
            autoSuggestApplied: preview.existingConfig.autoSuggestApplied,
          });

          // Always show the field selection dialog so the user sees what was configured
          setJsonPreviewData(preview);
          setJsonFieldDialogOpen(true);
          onUploadComplete?.();

          toast.success(
            t('toast_auto_proceed', { count: existingFields.filter((f) => f.selected).length }),
          );
        } else {
          // New fields detected or no existing config — show dialog
          setJsonPreviewData(preview);
          setJsonFieldDialogOpen(true);
        }
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('error_schema_preview_failed')));
      } finally {
        setJsonPreviewLoading(false);
      }
    } else if (errorCount === 0) {
      toast.success(t('toast_upload_success', { count: successCount }));
      onUploadComplete?.();
      onClose();
    }
    // On partial success (with errors, not cancel), keep dialog open for retry
  }, [resolveSourceId, files, metadata, advancedJson, indexId, t, onUploadComplete, onClose]);

  const handleCancelUpload = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  // ─── Render: Source Selector ───────────────────────────────────────────
  const renderSourceSelector = () => (
    <div className="space-y-2">
      <label htmlFor="upload-source-select" className="block text-sm font-medium text-foreground">
        {t('source_label')}
      </label>
      {creatingSource ? (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Input
              label={t('source_name_label')}
              value={newSourceName}
              onChange={(e) => setNewSourceName(e.target.value)}
              placeholder={t('source_name_placeholder')}
            />
          </div>
          <Button
            size="sm"
            onClick={handleCreateSource}
            loading={sourceSubmitting}
            disabled={sourceSubmitting}
          >
            {t('source_create')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setCreatingSource(false);
              setNewSourceName('');
            }}
          >
            {t('source_create_cancel')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {/* Native <select> used intentionally — Radix Select triggers DOM listener
              issues in happy-dom test environments (vitest). */}
          <select
            id="upload-source-select"
            value={selectedSourceId}
            onChange={(e) => setSelectedSourceId(e.target.value)}
            className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
          >
            <option value="">{t('source_select_placeholder')}</option>
            {/* Show the parent-provided source even if not yet in the sources list
                (it was just created and SWR hasn't revalidated yet) */}
            {sourceId && sourceName && !manualSources.some((s) => s._id === sourceId) && (
              <option key={sourceId} value={sourceId}>
                {getSourceDisplayName(sourceName)}
              </option>
            )}
            {manualSources.map((s) => (
              <option key={s._id} value={s._id}>
                {getSourceDisplayName(s.name)}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={() => setCreatingSource(true)}
          >
            {t('source_create_new')}
          </Button>
        </div>
      )}
    </div>
  );

  // ─── Render: Dropzone ──────────────────────────────────────────────────
  const renderDropzone = () => (
    <div
      role="button"
      tabIndex={0}
      aria-label={t('aria_dropzone')}
      className={`flex flex-col items-center justify-center gap-2 p-8 rounded-xl border-2 border-dashed cursor-pointer transition-default ${
        dragOver
          ? 'border-border-focus bg-accent/5'
          : 'border-default hover:border-border-focus hover:bg-background-subtle'
      }`}
      onClick={() => fileInputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fileInputRef.current?.click();
        }
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Upload className="w-8 h-8 text-muted" />
      <p className="text-sm text-foreground font-medium">{t('dropzone_label')}</p>
      <p className="text-xs text-muted">{t('dropzone_formats')}</p>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPT_STRING}
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            validateAndAddFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />
    </div>
  );

  // ─── Render: File List ─────────────────────────────────────────────────
  const renderFileList = () => {
    if (files.length === 0) return null;

    return (
      <div className="space-y-1.5">
        {files.map((file, index) => {
          const status = uploadProgress[String(index)];
          return (
            <div
              key={`${file.name}-${index}`}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-background-subtle border border-default text-sm"
            >
              <FileText className="w-4 h-4 text-muted shrink-0" />
              <span className="flex-1 truncate text-foreground">{file.name}</span>
              <span className="text-xs text-muted">{formatBytes(file.size)}</span>
              {status && (
                <span
                  className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                    status === 'done'
                      ? 'bg-success/10 text-success'
                      : status === 'error'
                        ? 'bg-error/10 text-error'
                        : status === 'uploading'
                          ? 'bg-accent/10 text-accent'
                          : status === 'cancelled'
                            ? 'bg-warning/10 text-warning'
                            : 'bg-background-muted text-muted'
                  }`}
                >
                  {t(`progress_${status}`)}
                </span>
              )}
              {uploadProgress[String(index)] === 'error' && (
                <button
                  type="button"
                  onClick={() => handleRetryFile(index)}
                  className="p-1 text-accent hover:text-foreground transition-default rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                  aria-label={t('retry_upload')}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
              {!uploading && (
                <button
                  type="button"
                  aria-label={t('aria_remove_file', { name: file.name })}
                  onClick={() => removeFile(index)}
                  className="p-0.5 text-muted hover:text-foreground transition-default rounded"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // ─── Render: Auto-detected Info ────────────────────────────────────────
  const renderAutoDetected = () => {
    if (files.length === 0) return null;
    const first = files[0];
    const nameWithoutExt = first.name.replace(/\.[^/.]+$/, '');

    return (
      <div className="rounded-lg bg-background-subtle border border-default p-3 text-sm space-y-1">
        <p className="font-medium text-foreground">{t('auto_detected')}</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted">
          <span>
            {t('auto_title')}: {nameWithoutExt}
          </span>
          <span>
            {t('auto_type')}: {getDisplayType(first.name)}
          </span>
          <span>
            {t('auto_size')}: {formatBytes(first.size)}
          </span>
          {files.length > 1 && (
            <span>
              {t('auto_files')}: {files.length}
            </span>
          )}
        </div>
      </div>
    );
  };

  // ─── Render: Metadata Field ────────────────────────────────────────────
  const renderMetadataField = (fieldName: string) => {
    const hint = fieldHintMap[fieldName];
    const inputType = hint ? getInputType(hint.type) : 'text';
    const label = hint?.label ?? fieldName;
    const placeholder = hintsData?.lastValues?.[fieldName] ?? '';

    return (
      <Input
        key={fieldName}
        label={label}
        type={inputType}
        value={metadata[fieldName] ?? ''}
        onChange={(e) => updateMetadataField(fieldName, e.target.value)}
        placeholder={placeholder}
      />
    );
  };

  // ─── Render: Metadata Section ──────────────────────────────────────────
  const renderMetadataSection = () => {
    // Split fields into categories for better UX
    const essentialFields = DEFAULT_FIELDS; // Always show these
    const essentialSet = new Set(essentialFields);

    // Recently used fields that aren't in essential
    const recentFields = (hintsData?.recentFields || []).filter((f) => !essentialSet.has(f));

    // All other fields (not essential, not recent)
    const otherFields = remainingFields.filter(
      (f) => !essentialSet.has(f.storageField) && !recentFields.includes(f.storageField),
    );

    return (
      <div className="space-y-4">
        {/* Essential Fields (Always Shown) */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h4 className="text-sm font-medium text-foreground">
              {t('section_essential_fields') || 'Essential Fields'}
            </h4>
            <span className="text-xs text-muted">
              {t('section_essential_hint') || '(Most commonly used)'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">{essentialFields.map(renderMetadataField)}</div>
        </div>

        {/* Recently Used Fields (If Any) */}
        {recentFields.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <h4 className="text-sm font-medium text-foreground">
                {t('section_recently_used') || 'Recently Used'}
              </h4>
              <span className="text-xs text-muted">
                {t('section_recent_hint') || '(From your last upload)'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">{recentFields.map(renderMetadataField)}</div>
          </div>
        )}

        {/* More Fields Collapsible */}
        {otherFields.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowMoreFields((v) => !v)}
              className="flex items-center gap-1 text-sm text-accent hover:text-foreground transition-default font-medium"
            >
              {showMoreFields ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              {t('section_more_fields', { count: otherFields.length }) ||
                `+ Add More Fields (${otherFields.length} available)`}
            </button>
            {showMoreFields && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                {otherFields.map((f) => renderMetadataField(f.storageField))}
              </div>
            )}
          </div>
        )}

        {/* Advanced JSON Collapsible */}
        <div className="pt-2 border-t border-default">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1 text-sm text-muted hover:text-foreground transition-default"
          >
            {showAdvanced ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            {t('section_advanced') || 'Advanced (Custom Fields JSON)'}
          </button>
          {showAdvanced && (
            <div className="mt-2">
              <p className="text-xs text-muted mb-2">
                {t('section_advanced_hint') ||
                  'Add custom fields as JSON. Example: {"custom_string_1": "value"}'}
              </p>
              <textarea
                aria-label={t('section_advanced')}
                value={advancedJson}
                onChange={(e) => setAdvancedJson(e.target.value)}
                rows={4}
                placeholder='{"custom_string_1": "value", "custom_number_1": 42}'
                className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-sm py-2 px-3 font-mono"
              />
            </div>
          )}
        </div>
      </div>
    );
  };

  // ─── Dialog Title ──────────────────────────────────────────────────────
  const dialogTitle = sourceName
    ? t('dialog_title_existing', { sourceName: getSourceDisplayName(sourceName) })
    : t('dialog_title');

  const canUpload = files.length > 0 && !uploading && !jsonPreviewLoading;

  return (
    <Dialog open={open} onClose={onClose} title={dialogTitle} maxWidth="2xl">
      <div className="space-y-5">
        {/* Source Selector */}
        {renderSourceSelector()}

        {/* Dropzone */}
        {renderDropzone()}

        {/* File List */}
        {renderFileList()}

        {/* Auto-detected Info */}
        {renderAutoDetected()}

        {/* Info Note about Metadata */}
        <div className="flex items-start gap-2 rounded-lg bg-accent/5 border border-accent/20 p-3">
          <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
          <p className="text-xs text-muted">
            {t('metadata_info_note') ||
              'Fields you fill below will be searchable. Only filled fields create vocabulary entries for natural language queries.'}
          </p>
        </div>

        {/* Metadata Fields (always shown) */}
        {renderMetadataSection()}

        {/* Form Error */}
        {formError && <p className="text-sm text-error">{formError}</p>}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={uploading ? handleCancelUpload : onClose}>
            {t('button_cancel')}
          </Button>
          <Button
            size="sm"
            onClick={handleUpload}
            loading={uploading}
            disabled={!canUpload}
            icon={<Upload className="w-3.5 h-3.5" />}
          >
            {files.length > 0
              ? t('button_upload_count', { count: files.length })
              : t('button_upload')}
          </Button>
        </div>
      </div>

      {/* JSON Field Selection Dialog — shown after JSON upload when no config exists */}
      {jsonPreviewData && (
        <JsonFieldSelectionDialog
          open={jsonFieldDialogOpen}
          onClose={() => {
            setJsonFieldDialogOpen(false);
            setJsonPreviewData(null);
            // Still close upload dialog and notify — docs are uploaded but pending
            onUploadComplete?.();
            onClose();
          }}
          indexId={indexId}
          previewData={jsonPreviewData}
          onSaved={() => {
            setJsonFieldDialogOpen(false);
            setJsonPreviewData(null);
            onUploadComplete?.();
            onClose();
          }}
        />
      )}
    </Dialog>
  );
}
