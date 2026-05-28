/**
 * Auth Profile Resolver — resolves exported auth profile names to target environment IDs.
 *
 * Resolution cascade:
 * 1. User-provided manual mapping (from import options — highest priority)
 * 2. Exact name match (case-insensitive) — auto-applied (confidence 1.0)
 * 3. Fuzzy match by (authType + scope + connector) — NEVER auto-applied.
 *    Fuzzy matches are returned as `suggestedMatch` in the unresolved array.
 *    The preview endpoint presents these for user confirmation. The user must
 *    explicitly include confirmed fuzzy matches in `userMappings` to apply them.
 *
 * Only active profiles are considered as candidates.
 */

// ── Types ──

export type ResolutionStrategy = 'exact_name' | 'user_mapped';

export interface ResolvedAuthProfile {
  exportedName: string;
  resolvedId: string;
  resolvedName: string;
  strategy: ResolutionStrategy;
  confidence: number; // 0.0 - 1.0
}

export interface UnresolvedAuthProfile {
  exportedName: string;
  authType: string;
  scope: 'tenant' | 'project';
  connector?: string;
  referencedBy: string[];
  /** Candidate matches found during fuzzy search */
  candidates: Array<{
    id: string;
    name: string;
    authType: string;
    score: number;
  }>;
  /**
   * Best fuzzy candidate with score >= 0.7, if any.
   * Presented in the preview UI as a suggestion for user confirmation.
   * NEVER auto-applied — the user must explicitly confirm via userMappings.
   */
  suggestedMatch?: {
    id: string;
    name: string;
    authType: string;
    score: number;
  };
}

export interface AuthProfileResolution {
  resolved: Map<string, ResolvedAuthProfile>;
  unresolved: UnresolvedAuthProfile[];
  /** Pre-built mapping: exportedName -> targetId (for connection rewriting) */
  nameToIdMap: Record<string, string>;
}

/** Minimal auth profile record from the database */
export interface TargetAuthProfile {
  _id: string;
  name: string;
  authType: string;
  scope: 'tenant' | 'project';
  connector?: string;
  category?: string;
  visibility: 'shared' | 'personal';
  status: 'active' | 'expired' | 'revoked' | 'invalid';
}

/** Minimal required profile reference from the manifest */
export interface RequiredAuthProfileRef {
  name: string;
  authType: string;
  scope: 'tenant' | 'project';
  connector?: string;
  category?: string;
  referencedBy: string[];
}

// ── Main resolver ──

/**
 * Resolve exported auth profile references to target environment IDs.
 *
 * Only active profiles are considered as candidates. Exact name matches
 * (case-insensitive) are auto-applied. Fuzzy matches are returned as
 * suggestions that require explicit user confirmation.
 */
export function resolveAuthProfiles(
  required: RequiredAuthProfileRef[],
  targetProfiles: TargetAuthProfile[],
  userMappings?: Record<string, string>,
): AuthProfileResolution {
  const resolved = new Map<string, ResolvedAuthProfile>();
  const unresolved: UnresolvedAuthProfile[] = [];
  const nameToIdMap: Record<string, string> = {};

  // Filter to active profiles only
  const activeProfiles = targetProfiles.filter((p) => p.status === 'active');

  // Build lookup indexes
  const byNameLower = new Map<string, TargetAuthProfile>();
  for (const p of activeProfiles) {
    byNameLower.set(p.name.toLowerCase(), p);
  }

  for (const req of required) {
    // Step 0: Check user-provided mapping first
    if (userMappings && userMappings[req.name]) {
      const mappedId = userMappings[req.name];
      const target = activeProfiles.find((p) => p._id === mappedId);
      if (target) {
        const entry: ResolvedAuthProfile = {
          exportedName: req.name,
          resolvedId: target._id,
          resolvedName: target.name,
          strategy: 'user_mapped',
          confidence: 1.0,
        };
        resolved.set(req.name, entry);
        nameToIdMap[req.name] = target._id;
        continue;
      }
    }

    // Step 1: Exact name match (case-insensitive)
    const exactMatch = byNameLower.get(req.name.toLowerCase());
    if (exactMatch) {
      const entry: ResolvedAuthProfile = {
        exportedName: req.name,
        resolvedId: exactMatch._id,
        resolvedName: exactMatch.name,
        strategy: 'exact_name',
        confidence: 1.0,
      };
      resolved.set(req.name, entry);
      nameToIdMap[req.name] = exactMatch._id;
      continue;
    }

    // Step 2: Fuzzy match by (authType + scope + connector) — NEVER auto-applied
    const candidates = scoreCandidates(req, activeProfiles);

    // Step 3: Unresolved — user must confirm or manually map
    unresolved.push({
      exportedName: req.name,
      authType: req.authType,
      scope: req.scope,
      connector: req.connector,
      referencedBy: req.referencedBy,
      candidates: candidates.slice(0, 5),
      suggestedMatch:
        candidates.length > 0 && candidates[0].score >= 0.7 ? candidates[0] : undefined,
    });
  }

  return { resolved, unresolved, nameToIdMap };
}

/**
 * Rewrite authProfileName references to authProfileId in connection data.
 * Called during the connections layer disassembly before staging.
 */
export function rewriteConnectionAuthProfiles(
  connectionData: Record<string, unknown>,
  nameToIdMap: Record<string, string>,
): { rewritten: Record<string, unknown>; unmapped: string[] } {
  const unmapped: string[] = [];
  const rewritten = { ...connectionData };

  const profileName = rewritten.authProfileName as string | undefined;
  if (profileName) {
    const resolvedId = nameToIdMap[profileName];
    if (resolvedId) {
      rewritten.authProfileId = resolvedId;
      delete rewritten.authProfileName;
    } else {
      unmapped.push(profileName);
    }
  }

  return { rewritten, unmapped };
}

// ── Scoring ──

/**
 * Score target profiles against an exported requirement.
 *
 * Scoring weights:
 * - authType match:  0.4 (required for any match)
 * - scope match:     0.2
 * - connector match: 0.3
 * - category match:  0.1
 */
function scoreCandidates(
  req: RequiredAuthProfileRef,
  targets: TargetAuthProfile[],
): Array<{ id: string; name: string; authType: string; score: number }> {
  const results: Array<{
    id: string;
    name: string;
    authType: string;
    score: number;
  }> = [];

  for (const t of targets) {
    let score = 0;

    // authType is a hard requirement — skip if no match
    if (t.authType !== req.authType) continue;
    score += 0.4;

    if (t.scope === req.scope) score += 0.2;

    if (req.connector && t.connector && t.connector.toLowerCase() === req.connector.toLowerCase()) {
      score += 0.3;
    }

    if (req.category && t.category && t.category.toLowerCase() === req.category.toLowerCase()) {
      score += 0.1;
    }

    results.push({
      id: t._id,
      name: t.name,
      authType: t.authType,
      score,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

// ── Convenience types for simpler consumers ──

/**
 * Simplified auth profile candidate type.
 * Used by prerequisite-validator and import preview UI.
 */
export interface AuthProfileCandidate {
  name: string;
  authType: string;
  scope: 'tenant' | 'project';
}

/**
 * Simplified resolution result for import preview display.
 * Built from the full AuthProfileResolution for consumers that
 * need a flat mapping rather than the rich resolved/unresolved model.
 */
export interface SimpleAuthProfileResolution {
  mapping: Record<string, string>;
  exactMatches: string[];
  suggestions: Array<{
    exportedName: string;
    candidates: AuthProfileCandidate[];
  }>;
  unmapped: string[];
  warnings: string[];
}

/**
 * Convert a full AuthProfileResolution to the simplified flat mapping format.
 * Useful for import preview endpoints that need a simpler shape.
 */
export function toSimpleResolution(resolution: AuthProfileResolution): SimpleAuthProfileResolution {
  const mapping: Record<string, string> = { ...resolution.nameToIdMap };
  const exactMatches: string[] = [];
  const suggestions: SimpleAuthProfileResolution['suggestions'] = [];
  const unmapped: string[] = [];
  const warnings: string[] = [];

  for (const [name, entry] of resolution.resolved) {
    if (entry.strategy === 'exact_name') {
      exactMatches.push(name);
    }
  }

  for (const entry of resolution.unresolved) {
    unmapped.push(entry.exportedName);
    if (entry.candidates.length > 0) {
      suggestions.push({
        exportedName: entry.exportedName,
        candidates: entry.candidates.map((c) => ({
          name: c.name,
          authType: c.authType,
          scope: entry.scope,
        })),
      });
    }
    if (entry.suggestedMatch) {
      warnings.push(
        `Auth profile "${entry.exportedName}" has a suggested match: ` +
          `"${entry.suggestedMatch.name}" (score: ${entry.suggestedMatch.score.toFixed(2)})`,
      );
    }
  }

  return { mapping, exactMatches, suggestions, unmapped, warnings };
}
