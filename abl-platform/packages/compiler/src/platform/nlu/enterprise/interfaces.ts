/**
 * Enterprise NLU Port Interfaces
 *
 * Dependency inversion ports for enterprise integrations.
 * External systems implement these interfaces; the NLU engine
 * consumes them without depending on concrete implementations.
 */

import type { Environment } from '../../core/types.js';
import type { NLUTask, NLULayer } from '../types.js';

// =============================================================================
// TENANT CONTEXT
// =============================================================================

export interface NLUTenantContext {
  tenantId: string;
  userId?: string;
  environment: Environment;
}

// =============================================================================
// AUDIT PORT
// =============================================================================

export interface NLUAuditEvent {
  timestamp: Date;
  tenantId: string;
  task: NLUTask;
  layer: NLULayer | string;
  model: string;
  input: string;
  prediction: unknown;
  confidence: number;
  latencyMs: number;
  configVersion?: string;
}

export interface NLUAuditPort {
  logPrediction(event: NLUAuditEvent): Promise<void>;
}

// =============================================================================
// ENCRYPTION PORT
// =============================================================================

export interface NLUEncryptionPort {
  encrypt(data: string, tenantId: string): string;
  decrypt(data: string, tenantId: string): string;
}

// =============================================================================
// RATE LIMITER PORT
// =============================================================================

export interface NLURateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export interface NLURateLimiterPort {
  check(tenantId: string, task: NLUTask): NLURateLimitResult;
  record(tenantId: string, task: NLUTask): void;
}

// =============================================================================
// ENTERPRISE PORTS BUNDLE
// =============================================================================

export interface NLUEnterprisePorts {
  audit?: NLUAuditPort;
  encryption?: NLUEncryptionPort;
  rateLimiter?: NLURateLimiterPort;
}
