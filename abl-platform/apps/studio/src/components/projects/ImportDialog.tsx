/**
 * ImportDialog Component
 *
 * Upload .zip, .agent-bundle.json, or .abl files, preview changes, and apply import.
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AppError } from '@agent-platform/shared/errors';
import { sanitizeError, sanitizeServerError } from '@/lib/sanitize-error';
import clsx from 'clsx';
import {
  Upload,
  FileUp,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Plus,
  Pencil,
  Minus,
  FileText,
  ChevronDown,
  Shield,
} from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Checkbox } from '../ui/Checkbox';
import {
  fetchImportPreview,
  applyImport,
  fetchImportStatus,
  type ImportContractError,
  type ImportBindingResolutionInput,
  type ImportOperationStatusData,
  type ImportPreviewResponse,
} from '../../api/project-io';
import { loadProjects } from '../../api/projects';
import { useKnowledgeBases } from '../../hooks/useKnowledgeBases';
import { useWorkflows } from '../../hooks/useWorkflows';
import { listWorkflowTriggers, type WorkflowTrigger } from '../../api/workflows';

// Client-side limits — aligned with server-side validation
const MAX_DECOMPRESSED_SIZE = 50 * 1024 * 1024; // 50MB total decompressed
const MAX_FILE_SIZE = 1024 * 1024; // 1MB per file
const MAX_FILE_COUNT = 500;
const MAX_ZIP_SIZE = 100 * 1024 * 1024; // 100MB compressed input
const MAX_COMPRESSION_RATIO = 1000; // reject if decompressed/compressed > 1000:1

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onImported?: () => void;
}

type Step = 'upload' | 'preview' | 'result';

interface DisplayImportError {
  code: string | null;
  message: string;
  stage: string | null;
  sanitizedCause: string | null;
  operationId: string | null;
  operationStatus: DisplayImportOperationStatus | null;
}

interface DisplayImportOperationStatus {
  status: string;
  layers: Array<{ name: string; status: string }>;
}

function normalizeImportContractError(
  error: ImportContractError | string | null | undefined,
  fallback: string,
  operationId?: string | null,
): DisplayImportError | null {
  if (!error) {
    return null;
  }

  if (typeof error === 'string') {
    return {
      code: null,
      message: sanitizeServerError(error, fallback),
      stage: null,
      sanitizedCause: null,
      operationId: operationId ?? null,
      operationStatus: null,
    };
  }

  return {
    code: error.code ?? null,
    message: sanitizeServerError(error.message, fallback),
    stage: error.stage ?? null,
    sanitizedCause: error.sanitizedCause ?? null,
    operationId: operationId ?? null,
    operationStatus: null,
  };
}

function extractThrownImportErrorMetadata(error: unknown): {
  stage: string | null;
  sanitizedCause: string | null;
  operationId: string | null;
} {
  const cause =
    error instanceof Error ? ((error as Error & { cause?: unknown }).cause ?? null) : null;

  if (!cause || typeof cause !== 'object') {
    return {
      stage: null,
      sanitizedCause: null,
      operationId: null,
    };
  }

  const causeRecord = cause as Record<string, unknown>;

  return {
    stage: typeof causeRecord.stage === 'string' ? causeRecord.stage : null,
    sanitizedCause:
      typeof causeRecord.sanitizedCause === 'string' ? causeRecord.sanitizedCause : null,
    operationId: typeof causeRecord.operationId === 'string' ? causeRecord.operationId : null,
  };
}

function normalizeThrownImportError(error: unknown, fallback: string): DisplayImportError {
  const metadata = extractThrownImportErrorMetadata(error);

  return {
    code: error instanceof AppError ? error.code : null,
    message: sanitizeError(error, fallback),
    stage: metadata.stage,
    sanitizedCause: metadata.sanitizedCause,
    operationId: metadata.operationId,
    operationStatus: null,
  };
}

function formatDisplayImportError(error: DisplayImportError): string {
  const prefix = [error.code, error.stage].filter(Boolean).join(' · ');
  return prefix ? `${prefix}: ${error.message}` : error.message;
}

function normalizeImportOperationStatus(
  data: ImportOperationStatusData | null | undefined,
): DisplayImportOperationStatus | null {
  if (!data) {
    return null;
  }

  return {
    status: data.status,
    layers: Object.entries(data.layers ?? {}).map(([name, layer]) => ({
      name,
      status: layer.status,
    })),
  };
}

function mergeVisiblePreviewWarnings(
  previewResponse: ImportPreviewResponse,
): ImportPreviewResponse {
  if (!previewResponse.preview) {
    return previewResponse;
  }

  return {
    ...previewResponse,
    preview: {
      ...previewResponse.preview,
      warnings: Array.from(
        new Set([...(previewResponse.preview.warnings ?? []), ...(previewResponse.warnings ?? [])]),
      ),
    },
  };
}

export function ImportDialog({ open, onClose, projectId, onImported }: ImportDialogProps) {
  const t = useTranslations('projects.import');
  const [step, setStep] = useState<Step>('upload');
  const [files, setFiles] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [result, setResult] = useState<{
    created: number;
    updated: number;
    deleted: number;
    toolsCreated: number;
    toolsUpdated: number;
    toolsDeleted: number;
    localesCreated: number;
    localesUpdated: number;
    localesDeleted: number;
    evalsCreated?: number;
    evalsUpdated?: number;
    evalsDeleted?: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [acknowledgedIssues, setAcknowledgedIssues] = useState(false);
  const [applyError, setApplyError] = useState<DisplayImportError | null>(null);
  const [replaceProjectContents, setReplaceProjectContents] = useState(false);
  const [bindingResolutions, setBindingResolutions] = useState<
    Record<string, ImportBindingResolutionInput>
  >({});
  const [workflowTriggers, setWorkflowTriggers] = useState<WorkflowTrigger[]>([]);
  const [workflowTriggersLoading, setWorkflowTriggersLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { knowledgeBases } = useKnowledgeBases(open ? projectId : null);
  const { workflows } = useWorkflows(open ? projectId : null);
  const workflowsById = useMemo(
    () => new Map(workflows.map((workflow) => [workflow.id, workflow])),
    [workflows],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setWorkflowTriggersLoading(true);
    listWorkflowTriggers(projectId)
      .then((triggers) => {
        if (!cancelled) {
          setWorkflowTriggers(triggers.filter((trigger) => trigger.status !== 'deleted'));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkflowTriggers([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWorkflowTriggersLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const reset = useCallback(() => {
    setStep('upload');
    setFiles({});
    setFileNames([]);
    setPreview(null);
    setResult(null);
    setLoading(false);
    setDragging(false);
    setAcknowledgedIssues(false);
    setApplyError(null);
    setReplaceProjectContents(false);
    setBindingResolutions({});
    setWorkflowTriggers([]);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const handleClose = () => {
    const imported = step === 'result';
    reset();
    onClose();
    if (imported) onImported?.();
  };

  /**
   * Sanitize a ZIP entry path: strip path traversal sequences and leading slashes.
   * Returns null if the path is unsafe after sanitization.
   */
  const sanitizePath = (entryPath: string): string | null => {
    // Reject null bytes
    if (entryPath.includes('\0')) return null;
    // Normalize: remove leading slashes, collapse ../ sequences
    let safe = entryPath.replace(/\\/g, '/');
    // Strip leading / or ./
    safe = safe.replace(/^(\.\/|\/)+/, '');
    // Reject any remaining path traversal
    if (safe.includes('..')) return null;
    // Reject empty or directory-only entries
    if (!safe || safe.endsWith('/')) return null;
    return safe;
  };

  const parseFiles = async (fileList: FileList): Promise<Record<string, string>> => {
    const parsed: Record<string, string> = {};

    for (const file of Array.from(fileList)) {
      if (file.name.endsWith('.zip')) {
        // ZIP file — extract with fflate (with safety limits)
        try {
          if (file.size > MAX_ZIP_SIZE) {
            toast.error(t('file_too_large', { name: file.name, max: '100MB' }));
            continue;
          }

          const { unzip, strFromU8 } = await import('fflate');
          const zipData = new Uint8Array(await file.arrayBuffer());
          const extracted = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
            unzip(
              zipData,
              {
                filter: (f) =>
                  !f.name.endsWith('/') &&
                  ['.abl', '.json', '.yaml', '.yml', '.txt'].some((ext) => f.name.endsWith(ext)),
              },
              (err, result) => (err ? reject(err) : resolve(result)),
            );
          });

          // Validate decompressed output
          const entries = Object.entries(extracted);
          if (entries.length > MAX_FILE_COUNT) {
            toast.error(t('too_many_files', { max: MAX_FILE_COUNT }));
            continue;
          }

          let totalDecompressed = 0;
          for (const [entryPath, data] of entries) {
            const safePath = sanitizePath(entryPath);
            if (!safePath) continue;

            if (data.byteLength > MAX_FILE_SIZE) continue; // skip oversized files silently

            totalDecompressed += data.byteLength;
            if (totalDecompressed > MAX_DECOMPRESSED_SIZE) {
              toast.error(t('total_too_large', { max: '50MB' }));
              break;
            }

            parsed[safePath] = strFromU8(data);
          }

          // Compression ratio check (zip bomb defense)
          if (totalDecompressed > 0 && totalDecompressed / file.size > MAX_COMPRESSION_RATIO) {
            toast.error(t('suspicious_archive', { name: file.name }));
            // Clear parsed entries from this zip
            for (const key of Object.keys(parsed)) {
              delete parsed[key];
            }
            continue;
          }
        } catch {
          toast.error(t('parse_failed', { name: file.name }));
        }
      } else if (file.name.endsWith('.agent-bundle.json')) {
        // Bundle file — extract the files map
        try {
          if (file.size > MAX_DECOMPRESSED_SIZE) {
            toast.error(t('file_too_large', { name: file.name, max: '50MB' }));
            continue;
          }
          const text = await file.text();
          const bundle = JSON.parse(text);
          if (bundle.files && typeof bundle.files === 'object') {
            Object.assign(parsed, bundle.files);
          }
        } catch {
          toast.error(t('parse_failed', { name: file.name }));
        }
      } else if (file.name.endsWith('.abl')) {
        // Individual ABL file
        if (file.size > MAX_FILE_SIZE) {
          toast.error(t('file_too_large', { name: file.name, max: '1MB' }));
          continue;
        }
        const text = await file.text();
        parsed[file.name] = text;
      } else {
        toast.error(t('unsupported_type', { name: file.name }));
      }
    }

    return parsed;
  };

  const handleFiles = async (fileList: FileList) => {
    if (fileList.length === 0) return;

    setFileNames(Array.from(fileList).map((f) => f.name));
    setApplyError(null);
    setLoading(true);
    try {
      const parsed = await parseFiles(fileList);
      if (Object.keys(parsed).length === 0) {
        toast.error(t('no_valid_files'));
        setFileNames([]);
        return;
      }
      setFiles(parsed);
      setBindingResolutions({});

      const previewData = await fetchImportPreview(projectId, parsed, {
        deleteUnmatched: replaceProjectContents,
      });
      setPreview(mergeVisiblePreviewWarnings(previewData));
      setAcknowledgedIssues(false);
      setStep('preview');
    } catch (err) {
      console.error('Import preview failed:', err);
      toast.error(formatDisplayImportError(normalizeThrownImportError(err, t('preview_failed'))));
    } finally {
      setLoading(false);
    }
  };

  const handleApply = async () => {
    setApplyError(null);
    setLoading(true);
    try {
      const data = await applyImport(projectId, files, {
        deleteUnmatched: replaceProjectContents,
        previewDigest: preview?.previewDigest ?? previewData?.previewDigest ?? null,
        acknowledgedIssueIds: acknowledgedIssues
          ? (previewData?.issues ?? []).filter((issue) => !issue.blocking).map((issue) => issue.id)
          : [],
        bindingResolutions,
      });
      if (!data.success) {
        const nextApplyError = normalizeImportContractError(
          data.error,
          t('import_failed'),
          data.operationId ?? null,
        ) ?? {
          code: null,
          message: t('import_failed'),
          stage: null,
          sanitizedCause: null,
          operationId: data.operationId ?? null,
          operationStatus: null,
        };
        if (data.operationId) {
          const statusResult = await fetchImportStatus(projectId, data.operationId);
          if (statusResult.success) {
            nextApplyError.operationStatus = normalizeImportOperationStatus(statusResult.data);
          }
        }
        setApplyError(nextApplyError);
        setPreview((currentPreview) => {
          const nextPreview = data.preview ?? currentPreview?.preview;
          const nextWarnings = data.warnings ?? currentPreview?.warnings ?? [];
          const mergedPreviewWarnings = Array.from(
            new Set([...(nextPreview?.warnings ?? []), ...nextWarnings]),
          );

          return {
            success: currentPreview?.success ?? true,
            previewDigest:
              data.previewDigest ?? data.preview?.previewDigest ?? currentPreview?.previewDigest,
            preview: nextPreview
              ? {
                  ...nextPreview,
                  warnings: mergedPreviewWarnings,
                }
              : nextPreview,
            warnings: nextWarnings,
            error: data.error,
          };
        });
        setStep('preview');
        toast.error(formatDisplayImportError(nextApplyError));
        return;
      }
      setResult({
        created:
          data.applied.created +
          data.applied.toolsCreated +
          data.applied.localesCreated +
          (data.applied.evalsCreated ?? 0),
        updated:
          data.applied.updated +
          data.applied.toolsUpdated +
          data.applied.localesUpdated +
          (data.applied.evalsUpdated ?? 0),
        deleted:
          data.applied.deleted +
          data.applied.toolsDeleted +
          data.applied.localesDeleted +
          (data.applied.evalsDeleted ?? 0),
        toolsCreated: data.applied.toolsCreated,
        toolsUpdated: data.applied.toolsUpdated,
        toolsDeleted: data.applied.toolsDeleted,
        localesCreated: data.applied.localesCreated,
        localesUpdated: data.applied.localesUpdated,
        localesDeleted: data.applied.localesDeleted,
        evalsCreated: data.applied.evalsCreated ?? 0,
        evalsUpdated: data.applied.evalsUpdated ?? 0,
        evalsDeleted: data.applied.evalsDeleted ?? 0,
      });
      await loadProjects();
      setStep('result');
    } catch (err) {
      console.error('Import apply failed:', err);
      const nextApplyError = normalizeThrownImportError(err, t('import_failed'));
      if (nextApplyError.operationId) {
        try {
          const statusResult = await fetchImportStatus(projectId, nextApplyError.operationId);
          if (statusResult.success) {
            nextApplyError.operationStatus = normalizeImportOperationStatus(statusResult.data);
          }
        } catch {
          // The primary apply error is already captured above; status details are best effort.
        }
      }
      setApplyError(nextApplyError);
      toast.error(formatDisplayImportError(nextApplyError));
    } finally {
      setLoading(false);
    }
  };

  const handleBindingResolutionChange = (
    requestId: string,
    resolution: ImportBindingResolutionInput | null,
  ) => {
    setBindingResolutions((current) => {
      const next = { ...current };
      if (!resolution) {
        delete next[requestId];
        return next;
      }
      next[requestId] = resolution;
      return next;
    });
  };

  const handleValidateBindingResolutions = async () => {
    setApplyError(null);
    setLoading(true);
    try {
      const previewData = await fetchImportPreview(projectId, files, {
        deleteUnmatched: replaceProjectContents,
        bindingResolutions,
      });
      setPreview(mergeVisiblePreviewWarnings(previewData));
      setAcknowledgedIssues(false);
    } catch (err) {
      toast.error(formatDisplayImportError(normalizeThrownImportError(err, t('preview_failed'))));
    } finally {
      setLoading(false);
    }
  };

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
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  };

  const previewData = preview?.preview;
  const previewFailed = preview?.success === false;
  const previewError = previewFailed
    ? normalizeImportContractError(preview.error, t('preview_failed'))
    : null;
  // v2 uses top-level agentChanges and toolChanges (not changes.agents/tools)
  const agentChanges = previewData?.agentChanges;
  const toolChanges = previewData?.toolChanges;
  const localeChanges = previewData?.localeChanges;
  const issues = previewData?.issues ?? [];
  const bindingResolutionRequests = previewData?.bindingResolutionRequests ?? [];
  const allBindingRequestsResolved =
    bindingResolutionRequests.length === 0 ||
    bindingResolutionRequests.every((request) => {
      const resolution = bindingResolutions[request.id];
      if (request.kind === 'searchai_index') {
        return Boolean(resolution?.target?.indexId);
      }
      return Boolean(resolution?.target?.workflowId && resolution.target.triggerId);
    });
  const blockingIssues = issues.filter((issue) => issue.blocking && issue.category !== 'binding');
  const bindingIssues = issues.filter((issue) => issue.blocking && issue.category === 'binding');
  const advisoryIssues = issues.filter((issue) => !issue.blocking);
  const hasBlockingIssues =
    previewData?.hasBlockingIssues ?? (previewData?.syntaxErrors?.length ?? 0) > 0;
  const requiresAcknowledgement = previewData?.requiresAcknowledgement ?? advisoryIssues.length > 0;
  const inlinePreviewError = applyError ?? previewError;
  // v2 uses layerChanges counts for per-layer summary
  const layerChanges = previewData?.layerChanges;
  const totalToolChanges =
    (toolChanges?.added?.length ?? 0) +
    (toolChanges?.modified?.length ?? 0) +
    (toolChanges?.removed?.length ?? 0);
  const totalLocaleChanges =
    (localeChanges?.added?.length ?? 0) +
    (localeChanges?.modified?.length ?? 0) +
    (localeChanges?.removed?.length ?? 0);
  const totalChanges =
    (agentChanges?.added?.length ?? 0) +
    (agentChanges?.modified?.length ?? 0) +
    (agentChanges?.removed?.length ?? 0) +
    totalToolChanges +
    totalLocaleChanges;

  // Detect format version from imported project.json
  const formatVersion = (() => {
    try {
      const manifest = files['project.json'];
      if (!manifest) return null;
      const parsed = JSON.parse(manifest);
      return parsed.format_version ?? '1.0';
    } catch {
      return null;
    }
  })();

  const formatIssueLabel = (message: string, file?: string, line?: number) => {
    if (!file) {
      return message;
    }

    return `${file}${line ? `:${line}` : ''}: ${message}`;
  };

  // Detect lockfile integrity for SHA badge
  const lockfileIntegrity = (() => {
    try {
      const lock = files['abl.lock'];
      if (!lock) return null;
      const parsed = JSON.parse(lock);
      return parsed.integrity ? (parsed.integrity as string).slice(0, 12) : null;
    } catch {
      return null;
    }
  })();

  return (
    <Dialog open={open} onClose={handleClose} title={t('title')} maxWidth="xl">
      {/* Upload step */}
      {step === 'upload' && (
        <div className="space-y-4">
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
            {loading ? (
              <div className="flex flex-col items-center">
                <Loader2 className="w-8 h-8 text-muted animate-spin mb-2" />
                {fileNames.length > 0 && (
                  <p className="text-xs text-muted">
                    {t('processing_files', {
                      count: fileNames.length,
                      names: fileNames.join(', '),
                    })}
                  </p>
                )}
              </div>
            ) : (
              <>
                <Upload className="w-8 h-8 text-muted mb-3" />
                <p className="text-sm font-medium text-foreground">{t('drop_or_browse')}</p>
                <p className="text-xs text-muted mt-1">{t('accepted_formats')}</p>
              </>
            )}
          </div>
          <div className="rounded-lg border border-default bg-background-muted p-3">
            <div className="mb-2">
              <p className="text-xs font-medium text-subtle uppercase tracking-wider">
                {t('import_mode_title')}
              </p>
              <p className="text-sm font-medium text-foreground mt-1">
                {replaceProjectContents ? t('replace_mode_label') : t('merge_mode_summary')}
              </p>
              <p className="text-xs text-muted mt-0.5">
                {replaceProjectContents
                  ? t('replace_mode_description')
                  : t('merge_mode_description')}
              </p>
            </div>
            <Checkbox
              checked={replaceProjectContents}
              onChange={setReplaceProjectContents}
              label={t('replace_mode_label')}
              description={t('replace_mode_description')}
            />
          </div>
          <details className="group">
            <summary className="flex items-center gap-1.5 text-xs text-muted cursor-pointer hover:text-foreground transition-default">
              <ChevronDown className="w-3.5 h-3.5 transition-transform duration-200 group-open:rotate-180" />
              {t('structure_hint_toggle')}
            </summary>
            <div className="mt-2 text-xs text-muted font-mono bg-background-muted rounded-lg p-3 whitespace-pre leading-relaxed">
              {`your-project/
  project.json               (manifest)
  abl.lock                   (integrity)
  agents/                    [core]
    supervisor.agent.abl
    booking_agent.agent.abl
  tools/                     [core]
    hotels-api.tools.abl
  config/                    [core]
  connections/               [connections]
  guardrails/                [guardrails]
  workflows/                 [workflows]
  locales/                   (optional)
    en/
      booking_agent.json`}
            </div>
          </details>
          <input
            ref={inputRef}
            type="file"
            accept=".json,.abl,.zip"
            multiple
            className="hidden"
            onChange={handleInputChange}
          />
          <div className="flex justify-end">
            <Button variant="ghost" onClick={handleClose}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}

      {/* Preview step — fallback when preview data is missing */}
      {step === 'preview' && !previewData && (
        <div className="space-y-4 text-center py-4">
          <AlertTriangle className="w-8 h-8 text-error mx-auto" />
          <div className="space-y-2">
            <p className="text-sm text-error font-medium">
              {previewError?.message ?? t('preview_failed')}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {previewError?.code && (
                <Badge variant="error" className="font-mono">
                  {previewError.code}
                </Badge>
              )}
              {previewError?.stage && (
                <Badge variant="error" className="font-mono">
                  {previewError.stage}
                </Badge>
              )}
            </div>
            {previewError?.sanitizedCause && (
              <p className="text-xs text-error/80">{previewError.sanitizedCause}</p>
            )}
          </div>
          <Button variant="ghost" onClick={reset}>
            {t('back')}
          </Button>
        </div>
      )}

      {/* Preview step — fallback when server response is malformed */}
      {step === 'preview' && previewData && !agentChanges && (
        <div className="space-y-4 text-center py-4">
          <AlertTriangle className="w-8 h-8 text-error mx-auto" />
          <div className="space-y-2">
            <p className="text-sm text-error font-medium">
              {previewError?.message ?? t('preview_invalid')}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {previewError?.code && (
                <Badge variant="error" className="font-mono">
                  {previewError.code}
                </Badge>
              )}
              {previewError?.stage && (
                <Badge variant="error" className="font-mono">
                  {previewError.stage}
                </Badge>
              )}
            </div>
            {previewError?.sanitizedCause && (
              <p className="text-xs text-error/80">{previewError.sanitizedCause}</p>
            )}
          </div>
          <Button variant="ghost" onClick={reset}>
            {t('back')}
          </Button>
        </div>
      )}

      {/* Preview step */}
      {step === 'preview' && previewData && agentChanges && (
        <div className="space-y-5">
          {inlinePreviewError && (
            <div className="rounded-lg border border-error/30 bg-error-subtle/30 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-error" />
                <span className="text-xs font-medium text-error">
                  {applyError ? t('import_failed') : t('preview_failed')}
                </span>
                {inlinePreviewError.code ? (
                  <Badge variant="error" className="font-mono">
                    {inlinePreviewError.code}
                  </Badge>
                ) : null}
                {inlinePreviewError.stage ? (
                  <Badge variant="error" className="font-mono">
                    {inlinePreviewError.stage}
                  </Badge>
                ) : null}
              </div>
              <p className="text-sm text-error">{inlinePreviewError.message}</p>
              {inlinePreviewError.sanitizedCause ? (
                <p className="text-xs text-error/80 mt-1">{inlinePreviewError.sanitizedCause}</p>
              ) : null}
              {inlinePreviewError.operationId ? (
                <p className="text-xs text-error/80 mt-1 font-mono">
                  Operation: {inlinePreviewError.operationId}
                </p>
              ) : null}
              {inlinePreviewError.operationStatus ? (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-error/80 font-mono">
                    Status: {inlinePreviewError.operationStatus.status}
                  </p>
                  {inlinePreviewError.operationStatus.layers.map((layer) => (
                    <p key={layer.name} className="text-xs text-error/80 font-mono">
                      {layer.name}: {layer.status}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          {/* Format info badges */}
          {(formatVersion || lockfileIntegrity) && (
            <div className="flex items-center gap-2">
              {formatVersion && (
                <Badge variant={formatVersion === '2.0' ? 'info' : 'default'}>
                  Format v{formatVersion}
                </Badge>
              )}
              {lockfileIntegrity && (
                <Badge variant="default" className="font-mono">
                  <Shield className="w-3 h-3 mr-1 inline" />
                  SHA: {lockfileIntegrity}
                </Badge>
              )}
            </div>
          )}

          {/* Change summary */}
          <div className="grid grid-cols-4 gap-3">
            <SummaryCard
              icon={<Plus className="w-4 h-4" />}
              label={t('added')}
              count={agentChanges.added?.length ?? 0}
              variant="success"
            />
            <SummaryCard
              icon={<Pencil className="w-4 h-4" />}
              label={t('modified')}
              count={agentChanges.modified?.length ?? 0}
              variant="info"
            />
            <SummaryCard
              icon={<Minus className="w-4 h-4" />}
              label={t('removed')}
              count={agentChanges.removed?.length ?? 0}
              variant="error"
            />
            <SummaryCard
              icon={<FileText className="w-4 h-4" />}
              label={t('unchanged')}
              count={agentChanges.unchanged?.length ?? 0}
              variant="default"
            />
          </div>

          {/* Agent lists */}
          {(agentChanges.added?.length ?? 0) > 0 && (
            <AgentChangeList
              label={t('new_agents')}
              agents={agentChanges.added}
              variant="success"
              badgeLabel={t('badge_new')}
            />
          )}
          {(agentChanges.modified?.length ?? 0) > 0 && (
            <AgentChangeList
              label={t('modified_agents')}
              agents={agentChanges.modified.map((m) => m.name)}
              variant="info"
              badgeLabel={t('badge_mod')}
            />
          )}
          {(agentChanges.removed?.length ?? 0) > 0 && (
            <AgentChangeList
              label={t('removed_agents')}
              agents={agentChanges.removed}
              variant="error"
              badgeLabel={t('badge_del')}
            />
          )}

          {/* Tool changes */}
          {totalToolChanges > 0 && (
            <div>
              <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
                Tools ({totalToolChanges})
              </h3>
              <div className="space-y-1">
                {toolChanges?.added?.map((name) => (
                  <div
                    key={name}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted"
                  >
                    <Badge variant="success" dot>
                      {t('badge_new')}
                    </Badge>
                    <span className="text-sm text-foreground font-medium">{name}</span>
                  </div>
                ))}
                {toolChanges?.modified?.map((name) => (
                  <div
                    key={name}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted"
                  >
                    <Badge variant="info" dot>
                      {t('badge_mod')}
                    </Badge>
                    <span className="text-sm text-foreground font-medium">{name}</span>
                  </div>
                ))}
                {toolChanges?.removed?.map((name) => (
                  <div
                    key={name}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted"
                  >
                    <Badge variant="error" dot>
                      {t('badge_del')}
                    </Badge>
                    <span className="text-sm text-foreground font-medium">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {totalLocaleChanges > 0 && (
            <div>
              <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
                {t('locale_files')} ({totalLocaleChanges})
              </h3>
              <div className="space-y-1">
                {localeChanges?.added?.map((filePath) => (
                  <div
                    key={filePath}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted"
                  >
                    <Badge variant="success" dot>
                      {t('badge_new')}
                    </Badge>
                    <span className="text-sm text-foreground font-medium">{filePath}</span>
                  </div>
                ))}
                {localeChanges?.modified?.map((filePath) => (
                  <div
                    key={filePath}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted"
                  >
                    <Badge variant="info" dot>
                      {t('badge_mod')}
                    </Badge>
                    <span className="text-sm text-foreground font-medium">{filePath}</span>
                  </div>
                ))}
                {localeChanges?.removed?.map((filePath) => (
                  <div
                    key={filePath}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted"
                  >
                    <Badge variant="error" dot>
                      {t('badge_del')}
                    </Badge>
                    <span className="text-sm text-foreground font-medium">{filePath}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Layer summary (v2 — per-layer file counts) */}
          {layerChanges && Object.keys(layerChanges).length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
                Layers
              </h3>
              <div className="space-y-1">
                {Object.entries(layerChanges).map(([layer, counts]) =>
                  counts ? (
                    <div
                      key={layer}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted"
                    >
                      <span className="text-sm text-foreground font-medium capitalize">
                        {layer}
                      </span>
                      {counts.added > 0 && (
                        <Badge variant="success" dot>
                          +{counts.added}
                        </Badge>
                      )}
                      {counts.modified > 0 && (
                        <Badge variant="info" dot>
                          ~{counts.modified}
                        </Badge>
                      )}
                      {counts.removed > 0 && (
                        <Badge variant="error" dot>
                          -{counts.removed}
                        </Badge>
                      )}
                      {counts.unchanged > 0 && (
                        <Badge variant="default">{counts.unchanged} unchanged</Badge>
                      )}
                    </div>
                  ) : null,
                )}
              </div>
            </div>
          )}

          {bindingResolutionRequests.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning-subtle/20 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-warning" />
                <span className="text-xs font-medium text-warning">Bindings to resolve</span>
              </div>
              <div className="space-y-3">
                {bindingResolutionRequests.map((request) => {
                  const resolution = bindingResolutions[request.id];
                  return (
                    <div
                      key={request.id}
                      className="rounded-lg border border-default bg-background p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">{request.toolName}</p>
                          <p className="text-xs text-muted mt-0.5">{request.message}</p>
                        </div>
                        <Badge variant="warning" className="font-mono">
                          {request.kind}
                        </Badge>
                      </div>

                      {request.kind === 'searchai_index' ? (
                        <div className="mt-3">
                          <label className="block text-xs font-medium text-subtle mb-1">
                            Target knowledge base
                          </label>
                          <select
                            className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm text-foreground"
                            value={resolution?.target?.indexId ?? ''}
                            onChange={(event) =>
                              handleBindingResolutionChange(
                                request.id,
                                event.target.value
                                  ? {
                                      action: 'map_existing',
                                      target: { indexId: event.target.value },
                                    }
                                  : null,
                              )
                            }
                          >
                            <option value="">Select a knowledge base</option>
                            {knowledgeBases.map((kb) => (
                              <option key={kb._id} value={kb._id}>
                                {kb.name}
                              </option>
                            ))}
                          </select>
                          <p className="text-xs text-muted mt-1">
                            Source: {request.source.kbName ?? request.source.indexId ?? 'unknown'}
                          </p>
                        </div>
                      ) : (
                        <div className="mt-3">
                          <label className="block text-xs font-medium text-subtle mb-1">
                            Target workflow trigger
                          </label>
                          <select
                            className="w-full rounded-md border border-default bg-background px-3 py-2 text-sm text-foreground"
                            value={
                              resolution?.target?.workflowId && resolution.target.triggerId
                                ? `${resolution.target.workflowId}::${resolution.target.triggerId}`
                                : ''
                            }
                            disabled={workflowTriggersLoading}
                            onChange={(event) => {
                              if (!event.target.value) {
                                handleBindingResolutionChange(request.id, null);
                                return;
                              }
                              const [workflowId, triggerId] = event.target.value.split('::');
                              handleBindingResolutionChange(request.id, {
                                action: 'map_existing',
                                target: { workflowId, triggerId },
                              });
                            }}
                          >
                            <option value="">
                              {workflowTriggersLoading
                                ? 'Loading workflow triggers...'
                                : 'Select a workflow trigger'}
                            </option>
                            {workflowTriggers
                              .filter((trigger) => trigger.workflowId)
                              .map((trigger) => {
                                const workflow = workflowsById.get(trigger.workflowId ?? '');
                                return (
                                  <option
                                    key={trigger.id}
                                    value={`${trigger.workflowId}::${trigger.id}`}
                                  >
                                    {workflow?.name ?? trigger.workflowId} · {trigger.triggerType}
                                  </option>
                                );
                              })}
                          </select>
                          <p className="text-xs text-muted mt-1">
                            Source: {request.source.workflowId ?? 'unknown'} /{' '}
                            {request.source.triggerId ?? 'unknown'}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-end mt-3">
                <Button
                  variant="secondary"
                  loading={loading}
                  disabled={!allBindingRequestsResolved}
                  onClick={handleValidateBindingResolutions}
                >
                  Validate bindings
                </Button>
              </div>
            </div>
          )}

          {/* Blocking issues */}
          {(blockingIssues.length > 0 || bindingIssues.length > 0) && (
            <div className="rounded-lg border border-error/30 bg-error-subtle/30 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-error" />
                <span className="text-xs font-medium text-error">{t('blocking_issues')}</span>
              </div>
              <p className="text-xs text-error/80 mb-2">{t('blocking_issues_description')}</p>
              <ul className="space-y-1">
                {[...blockingIssues, ...bindingIssues].map((issue) => (
                  <li key={issue.id} className="text-xs text-muted">
                    {formatIssueLabel(issue.message, issue.file, issue.line)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Non-blocking issues */}
          {advisoryIssues.length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning-subtle/30 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-warning" />
                <span className="text-xs font-medium text-warning">{t('issues_to_review')}</span>
              </div>
              <ul className="space-y-1">
                {advisoryIssues.map((issue) => (
                  <li key={issue.id} className="text-xs text-muted">
                    {formatIssueLabel(issue.message, issue.file, issue.line)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Warnings */}
          {(previewData.warnings?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-warning/20 bg-warning-subtle/20 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-warning" />
                <span className="text-xs font-medium text-warning">{t('warnings')}</span>
              </div>
              <ul className="space-y-1">
                {previewData.warnings.map((warning, index) => (
                  <li key={index} className="text-xs text-muted">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {requiresAcknowledgement && advisoryIssues.length > 0 && (
            <div className="rounded-lg border border-default bg-background-muted p-3">
              <Checkbox
                checked={acknowledgedIssues}
                onChange={setAcknowledgedIssues}
                label={t('acknowledge_issues')}
                description={t('acknowledge_issues_description')}
              />
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-between pt-2">
            <Button variant="ghost" onClick={reset}>
              {t('back')}
            </Button>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={handleClose}>
                {t('cancel')}
              </Button>
              <Button
                icon={<FileUp className="w-4 h-4" />}
                loading={loading}
                disabled={
                  totalChanges === 0 ||
                  previewFailed ||
                  hasBlockingIssues ||
                  (requiresAcknowledgement && !acknowledgedIssues)
                }
                onClick={handleApply}
              >
                {t('apply_import')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Result step */}
      {step === 'result' && result && (
        <div className="space-y-5 text-center py-4">
          <div className="flex justify-center">
            <div className="w-12 h-12 rounded-full bg-success-subtle flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-success" />
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{t('import_complete')}</p>
            <p className="text-xs text-muted mt-1">
              {t('import_summary', {
                created: result.created,
                updated: result.updated,
                deleted: result.deleted,
              })}
            </p>
            {'toolsCreated' in result &&
              (result.toolsCreated > 0 ||
                result.toolsUpdated > 0 ||
                result.toolsDeleted > 0 ||
                result.localesCreated > 0 ||
                result.localesUpdated > 0 ||
                result.localesDeleted > 0 ||
                (result.evalsCreated ?? 0) > 0 ||
                (result.evalsUpdated ?? 0) > 0 ||
                (result.evalsDeleted ?? 0) > 0) && (
                <p className="text-xs text-muted mt-1">
                  {`Tools +${result.toolsCreated} / ~${result.toolsUpdated} / -${result.toolsDeleted} · Locales +${result.localesCreated} / ~${result.localesUpdated} / -${result.localesDeleted} · Evals +${result.evalsCreated ?? 0} / ~${result.evalsUpdated ?? 0} / -${result.evalsDeleted ?? 0}`}
                </p>
              )}
          </div>
          <Button variant="primary" onClick={handleClose}>
            {t('done')}
          </Button>
        </div>
      )}
    </Dialog>
  );
}

// =============================================================================
// SUBCOMPONENTS
// =============================================================================

function SummaryCard({
  icon,
  label,
  count,
  variant,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  variant: 'success' | 'info' | 'error' | 'default';
}) {
  const colors = {
    success: 'text-success',
    info: 'text-info',
    error: 'text-error',
    default: 'text-muted',
  };

  return (
    <div className="rounded-lg border border-default bg-background-elevated p-3 text-center">
      <div className={clsx('flex justify-center mb-1', colors[variant])}>{icon}</div>
      <p className="text-lg font-semibold text-foreground">{count}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

function AgentChangeList({
  label,
  agents,
  variant,
  badgeLabel,
}: {
  label: string;
  agents: string[];
  variant: 'success' | 'info' | 'error';
  badgeLabel: string;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">{label}</h3>
      <div className="space-y-1">
        {agents.map((name) => (
          <div
            key={name}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted"
          >
            <Badge variant={variant} dot>
              {badgeLabel}
            </Badge>
            <span className="text-sm text-foreground">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
