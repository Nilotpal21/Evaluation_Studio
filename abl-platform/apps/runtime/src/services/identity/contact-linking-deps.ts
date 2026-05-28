import type { Contact } from '../../contexts/contact/domain/contact.js';
import type { ResolveOrCreateContactAuditOptions } from '../../contexts/contact/use-cases/resolve-or-create-contact.js';
import type { ChannelType } from '../../channels/types.js';

interface ResolveOrCreateContactPort {
  execute(
    tenantId: string,
    identityType: string,
    identityValue: string,
    channelType?: string,
    auditOptions?: ResolveOrCreateContactAuditOptions,
  ): Promise<Contact>;
}

interface LinkSessionPort {
  execute(
    tenantId: string,
    contactId: string,
    sessionId: string,
    channelType: ChannelType,
    channelId: string,
  ): Promise<void>;
}

export interface ContactLinkingDeps {
  readonly resolveOrCreateContact: ResolveOrCreateContactPort;
  readonly linkSessionToContact: LinkSessionPort;
}

let contactLinkingDeps: ContactLinkingDeps | null = null;

export function setContactLinkingDeps(deps: ContactLinkingDeps): void {
  contactLinkingDeps = deps;
}

export function getContactLinkingDeps(): ContactLinkingDeps | null {
  return contactLinkingDeps;
}

export function clearContactLinkingDeps(): void {
  contactLinkingDeps = null;
}
