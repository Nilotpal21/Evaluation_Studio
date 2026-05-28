/**
 * Best-effort cascade-delete of the bridge ConnectorConnection that was
 * auto-created alongside an integration auth profile.
 *
 * Extracted as a pure function with injectable deps so the rollback path
 * (deleteOne throws while the profile is already gone) can be unit-tested
 * without platform mocks. Both the workspace and project DELETE routes
 * call this helper and rely on its non-throwing contract.
 */

export interface CascadeDeleteBridgeDeps {
  deleteOne: (filter: Record<string, unknown>) => Promise<unknown>;
  log: { warn: (msg: string, ctx: Record<string, unknown>) => void };
}

export interface CascadeDeleteBridgeResult {
  deleted: boolean;
}

/**
 * Attempts to delete the bridge ConnectorConnection that was auto-created
 * alongside `profileId`. An orphaned bridge (empty credentials) is harmless
 * at execution time — the caller still returns 200 regardless of the outcome.
 *
 * Never throws. All errors are caught, logged as warnings, and reported
 * via `{ deleted: false }` so callers can observe the outcome without needing
 * their own try-catch.
 */
export async function cascadeDeleteBridge(
  params: { profileId: string; tenantId: string },
  deps: CascadeDeleteBridgeDeps,
): Promise<CascadeDeleteBridgeResult> {
  try {
    await deps.deleteOne({ authProfileId: params.profileId, tenantId: params.tenantId });
    return { deleted: true };
  } catch (err) {
    deps.log.warn('Failed to cascade-delete bridge ConnectorConnection', {
      profileId: params.profileId,
      tenantId: params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { deleted: false };
  }
}
