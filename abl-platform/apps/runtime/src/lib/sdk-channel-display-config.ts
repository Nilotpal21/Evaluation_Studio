export interface SDKChannelDisplayConfig {
  showActivityUpdates: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveSdkChannelDisplayConfig(config: unknown): SDKChannelDisplayConfig {
  const channelConfig = isRecord(config) ? config : {};

  return {
    showActivityUpdates: channelConfig.showActivityUpdates === true,
  };
}
