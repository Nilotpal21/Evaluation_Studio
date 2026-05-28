'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import { clsx } from 'clsx';
import { ChevronRight, ChevronDown, FileText, Image } from 'lucide-react';
import type { Specification } from '@agent-platform/arch-ai';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { ChannelTags } from './ChannelTags';
import { ConversationNotes } from './ConversationNotes';
import { FileList } from './FileList';
import { TokenBudgetGauge } from '../panels/TokenBudgetGauge';

interface SpecificationCardProps {
  specification: Specification;
  onUpdate: (field: string, value: unknown) => void;
  disabled?: boolean;
}

const LANGUAGE_OPTIONS = [
  'English',
  'Spanish',
  'French',
  'German',
  'Portuguese',
  'Japanese',
  'Multi-language',
];

/**
 * SpecificationCard — the project setup form in the artifact panel.
 * Contract 3 (specification-schema): slim 5-field form + conversation notes.
 * S1-F12: "Continue →" enabled once projectName is filled.
 */
export function SpecificationCard({
  specification,
  onUpdate,
  disabled = false,
}: SpecificationCardProps) {
  return (
    <div className="flex flex-col gap-5 p-5">
      {/* Project Name — required */}
      <EditableField
        label="Project Name"
        value={specification.projectName}
        onChange={(v) => onUpdate('projectName', v)}
        placeholder="e.g., Fintech Customer Support"
        required
        disabled={disabled}
      />

      {/* Description — optional */}
      <EditableField
        label="Description"
        value={specification.description ?? ''}
        onChange={(v) => onUpdate('description', v || null)}
        placeholder="What does this project do?"
        multiline
        disabled={disabled}
      />

      {/* Channels — optional */}
      <div>
        <label className="text-xs font-medium text-foreground-muted">Channels</label>
        <ChannelTags
          channels={specification.channels}
          onChange={(channels) => onUpdate('channels', channels)}
          disabled={disabled}
        />
      </div>

      {/* Language — optional */}
      <div>
        <label className="text-xs font-medium text-foreground-muted">Language</label>
        <LanguageSelect
          value={specification.language}
          onChange={(v) => onUpdate('language', v)}
          disabled={disabled}
        />
      </div>

      {/* Uploaded Files — optional */}
      {specification.uploadedFiles.length > 0 && (
        <div>
          <label className="text-xs font-medium text-foreground-muted">Documents</label>
          <FileList files={specification.uploadedFiles} />
        </div>
      )}

      {/* Conversation Notes */}
      {specification.conversationNotes.length > 0 && (
        <ConversationNotes notes={specification.conversationNotes} />
      )}

      {/* Attached Files (uploads from file panel) */}
      <AttachedFilesSection />
    </div>
  );
}

// ─── Attached Files Section ──────────────────────────────────────────────

/** Default token budget for file context (128K) */
const DEFAULT_TOKEN_BUDGET = 128_000;

function AttachedFilesSection() {
  const files = useArchAIStore((s) => s.filePanelFiles);
  const [expanded, setExpanded] = useState(false);

  const uploadEntries = useMemo(() => {
    return Object.entries(files).filter(([, f]) => f.fileType === 'upload');
  }, [files]);

  const tokenUsed = useMemo(
    () => uploadEntries.reduce((sum, [, f]) => sum + (f.upload?.tokenCost ?? 0), 0),
    [uploadEntries],
  );

  if (uploadEntries.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1 text-xs font-medium text-foreground-muted hover:text-foreground transition-colors"
      >
        <ChevronRight className={clsx('h-3 w-3 transition-transform', expanded && 'rotate-90')} />
        Attached Files ({uploadEntries.length})
      </button>

      {expanded && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {uploadEntries.map(([name, file]) => {
            const isImage = file.upload?.mediaType.startsWith('image/') ?? false;
            const Icon = isImage ? Image : FileText;
            return (
              <div
                key={name}
                className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-sm"
              >
                <span className="rounded bg-background-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground-muted">
                  {getMediaBadge(file.upload?.mediaType)}
                </span>
                <Icon className="h-3 w-3 flex-shrink-0 text-foreground-muted" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {file.displayName ?? name}
                </span>
                <span className="flex-shrink-0 text-xs text-foreground-muted">
                  {file.upload ? formatUploadSize(file.upload.size) : ''}
                </span>
              </div>
            );
          })}
          <div className="mt-1">
            <TokenBudgetGauge used={tokenUsed} total={DEFAULT_TOKEN_BUDGET} />
          </div>
        </div>
      )}
    </div>
  );
}

function getMediaBadge(mediaType?: string): string {
  if (!mediaType) return 'FILE';
  const badges: Record<string, string> = {
    'application/pdf': 'PDF',
    'text/plain': 'TXT',
    'text/markdown': 'MD',
    'application/json': 'JSON',
    'image/png': 'PNG',
    'image/jpeg': 'JPG',
    'image/webp': 'WEBP',
  };
  return badges[mediaType] ?? mediaType.split('/')[1]?.toUpperCase() ?? 'FILE';
}

function formatUploadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Language Select ─────────────────────────────────────────────────────

function LanguageSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative mt-1">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className={clsx(
          'flex w-full items-center justify-between rounded-lg border border-border bg-background-elevated px-3 py-2 text-sm outline-none transition-colors',
          open ? 'border-accent' : 'hover:border-foreground-subtle',
          'disabled:opacity-50',
        )}
      >
        <span>{value || 'Select language'}</span>
        <ChevronDown
          className={clsx(
            'h-4 w-4 text-foreground-muted transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <ul className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border/60 bg-background-elevated py-1 shadow-md">
          {LANGUAGE_OPTIONS.map((lang) => (
            <li key={lang}>
              <button
                type="button"
                onClick={() => {
                  onChange(lang);
                  setOpen(false);
                }}
                className={clsx(
                  'flex w-full items-center px-3 py-2 text-sm transition-colors hover:bg-background-muted',
                  lang === value ? 'font-medium text-accent' : 'text-foreground',
                )}
              >
                {lang}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

interface EditableFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  disabled?: boolean;
}

function EditableField({
  label,
  value,
  onChange,
  placeholder,
  required,
  multiline,
  disabled,
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const filled = value.trim().length > 0;

  const sharedClasses = clsx(
    'mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors',
    filled ? 'border-success/50' : 'border-border',
    'focus:border-accent disabled:opacity-50 bg-background-elevated',
  );

  return (
    <div>
      <label className="text-xs font-medium text-foreground-muted">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          rows={2}
          maxLength={500}
          className={sharedClasses}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={100}
          className={sharedClasses}
        />
      )}
    </div>
  );
}
