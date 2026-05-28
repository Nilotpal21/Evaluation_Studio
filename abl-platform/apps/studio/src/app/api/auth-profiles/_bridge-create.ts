/**
 * Best-effort upsert of the bridge ConnectorConnection that should be
 * auto-created alongside an integration auth profile.
 *
 * Extracted as a pure function with injectable deps so the creation path
 * can be unit-tested without platform mocks. Both the workspace and project
 * POST routes call this helper inside the withTransaction block — any
 * thrown error propagates to the transaction and rolls back the AuthProfile
 * on replica-set environments.
 */

export interface CreateBridgeDeps {
  /**
   * Upsert a ConnectorConnection matching `filter`. When the document is
   * newly inserted `setOnInsert` fields are written; when it already exists
   * the document is left unchanged. Returns whether the row already existed
   * prior to this call.
   *
   * The implementation is responsible for wrapping `setOnInsert` in
   * `$setOnInsert` — the pure function stays DB-operator-agnostic.
   */
  upsertOne: (
    filter: Record<string, unknown>,
    setOnInsert: Record<string, unknown>,
  ) => Promise<{ alreadyExisted: boolean }>;
  log: { debug: (msg: string, ctx: Record<string, unknown>) => void };
}

export interface CreateBridgeResult {
  /** True when a new ConnectorConnection was inserted. */
  created: boolean;
  /** True when no connector was specified — bridge creation intentionally skipped. */
  skipped: boolean;
}

/**
 * Upserts the bridge ConnectorConnection that links `connector` to
 * `profileId`. Profiles without a `connector` value are silently skipped
 * (not every auth profile is a connector bridge).
 *
 * Throws on `upsertOne` failure so the caller's transaction rolls back the
 * corresponding AuthProfile. The caller must NOT swallow this error.
 */
export async function createBridgeForProfile(
  params: {
    profileId: string;
    connector: string | null | undefined;
    tenantId: string;
    projectId: string;
    displayName: string;
    userId?: string | null;
  },
  deps: CreateBridgeDeps,
): Promise<CreateBridgeResult> {
  if (!params.connector) {
    return { created: false, skipped: true };
  }

  const filter = {
    tenantId: params.tenantId,
    projectId: params.projectId,
    connectorName: params.connector,
    authProfileId: params.profileId,
  };

  const setOnInsert = {
    tenantId: params.tenantId,
    projectId: params.projectId,
    connectorName: params.connector,
    displayName: params.displayName,
    scope: 'tenant' as const,
    userId: params.userId ?? null,
    authProfileId: params.profileId,
    status: 'active' as const,
  };

  const { alreadyExisted } = await deps.upsertOne(filter, setOnInsert);

  deps.log.debug('createBridgeForProfile result', {
    profileId: params.profileId,
    connector: params.connector,
    alreadyExisted,
  });

  return { created: !alreadyExisted, skipped: false };
}
