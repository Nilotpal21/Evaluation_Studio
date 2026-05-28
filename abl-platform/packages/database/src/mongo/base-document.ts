/**
 * Base Document Interfaces for MongoDB
 *
 * Defines the common fields and interfaces applied to all MongoDB documents
 * in the ABL Platform. Uses UUID v7 for time-sortable, shard-safe identifiers.
 */

import mongoose, { type Schema } from 'mongoose';
import { leanIdPlugin } from './plugins/lean-id.plugin.js';

// Register lean-id plugin globally BEFORE any model() calls.
// This module is imported by every model file (for uuidv7), so ESM
// dependency ordering guarantees it evaluates first.
mongoose.plugin(leanIdPlugin);

// ─── Core Interfaces ──────────────────────────────────────────────────────

/** Applied to ALL documents */
export interface BaseDocument {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
  /** Schema version — incremented on breaking changes for lazy migration */
  _v: number;
}

/** Applied to soft-deletable documents */
export interface SoftDeletableDocument extends BaseDocument {
  deletedAt?: Date | null;
}

/** Applied to tenant-scoped documents */
export interface TenantScopedDocument extends BaseDocument {
  tenantId: string;
}

/** Applied to documents with encrypted fields */
export interface EncryptedDocument extends BaseDocument {
  /** Initialization reference for encryption */
  ire: string;
  /** Initialization vector */
  iv: string;
  /** Content encryption key (encrypted by master key) */
  cek: string;
  /** Which fields are encrypted in this document */
  fieldsToEncrypt: string[];
}

// ─── UUID v7 Generator ────────────────────────────────────────────────────

/**
 * Generate a UUID v7 (time-sortable).
 *
 * Layout: 48-bit unix_ts_ms | 4-bit ver(7) | 12-bit rand_a | 2-bit var(10) | 62-bit rand_b
 */
export function uuidv7(): string {
  const now = Date.now();
  const bytes = new Uint8Array(16);

  // Fill with random bytes
  crypto.getRandomValues(bytes);

  // Timestamp: 48 bits (6 bytes) — big-endian
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Version: 0111 (7)
  bytes[6] = (bytes[6] & 0x0f) | 0x70;

  // Variant: 10xx
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

// ─── Mongoose Schema Fields ──────────────────────────────────────────────

/** Base fields applied to all schemas */
export const baseSchemaFields = {
  _id: { type: String, default: uuidv7 },
  _v: { type: Number, default: 1 },
} as const;

/** Soft-delete field */
export const softDeleteSchemaFields = {
  deletedAt: { type: Date, default: null },
} as const;

/** Tenant isolation field */
export const tenantSchemaFields = {
  tenantId: { type: String, required: true, index: true },
} as const;

/** Encryption fields for documents with encrypted data */
export const encryptionSchemaFields = {
  ire: { type: String },
  iv: { type: String },
  cek: { type: String },
  fieldsToEncrypt: { type: [String], default: [] },
} as const;

// ─── Schema Helpers ──────────────────────────────────────────────────────

/**
 * Apply base fields to a Mongoose schema.
 * Call this after creating the schema to add _id (UUID v7), _v, and timestamps.
 */
export function applyBaseSchema(schema: Schema): void {
  schema.add(baseSchemaFields);
  schema.set('timestamps', true);
}

/**
 * Apply soft-delete fields to a Mongoose schema.
 */
export function applySoftDeleteSchema(schema: Schema): void {
  schema.add(softDeleteSchemaFields);
}

/**
 * Apply tenant isolation fields to a Mongoose schema.
 */
export function applyTenantSchema(schema: Schema): void {
  schema.add(tenantSchemaFields);
}

/**
 * Apply encryption fields to a Mongoose schema.
 */
export function applyEncryptionSchema(schema: Schema): void {
  schema.add(encryptionSchemaFields);
}

// ─── Pagination Types ────────────────────────────────────────────────────

export interface PaginationOptions {
  page?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface CursorOptions {
  cursor?: string;
  limit?: number;
  sort?: Record<string, 1 | -1>;
  direction?: 'forward' | 'backward';
}

export interface CursorResult<T> {
  data: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  hasMore: boolean;
}

export interface QueryOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  lean?: boolean;
  readPreference?: string;
  includeSoftDeleted?: boolean;
}
