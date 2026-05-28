export interface VersionInfoLike {
  versions?: Record<string, number>;
  rawVersions?: Record<string, string>;
}

export function normalizeAgentVersionKey(agentName: string): string {
  return agentName.toLowerCase().replace(/_/g, '');
}

export function resolveRawVersionAlias(
  rawVersions: Record<string, string> | undefined,
  agentName: string,
): string | undefined {
  if (!rawVersions || !agentName) return undefined;

  if (rawVersions[agentName]) return rawVersions[agentName];

  const normalized = normalizeAgentVersionKey(agentName);
  for (const [key, version] of Object.entries(rawVersions)) {
    if (normalizeAgentVersionKey(key) === normalized) {
      return version;
    }
  }

  return undefined;
}

export function resolveVersionString(
  versionInfo: VersionInfoLike | undefined,
  agentName: string,
): string | undefined {
  if (!versionInfo) return undefined;

  const rawVersion = resolveRawVersionAlias(versionInfo.rawVersions, agentName);
  if (rawVersion) return rawVersion;

  if (versionInfo.versions?.[agentName] != null) {
    return String(versionInfo.versions[agentName]);
  }

  if (versionInfo.versions && agentName) {
    const normalized = normalizeAgentVersionKey(agentName);
    for (const [key, version] of Object.entries(versionInfo.versions)) {
      if (normalizeAgentVersionKey(key) === normalized) {
        return String(version);
      }
    }
  }

  const firstRaw = Object.values(versionInfo.rawVersions ?? {}).find(
    (value) => typeof value === 'string' && value.length > 0,
  );
  if (firstRaw) return firstRaw;

  const firstNumeric = Object.values(versionInfo.versions ?? {}).find(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
  if (firstNumeric != null) return String(firstNumeric);

  return undefined;
}

export function resolvePersistedAgentVersion(
  versionInfo: VersionInfoLike | undefined,
  agentName: string,
): string {
  return resolveVersionString(versionInfo, agentName) ?? '1.0';
}
