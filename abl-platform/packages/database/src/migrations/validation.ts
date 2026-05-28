import mongoose from 'mongoose';
import type { MigrationValidationResult } from './types.js';

type Db = mongoose.mongo.Db;

type IndexDefinition = {
  key?: Record<string, unknown>;
  name?: string;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: unknown;
};

function normalizeRecord(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function keysMatch(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
): boolean {
  return normalizeRecord(actual) === normalizeRecord(expected);
}

function subsetMatches(index: IndexDefinition, subset?: Partial<IndexDefinition>): boolean {
  if (!subset) return true;

  for (const [key, expectedValue] of Object.entries(subset)) {
    const actualValue = index[key as keyof IndexDefinition];
    if (normalizeRecord(actualValue) !== normalizeRecord(expectedValue)) {
      return false;
    }
  }

  return true;
}

export function validationPassed(
  summary: string,
  details?: Record<string, unknown>,
): MigrationValidationResult {
  return { ok: true, summary, details };
}

export function validationFailed(
  summary: string,
  details?: Record<string, unknown>,
): MigrationValidationResult {
  return { ok: false, summary, details };
}

export async function collectionExists(db: Db, name: string): Promise<boolean> {
  const matches = await db.listCollections({ name }).toArray();
  return matches.length > 0;
}

export async function findIndex(
  db: Db,
  collectionName: string,
  expectedKey: Record<string, unknown>,
  subset?: Partial<IndexDefinition>,
): Promise<IndexDefinition | null> {
  if (!(await collectionExists(db, collectionName))) {
    return null;
  }

  const indexes = (await db.collection(collectionName).indexes()) as IndexDefinition[];
  return (
    indexes.find((index) => keysMatch(index.key, expectedKey) && subsetMatches(index, subset)) ??
    null
  );
}

export async function hasIndex(
  db: Db,
  collectionName: string,
  expectedKey: Record<string, unknown>,
  subset?: Partial<IndexDefinition>,
): Promise<boolean> {
  return (await findIndex(db, collectionName, expectedKey, subset)) !== null;
}
