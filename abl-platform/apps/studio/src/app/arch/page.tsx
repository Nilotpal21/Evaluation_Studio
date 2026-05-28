'use client';

/**
 * /arch — Arch AI workspace entry point.
 * Owns session bootstrap, chat shell layout, and onboarding/build/project flow UI.
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import { AlertTriangle, RotateCcw, Settings2 } from 'lucide-react';
import { useArchChat } from '@/lib/arch-ai/ui/hook';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { authHeaders } from '@/lib/api-client';
import { ArchShell } from '@/lib/arch-ai/components/arch/layout';
import {
  ArchAssistantResponse,
  SpecialistBadge,
  UserFileChips,
  ArchEntryState,
  ArchHeroStrip,
  ScrollToBottomButton,
  BuildProgressCard,
  BuildSummaryCard,
  ChatStatusMessages,
  InlineStatus,
} from '@/lib/arch-ai/components/arch/chat';
import {
  fetchUploadedFile,
  uploadFiles,
  type UploadedFileDetails,
  type UploadedFileStatus,
} from '@/lib/arch/upload-files';
import { ARCH_AI_FILES } from '@/lib/arch-ai/constants';
import {
  normalizeArchUploadMimeType,
  resolveAcceptedArchUploadMimeType,
} from '@/lib/arch-ai/file-mime';
import { normalizeGateRequestAnswer } from '@/lib/arch-ai/gate-request';
import { recordArchStreamLog } from '@/lib/arch-ai/stream-debug';
import { OnboardingArtifactPanel, MemorySettingsPanel } from '@/lib/arch-ai/components/arch/panels';
import { WidgetRenderer } from '@/lib/arch-ai/components/arch/widgets';
import { ArchGradientMark } from '@/components/arch-shared/ArchGradientMark';
import { ChatInputBar, type ChatInputAttachment } from '@/components/chat/ChatInputBar';
import { loadProjects } from '@/api/projects';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { useArchUIStore } from '@/lib/arch-ai/ui/store';
import { markDiffResolutionInFlight } from '@/lib/arch-ai/ui/proposal-artifacts';
import { useNavigationStore } from '@/store/navigation-store';
import { usePreloadOrchestrator } from '@/lib/arch-ai/hooks/usePreloadOrchestrator';
import type { WidgetInput } from '@/lib/arch-ai/components/arch/widgets';
import type { SessionCheckpoint } from '@agent-platform/arch-ai/types';
import { isBuildExecutionActive } from '@/lib/arch-ai/ui/build-state';
import {
  buildCompleteWidgetAllowsCreate,
  canTriggerManualCreateProject,
  hasCreateProjectResultMessage,
  hasCreatedProject,
  shouldSuppressFooterActionForPendingWidget,
} from '@/lib/arch-ai/ui/create-project-state';
import { shouldRenderToolCallMessage } from '@/lib/arch-ai/ui/widget-visibility';
import {
  getBlueprintStage,
  getDraftTopology,
  getLockedTopology,
} from '@/lib/arch-ai/blueprint-flow';
import { buildBlueprintDocumentArtifact } from '@/lib/arch-ai/blueprint-document';
import type { ArchError, ChatMessage } from '@/lib/arch-ai/ui/types';

// ─── Phase pipeline ────────────────────────────────────────────────────────

const BACKEND_PHASES = ['INTERVIEW', 'BLUEPRINT', 'BUILD', 'CREATE'] as const;
type BackendPhase = (typeof BACKEND_PHASES)[number];

const DISPLAY_PHASES = [
  'INTERVIEW',
  'BLUEPRINT',
  'BUILD',
] as const satisfies readonly BackendPhase[];

const PHASE_LABELS: Record<BackendPhase, string> = {
  INTERVIEW: 'Interview',
  BLUEPRINT: 'Blueprint',
  BUILD: 'Build',
  CREATE: 'Create',
};

const ATTACHMENT_POLL_INTERVAL_MS = 1_500;
const LARGE_ATTACHMENT_WARNING_BYTES = 5 * 1024 * 1024;
const CONTEXT_WARNING_TOKEN_THRESHOLD = 12_000;
const ATTACHMENT_SLOW_PROCESSING_MS = 30_000;
const ATTACHMENT_STUCK_PROCESSING_MS = 90_000;
const ATTACHMENT_STILL_PROCESSING_CODE = 'ATTACHMENT_STILL_PROCESSING';

interface ComposerAttachmentDraft extends ChatInputAttachment {
  blobId?: string;
  tokenCost?: number;
  processingStartedAt?: number;
}

interface CurrentOnboardingSessionResponse {
  success?: boolean;
  session?: {
    id?: string;
  } | null;
  error?: {
    message?: string;
  };
  errors?: Array<{
    msg?: string;
  }>;
}

function parseApiErrorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    Array.isArray((payload as { errors?: Array<{ msg?: string }> }).errors)
  ) {
    const first = (payload as { errors: Array<{ msg?: string }> }).errors.find(
      (entry) => typeof entry.msg === 'string' && entry.msg.trim().length > 0,
    );
    if (first?.msg) {
      return first.msg;
    }
  }

  if (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { error?: { message?: string } }).error?.message === 'string'
  ) {
    return (payload as { error: { message: string } }).error.message;
  }

  return fallback;
}

function mapUploadedFileStatus(
  status: UploadedFileStatus | undefined,
): ComposerAttachmentDraft['status'] {
  if (status === 'failed' || status === 'blocked') {
    return 'failed';
  }
  if (status === 'processing') {
    return 'processing';
  }
  return 'ready';
}

function isArchRequestErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function getAttachmentProcessingLabel(mediaType: string): string {
  if (mediaType === 'application/pdf') {
    return 'Extracting text from PDF...';
  }
  if (
    mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mediaType.startsWith('text/')
  ) {
    return 'Extracting document text...';
  }
  if (mediaType.startsWith('image/')) {
    return 'Scanning image...';
  }
  return 'Scanning and extracting content...';
}

function buildAttachmentProcessingDetail(details: {
  mediaType: string;
  processingStartedAt?: number;
  now?: number;
}): string {
  if (details.processingStartedAt) {
    const elapsedMs = (details.now ?? Date.now()) - details.processingStartedAt;
    if (elapsedMs >= ATTACHMENT_STUCK_PROCESSING_MS) {
      return 'Still processing. You can wait or remove and upload it again.';
    }
    if (elapsedMs >= ATTACHMENT_SLOW_PROCESSING_MS) {
      return 'Still extracting. Large PDFs and documents can take a minute.';
    }
  }

  return getAttachmentProcessingLabel(details.mediaType);
}

function normalizeAttachmentFailureReason(reason?: string | null): string | null {
  if (!reason) {
    return null;
  }

  const failedMatch = reason.match(/^\[Failed to process: .+? — (.+)\]$/);
  if (failedMatch?.[1]) {
    return failedMatch[1];
  }

  if (/^\[(File unavailable|File still processing|Unsupported file|File blocked):/.test(reason)) {
    return null;
  }

  return reason;
}

function buildAttachmentDetail(details: {
  status: ComposerAttachmentDraft['status'];
  unavailableReason?: string | null;
  size: number;
  tokenCost?: number;
  mediaType: string;
  processingStartedAt?: number;
  now?: number;
}): string | null {
  if (details.status === 'failed') {
    return (
      normalizeAttachmentFailureReason(details.unavailableReason) ??
      'This file could not be prepared.'
    );
  }

  if (details.status === 'processing') {
    return buildAttachmentProcessingDetail({
      mediaType: details.mediaType,
      processingStartedAt: details.processingStartedAt,
      now: details.now,
    });
  }

  const hints: string[] = [];
  if (details.size >= LARGE_ATTACHMENT_WARNING_BYTES) {
    hints.push('Large file');
  }
  if ((details.tokenCost ?? 0) >= CONTEXT_WARNING_TOKEN_THRESHOLD) {
    hints.push('May be summarized to fit context');
  }

  return hints.length > 0 ? hints.join(' • ') : null;
}

function buildComposerAttachmentFromUpload(
  id: string,
  file: File,
  result: {
    blobId: string;
    tokenCost?: number;
    status?: UploadedFileStatus;
    unavailableReason?: string | null;
  },
): ComposerAttachmentDraft {
  const status = mapUploadedFileStatus(result.status);
  const processingStartedAt = status === 'processing' ? Date.now() : undefined;
  const mediaType = normalizeArchUploadMimeType(file.name, file.type);
  return {
    id,
    blobId: result.blobId,
    name: file.name,
    size: file.size,
    mediaType,
    status,
    tokenCost: result.tokenCost,
    processingStartedAt,
    detail: buildAttachmentDetail({
      status,
      unavailableReason: result.unavailableReason,
      size: file.size,
      tokenCost: result.tokenCost,
      mediaType,
      processingStartedAt,
    }),
  };
}

function buildComposerAttachmentFromStatus(
  status: UploadedFileDetails,
  previous?: ComposerAttachmentDraft,
  now = Date.now(),
): ComposerAttachmentDraft {
  const mappedStatus = mapUploadedFileStatus(status.status);
  const processingStartedAt =
    mappedStatus === 'processing' ? (previous?.processingStartedAt ?? now) : undefined;
  return {
    id: status.blobId,
    blobId: status.blobId,
    name: status.name,
    size: status.size,
    mediaType: status.mediaType,
    status: mappedStatus,
    tokenCost: status.tokenCost,
    processingStartedAt,
    detail: buildAttachmentDetail({
      status: mappedStatus,
      unavailableReason: status.unavailableReason,
      size: status.size,
      tokenCost: status.tokenCost,
      mediaType: status.mediaType,
      processingStartedAt,
      now,
    }),
  };
}

function validateAttachmentFile(file: File): { mediaType: string } | { error: string } {
  if (file.size <= 0) {
    return { error: 'File is empty.' };
  }

  if (file.size > ARCH_AI_FILES.MAX_FILE_SIZE_BYTES) {
    return {
      error: `File exceeds ${(ARCH_AI_FILES.MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0)}MB limit.`,
    };
  }

  const mediaType = resolveAcceptedArchUploadMimeType(file.name, file.type);
  if (!mediaType) {
    return {
      error: `Unsupported file type. Allowed: ${ARCH_AI_FILES.ACCEPTED_UPLOAD_EXTENSIONS.join(', ')}`,
    };
  }

  return { mediaType };
}

function PhasePipeline({
  currentPhase,
  revealedPhases,
}: {
  currentPhase: string | null | undefined;
  revealedPhases?: readonly string[];
}) {
  const currentIdx = currentPhase ? BACKEND_PHASES.indexOf(currentPhase as BackendPhase) : -1;
  const useRevealedLogic = revealedPhases !== undefined;
  const lastRevealed = revealedPhases ? revealedPhases[revealedPhases.length - 1] : undefined;

  return (
    <div className="flex items-center gap-2">
      {DISPLAY_PHASES.map((phase, idx) => {
        let isCompleted: boolean;
        let isActive: boolean;
        if (useRevealedLogic) {
          const isRevealed = revealedPhases!.includes(phase);
          isActive = phase === lastRevealed;
          isCompleted = isRevealed && !isActive;
        } else {
          isCompleted = idx < currentIdx;
          isActive = idx === currentIdx;
        }

        return (
          <div key={phase} className="flex items-center gap-2">
            {idx > 0 && <div className="h-px w-4 shrink-0 bg-border" />}
            <div className="flex items-center gap-1.5">
              <span
                className={clsx(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  isActive && 'animate-badge-pulse bg-accent',
                  isCompleted && 'bg-success',
                  !isActive && !isCompleted && 'bg-border',
                )}
              />
              <span
                className={clsx(
                  'whitespace-nowrap font-mono text-[10px] uppercase tracking-widest',
                  isActive && 'font-medium text-foreground',
                  isCompleted && 'text-foreground-subtle',
                  !isActive && !isCompleted && 'text-foreground-subtle/50',
                )}
              >
                {PHASE_LABELS[phase]}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function getCtaLabel(phase: string | null | undefined, projectCreated: boolean): string {
  if (!phase) return 'Loading...';
  switch (phase) {
    case 'INTERVIEW':
    case 'BLUEPRINT':
      return 'Continue';
    case 'BUILD':
    case 'CREATE':
      return projectCreated ? 'Project Created' : 'Create Project';
    default:
      return 'Continue';
  }
}

function ProjectReadyCard({
  projectName,
  projectId,
  requestId,
  sessionId,
  onOpenProject,
}: {
  projectName?: string;
  projectId: string;
  requestId?: string;
  sessionId: string | null;
  onOpenProject: () => void;
}) {
  const didLogRenderRef = useRef(false);

  useEffect(() => {
    if (didLogRenderRef.current) {
      return;
    }
    didLogRenderRef.current = true;
    recordArchStreamLog({
      requestId: requestId ?? `create_project:${projectId}`,
      sessionId,
      direction: 'client',
      type: 'create_success_card_rendered',
      level: 'info',
      data: {
        projectId,
        projectName: projectName ?? null,
      },
    });
  }, [projectId, projectName, requestId, sessionId]);

  return (
    <div className="px-4 py-6">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-success/20 bg-success/[0.04] py-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
          <svg
            className="h-6 w-6 text-success"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-lg font-semibold text-success">Your project is ready</p>
          {projectName && <p className="text-sm text-foreground/50">{projectName}</p>}
        </div>
        <button
          onClick={onOpenProject}
          className="rounded-lg bg-accent px-6 py-2.5 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90"
        >
          Open Project &rarr;
        </button>
      </div>
    </div>
  );
}

// ─── Error Screen ─────────────────────────────────────────────────────────

const ARCH_SETUP_ERROR_PATTERNS = [
  'no api key configured',
  'no direct api key is configured',
  'api key not configured',
  'no llm configured',
  'could not find a usable model',
  'configure platform credits',
  'choose a model hub model',
  'open admin > arch',
  'saved direct api key',
  'saved platform credits',
  'saved model hub selection',
  'saved auth profile',
  'platform credits are not available',
  'no active model hub model is ready for arch',
  'anthropic_api_key',
  'openai_api_key',
  'gemini_api_key',
  'google_api_key',
] as const;

function isApiKeyError(err: { message: string; type?: string } | string | null): boolean {
  if (!err) return false;
  const text = typeof err === 'string' ? err : err.message;
  const type = typeof err === 'string' ? undefined : err.type;
  const lower = text.toLowerCase();
  // Only promote true setup/configuration problems into the full-page takeover.
  // Provider auth failures (invalid/expired keys) should stay inline in chat.
  if (type && type !== 'network_error' && type !== 'generic') {
    return false;
  }
  return ARCH_SETUP_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

function ArchErrorScreen({ error }: { error: string }) {
  const isKeyError = isApiKeyError(error);
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-6 overflow-hidden bg-background-subtle px-6">
      {/* Dot grid pattern */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, hsl(var(--foreground) / 0.07) 1px, transparent 1px), radial-gradient(circle, hsl(var(--foreground) / 0.07) 1px, transparent 1px)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 8px 8px',
        }}
      />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-error/10">
        <AlertTriangle className="h-7 w-7 text-error" />
      </div>
      <div className="relative flex flex-col items-center gap-2 text-center">
        <h2 className="text-lg font-semibold text-foreground">
          {isKeyError ? 'API Key Not Configured' : 'Unable to start Arch'}
        </h2>
        <p className="max-w-sm text-sm text-foreground-muted">{error}</p>
      </div>
      {isKeyError && (
        <a
          href="/admin/arch"
          className="relative rounded-md bg-accent px-5 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
        >
          Configure in Admin &rarr;
        </a>
      )}
    </div>
  );
}

function ArchErrorActionLine({ error, onRetry }: { error: ArchError; onRetry?: () => void }) {
  return (
    <p className="text-sm leading-6 text-error">
      <span>{error.message}</span>{' '}
      {!error.recoverable && (
        <a
          href="/admin/arch"
          className="font-medium text-blue-600 underline-offset-2 transition-colors hover:text-blue-700 hover:underline"
        >
          Open Arch Settings
        </a>
      )}
      {error.recoverable && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="font-medium text-blue-600 underline-offset-2 transition-colors hover:text-blue-700 hover:underline"
        >
          Retry
        </button>
      )}
    </p>
  );
}

// ─── Loading Screen ────────────────────────────────────────────────────────

const LOADING_STEPS = [
  'Connecting to Arch...',
  'Loading your workspace...',
  'Checking previous sessions...',
  'Preparing agent toolkit...',
  'Almost ready...',
];

function ArchLoadingScreen() {
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setStepIdx((i) => Math.min(i + 1, LOADING_STEPS.length - 1));
    }, 900);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-8 overflow-hidden bg-background-subtle">
      {/* Dot grid pattern */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, hsl(var(--foreground) / 0.07) 1px, transparent 1px), radial-gradient(circle, hsl(var(--foreground) / 0.07) 1px, transparent 1px)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 8px 8px',
        }}
      />
      {/* Arch icon with pulse ring */}
      <div className="relative flex items-center justify-center">
        <span className="absolute h-16 w-16 animate-ping rounded-full bg-foreground/10" />
        <ArchGradientMark size="lg" className="relative" />
      </div>

      {/* Progress step — one at a time */}
      <div className="flex h-6 items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.span
            key={stepIdx}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className="font-mono text-xs text-foreground-muted"
          >
            {LOADING_STEPS[stepIdx]}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Checkpoint Timeline ──────────────────────────────────────────────────

const TRIGGER_LABELS: Record<string, string> = {
  phase_transition: 'Phase gate',
  build_complete: 'Build done',
  topology_approved: 'Topology OK',
  mutation_applied: 'Mutation',
};

const PHASE_ORDER = ['INTERVIEW', 'BLUEPRINT', 'BUILD', 'REVIEW', 'DEPLOY'];

function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function checkpointSummaryText(cp: SessionCheckpoint): string {
  const parts: string[] = [];
  const topology = cp.stateSnapshot.topology as Record<string, unknown> | undefined;
  const agents = topology?.agents;
  const agentCount = Array.isArray(agents)
    ? agents.length
    : typeof agents === 'object' && agents !== null
      ? Object.keys(agents).length
      : 0;
  if (agentCount > 0) {
    parts.push(`${agentCount} agent${agentCount === 1 ? '' : 's'}`);
  }
  const pattern = topology?.pattern as string | undefined;
  if (pattern) parts.push(`${pattern} pattern`);
  if (cp.stateSnapshot.topologyApproved) parts.push('topology approved');
  const buildStage = cp.stateSnapshot.buildProgress?.stage;
  if (buildStage) {
    parts.push(buildStage === 'complete' ? 'build complete' : `build ${buildStage}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'Session snapshot';
}

function CheckpointTimeline({
  checkpoints,
  currentPhase,
  onRollback,
}: {
  checkpoints: SessionCheckpoint[];
  currentPhase: string | null;
  onRollback: (checkpointId: string, phase: string, checkpoint: SessionCheckpoint) => void;
}) {
  if (checkpoints.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      <RotateCcw className="mr-1 h-3 w-3 text-foreground-subtle/60" />
      {checkpoints.map((cp, idx) => (
        <div key={cp.checkpointId} className="group relative">
          <button
            onClick={() => onRollback(cp.checkpointId, cp.phase, cp)}
            className={clsx(
              'h-2 w-2 rounded-full transition-all',
              'bg-foreground-subtle/30 hover:bg-accent hover:scale-150',
              idx === checkpoints.length - 1 && 'bg-foreground-subtle/50',
            )}
            aria-label={`Rollback to ${cp.phase} (${TRIGGER_LABELS[cp.trigger] ?? cp.trigger})`}
          />
          {/* Enhanced hover tooltip with checkpoint details */}
          <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 rounded-lg border border-border bg-background-elevated px-3 py-2 opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
            <div className="flex flex-col gap-1 whitespace-nowrap">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                {cp.phase}
              </div>
              <div className="text-[10px] text-foreground-muted">
                {TRIGGER_LABELS[cp.trigger] ?? cp.trigger} \u2014 {formatRelativeTime(cp.timestamp)}
              </div>
              <div className="mt-0.5 text-[10px] text-foreground-subtle">
                {checkpointSummaryText(cp)}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Preview modal content: shows what changes on rollback. */
function RollbackPreviewModal({
  checkpoint,
  currentPhase,
  onConfirm,
  onCancel,
}: {
  checkpoint: SessionCheckpoint;
  currentPhase: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const currentPhaseIdx = PHASE_ORDER.indexOf(currentPhase ?? '');
  const targetPhaseIdx = PHASE_ORDER.indexOf(checkpoint.phase);
  const phasesLost =
    currentPhaseIdx > targetPhaseIdx
      ? PHASE_ORDER.slice(targetPhaseIdx + 1, currentPhaseIdx + 1)
      : [];

  const topology = checkpoint.stateSnapshot.topology as Record<string, unknown> | undefined;
  const agents = topology?.agents;
  const agentCount = Array.isArray(agents)
    ? agents.length
    : typeof agents === 'object' && agents !== null
      ? Object.keys(agents).length
      : 0;

  const buildStage = checkpoint.stateSnapshot.buildProgress?.stage;
  const pattern = topology?.pattern as string | undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-xl">
        <h3 className="text-base font-semibold text-foreground">
          Roll back to {checkpoint.phase}?
        </h3>
        <p className="mt-1 text-xs text-foreground-muted">
          {formatRelativeTime(checkpoint.timestamp)} \u2014{' '}
          {TRIGGER_LABELS[checkpoint.trigger] ?? checkpoint.trigger}
        </p>

        <div className="mt-4 space-y-3">
          {/* What will be restored */}
          <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-2">
            <div className="text-xs font-medium text-success">Restored</div>
            <ul className="mt-1 space-y-0.5 text-xs text-foreground-muted">
              <li>
                Phase: <span className="font-medium text-foreground">{checkpoint.phase}</span>
              </li>
              {agentCount > 0 && (
                <li>
                  Topology: {agentCount} agent{agentCount === 1 ? '' : 's'}
                  {pattern ? ` (${pattern})` : ''}
                </li>
              )}
              {checkpoint.stateSnapshot.topologyApproved && <li>Topology approval status</li>}
              {checkpoint.stateSnapshot.specification != null && <li>Specification document</li>}
              {buildStage && (
                <li>Build progress: {buildStage === 'complete' ? 'completed' : buildStage}</li>
              )}
            </ul>
          </div>

          {/* What will be lost */}
          {phasesLost.length > 0 && (
            <div className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2">
              <div className="text-xs font-medium text-warning">Progress lost</div>
              <ul className="mt-1 space-y-0.5 text-xs text-foreground-muted">
                {phasesLost.map((p) => (
                  <li key={p}>{p} phase progress will be reset</li>
                ))}
                {currentPhase === 'BUILD' && checkpoint.phase !== 'BUILD' && (
                  <li>All compiled agents will be cleared</li>
                )}
              </ul>
            </div>
          )}
          {phasesLost.length === 0 && currentPhase === checkpoint.phase && (
            <div className="rounded-lg border border-border bg-background-muted px-3 py-2">
              <div className="text-xs font-medium text-foreground-muted">Same phase</div>
              <p className="mt-1 text-xs text-foreground-subtle">
                Rolling back to an earlier point within the {checkpoint.phase} phase. Changes made
                after this checkpoint will be lost.
              </p>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-background-muted"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-warning px-4 py-2 text-sm font-medium text-foreground transition-opacity hover:opacity-90"
          >
            Roll back
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function ArchPage() {
  const {
    messages,
    state: chatState,
    currentSpecialist,
    phase,
    error,
    statusMessage,
    statusMessages,
    send,
    sendToolAnswer,
    sendGateResponse,
    sendCreate,
    session,
    resume,
    checkpoints,
    rollback,
    loadSession,
    refreshSession,
    clearSession,
    stop,
    retry,
    startFresh,
  } = useArchChat();

  const navigateTo = useNavigationStore((s) => s.navigate);
  const [initialized, setInitialized] = useState(false);
  const [acknowledgedSession, setAcknowledgedSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionTransitioning, setSessionTransitioning] = useState(false);
  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);
  const [showMemorySettings, setShowMemorySettings] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<{
    checkpointId: string;
    phase: string;
    checkpoint: SessionCheckpoint;
  } | null>(null);
  // Spec fields to show after the user picks a name from the name-suggestion widget.
  const [specOverride, setSpecOverride] = useState<{
    projectName?: string;
    description?: string;
  } | null>(null);
  const [surfaceError, setSurfaceError] = useState<ArchError | null>(null);
  // Stores the description from the most recently clicked chip
  const pendingChipDescRef = useRef<string | null>(null);

  const { preloadState, startPreload } = usePreloadOrchestrator(session);
  const sessionMessageCount = (session?.metadata.messages as unknown[])?.length ?? 0;
  const resumeGateVisible = !!session && !acknowledgedSession && sessionMessageCount > 0;

  // Mount: load ONBOARDING-scoped session, auto-archive COMPLETE, show resume dialog.
  // loadSession is stable (useCallback([]) in hook), so [] dep runs exactly once.
  useEffect(() => {
    async function init() {
      const statusPromise = fetch('/api/arch/status', { headers: authHeaders() }).catch(
        (err: unknown) => {
          console.warn('[arch-ai] status preflight failed', err);
          return null;
        },
      );
      const [, statusRes] = await Promise.all([loadSession('ONBOARDING'), statusPromise]);
      if (statusRes?.ok) {
        try {
          const { data } = await statusRes.json();
          const statusError =
            typeof data?.error === 'string' && data.error.trim().length > 0 ? data.error : null;
          if (data && !data.configured) {
            const msg =
              statusError ??
              'No AI model is configured for Arch. Go to Admin > Arch settings to select a model.';
            const nextError: ArchError = {
              message: msg,
              type: 'generic',
              recoverable: false,
            };
            useArchUIStore.getState().setError(nextError);
            setSurfaceError(nextError);
          } else if (data?.configured) {
            useArchUIStore.getState().setError(null);
            setSurfaceError(null);
          }
        } catch (parseErr: unknown) {
          console.warn('[arch-ai] status preflight parse failed', parseErr);
        }
      }
      setInitialized(true);
    }
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error && !isApiKeyError(error)) {
      setSurfaceError(error);
    }
  }, [error]);

  useEffect(() => {
    if (!error && chatState === 'streaming') {
      setSurfaceError((prev) => (prev?.recoverable ? null : prev));
    }
  }, [chatState, error]);

  // After session loads: auto-archive terminal sessions; configure resume gating
  // for newly surfaced sessions. Fresh blank sessions should never bounce back
  // into the resume card after their first message.
  useEffect(() => {
    if (!initialized || !session) return;

    if (session.state === 'COMPLETE' || session.state === 'GATE_PENDING') {
      // Contract 2: auto-archive on mount for COMPLETE sessions.
      // Also auto-archive GATE_PENDING sessions — these are stuck legacy sessions
      // from the pre-gate-free era. They cannot be resumed under the current design;
      // archive immediately and start fresh rather than showing a broken resume card.
      fetch(`/api/arch-ai/sessions/${session.id}/archive`, {
        method: 'POST',
        headers: authHeaders(),
      })
        .then(() => {
          clearSession();
          // After archiving, create a fresh session
          return fetch('/api/arch-ai/sessions', {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
        })
        .then(() => loadSession('ONBOARDING'));
      return;
    }

    const surfacedMessageCount = (session.metadata.messages as unknown[])?.length ?? 0;
    setAcknowledgedSession(surfacedMessageCount === 0);
  }, [initialized, session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshActiveWidgetSession = useCallback(async () => {
    const projectId = session?.metadata.projectId;
    if (
      session?.metadata.mode === 'IN_PROJECT' &&
      typeof projectId === 'string' &&
      projectId.length > 0
    ) {
      await refreshSession('IN_PROJECT', projectId);
      return;
    }

    await refreshSession('ONBOARDING');
  }, [refreshSession, session?.metadata.mode, session?.metadata.projectId]);

  const handleWidgetSubmit = useCallback(
    async (
      toolName: string,
      toolCallId: string,
      answer: unknown,
      secrets?: { flowId: string; values: Record<string, string> },
    ) => {
      if (toolName === 'gate_request') {
        const gateAnswer = normalizeGateRequestAnswer(answer);
        if (gateAnswer) {
          pendingChipDescRef.current = null;
          await sendGateResponse(gateAnswer.action, gateAnswer.feedback);
          await refreshActiveWidgetSession();
          return;
        }
      }

      // If a chip was clicked before this widget answer, treat the answer as the
      // project name and pair it with the chip's pre-set description.
      if (pendingChipDescRef.current !== null && typeof answer === 'string') {
        setSpecOverride({ projectName: answer, description: pendingChipDescRef.current });
        pendingChipDescRef.current = null;
      }
      if (session?.metadata.mode === 'IN_PROJECT') {
        markDiffResolutionInFlight(toolCallId);
      }
      await sendToolAnswer(toolCallId, answer, secrets);
      if (session?.metadata.mode !== 'IN_PROJECT') {
        await refreshActiveWidgetSession();
      }
    },
    [sendToolAnswer, sendGateResponse, refreshActiveWidgetSession, session?.metadata.mode],
  );

  const handleSpecUpdate = useCallback(
    async (field: string, value: unknown) => {
      if (!session) return;
      await fetch('/api/arch-ai/message', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.id,
          type: 'message',
          text: `Please update the specification: set ${field} to ${JSON.stringify(value)}`,
        }),
      });
      await refreshSession('ONBOARDING');
    },
    [session, refreshSession],
  );

  // Clear specOverride once the session's real spec has the project name we set.
  useEffect(() => {
    if (!specOverride?.projectName) return;
    const sessionProjectName = (
      session?.metadata?.specification as Record<string, unknown> | undefined
    )?.projectName as string | undefined;
    if (sessionProjectName && sessionProjectName === specOverride.projectName) {
      setSpecOverride(null);
    }
  }, [session?.metadata?.specification, specOverride]);

  const { scrollRef, showScrollButton, scrollToBottom, onUserSent } = useAutoScroll(
    messages.length,
    chatState,
  );

  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachmentDraft[]>([]);
  // B05v2: Index of first message with thinkingText (for expanded-first-time behavior)
  const firstThinkingIdx = useMemo(() => messages.findIndex((m) => m.thinkingText), [messages]);

  // BUILD phase: extract topology agent names for BuildProgressCard
  const topologyAgentNames = useMemo(() => {
    const topology =
      (session ? getLockedTopology(session) : null) ??
      (session?.metadata?.topology as { agents?: Array<{ name: string }> } | undefined);
    return topology?.agents?.map((a) => a.name) ?? [];
  }, [session]);
  const isBuildWithCard = phase === 'BUILD' && topologyAgentNames.length > 0;
  const getVisibleActivityGroups = useCallback(
    (groups: ChatMessage['activityGroups']) =>
      isBuildWithCard ? groups?.filter((group) => !/^build[-:]/.test(group.id)) : groups,
    [isBuildWithCard],
  );
  const hasVisibleActivityPanel = useMemo(
    () =>
      messages.some((message) => {
        const visibleGroups = getVisibleActivityGroups(message.activityGroups);
        return Boolean(
          message.isStreaming &&
          ((visibleGroups?.length ?? 0) > 0 || (message.thinkingText ?? '').length > 0),
        );
      }),
    [getVisibleActivityGroups, messages],
  );
  const liveStatusMessages = useMemo(
    () =>
      statusMessages.filter(
        (message) => message.id !== 'v2-status' || message.text !== statusMessage,
      ),
    [statusMessage, statusMessages],
  );

  const clearComposerAttachments = useCallback(() => {
    setComposerAttachments([]);
  }, []);

  const updateComposerAttachment = useCallback(
    (
      attachmentId: string,
      updater: (current: ComposerAttachmentDraft) => ComposerAttachmentDraft,
    ) => {
      setComposerAttachments((prev) =>
        prev.map((attachment) =>
          attachment.id === attachmentId ? updater(attachment) : attachment,
        ),
      );
    },
    [],
  );

  const createOnboardingSession = useCallback(
    async (options: { force?: boolean; threadId?: string } = {}): Promise<string> => {
      const response = await fetch('/api/arch-ai/sessions', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(options.force ? { force: true } : {}),
          ...(options.threadId ? { threadId: options.threadId } : {}),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        sessionId?: string;
        session?: { metadata?: { threadId?: string } };
        errors?: Array<{ msg?: string }>;
      };

      if (!response.ok || !payload.success || typeof payload.sessionId !== 'string') {
        throw new Error(parseApiErrorMessage(payload, 'Failed to create a session.'));
      }

      const threadId = payload.session?.metadata?.threadId ?? options.threadId;
      await loadSession('ONBOARDING', undefined, threadId ? { threadId } : undefined);
      return payload.sessionId;
    },
    [loadSession],
  );

  const fetchCurrentOnboardingSessionId = useCallback(async (): Promise<string | null> => {
    const response = await fetch('/api/arch-ai/sessions/current?mode=ONBOARDING', {
      headers: authHeaders(),
    });
    const payload = (await response.json().catch(() => ({}))) as CurrentOnboardingSessionResponse;

    if (!response.ok || !payload.success) {
      throw new Error(parseApiErrorMessage(payload, 'Failed to load the current session.'));
    }

    return typeof payload.session?.id === 'string' ? payload.session.id : null;
  }, []);

  const ensureOnboardingSession = useCallback(async (): Promise<string> => {
    setSessionTransitioning(true);
    setSessionError(null);
    try {
      if (session && resumeGateVisible) {
        return await createOnboardingSession({ force: true });
      }

      const liveSessionId = await fetchCurrentOnboardingSessionId();
      if (liveSessionId) {
        if (liveSessionId !== session?.id) {
          await loadSession('ONBOARDING');
        }
        return liveSessionId;
      }

      return await createOnboardingSession();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setSessionError(message);
      throw err;
    } finally {
      setSessionTransitioning(false);
    }
  }, [
    session,
    resumeGateVisible,
    createOnboardingSession,
    fetchCurrentOnboardingSessionId,
    loadSession,
  ]);

  // Start a fresh hidden thread — used by Dismiss and New Chat.
  const archiveAndStartFresh = useCallback(async () => {
    if (!session) return;
    setSurfaceError(null);
    setSessionTransitioning(true);
    setSessionError(null);
    try {
      clearSession();
      useArchAIStore.getState().resetProjectState();
      clearComposerAttachments();
      await createOnboardingSession({ force: true });
    } catch (err: unknown) {
      setSessionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionTransitioning(false);
    }
  }, [session, clearSession, clearComposerAttachments, createOnboardingSession]);

  const uploadComposerAttachment = useCallback(
    async (attachmentId: string, file: File, sessionId: string) => {
      try {
        const [result] = await uploadFiles(sessionId, [file], (_index, progress) => {
          updateComposerAttachment(attachmentId, (current) => ({
            ...current,
            progress,
            detail: progress >= 1 ? 'Preparing attachment...' : 'Uploading...',
          }));
        });

        updateComposerAttachment(attachmentId, () =>
          buildComposerAttachmentFromUpload(attachmentId, file, result),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        updateComposerAttachment(attachmentId, (current) => ({
          ...current,
          status: 'failed',
          progress: undefined,
          detail: message,
        }));
      }
    },
    [updateComposerAttachment],
  );

  const handleComposerAttachFiles = useCallback(
    async (selectedFiles: File[]) => {
      if (
        selectedFiles.length === 0 ||
        sessionTransitioning ||
        (chatState !== 'idle' && chatState !== 'widget_pending')
      ) {
        return;
      }

      const remainingSlots = Math.max(0, ARCH_AI_FILES.MAX_FILES - composerAttachments.length);
      if (remainingSlots === 0) {
        setSessionError(`You can attach up to ${ARCH_AI_FILES.MAX_FILES} files in one message.`);
        return;
      }

      const existingKeys = new Set(
        composerAttachments.map(
          (attachment) => `${attachment.name}:${attachment.size}:${attachment.mediaType}`,
        ),
      );
      const acceptedPairs: Array<{ file: File; draft: ComposerAttachmentDraft }> = [];
      const rejectedDrafts: ComposerAttachmentDraft[] = [];

      for (const file of selectedFiles) {
        const validation = validateAttachmentFile(file);
        const mediaType =
          'mediaType' in validation
            ? validation.mediaType
            : normalizeArchUploadMimeType(file.name, file.type);
        const dedupeKey = `${file.name}:${file.size}:${mediaType}`;
        if (existingKeys.has(dedupeKey)) {
          continue;
        }
        existingKeys.add(dedupeKey);

        if ('error' in validation) {
          rejectedDrafts.push({
            id: crypto.randomUUID(),
            name: file.name,
            size: file.size,
            mediaType,
            status: 'failed',
            detail: validation.error,
          });
        } else {
          acceptedPairs.push({
            file,
            draft: {
              id: crypto.randomUUID(),
              name: file.name,
              size: file.size,
              mediaType: validation.mediaType,
              status: 'uploading',
              progress: 0,
              detail: 'Uploading...',
            },
          });
        }

        if (acceptedPairs.length + rejectedDrafts.length >= remainingSlots) {
          break;
        }
      }

      if (acceptedPairs.length === 0 && rejectedDrafts.length === 0) {
        return;
      }

      setSessionError(null);

      const draftAttachments = acceptedPairs.map((pair) => pair.draft);

      setComposerAttachments((prev) => [...prev, ...draftAttachments, ...rejectedDrafts]);

      if (acceptedPairs.length === 0) {
        return;
      }

      try {
        const sessionId = await ensureOnboardingSession();
        await Promise.all(
          acceptedPairs.map(({ draft, file }) =>
            uploadComposerAttachment(draft.id, file, sessionId),
          ),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setComposerAttachments((prev) =>
          prev.map((attachment) =>
            draftAttachments.some((draft) => draft.id === attachment.id)
              ? {
                  ...attachment,
                  status: 'failed',
                  progress: undefined,
                  detail: message,
                }
              : attachment,
          ),
        );
      }
    },
    [
      chatState,
      composerAttachments,
      ensureOnboardingSession,
      sessionTransitioning,
      updateComposerAttachment,
      uploadComposerAttachment,
    ],
  );

  const refreshReadyAttachmentsBeforeSend = useCallback(
    async (
      readyAttachments: Array<ComposerAttachmentDraft & { blobId: string }>,
    ): Promise<boolean> => {
      if (readyAttachments.length === 0) {
        return true;
      }

      const now = Date.now();
      const results = await Promise.all(
        readyAttachments.map(async (attachment) => ({
          id: attachment.id,
          details: await fetchUploadedFile(attachment.blobId),
        })),
      );

      const allReady = results.every(
        (result) => mapUploadedFileStatus(result.details.status) === 'ready',
      );
      setComposerAttachments((prev) =>
        prev.map((attachment) => {
          const result = results.find((entry) => entry.id === attachment.id);
          if (!result) {
            return attachment;
          }

          const next = buildComposerAttachmentFromStatus(result.details, attachment, now);
          return {
            ...next,
            id: attachment.id,
          };
        }),
      );

      return allReady;
    },
    [],
  );

  const removeComposerAttachment = useCallback((attachmentId: string) => {
    setComposerAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
  }, []);

  const handleChatBarSend = useCallback(
    async (text: string, files?: File[]) => {
      const trimmedText = text.trim();
      const fallbackFiles = files ?? [];
      const readyAttachments = composerAttachments.filter(
        (attachment): attachment is ComposerAttachmentDraft & { blobId: string } =>
          attachment.status === 'ready' && typeof attachment.blobId === 'string',
      );

      if (sessionTransitioning || (chatState !== 'idle' && chatState !== 'widget_pending')) {
        return;
      }
      if (!trimmedText && readyAttachments.length === 0 && fallbackFiles.length === 0) {
        return;
      }

      setSessionError(null);

      try {
        const sessionId = await ensureOnboardingSession();
        if (fallbackFiles.length > 0) {
          const results = await uploadFiles(sessionId, fallbackFiles, undefined, {
            waitForReady: true,
          });
          const refs = results.map((result, index) => ({
            blobId: result.blobId,
            name: fallbackFiles[index]?.name,
            type: fallbackFiles[index]
              ? normalizeArchUploadMimeType(fallbackFiles[index].name, fallbackFiles[index].type)
              : undefined,
            size: fallbackFiles[index]?.size,
          }));
          onUserSent();
          await send(trimmedText, undefined, refs);
        } else {
          const attachmentsReady = await refreshReadyAttachmentsBeforeSend(readyAttachments);
          if (!attachmentsReady) {
            setSessionError(
              "One or more attachments are still being prepared. You can send when they're ready.",
            );
            return;
          }

          onUserSent();
          await send(
            trimmedText,
            undefined,
            readyAttachments.map((attachment) => ({
              blobId: attachment.blobId,
              name: attachment.name,
              type: attachment.mediaType,
              size: attachment.size,
            })),
          );
          clearComposerAttachments();
        }
        await refreshSession('ONBOARDING');
      } catch (err: unknown) {
        if (isArchRequestErrorWithCode(err, ATTACHMENT_STILL_PROCESSING_CODE)) {
          const now = Date.now();
          setComposerAttachments((prev) =>
            prev.map((attachment) =>
              readyAttachments.some((ready) => ready.id === attachment.id)
                ? {
                    ...attachment,
                    status: 'processing',
                    processingStartedAt: attachment.processingStartedAt ?? now,
                    detail: buildAttachmentProcessingDetail({
                      mediaType: attachment.mediaType,
                      processingStartedAt: attachment.processingStartedAt ?? now,
                      now,
                    }),
                  }
                : attachment,
            ),
          );
          setSessionError(
            "One or more attachments are still being prepared. You can send when they're ready.",
          );
          return;
        }
        setSessionError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      chatState,
      clearComposerAttachments,
      composerAttachments,
      ensureOnboardingSession,
      refreshReadyAttachmentsBeforeSend,
      sessionTransitioning,
      send,
      refreshSession,
      onUserSent,
    ],
  );

  const handleStartFresh = useCallback(async () => {
    setSurfaceError(null);
    clearComposerAttachments();
    await startFresh();
  }, [clearComposerAttachments, startFresh]);

  // Stable key: only re-register the interval when the SET of pending blob IDs
  // actually changes (not when the composerAttachments array reference changes
  // after an unrelated setState, which would leak intervals).
  const pendingBlobKey = composerAttachments
    .filter(
      (a): a is ComposerAttachmentDraft & { blobId: string } =>
        a.status === 'processing' && typeof a.blobId === 'string',
    )
    .map((a) => a.blobId)
    .sort()
    .join(',');

  // Keep a ref so the poll callback always reads the latest list without
  // being captured in a stale closure.
  const composerAttachmentsRef = useRef(composerAttachments);
  composerAttachmentsRef.current = composerAttachments;

  useEffect(() => {
    if (pendingBlobKey === '') {
      return;
    }

    let cancelled = false;

    const pollStatuses = async () => {
      const now = Date.now();
      setComposerAttachments((prev) =>
        prev.map((attachment) => {
          if (attachment.status !== 'processing' || typeof attachment.blobId !== 'string') {
            return attachment;
          }

          const processingStartedAt = attachment.processingStartedAt ?? now;
          return {
            ...attachment,
            processingStartedAt,
            detail: buildAttachmentProcessingDetail({
              mediaType: attachment.mediaType,
              processingStartedAt,
              now,
            }),
          };
        }),
      );

      const current = composerAttachmentsRef.current;
      const pendingAttachments = current.filter(
        (attachment): attachment is ComposerAttachmentDraft & { blobId: string } =>
          attachment.status === 'processing' && typeof attachment.blobId === 'string',
      );

      await Promise.all(
        pendingAttachments.map(async (attachment) => {
          try {
            const latest = await fetchUploadedFile(attachment.blobId);
            if (cancelled) {
              return;
            }

            setComposerAttachments((prev) =>
              prev.map((c) =>
                c.id === attachment.id
                  ? {
                      ...buildComposerAttachmentFromStatus(latest, c, now),
                      id: c.id,
                    }
                  : c,
              ),
            );
          } catch {
            // Keep the current chip state; transient status fetch failures should not
            // turn a healthy attachment into a failed one.
          }
        }),
      );
    };

    void pollStatuses();
    const timer = setInterval(() => {
      void pollStatuses();
    }, ATTACHMENT_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingBlobKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Progressive tab wiring ─────────────────────────────────────────────

  const filePanelFiles = useArchAIStore((s) => s.filePanelFiles);
  const buildStages = useArchAIStore((s) => s.buildStages);

  // Unified BUILD state — single source of truth for BUILD phase status
  const buildPhase = useArchAIStore((s) => s.buildState.phase);
  const buildSummary = useArchAIStore((s) => s.buildState.summary);
  const buildAgents = useArchAIStore((s) => s.buildState.agents);
  const createdProjectId = useArchAIStore((s) => s.createdProjectId);

  // Backward compat: keep the buildStatus shape for existing consumers in this file
  const buildStatus = useMemo(
    () => ({
      inProgress: isBuildExecutionActive(buildPhase),
      complete: buildPhase === 'complete',
    }),
    [buildPhase],
  );

  // BUILD lock is activity-based, not phase-based. Keep the composer enabled
  // while BUILD is waiting for the user's choice (ready state), and lock only
  // during actual active generation/validation.
  const buildLockActive = buildStatus.inProgress;

  // Tab/file panel wiring uses getState() in effects — no reactive selectors needed

  // On session load: reset store; add Specification tab only if the session has prior messages
  useEffect(() => {
    if (!session) {
      if (initialized) useArchAIStore.getState().reset();
      return;
    }
    if (session) {
      const store = useArchAIStore.getState();
      store.reset();

      // Don't populate artifact tabs for a fresh session with no history — show empty state
      const hasHistory = (session.metadata.messages as unknown[])?.length > 0;
      if (!hasHistory) return;

      // If the resume card will be shown, defer tab population to the preload orchestrator
      if (resumeGateVisible || sessionTransitioning || preloadState.status === 'running') return;

      store.addTab({
        type: 'spec-document',
        label: 'Spec',
        data: session.metadata.specification,
        toolCallId: `spec-${session.id}`,
      });
      store.addTab({
        type: 'journal',
        label: 'Journal',
        data: {},
        toolCallId: `journal-${session.id}`,
      });
      const specTab = useArchAIStore
        .getState()
        .artifactTabs.find((t) => t.type === 'spec-document');
      if (specTab) useArchAIStore.getState().setActiveTab(specTab.id);
    }
  }, [session?.id, resumeGateVisible, sessionTransitioning, preloadState.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once the first message arrives in an active session, surface the Spec tab
  const hasAnyMessage = messages.length > 0;
  useEffect(() => {
    if (
      !session ||
      !hasAnyMessage ||
      resumeGateVisible ||
      sessionTransitioning ||
      preloadState.status === 'running'
    ) {
      return;
    }
    const store = useArchAIStore.getState();
    const alreadyHasSpec = store.artifactTabs.some((t) => t.type === 'spec-document');
    if (alreadyHasSpec) return;
    store.addTab({
      type: 'spec-document',
      label: 'Spec',
      data: session.metadata.specification,
      toolCallId: `spec-${session.id}`,
    });
    store.addTab({
      type: 'journal',
      label: 'Journal',
      data: {},
      toolCallId: `journal-${session.id}`,
    });
    const specTab = useArchAIStore.getState().artifactTabs.find((t) => t.type === 'spec-document');
    if (specTab) useArchAIStore.getState().setActiveTab(specTab.id);
  }, [hasAnyMessage, session?.id, resumeGateVisible, sessionTransitioning, preloadState.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // On phase change: progressively add tabs / show panels
  // Uses getState() to avoid stale session closures (reviewer finding #6)
  useEffect(() => {
    if (!session || resumeGateVisible || sessionTransitioning || preloadState.status === 'running')
      return;
    const store = useArchAIStore.getState();

    // Re-read session for fresh metadata (avoid stale closure)
    const meta = session.metadata as unknown as Record<string, unknown>;
    const blueprintStage = getBlueprintStage(session);
    const draftTopology = getDraftTopology(session) as Record<string, unknown> | null;
    const lockedTopology = getLockedTopology(session) as Record<string, unknown> | null;
    const resumeTopology =
      lockedTopology ?? draftTopology ?? (meta.topology as Record<string, unknown> | undefined);
    const topologyTabPayload = {
      ...(resumeTopology ?? { agents: [], edges: [] }),
      stage: resume?.artifacts?.topology?.stage ?? blueprintStage,
      approved: resume?.artifacts?.topology?.approved ?? meta.topologyApproved,
      locked: resume?.artifacts?.topology?.locked ?? Boolean(lockedTopology),
    };
    const blueprintDocumentPayload = buildBlueprintDocumentArtifact({
      metadata: meta,
      topology: resumeTopology ?? null,
      stage: blueprintStage,
      approved: Boolean(resume?.artifacts?.topology?.approved ?? meta.topologyApproved),
      locked: Boolean(resume?.artifacts?.topology?.locked ?? lockedTopology),
    });

    // INTERVIEW/BLUEPRINT: ensure file panel is hidden
    if (phase === 'INTERVIEW' || phase === 'BLUEPRINT') {
      store.hideFilePanel();
    }

    // BLUEPRINT: default to the document-first blueprint. Keep the graph as a secondary tab.
    if (phase === 'BLUEPRINT') {
      const existingBlueprint = store.artifactTabs.find((t) => t.type === 'blueprint-document');
      const existingTopo = store.artifactTabs.find((t) => t.type === 'topology');
      let blueprintTabId = existingBlueprint?.id ?? null;

      if (!existingTopo) {
        store.addTab({
          type: 'topology',
          label: 'Topology',
          data: topologyTabPayload,
          toolCallId: `topology-${session.id}`,
          isNew: true,
        });
      } else if (resumeTopology || blueprintStage === 'concept_ready') {
        store.updateTab(existingTopo.id, topologyTabPayload);
      }

      if (existingBlueprint) {
        store.updateTab(existingBlueprint.id, blueprintDocumentPayload);
        blueprintTabId = existingBlueprint.id;
      } else {
        blueprintTabId = store.addTab({
          type: 'blueprint-document',
          label: 'Blueprint',
          data: blueprintDocumentPayload,
          toolCallId: `blueprint-${session.id}`,
          isNew: true,
        });
      }

      if (blueprintTabId) store.setActiveTab(blueprintTabId);
    }

    if (
      (phase === 'BUILD' || phase === 'CREATE') &&
      resumeTopology &&
      resume?.artifacts?.topology?.exists
    ) {
      const existing = store.artifactTabs.find((t) => t.type === 'topology');
      if (existing) {
        store.updateTab(existing.id, topologyTabPayload);
        if (phase === 'BUILD') store.setActiveTab(existing.id);
      } else {
        const tabId = store.addTab({
          type: 'topology',
          label: 'Topology',
          data: topologyTabPayload,
          toolCallId: `topology-${session.id}`,
        });
        if (phase === 'BUILD') store.setActiveTab(tabId);
      }
    }

    if (phase === 'BUILD') {
      store.showFilePanel();

      // Pre-populate ALL topology agents as pending in the file tree
      const topology = (lockedTopology ?? resumeTopology) as
        | { agents?: Array<{ name: string }> }
        | undefined;
      const topologyNames = topology?.agents?.map((a) => a.name) ?? [];
      const files = (meta.files ?? {}) as Record<string, { content: string }>;

      for (const name of topologyNames) {
        if (files[name]) {
          store.addFile(name, files[name].content);
        } else {
          store.addFile(name, '');
        }
      }

      for (const [name, file] of Object.entries(files)) {
        if (!topologyNames.includes(name)) {
          store.addFile(name, file.content);
        }
      }
      // Restore mock server files into file panel
      const mockServer = meta.mockServer as {
        files: Array<{ path: string; content: string }>;
      } | null;
      if (mockServer?.files?.length) {
        for (const file of mockServer.files) {
          store.addFile(`mock:${file.path}`, file.content, {
            fileType: 'mock',
            displayName: file.path,
          });
        }
      }
    }

    if (phase === 'CREATE') {
      store.hideFilePanel();
      store.addTab({
        type: 'summary',
        label: 'Summary',
        data: {
          specification: meta.specification,
          topology: lockedTopology ?? resumeTopology ?? meta.topology,
          files: meta.files ?? {},
          mockServer: meta.mockServer ?? null,
        },
        toolCallId: `summary-${session.id}`,
      });
    }
  }, [phase, resume, session, resumeGateVisible, sessionTransitioning, preloadState.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateProject = useCallback(async () => {
    if (!session) return;
    await sendCreate();
    await refreshSession('ONBOARDING');
  }, [session, sendCreate, refreshSession]);

  const hasCreateProjectResult = hasCreateProjectResultMessage(messages);
  const projectCreated = hasCreatedProject(messages, createdProjectId);

  // ─── All hooks declared above this line ─────────────────────────────────

  if (!initialized) {
    return <ArchLoadingScreen />;
  }

  if (initialized && isApiKeyError(error)) {
    return <ArchErrorScreen error={error!.message} />;
  }

  // Compute the session card target: show only if session has prior history and user hasn't acknowledged it
  const sessionForCard = resumeGateVisible ? session : null;
  const shouldShowEmptyState =
    !projectCreated && (messages.length === 0 || sessionForCard !== null || sessionTransitioning);
  const visibleSurfaceError = error && !isApiKeyError(error) ? error : surfaceError;

  const chatPanel = (
    <div className="flex h-full flex-col">
      <AnimatePresence mode="popLayout" initial={false}>
        {shouldShowEmptyState ? (
          /* Empty state: scrollable content top, input pinned bottom */
          <motion.div
            key="empty-state"
            className="flex flex-1 flex-col overflow-hidden"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            {/* Scrollable top section */}
            <div className="flex flex-1 flex-col overflow-y-auto px-6">
              <div className="my-auto w-full py-10">
                <ArchEntryState
                  session={sessionForCard}
                  onContinue={() => {
                    setAcknowledgedSession(true);
                    startPreload(messages.length || sessionMessageCount);
                  }}
                  onDismiss={() => {
                    void archiveAndStartFresh();
                  }}
                  sessionError={sessionError}
                  onChipSend={({ chatPrompt, projectDescription }) => {
                    pendingChipDescRef.current = projectDescription;
                    void handleChatBarSend(chatPrompt);
                  }}
                >
                  {visibleSurfaceError && (
                    <ArchErrorActionLine
                      error={visibleSurfaceError}
                      onRetry={visibleSurfaceError.recoverable ? retry : undefined}
                    />
                  )}
                </ArchEntryState>
              </div>
            </div>

            {/* Input pinned to bottom */}
            <div className="shrink-0 px-6 pb-6 pt-3">
              <motion.div layoutId="arch-chat-input">
                <ChatInputBar
                  onSend={(text, files) => handleChatBarSend(text, files)}
                  attachments={composerAttachments}
                  onAttachFiles={(files) => {
                    void handleComposerAttachFiles(files);
                  }}
                  onRemoveAttachment={removeComposerAttachment}
                  disabled={sessionTransitioning || chatState !== 'idle'}
                  disabledReason={
                    sessionTransitioning
                      ? 'connecting'
                      : chatState === 'streaming'
                        ? 'streaming'
                        : undefined
                  }
                  isStreaming={sessionTransitioning || chatState === 'streaming'}
                  onStop={stop}
                  placeholder={
                    sessionTransitioning
                      ? 'Starting a fresh session...'
                      : chatState === 'streaming'
                        ? 'Thinking...'
                        : 'Describe your project...'
                  }
                  showModelLabel={false}
                />
              </motion.div>
            </div>
          </motion.div>
        ) : (
          /* Messages layout: scrollable messages + fixed input at bottom */
          <motion.div
            key="messages-state"
            className="flex flex-1 flex-col overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18 }}
          >
            <ArchHeroStrip
              variant="compact"
              projectName={session?.metadata.specification.projectName ?? ''}
              phase={phase}
              onReset={() => setShowNewChatConfirm(true)}
              headerActions={
                <button
                  onClick={() => setShowMemorySettings((v) => !v)}
                  className="rounded-md p-1.5 text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
                  title="Memory & Learning Settings"
                >
                  <Settings2 className="h-4 w-4" />
                </button>
              }
            />
            {visibleSurfaceError && (
              <div className="px-6 pt-3">
                <ArchErrorActionLine
                  error={visibleSurfaceError}
                  onRetry={visibleSurfaceError.recoverable ? retry : undefined}
                />
              </div>
            )}
            <div className="relative flex-1 overflow-hidden">
              <div ref={scrollRef} className="h-full overflow-y-auto">
                <div className="px-6 py-8">
                  {(preloadState.status === 'running'
                    ? messages.slice(0, preloadState.visibleMessageCount)
                    : messages
                  ).map((msg, msgIdx) => {
                    const prevMsg = messages[msgIdx - 1];
                    const isUser = msg.role === 'user';
                    const toolCall = msg.toolCall;
                    const isTerminal =
                      toolCall?.toolName === 'create_project' && !!toolCall?.result;
                    const shouldRenderToolCall =
                      toolCall != null ? shouldRenderToolCallMessage(toolCall, session) : false;

                    // Terminal card — full-width, no avatar
                    if (isTerminal) {
                      const projectResult = msg.toolCall!.result as Record<string, unknown>;
                      const projectId =
                        typeof projectResult.projectId === 'string' ? projectResult.projectId : '';
                      const projectName =
                        typeof projectResult.projectName === 'string'
                          ? projectResult.projectName
                          : session?.metadata.specification.projectName;
                      return (
                        <ProjectReadyCard
                          key={msg.id}
                          projectName={projectName}
                          projectId={projectId}
                          requestId={msg.toolCall?.requestId}
                          sessionId={session?.id ?? null}
                          onOpenProject={() => {
                            loadProjects().then(() => navigateTo(`/projects/${projectId}`));
                          }}
                        />
                      );
                    }

                    if (
                      toolCall &&
                      !shouldRenderToolCall &&
                      !msg.content &&
                      !msg.activityGroups &&
                      !msg.thinkingText
                    ) {
                      return null;
                    }

                    return (
                      <div key={msg.id}>
                        <div className={clsx('px-4 py-1.5', isUser && 'flex justify-end')}>
                          <div className={clsx(!isUser && 'min-w-0 flex-1')}>
                            {isUser ? (
                              <div className="flex flex-col items-end gap-1">
                                {msg.rawContent && <UserFileChips blocks={msg.rawContent} />}
                                {msg.content ? (
                                  <div className="w-fit max-w-[580px] rounded-2xl bg-foreground/[0.06] px-4 py-3 text-[15px] leading-7 text-foreground/80">
                                    {msg.content}
                                  </div>
                                ) : null}
                              </div>
                            ) : (
                              <>
                                {(msg.content ||
                                  msg.activityGroups ||
                                  msg.thinkingText ||
                                  (msg.isStreaming && !!msg.specialist)) && (
                                  <ArchAssistantResponse
                                    message={msg}
                                    activityGroups={getVisibleActivityGroups(msg.activityGroups)}
                                    defaultExpanded={msgIdx === firstThinkingIdx}
                                  />
                                )}
                                {toolCall && shouldRenderToolCall && (
                                  <div className="mt-2">
                                    <WidgetRenderer
                                      toolCallId={toolCall.toolCallId}
                                      toolName={toolCall.toolName}
                                      input={toolCall.input as unknown as WidgetInput}
                                      requestId={toolCall.requestId}
                                      onSubmit={(toolCallId, answer, secrets) =>
                                        handleWidgetSubmit(
                                          toolCall.toolName,
                                          toolCallId,
                                          answer,
                                          secrets,
                                        )
                                      }
                                      answeredResult={toolCall.result}
                                    />
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {createdProjectId && !hasCreateProjectResult && (
                    <ProjectReadyCard
                      projectName={session?.metadata.specification.projectName}
                      projectId={createdProjectId}
                      sessionId={session?.id ?? null}
                      onOpenProject={() => {
                        loadProjects().then(() => navigateTo(`/projects/${createdProjectId}`));
                      }}
                    />
                  )}

                  {/* BUILD phase: progress card while generating (summary is shown by the completion widget) */}
                  {isBuildWithCard && !buildStatus.complete && (
                    <div className="mt-4">
                      <BuildProgressCard topologyAgents={topologyAgentNames} />
                    </div>
                  )}

                  {/* Status messages — BUILD progress, thinking warnings */}
                  {liveStatusMessages.length > 0 &&
                    chatState === 'streaming' &&
                    !hasVisibleActivityPanel && (
                      <ChatStatusMessages messages={liveStatusMessages} />
                    )}

                  {/* Filler status — visible during thinking (pre-streaming) and streaming phases.
                      InlineStatus is shown whenever statusMessage is set, even before response_start,
                      so fillers that arrive while chatState==='idle' are still rendered.
                      Suppressed only when an activity/thinking panel is already visible (reasoning agents). */}
                  {statusMessage && !hasVisibleActivityPanel && (
                    <InlineStatus message={statusMessage} isStreaming={chatState === 'streaming'} />
                  )}

                  {/* Streaming indicator fallback — only show dots when streaming but no filler text. */}
                  {chatState === 'streaming' && !hasVisibleActivityPanel && !statusMessage && (
                    <div className="mt-1 px-4 py-2">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          className="h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/30 motion-reduce:animate-none"
                          style={{ animationDelay: '0ms' }}
                        />
                        <span
                          className="h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/30 motion-reduce:animate-none"
                          style={{ animationDelay: '150ms' }}
                        />
                        <span
                          className="h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/30 motion-reduce:animate-none"
                          style={{ animationDelay: '300ms' }}
                        />
                        <span className="ml-1">Arch is working...</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <ScrollToBottomButton visible={showScrollButton} onClick={scrollToBottom} />
            </div>

            {sessionError && (
              <div className="mx-6 mb-3 rounded-lg border border-error/20 bg-error/5 px-4 py-2.5 text-sm text-error">
                {sessionError}
              </div>
            )}

            {/* Chat input */}
            <div className="px-6 pb-6">
              <motion.div layoutId="arch-chat-input">
                <ChatInputBar
                  onSend={(text, files) => handleChatBarSend(text, files)}
                  attachments={composerAttachments}
                  onAttachFiles={(files) => {
                    void handleComposerAttachFiles(files);
                  }}
                  onRemoveAttachment={removeComposerAttachment}
                  disabled={
                    sessionTransitioning ||
                    preloadState.status === 'running' ||
                    chatState === 'streaming' ||
                    buildLockActive ||
                    !['idle', 'widget_pending'].includes(chatState)
                  }
                  disabledReason={
                    sessionTransitioning || preloadState.status === 'running'
                      ? 'connecting'
                      : buildLockActive
                        ? 'generating'
                        : chatState === 'streaming'
                          ? 'streaming'
                          : undefined
                  }
                  isStreaming={
                    sessionTransitioning ||
                    preloadState.status === 'running' ||
                    chatState === 'streaming' ||
                    buildLockActive
                  }
                  onStop={stop}
                  placeholder={
                    sessionTransitioning || preloadState.status === 'running'
                      ? 'Restoring session...'
                      : buildLockActive
                        ? 'Generating agents...'
                        : chatState === 'streaming' && phase === 'BLUEPRINT'
                          ? 'Designing architecture...'
                          : chatState === 'streaming'
                            ? 'Thinking...'
                            : chatState === 'widget_pending'
                              ? 'Or type something else...'
                              : phase === 'INTERVIEW'
                                ? 'Describe your project...'
                                : phase === 'BLUEPRINT'
                                  ? 'Type a message...'
                                  : phase === 'BUILD'
                                    ? 'Choose a build step or type what you want next...'
                                    : 'Type a message...'
                  }
                  showModelLabel={false}
                />
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  const artifactPanel = (
    <OnboardingArtifactPanel
      session={
        session
          ? { id: session.id, metadata: session.metadata as unknown as Record<string, unknown> }
          : null
      }
      onSpecUpdate={handleSpecUpdate}
      phase={phase}
      forceEmpty={resumeGateVisible || sessionTransitioning}
      specOverride={specOverride}
    />
  );

  const ctaLabel = getCtaLabel(phase, projectCreated);
  const projectName = session?.metadata.specification.projectName ?? '';
  const topologyApproved =
    !!session &&
    (Boolean(getLockedTopology(session)) || session.metadata.topologyApproved === true);
  const pendingWidgetType =
    session?.metadata.pendingInteraction?.kind === 'widget'
      ? ((session.metadata.pendingInteraction.payload as { widgetType?: string }).widgetType ??
        null)
      : null;
  const pendingWidgetPayload =
    session?.metadata.pendingInteraction?.kind === 'widget'
      ? session.metadata.pendingInteraction.payload
      : null;
  const phaseOwnedWidgetActive = shouldSuppressFooterActionForPendingWidget(
    phase,
    pendingWidgetType,
    projectCreated,
  );
  const canCreateProject =
    buildPhase === 'complete' &&
    buildSummary !== null &&
    buildSummary.total > 0 &&
    buildSummary.compiled === buildSummary.total &&
    buildSummary.errors === 0;
  const canRecoverCreateProjectFromWidget =
    phase === 'CREATE' && buildCompleteWidgetAllowsCreate(pendingWidgetPayload);
  const manualCreateProjectAvailable = canTriggerManualCreateProject(
    phase,
    projectCreated,
    canCreateProject || canRecoverCreateProjectFromWidget,
  );
  const ctaDisabled =
    (manualCreateProjectAvailable
      ? !['idle', 'widget_pending'].includes(chatState)
      : chatState !== 'idle') ||
    !phase ||
    ((phase === 'BUILD' || phase === 'CREATE') && !manualCreateProjectAvailable) ||
    (phase === 'INTERVIEW' && !projectName.trim()) ||
    (phase === 'BLUEPRINT' && !topologyApproved);
  const handleCtaClick = manualCreateProjectAvailable ? handleCreateProject : undefined;

  return (
    <div className="flex h-full flex-col">
      {/* Main content */}
      <div className="flex-1 overflow-hidden">
        <ArchShell chatPanel={chatPanel} artifactPanel={artifactPanel} />
      </div>

      {/* Bottom status bar */}
      <div className="flex h-14 shrink-0 items-center border-t border-border bg-background px-6">
        <PhasePipeline
          currentPhase={sessionForCard !== null ? null : phase}
          revealedPhases={
            preloadState.status === 'running' ? preloadState.revealedPhases : undefined
          }
        />
        {checkpoints.length > 0 && (
          <>
            <div className="mx-3 h-5 w-px shrink-0 bg-border" />
            <CheckpointTimeline
              checkpoints={checkpoints}
              currentPhase={phase}
              onRollback={(cpId, cpPhase, cp) =>
                setRollbackTarget({ checkpointId: cpId, phase: cpPhase, checkpoint: cp })
              }
            />
          </>
        )}
        <div className="flex-1" />
        {sessionForCard === null && handleCtaClick && !phaseOwnedWidgetActive && (
          <>
            <div className="mr-6 h-5 w-px shrink-0 bg-border" />
            <button
              onClick={handleCtaClick}
              disabled={ctaDisabled}
              className={clsx(
                'shrink-0 rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                'bg-accent text-accent-foreground',
                ctaDisabled ? 'cursor-not-allowed opacity-40' : 'hover:opacity-90',
              )}
            >
              {ctaLabel}
            </button>
          </>
        )}
      </div>

      {/* New chat confirmation modal */}
      {showNewChatConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-xl border border-border bg-background p-6 shadow-xl">
            <h3 className="text-base font-semibold text-foreground">Start new chat?</h3>
            <p className="mt-2 text-sm text-foreground/60">
              This will archive the current session and all its progress. You can&apos;t undo this.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowNewChatConfirm(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-background-muted"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setShowNewChatConfirm(false);
                  await archiveAndStartFresh();
                }}
                className="rounded-lg bg-error px-4 py-2 text-sm font-medium text-error-foreground transition-opacity hover:opacity-90"
              >
                Start new
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rollback preview modal — shows what will change before confirming */}
      {rollbackTarget && (
        <RollbackPreviewModal
          checkpoint={rollbackTarget.checkpoint}
          currentPhase={phase}
          onConfirm={async () => {
            const target = rollbackTarget;
            setRollbackTarget(null);
            await rollback(target.checkpointId);
          }}
          onCancel={() => setRollbackTarget(null)}
        />
      )}

      {/* Memory settings panel */}
      {showMemorySettings && (
        <MemorySettingsPanel
          mode={session?.metadata?.mode as string | undefined}
          projectId={session?.metadata?.projectId as string | undefined}
          onClose={() => setShowMemorySettings(false)}
        />
      )}
    </div>
  );
}
