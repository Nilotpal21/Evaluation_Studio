import type { CreateSDKChannelInput } from '../../hooks/useConnectors';

interface BuildSDKChannelInputOptions {
  name: string;
  projectId: string;
  environment: string | null;
  initialEnvironment?: string | null;
  enabled: boolean;
  rateLimitRpm: string;
  allowedOrigins: string;
  isEditing: boolean;
}

export function buildSDKChannelInput(options: BuildSDKChannelInputOptions): CreateSDKChannelInput {
  const parsedRateLimitRpm = options.rateLimitRpm ? parseInt(options.rateLimitRpm, 10) : undefined;
  const parsedAllowedOrigins = options.allowedOrigins
    ? options.allowedOrigins
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : undefined;
  const shouldIncludeEnvironment =
    !options.isEditing || options.environment !== (options.initialEnvironment ?? null);

  return {
    name: options.name.trim(),
    projectId: options.projectId,
    ...(shouldIncludeEnvironment ? { environment: options.environment } : {}),
    enabled: options.enabled,
    rateLimitRpm: parsedRateLimitRpm ?? (options.isEditing ? null : undefined),
    allowedOrigins: parsedAllowedOrigins ?? (options.isEditing ? null : undefined),
  };
}
