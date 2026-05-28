import type {
  DeferredFindingRecord,
  Finding,
  FindingHorizon,
  PlanReviewApprovedSlice,
  PlanReviewStageOutput,
  PlanReviewState,
  Session,
  SlicePlanStageOutput,
} from '../types.js';

const MAX_RENDERED_AMENDMENTS = 3;
const MAX_RENDERED_ADVISORIES = 6;
const MAX_RENDERED_SLICE_DESCRIPTION_CHARS = 240;
const ACTIONABLE_FINDING_HORIZONS = new Set<FindingHorizon>(['immediate', 'next']);

export function buildPlanReviewState(
  review: PlanReviewStageOutput,
  plan: SlicePlanStageOutput,
): PlanReviewState {
  const approvedSlices: PlanReviewApprovedSlice[] = [];
  const slicesToRevise: PlanReviewState['slicesToRevise'] = [];

  for (const assessment of review.sliceAssessments) {
    const slice = plan.slices[assessment.sliceNumber - 1];
    if (!slice) {
      continue;
    }

    if (assessment.verdict === 'approved') {
      approvedSlices.push({
        sliceNumber: assessment.sliceNumber,
        slice,
      });
      continue;
    }

    slicesToRevise.push({
      sliceNumber: assessment.sliceNumber,
      title: slice.title,
      rationale: assessment.rationale,
      requiredTestAmendments: assessment.requiredTestAmendments,
    });
  }

  const blockingFindings = review.findings.filter((finding) => finding.disposition === 'blocking');
  const advisoryFindings = review.findings.filter((finding) => finding.disposition === 'advisory');

  return {
    summary: review.summary,
    approvedSlices,
    slicesToRevise,
    deferredFindings: dedupeDeferredFindings(review.deferredFindings),
    blockingFindings,
    advisoryFindings,
    carriedForwardAt: new Date().toISOString(),
  };
}

export function formatPlanReviewCarryForward(session: Session): string {
  const state = session.planReviewState;
  if (!state) {
    return '(none)';
  }

  const lines = [
    state.summary || 'Prior review preserved part of the plan and requested targeted revisions.',
  ];

  if (state.approvedSlices.length > 0) {
    lines.push('', 'Approved slices to keep unless a revised dependency truly forces a change:');
    for (const approvedSlice of state.approvedSlices) {
      const depends =
        approvedSlice.slice.dependencies.length > 0
          ? approvedSlice.slice.dependencies.join(', ')
          : 'none';
      lines.push(
        `- Slice ${approvedSlice.sliceNumber}: ${approvedSlice.slice.title} | findings: ${approvedSlice.slice.findings.join(', ') || '(none)'} | tests: ${approvedSlice.slice.tests.join(', ') || '(none)'} | depends: ${depends}`,
      );
      lines.push(
        `  Description: ${truncateInlineText(approvedSlice.slice.description || '(no description provided)', MAX_RENDERED_SLICE_DESCRIPTION_CHARS)}`,
      );
    }
  }

  if (state.slicesToRevise.length > 0) {
    lines.push('', 'Slices that still need revision before the plan can pass:');
    for (const revision of state.slicesToRevise) {
      lines.push(`- Slice ${revision.sliceNumber}: ${revision.title} - ${revision.rationale}`);
      if (revision.requiredTestAmendments.length > 0) {
        const amendments = revision.requiredTestAmendments.slice(0, MAX_RENDERED_AMENDMENTS);
        lines.push(`  Required test amendments: ${amendments.join(' | ')}`);
        if (revision.requiredTestAmendments.length > amendments.length) {
          lines.push(
            `  ... and ${revision.requiredTestAmendments.length - amendments.length} more required test amendments`,
          );
        }
      }
    }
  }

  if (state.deferredFindings.length > 0) {
    lines.push('', 'Findings explicitly approved for backlog deferral:');
    for (const deferred of state.deferredFindings) {
      lines.push(`- ${deferred.findingId} - ${deferred.reason}`);
    }
  }

  if (state.advisoryFindings.length > 0) {
    lines.push('', 'Advisory notes that should not block the approved slices:');
    for (const finding of state.advisoryFindings.slice(0, MAX_RENDERED_ADVISORIES)) {
      lines.push(`- [${finding.severity}] ${finding.title} - ${finding.description}`);
    }
    if (state.advisoryFindings.length > MAX_RENDERED_ADVISORIES) {
      lines.push(
        `- ... and ${state.advisoryFindings.length - MAX_RENDERED_ADVISORIES} more advisory notes`,
      );
    }
  }

  return lines.join('\n');
}

export function getDeferredPlanFindingIds(session: Session): Set<string> {
  return new Set(
    session.planReviewState?.deferredFindings.map((finding) => finding.findingId) ?? [],
  );
}

export function getApprovedPlanFindingIds(session: Session): Set<string> {
  const approvedFindings =
    session.planReviewState?.approvedSlices.flatMap(
      (approvedSlice) => approvedSlice.slice.findings,
    ) ?? [];
  return new Set(approvedFindings);
}

export function getVisiblePlanFindings(session: Session): Finding[] {
  const deferredFindingIds = getDeferredPlanFindingIds(session);
  const approvedFindingIds = getApprovedPlanFindingIds(session);

  return session.findings.filter(
    (finding) =>
      finding.status === 'open' &&
      ACTIONABLE_FINDING_HORIZONS.has(getFindingHorizon(finding)) &&
      !deferredFindingIds.has(finding.id) &&
      !approvedFindingIds.has(finding.id),
  );
}

export function getFollowUpPlanFindings(session: Session): Finding[] {
  const deferredFindingIds = getDeferredPlanFindingIds(session);
  const approvedFindingIds = getApprovedPlanFindingIds(session);

  return session.findings.filter(
    (finding) =>
      finding.status === 'open' &&
      !ACTIONABLE_FINDING_HORIZONS.has(getFindingHorizon(finding)) &&
      !deferredFindingIds.has(finding.id) &&
      !approvedFindingIds.has(finding.id),
  );
}

export function buildHorizonDeferredPlanFindings(session: Session): DeferredFindingRecord[] {
  return getFollowUpPlanFindings(session).map((finding) => {
    const horizon = getFindingHorizon(finding);
    return {
      findingId: finding.id,
      reason: `${horizon} follow-up deferred from the current implementation pass; continue with immediate and next findings now and schedule a later audit or implementation follow-up for this item.`,
    };
  });
}

export function applyDeferredPlanFindings(
  session: Session,
  deferredFindings: DeferredFindingRecord[],
): void {
  const deferredById = new Map(
    deferredFindings.map((finding) => [finding.findingId, finding.reason] as const),
  );

  for (const finding of session.findings) {
    const reason = deferredById.get(finding.id);
    if (!reason || finding.assignedSlice != null) {
      continue;
    }

    finding.status = 'deferred';
    finding.updatedAt = new Date().toISOString();
    finding.deferredReason = reason;
  }
}

function dedupeDeferredFindings(findings: DeferredFindingRecord[]): DeferredFindingRecord[] {
  const byId = new Map<string, DeferredFindingRecord>();
  for (const finding of findings) {
    if (!byId.has(finding.findingId)) {
      byId.set(finding.findingId, finding);
    }
  }
  return [...byId.values()];
}

function truncateInlineText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(maxChars - 14, 0)).trimEnd()} [truncated]`;
}

function getFindingHorizon(finding: Finding): FindingHorizon {
  return finding.horizon ?? inferDefaultFindingHorizon(finding.severity);
}

function inferDefaultFindingHorizon(severity: Finding['severity']): FindingHorizon {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'immediate';
    case 'medium':
      return 'next';
    case 'low':
      return 'near-term';
    case 'info':
    default:
      return 'long-term';
  }
}
