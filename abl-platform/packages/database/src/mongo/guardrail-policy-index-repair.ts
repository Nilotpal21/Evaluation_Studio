import type mongoose from 'mongoose';

type Db = mongoose.mongo.Db;
type IndexDescription = mongoose.mongo.IndexDescriptionInfo;

export const GUARDRAIL_POLICY_COLLECTION = 'guardrail_policies';
export const LEGACY_GUARDRAIL_POLICY_UNIQUE_INDEX_KEY = {
  tenantId: 1,
  name: 1,
  'scope.type': 1,
} as const;
export const SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_KEY = {
  tenantId: 1,
  name: 1,
  'scope.type': 1,
  'scope.projectId': 1,
  'scope.agentDefId': 1,
} as const;
export const SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_NAME =
  'tenantId_1_name_1_scope.type_1_scope.projectId_1_scope.agentDefId_1';

export interface GuardrailPolicyIndexReconciliationResult {
  scopedIndexName: string;
  droppedLegacyIndexes: string[];
}

function sameIndexKey(left: IndexDescription['key'], right: Record<string, 1>): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

async function guardrailPolicyIndexes(db: Db): Promise<IndexDescription[]> {
  return db.collection(GUARDRAIL_POLICY_COLLECTION).indexes();
}

export async function findLegacyGuardrailPolicyUniqueIndexes(db: Db): Promise<string[]> {
  const indexes = await guardrailPolicyIndexes(db);
  return indexes
    .filter(
      (index) =>
        index.name &&
        index.unique === true &&
        sameIndexKey(index.key, LEGACY_GUARDRAIL_POLICY_UNIQUE_INDEX_KEY),
    )
    .map((index) => index.name as string);
}

export async function hasScopedGuardrailPolicyUniqueIndex(db: Db): Promise<boolean> {
  const indexes = await guardrailPolicyIndexes(db);
  return indexes.some(
    (index) =>
      index.name === SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_NAME &&
      index.unique === true &&
      sameIndexKey(index.key, SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_KEY),
  );
}

export async function reconcileGuardrailPolicyUniqueIndexes(
  db: Db,
): Promise<GuardrailPolicyIndexReconciliationResult> {
  const collection = db.collection(GUARDRAIL_POLICY_COLLECTION);

  await collection.createIndex(SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_KEY, {
    unique: true,
    name: SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_NAME,
  });

  const legacyIndexes = await findLegacyGuardrailPolicyUniqueIndexes(db);
  for (const indexName of legacyIndexes) {
    await collection.dropIndex(indexName);
  }

  return {
    scopedIndexName: SCOPED_GUARDRAIL_POLICY_UNIQUE_INDEX_NAME,
    droppedLegacyIndexes: legacyIndexes,
  };
}
