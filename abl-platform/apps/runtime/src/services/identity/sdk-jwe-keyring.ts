import {
  createLocalSdkJweKeyHandle,
  type SDKJweKeyHandle,
  type SDKTokenEnvelopePurpose,
} from '@agent-platform/shared-auth';
import type {
  RuntimeSdkJweCapability,
  RuntimeSdkJweCapabilityBlockReason,
} from './sdk-token-envelope-policy.js';

export type RuntimeSdkJweKeyStatus = 'active' | 'previous' | 'disabled';

export interface RuntimeSdkJweKeyInput {
  kid: string;
  purposes: SDKTokenEnvelopePurpose[];
  status: RuntimeSdkJweKeyStatus;
  keyBytes: Uint8Array;
}

export interface RuntimeSdkJweSafetyGates {
  redactionVerified: boolean;
  diagnosticsReady: boolean;
  bootstrapTransportBudgetVerified: boolean;
  sessionTransportBudgetVerified: boolean;
}

export interface RuntimeSdkJweSafeKeyMetadata {
  kid: string;
  purposes: SDKTokenEnvelopePurpose[];
  status: RuntimeSdkJweKeyStatus;
  alg: 'dir';
}

export interface RuntimeSdkJweKeyProvider {
  getCapability(): RuntimeSdkJweCapability;
  getActiveKey(purpose: SDKTokenEnvelopePurpose): SDKJweKeyHandle | null;
  resolveKey(kid: string, purpose: SDKTokenEnvelopePurpose): SDKJweKeyHandle | null;
  listSafeMetadata(): RuntimeSdkJweSafeKeyMetadata[];
}

const READY_SAFETY_GATES: RuntimeSdkJweSafetyGates = {
  redactionVerified: true,
  diagnosticsReady: true,
  bootstrapTransportBudgetVerified: true,
  sessionTransportBudgetVerified: true,
};

function uniquePurposes(purposes: SDKTokenEnvelopePurpose[]): SDKTokenEnvelopePurpose[] {
  return Array.from(new Set(purposes));
}

function getGateBlockReason(
  safetyGates: RuntimeSdkJweSafetyGates,
): RuntimeSdkJweCapabilityBlockReason | undefined {
  if (!safetyGates.redactionVerified) {
    return 'redaction_unverified';
  }
  if (!safetyGates.diagnosticsReady) {
    return 'diagnostics_unready';
  }
  if (
    !safetyGates.bootstrapTransportBudgetVerified ||
    !safetyGates.sessionTransportBudgetVerified
  ) {
    return 'transport_budget_unverified';
  }
  return undefined;
}

function hasPurpose(record: RuntimeSdkJweKeyInput, purpose: SDKTokenEnvelopePurpose): boolean {
  return record.purposes.includes(purpose);
}

function hasUsableKey(records: RuntimeSdkJweKeyInput[], purpose: SDKTokenEnvelopePurpose): boolean {
  return records.some((record) => record.status !== 'disabled' && hasPurpose(record, purpose));
}

function hasActiveKey(records: RuntimeSdkJweKeyInput[], purpose: SDKTokenEnvelopePurpose): boolean {
  return records.some((record) => record.status === 'active' && hasPurpose(record, purpose));
}

function buildUnavailableCapability(
  blockedReason: RuntimeSdkJweCapabilityBlockReason,
): RuntimeSdkJweCapability {
  return {
    supported: false,
    canIssueBootstrap: false,
    canIssueSession: false,
    canVerify: false,
    blockedReason,
  };
}

export function createDisabledSdkJweKeyProvider(): RuntimeSdkJweKeyProvider {
  return {
    getCapability() {
      return buildUnavailableCapability('provider_disabled');
    },
    getActiveKey() {
      return null;
    },
    resolveKey() {
      return null;
    },
    listSafeMetadata() {
      return [];
    },
  };
}

export function createStaticSdkJweKeyProvider(input: {
  keys: RuntimeSdkJweKeyInput[];
  safetyGates?: Partial<RuntimeSdkJweSafetyGates>;
}): RuntimeSdkJweKeyProvider {
  const safetyGates: RuntimeSdkJweSafetyGates = {
    ...READY_SAFETY_GATES,
    ...input.safetyGates,
  };
  const safeRecords = input.keys.map((key) => ({
    ...key,
    purposes: uniquePurposes(key.purposes),
    keyBytes: new Uint8Array(key.keyBytes),
  }));
  const handles = new Map<string, SDKJweKeyHandle>();

  for (const record of safeRecords) {
    for (const purpose of record.purposes) {
      const mapKey = `${record.kid}:${purpose}`;
      if (handles.has(mapKey)) {
        throw new Error(`Duplicate SDK JWE key for kid and purpose: ${record.kid}`);
      }
      handles.set(
        mapKey,
        createLocalSdkJweKeyHandle({
          kid: record.kid,
          purpose,
          keyBytes: record.keyBytes,
        }),
      );
    }
  }

  function lookup(kid: string, purpose: SDKTokenEnvelopePurpose): SDKJweKeyHandle | null {
    return handles.get(`${kid}:${purpose}`) ?? null;
  }

  return {
    getCapability() {
      const gateBlockReason = getGateBlockReason(safetyGates);
      if (gateBlockReason) {
        return buildUnavailableCapability(gateBlockReason);
      }

      const canVerify =
        hasUsableKey(safeRecords, 'sdk_bootstrap') || hasUsableKey(safeRecords, 'sdk_session');
      const canIssueBootstrap =
        safetyGates.bootstrapTransportBudgetVerified && hasActiveKey(safeRecords, 'sdk_bootstrap');
      const canIssueSession =
        safetyGates.sessionTransportBudgetVerified && hasActiveKey(safeRecords, 'sdk_session');

      return {
        supported: canVerify,
        canIssueBootstrap,
        canIssueSession,
        canVerify,
        ...(!canVerify || !canIssueBootstrap || !canIssueSession
          ? { blockedReason: 'key_provider_unavailable' as const }
          : {}),
      };
    },
    getActiveKey(purpose) {
      const record = safeRecords.find(
        (candidate) => candidate.status === 'active' && hasPurpose(candidate, purpose),
      );
      return record ? lookup(record.kid, purpose) : null;
    },
    resolveKey(kid, purpose) {
      const record = safeRecords.find(
        (candidate) =>
          candidate.kid === kid &&
          candidate.status !== 'disabled' &&
          hasPurpose(candidate, purpose),
      );
      return record ? lookup(record.kid, purpose) : null;
    },
    listSafeMetadata() {
      return safeRecords.map((record) => ({
        kid: record.kid,
        purposes: [...record.purposes],
        status: record.status,
        alg: 'dir',
      }));
    },
  };
}
