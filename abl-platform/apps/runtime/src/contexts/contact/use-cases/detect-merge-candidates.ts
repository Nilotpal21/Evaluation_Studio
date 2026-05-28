/**
 * Detect Merge Candidates Use Case
 *
 * Given a contact, extracts its blind indexes and searches for other contacts
 * in the same tenant that share any of those indexes. Filters out the source
 * contact to avoid self-matching.
 *
 * Port: ContactRepository
 */

import type { Contact } from '../domain/contact.js';
import type { ContactRepository } from '../domain/contact-repository.js';

export class DetectMergeCandidates {
  constructor(private readonly repo: ContactRepository) {}

  async execute(tenantId: string, contactId: string): Promise<Contact[]> {
    const contact = await this.repo.findById(tenantId, contactId);
    if (!contact) {
      return [];
    }

    const blindIndexes = contact.identities.map((i) => i.blindIndex);
    if (blindIndexes.length === 0) {
      return [];
    }

    const candidates = await this.repo.findMergeCandidates(tenantId, blindIndexes);

    // Filter out the source contact itself
    return candidates.filter((c) => c.id !== contactId);
  }
}
