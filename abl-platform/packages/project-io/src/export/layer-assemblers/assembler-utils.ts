const DEFAULT_INTERNAL_KEYS = [
  '_id',
  'id',
  '__v',
  '_v',
  'projectId',
  'tenantId',
  'createdBy',
  'updatedBy',
  'modifiedBy',
  'ownerId',
  'ownerTeamId',
  'lastEditedBy',
  'createdAt',
  'updatedAt',
];

export function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

export function stripInternalFields<T extends Record<string, unknown>>(
  obj: T,
  additionalKeys?: string[],
): Partial<T> {
  const result = { ...obj };
  const keys = additionalKeys
    ? [...DEFAULT_INTERNAL_KEYS, ...additionalKeys]
    : DEFAULT_INTERNAL_KEYS;
  for (const key of keys) {
    delete result[key];
  }
  return result;
}
