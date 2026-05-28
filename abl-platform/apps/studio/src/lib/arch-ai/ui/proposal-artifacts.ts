import { useArchAIStore } from '../store/arch-ai-store';
import type {
  ModificationProposal,
  ProposalReviewStatus,
  ProposalValidation,
} from '@/lib/arch-ai/types/arch';
import type { JournalMutationEntry } from '@/lib/arch-ai/journal/undo';

type NormalizedProposedChange = ModificationProposal['changes'][number];

const DIFF_RESOLUTION_IN_FLIGHT_TTL_MS = 30_000;

const VALID_PROPOSAL_REVIEW_STATUSES = new Set<ProposalReviewStatus>([
  'pending',
  'applying',
  'applied',
  'rejected',
  'blocked',
]);

const VALID_PROPOSED_CHANGE_CONSTRUCTS = new Set<NormalizedProposedChange['construct']>([
  'FULL',
  'AGENT',
  'PERSONA',
  'GOAL',
  'LIMITATIONS',
  'GATHER',
  'TOOLS',
  'FLOW',
  'HANDOFFS',
  'CONSTRAINTS',
  'GUARDRAILS',
  'EXECUTION',
  'MEMORY',
  'ON_INPUT',
  'ON_FAIL',
  'RESPOND',
]);

const MAX_APPLIED_MUTATION_HISTORY = 50;
const appliedMutationHistory: JournalMutationEntry[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCompilationStatus(
  status: unknown,
): ModificationProposal['compilationStatus'] | undefined {
  if (!isRecord(status) || typeof status.success !== 'boolean') {
    return undefined;
  }

  return {
    success: status.success,
    errors: Array.isArray(status.errors) ? status.errors.map(String) : [],
    warnings: Array.isArray(status.warnings) ? status.warnings.map(String) : [],
  };
}

function normalizeProposedChange(change: unknown): NormalizedProposedChange | null {
  if (!isRecord(change) || typeof change.construct !== 'string') {
    return null;
  }

  if (
    !VALID_PROPOSED_CHANGE_CONSTRUCTS.has(change.construct as NormalizedProposedChange['construct'])
  ) {
    return null;
  }

  return {
    construct: change.construct as NormalizedProposedChange['construct'],
    before: typeof change.before === 'string' || change.before === null ? change.before : null,
    after: typeof change.after === 'string' || change.after === null ? change.after : null,
    rationale: typeof change.rationale === 'string' ? change.rationale : '',
  };
}

function normalizeValidationIssue(
  issue: Record<string, unknown>,
): ProposalValidation['errors'][number] {
  return {
    line: typeof issue.line === 'number' ? issue.line : undefined,
    message: typeof issue.message === 'string' ? issue.message : '',
    severity: issue.severity === 'warning' ? 'warning' : 'error',
    source:
      issue.source === 'parse' || issue.source === 'compile' || issue.source === 'diagnostics'
        ? (issue.source as 'parse' | 'compile' | 'diagnostics')
        : undefined,
    agent: typeof issue.agent === 'string' ? issue.agent : undefined,
  };
}

function normalizeValidation(value: unknown): ProposalValidation | undefined {
  if (!isRecord(value) || typeof value.valid !== 'boolean') {
    return undefined;
  }

  const errors = Array.isArray(value.errors)
    ? value.errors.filter(isRecord).map(normalizeValidationIssue)
    : [];
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.filter(isRecord).map(normalizeValidationIssue)
    : [];

  return {
    valid: value.valid,
    errors,
    warnings,
    hint: typeof value.hint === 'string' ? value.hint : undefined,
    repairAttempts: typeof value.repairAttempts === 'number' ? value.repairAttempts : 0,
  };
}

export function normalizeProposal(
  proposal: Record<string, unknown>,
  fallbackStatus: ProposalReviewStatus = 'pending',
): ModificationProposal {
  const normalizedChanges = Array.isArray(proposal.changes)
    ? proposal.changes
        .map((change) => normalizeProposedChange(change))
        .filter((change): change is NormalizedProposedChange => change !== null)
    : [];

  const reviewStatus =
    typeof proposal.reviewStatus === 'string' &&
    VALID_PROPOSAL_REVIEW_STATUSES.has(proposal.reviewStatus as ProposalReviewStatus)
      ? (proposal.reviewStatus as ProposalReviewStatus)
      : fallbackStatus;

  return {
    agentName: typeof proposal.agentName === 'string' ? proposal.agentName : '',
    changes: normalizedChanges,
    compilationStatus: normalizeCompilationStatus(proposal.compilationStatus),
    change: typeof proposal.change === 'string' ? proposal.change : undefined,
    currentCode: typeof proposal.currentCode === 'string' ? proposal.currentCode : undefined,
    proposedCode: typeof proposal.proposedCode === 'string' ? proposal.proposedCode : undefined,
    linesChanged: typeof proposal.linesChanged === 'number' ? proposal.linesChanged : undefined,
    reviewStatus,
    validation: normalizeValidation(proposal.validation),
    applyError: typeof proposal.applyError === 'string' ? proposal.applyError : undefined,
    impact: isRecord(proposal.impact) ? proposal.impact : undefined,
  };
}

export function upsertDiffTab(proposal: ModificationProposal, toolCallId: string): void {
  const store = useArchAIStore.getState();
  const existing = store.artifactTabs.find((tab) => tab.type === 'diff');

  if (existing) {
    store.updateTab(existing.id, proposal);
    store.setActiveTab(existing.id);
  } else {
    const tabId = store.addTab({
      type: 'diff',
      data: proposal,
      label: 'Changes',
      toolCallId,
      isNew: true,
    });
    store.setActiveTab(tabId);
  }

  store.setOverlayState('artifacts');
}

export function updateDiffTabStatus(
  status: ProposalReviewStatus,
  applyError?: string,
  onlyWhenCurrentStatus?: ProposalReviewStatus,
): void {
  const store = useArchAIStore.getState();
  const existing = store.artifactTabs.find((tab) => tab.type === 'diff');
  if (!existing) {
    return;
  }

  const proposal = existing.data as ModificationProposal | undefined;
  if (!proposal) {
    return;
  }

  if (onlyWhenCurrentStatus && proposal.reviewStatus !== onlyWhenCurrentStatus) {
    return;
  }

  store.updateTab(existing.id, {
    ...proposal,
    reviewStatus: status,
    applyError,
    clientResolution: undefined,
  });
  store.setActiveTab(existing.id);
  store.setOverlayState('artifacts');
}

export function markDiffResolutionInFlight(toolCallId?: string): void {
  const store = useArchAIStore.getState();
  const existing = store.artifactTabs.find((tab) => tab.type === 'diff');
  if (!existing) {
    return;
  }

  const proposal = existing.data as ModificationProposal | undefined;
  if (!proposal || proposal.reviewStatus !== 'pending') {
    return;
  }

  const startedAt = Date.now();
  store.updateTab(existing.id, {
    ...proposal,
    reviewStatus: 'applying',
    clientResolution: {
      state: 'in_flight',
      startedAt,
      expiresAt: startedAt + DIFF_RESOLUTION_IN_FLIGHT_TTL_MS,
      toolCallId,
    },
  });
}

export function syncDiffArtifact(
  update: {
    diffId?: string;
    status: 'pending' | 'applying' | 'applied' | 'rejected';
    payload?: unknown;
  },
  toolCallId: string,
): void {
  if (isRecord(update.payload)) {
    const proposal = normalizeProposal(update.payload, update.status);
    if (update.status === 'applied') {
      useArchAIStore.getState().setLastAgentEdit();
      recordAppliedMutationForUndo(proposal, update.diffId ?? toolCallId);
      clearResolvedReviewArtifactTabs();
      return;
    }
    upsertDiffTab(proposal, toolCallId);
    return;
  }

  if (update.status === 'applied') {
    useArchAIStore.getState().setLastAgentEdit();
    clearResolvedReviewArtifactTabs();
    return;
  }
  updateDiffTabStatus(update.status);
}

export function recordAppliedMutationForUndo(
  proposal: ModificationProposal,
  id = `mutation-${Date.now()}`,
): JournalMutationEntry | null {
  if (
    typeof proposal.currentCode !== 'string' ||
    proposal.currentCode.trim().length === 0 ||
    typeof proposal.proposedCode !== 'string' ||
    proposal.proposedCode.trim().length === 0 ||
    proposal.currentCode === proposal.proposedCode
  ) {
    return null;
  }

  const entry: JournalMutationEntry = {
    id,
    timestamp: new Date().toISOString(),
    agentName: proposal.agentName,
    from: proposal.currentCode,
    to: proposal.proposedCode,
  };

  const duplicateIndex = appliedMutationHistory.findIndex(
    (item) => item.id === entry.id || (item.agentName === entry.agentName && item.to === entry.to),
  );
  if (duplicateIndex >= 0) {
    appliedMutationHistory.splice(duplicateIndex, 1);
  }

  appliedMutationHistory.push(entry);
  if (appliedMutationHistory.length > MAX_APPLIED_MUTATION_HISTORY) {
    appliedMutationHistory.splice(0, appliedMutationHistory.length - MAX_APPLIED_MUTATION_HISTORY);
  }

  return entry;
}

export function recordUndoMutation(entry: JournalMutationEntry): JournalMutationEntry {
  const undoEntry: JournalMutationEntry = {
    id: `undo-${entry.id}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    agentName: entry.agentName,
    from: entry.to,
    to: entry.from,
  };

  appliedMutationHistory.push(undoEntry);
  if (appliedMutationHistory.length > MAX_APPLIED_MUTATION_HISTORY) {
    appliedMutationHistory.splice(0, appliedMutationHistory.length - MAX_APPLIED_MUTATION_HISTORY);
  }

  return undoEntry;
}

export function getAppliedMutationHistory(): JournalMutationEntry[] {
  return [...appliedMutationHistory];
}

export function __resetAppliedMutationHistoryForTests(): void {
  appliedMutationHistory.splice(0, appliedMutationHistory.length);
}

export function restorePendingMutationDiffTab(pendingMutation: unknown): boolean {
  if (!isRecord(pendingMutation)) {
    return false;
  }

  const target = typeof pendingMutation.target === 'string' ? pendingMutation.target : null;
  const afterCode = typeof pendingMutation.after === 'string' ? pendingMutation.after : null;
  if (!target || !afterCode) {
    return false;
  }

  const beforeCode = typeof pendingMutation.before === 'string' ? pendingMutation.before : '';
  const restoredStatus: ProposalReviewStatus =
    typeof pendingMutation.reviewStatus === 'string' &&
    VALID_PROPOSAL_REVIEW_STATUSES.has(pendingMutation.reviewStatus as ProposalReviewStatus)
      ? (pendingMutation.reviewStatus as ProposalReviewStatus)
      : 'pending';

  upsertDiffTab(
    normalizeProposal(
      {
        agentName: target,
        changes: [
          {
            construct: 'FULL',
            before: beforeCode || null,
            after: afterCode,
            rationale:
              typeof pendingMutation.changeSummary === 'string'
                ? pendingMutation.changeSummary
                : 'Rehydrated from session metadata',
          },
        ],
        currentCode: beforeCode || undefined,
        proposedCode: afterCode,
        change:
          typeof pendingMutation.changeSummary === 'string'
            ? pendingMutation.changeSummary
            : undefined,
        reviewStatus: restoredStatus,
        validation: pendingMutation.validation,
        impact: pendingMutation.impact,
      },
      restoredStatus,
    ),
    `restored-${target}`,
  );

  return true;
}

export function clearPendingDiffTabIfUnbacked(): void {
  const store = useArchAIStore.getState();
  const existing = store.artifactTabs.find((tab) => tab.type === 'diff');
  if (!existing) {
    return;
  }

  const proposal = existing.data as ModificationProposal | undefined;
  const status = proposal?.reviewStatus;
  if (
    status === 'applying' &&
    proposal?.clientResolution?.state === 'in_flight' &&
    proposal.clientResolution.expiresAt > Date.now()
  ) {
    return;
  }

  if (status === 'pending' || status === 'applying' || status === 'blocked') {
    store.removeTab(existing.id);
  }
}

export function clearResolvedReviewArtifactTabs(): void {
  const store = useArchAIStore.getState();
  const reviewTabs = store.artifactTabs.filter((tab) => tab.type === 'diff' || tab.type === 'plan');

  for (const tab of reviewTabs) {
    useArchAIStore.getState().removeTab(tab.id);
  }
}
