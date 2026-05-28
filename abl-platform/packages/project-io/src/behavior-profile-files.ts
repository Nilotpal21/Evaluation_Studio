const BEHAVIOR_PROFILE_CONFIG_KEY_PREFIX = 'profile:';

export function behaviorProfileNameToConfigKey(profileName: string): string {
  return `${BEHAVIOR_PROFILE_CONFIG_KEY_PREFIX}${profileName}`;
}

export function isBehaviorProfileConfigKey(key: string): boolean {
  return key.startsWith(BEHAVIOR_PROFILE_CONFIG_KEY_PREFIX);
}

export function behaviorProfileConfigKeyToName(key: string): string | null {
  if (!isBehaviorProfileConfigKey(key)) {
    return null;
  }

  const name = key.slice(BEHAVIOR_PROFILE_CONFIG_KEY_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

export function extractBehaviorProfileNameFromDsl(content: string): string | null {
  const match = content.match(/^\s*BEHAVIOR_PROFILE:\s*(\S+)/im);
  return match ? match[1].trim() : null;
}
