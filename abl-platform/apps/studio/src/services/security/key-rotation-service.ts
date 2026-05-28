/**
 * Key Rotation Service
 *
 * Manages encryption key lifecycle:
 * - Master key versioning (envelope encryption)
 * - Tenant DEK rotation
 * - API key rotation with grace period
 * - Re-encryption of existing data
 */

import crypto from 'crypto';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeyVersion {
  id: string;
  version: number;
  status: 'active' | 'decrypt_only' | 'destroyed';
  algorithm: string;
  createdAt: Date;
  rotatedAt?: Date;
  destroyedAt?: Date;
}

export interface RotationPolicy {
  masterKeyRotationDays: number; // Default: 90
  tenantKeyRotationDays: number; // Default: 180
  apiKeyMaxAgeDays: number; // Default: 365
  apiKeyGracePeriodHours: number; // Default: 24
  oauthRefreshBufferSeconds: number; // Default: 300
}

export interface ReEncryptionJob {
  id: string;
  oldKeyVersion: number;
  newKeyVersion: number;
  totalItems: number;
  processedItems: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
}

// ---------------------------------------------------------------------------
// Key Store Interface
// ---------------------------------------------------------------------------

export interface KeyStore {
  getActiveKeyVersion(): Promise<KeyVersion | null>;
  getKeyVersion(version: number): Promise<KeyVersion | null>;
  listKeyVersions(): Promise<KeyVersion[]>;
  saveKeyVersion(key: KeyVersion): Promise<void>;
  updateKeyVersionStatus(version: number, status: KeyVersion['status']): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-Memory Key Store (development/testing)
// ---------------------------------------------------------------------------

export class InMemoryKeyStore implements KeyStore {
  private versions: KeyVersion[] = [];

  async getActiveKeyVersion(): Promise<KeyVersion | null> {
    return this.versions.find((v) => v.status === 'active') ?? null;
  }

  async getKeyVersion(version: number): Promise<KeyVersion | null> {
    return this.versions.find((v) => v.version === version) ?? null;
  }

  async listKeyVersions(): Promise<KeyVersion[]> {
    return [...this.versions].sort((a, b) => b.version - a.version);
  }

  async saveKeyVersion(key: KeyVersion): Promise<void> {
    this.versions.push({ ...key });
  }

  async updateKeyVersionStatus(version: number, status: KeyVersion['status']): Promise<void> {
    const v = this.versions.find((k) => k.version === version);
    if (v) {
      v.status = status;
      if (status === 'destroyed') v.destroyedAt = new Date();
      if (status === 'decrypt_only') v.rotatedAt = new Date();
    }
  }

  /** Test helper */
  clear(): void {
    this.versions = [];
  }
}

// ---------------------------------------------------------------------------
// Key Rotation Service
// ---------------------------------------------------------------------------

const DEFAULT_POLICY: RotationPolicy = {
  masterKeyRotationDays: 90,
  tenantKeyRotationDays: 180,
  apiKeyMaxAgeDays: 365,
  apiKeyGracePeriodHours: 24,
  oauthRefreshBufferSeconds: 300,
};

export class KeyRotationService {
  private store: KeyStore;
  private policy: RotationPolicy;

  constructor(store: KeyStore, policy?: Partial<RotationPolicy>) {
    this.store = store;
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  /** Initialize with first key version if none exists */
  async initialize(): Promise<KeyVersion> {
    const active = await this.store.getActiveKeyVersion();
    if (active) return active;

    const firstKey: KeyVersion = {
      id: crypto.randomUUID(),
      version: 1,
      status: 'active',
      algorithm: 'AES-256-GCM',
      createdAt: new Date(),
    };

    await this.store.saveKeyVersion(firstKey);
    return firstKey;
  }

  /** Check if master key rotation is due */
  async isRotationDue(): Promise<boolean> {
    const active = await this.store.getActiveKeyVersion();
    if (!active) return true;

    const age = Date.now() - active.createdAt.getTime();
    const maxAge = this.policy.masterKeyRotationDays * 24 * 60 * 60 * 1000;
    return age > maxAge;
  }

  /** Rotate the master key */
  async rotateMasterKey(): Promise<{ oldVersion: number; newVersion: number }> {
    const active = await this.store.getActiveKeyVersion();
    if (!active) {
      const first = await this.initialize();
      return { oldVersion: 0, newVersion: first.version };
    }

    // Mark current key as decrypt-only
    await this.store.updateKeyVersionStatus(active.version, 'decrypt_only');

    // Create new active key
    const newKey: KeyVersion = {
      id: crypto.randomUUID(),
      version: active.version + 1,
      status: 'active',
      algorithm: 'AES-256-GCM',
      createdAt: new Date(),
    };

    await this.store.saveKeyVersion(newKey);

    return { oldVersion: active.version, newVersion: newKey.version };
  }

  /** Destroy an old key version (after re-encryption is complete) */
  async destroyKeyVersion(version: number): Promise<void> {
    const key = await this.store.getKeyVersion(version);
    if (!key) throw new AppError(`Key version ${version} not found`, { ...ErrorCodes.NOT_FOUND });
    if (key.status === 'active')
      throw new AppError('Cannot destroy active key version', { ...ErrorCodes.BAD_REQUEST });

    await this.store.updateKeyVersionStatus(version, 'destroyed');
  }

  /** Check if API key needs rotation */
  isApiKeyExpired(createdAt: Date, expiresAt?: Date): { expired: boolean; warningDays: number } {
    const now = Date.now();

    if (expiresAt && now > expiresAt.getTime()) {
      return { expired: true, warningDays: 0 };
    }

    const age = now - createdAt.getTime();
    const maxAge = this.policy.apiKeyMaxAgeDays * 24 * 60 * 60 * 1000;
    const warningThreshold = 30 * 24 * 60 * 60 * 1000; // 30 days

    if (age > maxAge) {
      return { expired: true, warningDays: 0 };
    }

    const remaining = maxAge - age;
    if (remaining < warningThreshold) {
      return { expired: false, warningDays: Math.ceil(remaining / (24 * 60 * 60 * 1000)) };
    }

    return { expired: false, warningDays: -1 }; // -1 = not in warning period
  }

  /** Get all key versions (for admin dashboard) */
  async listVersions(): Promise<KeyVersion[]> {
    return this.store.listKeyVersions();
  }

  /** Get rotation policy */
  getPolicy(): Readonly<RotationPolicy> {
    return { ...this.policy };
  }
}
