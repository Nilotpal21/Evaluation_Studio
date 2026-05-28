# @agent-platform/connectors-base

Shared infrastructure for enterprise connectors. Provides interfaces, base classes, OAuth flows, rate limiting, and common utilities that all connectors extend.

## Installation

```bash
pnpm add @agent-platform/connectors-base
```

## Overview

This package contains the foundational components for building enterprise connectors. Instead of reimplementing OAuth flows, rate limiting, and sync orchestration for each data source, connectors extend these battle-tested base classes.

### What's Included

**Interfaces**: Core contracts that all connectors must implement

- `IConnector` - Main connector interface
- `ISyncCoordinator` - Sync orchestration
- `IFilterEngine` - Document filtering
- `IOAuthProvider` - OAuth provider abstraction
- `IPermissionCrawler` - Permission tracking

**OAuth & Authentication**:

- `DeviceCodeFlowAuthenticator` - RFC 8628 implementation
- `TokenManager` - Token refresh and validation
- Works with any OAuth provider (Microsoft, Atlassian, Google)

**HTTP & Rate Limiting**:

- `RateLimiter` - Token bucket algorithm
- `RetryHandler` - Exponential backoff with jitter
- `HttpClient` - Base HTTP client with rate limiting + retry

**Sync & Filtering**:

- `BaseSyncCoordinator` - Template method for sync operations
- `BaseFilterEngine` - Common filters (date, size, content type)

## Usage

### Creating a New Connector

```typescript
import {
  BaseSyncCoordinator,
  BaseFilterEngine,
  DeviceCodeFlowAuthenticator,
  IOAuthProvider,
  RateLimiter,
  HttpClient,
} from '@agent-platform/connectors-base';

// 1. Implement OAuth Provider
class MyOAuthProvider implements IOAuthProvider {
  async requestDeviceCode(scopes: string[]) {
    // Provider-specific device code request
  }

  async exchangeDeviceCode(deviceCode: string) {
    // Provider-specific token exchange
  }

  async refreshToken(refreshToken: string) {
    // Provider-specific token refresh
  }
}

// 2. Create API Client
class MyAPIClient extends HttpClient {
  constructor(accessToken: string) {
    super({
      baseUrl: 'https://api.example.com',
      defaultHeaders: {
        Authorization: `Bearer ${accessToken}`,
      },
      rateLimiter: new RateLimiter(1000, 10), // 1000 req per 100 sec
    });
  }

  async getResources() {
    return await this.get('/resources');
  }
}

// 3. Implement Sync Coordinator
class MySyncCoordinator extends BaseSyncCoordinator {
  constructor(
    config: IConnectorConfig,
    filterEngine: IFilterEngine,
    private apiClient: MyAPIClient,
  ) {
    super(config, filterEngine);
  }

  protected async fetchDocuments(checkpoint: ISyncCheckpoint | null) {
    const resources = await this.apiClient.getResources();
    return resources.map((r) => this.mapToSourceDocument(r));
  }

  protected async getDeltaToken() {
    return this.config.syncState.deltaToken || null;
  }
}
```

## Key Components

### DeviceCodeFlowAuthenticator

Implements OAuth 2.0 Device Code Flow (RFC 8628) for CLI-friendly authentication.

```typescript
const provider = new MyOAuthProvider({ clientId: 'abc123' });
const authenticator = new DeviceCodeFlowAuthenticator(provider);

const tokens = await authenticator.authenticate(['read:data', 'write:data'], (deviceCode) => {
  console.log(`Visit: ${deviceCode.verificationUri}`);
  console.log(`Code: ${deviceCode.userCode}`);
});

// tokens.accessToken, tokens.refreshToken
```

### RateLimiter

Token bucket algorithm for API rate limiting.

```typescript
const rateLimiter = new RateLimiter(
  10000, // maxTokens
  16.67, // refillRate (tokens per second)
);

// Acquire 1 token (waits if necessary)
await rateLimiter.acquire();

// Acquire 5 tokens
await rateLimiter.acquire(5);
```

### BaseSyncCoordinator

Template method pattern for sync operations. Implement only `fetchDocuments()` and `getDeltaToken()`.

```typescript
class MySyncCoordinator extends BaseSyncCoordinator {
  // Required: How to fetch documents
  protected async fetchDocuments(checkpoint: ISyncCheckpoint | null) {
    // Your logic here
    return documents;
  }

  // Required: How to get delta token
  protected async getDeltaToken() {
    return this.config.syncState.deltaToken || null;
  }
}

// The base class handles:
// - Checkpoint management
// - Progress tracking
// - Creating SearchDocument records
// - Triggering ingestion pipeline
// - Error handling
```

### BaseFilterEngine

Common filter evaluation logic. Extend for connector-specific filters.

```typescript
class MyFilterEngine extends BaseFilterEngine {
  evaluate(document: SourceDocument): FilterEvaluationResult {
    // Apply base filters (date, size, content type)
    const baseResult = super.evaluate(document);
    if (!baseResult.include) return baseResult;

    // Apply custom filters
    if (this.config.custom?.myCustomFilter) {
      // Your filter logic
    }

    return { include: true, appliedFilters: [] };
  }
}
```

## Design Patterns

### Template Method Pattern

`BaseSyncCoordinator` defines the skeleton algorithm:

```typescript
async performSync() {
  // 1. Initialize (provided)
  const checkpoint = await this.initializeSync();

  // 2. Fetch documents (YOU implement)
  const documents = await this.fetchDocuments(checkpoint);

  // 3. Process documents (provided)
  for (const doc of documents) {
    if (this.filterEngine.evaluate(doc).include) {
      await this.createSearchDocument(doc);
      await this.triggerIngestion(doc);
    }
  }

  // 4. Finalize (provided)
  return await this.finalizeSync(checkpoint);
}
```

### Strategy Pattern

`IOAuthProvider` allows different OAuth implementations:

```typescript
interface IOAuthProvider {
  requestDeviceCode(scopes: string[]): Promise<DeviceCodeResponse>;
  exchangeDeviceCode(deviceCode: string): Promise<OAuthTokens>;
  refreshToken(refreshToken: string): Promise<OAuthTokens>;
}

// Microsoft implementation
class MicrosoftOAuthProvider implements IOAuthProvider { ... }

// Atlassian implementation
class AtlassianOAuthProvider implements IOAuthProvider { ... }

// Generic authenticator works with both
const auth = new DeviceCodeFlowAuthenticator(provider);
```

## Testing

```bash
# Run unit tests
pnpm test

# Run with coverage
pnpm test:coverage

# Watch mode
pnpm test:watch
```

## API Reference

See `/packages/connectors/sharepoint/docs/ARCHITECTURE.md` for detailed architecture documentation.

## Examples

See `/packages/connectors/sharepoint/` for a complete reference implementation.

## License

Proprietary - Internal use only
