import type { ContactContext, ContactContextDeps } from './index.js';
import { ContactMongoRepository, createContactContext, eraseUserScopedFacts } from './index.js';
import {
  clearContactLinkingDeps,
  setContactLinkingDeps,
} from '../../services/identity/contact-linking-deps.js';

export type RuntimeContactContextOptions = Omit<ContactContextDeps, 'repository' | 'encryptor'>;

export async function initializeRuntimeContactLinking(
  options: RuntimeContactContextOptions,
): Promise<ContactContext> {
  const { Contact } = await import('@agent-platform/database/models');
  const { getEncryptionService } = await import('@agent-platform/shared/encryption');

  const contactCtx = createContactContext({
    repository: new ContactMongoRepository(Contact),
    encryptor: getEncryptionService(),
    // Default `memory.user.*` erasure cascade. Callers can override via
    // `options.factErasure` (e.g. tests that don't want the cascade).
    factErasure: eraseUserScopedFacts,
    ...options,
  });

  setContactLinkingDeps({
    resolveOrCreateContact: contactCtx.resolveOrCreateContact,
    linkSessionToContact: contactCtx.linkSessionToContact,
  });

  return contactCtx;
}

export function clearRuntimeContactLinking(): void {
  clearContactLinkingDeps();
}
