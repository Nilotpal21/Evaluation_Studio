/**
 * Search AI Error Classes
 */

export class SearchError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'SearchError';
    this.statusCode = statusCode;
  }
}

export class IndexNotFoundError extends SearchError {
  constructor(indexId: string) {
    super(`Search index not found: ${indexId}`, 404);
    this.name = 'IndexNotFoundError';
  }
}

export class SourceNotFoundError extends SearchError {
  constructor(sourceId: string) {
    super(`Search source not found: ${sourceId}`, 404);
    this.name = 'SourceNotFoundError';
  }
}

export class QueryTimeoutError extends SearchError {
  constructor(timeoutMs: number) {
    super(`Search query timed out after ${timeoutMs}ms`, 408);
    this.name = 'QueryTimeoutError';
  }
}

export class VocabularyResolutionError extends SearchError {
  constructor(term: string, reason: string) {
    super(`Failed to resolve vocabulary term "${term}": ${reason}`, 422);
    this.name = 'VocabularyResolutionError';
  }
}

export class SchemaNotFoundError extends SearchError {
  constructor(schemaId: string) {
    super(`Canonical schema not found: ${schemaId}`, 404);
    this.name = 'SchemaNotFoundError';
  }
}

export class MappingConflictError extends SearchError {
  constructor(canonicalField: string, connectorId: string) {
    super(`Mapping conflict for "${canonicalField}" on connector ${connectorId}`, 409);
    this.name = 'MappingConflictError';
  }
}

export class IngestionError extends SearchError {
  public readonly stage: string;
  public readonly documentId?: string;

  constructor(message: string, stage: string, documentId?: string) {
    super(message, 500);
    this.name = 'IngestionError';
    this.stage = stage;
    this.documentId = documentId;
  }
}

export class VectorStoreError extends SearchError {
  constructor(message: string) {
    super(message, 502);
    this.name = 'VectorStoreError';
  }
}

export class EmbeddingError extends SearchError {
  constructor(message: string) {
    super(message, 502);
    this.name = 'EmbeddingError';
  }
}

// =============================================================================
// ATLAS-KG ENHANCED ERROR TYPES (Phase 1: Refactoring)
// =============================================================================

/**
 * Base error for all ATLAS-KG pipeline errors
 * Provides structured context and JSON serialization
 */
export abstract class SearchAIError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      context: this.context,
    };
  }
}

/**
 * Resource not found (404)
 */
export class ResourceNotFoundError extends SearchAIError {
  constructor(resourceType: string, resourceId: string, context?: Record<string, unknown>) {
    super(`${resourceType} with ID '${resourceId}' not found`, 'RESOURCE_NOT_FOUND', 404, {
      resourceType,
      resourceId,
      ...context,
    });
  }
}

/**
 * Validation error (400)
 */
export class ValidationError extends SearchAIError {
  constructor(message: string, validationErrors: Record<string, string[]>) {
    super(message, 'VALIDATION_ERROR', 400, { validationErrors });
  }
}

/**
 * External service error (502)
 */
export class ExternalServiceError extends SearchAIError {
  constructor(serviceName: string, originalError: Error, context?: Record<string, unknown>) {
    super(
      `External service '${serviceName}' failed: ${originalError.message}`,
      'EXTERNAL_SERVICE_ERROR',
      502,
      { serviceName, originalError: originalError.message, ...context },
    );
  }
}

/**
 * Rate limit exceeded (429)
 */
export class RateLimitExceededError extends SearchAIError {
  constructor(service: string, limit: number, retryAfterSeconds?: number) {
    super(`Rate limit exceeded for '${service}': ${limit} requests`, 'RATE_LIMIT_EXCEEDED', 429, {
      service,
      limit,
      retryAfterSeconds,
    });
  }
}

/**
 * Configuration error (500)
 */
export class ConfigurationError extends SearchAIError {
  constructor(configKey: string, reason: string) {
    super(`Configuration error for '${configKey}': ${reason}`, 'CONFIGURATION_ERROR', 500, {
      configKey,
      reason,
    });
  }
}

/**
 * Tenant isolation violation (403)
 */
export class TenantIsolationError extends SearchAIError {
  constructor(attemptedTenantId: string, actualTenantId: string) {
    super(
      `Tenant isolation violation: attempted to access tenant '${attemptedTenantId}' but resource belongs to '${actualTenantId}'`,
      'TENANT_ISOLATION_VIOLATION',
      403,
      { attemptedTenantId, actualTenantId },
    );
  }
}
