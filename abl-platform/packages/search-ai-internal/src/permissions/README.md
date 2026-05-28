# Permission Graph Module

Neo4j-based permission graph for SearchAI enterprise authorization.

## Overview

This module provides a complete permission management system using Neo4j graph database:

- **PermissionGraphClient**: Low-level Neo4j client with direct query access
- **PermissionGraphService**: High-level service with retry logic, circuit breaker, and monitoring

## Quick Start

### Basic Usage with Service (Recommended)

```typescript
import { PermissionGraphService } from '@agent-platform/search-ai-internal/permissions';

// Initialize singleton
const service = PermissionGraphService.getInstance({
  uri: process.env.NEO4J_URI || 'neo4j://localhost:7687',
  username: process.env.NEO4J_USERNAME || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'password',
  database: 'neo4j',

  // Optional: Retry configuration
  maxRetries: 3,
  retryDelayMs: 1000,
  retryBackoffMultiplier: 2,

  // Optional: Circuit breaker
  circuitBreakerThreshold: 5,
  circuitBreakerTimeout: 60000,
});

// Initialize schema (idempotent)
await service.initializeSchema();

// Create a user
const user = await service.upsertUser({
  tenantId: 'tenant-123',
  email: 'alice@contoso.com',
  idpUserId: 'azure-ad-user-id',
  idpProvider: 'azuread',
  displayName: 'Alice Johnson',
});

// Create a group
const group = await service.upsertGroup({
  tenantId: 'tenant-123',
  groupId: 'azuread:engineering',
  source: 'azuread',
  displayName: 'Engineering Team',
});

// Set membership
await service.setMembership({
  tenantId: 'tenant-123',
  memberEmail: 'alice@contoso.com',
  parentGroupId: 'azuread:engineering',
  source: 'azuread',
});

// Get all groups for user (recursive)
const groups = await service.getUserGroups('tenant-123', 'alice@contoso.com');
console.log('Alice is member of:', groups);
```

### Health Checks

```typescript
const health = await service.healthCheck();
console.log('Service health:', health);
// {
//   healthy: true,
//   status: 'healthy',
//   details: {
//     connected: true,
//     circuitState: 'closed',
//     failureCount: 0,
//     lastSuccessAt: Date
//   }
// }
```

### Metrics

```typescript
const metrics = service.getMetrics();
console.log('Operation metrics:', metrics.operations);
console.log('Circuit state:', metrics.circuitState);

// Per-operation metrics:
// {
//   'upsertUser': {
//     totalCalls: 150,
//     successCalls: 148,
//     failedCalls: 2,
//     retriedCalls: 5,
//     totalLatencyMs: 2340,
//     lastError: Error,
//     lastErrorAt: Date
//   }
// }
```

## Features

### 1. Automatic Retry with Exponential Backoff

Transient failures (connection issues, timeouts) are automatically retried:

- **Default**: 3 retries with 1s base delay, 2x multiplier
- **Backoff**: 1s → 2s → 4s
- **Configurable**: Adjust via `maxRetries`, `retryDelayMs`, `retryBackoffMultiplier`

```typescript
// Will retry automatically on transient failures
const user = await service.upsertUser({ ... });
```

### 2. Circuit Breaker Pattern

Protects against cascading failures:

- **Threshold**: Circuit opens after 5 consecutive failures (configurable)
- **Timeout**: Circuit tests recovery after 60 seconds (configurable)
- **States**: CLOSED (normal) → OPEN (failing) → HALF_OPEN (testing) → CLOSED

```typescript
// Circuit breaker prevents requests during failures
try {
  const user = await service.upsertUser({ ... });
} catch (error) {
  if (error.message.includes('Circuit breaker is OPEN')) {
    // Service temporarily unavailable, try again later
  }
}
```

### 3. Comprehensive Monitoring

Track performance and errors:

```typescript
const metrics = service.getMetrics();

// Operation-level metrics
for (const [operation, stats] of metrics.operations) {
  const avgLatency = stats.totalLatencyMs / stats.totalCalls;
  const successRate = (stats.successCalls / stats.totalCalls) * 100;

  console.log(`${operation}: ${successRate.toFixed(2)}% success, ${avgLatency.toFixed(2)}ms avg`);
}

// Circuit breaker status
console.log('Circuit state:', metrics.circuitState);
console.log('Failure count:', metrics.failureCount);
```

### 4. Singleton Pattern

Service uses singleton pattern for efficient connection pooling:

```typescript
// Get existing instance or create new one
const service1 = PermissionGraphService.getInstance(config);
const service2 = PermissionGraphService.getInstance(); // Returns same instance

// Reset for testing
PermissionGraphService.resetInstance();
```

### 5. Graceful Degradation

Service handles failures gracefully:

- **Health checks**: Monitor service availability
- **Circuit breaker**: Fail fast during outages
- **Clear errors**: Actionable error messages

## API Reference

### User Operations

```typescript
// Upsert user (create or update)
await service.upsertUser({
  tenantId: 'tenant-123',
  email: 'alice@contoso.com',
  idpUserId: 'azure-ad-id',
  idpProvider: 'azuread',
  displayName: 'Alice Johnson',
});

// Get user
const user = await service.getUser('tenant-123', 'alice@contoso.com');

// Batch upsert (for IDP sync)
const count = await service.batchUpsertUsers('tenant-123', [
  { tenantId: 'tenant-123', email: 'user1@contoso.com', displayName: 'User 1' },
  { tenantId: 'tenant-123', email: 'user2@contoso.com', displayName: 'User 2' },
]);
```

### Group Operations

```typescript
// Upsert group
await service.upsertGroup({
  tenantId: 'tenant-123',
  groupId: 'azuread:engineering',
  source: 'azuread',
  displayName: 'Engineering Team',
});

// Get group
const group = await service.getGroup('tenant-123', 'azuread:engineering');

// Batch upsert
const count = await service.batchUpsertGroups('tenant-123', [
  { tenantId: 'tenant-123', groupId: 'azuread:group1', source: 'azuread', displayName: 'Group 1' },
]);
```

### Document Operations

```typescript
// Upsert document
await service.upsertDocument({
  tenantId: 'tenant-123',
  documentId: 'doc-456',
  sourceId: 'connector-789',
  source: 'sharepoint',
  name: 'Q1 Report.docx',
  publicInDomain: false,
  publicEverywhere: false,
});

// Delete document
await service.deleteDocument('tenant-123', 'doc-456');
```

### Membership Operations

```typescript
// User → Group
await service.setMembership({
  tenantId: 'tenant-123',
  memberEmail: 'alice@contoso.com',
  parentGroupId: 'azuread:engineering',
  source: 'azuread',
});

// Group → Group (nested)
await service.setMembership({
  tenantId: 'tenant-123',
  memberGroupId: 'azuread:dev-team',
  parentGroupId: 'azuread:engineering',
  source: 'azuread',
});

// Remove membership
await service.removeMembership({
  tenantId: 'tenant-123',
  memberEmail: 'alice@contoso.com',
  parentGroupId: 'azuread:engineering',
  source: 'azuread',
});
```

### Permission Operations

```typescript
// User → Document permission
await service.setPermission({
  tenantId: 'tenant-123',
  userEmail: 'alice@contoso.com',
  documentId: 'doc-456',
  role: 'owner',
  source: 'sharepoint',
});

// Group → Document permission
await service.setPermission({
  tenantId: 'tenant-123',
  groupId: 'azuread:engineering',
  documentId: 'doc-456',
  role: 'read',
  source: 'sharepoint',
});

// Document → Domain (public in domain)
await service.setPublicInDomain('tenant-123', 'doc-456', 'contoso.com');

// Remove permission
await service.removePermission({
  tenantId: 'tenant-123',
  userEmail: 'alice@contoso.com',
  documentId: 'doc-456',
  role: 'owner',
  source: 'sharepoint',
});
```

### Permission Queries

```typescript
// Get all groups for user (recursive, up to 20 levels)
const groups = await service.getUserGroups('tenant-123', 'alice@contoso.com');
// ['azuread:dev-team', 'azuread:engineering', 'azuread:all-staff']

// Get all documents user can access
const docIds = await service.getAccessibleDocuments('tenant-123', 'alice@contoso.com', {
  maxDepth: 20, // Group nesting depth
  limit: 10000, // Max documents to return
});

// Get flattened permissions for document (for vector DB)
const permissions = await service.getFlattenedPermissions('tenant-123', 'doc-456');
// {
//   allowedUsers: ['alice@contoso.com', 'bob@contoso.com'],
//   allowedGroups: ['azuread:engineering'],
//   allowedDomains: ['contoso.com'],
//   publicInDomain: true,
//   publicEverywhere: false
// }

// Get graph statistics
const stats = await service.getGraphStats('tenant-123');
// {
//   tenantId: 'tenant-123',
//   userCount: 5000,
//   groupCount: 150,
//   documentCount: 50000,
//   domainCount: 2,
//   membershipCount: 12000,
//   permissionCount: 100000
// }
```

## Configuration

### Environment Variables

```bash
# Neo4j connection
NEO4J_URI=neo4j://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password
NEO4J_DATABASE=neo4j

# Optional: Performance tuning
NEO4J_MAX_POOL_SIZE=50
NEO4J_CONNECTION_TIMEOUT=30000

# Optional: Retry configuration
NEO4J_MAX_RETRIES=3
NEO4J_RETRY_DELAY_MS=1000
NEO4J_RETRY_BACKOFF=2

# Optional: Circuit breaker
NEO4J_CIRCUIT_THRESHOLD=5
NEO4J_CIRCUIT_TIMEOUT=60000
```

### TypeScript Configuration

```typescript
const config: PermissionGraphServiceConfig = {
  // Required
  uri: process.env.NEO4J_URI || 'neo4j://localhost:7687',
  username: process.env.NEO4J_USERNAME || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'password',

  // Optional: Connection pooling
  maxConnectionPoolSize: parseInt(process.env.NEO4J_MAX_POOL_SIZE || '50'),
  connectionTimeout: parseInt(process.env.NEO4J_CONNECTION_TIMEOUT || '30000'),

  // Optional: Retry logic
  maxRetries: parseInt(process.env.NEO4J_MAX_RETRIES || '3'),
  retryDelayMs: parseInt(process.env.NEO4J_RETRY_DELAY_MS || '1000'),
  retryBackoffMultiplier: parseFloat(process.env.NEO4J_RETRY_BACKOFF || '2'),

  // Optional: Circuit breaker
  circuitBreakerThreshold: parseInt(process.env.NEO4J_CIRCUIT_THRESHOLD || '5'),
  circuitBreakerTimeout: parseInt(process.env.NEO4J_CIRCUIT_TIMEOUT || '60000'),

  // Optional: Monitoring
  enableMetrics: true,
  metricsPrefix: 'neo4j_permission',
};
```

## Error Handling

```typescript
try {
  await service.upsertUser({ ... });
} catch (error) {
  if (error.message.includes('Circuit breaker is OPEN')) {
    // Service temporarily unavailable
    console.error('Neo4j service unavailable, trying fallback...');
  } else if (error.message.includes('Connection')) {
    // Connection issue
    console.error('Neo4j connection failed:', error);
  } else {
    // Other errors (validation, constraint violations, etc.)
    console.error('Operation failed:', error);
  }
}
```

## Performance Targets

| Operation                 | Target Latency | Scale         |
| ------------------------- | -------------- | ------------- |
| `upsertUser`              | <10ms          | 100K users    |
| `getUserGroups`           | <10ms          | 100 groups    |
| `getUserGroups`           | <50ms          | 1000 groups   |
| `getAccessibleDocuments`  | <50ms          | 10M documents |
| `getFlattenedPermissions` | <20ms          | Per document  |
| `batchUpsertUsers`        | <1s            | 1000 users    |

## Testing

Run tests:

```bash
# Unit tests (with mocks)
pnpm test permission-graph-service

# Integration tests (requires Neo4j)
NEO4J_URI=neo4j://localhost:7687 pnpm test permission-graph-service.integration

# Performance tests
NEO4J_URI=neo4j://localhost:7687 pnpm test:perf permission-graph-service
```

## Migration from MongoDB

See [PERMISSION-IMPLEMENTATION-PLAN.md](./docs/IMPLEMENTATION-PLAN.md) for complete migration strategy.

## Troubleshooting

### Circuit Breaker Opened

```typescript
const health = await service.healthCheck();
if (health.status === 'circuit_open') {
  console.log('Circuit opened at:', health.details.circuitOpenedAt);
  console.log('Failure count:', health.details.failureCount);

  // Wait for circuit to reset or manually reset metrics
  service.resetMetrics();
}
```

### High Latency

```typescript
const metrics = service.getMetrics();
for (const [operation, stats] of metrics.operations) {
  const avgLatency = stats.totalLatencyMs / stats.totalCalls;
  if (avgLatency > 100) {
    console.warn(`${operation} slow: ${avgLatency.toFixed(2)}ms average`);
  }
}
```

### Connection Issues

```bash
# Verify Neo4j is running
docker ps | grep neo4j

# Check connection
curl http://localhost:7474

# Test connection in code
const connected = await service.healthCheck();
console.log('Connected:', connected.details.connected);
```

## Related Documentation

- [Neo4j Schema Documentation](./neo4j-permission-schema.md)
- [RFC-003: Permission Architecture](../../../../docs/rfcs/RFC-003-SearchAI-Permission-Architecture.md)
- [Implementation Plan](./docs/IMPLEMENTATION-PLAN.md)

---

**Version**: 1.0.0
**Last Updated**: 2026-02-24
