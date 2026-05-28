/**
 * Archive Repository
 *
 * MongoDB repo for ArchiveManifest records.
 */

import { ensureDb } from '@/lib/ensure-db';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

type PlainRecord = Record<string, unknown>;

/**
 * Create an archive manifest entry
 */
export async function createArchiveManifest(data: PlainRecord): Promise<any> {
  await ensureDb();
  const { ArchiveManifest } = await import('@agent-platform/database/models');
  const doc = await ArchiveManifest.create(convertDataForMongo(data));
  return convertMongoToPlain(doc.toObject());
}

/**
 * Find an archive manifest by ID (tenant-scoped)
 */
export async function findArchiveManifestById(id: string, tenantId: string): Promise<any | null> {
  await ensureDb();
  const { ArchiveManifest } = await import('@agent-platform/database/models');
  const doc = await ArchiveManifest.findOne({ _id: id, tenantId }).lean();
  return doc ? convertMongoToPlain(doc) : null;
}

/**
 * Find archive manifests with cursor pagination
 */
export async function findArchiveManifests(
  where: PlainRecord,
  opts?: {
    orderBy?: PlainRecord;
    take?: number;
    skip?: number;
    cursor?: { id: string };
  },
): Promise<any[]> {
  await ensureDb();
  const { ArchiveManifest } = await import('@agent-platform/database/models');

  const mongoWhere = convertWhereClause(where);

  if (opts?.cursor?.id) {
    mongoWhere._id = { $gt: opts.cursor.id };
  }

  let query = ArchiveManifest.find({ ...mongoWhere, tenantId: where.tenantId });

  if (opts?.orderBy) {
    const sort: Record<string, 1 | -1> = {};
    for (const [key, value] of Object.entries(opts.orderBy)) {
      sort[key === 'id' ? '_id' : key] = value === 'asc' ? 1 : -1;
    }
    query = query.sort(sort);
  }

  if (opts?.skip) {
    query = query.skip(opts.skip);
  }

  if (opts?.take) {
    query = query.limit(opts.take);
  }

  const docs = await query.lean();
  return docs.map(convertMongoToPlain);
}

/**
 * Delete an archive manifest (tenant-scoped)
 */
export async function deleteArchiveManifest(id: string, tenantId: string): Promise<any> {
  await ensureDb();
  const { ArchiveManifest } = await import('@agent-platform/database/models');
  const doc = await ArchiveManifest.findOneAndDelete({ _id: id, tenantId }).lean();
  if (!doc) {
    throw new AppError('ArchiveManifest not found', { ...ErrorCodes.NOT_FOUND });
  }
  return convertMongoToPlain(doc);
}

function convertWhereClause(where: PlainRecord): PlainRecord {
  const query: PlainRecord = {};

  for (const [key, value] of Object.entries(where)) {
    if (key === 'id') {
      query._id = value;
    } else if (key === 'createdAt' && typeof value === 'object' && value !== null) {
      const dateFilter = value as Record<string, unknown>;
      const dateQuery: PlainRecord = {};
      if ('gt' in dateFilter) dateQuery.$gt = dateFilter.gt;
      if ('gte' in dateFilter) dateQuery.$gte = dateFilter.gte;
      if ('lt' in dateFilter) dateQuery.$lt = dateFilter.lt;
      if ('lte' in dateFilter) dateQuery.$lte = dateFilter.lte;
      query.createdAt = dateQuery;
    } else if (typeof value === 'object' && value !== null) {
      const operatorValue = value as Record<string, unknown>;
      if ('gt' in operatorValue) query[key] = { $gt: operatorValue.gt };
      else if ('gte' in operatorValue) query[key] = { $gte: operatorValue.gte };
      else if ('lt' in operatorValue) query[key] = { $lt: operatorValue.lt };
      else if ('lte' in operatorValue) query[key] = { $lte: operatorValue.lte };
      else if ('in' in operatorValue) query[key] = { $in: operatorValue.in };
      else if ('not' in operatorValue) query[key] = { $ne: operatorValue.not };
      else query[key] = value;
    } else {
      query[key] = value;
    }
  }

  return query;
}

function convertDataForMongo(data: PlainRecord): PlainRecord {
  const converted: PlainRecord = {};

  for (const [key, value] of Object.entries(data)) {
    if (key === 'id') {
      converted._id = value;
    } else {
      converted[key] = value;
    }
  }

  return converted;
}

function convertMongoToPlain(doc: object): PlainRecord {
  const plain: PlainRecord = {};

  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (key === '_id') {
      plain.id = value;
    } else if (key === '__v' || key === '_v') {
      continue;
    } else {
      plain[key] = value;
    }
  }

  return plain;
}
