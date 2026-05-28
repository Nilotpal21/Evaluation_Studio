import { randomUUID } from 'node:crypto';

import { StructuredOutputParseError } from '../models/executor-errors.js';
import { validateStageOutputData } from './stage-output-schema.js';
import type {
  AnalysisStageOutput,
  FailureAdvisoryStageOutput,
  DeferredFindingRecord,
  Decision,
  Finding,
  FindingHorizon,
  FindingSeverity,
  ImpactAnalysis,
  ImpactAnalysisStageOutput,
  LegacyPathPlan,
  OracleFindingAssessmentRecord,
  OracleReviewStageOutput,
  PlanReviewFindingDisposition,
  PlanReviewFindingRecord,
  PlanReviewSliceAssessmentRecord,
  PlanReviewStageOutput,
  ReproductionStageOutput,
  Session,
  Slice,
  SlicePlanRecord,
  SlicePlanStageOutput,
  StageOutputSchemaId,
  StructuredDecisionRecord,
  StructuredFindingRecord,
  StructuredLegacyPathRecord,
  WorkspaceReconcileAssessmentRecord,
  WorkspaceReconcileDisposition,
  WorkspaceReconcileStageOutput,
} from '../types.js';

interface StructuredStageOutputParseError {
  schemaId: StageOutputSchemaId;
  message: string;
  details: string[];
}

type StructuredStageOutputParseResult<T> =
  | { data: T; error: null }
  | { data: null; error: StructuredStageOutputParseError };

export function parseAnalysisOutput(
  output: string,
  stageName: string,
): { findings: Finding[]; decisions: Decision[] } {
  const structured = parseStructuredStageOutput(output, 'analysis-report');
  if (structured) {
    return {
      findings: structured.findings.map((finding) => materializeFindingRecord(finding, stageName)),
      decisions: structured.decisions.map((decision) =>
        materializeDecisionRecord(decision, stageName),
      ),
    };
  }

  return parseLineBasedAnalysisOutput(output, stageName);
}

export function parseReproductionOutput(
  output: string,
  stageName: string,
): {
  summary: string;
  testFile: string;
  reproductionSteps: string[];
  findings: Finding[];
  decisions: Decision[];
} | null {
  const structured = parseStructuredStageOutput(output, 'reproduction-report');
  if (!structured) {
    return null;
  }

  return {
    summary: structured.summary,
    testFile: structured.testFile,
    reproductionSteps: structured.reproductionSteps,
    findings: structured.findings.map((finding) => materializeFindingRecord(finding, stageName)),
    decisions: structured.decisions.map((decision) =>
      materializeDecisionRecord(decision, stageName),
    ),
  };
}

export function parseSlicePlanOutput(output: string, session: Session): Slice[] {
  const structured = parseStructuredStageOutput(output, 'slice-plan');
  if (structured) {
    return buildSlicesFromStructuredPlan(structured, session);
  }

  return parseLineBasedSlicePlan(output, session);
}

export function parseImpactAnalysisOutput(output: string, directFiles: string[]): ImpactAnalysis {
  const structured = parseStructuredStageOutput(output, 'impact-analysis');
  if (structured) {
    return {
      directFiles,
      dependentFiles: normalizeStringList(structured.dependentFiles),
      affectedTests: normalizeStringList(structured.affectedTests),
      riskLevel: normalizeRiskLevel(structured.riskLevel),
      notes: normalizeText(structured.notes),
    };
  }

  return parseLineBasedImpactAnalysis(output, directFiles);
}

export function parseOracleReviewOutput(output: string): OracleReviewStageOutput {
  const structured = parseStructuredStageOutput(output, 'oracle-review');
  if (structured) {
    return structured;
  }

  return parseLineBasedOracleReviewOutput(output);
}

export function parsePlanCWithDivergenceOutput(
  rawOutput: string,
  strict?: boolean,
): { plan: string; divergenceNotes?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (parseError: unknown) {
    throw new StructuredOutputParseError(
      'plan-c-with-divergence',
      'JSON.parse failed',
      parseError instanceof Error ? parseError.message : String(parseError),
    );
  }

  const validation = validateStageOutputData(
    { id: 'plan-c-with-divergence', strict: strict ?? true },
    parsed,
  );
  if (!validation.ok) {
    throw new StructuredOutputParseError(
      'plan-c-with-divergence',
      'AJV validation failed',
      validation.errors,
    );
  }

  const record = parsed as Record<string, unknown>;
  const { divergenceNotes, ...planBody } = record;
  const plan = JSON.stringify(planBody);

  return {
    plan,
    divergenceNotes:
      typeof divergenceNotes === 'string' && divergenceNotes.length > 0
        ? divergenceNotes
        : undefined,
  };
}

/**
 * Maximum file contracts per slice. Slices that touch many files in one
 * implementation pass tend to exhaust executor turn budgets before tests
 * can be written and verified. The planner is asked to split topics that
 * touch more than this number of files across multiple cohesive slices.
 */
export const MAX_FILE_CONTRACTS_PER_SLICE = 6;

/**
 * Maximum impact-weighted score per slice. Combines direct file contracts
 * with a fraction of dependent files (which the implementer must read to
 * understand impact). Caps the total "things the model has to think about"
 * even when each individual file is small.
 *
 * Formula: directFiles.length + ceil(dependentFiles.length * 0.3)
 * LOC weighting is not yet included; that requires a file-size resolver
 * and is tracked as a follow-up.
 */
export const MAX_SLICE_IMPACT_SCORE = 12;

export function computeSliceImpactScore(
  directFileCount: number,
  dependentFileCount: number,
): number {
  return directFileCount + Math.ceil(dependentFileCount * 0.3);
}

export function validateSlicePlan(
  slices: Slice[],
  session: Session,
  options: {
    deferredFindingIds?: Set<string>;
    allowDependentContinuationSlicesWithoutFindings?: boolean;
  } = {},
): { ok: true } | { ok: false; reason: string } {
  if (slices.length === 0) {
    return { ok: false, reason: 'Plan generation produced zero slices' };
  }

  const deferredFindingIds = options.deferredFindingIds ?? new Set<string>();
  const allowDependentContinuationSlicesWithoutFindings =
    options.allowDependentContinuationSlicesWithoutFindings ?? false;
  const openFindingIds = new Set(
    session.findings
      .filter((finding) => finding.status === 'open' && !deferredFindingIds.has(finding.id))
      .map((finding) => finding.id),
  );
  const assignedFindings = new Map<string, number>();

  for (const slice of slices) {
    const sliceNumber = slice.index + 1;
    if (slice.findings.length === 0) {
      if (
        allowDependentContinuationSlicesWithoutFindings &&
        slice.dependencies.length > 0 &&
        slice.impactAnalysis.directFiles.length > 0
      ) {
        continue;
      }
      return {
        ok: false,
        reason: `Plan left slice ${sliceNumber} without finding assignments`,
      };
    }

    if (slice.impactAnalysis.directFiles.length === 0) {
      return {
        ok: false,
        reason: `Plan left slice ${sliceNumber} without file scope`,
      };
    }

    if (slice.impactAnalysis.directFiles.length > MAX_FILE_CONTRACTS_PER_SLICE) {
      return {
        ok: false,
        reason: `Plan gave slice ${sliceNumber} ${slice.impactAnalysis.directFiles.length} file contracts; cap is ${MAX_FILE_CONTRACTS_PER_SLICE}. Split this slice into smaller cohesive units (e.g., scaffolding + wiring + tests as separate slices).`,
      };
    }

    const impactScore = computeSliceImpactScore(
      slice.impactAnalysis.directFiles.length,
      slice.impactAnalysis.dependentFiles.length,
    );
    if (impactScore > MAX_SLICE_IMPACT_SCORE) {
      return {
        ok: false,
        reason: `Plan gave slice ${sliceNumber} an impact score of ${impactScore} (${slice.impactAnalysis.directFiles.length} direct + ${slice.impactAnalysis.dependentFiles.length} dependent files); cap is ${MAX_SLICE_IMPACT_SCORE}. Either narrow the dependent-file impact or split the slice.`,
      };
    }

    const invalidDependency = slice.dependencies.find((dependency) => dependency >= slices.length);
    if (invalidDependency != null) {
      return {
        ok: false,
        reason: `Plan gave slice ${sliceNumber} an out-of-range dependency on slice ${invalidDependency + 1}`,
      };
    }

    const selfDependency = slice.dependencies.find((dependency) => dependency === slice.index);
    if (selfDependency != null) {
      return {
        ok: false,
        reason: `Plan made slice ${sliceNumber} depend on itself`,
      };
    }

    const futureDependency = slice.dependencies.find((dependency) => dependency > slice.index);
    if (futureDependency != null) {
      return {
        ok: false,
        reason: `Plan made slice ${sliceNumber} depend on later slice ${futureDependency + 1}`,
      };
    }

    for (const findingId of slice.findings) {
      if (deferredFindingIds.has(findingId)) {
        return {
          ok: false,
          reason: `Plan assigned deferred finding ${findingId} to slice ${sliceNumber}`,
        };
      }

      if (!openFindingIds.has(findingId)) {
        return {
          ok: false,
          reason: `Plan assigned unknown or non-open finding ${findingId} to slice ${sliceNumber}`,
        };
      }

      const priorSlice = assignedFindings.get(findingId);
      if (priorSlice != null) {
        return {
          ok: false,
          reason: `Plan assigned finding ${findingId} to multiple slices (${priorSlice + 1} and ${sliceNumber})`,
        };
      }

      assignedFindings.set(findingId, slice.index);
    }
  }

  const unassignedFindings = [...openFindingIds].filter(
    (findingId) => !assignedFindings.has(findingId),
  );
  if (unassignedFindings.length > 0) {
    return {
      ok: false,
      reason: `Plan left ${unassignedFindings.length} findings unassigned`,
    };
  }

  const slicesWithoutTests = slices.filter((slice) => slice.testLock.requiredTests.length === 0);
  if (slicesWithoutTests.length > 0) {
    return {
      ok: false,
      reason: `Plan left ${slicesWithoutTests.length} slices without required tests`,
    };
  }

  return { ok: true };
}

export function normalizeBroadReplayPlanFindingOwnership(slices: Slice[]): {
  slices: Slice[];
  changed: boolean;
  removedAssignments: number;
} {
  const ownedFindingIds = new Set<string>();
  let changed = false;
  let removedAssignments = 0;

  const normalizedSlices = slices.map((slice) => {
    const uniqueFindings: string[] = [];
    for (const findingId of slice.findings) {
      if (ownedFindingIds.has(findingId)) {
        changed = true;
        removedAssignments += 1;
        continue;
      }
      ownedFindingIds.add(findingId);
      uniqueFindings.push(findingId);
    }

    if (!changed || uniqueFindings.length === slice.findings.length) {
      return slice;
    }

    return {
      ...slice,
      findings: uniqueFindings,
    };
  });

  return {
    slices: changed ? normalizedSlices : slices,
    changed,
    removedAssignments,
  };
}

export function normalizeStructuredLine(rawLine: string): string {
  const directiveIndex = rawLine.search(/\b(?:FINDING|DECISION):/i);
  let line = directiveIndex >= 0 ? rawLine.slice(directiveIndex) : rawLine;
  line = line.trim();
  line = line.replace(/^[-*>\s\d.)]+/, '').trim();
  line = line.replace(/^\*+/, '').replace(/\*+$/, '').trim();
  line = line.replace(/^`+|`+$/g, '').trim();
  return line;
}

export function parseStructuredStageOutput(
  output: string,
  schemaId: 'analysis-report',
): AnalysisStageOutput | null;
export function parseStructuredStageOutput(
  output: string,
  schemaId: 'reproduction-report',
): ReproductionStageOutput | null;
export function parseStructuredStageOutput(
  output: string,
  schemaId: 'slice-plan',
): SlicePlanStageOutput | null;
export function parseStructuredStageOutput(
  output: string,
  schemaId: 'plan-review',
): PlanReviewStageOutput | null;
export function parseStructuredStageOutput(
  output: string,
  schemaId: 'impact-analysis',
): ImpactAnalysisStageOutput | null;
export function parseStructuredStageOutput(
  output: string,
  schemaId: 'plan-c-with-divergence',
): SlicePlanStageOutput | null;
export function parseStructuredStageOutput(
  output: string,
  schemaId: 'oracle-review',
): OracleReviewStageOutput | null;
export function parseStructuredStageOutput(
  output: string,
  schemaId: 'workspace-reconcile',
): WorkspaceReconcileStageOutput | null;
export function parseStructuredStageOutput(
  output: string,
  schemaId: 'failure-advisory',
): FailureAdvisoryStageOutput | null;
export function parseStructuredStageOutput(
  output: string,
  schemaId: StageOutputSchemaId,
):
  | AnalysisStageOutput
  | FailureAdvisoryStageOutput
  | ReproductionStageOutput
  | SlicePlanStageOutput
  | PlanReviewStageOutput
  | ImpactAnalysisStageOutput
  | OracleReviewStageOutput
  | WorkspaceReconcileStageOutput
  | null;
export function parseStructuredStageOutput(
  output: string,
  schemaId: StageOutputSchemaId,
):
  | AnalysisStageOutput
  | FailureAdvisoryStageOutput
  | ReproductionStageOutput
  | SlicePlanStageOutput
  | PlanReviewStageOutput
  | ImpactAnalysisStageOutput
  | OracleReviewStageOutput
  | WorkspaceReconcileStageOutput
  | null {
  return parseStructuredStageOutputResult(output, schemaId).data;
}

export function parseStructuredStageOutputResult(
  output: string,
  schemaId: 'analysis-report',
): StructuredStageOutputParseResult<AnalysisStageOutput>;
export function parseStructuredStageOutputResult(
  output: string,
  schemaId: 'reproduction-report',
): StructuredStageOutputParseResult<ReproductionStageOutput>;
export function parseStructuredStageOutputResult(
  output: string,
  schemaId: 'slice-plan',
): StructuredStageOutputParseResult<SlicePlanStageOutput>;
export function parseStructuredStageOutputResult(
  output: string,
  schemaId: 'plan-review',
): StructuredStageOutputParseResult<PlanReviewStageOutput>;
export function parseStructuredStageOutputResult(
  output: string,
  schemaId: 'impact-analysis',
): StructuredStageOutputParseResult<ImpactAnalysisStageOutput>;
export function parseStructuredStageOutputResult(
  output: string,
  schemaId: 'plan-c-with-divergence',
): StructuredStageOutputParseResult<SlicePlanStageOutput>;
export function parseStructuredStageOutputResult(
  output: string,
  schemaId: 'oracle-review',
): StructuredStageOutputParseResult<OracleReviewStageOutput>;
export function parseStructuredStageOutputResult(
  output: string,
  schemaId: 'workspace-reconcile',
): StructuredStageOutputParseResult<WorkspaceReconcileStageOutput>;
export function parseStructuredStageOutputResult(
  output: string,
  schemaId: 'failure-advisory',
): StructuredStageOutputParseResult<FailureAdvisoryStageOutput>;
export function parseStructuredStageOutputResult(
  output: string,
  schemaId: StageOutputSchemaId,
):
  | StructuredStageOutputParseResult<AnalysisStageOutput>
  | StructuredStageOutputParseResult<FailureAdvisoryStageOutput>
  | StructuredStageOutputParseResult<ReproductionStageOutput>
  | StructuredStageOutputParseResult<SlicePlanStageOutput>
  | StructuredStageOutputParseResult<PlanReviewStageOutput>
  | StructuredStageOutputParseResult<ImpactAnalysisStageOutput>
  | StructuredStageOutputParseResult<OracleReviewStageOutput>
  | StructuredStageOutputParseResult<WorkspaceReconcileStageOutput>;
export function parseStructuredStageOutputResult(
  output: string,
  schemaId: StageOutputSchemaId,
):
  | StructuredStageOutputParseResult<AnalysisStageOutput>
  | StructuredStageOutputParseResult<FailureAdvisoryStageOutput>
  | StructuredStageOutputParseResult<ReproductionStageOutput>
  | StructuredStageOutputParseResult<SlicePlanStageOutput>
  | StructuredStageOutputParseResult<PlanReviewStageOutput>
  | StructuredStageOutputParseResult<ImpactAnalysisStageOutput>
  | StructuredStageOutputParseResult<OracleReviewStageOutput>
  | StructuredStageOutputParseResult<WorkspaceReconcileStageOutput> {
  const parsed = parseJsonFromOutput(output);
  if (parsed == null) {
    return {
      data: null,
      error: buildStructuredStageOutputParseError(
        schemaId,
        `No JSON object found for ${schemaId} output`,
      ),
    };
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      data: null,
      error: buildStructuredStageOutputParseError(
        schemaId,
        `${schemaId} output must be a JSON object`,
      ),
    };
  }

  const sanitized = sanitizeStructuredStageOutputCandidate(schemaId, parsed);
  const validation = validateStageOutputData({ id: schemaId }, sanitized);
  if (!validation.ok) {
    return {
      data: null,
      error: buildStructuredStageOutputParseError(
        schemaId,
        `${schemaId} JSON failed schema validation`,
        validation.errors,
      ),
    };
  }

  switch (schemaId) {
    case 'analysis-report':
      return buildStructuredStageOutputParseSuccess(schemaId, normalizeAnalysisStageOutput(parsed));
    case 'reproduction-report':
      return buildStructuredStageOutputParseSuccess(
        schemaId,
        normalizeReproductionStageOutput(parsed),
      );
    case 'slice-plan':
      return buildStructuredStageOutputParseSuccess(
        schemaId,
        normalizeSlicePlanStageOutput(sanitized),
      );
    case 'plan-c-with-divergence':
      return buildStructuredStageOutputParseSuccess(
        schemaId,
        normalizeSlicePlanStageOutput(sanitized),
      );
    case 'plan-review':
      return buildStructuredStageOutputParseSuccess(
        schemaId,
        normalizePlanReviewStageOutput(parsed),
      );
    case 'impact-analysis':
      return buildStructuredStageOutputParseSuccess(
        schemaId,
        normalizeImpactAnalysisStageOutput(parsed),
      );
    case 'oracle-review':
      return buildStructuredStageOutputParseSuccess(
        schemaId,
        normalizeOracleReviewStageOutput(parsed),
      );
    case 'workspace-reconcile':
      return buildStructuredStageOutputParseSuccess(
        schemaId,
        normalizeWorkspaceReconcileStageOutput(parsed),
      );
    case 'failure-advisory':
      return buildStructuredStageOutputParseSuccess(
        schemaId,
        normalizeFailureAdvisoryStageOutput(parsed),
      );
  }
}

function sanitizeStructuredStageOutputCandidate(
  schemaId: StageOutputSchemaId,
  parsed: object,
): object {
  switch (schemaId) {
    case 'slice-plan':
      return sanitizeSlicePlanStageOutput(parsed);
    default:
      return parsed;
  }
}

function sanitizeSlicePlanStageOutput(value: object): object {
  const candidate = value as Record<string, unknown>;
  return {
    summary: candidate['summary'],
    slices: Array.isArray(candidate['slices'])
      ? candidate['slices'].map((entry) => sanitizeSlicePlanRecord(entry))
      : candidate['slices'],
  };
}

function sanitizeSlicePlanRecord(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  return {
    title: candidate['title'],
    description: candidate['description'],
    findings: candidate['findings'],
    files: candidate['files'],
    tests: candidate['tests'],
    dependencies: candidate['dependencies'],
    legacyPaths: Array.isArray(candidate['legacyPaths'])
      ? candidate['legacyPaths'].map((entry) => sanitizeStructuredLegacyPathRecord(entry))
      : candidate['legacyPaths'],
  };
}

function sanitizeStructuredLegacyPathRecord(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Record<string, unknown>;
  return {
    path: candidate['path'],
    reason: candidate['reason'],
  };
}

function buildStructuredStageOutputParseSuccess<T>(
  schemaId: StageOutputSchemaId,
  value: T | null,
): StructuredStageOutputParseResult<T> {
  if (value != null) {
    return {
      data: value,
      error: null,
    };
  }

  return {
    data: null,
    error: buildStructuredStageOutputParseError(
      schemaId,
      `${schemaId} JSON matched the schema but could not be normalized`,
    ),
  };
}

function buildStructuredStageOutputParseError(
  schemaId: StageOutputSchemaId,
  message: string,
  details: string[] = [],
): StructuredStageOutputParseError {
  return {
    schemaId,
    message: details.length > 0 ? `${message}: ${details.slice(0, 4).join('; ')}` : message,
    details,
  };
}

function parseLineBasedAnalysisOutput(
  output: string,
  stageName: string,
): { findings: Finding[]; decisions: Decision[] } {
  const findings: Finding[] = [];
  const decisions: Decision[] = [];

  for (const rawLine of output.split('\n')) {
    const line = normalizeStructuredLine(rawLine);
    if (!line) continue;

    const findingMatch = line.match(/^FINDING:\s*\[(\w+)\]\s*\[([a-z-]+)\]\s*(.+)$/i);
    if (findingMatch) {
      const description = findingMatch[3].trim();
      findings.push({
        id: randomUUID().slice(0, 8),
        severity: normalizeSeverity(findingMatch[1]),
        category: normalizeCategory(findingMatch[2]),
        status: 'open',
        title: description,
        description,
        files: [],
        discoveredBy: stageName,
        createdAt: now(),
        updatedAt: now(),
      });
      continue;
    }

    const decisionMatch = line.match(/^DECISION:\s*\[(\w+)\]\s*(.+)$/i);
    if (decisionMatch) {
      decisions.push({
        id: randomUUID().slice(0, 8),
        classification: normalizeClassification(decisionMatch[1]),
        question: decisionMatch[2].trim(),
        context: '',
        oracleVotes: [],
        stage: stageName,
      });
    }
  }

  return { findings, decisions };
}

function parseLineBasedSlicePlan(output: string, session: Session): Slice[] {
  const slices: Slice[] = [];
  const lines = output.split('\n');

  let current: ParsedSliceDraft | null = null;
  let legacyPaths: LegacyPathPlan[] = [];

  for (const line of lines) {
    const sliceMatch = line.match(/^SLICE\s+(\d+)\s*:\s*(.+)$/i);
    if (sliceMatch) {
      if (current) {
        slices.push(finalizeSlice(current, legacyPaths));
        legacyPaths = [];
      }
      current = {
        index: slices.length,
        title: sliceMatch[2].trim(),
        description: '',
        findings: [],
        files: [],
        tests: [],
        dependencies: [],
      };
      continue;
    }

    if (!current) continue;

    const trimmed = line.replace(/^\s*[-*]\s*/, '').trim();

    const findingsMatch = trimmed.match(/^FINDINGS?\s*:\s*(.+)$/i);
    if (findingsMatch) {
      const ids = findingsMatch[1].split(/[,;\s]+/).filter(Boolean);
      current.findings = matchFindingIds(ids, session);
      continue;
    }

    const filesMatch = trimmed.match(/^FILES?\s*:\s*(.+)$/i);
    if (filesMatch) {
      current.files = filesMatch[1].split(/[,;\s]+/).filter(Boolean);
      continue;
    }

    const testsMatch = trimmed.match(/^TESTS?\s*:\s*(.+)$/i);
    if (testsMatch) {
      const value = testsMatch[1].trim().toLowerCase();
      current.tests =
        value === 'none' || value === 'n/a' ? [] : testsMatch[1].split(/[,;\s]+/).filter(Boolean);
      continue;
    }

    const depsMatch = trimmed.match(/^DEPENDS?\s*:\s*(.+)$/i);
    if (depsMatch) {
      const value = depsMatch[1].trim().toLowerCase();
      if (value !== 'none' && value !== 'n/a') {
        current.dependencies = value
          .split(/[,;\s]+/)
          .map((dependency) => parseInt(dependency, 10) - 1)
          .filter((dependency) => !Number.isNaN(dependency) && dependency >= 0);
      }
      continue;
    }

    const descriptionMatch = trimmed.match(/^DESCRIPTION\s*:\s*(.+)$/i);
    if (descriptionMatch) {
      current.description = descriptionMatch[1].trim();
      continue;
    }

    const legacyMatch = trimmed.match(/^LEGACY\s*:\s*(\S+)\s*[—–-]\s*(.+)$/i);
    if (legacyMatch) {
      legacyPaths.push({
        path: legacyMatch[1],
        reason: legacyMatch[2].trim(),
        removableAfter: slices.length,
        status: 'identified',
      });
    }
  }

  if (current) {
    slices.push(finalizeSlice(current, legacyPaths));
  }

  return slices;
}

function buildSlicesFromStructuredPlan(plan: SlicePlanStageOutput, session: Session): Slice[] {
  return plan.slices.map((record, index) =>
    finalizeSlice(
      {
        index,
        title: normalizeText(record.title) || `Slice ${index + 1}`,
        description: normalizeText(record.description),
        findings: matchFindingIds(record.findings, session),
        files: normalizeStringList(record.files),
        tests: normalizeStringList(record.tests),
        dependencies: normalizeDependencyIndexes(record.dependencies),
      },
      normalizeStructuredLegacyPaths(record.legacyPaths, index),
    ),
  );
}

export function applySliceAssignments(slices: Slice[], session: Session): void {
  for (const slice of slices) {
    for (const findingId of slice.findings) {
      const finding = session.findings.find((candidate) => candidate.id === findingId);
      if (!finding) continue;
      finding.assignedSlice = slice.index;
      finding.status = 'planned';
      finding.deferredReason = undefined;
    }
  }
}

function parseLineBasedImpactAnalysis(output: string, directFiles: string[]): ImpactAnalysis {
  const dependentFiles: string[] = [];
  const affectedTests: string[] = [];
  let riskLevel: 'low' | 'medium' | 'high' = 'medium';
  let notes = '';

  for (const line of output.split('\n')) {
    const dependentMatch = line.match(/^DEPENDENT:\s*(.+)$/i);
    if (dependentMatch) {
      dependentFiles.push(dependentMatch[1].trim());
      continue;
    }
    const testMatch = line.match(/^TEST:\s*(.+)$/i);
    if (testMatch) {
      affectedTests.push(testMatch[1].trim());
      continue;
    }
    const riskMatch = line.match(/^RISK:\s*(low|medium|high)$/i);
    if (riskMatch) {
      riskLevel = riskMatch[1].toLowerCase() as 'low' | 'medium' | 'high';
      continue;
    }
    const notesMatch = line.match(/^NOTES:\s*(.+)$/i);
    if (notesMatch) {
      notes = notesMatch[1].trim();
    }
  }

  return { directFiles, dependentFiles, affectedTests, riskLevel, notes };
}

function parseLineBasedOracleReviewOutput(output: string): OracleReviewStageOutput {
  const assessments: OracleFindingAssessmentRecord[] = [];
  const newFindings: StructuredFindingRecord[] = [];
  const decisions: StructuredDecisionRecord[] = [];

  for (const rawLine of output.split('\n')) {
    const line = normalizeStructuredLine(rawLine);
    if (!line) continue;

    const assessmentMatch = line.match(
      /^ASSESSMENT:\s*\[([^\]]+)\]\s*\[(confirm|challenge|reprioritize)\](?:\s*\[(critical|high|medium|low|info)\])?\s*(.+)$/i,
    );
    if (assessmentMatch) {
      assessments.push({
        findingId: assessmentMatch[1].trim(),
        verdict: normalizeOracleAssessmentVerdict(assessmentMatch[2]),
        severity: assessmentMatch[3]
          ? normalizeSeverity(assessmentMatch[3] as FindingSeverity)
          : null,
        rationale: assessmentMatch[4].trim(),
      });
      continue;
    }

    const findingMatch = line.match(/^FINDING:\s*\[(\w+)\]\s*\[([a-z-]+)\]\s*(.+)$/i);
    if (findingMatch) {
      const description = findingMatch[3].trim();
      newFindings.push({
        severity: normalizeSeverity(findingMatch[1]),
        category: normalizeCategory(findingMatch[2]),
        title: description,
        description,
        files: [],
      });
      continue;
    }

    const decisionMatch = line.match(/^DECISION:\s*\[(\w+)\]\s*(.+)$/i);
    if (decisionMatch) {
      decisions.push({
        classification: normalizeClassification(decisionMatch[1]),
        question: decisionMatch[2].trim(),
        context: null,
        answer: null,
      });
    }
  }

  return {
    summary: '',
    assessments,
    newFindings,
    decisions,
  };
}

function normalizeAnalysisStageOutput(value: object): AnalysisStageOutput | null {
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate['findings']) || !Array.isArray(candidate['decisions'])) {
    return null;
  }

  return {
    summary: normalizeText(candidate['summary']),
    findings: candidate['findings']
      .map((entry) => normalizeStructuredFindingRecord(entry))
      .filter((entry): entry is StructuredFindingRecord => entry != null),
    decisions: candidate['decisions']
      .map((entry) => normalizeStructuredDecisionRecord(entry))
      .filter((entry): entry is StructuredDecisionRecord => entry != null),
  };
}

function normalizeReproductionStageOutput(value: object): ReproductionStageOutput | null {
  const candidate = value as Record<string, unknown>;
  const testFile = normalizeText(candidate['testFile']);
  if (
    !testFile ||
    !Array.isArray(candidate['reproductionSteps']) ||
    !Array.isArray(candidate['findings']) ||
    !Array.isArray(candidate['decisions'])
  ) {
    return null;
  }

  return {
    summary: normalizeText(candidate['summary']),
    testFile,
    reproductionSteps: normalizeStringList(candidate['reproductionSteps']),
    findings: candidate['findings']
      .map((entry) => normalizeStructuredFindingRecord(entry))
      .filter((entry): entry is StructuredFindingRecord => entry != null),
    decisions: candidate['decisions']
      .map((entry) => normalizeStructuredDecisionRecord(entry))
      .filter((entry): entry is StructuredDecisionRecord => entry != null),
  };
}

function normalizeSlicePlanStageOutput(value: object): SlicePlanStageOutput | null {
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate['slices'])) {
    return null;
  }

  return {
    summary: normalizeText(candidate['summary']),
    slices: candidate['slices']
      .map((entry) => normalizeSlicePlanRecord(entry))
      .filter((entry): entry is SlicePlanRecord => entry != null),
  };
}

function normalizePlanReviewStageOutput(value: object): PlanReviewStageOutput | null {
  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate['findings']) ||
    !Array.isArray(candidate['sliceAssessments']) ||
    !Array.isArray(candidate['deferredFindings']) ||
    !Array.isArray(candidate['decisions'])
  ) {
    return null;
  }

  return {
    summary: normalizeText(candidate['summary']),
    findings: candidate['findings']
      .map((entry) => normalizePlanReviewFindingRecord(entry))
      .filter((entry): entry is PlanReviewFindingRecord => entry != null),
    sliceAssessments: candidate['sliceAssessments']
      .map((entry) => normalizePlanReviewSliceAssessmentRecord(entry))
      .filter((entry): entry is PlanReviewSliceAssessmentRecord => entry != null),
    deferredFindings: candidate['deferredFindings']
      .map((entry) => normalizeDeferredFindingRecord(entry))
      .filter((entry): entry is DeferredFindingRecord => entry != null),
    decisions: candidate['decisions']
      .map((entry) => normalizeStructuredDecisionRecord(entry))
      .filter((entry): entry is StructuredDecisionRecord => entry != null),
  };
}

function normalizeImpactAnalysisStageOutput(value: object): ImpactAnalysisStageOutput | null {
  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate['dependentFiles']) ||
    !Array.isArray(candidate['affectedTests']) ||
    typeof candidate['riskLevel'] !== 'string'
  ) {
    return null;
  }

  return {
    dependentFiles: normalizeStringList(candidate['dependentFiles']),
    affectedTests: normalizeStringList(candidate['affectedTests']),
    riskLevel: normalizeRiskLevel(candidate['riskLevel']),
    notes: normalizeText(candidate['notes']),
  };
}

function normalizeOracleReviewStageOutput(value: object): OracleReviewStageOutput | null {
  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate['assessments']) ||
    !Array.isArray(candidate['newFindings']) ||
    !Array.isArray(candidate['decisions'])
  ) {
    return null;
  }

  return {
    summary: normalizeText(candidate['summary']),
    assessments: candidate['assessments']
      .map((entry) => normalizeOracleFindingAssessmentRecord(entry))
      .filter((entry): entry is OracleFindingAssessmentRecord => entry != null),
    newFindings: candidate['newFindings']
      .map((entry) => normalizeStructuredFindingRecord(entry))
      .filter((entry): entry is StructuredFindingRecord => entry != null),
    decisions: candidate['decisions']
      .map((entry) => normalizeStructuredDecisionRecord(entry))
      .filter((entry): entry is StructuredDecisionRecord => entry != null),
  };
}

function normalizeWorkspaceReconcileStageOutput(
  value: object,
): WorkspaceReconcileStageOutput | null {
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate['assessments'])) {
    return null;
  }

  return {
    summary: normalizeText(candidate['summary']),
    assessments: candidate['assessments']
      .map((entry) => normalizeWorkspaceReconcileAssessmentRecord(entry))
      .filter((entry): entry is WorkspaceReconcileAssessmentRecord => entry != null),
  };
}

function normalizeFailureAdvisoryStageOutput(value: object): FailureAdvisoryStageOutput | null {
  const candidate = value as Record<string, unknown>;
  const summary = normalizeText(candidate['summary']);
  const suspectedCause = normalizeText(candidate['suspectedCause']);
  if (!summary || !suspectedCause) {
    return null;
  }

  return {
    summary,
    suspectedCause,
    recommendedAction: normalizeFailureAdvisoryRecommendedAction(candidate['recommendedAction']),
    promptGuidance: normalizeNullableText(candidate['promptGuidance']),
    operatorActions: Array.isArray(candidate['operatorActions'])
      ? candidate['operatorActions'].map((item) => normalizeText(item)).filter(Boolean)
      : [],
    budgetRecommendation: normalizeFailureAdvisoryBudgetRecommendation(
      candidate['budgetRecommendation'],
    ),
  };
}

function normalizeStructuredFindingRecord(value: unknown): StructuredFindingRecord | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const title = normalizeText(candidate['title']);
  const description = normalizeText(candidate['description']) || title;
  if (!title && !description) {
    return null;
  }

  return {
    severity: normalizeSeverity(candidate['severity']),
    category: normalizeCategory(candidate['category']),
    title: title || description,
    description: description || title,
    files: normalizeStringList(candidate['files']),
  };
}

function normalizePlanReviewFindingRecord(value: unknown): PlanReviewFindingRecord | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const finding = normalizeStructuredFindingRecord(candidate);
  if (!finding) {
    return null;
  }

  return {
    ...finding,
    disposition: normalizePlanReviewFindingDisposition(candidate['disposition']),
  };
}

function normalizeWorkspaceReconcileAssessmentRecord(
  value: unknown,
): WorkspaceReconcileAssessmentRecord | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const file = normalizeText(candidate['file']);
  const rationale = normalizeText(candidate['rationale']);
  if (!file || !rationale) {
    return null;
  }

  return {
    file,
    disposition: normalizeWorkspaceReconcileDisposition(candidate['disposition']),
    rationale,
  };
}

function normalizeStructuredDecisionRecord(value: unknown): StructuredDecisionRecord | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const question = normalizeText(candidate['question']);
  if (!question) {
    return null;
  }

  const context = normalizeNullableText(candidate['context']);
  const answer = normalizeNullableText(candidate['answer']);

  return {
    classification: normalizeClassification(candidate['classification']),
    question,
    context,
    answer,
  };
}

function normalizePlanReviewSliceAssessmentRecord(
  value: unknown,
): PlanReviewSliceAssessmentRecord | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const sliceNumber = normalizePositiveInteger(candidate['sliceNumber']);
  const rationale = normalizeText(candidate['rationale']);
  if (!sliceNumber || !rationale) {
    return null;
  }

  return {
    sliceNumber,
    verdict: normalizePlanReviewSliceVerdict(candidate['verdict']),
    rationale,
    requiredTestAmendments: normalizeStringList(candidate['requiredTestAmendments']),
  };
}

function normalizeDeferredFindingRecord(value: unknown): DeferredFindingRecord | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const findingId = normalizeText(candidate['findingId']);
  const reason = normalizeText(candidate['reason']);
  if (!findingId || !reason) {
    return null;
  }

  return { findingId, reason };
}

function normalizeOracleFindingAssessmentRecord(
  value: unknown,
): OracleFindingAssessmentRecord | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const findingId = normalizeText(candidate['findingId']);
  const rationale = normalizeText(candidate['rationale']);
  if (!findingId || !rationale) {
    return null;
  }

  return {
    findingId,
    verdict: normalizeOracleAssessmentVerdict(candidate['verdict']),
    rationale,
    severity: normalizeNullableSeverity(candidate['severity']),
    horizon: normalizeNullableFindingHorizon(candidate['horizon']),
  };
}

function normalizeSlicePlanRecord(value: unknown): SlicePlanRecord | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const title = normalizeText(candidate['title']);
  if (!title) {
    return null;
  }

  return {
    title,
    description: normalizeText(candidate['description']),
    findings: normalizeStringList(candidate['findings']),
    files: normalizeStringList(candidate['files']),
    tests: normalizeStringList(candidate['tests']),
    dependencies: normalizeIntegerList(candidate['dependencies']),
    legacyPaths: normalizeStructuredLegacyPathRecords(candidate['legacyPaths']),
  };
}

function normalizeStructuredLegacyPathRecords(value: unknown): StructuredLegacyPathRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeStructuredLegacyPathRecord(entry))
    .filter((entry): entry is StructuredLegacyPathRecord => entry != null);
}

function normalizeStructuredLegacyPathRecord(value: unknown): StructuredLegacyPathRecord | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const path = normalizeText(candidate['path']);
  const reason = normalizeText(candidate['reason']);
  if (!path || !reason) {
    return null;
  }

  return { path, reason };
}

function materializeFindingRecord(record: StructuredFindingRecord, stageName: string): Finding {
  const description = normalizeText(record.description) || record.title;
  const severity = normalizeSeverity(record.severity);
  return {
    id: randomUUID().slice(0, 8),
    severity,
    category: normalizeCategory(record.category),
    status: 'open',
    horizon: inferDefaultFindingHorizon(severity),
    title: normalizeText(record.title) || description,
    description,
    files: record.files.map((path) => ({ path })),
    discoveredBy: stageName,
    createdAt: now(),
    updatedAt: now(),
  };
}

function materializeDecisionRecord(record: StructuredDecisionRecord, stageName: string): Decision {
  return {
    id: randomUUID().slice(0, 8),
    classification: normalizeClassification(record.classification),
    question: normalizeText(record.question),
    context: normalizeText(record.context),
    answer: normalizeText(record.answer) || undefined,
    oracleVotes: [],
    stage: stageName,
  };
}

interface ParsedSliceDraft {
  index: number;
  title: string;
  description: string;
  findings: string[];
  files: string[];
  tests: string[];
  dependencies: number[];
}

function finalizeSlice(partial: ParsedSliceDraft, legacyPaths: LegacyPathPlan[]): Slice {
  const sliceFiles = normalizeStringList(partial.files);

  return {
    index: partial.index,
    title: partial.title || 'Untitled slice',
    description: partial.description,
    status: 'pending',
    findings: partial.findings,
    dependencies: partial.dependencies,
    manifest: {
      entryConditions: [],
      fileContracts: sliceFiles.map((path) => ({
        path,
        action: 'modify',
        reason: 'Planned file scope from slice plan',
      })),
      exportContracts: [],
    },
    testLock: {
      requiredTests: normalizeStringList(partial.tests).map((testFile) => ({
        testFile,
        description: `Required regression coverage for slice: ${partial.title}`,
        status: 'pending',
        coversFindings: partial.findings,
        isNew: true,
      })),
      regressionSuite: [],
      locked: false,
    },
    impactAnalysis: {
      directFiles: sliceFiles,
      dependentFiles: [],
      affectedTests: [],
      riskLevel: 'medium',
      notes: '',
    },
    legacyPaths,
    exitCriteria: [
      {
        id: 'typecheck',
        type: 'typecheck',
        description: 'TypeScript compiles',
        passed: false,
      },
      {
        id: 'lint',
        type: 'lint',
        description: 'Changed files are formatted',
        passed: false,
      },
      {
        id: 'workspace-scope-clean',
        type: 'workspace-scope-clean',
        description:
          'Workspace reconcile produced no out-of-scope working tree changes that fall outside the declared slice manifest',
        passed: false,
      },
      {
        id: 'architecture-reviewed',
        type: 'architecture-reviewed',
        description:
          'Architecture review found no blocking seam, wiring, or future-proofing issues',
        passed: false,
      },
      {
        id: 'test-lock',
        type: 'test-lock',
        description: 'Required tests pass and lock the slice',
        passed: false,
      },
      {
        id: 'impact-reviewed',
        type: 'impact-reviewed',
        description: 'Impact analysis complete',
        passed: false,
      },
    ],
  };
}

const FINDING_MATCH_STOP_WORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were']);

interface FindingReferenceFingerprint {
  normalized: string;
  reducedTokens: string[];
  slug: string;
  reducedSlug: string;
  collapsed: string;
  reducedCollapsed: string;
}

function matchFindingIds(refs: string[], session: Session): string[] {
  const matched = new Set<string>();
  const catalog = session.findings.map((finding) => ({
    id: finding.id,
    fingerprint: buildFindingReferenceFingerprint(finding.title),
  }));

  for (const ref of refs) {
    const trimmedRef = ref.trim();
    if (!trimmedRef) continue;

    const byId = catalog.find((finding) => finding.id === trimmedRef);
    if (byId) {
      matched.add(byId.id);
      continue;
    }

    const bestMatch = findBestFindingMatch(trimmedRef, catalog);
    if (bestMatch) {
      matched.add(bestMatch);
    }
  }

  return [...matched];
}

function buildFindingReferenceFingerprint(value: string): FindingReferenceFingerprint {
  const tokens = value
    .toLowerCase()
    .replace(/[`"'’]/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const reducedTokensBase = tokens.filter((token) => !FINDING_MATCH_STOP_WORDS.has(token));
  const reducedTokens = reducedTokensBase.length > 0 ? reducedTokensBase : tokens;

  return {
    normalized: tokens.join(' '),
    reducedTokens,
    slug: tokens.join('-'),
    reducedSlug: reducedTokens.join('-'),
    collapsed: tokens.join(''),
    reducedCollapsed: reducedTokens.join(''),
  };
}

function findBestFindingMatch(
  ref: string,
  catalog: Array<{ id: string; fingerprint: FindingReferenceFingerprint }>,
): string | null {
  const reference = buildFindingReferenceFingerprint(ref);
  let bestMatch: { id: string; score: number } | null = null;
  let isTie = false;

  for (const candidate of catalog) {
    const score = scoreFindingReferenceMatch(reference, candidate.fingerprint);
    if (score <= 0) {
      continue;
    }

    if (bestMatch == null || score > bestMatch.score) {
      bestMatch = { id: candidate.id, score };
      isTie = false;
      continue;
    }

    if (score === bestMatch.score && candidate.id !== bestMatch.id) {
      isTie = true;
    }
  }

  if (bestMatch == null || isTie) {
    return null;
  }

  return bestMatch.id;
}

function scoreFindingReferenceMatch(
  reference: FindingReferenceFingerprint,
  candidate: FindingReferenceFingerprint,
): number {
  if (reference.normalized.length === 0 || candidate.normalized.length === 0) {
    return 0;
  }

  if (candidate.normalized === reference.normalized) {
    return 100;
  }

  if (
    reference.normalized.length >= 12 &&
    (candidate.normalized.includes(reference.normalized) ||
      reference.normalized.includes(candidate.normalized))
  ) {
    return 92;
  }

  if (reference.reducedSlug.length > 0 && candidate.reducedSlug === reference.reducedSlug) {
    return 90;
  }

  if (
    reference.reducedCollapsed.length > 0 &&
    candidate.reducedCollapsed === reference.reducedCollapsed
  ) {
    return 88;
  }

  if (reference.slug.length > 0 && candidate.slug === reference.slug) {
    return 86;
  }

  if (reference.collapsed.length > 0 && candidate.collapsed === reference.collapsed) {
    return 84;
  }

  if (
    reference.reducedCollapsed.length >= 16 &&
    (candidate.reducedCollapsed.includes(reference.reducedCollapsed) ||
      reference.reducedCollapsed.includes(candidate.reducedCollapsed))
  ) {
    return 80;
  }

  const overlapCount = countTokenOverlap(reference.reducedTokens, candidate.reducedTokens);
  if (reference.reducedTokens.length >= 3 && overlapCount === reference.reducedTokens.length) {
    return 76;
  }

  if (reference.reducedTokens.length >= 4) {
    const coverage = overlapCount / reference.reducedTokens.length;
    if (coverage >= 0.8) {
      return Math.round(coverage * 100) - 10;
    }
  }

  return 0;
}

function countTokenOverlap(referenceTokens: string[], candidateTokens: string[]): number {
  if (referenceTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }

  const candidateSet = new Set(candidateTokens);
  return referenceTokens.filter((token) => candidateSet.has(token)).length;
}

function normalizeStructuredLegacyPaths(
  records: StructuredLegacyPathRecord[],
  removableAfter: number,
): LegacyPathPlan[] {
  return records.map((record) => ({
    path: record.path,
    reason: record.reason,
    removableAfter,
    status: 'identified',
  }));
}

function normalizeDependencyIndexes(dependencies: number[]): number[] {
  const normalized = dependencies
    .filter((dependency) => Number.isInteger(dependency) && dependency >= 0)
    .map((dependency) => (dependencies.includes(0) ? dependency : dependency - 1))
    .filter((dependency) => dependency >= 0);

  return [...new Set(normalized)];
}

function normalizeIntegerList(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const integers: number[] = [];
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isInteger(entry)) {
      integers.push(entry);
      continue;
    }
    if (typeof entry === 'string' && /^-?\d+$/.test(entry.trim())) {
      integers.push(parseInt(entry, 10));
    }
  }

  return integers;
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = parseInt(value, 10);
    return parsed > 0 ? parsed : null;
  }

  return null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items = value
    .map((entry) => normalizeText(entry))
    .filter((entry): entry is string => entry.length > 0);

  return [...new Set(items)];
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNullableText(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
}

function normalizeSeverity(value: unknown): Finding['severity'] {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (['critical', 'high', 'medium', 'low', 'info'].includes(normalized)) {
    return normalized as Finding['severity'];
  }
  return 'medium';
}

function normalizeNullableSeverity(value: unknown): Finding['severity'] | null {
  if (value == null) {
    return null;
  }

  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  return normalizeSeverity(normalized);
}

function normalizeFindingHorizon(value: unknown): FindingHorizon {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'next':
      return 'next';
    case 'near-term':
    case 'nearterm':
      return 'near-term';
    case 'long-term':
    case 'longterm':
      return 'long-term';
    case 'immediate':
    default:
      return 'immediate';
  }
}

function normalizeNullableFindingHorizon(value: unknown): FindingHorizon | null {
  if (value == null) {
    return null;
  }

  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  return normalizeFindingHorizon(normalized);
}

export function inferDefaultFindingHorizon(severity: FindingSeverity): FindingHorizon {
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

function normalizeCategory(value: unknown): Finding['category'] {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  const categories = [
    'redundancy',
    'wiring-gap',
    'inconsistency',
    'bug',
    'missing-test',
    'missing-doc',
    'security',
    'performance',
    'isolation',
    'dead-code',
    'stale-dependency',
  ];
  if (categories.includes(normalized)) {
    return normalized as Finding['category'];
  }
  return 'bug';
}

function normalizeClassification(value: unknown): Decision['classification'] {
  const normalized = typeof value === 'string' ? value.toUpperCase() : '';
  if (['ANSWERED', 'INFERRED', 'DECIDED', 'AMBIGUOUS'].includes(normalized)) {
    return normalized as Decision['classification'];
  }
  return 'AMBIGUOUS';
}

function normalizePlanReviewFindingDisposition(value: unknown): PlanReviewFindingDisposition {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'blocking' || normalized === 'advisory') {
    return normalized;
  }
  return 'blocking';
}

function normalizePlanReviewSliceVerdict(
  value: unknown,
): PlanReviewSliceAssessmentRecord['verdict'] {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'approved' || normalized === 'revise') {
    return normalized;
  }
  return 'revise';
}

function normalizeOracleAssessmentVerdict(
  value: unknown,
): OracleFindingAssessmentRecord['verdict'] {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'confirm' || normalized === 'challenge' || normalized === 'reprioritize') {
    return normalized;
  }
  return 'confirm';
}

function normalizeWorkspaceReconcileDisposition(value: unknown): WorkspaceReconcileDisposition {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'ignore' || normalized === 'block') {
    return normalized;
  }
  return 'block';
}

function normalizeFailureAdvisoryRecommendedAction(
  value: unknown,
): FailureAdvisoryStageOutput['recommendedAction'] {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (
    normalized === 'retry-stage' ||
    normalized === 'synthesize-stage' ||
    normalized === 'switch-model' ||
    normalized === 'continue-immediate-only' ||
    normalized === 'promote-stage' ||
    normalized === 'pause-and-resume'
  ) {
    return normalized;
  }
  return 'pause-and-resume';
}

function normalizeFailureAdvisoryBudgetRecommendation(
  value: unknown,
): FailureAdvisoryStageOutput['budgetRecommendation'] {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const rationale = normalizeText(candidate['rationale']);
  if (!rationale) {
    return null;
  }

  return {
    rationale,
    targetTurns: normalizePositiveInteger(candidate['targetTurns']) ?? undefined,
    explorationTurns: normalizePositiveInteger(candidate['explorationTurns']) ?? undefined,
    shellWarnFloor: normalizePositiveInteger(candidate['shellWarnFloor']) ?? undefined,
    shellAbortFloor: normalizePositiveInteger(candidate['shellAbortFloor']) ?? undefined,
  };
}

function normalizeRiskLevel(value: unknown): ImpactAnalysis['riskLevel'] {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return 'medium';
}

function parseJsonFromOutput(output: string): unknown {
  const candidates = collectJsonCandidates(output);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function collectJsonCandidates(output: string): string[] {
  const candidates = new Set<string>();
  const trimmed = output.trim();
  if (trimmed) {
    candidates.add(trimmed);
  }

  const fencedMatches = output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.add(candidate);
    }
  }

  const balancedObjects = extractBalancedJsonObjects(output);
  for (const candidate of balancedObjects) {
    candidates.add(candidate);
  }

  return [...candidates].sort((left, right) => right.length - left.length);
}

function extractBalancedJsonObjects(output: string): string[] {
  const candidates = new Set<string>();

  for (let index = 0; index < output.length; index++) {
    if (output[index] !== '{') {
      continue;
    }

    const candidate = extractBalancedJsonObjectFrom(output, index);
    if (candidate) {
      candidates.add(candidate);
    }
  }

  return [...candidates];
}

function extractBalancedJsonObjectFrom(output: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < output.length; index++) {
    const char = output[index];

    if (index === start) {
      if (char !== '{') {
        return null;
      }
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth++;
      continue;
    }

    if (char === '}') {
      depth--;
      if (depth === 0) {
        return output.slice(start, index + 1).trim();
      }
    }
  }

  return null;
}

function now(): string {
  return new Date().toISOString();
}
