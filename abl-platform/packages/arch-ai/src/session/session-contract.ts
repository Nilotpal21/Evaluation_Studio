export const CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION = 3 as const;
export const DEFAULT_SESSION_THREAD_ID = '__default__' as const;

interface SessionContractMetadataLike {
  mode?: unknown;
  contractVersion?: unknown;
}

export function getSessionContractVersion(
  metadata: SessionContractMetadataLike | null | undefined,
): number | null {
  const value = metadata?.contractVersion;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export function hasSupportedInProjectSessionContract(
  metadata: SessionContractMetadataLike | null | undefined,
): boolean {
  if (metadata?.mode !== 'IN_PROJECT') {
    return true;
  }

  return getSessionContractVersion(metadata) === CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION;
}
