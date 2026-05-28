import { z } from 'zod';

const OptionalIdSchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).optional());

export const ProjectAgentTransferConnectionRefSchema = z
  .object({
    connectionId: OptionalIdSchema,
    authProfileId: OptionalIdSchema,
    connectorName: OptionalIdSchema,
  })
  .catchall(z.unknown());

export const ProjectAgentTransferDefaultRoutingSchema = z
  .object({
    connection: ProjectAgentTransferConnectionRefSchema.optional(),
    /** @deprecated Compatibility alias for legacy project settings payloads. */
    connectionId: OptionalIdSchema,
    queue: z.string().optional(),
    priority: z.number().optional(),
    postAgentAction: z.enum(['return', 'end']).optional(),
  })
  .catchall(z.unknown());

export const ProjectAgentTransferSessionSchema = z
  .object({
    ttl: z
      .object({
        chat: z.number().optional(),
        email: z.number().optional(),
        voice: z.number().optional(),
        messaging: z.number().optional(),
        campaign: z.number().optional(),
        default: z.number().optional(),
      })
      .catchall(z.unknown())
      .optional(),
    maxConcurrentPerContact: z.number().optional(),
  })
  .catchall(z.unknown());

export const ProjectAgentTransferVoiceSchema = z
  .object({
    type: z.enum(['korevg', 'audiocodes', 'jambonz']).optional(),
    transferMethod: z.enum(['invite', 'refer', 'bye']).optional(),
    headerPassthrough: z.boolean().optional(),
    recordingEnabled: z.boolean().optional(),
  })
  .catchall(z.unknown());

export const ProjectAgentTransferPiiSchema = z
  .object({
    deTokenizeBeforeTransfer: z.boolean().optional(),
    detectionPattern: z.string().optional(),
  })
  .catchall(z.unknown());

export const ProjectAgentTransferSettingsSchema = z
  .object({
    session: ProjectAgentTransferSessionSchema.optional(),
    defaultRouting: ProjectAgentTransferDefaultRoutingSchema.optional(),
    voice: ProjectAgentTransferVoiceSchema.optional(),
    pii: ProjectAgentTransferPiiSchema.optional(),
  })
  .catchall(z.unknown());

export type ProjectAgentTransferConnectionRef = z.infer<
  typeof ProjectAgentTransferConnectionRefSchema
>;
export type ProjectAgentTransferDefaultRouting = z.infer<
  typeof ProjectAgentTransferDefaultRoutingSchema
>;
export type ProjectAgentTransferSettings = z.infer<typeof ProjectAgentTransferSettingsSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOptionalId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveProjectAgentTransferConnectionRef(
  settings:
    | Pick<ProjectAgentTransferSettings, 'defaultRouting'>
    | Record<string, unknown>
    | null
    | undefined,
): ProjectAgentTransferConnectionRef | undefined {
  const defaultRouting = isRecord(settings?.defaultRouting) ? settings.defaultRouting : undefined;
  if (!defaultRouting) {
    return undefined;
  }

  const connection = isRecord(defaultRouting.connection) ? defaultRouting.connection : undefined;
  const connectionId =
    normalizeOptionalId(connection?.connectionId) ??
    normalizeOptionalId(defaultRouting.connectionId);

  if (!connectionId) {
    return undefined;
  }

  const authProfileId = normalizeOptionalId(connection?.authProfileId);
  const connectorName = normalizeOptionalId(connection?.connectorName);

  return {
    ...(connection ?? {}),
    connectionId,
    ...(authProfileId ? { authProfileId } : {}),
    ...(connectorName ? { connectorName } : {}),
  };
}

export function normalizeProjectAgentTransferSettings(
  settings: ProjectAgentTransferSettings | Record<string, unknown> | null | undefined,
): ProjectAgentTransferSettings | null {
  if (!isRecord(settings)) {
    return null;
  }

  const normalized: Record<string, unknown> = { ...settings };
  const defaultRouting = isRecord(settings.defaultRouting) ? settings.defaultRouting : undefined;

  if (defaultRouting) {
    const { connectionId: _legacyConnectionId, ...restDefaultRouting } = defaultRouting;
    const connection = resolveProjectAgentTransferConnectionRef({ defaultRouting });
    normalized.defaultRouting = connection
      ? { ...restDefaultRouting, connection }
      : restDefaultRouting;
  }

  return normalized as ProjectAgentTransferSettings;
}
