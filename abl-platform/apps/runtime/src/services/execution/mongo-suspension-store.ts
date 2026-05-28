/**
 * MongoSuspensionStore — MongoDB-backed implementation of SuspensionStore.
 *
 * Persists SuspendedExecution records to MongoDB for durability across pod
 * restarts. Uses atomic findOneAndUpdate for claim operations to prevent
 * duplicate processing in multi-pod deployments.
 */

import type { SuspensionStore } from '@agent-platform/execution';
import type { SuspendedExecution } from '@agent-platform/execution';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('mongo-suspension-store');

export class MongoSuspensionStore implements SuspensionStore {
  private async getModel() {
    const { Suspension } = await import('@agent-platform/database/models');
    return Suspension;
  }

  private toExecution(doc: any): SuspendedExecution {
    return {
      suspensionId: doc._id,
      executionId: doc.executionId,
      sessionId: doc.sessionId,
      tenantId: doc.tenantId,
      projectId: doc.projectId,
      reason: doc.reason,
      continuation: doc.continuation,
      channelBinding: doc.channelBinding,
      callbackId: doc.callbackId,
      callbackSecret: doc.callbackSecret,
      barrierId: doc.barrierId,
      status: doc.status,
      suspendedAt: doc.suspendedAt,
      expiresAt: doc.expiresAt,
      resumedAt: doc.resumedAt,
      completedAt: doc.completedAt,
      resumeAttempts: doc.resumeAttempts,
      error: doc.error,
    };
  }

  async create(suspension: SuspendedExecution): Promise<void> {
    const Model = await this.getModel();
    await Model.create({
      _id: suspension.suspensionId,
      tenantId: suspension.tenantId,
      executionId: suspension.executionId,
      sessionId: suspension.sessionId,
      projectId: suspension.projectId,
      reason: suspension.reason,
      continuation: suspension.continuation,
      channelBinding: suspension.channelBinding,
      callbackId: suspension.callbackId,
      callbackSecret: suspension.callbackSecret,
      barrierId: suspension.barrierId,
      status: suspension.status,
      suspendedAt: suspension.suspendedAt,
      expiresAt: suspension.expiresAt,
      resumeAttempts: suspension.resumeAttempts,
    });
  }

  async load(suspensionId: string): Promise<SuspendedExecution | null> {
    const Model = await this.getModel();
    const doc = await Model.findOne({ _id: suspensionId }).lean();
    return doc ? this.toExecution(doc) : null;
  }

  async loadScoped(tenantId: string, suspensionId: string): Promise<SuspendedExecution | null> {
    const Model = await this.getModel();
    const doc = await Model.findOne({ _id: suspensionId, tenantId }).lean();
    return doc ? this.toExecution(doc) : null;
  }

  async loadByCallbackId(callbackId: string): Promise<SuspendedExecution | null> {
    const Model = await this.getModel();
    const doc = await Model.findOne({ callbackId }).lean();
    return doc ? this.toExecution(doc) : null;
  }

  async claimForResume(suspensionId: string): Promise<boolean> {
    const Model = await this.getModel();
    const result = await Model.findOneAndUpdate(
      { _id: suspensionId, status: 'suspended' },
      {
        $set: { status: 'resuming', resumedAt: new Date() },
        $inc: { resumeAttempts: 1 },
      },
      { new: true },
    ).lean();
    return result !== null;
  }

  async releaseClaim(suspensionId: string): Promise<void> {
    const Model = await this.getModel();
    await Model.updateOne(
      { _id: suspensionId, status: 'resuming' },
      { $set: { status: 'suspended' } },
    );
  }

  async complete(suspensionId: string): Promise<void> {
    const Model = await this.getModel();
    await Model.updateOne(
      { _id: suspensionId },
      { $set: { status: 'completed', completedAt: new Date() } },
    );
  }

  async fail(suspensionId: string, error: { code: string; message: string }): Promise<void> {
    const Model = await this.getModel();
    await Model.updateOne({ _id: suspensionId }, { $set: { status: 'failed', error } });
  }

  async expire(suspensionId: string): Promise<void> {
    const Model = await this.getModel();
    await Model.updateOne({ _id: suspensionId }, { $set: { status: 'expired' } });
  }

  async cancel(suspensionId: string): Promise<void> {
    const Model = await this.getModel();
    await Model.updateOne({ _id: suspensionId }, { $set: { status: 'cancelled' } });
  }

  async findByBarrier(barrierId: string): Promise<SuspendedExecution[]> {
    const Model = await this.getModel();
    const docs = await Model.find({ barrierId }).lean();
    return docs.map((d: any) => this.toExecution(d));
  }

  async findExpired(limit: number): Promise<SuspendedExecution[]> {
    const Model = await this.getModel();
    const docs = await Model.find({
      status: 'suspended',
      expiresAt: { $lt: new Date() },
    })
      .limit(limit)
      .lean();
    return docs.map((d: any) => this.toExecution(d));
  }

  async findBySession(sessionId: string): Promise<SuspendedExecution[]> {
    const Model = await this.getModel();
    const docs = await Model.find({ sessionId }).lean();
    return docs.map((d: any) => this.toExecution(d));
  }

  async list(params: {
    tenantId: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<SuspendedExecution[]> {
    const Model = await this.getModel();
    const query: any = { tenantId: params.tenantId };
    if (params.status) query.status = params.status;
    const docs = await Model.find(query)
      .skip(params.offset ?? 0)
      .limit(params.limit ?? 100)
      .sort({ suspendedAt: -1 })
      .lean();
    return docs.map((d: any) => this.toExecution(d));
  }
}
