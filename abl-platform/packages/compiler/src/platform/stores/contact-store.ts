/**
 * Contact Store
 *
 * Manages contact records (employees, customers, anonymous visitors).
 * Contacts are linked to sessions asynchronously — a session may start
 * anonymous and be linked to a contact later via `linkContact`.
 */

import { randomUUID } from 'crypto';
import type { Contact, ContactType, IdentityType } from '../core/types.js';

// =============================================================================
// INTERFACES
// =============================================================================

export interface ContactStoreConfig {
  type: 'postgres' | 'mongodb' | 'memory';
  connectionString?: string;
}

export interface CreateContactParams {
  tenantId: string;
  type?: ContactType;
  identity?: string;
  identityType?: IdentityType;
  displayName?: string;
  department?: string;
  employeeId?: string;
  company?: string;
  accountRef?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface UpdateContactParams {
  type?: ContactType;
  identity?: string;
  identityType?: IdentityType;
  displayName?: string;
  department?: string;
  employeeId?: string;
  company?: string;
  accountRef?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface QueryContactsParams {
  tenantId: string;
  type?: ContactType;
  channel?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

// =============================================================================
// ABSTRACT STORE
// =============================================================================

export abstract class ContactStore {
  protected config: ContactStoreConfig;

  constructor(config: ContactStoreConfig) {
    this.config = config;
  }

  abstract create(params: CreateContactParams): Promise<Contact>;
  abstract getById(id: string, tenantId?: string): Promise<Contact | null>;
  abstract findByIdentity(
    tenantId: string,
    identityType: IdentityType,
    identity: string,
  ): Promise<Contact | null>;
  abstract update(id: string, params: UpdateContactParams, tenantId?: string): Promise<Contact>;
  abstract query(params: QueryContactsParams): Promise<{ contacts: Contact[]; total: number }>;
  abstract delete(id: string): Promise<void>;
  abstract softDelete(id: string, tenantId?: string): Promise<void>;
  abstract touchLastSeen(id: string): Promise<void>;
}

// =============================================================================
// IN-MEMORY IMPLEMENTATION
// =============================================================================

export class InMemoryContactStore extends ContactStore {
  private contacts: Map<string, Contact> = new Map();

  async create(params: CreateContactParams): Promise<Contact> {
    const now = new Date();
    const contact: Contact = {
      id: randomUUID(),
      tenantId: params.tenantId,
      type: params.type || 'anonymous',
      identity: params.identity,
      identityType: params.identityType,
      displayName: params.displayName,
      department: params.department,
      employeeId: params.employeeId,
      company: params.company,
      accountRef: params.accountRef,
      channel: params.channel,
      metadata: params.metadata || {},
      tags: params.tags || [],
      firstSeenAt: now,
      lastSeenAt: now,
    };

    this.contacts.set(contact.id, contact);
    return contact;
  }

  async getById(id: string, _tenantId?: string): Promise<Contact | null> {
    const contact = this.contacts.get(id) || null;
    if (contact && _tenantId && contact.tenantId !== _tenantId) return null;
    return contact;
  }

  async findByIdentity(
    tenantId: string,
    identityType: IdentityType,
    identity: string,
  ): Promise<Contact | null> {
    for (const contact of this.contacts.values()) {
      if (
        contact.tenantId === tenantId &&
        contact.identityType === identityType &&
        contact.identity === identity
      ) {
        return contact;
      }
    }
    return null;
  }

  async update(id: string, params: UpdateContactParams, _tenantId?: string): Promise<Contact> {
    const contact = this.contacts.get(id);
    if (!contact) {
      throw new Error(`Contact ${id} not found`);
    }

    const updated: Contact = {
      ...contact,
      ...params,
      metadata: params.metadata ? { ...contact.metadata, ...params.metadata } : contact.metadata,
      tags: params.tags ?? contact.tags,
    };

    this.contacts.set(id, updated);
    return updated;
  }

  async softDelete(id: string, _tenantId?: string): Promise<void> {
    const contact = this.contacts.get(id);
    if (!contact) {
      throw new Error(`Contact ${id} not found`);
    }
    contact.deletedAt = new Date();
    contact.identity = undefined;
    contact.identityType = undefined;
    contact.displayName = undefined;
    contact.employeeId = undefined;
    contact.company = undefined;
    contact.accountRef = undefined;
    contact.type = 'anonymous';
  }

  async query(params: QueryContactsParams): Promise<{ contacts: Contact[]; total: number }> {
    let contacts = Array.from(this.contacts.values())
      .filter((c) => c.tenantId === params.tenantId)
      .filter((c) => !c.deletedAt);

    if (params.type) {
      contacts = contacts.filter((c) => c.type === params.type);
    }
    if (params.channel) {
      contacts = contacts.filter((c) => c.channel === params.channel);
    }
    if (params.tags && params.tags.length > 0) {
      contacts = contacts.filter((c) => params.tags!.some((tag) => c.tags.includes(tag)));
    }

    contacts.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());

    const total = contacts.length;
    const offset = params.offset || 0;
    const limit = params.limit || 50;

    return {
      contacts: contacts.slice(offset, offset + limit),
      total,
    };
  }

  async delete(id: string): Promise<void> {
    this.contacts.delete(id);
  }

  async touchLastSeen(id: string): Promise<void> {
    const contact = this.contacts.get(id);
    if (contact) {
      contact.lastSeenAt = new Date();
    }
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createContactStore(config: ContactStoreConfig): ContactStore {
  switch (config.type) {
    case 'memory':
      return new InMemoryContactStore(config);
    case 'postgres':
      throw new Error('PostgreSQL contact store not yet implemented');
    case 'mongodb':
      throw new Error('MongoDB contact store not yet implemented');
    default:
      throw new Error(`Unknown contact store type: ${config.type}`);
  }
}
