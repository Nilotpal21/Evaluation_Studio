/**
 * MongoMemoryServer model adapter for agent-assist binding repo tests.
 *
 * Connects to MongoMemoryServer using the default mongoose instance,
 * then provides the real AgentAssistBinding model (with plugins)
 * wrapped in a BindingModelLike adapter for DI.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { BindingModelLike } from '../../../repos/agent-assist-binding-repo.js';

const MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';

export interface MongoTestContext {
  mongod: MongoMemoryServer;
  /** The underlying Mongoose model — for index inspection only. */
  model: mongoose.Model<any>;
  adapter: BindingModelLike;
  cleanup(): Promise<void>;
  teardown(): Promise<void>;
}

export async function setupMongoTestContext(): Promise<MongoTestContext> {
  const mongod = await MongoMemoryServer.create({
    binary: { version: MONGO_VERSION },
    instance: { launchTimeout: 30_000 },
  });

  // Connect the default mongoose instance (same one models register on)
  await mongoose.connect(mongod.getUri());

  // Import the model AFTER connecting — the barrel skips auto-connect in test env
  const { AgentAssistBinding } = await import('@agent-platform/database/models');

  // Ensure indexes are synced to the in-memory server
  await AgentAssistBinding.ensureIndexes();

  const adapter = wrapModel(AgentAssistBinding);

  return {
    mongod,
    model: AgentAssistBinding,
    adapter,
    async cleanup() {
      const db = mongoose.connection.db;
      if (!db) return;
      const collections = await db.listCollections().toArray();
      for (const coll of collections) {
        await db.collection(coll.name).deleteMany({});
      }
    },
    async teardown() {
      await mongoose.disconnect();
      await mongod.stop();
    },
  };
}

function wrapModel(M: mongoose.Model<any>): BindingModelLike {
  return {
    findOne(filter: Record<string, unknown>) {
      return { lean: () => M.findOne(filter).lean().exec() };
    },
    find(filter: Record<string, unknown>) {
      return {
        sort(spec: Record<string, unknown>) {
          return {
            skip(n: number) {
              return {
                limit(l: number) {
                  return {
                    lean: () => M.find(filter).sort(spec).skip(n).limit(l).lean().exec(),
                  };
                },
              };
            },
          };
        },
      };
    },
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) {
      return { lean: () => M.findOneAndUpdate(filter, update, options).lean().exec() };
    },
    findOneAndDelete(filter: Record<string, unknown>) {
      return { lean: () => M.findOneAndDelete(filter).lean().exec() };
    },
    countDocuments(filter: Record<string, unknown>) {
      return M.countDocuments(filter).exec();
    },
    async create(data: Record<string, unknown>) {
      const doc = await M.create(data);
      return { toObject: () => doc.toObject() };
    },
    deleteMany(filter: Record<string, unknown>) {
      return M.deleteMany(filter).exec();
    },
  };
}
