/**
 * Auth Profile Mapping for Import/Export
 *
 * Extracts auth profile requirements from manifests, matches candidates
 * in the target tenant/project, and applies ID remapping during import.
 */

export interface AuthProfileRequirement {
  name: string;
  authType: string;
  scope: 'tenant' | 'project';
  connector?: string;
  category?: string;
  connectionMode?: 'shared' | 'per_user';
  config: Record<string, unknown>;
  referencedBy: string[];
}

export interface AuthProfileCandidate {
  _id: string;
  name: string;
  authType: string;
}

export interface AuthProfileMatchResult {
  requirement: AuthProfileRequirement;
  candidates: AuthProfileCandidate[];
  autoMatched: boolean;
}

/**
 * Extract auth profile requirements from a v2 manifest's metadata.
 */
export function extractAuthMappingRequirements(
  manifest: {
    metadata?: {
      required_auth_profiles?: Array<{
        name: string;
        authType: string;
        scope?: 'tenant' | 'project';
        [key: string]: unknown;
      }>;
    };
  } | null,
): AuthProfileRequirement[] {
  if (!manifest?.metadata?.required_auth_profiles) return [];

  return manifest.metadata.required_auth_profiles.map((p) => ({
    name: p.name,
    authType: p.authType,
    scope: (p.scope as 'tenant' | 'project') ?? 'project',
    connector: p.connector as string | undefined,
    category: p.category as string | undefined,
    connectionMode: p.connectionMode as 'shared' | 'per_user' | undefined,
    config: (p.config as Record<string, unknown>) ?? {},
    referencedBy: (p.referencedBy as string[]) ?? [],
  }));
}

/**
 * Match auth profile requirements against existing profiles in the target scope.
 * Matches by name AND authType for safety.
 */
export function matchAuthProfileCandidates(
  requirements: AuthProfileRequirement[],
  existingProfiles: AuthProfileCandidate[],
): AuthProfileMatchResult[] {
  return requirements.map((req) => {
    const candidates = existingProfiles.filter(
      (p) => p.name === req.name && p.authType === req.authType,
    );
    return {
      requirement: req,
      candidates,
      autoMatched: candidates.length === 1,
    };
  });
}

/**
 * Apply auth profile ID mapping to imported connection data.
 * Replaces authProfileName references with the mapped authProfileId.
 *
 * @param connections - Array of connection objects from the import
 * @param mapping - Maps exported profile name to target profile ID
 * @returns Connections with authProfileId set from mapping
 */
export function applyAuthProfileMapping<T extends Record<string, unknown>>(
  connections: T[],
  mapping: Record<string, string>,
): T[] {
  return connections.map((conn) => {
    const profileName = conn.authProfileName as string | undefined;
    if (!profileName) return conn;

    const mappedId = mapping[profileName];
    if (!mappedId) return conn;

    return {
      ...conn,
      authProfileId: mappedId,
      authProfileName: undefined, // Remove name reference, replaced by ID
    };
  });
}

/**
 * Strip all authProfileId references from connections during cross-tenant import.
 * Auth profile IDs are tenant-scoped and cannot be carried across tenants.
 */
export function stripCrossTenantAuthReferences<T extends Record<string, unknown>>(
  connection: T,
): T {
  const { authProfileId, ...rest } = connection;
  return rest as T;
}
