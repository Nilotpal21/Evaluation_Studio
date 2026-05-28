import mongoose from 'mongoose';

export interface UpsertOptions {
  session?: mongoose.ClientSession | null;
  lean?: boolean;
}

/**
 * Shared Mongoose upsert helper for deterministic seed data.
 *
 * When `updateData` is omitted, the record is created from `createData` and
 * re-runs update every non-`_id` field from `createData`.
 *
 * When `updateData` is provided, only those fields are updated on re-run while
 * remaining `createData` fields are treated as insert-only.
 */
export async function upsertOne<T>(
  model: mongoose.Model<T>,
  filter: Record<string, unknown>,
  createData: Record<string, unknown>,
  updateData?: Record<string, unknown>,
  options: UpsertOptions = {},
): Promise<T> {
  const { session, lean = true } = options;

  if (!updateData) {
    const { _id, ...rest } = createData;
    const simpleUpdate: Record<string, unknown> = { $set: rest };
    if (_id !== undefined) {
      simpleUpdate.$setOnInsert = { _id };
    }

    const result = await model.findOneAndUpdate(filter, simpleUpdate, {
      upsert: true,
      new: true,
      lean,
      session: session ?? undefined,
    } as const);

    return result as T;
  }

  const { _id: updateId, ...restUpdate } = updateData;
  const setOnInsert: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(createData)) {
    if (!(key in updateData) || key === '_id') {
      setOnInsert[key] = value;
    }
  }

  const idValue = updateId ?? createData._id;
  if (idValue !== undefined) {
    setOnInsert._id = idValue;
  }

  const update: Record<string, unknown> = { $set: restUpdate };
  if (Object.keys(setOnInsert).length > 0) {
    update.$setOnInsert = setOnInsert;
  }

  const result = await model.findOneAndUpdate(filter, update, {
    upsert: true,
    new: true,
    lean,
    session: session ?? undefined,
  } as const);

  return result as T;
}
