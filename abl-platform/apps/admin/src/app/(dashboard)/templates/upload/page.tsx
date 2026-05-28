'use client';

import { useState, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileArchive, CheckCircle, AlertCircle, ArrowLeft, Loader2 } from 'lucide-react';
import { unzipSync, strFromU8 } from 'fflate';
import { PageHeader } from '@agent-platform/admin-ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExtractedFile {
  path: string;
  content: string;
  size: number;
}

interface UploadValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface TemplateMetadata {
  name: string;
  shortDescription: string;
  longDescription: string;
  category: string;
  tags: string;
  complexity: string;
  type: string;
}

interface UploadResponse {
  success: boolean;
  data?: {
    id: string;
    metadata: {
      name?: string;
      shortDescription?: string;
      longDescription?: string;
      category?: string;
      tags?: string[];
      complexity?: string;
      type?: string;
    };
    validation: UploadValidation;
  };
  error?: { code: string; message: string } | string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_BUNDLE_SIZE = 4 * 1024 * 1024; // 4MB
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
const MAX_FILE_COUNT = 500;

const CATEGORY_OPTIONS = [
  'customer-service',
  'sales',
  'hr',
  'finance',
  'healthcare',
  'education',
  'general',
  'other',
];

const COMPLEXITY_OPTIONS = ['starter', 'standard', 'advanced'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizePath(path: string): string {
  // Strip leading slashes and normalize
  return path.replace(/^\/+/, '').replace(/\\/g, '/');
}

function stripCommonPrefix(paths: string[]): string[] {
  if (paths.length === 0) return paths;

  const parts = paths.map((p) => p.split('/'));
  const minLen = Math.min(...parts.map((p) => p.length));

  let commonLen = 0;
  for (let i = 0; i < minLen - 1; i++) {
    const segment = parts[0][i];
    if (parts.every((p) => p[i] === segment)) {
      commonLen = i + 1;
    } else {
      break;
    }
  }

  if (commonLen === 0) return paths;
  return paths.map((p) => p.split('/').slice(commonLen).join('/'));
}

function extractManifestMetadata(files: Record<string, string>): Partial<TemplateMetadata> {
  const manifestKey = Object.keys(files).find(
    (k) => k === 'manifest.json' || k.endsWith('/manifest.json'),
  );
  if (!manifestKey) return {};

  try {
    const manifest = JSON.parse(files[manifestKey]);
    return {
      name: manifest.name ?? '',
      shortDescription: manifest.shortDescription ?? manifest.description ?? '',
      longDescription: manifest.longDescription ?? '',
      category: manifest.category ?? '',
      tags: Array.isArray(manifest.tags) ? manifest.tags.join(', ') : '',
      complexity: manifest.complexity ?? 'standard',
      type: manifest.type ?? 'agent',
    };
  } catch {
    return {};
  }
}

function detectType(files: Record<string, string>): string {
  const fileNames = Object.keys(files);
  const hasProjectFile = fileNames.some(
    (f) => f.endsWith('.project.abl') || f.includes('project.json'),
  );
  if (hasProjectFile) return 'project';
  return 'agent';
}

// ─── Drop Zone ────────────────────────────────────────────────────────────────

function DropZone({
  onFilesExtracted,
  disabled,
}: {
  onFilesExtracted: (files: Record<string, string>, rawFiles: ExtractedFile[]) => void;
  disabled: boolean;
}) {
  const [dragActive, setDragActive] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processZipFile = useCallback(
    async (file: File) => {
      setExtractError(null);
      setExtracting(true);

      try {
        if (file.size > MAX_BUNDLE_SIZE) {
          setExtractError(
            `Bundle too large: ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_BUNDLE_SIZE / 1024 / 1024}MB limit`,
          );
          return;
        }

        const arrayBuffer = await file.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);
        const unzipped = unzipSync(uint8);

        const rawPaths = Object.keys(unzipped).filter((p) => !p.endsWith('/'));

        if (rawPaths.length > MAX_FILE_COUNT) {
          setExtractError(
            `Too many files: ${rawPaths.length} exceeds the ${MAX_FILE_COUNT} file limit`,
          );
          return;
        }

        const sanitizedPaths = rawPaths.map(sanitizePath);
        const strippedPaths = stripCommonPrefix(sanitizedPaths);

        const filesMap: Record<string, string> = {};
        const extractedFiles: ExtractedFile[] = [];
        const oversizedFiles: string[] = [];

        for (let i = 0; i < rawPaths.length; i++) {
          const rawPath = rawPaths[i];
          const cleanPath = strippedPaths[i];
          const fileData = unzipped[rawPath];

          if (fileData.byteLength > MAX_FILE_SIZE) {
            oversizedFiles.push(cleanPath);
            continue;
          }

          const content = strFromU8(fileData);
          filesMap[cleanPath] = content;
          extractedFiles.push({
            path: cleanPath,
            content,
            size: fileData.byteLength,
          });
        }

        if (oversizedFiles.length > 0) {
          setExtractError(
            `${oversizedFiles.length} file(s) exceed the ${MAX_FILE_SIZE / 1024 / 1024}MB per-file limit and were skipped: ${oversizedFiles.slice(0, 3).join(', ')}${oversizedFiles.length > 3 ? '...' : ''}`,
          );
        }

        onFilesExtracted(filesMap, extractedFiles);
      } catch (err: unknown) {
        setExtractError(err instanceof Error ? err.message : 'Failed to extract zip file');
      } finally {
        setExtracting(false);
      }
    },
    [onFilesExtracted],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      if (disabled || extracting) return;

      const file = e.dataTransfer.files[0];
      if (file && (file.name.endsWith('.zip') || file.type === 'application/zip')) {
        processZipFile(file);
      } else {
        setExtractError('Please drop a .zip file');
      }
    },
    [disabled, extracting, processZipFile],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        processZipFile(file);
      }
      // Reset the input so the same file can be re-selected
      e.target.value = '';
    },
    [processZipFile],
  );

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !extracting) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        onClick={() => {
          if (!disabled && !extracting) fileInputRef.current?.click();
        }}
        className={`
          flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-12
          transition-colors cursor-pointer
          ${
            dragActive
              ? 'border-accent bg-accent/5'
              : disabled || extracting
                ? 'border-border bg-background-muted cursor-not-allowed'
                : 'border-border hover:border-accent/50 hover:bg-background-muted'
          }
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          onChange={handleFileSelect}
          className="hidden"
        />
        {extracting ? (
          <>
            <Loader2 size={40} className="text-accent animate-spin mb-3" />
            <p className="text-sm font-medium text-foreground">Extracting bundle...</p>
          </>
        ) : (
          <>
            <FileArchive size={40} className="text-foreground-muted mb-3" />
            <p className="text-sm font-medium text-foreground">
              Drop a .zip file here or click to browse
            </p>
            <p className="text-xs text-foreground-muted mt-1">
              Maximum {MAX_BUNDLE_SIZE / 1024 / 1024}MB, {MAX_FILE_COUNT} files
            </p>
          </>
        )}
      </div>

      {extractError && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-error/25 bg-error/10 px-4 py-3">
          <AlertCircle size={16} className="shrink-0 text-error mt-0.5" />
          <p className="text-sm text-error">{extractError}</p>
        </div>
      )}
    </div>
  );
}

// ─── Metadata Form ────────────────────────────────────────────────────────────

function MetadataForm({
  metadata,
  onChange,
  disabled,
}: {
  metadata: TemplateMetadata;
  onChange: (meta: TemplateMetadata) => void;
  disabled: boolean;
}) {
  const inputClass =
    'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed';
  const selectClass =
    'h-9 w-full rounded-md border border-border bg-background-subtle px-3 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed';
  const labelClass = 'block text-xs font-medium text-foreground-muted mb-1';

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="tmpl-name" className={labelClass}>
          Name
        </label>
        <input
          id="tmpl-name"
          type="text"
          value={metadata.name}
          onChange={(e) => onChange({ ...metadata, name: e.target.value })}
          placeholder="Template name"
          className={inputClass}
          disabled={disabled}
        />
      </div>

      <div>
        <label htmlFor="tmpl-short-desc" className={labelClass}>
          Short Description
        </label>
        <input
          id="tmpl-short-desc"
          type="text"
          value={metadata.shortDescription}
          onChange={(e) => onChange({ ...metadata, shortDescription: e.target.value })}
          placeholder="Brief description"
          className={inputClass}
          disabled={disabled}
        />
      </div>

      <div>
        <label htmlFor="tmpl-long-desc" className={labelClass}>
          Long Description
        </label>
        <textarea
          id="tmpl-long-desc"
          value={metadata.longDescription}
          onChange={(e) => onChange({ ...metadata, longDescription: e.target.value })}
          placeholder="Detailed description of the template"
          rows={4}
          className={`${inputClass} h-auto py-2`}
          disabled={disabled}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="tmpl-category" className={labelClass}>
            Category
          </label>
          <select
            id="tmpl-category"
            value={metadata.category}
            onChange={(e) => onChange({ ...metadata, category: e.target.value })}
            className={selectClass}
            disabled={disabled}
          >
            <option value="">Select category</option>
            {CATEGORY_OPTIONS.map((cat) => (
              <option key={cat} value={cat}>
                {cat
                  .split('-')
                  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                  .join(' ')}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="tmpl-complexity" className={labelClass}>
            Complexity
          </label>
          <select
            id="tmpl-complexity"
            value={metadata.complexity}
            onChange={(e) => onChange({ ...metadata, complexity: e.target.value })}
            className={selectClass}
            disabled={disabled}
          >
            {COMPLEXITY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="tmpl-tags" className={labelClass}>
          Tags (comma-separated)
        </label>
        <input
          id="tmpl-tags"
          type="text"
          value={metadata.tags}
          onChange={(e) => onChange({ ...metadata, tags: e.target.value })}
          placeholder="customer-service, chatbot, onboarding"
          className={inputClass}
          disabled={disabled}
        />
      </div>

      <div>
        <label htmlFor="tmpl-type" className={labelClass}>
          Type (auto-detected)
        </label>
        <input
          id="tmpl-type"
          type="text"
          value={metadata.type}
          className={`${inputClass} bg-background-muted`}
          disabled
          readOnly
        />
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function UploadTemplatePage() {
  const router = useRouter();
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [extractedFiles, setExtractedFiles] = useState<ExtractedFile[]>([]);
  const [metadata, setMetadata] = useState<TemplateMetadata>({
    name: '',
    shortDescription: '',
    longDescription: '',
    category: '',
    tags: '',
    complexity: 'standard',
    type: 'agent',
  });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [validation, setValidation] = useState<UploadValidation | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [step, setStep] = useState<'drop' | 'review' | 'success'>('drop');

  const handleFilesExtracted = useCallback(
    (filesMap: Record<string, string>, rawFiles: ExtractedFile[]) => {
      setFiles(filesMap);
      setExtractedFiles(rawFiles);

      // Auto-extract metadata from manifest
      const manifestMeta = extractManifestMetadata(filesMap);
      const detectedType = detectType(filesMap);

      setMetadata({
        name: manifestMeta.name ?? '',
        shortDescription: manifestMeta.shortDescription ?? '',
        longDescription: manifestMeta.longDescription ?? '',
        category: manifestMeta.category ?? '',
        tags: manifestMeta.tags ?? '',
        complexity: manifestMeta.complexity ?? 'standard',
        type: manifestMeta.type ?? detectedType,
      });

      setStep('review');
    },
    [],
  );

  const handleUpload = useCallback(async () => {
    if (!files) return;

    setUploading(true);
    setUploadError(null);

    try {
      const tags = metadata.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const res = await fetch('/api/templates/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files,
          metadata: {
            name: metadata.name,
            shortDescription: metadata.shortDescription,
            longDescription: metadata.longDescription,
            category: metadata.category,
            tags,
            complexity: metadata.complexity,
            type: metadata.type,
          },
        }),
      });

      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }

      const result: UploadResponse = await res.json();

      if (!res.ok || !result.success) {
        const rawError = result.error;
        let errorMsg: string;
        if (typeof rawError === 'string') {
          errorMsg = rawError;
        } else if (rawError && typeof rawError === 'object' && 'message' in rawError) {
          errorMsg = rawError.message;
          // Append validation details if present
          if ('details' in rawError && Array.isArray(rawError.details)) {
            const details = rawError.details
              .map((d: { path?: string[]; message?: string }) =>
                d.path?.length ? `${d.path.join('.')}: ${d.message}` : d.message,
              )
              .join('; ');
            if (details) errorMsg += `: ${details}`;
          }
        } else {
          errorMsg = `Upload failed with status ${res.status}`;
        }
        setUploadError(errorMsg);
        return;
      }

      if (result.data) {
        setValidation(result.data.validation);
        setTemplateId(result.data.id);
      }

      setStep('success');
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'Failed to connect to server');
    } finally {
      setUploading(false);
    }
  }, [files, metadata]);

  const totalSize = useMemo(
    () => extractedFiles.reduce((sum, f) => sum + f.size, 0),
    [extractedFiles],
  );

  return (
    <div>
      <PageHeader
        title="Upload Template"
        description="Upload a template bundle (.zip) to the marketplace"
        actions={
          <button
            onClick={() => router.push('/templates')}
            className="flex items-center gap-2 rounded-md border border-border bg-background-subtle px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-background-muted"
          >
            <ArrowLeft size={14} />
            Back to Templates
          </button>
        }
      />

      {step === 'drop' && <DropZone onFilesExtracted={handleFilesExtracted} disabled={false} />}

      {step === 'review' && (
        <div className="space-y-6">
          {/* Extraction Summary */}
          <div className="rounded-lg border border-border bg-background-subtle p-4">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle size={16} className="text-success" />
              <h3 className="text-sm font-medium text-foreground">Bundle Extracted</h3>
            </div>
            <div className="flex items-center gap-6 text-xs text-foreground-muted">
              <span>{extractedFiles.length} files</span>
              <span>{(totalSize / 1024).toFixed(1)} KB total</span>
            </div>
            <div className="mt-3 max-h-40 overflow-y-auto rounded border border-border bg-background p-2">
              {extractedFiles.map((f) => (
                <div key={f.path} className="flex items-center justify-between py-0.5 text-xs">
                  <span className="font-mono text-foreground-muted truncate mr-4">{f.path}</span>
                  <span className="text-foreground-muted shrink-0">
                    {f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Metadata Form */}
          <div className="rounded-lg border border-border bg-background-subtle p-4">
            <h3 className="text-sm font-medium text-foreground mb-4">Template Metadata</h3>
            <MetadataForm metadata={metadata} onChange={setMetadata} disabled={uploading} />
          </div>

          {uploadError && (
            <div className="flex items-start gap-2 rounded-lg border border-error/25 bg-error/10 px-4 py-3">
              <AlertCircle size={16} className="shrink-0 text-error mt-0.5" />
              <p className="text-sm text-error">{uploadError}</p>
            </div>
          )}

          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                setStep('drop');
                setFiles(null);
                setExtractedFiles([]);
                setUploadError(null);
              }}
              disabled={uploading}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-background-muted transition-colors disabled:opacity-50"
            >
              Start Over
            </button>
            <button
              onClick={handleUpload}
              disabled={uploading || !metadata.name.trim()}
              className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploading ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload size={14} />
                  Upload Template
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {step === 'success' && (
        <div className="rounded-lg border border-border bg-background-subtle p-6">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle size={24} className="text-success" />
            <h3 className="text-lg font-semibold text-foreground">
              Template Uploaded Successfully
            </h3>
          </div>

          {validation && (
            <div className="space-y-2 mb-4">
              {validation.errors.length > 0 && (
                <div className="rounded-lg border border-error/25 bg-error/10 px-4 py-3">
                  <p className="text-xs font-medium text-error mb-1">Errors</p>
                  <ul className="text-xs text-error space-y-0.5">
                    {validation.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
              {validation.warnings.length > 0 && (
                <div className="rounded-lg border border-warning/25 bg-warning/10 px-4 py-3">
                  <p className="text-xs font-medium text-warning mb-1">Warnings</p>
                  <ul className="text-xs text-warning space-y-0.5">
                    {validation.warnings.map((warn, i) => (
                      <li key={i}>{warn}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/templates')}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 transition-colors"
            >
              View All Templates
            </button>
            {templateId && (
              <button
                onClick={() => router.push(`/templates/${templateId}`)}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground-muted hover:bg-background-muted transition-colors"
              >
                Edit Template
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
