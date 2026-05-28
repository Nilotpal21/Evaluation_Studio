import mongoose from 'mongoose';
import { readChangeHistory } from './history.js';
import type {
  ChangeEnforcementMode,
  ChangeEnvironment,
  ChangeHistoryEntry,
  ChangeHistoryStatus,
  ChangeValidationStatus,
  ServiceChangeRequirement,
} from './types.js';

type Db = mongoose.mongo.Db;

export const DEFAULT_CHANGE_ENFORCEMENT_MODE: ChangeEnforcementMode = 'soft_ready';

export type ChangeGateOutcome = 'ready' | 'not_ready' | 'warn_only' | 'proxy_only';

export interface ChangeCompatibilityIssue {
  changeId: string;
  severity: 'blocking' | 'warning';
  status: ChangeHistoryStatus | 'missing';
  validationStatus?: ChangeValidationStatus;
  reason: 'missing' | 'pending' | 'failed' | 'rolled_back' | 'skipped' | 'validation_failed';
  message: string;
}

export interface ServiceChangeCompatibilityResult {
  service: string;
  environment: ChangeEnvironment;
  enforcementMode: ChangeEnforcementMode;
  outcome: ChangeGateOutcome;
  ready: boolean;
  shouldExit: boolean;
  checkedAt: Date;
  checkedChangeIds: string[];
  blockingIssues: ChangeCompatibilityIssue[];
  warningIssues: ChangeCompatibilityIssue[];
}

export interface LoadServiceChangeCompatibilityOptions {
  collectionName?: string;
}

function normalizeEnvironment(rawValue: string | undefined): ChangeEnvironment {
  const value = (rawValue ?? '').toLowerCase();

  if (value === 'production' || value === 'prod') {
    return 'prod';
  }

  if (value === 'staging' || value === 'stage') {
    return 'staging';
  }

  return 'dev';
}

export function resolveCurrentChangeEnvironment(): ChangeEnvironment {
  return normalizeEnvironment(
    process.env.CHANGE_ENVIRONMENT ??
      process.env.APP_ENV ??
      process.env.ENVIRONMENT ??
      process.env.NODE_ENV,
  );
}

export function resolveChangeEnforcementMode(
  rawValue = process.env.CHANGE_ENFORCEMENT_MODE,
): ChangeEnforcementMode {
  switch ((rawValue ?? '').toLowerCase()) {
    case 'hard_fail':
      return 'hard_fail';
    case 'warn_only':
      return 'warn_only';
    case 'proxy_only':
      return 'proxy_only';
    case 'soft_ready':
    default:
      return DEFAULT_CHANGE_ENFORCEMENT_MODE;
  }
}

function isSatisfiedHistoryStatus(status: ChangeHistoryStatus): boolean {
  return status === 'applied' || status === 'verified';
}

function buildIssue(
  changeId: string,
  entry: ChangeHistoryEntry | undefined,
  severity: 'blocking' | 'warning',
): ChangeCompatibilityIssue {
  if (!entry) {
    return {
      changeId,
      severity,
      status: 'missing',
      reason: 'missing',
      message: `${changeId} is missing from change history.`,
    };
  }

  if (entry.validationStatus === 'failed') {
    return {
      changeId,
      severity,
      status: entry.status,
      validationStatus: entry.validationStatus,
      reason: 'validation_failed',
      message: `${changeId} is present but the latest validation failed.`,
    };
  }

  switch (entry.status) {
    case 'pending':
      return {
        changeId,
        severity,
        status: entry.status,
        validationStatus: entry.validationStatus,
        reason: 'pending',
        message: `${changeId} has not been applied yet.`,
      };
    case 'failed':
      return {
        changeId,
        severity,
        status: entry.status,
        validationStatus: entry.validationStatus,
        reason: 'failed',
        message: `${changeId} is recorded as failed.`,
      };
    case 'rolled_back':
      return {
        changeId,
        severity,
        status: entry.status,
        validationStatus: entry.validationStatus,
        reason: 'rolled_back',
        message: `${changeId} was rolled back and no longer satisfies compatibility requirements.`,
      };
    case 'skipped':
      return {
        changeId,
        severity,
        status: entry.status,
        validationStatus: entry.validationStatus,
        reason: 'skipped',
        message: `${changeId} was skipped and does not satisfy compatibility requirements.`,
      };
    default:
      return {
        changeId,
        severity,
        status: entry.status,
        validationStatus: entry.validationStatus,
        reason: 'failed',
        message: `${changeId} does not currently satisfy compatibility requirements.`,
      };
  }
}

function pickHistoryByChangeId(
  historyEntries: ChangeHistoryEntry[],
  changeIds: string[],
): Map<string, ChangeHistoryEntry> {
  const historyByChangeId = new Map<string, ChangeHistoryEntry>();

  for (const changeId of changeIds) {
    const matchingEntries = historyEntries.filter((entry) => entry.changeId === changeId);
    const preferredEntry =
      matchingEntries.find(
        (entry) => isSatisfiedHistoryStatus(entry.status) && entry.validationStatus !== 'failed',
      ) ?? matchingEntries[0];

    if (preferredEntry) {
      historyByChangeId.set(changeId, preferredEntry);
    }
  }

  return historyByChangeId;
}

export function evaluateServiceChangeCompatibility(
  requirement: ServiceChangeRequirement,
  historyEntries: ChangeHistoryEntry[],
): ServiceChangeCompatibilityResult {
  const checkedAt = new Date();
  const checkedChangeIds = [
    ...new Set([...requirement.requiredChangeIds, ...(requirement.optionalChangeIds ?? [])]),
  ];
  const historyByChangeId = pickHistoryByChangeId(historyEntries, checkedChangeIds);

  const blockingIssues = requirement.requiredChangeIds
    .map((changeId) => {
      const entry = historyByChangeId.get(changeId);
      if (entry && isSatisfiedHistoryStatus(entry.status) && entry.validationStatus !== 'failed') {
        return null;
      }
      return buildIssue(changeId, entry, 'blocking');
    })
    .filter((issue): issue is ChangeCompatibilityIssue => issue !== null);

  const warningIssues = (requirement.optionalChangeIds ?? [])
    .map((changeId) => {
      const entry = historyByChangeId.get(changeId);
      if (entry && isSatisfiedHistoryStatus(entry.status) && entry.validationStatus !== 'failed') {
        return null;
      }
      return buildIssue(changeId, entry, 'warning');
    })
    .filter((issue): issue is ChangeCompatibilityIssue => issue !== null);

  if (requirement.enforcementMode === 'proxy_only') {
    return {
      service: requirement.service,
      environment: requirement.environment,
      enforcementMode: requirement.enforcementMode,
      outcome: 'proxy_only',
      ready: true,
      shouldExit: false,
      checkedAt,
      checkedChangeIds,
      blockingIssues,
      warningIssues,
    };
  }

  if (requirement.enforcementMode === 'warn_only') {
    return {
      service: requirement.service,
      environment: requirement.environment,
      enforcementMode: requirement.enforcementMode,
      outcome: blockingIssues.length > 0 || warningIssues.length > 0 ? 'warn_only' : 'ready',
      ready: true,
      shouldExit: false,
      checkedAt,
      checkedChangeIds,
      blockingIssues,
      warningIssues,
    };
  }

  const hasBlockingIssues = blockingIssues.length > 0;
  return {
    service: requirement.service,
    environment: requirement.environment,
    enforcementMode: requirement.enforcementMode,
    outcome: hasBlockingIssues ? 'not_ready' : 'ready',
    ready: !hasBlockingIssues,
    shouldExit: requirement.enforcementMode === 'hard_fail' && hasBlockingIssues,
    checkedAt,
    checkedChangeIds,
    blockingIssues,
    warningIssues,
  };
}

export async function loadServiceChangeCompatibility(
  db: Db,
  requirement: ServiceChangeRequirement,
  options: LoadServiceChangeCompatibilityOptions = {},
): Promise<ServiceChangeCompatibilityResult> {
  const checkedChangeIds = [
    ...new Set([...requirement.requiredChangeIds, ...(requirement.optionalChangeIds ?? [])]),
  ];

  if (checkedChangeIds.length === 0) {
    return evaluateServiceChangeCompatibility(requirement, []);
  }

  const historyEntries = await readChangeHistory(
    db,
    {
      environment: requirement.environment,
      changeId: { $in: checkedChangeIds },
      $or: [{ targetKey: { $exists: false } }, { targetKey: null }],
    },
    options.collectionName,
  );

  return evaluateServiceChangeCompatibility(requirement, historyEntries);
}
