import { createLogger } from '@abl/compiler/platform';
import type { ChannelType } from '../../channels/types.js';
import type {
  ChannelArtifactType,
  IdentityTier,
  TenantContextData,
  VerificationMethod,
} from '@agent-platform/shared-auth';
import { runWithTenantContext } from '@agent-platform/shared-auth/middleware';
import { getContactLinkingDeps } from './contact-linking-deps.js';

const log = createLogger('channel-contact-linking');

type ContactIdentityType = 'email' | 'phone' | 'external';

function mapChannelArtifactToContactIdentity(
  artifactType: ChannelArtifactType | undefined,
  rawArtifact: string | undefined,
): ContactIdentityType | null {
  switch (artifactType) {
    case 'email_thread':
      return 'email';
    case 'phone':
      return 'phone';
    case 'caller_id':
      return rawArtifact && /^\+?\d[\d\s\-().]{6,}$/.test(rawArtifact) ? 'phone' : 'external';
    case 'aad_id':
    case 'psid':
    case 'sip_uri':
      return 'external';
    default:
      return null;
  }
}

function shouldResolveContact(params: {
  verificationMethod?: VerificationMethod;
  identityTier?: IdentityTier;
}): boolean {
  return params.verificationMethod === 'provider' || (params.identityTier ?? 0) >= 2;
}

function buildWorkerTenantContext(tenantId: string): TenantContextData {
  return {
    tenantId,
    userId: 'system',
    role: 'system',
    permissions: [],
    authType: 'api_key',
    isSuperAdmin: false,
  };
}

export async function resolveContactIdFromChannelIdentity(params: {
  tenantId: string;
  channelType: ChannelType;
  rawArtifact?: string;
  artifactType?: ChannelArtifactType;
  verificationMethod?: VerificationMethod;
  identityTier?: IdentityTier;
}): Promise<string | undefined> {
  if (!shouldResolveContact(params)) {
    return undefined;
  }

  const identityType = mapChannelArtifactToContactIdentity(params.artifactType, params.rawArtifact);
  if (!identityType || !params.rawArtifact) {
    return undefined;
  }

  try {
    const deps = getContactLinkingDeps();
    if (!deps) {
      log.warn('Contact linking dependencies are not initialized', {
        tenantId: params.tenantId,
        channelType: params.channelType,
        artifactType: params.artifactType,
      });
      return undefined;
    }

    const contact = await deps.resolveOrCreateContact.execute(
      params.tenantId,
      identityType,
      params.rawArtifact,
      params.channelType,
      { contactAuditSource: 'channel_artifact' },
    );
    return contact.id;
  } catch (err) {
    log.warn('Failed to resolve or create contact from channel identity', {
      tenantId: params.tenantId,
      channelType: params.channelType,
      artifactType: params.artifactType,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export async function linkResolvedContactToSession(params: {
  tenantId: string;
  channelType: ChannelType;
  channelId: string;
  sessionId: string;
  contactId: string;
}): Promise<void> {
  try {
    const { getStores } = await import('../stores/store-factory.js');

    const deps = getContactLinkingDeps();
    if (!deps) {
      log.warn('Contact linking dependencies are not initialized', {
        tenantId: params.tenantId,
        channelType: params.channelType,
        channelId: params.channelId,
        sessionId: params.sessionId,
        contactId: params.contactId,
      });
      return;
    }

    await runWithTenantContext(buildWorkerTenantContext(params.tenantId), async () => {
      await deps.linkSessionToContact.execute(
        params.tenantId,
        params.contactId,
        params.sessionId,
        params.channelType,
        params.channelId,
      );
      await getStores().conversation.linkContact(params.sessionId, params.contactId);
    });
  } catch (err) {
    log.warn('Failed to link resolved contact to session', {
      tenantId: params.tenantId,
      channelType: params.channelType,
      channelId: params.channelId,
      sessionId: params.sessionId,
      contactId: params.contactId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
