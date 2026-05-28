/**
 * Device Auth Request Model
 *
 * Implements the OAuth 2.0 Device Authorization Grant flow.
 * Tracks pending device codes, user codes, and their authorization
 * lifecycle. Expired entries are automatically removed via TTL index.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IDeviceAuthRequest {
  _id: string;
  deviceCode: string;
  userCode: string;
  scopes: string[];
  expiresAt: Date;
  userId: string | null;
  authorizedAt: Date | null;
  consumedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const DeviceAuthRequestSchema = new Schema<IDeviceAuthRequest>(
  {
    _id: { type: String, default: uuidv7 },
    deviceCode: { type: String, required: true },
    userCode: { type: String, required: true },
    scopes: { type: [String], default: [] },
    expiresAt: { type: Date, required: true },
    userId: { type: String, default: null },
    authorizedAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'device_auth_requests' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

DeviceAuthRequestSchema.index({ deviceCode: 1 }, { unique: true });
DeviceAuthRequestSchema.index({ userCode: 1 }, { unique: true });
DeviceAuthRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ───────────────────────────────────────────────────────────────

export const DeviceAuthRequest =
  (mongoose.models.DeviceAuthRequest as any) ||
  model<IDeviceAuthRequest>('DeviceAuthRequest', DeviceAuthRequestSchema);
