import {
  ContactStore,
  ContactStoreConfig,
  CreateContactParams,
  UpdateContactParams,
  QueryContactsParams,
} from '@abl/compiler/platform/stores/contact-store.js';
import type { Contact, IdentityType } from '@abl/compiler/platform/core/types';
import { Contact as ContactModel } from '@agent-platform/database/models';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

function mapDocToContact(doc: any): Contact {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    type: doc.type,
    identity: doc.identity ?? undefined,
    identityType: doc.identityType ?? undefined,
    displayName: doc.displayName ?? undefined,
    department: doc.department ?? undefined,
    employeeId: doc.employeeId ?? undefined,
    company: doc.company ?? undefined,
    accountRef: doc.accountRef ?? undefined,
    channel: doc.channel,
    metadata: doc.metadata ?? {},
    tags: doc.tags ?? [],
    firstSeenAt: doc.firstSeenAt,
    lastSeenAt: doc.lastSeenAt,
    deletedAt: doc.deletedAt ?? undefined,
  };
}

export class MongoContactStore extends ContactStore {
  constructor(config: ContactStoreConfig) {
    super(config);
  }

  async create(params: CreateContactParams): Promise<Contact> {
    const doc = await ContactModel.create({
      tenantId: params.tenantId,
      type: params.type,
      identity: params.identity,
      identityType: params.identityType,
      displayName: params.displayName,
      department: params.department,
      employeeId: params.employeeId,
      company: params.company,
      accountRef: params.accountRef,
      channel: params.channel,
      metadata: params.metadata ?? {},
      tags: params.tags ?? [],
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    return mapDocToContact(doc.toObject());
  }

  async getById(id: string, tenantId?: string): Promise<Contact | null> {
    const filter: Record<string, unknown> = { _id: id };
    if (tenantId) filter.tenantId = tenantId;
    const doc = await ContactModel.findOne(filter).lean();
    if (!doc) return null;
    return mapDocToContact(doc);
  }

  async findByIdentity(
    tenantId: string,
    identityType: IdentityType,
    identity: string,
  ): Promise<Contact | null> {
    const doc = await ContactModel.findOne({
      tenantId,
      identityType,
      identity,
      deletedAt: null,
    }).lean();

    if (!doc) return null;
    return mapDocToContact(doc);
  }

  async update(id: string, params: UpdateContactParams, tenantId?: string): Promise<Contact> {
    const filter: Record<string, unknown> = { _id: id };
    if (tenantId) filter.tenantId = tenantId;
    const doc = await ContactModel.findOneAndUpdate(
      filter,
      { $set: params },
      { new: true, lean: true },
    );

    if (!doc) {
      throw new AppError(`Contact not found: ${id}`, { ...ErrorCodes.NOT_FOUND });
    }

    return mapDocToContact(doc);
  }

  async query(params: QueryContactsParams): Promise<{ contacts: Contact[]; total: number }> {
    const filter: Record<string, any> = {
      tenantId: params.tenantId,
      deletedAt: null,
    };

    if (params.type) {
      filter.type = params.type;
    }

    if (params.channel) {
      filter.channel = params.channel;
    }

    if (params.tags && params.tags.length > 0) {
      filter.tags = { $all: params.tags };
    }

    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const [docs, total] = await Promise.all([
      ContactModel.find(filter).sort({ lastSeenAt: -1 }).skip(offset).limit(limit).lean(),
      ContactModel.countDocuments(filter),
    ]);

    return {
      contacts: docs.map(mapDocToContact),
      total,
    };
  }

  async delete(id: string): Promise<void> {
    await ContactModel.findOneAndDelete({ _id: id });
  }

  async softDelete(id: string, tenantId?: string): Promise<void> {
    const filter: Record<string, unknown> = { _id: id };
    if (tenantId) filter.tenantId = tenantId;
    await ContactModel.findOneAndUpdate(filter, {
      $set: {
        identity: null,
        identityType: null,
        displayName: null,
        employeeId: null,
        company: null,
        accountRef: null,
        type: 'anonymous',
        deletedAt: new Date(),
      },
    });
  }

  async touchLastSeen(id: string): Promise<void> {
    await ContactModel.findOneAndUpdate(
      { _id: id },
      {
        $set: { lastSeenAt: new Date() },
      },
    );
  }
}

export function createMongoContactStore(config?: Partial<ContactStoreConfig>): MongoContactStore {
  return new MongoContactStore({
    type: 'mongodb',
    ...config,
  });
}
