import {
  buildTransferContextSnapshot,
  buildTransferRoutingContext,
  normalizeTransferChannel,
  type TransferContact,
  type TransferContextSnapshot,
  type TransferIdentityHints,
  type TransferRoutingContext,
  type VoiceCallData,
} from '@agent-platform/agent-transfer';
import { createLogger } from '@abl/compiler/platform';
import type { CallerContext } from '@agent-platform/shared-auth';
import { getCurrentInteractionContext } from '../execution/interaction-context.js';
import type { RuntimeSession } from '../execution/types.js';

const log = createLogger('transfer-routing-context');

function trimOptionalString(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecordString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? trimOptionalString(value) : undefined;
}

function readNestedString(
  record: Record<string, unknown> | undefined,
  parentKey: string,
  childKey: string,
): string | undefined {
  const parent = record?.[parentKey];
  if (!isPlainObject(parent)) {
    return undefined;
  }
  return readRecordString(parent, childKey);
}

function readSessionValues(
  session: Pick<RuntimeSession, 'data'>,
): Record<string, unknown> | undefined {
  return session.data?.values;
}

function buildTransferInteractionContext(
  interactionContext: Record<string, unknown> | undefined,
): TransferContextSnapshot['interactionContext'] | undefined {
  if (!interactionContext) {
    return undefined;
  }

  const language = readRecordString(interactionContext, 'language');
  const locale = readRecordString(interactionContext, 'locale');
  const timezone = readRecordString(interactionContext, 'timezone');

  const sanitizedInteractionContext: NonNullable<TransferContextSnapshot['interactionContext']> = {
    ...(language ? { language } : {}),
    ...(locale ? { locale } : {}),
    ...(timezone ? { timezone } : {}),
  };

  return Object.keys(sanitizedInteractionContext).length > 0
    ? sanitizedInteractionContext
    : undefined;
}

function buildIdentityHints(
  callerContext: CallerContext | undefined,
): TransferIdentityHints | undefined {
  if (!callerContext) {
    return undefined;
  }

  const identityHints: TransferIdentityHints = {};
  const customerId = trimOptionalString(callerContext.customerId);
  const anonymousId =
    trimOptionalString(callerContext.anonymousId) ??
    trimOptionalString(callerContext.sessionPrincipalId);
  const verificationMethod = trimOptionalString(callerContext.verificationMethod);
  const channelArtifactType = trimOptionalString(callerContext.channelArtifactType);

  if (customerId) {
    identityHints.customerId = customerId;
  }
  if (anonymousId) {
    identityHints.anonymousId = anonymousId;
  }
  if (typeof callerContext.identityTier === 'number') {
    identityHints.identityTier = callerContext.identityTier;
  }
  if (verificationMethod) {
    identityHints.verificationMethod = verificationMethod;
  }
  if (channelArtifactType) {
    identityHints.channelArtifactType = channelArtifactType;
  }

  return Object.keys(identityHints).length > 0 ? identityHints : undefined;
}

export function resolveRuntimeTransferContactId(
  session: Pick<RuntimeSession, 'id' | 'callerContext' | 'data'>,
  resolvedContactId?: string,
): string {
  const sessionValues = readSessionValues(session);

  return (
    trimOptionalString(resolvedContactId) ??
    trimOptionalString(session.callerContext?.contactId) ??
    readRecordString(sessionValues, 'contact_id') ??
    readNestedString(sessionValues, 'session', 'contactId') ??
    trimOptionalString(session.callerContext?.customerId) ??
    readRecordString(sessionValues, 'customer_id') ??
    session.id
  );
}

export function buildRuntimeTransferContact(
  session: Pick<RuntimeSession, 'callerContext' | 'data'>,
): TransferContact | undefined {
  const sessionValues = readSessionValues(session);
  const contactContext = isPlainObject(session.callerContext?.contactContext)
    ? session.callerContext.contactContext
    : undefined;

  const firstName =
    readRecordString(contactContext, 'firstName') ??
    readRecordString(contactContext, 'first_name') ??
    readRecordString(sessionValues, 'first_name');
  const lastName =
    readRecordString(contactContext, 'lastName') ??
    readRecordString(contactContext, 'last_name') ??
    readRecordString(sessionValues, 'last_name');
  const displayName =
    trimOptionalString(session.callerContext?.contactDisplayName) ??
    readRecordString(contactContext, 'name') ??
    readRecordString(contactContext, 'displayName') ??
    readRecordString(sessionValues, 'name');
  const email =
    readRecordString(contactContext, 'email') ?? readRecordString(sessionValues, 'email');
  const phone =
    readRecordString(contactContext, 'phone') ??
    readRecordString(contactContext, 'phoneNumber') ??
    readRecordString(sessionValues, 'phone');
  const customerId =
    trimOptionalString(session.callerContext?.customerId) ??
    readRecordString(sessionValues, 'customer_id');

  const contact: TransferContact = {
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(customerId ? { customerId } : {}),
  };

  return Object.keys(contact).length > 0 ? contact : undefined;
}

function resolveConversationSessionId(
  session: Pick<RuntimeSession, 'data'>,
  conversationSessionId?: string,
): string | undefined {
  const sessionValues = readSessionValues(session);

  return (
    trimOptionalString(conversationSessionId) ??
    readNestedString(sessionValues, 'session', 'conversationSessionId') ??
    readRecordString(sessionValues, 'conversation_session_id') ??
    readNestedString(sessionValues, '_metadata', 'conversationSessionId')
  );
}

function resolveChannelConnectionId(
  session: Pick<RuntimeSession, 'callerContext' | 'data'>,
  channelConnectionId?: string,
): string | undefined {
  const sessionValues = readSessionValues(session);

  return (
    trimOptionalString(channelConnectionId) ??
    trimOptionalString(session.callerContext?.channelId) ??
    readNestedString(sessionValues, 'session', 'channelConnectionId') ??
    readNestedString(sessionValues, '_metadata', 'channelConnectionId')
  );
}

function resolveExternalSessionKey(
  session: Pick<RuntimeSession, 'data'>,
  externalSessionKey?: string,
): string | undefined {
  const sessionValues = readSessionValues(session);

  return (
    trimOptionalString(externalSessionKey) ??
    readNestedString(sessionValues, 'session', 'externalSessionKey') ??
    readNestedString(sessionValues, '_metadata', 'externalSessionKey')
  );
}

function normalizeInteractionSnapshot(
  interactionContext:
    | {
        language?: string | null;
        locale?: string | null;
        timezone?: string | null;
      }
    | undefined,
): TransferContextSnapshot['interactionContext'] | undefined {
  if (!interactionContext) {
    return undefined;
  }

  const normalized = {
    ...(trimOptionalString(interactionContext.language)
      ? { language: trimOptionalString(interactionContext.language) }
      : {}),
    ...(trimOptionalString(interactionContext.locale)
      ? { locale: trimOptionalString(interactionContext.locale) }
      : {}),
    ...(trimOptionalString(interactionContext.timezone)
      ? { timezone: trimOptionalString(interactionContext.timezone) }
      : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export interface RuntimeTransferRoutingContextInput {
  session: Pick<RuntimeSession, 'id' | 'channelType' | 'callerContext'>;
  conversationSessionId?: string;
  resolvedContactId?: string;
  channelConnectionId?: string;
  externalSessionKey?: string;
  voice?: TransferRoutingContext['voice'];
}

export function buildRuntimeTransferRoutingContext(
  input: RuntimeTransferRoutingContextInput,
): TransferRoutingContext {
  return buildTransferRoutingContext({
    runtimeSessionId: input.session.id,
    conversationSessionId: input.conversationSessionId,
    resolvedContactId:
      input.resolvedContactId ??
      trimOptionalString(input.session.callerContext?.contactId) ??
      trimOptionalString(input.session.callerContext?.customerId),
    channel: input.session.channelType ?? input.session.callerContext?.channel,
    sourceChannelType: input.session.callerContext?.channel ?? input.session.channelType,
    channelConnectionId: input.channelConnectionId,
    externalSessionKey: input.externalSessionKey,
    voice: input.voice,
  });
}

export interface RuntimeTransferContextSnapshotInput {
  callerContext?: CallerContext;
  contact?: TransferContact;
  interactionContext?: TransferContextSnapshot['interactionContext'] | Record<string, unknown>;
  sessionContext?: Record<string, unknown>;
  messageMetadata?: Record<string, unknown>;
  existing?: TransferContextSnapshot;
}

export function buildRuntimeTransferContextSnapshot(
  input: RuntimeTransferContextSnapshotInput,
): TransferContextSnapshot | undefined {
  const existing = input.existing;
  const identityHints = {
    ...(existing?.identityHints ?? {}),
    ...(buildIdentityHints(input.callerContext) ?? {}),
  };
  const contact = {
    ...(existing?.contact ?? {}),
    ...(input.contact ?? {}),
  };
  const interactionContext = {
    ...(existing?.interactionContext ?? {}),
    ...(buildTransferInteractionContext(input.interactionContext) ?? {}),
  };

  return buildTransferContextSnapshot({
    identityHints: Object.keys(identityHints).length > 0 ? identityHints : undefined,
    contact: Object.keys(contact).length > 0 ? contact : undefined,
    interactionContext: Object.keys(interactionContext).length > 0 ? interactionContext : undefined,
    sessionContext: input.sessionContext ?? existing?.sessionContext,
    messageMetadata: input.messageMetadata ?? existing?.messageMetadata,
  });
}

export interface RuntimeTransferEnvelopeInput {
  session: Pick<RuntimeSession, 'id' | 'channelType' | 'callerContext' | 'data'>;
  resolvedContactId?: string;
  conversationSessionId?: string;
  channelConnectionId?: string;
  externalSessionKey?: string;
  voiceData?: VoiceCallData;
}

export interface RuntimeTransferEnvelope {
  contactId: string;
  contact?: TransferContact;
  routing: TransferRoutingContext;
  contextSnapshot?: TransferContextSnapshot;
  language?: string;
  voiceData?: VoiceCallData;
  conversationSessionId?: string;
  channelConnectionId?: string;
  externalSessionKey?: string;
}

export async function resolveRuntimeTransferVoiceData(
  session: Pick<RuntimeSession, 'id' | 'channelType' | 'callerContext'>,
): Promise<VoiceCallData | undefined> {
  const sourceChannel = session.callerContext?.channel ?? session.channelType;
  if (normalizeTransferChannel(sourceChannel) !== 'voice') {
    return undefined;
  }

  try {
    const { getVoiceSession } = await import('../voice/korevg/korevg-session.js');
    const voiceSession = getVoiceSession(session.id);
    if (voiceSession) {
      return voiceSession.getVoiceTransferData();
    }

    // Fallback: realtime (S2S) sessions don't create KorevgSession instances; they
    // register a RealtimeVoiceGatewaySession instead.
    const { getRealtimeVoiceCallData } = await import('../voice/korevg/realtime-voice-session.js');
    const realtimeData = getRealtimeVoiceCallData(session.id);
    if (realtimeData) {
      log.info('Resolved voice transfer data from realtime session', {
        sessionId: session.id,
        callSid: realtimeData.callSid,
        hasSipCallId: !!realtimeData.sipCallId,
      });
      return realtimeData;
    }

    log.warn('No active voice session found while building transfer envelope', {
      sessionId: session.id,
      sourceChannel,
    });
    return undefined;
  } catch (error) {
    log.warn('Failed to resolve voice transfer data while building transfer envelope', {
      sessionId: session.id,
      sourceChannel,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function buildRuntimeTransferEnvelope(
  input: RuntimeTransferEnvelopeInput,
): Promise<RuntimeTransferEnvelope> {
  const contactId = resolveRuntimeTransferContactId(input.session, input.resolvedContactId);
  const contact = buildRuntimeTransferContact(input.session);
  const interactionContext = normalizeInteractionSnapshot(
    getCurrentInteractionContext(input.session.data),
  );
  const conversationSessionId = resolveConversationSessionId(
    input.session,
    input.conversationSessionId,
  );
  const channelConnectionId = resolveChannelConnectionId(input.session, input.channelConnectionId);
  const externalSessionKey = resolveExternalSessionKey(input.session, input.externalSessionKey);
  const voiceData = input.voiceData ?? (await resolveRuntimeTransferVoiceData(input.session));
  const sourceChannelType = input.session.callerContext?.channel ?? input.session.channelType;

  const routing = buildRuntimeTransferRoutingContext({
    session: input.session,
    conversationSessionId,
    resolvedContactId: contactId,
    channelConnectionId,
    externalSessionKey,
    voice: voiceData
      ? {
          callSid: voiceData.callSid,
          sipCallId: voiceData.sipCallId,
          gateway: sourceChannelType,
        }
      : undefined,
  });
  const contextSnapshot = buildRuntimeTransferContextSnapshot({
    callerContext: input.session.callerContext,
    contact,
    interactionContext,
  });

  return {
    contactId,
    contact,
    routing,
    contextSnapshot,
    language: interactionContext?.language,
    ...(voiceData ? { voiceData } : {}),
    ...(conversationSessionId ? { conversationSessionId } : {}),
    ...(channelConnectionId ? { channelConnectionId } : {}),
    ...(externalSessionKey ? { externalSessionKey } : {}),
  };
}

export function setRuntimeTransferActiveState(
  session: Pick<RuntimeSession, 'isEscalated' | 'transferInitiated'>,
  active: boolean,
): void {
  session.isEscalated = active;
  session.transferInitiated = active;
}
