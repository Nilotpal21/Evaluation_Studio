/**
 * User Model
 *
 * Stores user accounts for the ABL Platform.
 * Supports Google, email, and Microsoft auth providers.
 * Password hash is field-level encrypted at rest.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Embedded Subdocument Interfaces ─────────────────────────────────────

interface IRecoveryCode {
  codeHash: string;
  usedAt: Date | null;
  createdAt: Date;
}

interface IMfa {
  encryptedSecret: string;
  verified: boolean;
  enabledAt: Date | null;
  lastUsedAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  recoveryCodes: IRecoveryCode[];
}

interface IPasswordHistoryEntry {
  hash: string;
  changedAt: Date;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IUser {
  _id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  googleId: string | null;
  passwordHash: string | null;
  emailVerified: boolean;
  authProvider: string;
  lastLoginAt: Date | null;
  lastActiveTenantId: string | null;
  mfa: IMfa | null;
  failedLoginAttempts: number;
  loginLockedUntil: Date | null;
  passwordHistory: IPasswordHistoryEntry[];
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const RecoveryCodeSchema = new Schema<IRecoveryCode>(
  {
    codeHash: { type: String, required: true },
    usedAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const MfaSchema = new Schema<IMfa>(
  {
    encryptedSecret: { type: String, required: true },
    verified: { type: Boolean, required: true },
    enabledAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    recoveryCodes: { type: [RecoveryCodeSchema], default: [] },
  },
  { _id: false },
);

const PasswordHistoryEntrySchema = new Schema<IPasswordHistoryEntry>(
  {
    hash: { type: String, required: true },
    changedAt: { type: Date, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const UserSchema = new Schema<IUser>(
  {
    _id: { type: String, default: uuidv7 },
    email: { type: String, required: true },
    name: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    googleId: { type: String, default: null },
    passwordHash: { type: String, default: null },
    emailVerified: { type: Boolean, default: false },
    authProvider: { type: String, required: true },
    lastLoginAt: { type: Date, default: null },
    lastActiveTenantId: { type: String, default: null },
    mfa: { type: MfaSchema, default: null },
    failedLoginAttempts: { type: Number, default: 0 },
    loginLockedUntil: { type: Date, default: null },
    passwordHistory: { type: [PasswordHistoryEntrySchema], default: [] },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'users' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

UserSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['passwordHash'],
  skipTenantScoping: true,
});
UserSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index(
  { googleId: 1 },
  { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } },
);

// ─── Model ───────────────────────────────────────────────────────────────

// Check if model already exists to prevent OverwriteModelError in Next.js hot reloading
export const User =
  (mongoose.models.User as mongoose.Model<IUser>) || model<IUser>('User', UserSchema);
