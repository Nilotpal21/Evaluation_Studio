'use client';

import { useEffect, useRef, useMemo } from 'react';
import { clsx } from 'clsx';
import { Check, AlertTriangle, X, Loader2, FileText, Image, Circle, Plus } from 'lucide-react';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import type { FilePanelFile } from '@/lib/arch-ai/store/arch-ai-store';
import { TokenBudgetGauge } from './TokenBudgetGauge';

/** Default token budget for file context (128K) */
const DEFAULT_TOKEN_BUDGET = 128_000;

/**
 * IDEPanel — file tree + code viewer for BUILD phase.
 * Pushes in as a 3rd panel during agent generation.
 * Files appear incrementally as `file_changed` SSE events arrive.
 */
export function IDEPanel() {
  const files = useArchAIStore((s) => s.filePanelFiles);
  const selectedFile = useArchAIStore((s) => s.filePanelSelectedFile);
  const selectFile = useArchAIStore((s) => s.selectFile);
  const addFile = useArchAIStore((s) => s.addFile);
  const artifactVersions = useArchAIStore((s) => s.artifactVersions);
  const approvedAgents = useArchAIStore((s) => s.approvedAgents);
  const currentReviewAgent = useArchAIStore((s) => s.currentReviewAgent);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Extract expected agents from topology (available after topology approval)
  const topologyData = (artifactVersions.topology.at(-1)?.data ?? null) as {
    agents?: Array<{ name: string }>;
  } | null;
  const topologyAgentNames = useMemo(
    () => topologyData?.agents?.map((a) => a.name) ?? [],
    [topologyData],
  );

  const fileNames = Object.keys(files);
  const agentFiles = useMemo(
    () => fileNames.filter((n) => !files[n].fileType || files[n].fileType === 'agent'),
    [fileNames, files],
  );
  const mockFiles = useMemo(
    () => fileNames.filter((n) => files[n].fileType === 'mock'),
    [fileNames, files],
  );
  const uploadFiles = useMemo(
    () => fileNames.filter((n) => files[n].fileType === 'upload'),
    [fileNames, files],
  );

  // Token budget for uploads
  const tokenUsed = useMemo(
    () => uploadFiles.reduce((sum, n) => sum + (files[n].upload?.tokenCost ?? 0), 0),
    [uploadFiles, files],
  );

  // Progress tracking
  const expectedCount = topologyAgentNames.length > 0 ? topologyAgentNames.length : null;
  const generatedCount = agentFiles.length;
  const isGenerating =
    generatedCount === 0 || (expectedCount !== null && generatedCount < expectedCount);
  const progressPct = expectedCount ? Math.round((generatedCount / expectedCount) * 100) : null;

  // Full ordered list: topology agents first (as placeholders), then any extras from files
  const allAgentNames = useMemo(() => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const name of [...topologyAgentNames, ...agentFiles]) {
      if (seen.has(name)) continue;
      seen.add(name);
      ordered.push(name);
    }
    return ordered;
  }, [topologyAgentNames, agentFiles]);

  // Auto-select first file if none selected
  useEffect(() => {
    if (!selectedFile && fileNames.length > 0) {
      selectFile(fileNames[0]);
    }
  }, [fileNames.length, selectedFile, selectFile]);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputFiles = e.target.files;
    if (!inputFiles) return;
    Array.from(inputFiles).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const content = typeof reader.result === 'string' ? reader.result : '';
        addFile(file.name, content, {
          fileType: 'upload',
          displayName: file.name,
          upload: {
            blobId: `local-${Date.now()}-${file.name}`,
            mediaType: file.type || 'application/octet-stream',
            size: file.size,
            tokenCost: Math.ceil(file.size / 4),
            inContext: true,
          },
        });
      };
      reader.readAsText(file);
    });
    e.target.value = '';
  };

  // ── Header subtitle ───────────────────────────────────────────────────────
  const headerSubtitle = useMemo(() => {
    if (isGenerating && expectedCount === null) {
      return 'Building\u2026';
    }
    if (isGenerating && expectedCount !== null) {
      return `${generatedCount} of ${expectedCount} agents`;
    }
    const parts: string[] = [`${agentFiles.length} agent${agentFiles.length !== 1 ? 's' : ''}`];
    if (mockFiles.length > 0)
      parts.push(`${mockFiles.length} mock${mockFiles.length !== 1 ? 's' : ''}`);
    if (uploadFiles.length > 0)
      parts.push(`${uploadFiles.length} upload${uploadFiles.length !== 1 ? 's' : ''}`);
    return parts.join(' \u00b7 ');
  }, [
    isGenerating,
    expectedCount,
    generatedCount,
    agentFiles.length,
    mockFiles.length,
    uploadFiles.length,
  ]);

  return (
    <div className="flex h-full flex-col border-x border-border bg-slate-50">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border">
        <div className="px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-foreground">Files</h3>
            {isGenerating && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-accent">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                {expectedCount !== null ? `${generatedCount}/${expectedCount}` : 'Building'}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-foreground-muted">{headerSubtitle}</p>
          {uploadFiles.length > 0 && (
            <div className="mt-1.5">
              <TokenBudgetGauge used={tokenUsed} total={DEFAULT_TOKEN_BUDGET} />
            </div>
          )}
        </div>
        {/* Progress bar */}
        {isGenerating && (
          <div className="h-[2px] w-full bg-border/40">
            {progressPct !== null ? (
              <div
                className="h-full bg-accent transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            ) : (
              <div className="h-full w-1/3 animate-pulse bg-accent/60" />
            )}
          </div>
        )}
      </div>

      {/* Body */}
      {fileNames.length === 0 && allAgentNames.length === 0 ? (
        <WaitingState />
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* AGENTS group — topology-aware: shows queued rows before files arrive */}
          {allAgentNames.length > 0 && (
            <FileGroup
              label="AGENTS"
              badge={
                isGenerating ? `${generatedCount}/${allAgentNames.length}` : `${agentFiles.length}`
              }
            >
              {allAgentNames.map((name) => {
                const file = files[name];
                const isApproved = approvedAgents.includes(name);
                const isReviewing = !isApproved && currentReviewAgent === name;
                return (
                  <AgentFileRow
                    key={name}
                    name={name}
                    file={file}
                    selected={selectedFile === name}
                    onSelect={selectFile}
                    isApproved={isApproved}
                    isReviewing={isReviewing}
                  />
                );
              })}
            </FileGroup>
          )}

          {/* MOCKS group */}
          {mockFiles.length > 0 && (
            <FileGroup label="MOCKS" badge={`${mockFiles.length}`}>
              {mockFiles.map((name) => (
                <AgentFileRow
                  key={name}
                  name={name}
                  file={files[name]}
                  selected={selectedFile === name}
                  onSelect={selectFile}
                />
              ))}
            </FileGroup>
          )}

          {/* UPLOADS group */}
          <FileGroup label="UPLOADS">
            {uploadFiles.map((name) => (
              <UploadFileRow key={name} name={name} file={files[name]} />
            ))}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-accent hover:bg-background-muted/50 transition-colors"
            >
              <Plus className="h-3 w-3" />
              <span>Add files</span>
            </button>
          </FileGroup>
        </div>
      )}
    </div>
  );
}

// ─── Waiting State (topology not yet known) ───────────────────────────────

function WaitingState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <div className="flex flex-col items-center gap-2">
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-accent/50"
              style={{ animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite` }}
            />
          ))}
        </div>
        <p className="text-xs font-medium text-foreground-muted">Generating agents</p>
        <p className="text-[10px] text-foreground-subtle">
          Files will appear here as they&apos;re built
        </p>
      </div>
      {/* Skeleton placeholders */}
      <div className="w-full space-y-1.5 px-3">
        {[80, 65, 72].map((w, i) => (
          <div key={i} className="flex items-center gap-2 py-1">
            <div className="h-2 w-2 rounded-full bg-border animate-pulse" />
            <div
              className="h-2 rounded bg-border animate-pulse"
              style={{ width: `${w}%`, animationDelay: `${i * 0.15}s` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── File Group ────────────────────────────────────────────────────────────

function FileGroup({
  label,
  badge,
  children,
}: {
  label: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/50">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
          {label}
        </span>
        {badge && <span className="text-[10px] tabular-nums text-foreground-subtle">{badge}</span>}
      </div>
      {children}
    </div>
  );
}

// ─── Agent/Mock File Row ──────────────────────────────────────────────────

function AgentFileRow({
  name,
  file,
  selected,
  onSelect,
  isApproved = false,
  isReviewing = false,
}: {
  name: string;
  file?: FilePanelFile;
  selected: boolean;
  onSelect: (name: string) => void;
  isApproved?: boolean;
  isReviewing?: boolean;
}) {
  const isPending = !file;

  const isStreaming = !!file?.streamingContent;
  const isGenerating =
    file &&
    !file.content &&
    !isStreaming &&
    (file.compileStatus === 'compiling' || file.compileStatus === 'pending');

  const handleClick = () => {
    if (isPending) return;
    onSelect(name);
    const store = useArchAIStore.getState();
    const tabLabel = file.fileType === 'mock' ? (file.displayName ?? name) : name;
    const matchingTab = store.artifactTabs.find(
      (t) => t.type === 'agent_code' && t.label === tabLabel,
    );

    if (matchingTab) {
      // Update tab data with current content (final or streaming)
      const displayContent = file.content || file.streamingContent || '';
      if (displayContent) {
        store.updateTab(matchingTab.id, {
          name: file.displayName ?? name,
          content: displayContent,
          generating: isStreaming,
          ...(file.fileType === 'mock' ? { isMock: true } : {}),
        });
      }
      store.setActiveTab(matchingTab.id);
      return;
    }

    // Create tab even for empty/generating files — shows skeleton or streaming content
    store.addTab({
      type: 'agent_code',
      label: tabLabel,
      data: {
        name: file.displayName ?? name,
        content: file.content || file.streamingContent || '',
        generating: isGenerating || isStreaming,
        ...(file.fileType === 'mock' ? { isMock: true } : {}),
      },
      toolCallId: `ide-click-${name}`,
    });
  };

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className={clsx(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
        isPending && 'cursor-default opacity-50',
        !isPending && selected && 'bg-accent/15 text-accent font-medium',
        !isPending &&
          !selected &&
          'text-foreground-muted hover:bg-background-muted/50 hover:text-foreground',
        isApproved && 'opacity-60 line-through decoration-success/50',
      )}
    >
      <FileStatusIcon
        file={file}
        isApproved={isApproved}
        isReviewing={isReviewing}
        isStreaming={isStreaming}
      />
      <span className="min-w-0 flex-1 truncate">{file?.displayName ?? `${name}.abl.yaml`}</span>
      {isStreaming && (
        <span className="shrink-0 text-[10px] text-accent animate-pulse">streaming</span>
      )}
      {isReviewing && !isStreaming && (
        <span className="shrink-0 text-[10px] text-accent">reviewing</span>
      )}
      {isApproved && <span className="shrink-0 text-[10px] text-success">approved</span>}
    </button>
  );
}

// ─── Upload File Row ──────────────────────────────────────────────────────

function UploadFileRow({ name, file }: { name: string; file: FilePanelFile }) {
  const isImage = file.upload?.mediaType.startsWith('image/') ?? false;
  const Icon = isImage ? Image : FileText;

  return (
    <div className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground-muted">
      <Icon className="h-3 w-3 flex-shrink-0" />
      <span className="min-w-0 flex-1 truncate">{file.displayName ?? name}</span>
      <span className="flex-shrink-0 text-[10px]">
        {file.upload ? formatSize(file.upload.size) : ''}
      </span>
      <UploadStatusIcon file={file} />
    </div>
  );
}

// ─── Status Icons ─────────────────────────────────────────────────────────

function FileStatusIcon({
  file,
  isApproved,
  isReviewing,
  isStreaming,
}: {
  file?: FilePanelFile;
  isApproved?: boolean;
  isReviewing?: boolean;
  isStreaming?: boolean;
}) {
  if (isApproved) {
    return <Check className="h-3 w-3 text-success flex-shrink-0" />;
  }
  if (isStreaming) {
    return <Loader2 className="h-3 w-3 animate-spin text-accent flex-shrink-0" />;
  }
  if (isReviewing) {
    return <span className="h-2 w-2 animate-pulse rounded-full bg-accent flex-shrink-0 mt-px" />;
  }
  if (!file) {
    // queued / not yet generated
    return <div className="h-1.5 w-1.5 rounded-full bg-foreground/20 flex-shrink-0 mt-px" />;
  }
  switch (file.compileStatus) {
    case 'compiling':
      return <Loader2 className="h-3 w-3 animate-spin text-accent flex-shrink-0" />;
    case 'fixing':
      return <Loader2 className="h-3 w-3 animate-spin text-warning flex-shrink-0" />;
    case 'success':
      return <Check className="h-3 w-3 text-success flex-shrink-0" />;
    case 'warning':
      return <AlertTriangle className="h-3 w-3 text-warning flex-shrink-0" />;
    case 'error':
      return <X className="h-3 w-3 text-error flex-shrink-0" />;
    default:
      return <div className="h-1.5 w-1.5 rounded-full bg-foreground/20 flex-shrink-0 mt-px" />;
  }
}

function UploadStatusIcon({ file }: { file: FilePanelFile }) {
  if (!file.upload) {
    return <Circle className="h-3 w-3 text-foreground-muted flex-shrink-0" />;
  }
  switch (file.compileStatus) {
    case 'success':
      return <Check className="h-3 w-3 text-success flex-shrink-0" />;
    case 'error':
      return <X className="h-3 w-3 text-error flex-shrink-0" />;
    case 'warning':
      return <AlertTriangle className="h-3 w-3 text-warning flex-shrink-0" />;
    default:
      if (file.upload.inContext) {
        return <Check className="h-3 w-3 text-success flex-shrink-0" />;
      }
      return <Circle className="h-3 w-3 text-foreground-muted flex-shrink-0" />;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
