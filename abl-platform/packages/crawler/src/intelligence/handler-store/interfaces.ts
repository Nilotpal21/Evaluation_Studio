/**
 * Handler Store Interfaces
 *
 * Abstractions for storing and retrieving page handlers keyed by template fingerprint.
 *
 * Design Principles:
 * - Interface Segregation: IHandlerStore focused on handler storage
 * - Dependency Inversion: Depend on abstraction, not implementation
 * - Single Responsibility: Handler storage separated from intelligence loop
 */

import type { IPageHandler } from '../types.js';

/**
 * Input for saving a handler to the store.
 */
export interface SaveHandlerInput {
  tenantId: string;
  domain: string;
  urlPattern: string;
  /** Hex string fingerprint (from TemplateFingerprinter.toSerializable) */
  fingerprint: string;
  handler: IPageHandler;
  trainedOn: string[];
}

/**
 * A handler record as returned from the store.
 */
export interface StoredHandler {
  tenantId: string;
  domain: string;
  urlPattern: string;
  fingerprint: string;
  handler: IPageHandler;
  trainedOn: string[];
  successCount: number;
  failureCount: number;
  confidence: number;
  lastUsedAt: Date;
  createdAt: Date;
}

/**
 * IHandlerStore - Interface for handler storage
 */
export interface IHandlerStore {
  /** Save or update a handler. Upserts by { tenantId, domain, fingerprint }. */
  saveHandler(input: SaveHandlerInput): Promise<void>;

  /** Find a handler by its fingerprint. Returns null if not found. */
  findByFingerprint(
    tenantId: string,
    domain: string,
    fingerprint: string,
  ): Promise<StoredHandler | null>;

  /** Find all handlers for a domain, sorted by confidence desc. */
  findByDomain(tenantId: string, domain: string): Promise<StoredHandler[]>;

  /** Record a successful extraction, incrementing successCount and recalculating confidence. */
  recordSuccess(tenantId: string, domain: string, fingerprint: string): Promise<void>;

  /** Record a failed extraction, incrementing failureCount and recalculating confidence. */
  recordFailure(tenantId: string, domain: string, fingerprint: string): Promise<void>;

  /** Delete all handlers for a domain. Returns number deleted. */
  deleteByDomain(tenantId: string, domain: string): Promise<number>;
}

/**
 * Handler Store Error
 */
export class HandlerStoreError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'HandlerStoreError';
  }
}
