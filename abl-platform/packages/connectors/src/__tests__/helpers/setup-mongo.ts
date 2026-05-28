/**
 * Integration Test Setup: MongoMemoryServer
 *
 * Provides a shared setup for integration and E2E tests in the connectors
 * package. Centralizes MongoMemoryServer lifecycle, Mongoose schema/model
 * creation, and a model adapter that satisfies the ConnectionModel DI interface.
 *
 * Connections are pure binding records — credential storage and encryption
 * are handled by auth profiles, not by the connection model.
 *
 * Usage:
 *   let ctx: IntegrationTestContext;
 *   beforeAll(async () => { ctx = await setupIntegrationContext(); });
 *   afterEach(async () => { await ctx.cleanup(); });
 *   afterAll(async () => { await ctx.teardown(); });
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ConnectionModel } from '../../services/connection-service.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MONGO_LAUNCH_TIMEOUT_MS = 30_000;

// ─── Mongoose Schema ────────────────────────────────────────────────────────

const connectionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    connectorName: { type: String, required: true },
    displayName: { type: String, required: true },
    scope: { type: String, enum: ['tenant', 'user'], default: 'tenant' },
    userId: { type: String },
    authProfileId: { type: String, required: true },
    status: { type: String, enum: ['active', 'expired', 'revoked'], default: 'active' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'connector_connections', _id: false },
);

connectionSchema.index({ tenantId: 1, projectId: 1 });
connectionSchema.index(
  { tenantId: 1, projectId: 1, connectorName: 1, authProfileId: 1 },
  { unique: true },
);

// ─── Model Adapter ──────────────────────────────────────────────────────────

/**
 * Adapts a Mongoose model to the ConnectionModel DI interface.
 *
 * The ConnectionModel interface expects:
 * - find() returning a chainable { sort() { lean() } }
 * - findOne(), create(), findOneAndUpdate(), findOneAndDelete()
 */
function createModelAdapter(model: mongoose.Model<mongoose.Document>): ConnectionModel {
  return {
    find(filter: Record<string, unknown>) {
      return {
        sort(sortSpec: Record<string, unknown>) {
          return {
            async lean() {
              return model.find(filter).sort(sortSpec).lean().exec();
            },
          };
        },
      };
    },
    findOne(filter: Record<string, unknown>) {
      return {
        async lean() {
          return model.findOne(filter).lean().exec();
        },
      };
    },
    async create(data: Record<string, unknown>) {
      const doc = await model.create(data);
      return doc.toObject();
    },
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) {
      const result = await model
        .findOneAndUpdate(filter, update, { ...options, new: true })
        .lean()
        .exec();
      return result;
    },
    async findOneAndDelete(filter: Record<string, unknown>) {
      return model.findOneAndDelete(filter).lean().exec();
    },
  };
}

// ─── Public Interface ───────────────────────────────────────────────────────

export interface IntegrationTestContext {
  mongoUri: string;
  connection: mongoose.Connection;
  connectionModel: ConnectionModel;
  /** Drop all collections (use in afterEach) */
  cleanup(): Promise<void>;
  /** Disconnect + stop MongoMemoryServer (use in afterAll) */
  teardown(): Promise<void>;
}

/**
 * Creates a fully wired integration test context:
 * - MongoMemoryServer instance
 * - Mongoose connection with ConnectionRecord schema
 * - ConnectionModel adapter matching ConnectionServiceDeps
 */
export async function setupIntegrationContext(): Promise<IntegrationTestContext> {
  const mongod = await MongoMemoryServer.create({
    binary: { version: MONGO_VERSION },
    instance: { launchTimeout: MONGO_LAUNCH_TIMEOUT_MS },
  });

  const mongoUri = mongod.getUri();
  const connection = mongoose.createConnection(mongoUri);

  // Wait for the connection to be ready
  await connection.asPromise();

  // Register the schema on this connection
  const MongooseModel = connection.model('ConnectorConnection', connectionSchema);

  const connectionModel = createModelAdapter(
    MongooseModel as unknown as mongoose.Model<mongoose.Document>,
  );

  return {
    mongoUri,
    connection,
    connectionModel,

    async cleanup() {
      const db = connection.db;
      if (!db) return;
      const collections = await db.listCollections().toArray();
      for (const coll of collections) {
        await db.collection(coll.name).deleteMany({});
      }
    },

    async teardown() {
      await connection.close();
      await mongod.stop();
    },
  };
}
