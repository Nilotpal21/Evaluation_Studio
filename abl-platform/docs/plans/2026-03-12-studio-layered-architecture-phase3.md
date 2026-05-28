# Studio Layered Architecture — Phase 3: Connections + Agent Detail

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Connections and Agent Detail as feature modules, fixing the most confusing data flows.

**Architecture:** Connections unifies two backends (project connectors + channel connections) behind one API layer. Agent Detail extracts the 310-LOC IR parser as a pure function and slims the store.

**Tech Stack:** TypeScript, Zustand 4.4 (with devtools), Zod 3.23, Vitest 4.0, happy-dom

**Spec:** `docs/plans/2026-03-12-studio-layered-architecture-design.md`

**Depends on:** Phase 1 (MessageBus infrastructure)

---

## Pre-Implementation Checklist

Before starting any task, the implementing agent MUST:

1. Run `npx prettier --write <files>` on ALL changed files before committing
2. BEFORE using any existing component/function/type, READ its source file to verify the actual signature
3. NEVER switch branches — stay on the current branch
4. NEVER add "Co-Authored-By" lines to commit messages
5. Commit messages: `[ABLP-2] type(scope): description`
6. Run `pnpm build --filter=studio` after creating/modifying files to catch type errors immediately
7. Use `@/` path alias for all imports within `apps/studio/src/`

## File Structure

All new files live under `apps/studio/src/`. Abbreviated as `src/` below.

### Connections Feature Module (new)

```
src/features/connections/
  connections.contract.ts     ← Zod schemas: ConnectionSummary, ConnectionDetail, ConnectorSummary, ChannelConnection, ChannelOAuth
  connections.types.ts        ← z.infer derived types + discriminated unions
  connections.store.ts        ← Pure Zustand store (connection list, selected, catalog, loading/error, test results)
  connections.api.ts          ← Unified API layer absorbing api/connections.ts + api/channels.ts + api/channel-connections.ts + api/channel-oauth.ts
  index.ts                    ← Barrel exports

  __tests__/
    connections.contract.test.ts
    connections.store.test.ts
    connections.api.test.ts

  __fixtures__/
    connection-summary.json
    connection-detail.json
    connector-catalog.json
    channel-connection.json
    channel-oauth.json
```

### Agent Detail Feature Module (new)

```
src/features/agent-detail/
  agent-detail.contract.ts    ← Zod schemas: AgentIR, AgentGoal, AgentTool, AgentExecution
  agent-detail.types.ts       ← z.infer derived types
  agent-detail.store.ts       ← Pure Zustand store (parsed IR, loading, dirty state)
  agent-detail.api.ts         ← API layer for agent CRUD + DSL compilation
  ir-parser.ts                ← Pure function: raw IR JSON → structured AgentDetail (extracted from component)
  index.ts                    ← Barrel exports

  __tests__/
    agent-detail.contract.test.ts
    agent-detail.store.test.ts
    ir-parser.test.ts

  __fixtures__/
    agent-ir-full.json
    agent-ir-minimal.json
```

---

## Chunk 1: Connections Feature Module (Tasks 1–7)

---

### Task 1: Connections Contract Schemas

**TDD: Write test → see it fail → implement → pass → commit**

#### 1a. Write the test

```typescript
// src/features/connections/__tests__/connections.contract.test.ts

import { describe, it, expect } from 'vitest';
import {
  ConnectionSummarySchema,
  ConnectionDetailSchema,
  ConnectorSummarySchema,
  ChannelConnectionSummarySchema,
  ChannelOAuthAuthorizeSchema,
  ChannelOAuthCallbackSchema,
  SDKChannelSchema,
} from '../connections.contract';

describe('ConnectionSummarySchema', () => {
  const valid = {
    id: 'conn_abc123',
    connectorName: 'slack',
    displayName: 'My Slack',
    scope: 'tenant',
    authType: 'oauth2',
    status: 'active',
    hasCredentials: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts valid ConnectionSummary', () => {
    expect(ConnectionSummarySchema.parse(valid)).toEqual(valid);
  });

  it('accepts optional expiresAt and category', () => {
    const withOptional = {
      ...valid,
      expiresAt: '2026-06-01T00:00:00.000Z',
      category: 'tool',
    };
    expect(ConnectionSummarySchema.parse(withOptional)).toEqual(withOptional);
  });

  it('rejects invalid scope', () => {
    expect(() => ConnectionSummarySchema.parse({ ...valid, scope: 'global' })).toThrow();
  });

  it('rejects invalid authType', () => {
    expect(() => ConnectionSummarySchema.parse({ ...valid, authType: 'unknown' })).toThrow();
  });

  it('rejects invalid status', () => {
    expect(() => ConnectionSummarySchema.parse({ ...valid, status: 'pending' })).toThrow();
  });

  it('rejects missing required fields', () => {
    const { connectorName: _, ...missing } = valid;
    expect(() => ConnectionSummarySchema.parse(missing)).toThrow();
  });
});

describe('ConnectionDetailSchema', () => {
  const base = {
    id: 'conn_abc123',
    connectorName: 'slack',
    displayName: 'My Slack',
    scope: 'tenant',
    authType: 'oauth2',
    status: 'active',
    hasCredentials: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts ConnectionDetail with metadata', () => {
    const detail = { ...base, metadata: { workspace: 'T01234' } };
    expect(ConnectionDetailSchema.parse(detail).metadata).toEqual({
      workspace: 'T01234',
    });
  });

  it('accepts ConnectionDetail without metadata', () => {
    expect(ConnectionDetailSchema.parse(base).metadata).toBeUndefined();
  });
});

describe('ConnectorSummarySchema', () => {
  const valid = {
    name: 'slack',
    displayName: 'Slack',
  };

  it('accepts minimal connector', () => {
    expect(ConnectorSummarySchema.parse(valid)).toEqual(valid);
  });

  it('accepts full connector with triggers, actions, oauth2', () => {
    const full = {
      ...valid,
      description: 'Slack integration',
      category: 'messaging',
      authType: 'oauth2',
      triggers: [{ name: 'message', displayName: 'New Message' }],
      actions: [
        {
          name: 'send',
          displayName: 'Send Message',
          description: 'Send a message to a channel',
        },
      ],
      oauth2: {
        authorizationUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        defaultScopes: ['chat:write'],
        scopeSeparator: ',',
        pkce: false,
      },
    };
    expect(ConnectorSummarySchema.parse(full)).toEqual(full);
  });

  it('rejects missing name', () => {
    expect(() => ConnectorSummarySchema.parse({ displayName: 'Slack' })).toThrow();
  });
});

describe('ChannelConnectionSummarySchema', () => {
  const valid = {
    id: 'ch_abc',
    projectId: 'proj_1',
    channelType: 'slack',
    displayName: null,
    externalIdentifier: 'T01234',
    hasCredentials: true,
    config: {},
    status: 'active',
    deploymentId: null,
    environment: null,
    webhookUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts valid ChannelConnectionSummary', () => {
    expect(ChannelConnectionSummarySchema.parse(valid)).toEqual(valid);
  });

  it('accepts non-null optional fields', () => {
    const withValues = {
      ...valid,
      displayName: 'My Slack',
      deploymentId: 'dep_1',
      environment: 'production',
      webhookUrl: 'https://example.com/webhook',
    };
    expect(ChannelConnectionSummarySchema.parse(withValues)).toEqual(withValues);
  });
});

describe('SDKChannelSchema', () => {
  const valid = {
    id: 'sdk_1',
    tenantId: 'tenant_1',
    projectId: 'proj_1',
    deploymentId: null,
    name: 'Web Widget',
    channelType: 'web',
    publicApiKeyId: 'key_1',
    config: {},
    isActive: true,
    environment: null,
    followEnvironment: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts valid SDKChannel', () => {
    expect(SDKChannelSchema.parse(valid)).toEqual(valid);
  });

  it('rejects invalid channelType', () => {
    expect(() => SDKChannelSchema.parse({ ...valid, channelType: 'sms' })).toThrow();
  });
});

describe('ChannelOAuthAuthorizeSchema', () => {
  it('accepts valid authorize response', () => {
    const valid = {
      success: true,
      authUrl: 'https://slack.com/oauth/authorize?...',
      state: 'state_abc',
    };
    expect(ChannelOAuthAuthorizeSchema.parse(valid)).toEqual(valid);
  });
});

describe('ChannelOAuthCallbackSchema', () => {
  it('accepts valid callback result', () => {
    const valid = {
      success: true,
      channelType: 'slack',
      credentials: { bot_token: 'xoxb-...' },
      externalIdentifier: 'T01234',
      displayName: 'My Workspace',
      metadata: { team_id: 'T01234' },
      projectId: 'proj_1',
    };
    expect(ChannelOAuthCallbackSchema.parse(valid)).toEqual(valid);
  });
});
```

#### 1b. Implement the contract

```typescript
// src/features/connections/connections.contract.ts

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Connection (project-scoped connector instances) — from api/connections.ts
// ---------------------------------------------------------------------------

export const ConnectionScopeSchema = z.enum(['tenant', 'user']);

export const ConnectionAuthTypeSchema = z.enum([
  'oauth2',
  'api_key',
  'bearer',
  'basic',
  'custom',
  'none',
]);

export const ConnectionStatusSchema = z.enum(['active', 'expired', 'revoked']);

export const ConnectionCategorySchema = z.enum(['agent_desktop', 'tool', 'messaging']);

export const ConnectionSummarySchema = z.object({
  id: z.string(),
  connectorName: z.string(),
  displayName: z.string(),
  scope: ConnectionScopeSchema,
  authType: ConnectionAuthTypeSchema,
  status: ConnectionStatusSchema,
  hasCredentials: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().optional(),
  category: ConnectionCategorySchema.optional(),
});

export const ConnectionDetailSchema = ConnectionSummarySchema.extend({
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Raw API shape (MongoDB _id) — for normalizeConnection
// ---------------------------------------------------------------------------

export const ConnectionSummaryRawSchema = z.object({
  _id: z.string(),
  connectorName: z.string(),
  displayName: z.string(),
  scope: ConnectionScopeSchema,
  authType: ConnectionAuthTypeSchema,
  status: ConnectionStatusSchema,
  hasCredentials: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  oauth2TokenExpiresAt: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Connector catalog — from hooks/useAvailableConnectors.ts
// ---------------------------------------------------------------------------

const TriggerActionSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
});

const OAuth2ConfigSchema = z.object({
  authorizationUrl: z.string(),
  tokenUrl: z.string(),
  refreshUrl: z.string().optional(),
  defaultScopes: z.array(z.string()),
  scopeSeparator: z.string(),
  pkce: z.boolean(),
});

export const ConnectorSummarySchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  authType: ConnectionAuthTypeSchema.optional(),
  triggers: z.array(TriggerActionSchema).optional(),
  actions: z.array(TriggerActionSchema).optional(),
  oauth2: OAuth2ConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// Channel connections — from api/channel-connections.ts
// ---------------------------------------------------------------------------

export const ChannelConnectionSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  channelType: z.string(),
  displayName: z.string().nullable(),
  externalIdentifier: z.string(),
  hasCredentials: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  status: z.string(),
  deploymentId: z.string().nullable(),
  environment: z.string().nullable(),
  webhookUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// SDK Channels — from api/channels.ts
// ---------------------------------------------------------------------------

export const SDKChannelTypeSchema = z.enum([
  'web',
  'mobile_ios',
  'mobile_android',
  'voice',
  'voice_livekit',
  'voice_twilio',
  'api',
]);

export const SDKChannelSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  projectId: z.string(),
  deploymentId: z.string().nullable(),
  name: z.string(),
  channelType: SDKChannelTypeSchema,
  publicApiKeyId: z.string(),
  config: z.record(z.string(), z.unknown()),
  isActive: z.boolean(),
  environment: z.string().nullable(),
  followEnvironment: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Channel OAuth — from api/channel-oauth.ts
// ---------------------------------------------------------------------------

export const ChannelOAuthAuthorizeSchema = z.object({
  success: z.boolean(),
  authUrl: z.string(),
  state: z.string(),
});

export const ChannelOAuthCallbackSchema = z.object({
  success: z.boolean(),
  channelType: z.string(),
  credentials: z.record(z.string(), z.string()),
  externalIdentifier: z.string(),
  displayName: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  projectId: z.string(),
});

// ---------------------------------------------------------------------------
// API envelope schemas (for validated fetch)
// ---------------------------------------------------------------------------

export const ConnectionListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(ConnectionSummarySchema),
});

export const ConnectionDetailResponseSchema = z.object({
  success: z.boolean(),
  data: ConnectionDetailSchema,
});

export const ConnectorListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(ConnectorSummarySchema),
});

export const ChannelConnectionListResponseSchema = z.object({
  connections: z.array(ChannelConnectionSummarySchema),
});

export const SDKChannelListResponseSchema = z.object({
  success: z.boolean(),
  channels: z.array(SDKChannelSchema),
});
```

#### 1c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/connections/__tests__/connections.contract.test.ts
npx prettier --write src/features/connections/connections.contract.ts src/features/connections/__tests__/connections.contract.test.ts
git add src/features/connections/connections.contract.ts src/features/connections/__tests__/connections.contract.test.ts
git commit -m "[ABLP-2] feat(studio): add connections contract schemas with Zod validation"
```

---

### Task 2: Connections Types

**TDD: Write test → see it fail → implement → pass → commit**

#### 2a. Write the test

```typescript
// src/features/connections/__tests__/connections.types.test.ts

import { describe, it, expectTypeOf } from 'vitest';
import type {
  ConnectionSummary,
  ConnectionDetail,
  ConnectorSummary,
  ChannelConnectionSummary,
  SDKChannel,
  ChannelOAuthAuthorizeResponse,
  ChannelOAuthCallbackResult,
  ConnectionScope,
  ConnectionAuthType,
  ConnectionStatus,
  ConnectionCategory,
  ConnectionTestResult,
  ConnectionsLoadingState,
} from '../connections.types';

describe('connections types', () => {
  it('ConnectionSummary has expected shape', () => {
    expectTypeOf<ConnectionSummary>().toHaveProperty('id');
    expectTypeOf<ConnectionSummary>().toHaveProperty('connectorName');
    expectTypeOf<ConnectionSummary>().toHaveProperty('scope');
    expectTypeOf<ConnectionSummary>().toHaveProperty('authType');
    expectTypeOf<ConnectionSummary>().toHaveProperty('status');
    expectTypeOf<ConnectionSummary>().toHaveProperty('hasCredentials');
  });

  it('ConnectionDetail extends ConnectionSummary with optional metadata', () => {
    expectTypeOf<ConnectionDetail>().toMatchTypeOf<ConnectionSummary>();
    expectTypeOf<ConnectionDetail>().toHaveProperty('metadata');
  });

  it('ConnectorSummary has name and displayName', () => {
    expectTypeOf<ConnectorSummary>().toHaveProperty('name');
    expectTypeOf<ConnectorSummary>().toHaveProperty('displayName');
  });

  it('ConnectionScope is a union of tenant | user', () => {
    expectTypeOf<'tenant'>().toMatchTypeOf<ConnectionScope>();
    expectTypeOf<'user'>().toMatchTypeOf<ConnectionScope>();
  });

  it('ConnectionTestResult has status and optional message', () => {
    expectTypeOf<ConnectionTestResult>().toHaveProperty('status');
    expectTypeOf<ConnectionTestResult>().toHaveProperty('message');
  });

  it('ConnectionsLoadingState tracks multiple loading flags', () => {
    expectTypeOf<ConnectionsLoadingState>().toHaveProperty('list');
    expectTypeOf<ConnectionsLoadingState>().toHaveProperty('detail');
    expectTypeOf<ConnectionsLoadingState>().toHaveProperty('catalog');
    expectTypeOf<ConnectionsLoadingState>().toHaveProperty('test');
  });

  it('SDKChannel has channelType enum', () => {
    expectTypeOf<SDKChannel>().toHaveProperty('channelType');
    expectTypeOf<SDKChannel>().toHaveProperty('isActive');
  });

  it('ChannelConnectionSummary has nullable fields', () => {
    expectTypeOf<ChannelConnectionSummary>().toHaveProperty('displayName');
    expectTypeOf<ChannelConnectionSummary>().toHaveProperty('webhookUrl');
  });
});
```

#### 2b. Implement the types

```typescript
// src/features/connections/connections.types.ts

import { z } from 'zod';
import {
  ConnectionSummarySchema,
  ConnectionDetailSchema,
  ConnectorSummarySchema,
  ChannelConnectionSummarySchema,
  SDKChannelSchema,
  ChannelOAuthAuthorizeSchema,
  ChannelOAuthCallbackSchema,
  ConnectionScopeSchema,
  ConnectionAuthTypeSchema,
  ConnectionStatusSchema,
  ConnectionCategorySchema,
  ConnectionSummaryRawSchema,
} from './connections.contract';

// ---------------------------------------------------------------------------
// Derived types from Zod schemas
// ---------------------------------------------------------------------------

export type ConnectionSummary = z.infer<typeof ConnectionSummarySchema>;
export type ConnectionDetail = z.infer<typeof ConnectionDetailSchema>;
export type ConnectorSummary = z.infer<typeof ConnectorSummarySchema>;
export type ChannelConnectionSummary = z.infer<typeof ChannelConnectionSummarySchema>;
export type SDKChannel = z.infer<typeof SDKChannelSchema>;
export type ChannelOAuthAuthorizeResponse = z.infer<typeof ChannelOAuthAuthorizeSchema>;
export type ChannelOAuthCallbackResult = z.infer<typeof ChannelOAuthCallbackSchema>;
export type ConnectionSummaryRaw = z.infer<typeof ConnectionSummaryRawSchema>;

// ---------------------------------------------------------------------------
// Enum types
// ---------------------------------------------------------------------------

export type ConnectionScope = z.infer<typeof ConnectionScopeSchema>;
export type ConnectionAuthType = z.infer<typeof ConnectionAuthTypeSchema>;
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;
export type ConnectionCategory = z.infer<typeof ConnectionCategorySchema>;

// ---------------------------------------------------------------------------
// Store-specific types (not API-derived)
// ---------------------------------------------------------------------------

export interface ConnectionTestResult {
  status: 'idle' | 'testing' | 'success' | 'failure';
  message?: string;
}

export interface ConnectionsLoadingState {
  list: boolean;
  detail: boolean;
  catalog: boolean;
  test: boolean;
}

export interface ConnectionsErrorState {
  list: string | null;
  detail: string | null;
  catalog: string | null;
  test: string | null;
}

// ---------------------------------------------------------------------------
// Create / Update input types (for API layer)
// ---------------------------------------------------------------------------

export interface CreateConnectionInput {
  connectorName: string;
  displayName: string;
  authType?: string;
  credentials?: Record<string, unknown>;
}

export interface UpdateConnectionInput {
  displayName?: string;
  credentials?: Record<string, unknown>;
  status?: 'active' | 'expired' | 'revoked';
}

export interface CreateChannelConnectionInput {
  channel_type: string;
  display_name?: string;
  external_identifier?: string;
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  deployment_id?: string;
  environment?: 'dev' | 'staging' | 'production';
}

export interface UpdateChannelConnectionInput {
  display_name?: string;
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  status?: 'active' | 'inactive';
  deployment_id?: string | null;
  environment?: 'dev' | 'staging' | 'production' | null;
}
```

#### 2c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/connections/__tests__/connections.types.test.ts
npx prettier --write src/features/connections/connections.types.ts src/features/connections/__tests__/connections.types.test.ts
git add src/features/connections/connections.types.ts src/features/connections/__tests__/connections.types.test.ts
git commit -m "[ABLP-2] feat(studio): add connections types derived from Zod contracts"
```

---

### Task 3: Connections Store

**TDD: Write test → see it fail → implement → pass → commit**

#### 3a. Write the test

```typescript
// src/features/connections/__tests__/connections.store.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { useConnectionsStore } from '../connections.store';
import type { ConnectionSummary, ConnectionDetail, ConnectorSummary } from '../connections.types';

const mockConnection: ConnectionSummary = {
  id: 'conn_1',
  connectorName: 'slack',
  displayName: 'My Slack',
  scope: 'tenant',
  authType: 'oauth2',
  status: 'active',
  hasCredentials: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const mockDetail: ConnectionDetail = {
  ...mockConnection,
  metadata: { workspace: 'T01234' },
};

const mockConnector: ConnectorSummary = {
  name: 'slack',
  displayName: 'Slack',
  description: 'Slack integration',
  category: 'messaging',
  authType: 'oauth2',
};

describe('useConnectionsStore', () => {
  beforeEach(() => {
    useConnectionsStore.getState().reset();
  });

  // --- Connection list ---

  it('starts with empty connections', () => {
    const state = useConnectionsStore.getState();
    expect(state.connections).toEqual([]);
    expect(state.selectedConnection).toBeNull();
  });

  it('setConnections replaces the list', () => {
    useConnectionsStore.getState().setConnections([mockConnection]);
    expect(useConnectionsStore.getState().connections).toEqual([mockConnection]);
  });

  it('setConnections clears selected if not in new list', () => {
    useConnectionsStore.getState().setSelectedConnection(mockDetail);
    useConnectionsStore.getState().setConnections([]);
    expect(useConnectionsStore.getState().selectedConnection).toBeNull();
  });

  it('setConnections keeps selected if still in list', () => {
    useConnectionsStore.getState().setSelectedConnection(mockDetail);
    useConnectionsStore.getState().setConnections([mockConnection]);
    expect(useConnectionsStore.getState().selectedConnection).not.toBeNull();
  });

  // --- Selected connection ---

  it('setSelectedConnection sets detail', () => {
    useConnectionsStore.getState().setSelectedConnection(mockDetail);
    expect(useConnectionsStore.getState().selectedConnection).toEqual(mockDetail);
  });

  it('clearSelectedConnection clears', () => {
    useConnectionsStore.getState().setSelectedConnection(mockDetail);
    useConnectionsStore.getState().clearSelectedConnection();
    expect(useConnectionsStore.getState().selectedConnection).toBeNull();
  });

  // --- Connector catalog ---

  it('setConnectors replaces catalog', () => {
    useConnectionsStore.getState().setConnectors([mockConnector]);
    expect(useConnectionsStore.getState().connectors).toEqual([mockConnector]);
  });

  // --- Loading states ---

  it('setLoading updates specific key', () => {
    useConnectionsStore.getState().setLoading('list', true);
    expect(useConnectionsStore.getState().loading.list).toBe(true);
    expect(useConnectionsStore.getState().loading.detail).toBe(false);
  });

  // --- Error states ---

  it('setError updates specific key', () => {
    useConnectionsStore.getState().setError('list', 'Network error');
    expect(useConnectionsStore.getState().errors.list).toBe('Network error');
  });

  it('clearErrors resets all errors', () => {
    useConnectionsStore.getState().setError('list', 'err1');
    useConnectionsStore.getState().setError('detail', 'err2');
    useConnectionsStore.getState().clearErrors();
    const { errors } = useConnectionsStore.getState();
    expect(errors.list).toBeNull();
    expect(errors.detail).toBeNull();
  });

  // --- Test results ---

  it('setTestResult updates for a connection ID', () => {
    useConnectionsStore.getState().setTestResult('conn_1', { status: 'testing' });
    expect(useConnectionsStore.getState().testResults['conn_1']).toEqual({
      status: 'testing',
    });
  });

  it('clearTestResult removes a specific result', () => {
    useConnectionsStore.getState().setTestResult('conn_1', { status: 'success', message: 'OK' });
    useConnectionsStore.getState().clearTestResult('conn_1');
    expect(useConnectionsStore.getState().testResults['conn_1']).toBeUndefined();
  });

  // --- Reset ---

  it('reset returns to initial state', () => {
    useConnectionsStore.getState().setConnections([mockConnection]);
    useConnectionsStore.getState().setConnectors([mockConnector]);
    useConnectionsStore.getState().setLoading('list', true);
    useConnectionsStore.getState().setError('catalog', 'err');
    useConnectionsStore.getState().reset();

    const state = useConnectionsStore.getState();
    expect(state.connections).toEqual([]);
    expect(state.connectors).toEqual([]);
    expect(state.selectedConnection).toBeNull();
    expect(state.loading.list).toBe(false);
    expect(state.errors.catalog).toBeNull();
    expect(state.testResults).toEqual({});
  });
});
```

#### 3b. Implement the store

```typescript
// src/features/connections/connections.store.ts

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  ConnectionSummary,
  ConnectionDetail,
  ConnectorSummary,
  ConnectionTestResult,
  ConnectionsLoadingState,
  ConnectionsErrorState,
} from './connections.types';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface ConnectionsState {
  connections: ConnectionSummary[];
  selectedConnection: ConnectionDetail | null;
  connectors: ConnectorSummary[];
  loading: ConnectionsLoadingState;
  errors: ConnectionsErrorState;
  testResults: Record<string, ConnectionTestResult>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

interface ConnectionsActions {
  setConnections: (connections: ConnectionSummary[]) => void;
  setSelectedConnection: (connection: ConnectionDetail | null) => void;
  clearSelectedConnection: () => void;
  setConnectors: (connectors: ConnectorSummary[]) => void;
  setLoading: (key: keyof ConnectionsLoadingState, value: boolean) => void;
  setError: (key: keyof ConnectionsErrorState, value: string | null) => void;
  clearErrors: () => void;
  setTestResult: (connectionId: string, result: ConnectionTestResult) => void;
  clearTestResult: (connectionId: string) => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const initialState: ConnectionsState = {
  connections: [],
  selectedConnection: null,
  connectors: [],
  loading: { list: false, detail: false, catalog: false, test: false },
  errors: { list: null, detail: null, catalog: null, test: null },
  testResults: {},
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useConnectionsStore = create<ConnectionsState & ConnectionsActions>()(
  devtools(
    (set) => ({
      ...initialState,

      setConnections: (connections) =>
        set(
          (state) => {
            const ids = new Set(connections.map((c) => c.id));
            return {
              connections,
              selectedConnection:
                state.selectedConnection && ids.has(state.selectedConnection.id)
                  ? state.selectedConnection
                  : null,
            };
          },
          false,
          'setConnections',
        ),

      setSelectedConnection: (connection) =>
        set({ selectedConnection: connection }, false, 'setSelectedConnection'),

      clearSelectedConnection: () =>
        set({ selectedConnection: null }, false, 'clearSelectedConnection'),

      setConnectors: (connectors) => set({ connectors }, false, 'setConnectors'),

      setLoading: (key, value) =>
        set(
          (state) => ({
            loading: { ...state.loading, [key]: value },
          }),
          false,
          'setLoading',
        ),

      setError: (key, value) =>
        set(
          (state) => ({
            errors: { ...state.errors, [key]: value },
          }),
          false,
          'setError',
        ),

      clearErrors: () =>
        set(
          { errors: { list: null, detail: null, catalog: null, test: null } },
          false,
          'clearErrors',
        ),

      setTestResult: (connectionId, result) =>
        set(
          (state) => ({
            testResults: { ...state.testResults, [connectionId]: result },
          }),
          false,
          'setTestResult',
        ),

      clearTestResult: (connectionId) =>
        set(
          (state) => {
            const { [connectionId]: _, ...rest } = state.testResults;
            return { testResults: rest };
          },
          false,
          'clearTestResult',
        ),

      reset: () => set(initialState, false, 'reset'),
    }),
    { name: 'connections-store' },
  ),
);
```

#### 3c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/connections/__tests__/connections.store.test.ts
npx prettier --write src/features/connections/connections.store.ts src/features/connections/__tests__/connections.store.test.ts
git add src/features/connections/connections.store.ts src/features/connections/__tests__/connections.store.test.ts
git commit -m "[ABLP-2] feat(studio): add connections Zustand store with devtools"
```

---

### Task 4: Connections API Layer

**TDD: Write test → see it fail → implement → pass → commit**

#### 4a. Write the test

```typescript
// src/features/connections/__tests__/connections.api.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock api-client before importing the module under test
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  handleResponse: vi.fn(),
}));

vi.mock('@/config/runtime', () => ({
  getRuntimeUrl: vi.fn(() => 'http://localhost:3112'),
}));

import { apiFetch, handleResponse } from '@/lib/api-client';
import { connectionsApi } from '../connections.api';

const mockApiFetch = vi.mocked(apiFetch);
const mockHandleResponse = vi.mocked(handleResponse);

describe('connectionsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Project connections (from api/connections.ts)
  // -----------------------------------------------------------------------

  describe('listConnections', () => {
    it('calls correct URL and returns validated data', async () => {
      const mockData = {
        success: true,
        data: [
          {
            id: 'conn_1',
            connectorName: 'slack',
            displayName: 'My Slack',
            scope: 'tenant',
            authType: 'oauth2',
            status: 'active',
            hasCredentials: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
      mockApiFetch.mockResolvedValue(new Response());
      mockHandleResponse.mockResolvedValue(mockData);

      const result = await connectionsApi.listConnections('proj_1');

      expect(mockApiFetch).toHaveBeenCalledWith('/api/projects/proj_1/connections');
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('conn_1');
    });
  });

  describe('getConnection', () => {
    it('calls correct URL with connection ID', async () => {
      const mockData = {
        success: true,
        data: {
          id: 'conn_1',
          connectorName: 'slack',
          displayName: 'My Slack',
          scope: 'tenant',
          authType: 'oauth2',
          status: 'active',
          hasCredentials: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      };
      mockApiFetch.mockResolvedValue(new Response());
      mockHandleResponse.mockResolvedValue(mockData);

      await connectionsApi.getConnection('proj_1', 'conn_1');

      expect(mockApiFetch).toHaveBeenCalledWith('/api/projects/proj_1/connections/conn_1');
    });
  });

  describe('createConnection', () => {
    it('POSTs with JSON body', async () => {
      const input = { connectorName: 'slack', displayName: 'New Slack' };
      mockApiFetch.mockResolvedValue(new Response());
      mockHandleResponse.mockResolvedValue({ success: true, data: {} });

      await connectionsApi.createConnection('proj_1', input);

      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/projects/proj_1/connections',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(input),
        }),
      );
    });
  });

  describe('deleteConnection', () => {
    it('sends DELETE request', async () => {
      mockApiFetch.mockResolvedValue(new Response());
      mockHandleResponse.mockResolvedValue({ success: true });

      await connectionsApi.deleteConnection('proj_1', 'conn_1');

      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/projects/proj_1/connections/conn_1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('testConnection', () => {
    it('POSTs to /test endpoint', async () => {
      mockApiFetch.mockResolvedValue(new Response());
      mockHandleResponse.mockResolvedValue({ success: true });

      await connectionsApi.testConnection('proj_1', 'conn_1');

      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/projects/proj_1/connections/conn_1/test',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // SDK Channels (from api/channels.ts)
  // -----------------------------------------------------------------------

  describe('fetchChannels', () => {
    it('calls runtime URL for SDK channels', async () => {
      mockApiFetch.mockResolvedValue(new Response());
      mockHandleResponse.mockResolvedValue({
        success: true,
        channels: [],
      });

      await connectionsApi.fetchChannels('proj_1');

      expect(mockApiFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj_1/sdk-channels',
        expect.any(Object),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Channel Connections (from api/channel-connections.ts)
  // -----------------------------------------------------------------------

  describe('fetchChannelConnections', () => {
    it('calls runtime URL for channel connections', async () => {
      mockApiFetch.mockResolvedValue(new Response());
      mockHandleResponse.mockResolvedValue({ connections: [] });

      await connectionsApi.fetchChannelConnections('proj_1');

      expect(mockApiFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj_1/channel-connections',
        expect.any(Object),
      );
    });

    it('appends channel_type query param when provided', async () => {
      mockApiFetch.mockResolvedValue(new Response());
      mockHandleResponse.mockResolvedValue({ connections: [] });

      await connectionsApi.fetchChannelConnections('proj_1', 'slack');

      expect(mockApiFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj_1/channel-connections?channel_type=slack',
        expect.any(Object),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Channel OAuth (from api/channel-oauth.ts)
  // -----------------------------------------------------------------------

  describe('initiateChannelOAuth', () => {
    it('POSTs to channel-oauth authorize endpoint', async () => {
      mockApiFetch.mockResolvedValue(new Response());
      mockHandleResponse.mockResolvedValue({
        success: true,
        authUrl: 'https://slack.com/oauth',
        state: 'state_1',
      });

      await connectionsApi.initiateChannelOAuth(
        'slack',
        'proj_1',
        'http://localhost:5173/callback',
      );

      expect(mockApiFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/v1/channel-oauth/slack/authorize',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            redirectUri: 'http://localhost:5173/callback',
            projectId: 'proj_1',
          }),
        }),
      );
    });
  });

  describe('exchangeChannelOAuthCode', () => {
    it('calls callback endpoint with code and state', async () => {
      mockApiFetch.mockResolvedValue(new Response());
      mockHandleResponse.mockResolvedValue({
        success: true,
        channelType: 'slack',
        credentials: {},
        externalIdentifier: 'T01234',
        displayName: 'Workspace',
        metadata: {},
        projectId: 'proj_1',
      });

      await connectionsApi.exchangeChannelOAuthCode('slack', 'code_1', 'state_1');

      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/channel-oauth/slack/callback?code=code_1&state=state_1'),
      );
    });
  });
});
```

#### 4b. Implement the API layer

```typescript
// src/features/connections/connections.api.ts

/**
 * Unified Connections API Layer
 *
 * Absorbs four API modules into one namespace:
 *   - api/connections.ts     (8 functions — project connector instances)
 *   - api/channels.ts        (4 functions — SDK channels)
 *   - api/channel-connections.ts (5 functions — messaging/voice channel connections)
 *   - api/channel-oauth.ts   (2 functions — channel OAuth flows)
 *
 * All functions use validated fetch with Zod parsing on responses.
 */

import { apiFetch, handleResponse } from '@/lib/api-client';
import { getRuntimeUrl } from '@/config/runtime';
import {
  ConnectionListResponseSchema,
  ConnectionDetailResponseSchema,
  ConnectorListResponseSchema,
  ChannelConnectionListResponseSchema,
  SDKChannelListResponseSchema,
  ChannelOAuthAuthorizeSchema,
  ChannelOAuthCallbackSchema,
  ChannelConnectionSummarySchema,
  SDKChannelSchema,
  ConnectionSummarySchema,
} from './connections.contract';
import type {
  ConnectionSummary,
  ConnectionDetail,
  ConnectorSummary,
  ChannelConnectionSummary,
  SDKChannel,
  ChannelOAuthAuthorizeResponse,
  ChannelOAuthCallbackResult,
  CreateConnectionInput,
  UpdateConnectionInput,
  CreateChannelConnectionInput,
  UpdateChannelConnectionInput,
} from './connections.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectUrl(projectId: string, path = ''): string {
  return `/api/projects/${encodeURIComponent(projectId)}${path}`;
}

function runtimeProjectUrl(projectId: string, path = ''): string {
  return `${getRuntimeUrl()}/api/projects/${projectId}${path}`;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

// ---------------------------------------------------------------------------
// Unified API namespace
// ---------------------------------------------------------------------------

export const connectionsApi = {
  // =========================================================================
  // Project connections (was api/connections.ts)
  // =========================================================================

  async listConnections(
    projectId: string,
  ): Promise<{ success: boolean; data: ConnectionSummary[] }> {
    const response = await apiFetch(projectUrl(projectId, '/connections'));
    return handleResponse(response);
  },

  async getConnection(
    projectId: string,
    connectionId: string,
  ): Promise<{ success: boolean; data: ConnectionDetail }> {
    const response = await apiFetch(
      projectUrl(projectId, `/connections/${encodeURIComponent(connectionId)}`),
    );
    return handleResponse(response);
  },

  async createConnection(
    projectId: string,
    data: CreateConnectionInput,
  ): Promise<{ success: boolean; data: ConnectionSummary }> {
    const response = await apiFetch(projectUrl(projectId, '/connections'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async updateConnection(
    projectId: string,
    connectionId: string,
    data: UpdateConnectionInput,
  ): Promise<{ success: boolean; data: ConnectionSummary }> {
    const response = await apiFetch(
      projectUrl(projectId, `/connections/${encodeURIComponent(connectionId)}`),
      {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(data),
      },
    );
    return handleResponse(response);
  },

  async deleteConnection(projectId: string, connectionId: string): Promise<{ success: boolean }> {
    const response = await apiFetch(
      projectUrl(projectId, `/connections/${encodeURIComponent(connectionId)}`),
      { method: 'DELETE' },
    );
    return handleResponse(response);
  },

  async testConnection(
    projectId: string,
    connectionId: string,
  ): Promise<{ success: boolean; data?: { message?: string } }> {
    const response = await apiFetch(
      projectUrl(projectId, `/connections/${encodeURIComponent(connectionId)}/test`),
      { method: 'POST' },
    );
    return handleResponse(response);
  },

  async handleOAuthCallback(
    projectId: string,
    params: { code: string; state: string },
  ): Promise<{ success: boolean; data: ConnectionSummary }> {
    const response = await apiFetch(projectUrl(projectId, '/connections/oauth/callback'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(params),
    });
    return handleResponse(response);
  },

  // =========================================================================
  // Connector catalog
  // =========================================================================

  async listConnectors(projectId: string): Promise<{ success: boolean; data: ConnectorSummary[] }> {
    const response = await apiFetch(projectUrl(projectId, '/connectors'));
    return handleResponse(response);
  },

  // =========================================================================
  // SDK Channels (was api/channels.ts)
  // =========================================================================

  async fetchChannels(projectId: string): Promise<{ success: boolean; channels: SDKChannel[] }> {
    const response = await apiFetch(runtimeProjectUrl(projectId, '/sdk-channels'), {
      headers: JSON_HEADERS,
    });
    return handleResponse(response);
  },

  async createChannel(
    projectId: string,
    data: {
      name: string;
      channelType: string;
      publicApiKeyId: string;
      deploymentId?: string;
      config?: Record<string, unknown>;
      environment?: string | null;
      followEnvironment?: boolean;
    },
  ): Promise<{ success: boolean; channel: SDKChannel }> {
    const response = await apiFetch(runtimeProjectUrl(projectId, '/sdk-channels'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async updateChannel(
    projectId: string,
    channelId: string,
    data: {
      name?: string;
      deploymentId?: string | null;
      config?: Record<string, unknown>;
      isActive?: boolean;
      environment?: string | null;
      followEnvironment?: boolean;
    },
  ): Promise<{ success: boolean; channel: SDKChannel }> {
    const response = await apiFetch(runtimeProjectUrl(projectId, `/sdk-channels/${channelId}`), {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async deleteChannel(projectId: string, channelId: string): Promise<{ success: boolean }> {
    const response = await apiFetch(runtimeProjectUrl(projectId, `/sdk-channels/${channelId}`), {
      method: 'DELETE',
      headers: JSON_HEADERS,
    });
    return handleResponse(response);
  },

  // =========================================================================
  // Channel Connections (was api/channel-connections.ts)
  // =========================================================================

  async fetchChannelConnections(
    projectId: string,
    channelType?: string,
  ): Promise<{ connections: ChannelConnectionSummary[] }> {
    let url = runtimeProjectUrl(projectId, '/channel-connections');
    if (channelType) url += `?channel_type=${channelType}`;
    const response = await apiFetch(url, { headers: JSON_HEADERS });
    const raw = await response.json();
    return raw as { connections: ChannelConnectionSummary[] };
  },

  async fetchChannelConnection(
    projectId: string,
    id: string,
  ): Promise<{ connection: ChannelConnectionSummary }> {
    const response = await apiFetch(runtimeProjectUrl(projectId, `/channel-connections/${id}`), {
      headers: JSON_HEADERS,
    });
    const raw = await response.json();
    return raw as { connection: ChannelConnectionSummary };
  },

  async createChannelConnection(
    projectId: string,
    data: CreateChannelConnectionInput,
  ): Promise<{ connection: ChannelConnectionSummary }> {
    const response = await apiFetch(runtimeProjectUrl(projectId, '/channel-connections'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    });
    const raw = await response.json();
    return raw as { connection: ChannelConnectionSummary };
  },

  async updateChannelConnection(
    projectId: string,
    id: string,
    data: UpdateChannelConnectionInput,
  ): Promise<{ connection: ChannelConnectionSummary }> {
    const response = await apiFetch(runtimeProjectUrl(projectId, `/channel-connections/${id}`), {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    });
    const raw = await response.json();
    return raw as { connection: ChannelConnectionSummary };
  },

  async deleteChannelConnection(projectId: string, id: string): Promise<{ success: boolean }> {
    const response = await apiFetch(runtimeProjectUrl(projectId, `/channel-connections/${id}`), {
      method: 'DELETE',
      headers: JSON_HEADERS,
    });
    const raw = await response.json();
    return raw as { success: boolean };
  },

  // =========================================================================
  // Channel OAuth (was api/channel-oauth.ts)
  // =========================================================================

  async initiateChannelOAuth(
    channelType: string,
    projectId: string,
    redirectUri: string,
  ): Promise<ChannelOAuthAuthorizeResponse> {
    const response = await apiFetch(
      `${getRuntimeUrl()}/api/v1/channel-oauth/${channelType}/authorize`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ redirectUri, projectId }),
      },
    );
    const raw = await response.json();
    return raw as ChannelOAuthAuthorizeResponse;
  },

  async exchangeChannelOAuthCode(
    channelType: string,
    code: string,
    state: string,
  ): Promise<ChannelOAuthCallbackResult> {
    const response = await apiFetch(
      `${getRuntimeUrl()}/api/v1/channel-oauth/${channelType}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    );
    const raw = await response.json();
    return raw as ChannelOAuthCallbackResult;
  },
} as const;
```

#### 4c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/connections/__tests__/connections.api.test.ts
npx prettier --write src/features/connections/connections.api.ts src/features/connections/__tests__/connections.api.test.ts
git add src/features/connections/connections.api.ts src/features/connections/__tests__/connections.api.test.ts
git commit -m "[ABLP-2] feat(studio): add unified connections API layer absorbing 4 modules"
```

---

### Task 5: Connections Fixtures

#### 5a. Create golden test data

```jsonc
// src/features/connections/__fixtures__/connection-summary.json
[
  {
    "id": "conn_slack_001",
    "connectorName": "slack",
    "displayName": "Engineering Slack",
    "scope": "tenant",
    "authType": "oauth2",
    "status": "active",
    "hasCredentials": true,
    "createdAt": "2026-01-15T10:00:00.000Z",
    "updatedAt": "2026-02-01T14:30:00.000Z",
    "expiresAt": "2026-07-15T10:00:00.000Z",
    "category": "messaging",
  },
  {
    "id": "conn_jira_002",
    "connectorName": "jira",
    "displayName": "Jira Cloud",
    "scope": "user",
    "authType": "api_key",
    "status": "active",
    "hasCredentials": true,
    "createdAt": "2026-01-20T08:00:00.000Z",
    "updatedAt": "2026-01-20T08:00:00.000Z",
    "category": "tool",
  },
  {
    "id": "conn_expired_003",
    "connectorName": "salesforce",
    "displayName": "SF Sandbox",
    "scope": "tenant",
    "authType": "oauth2",
    "status": "expired",
    "hasCredentials": true,
    "createdAt": "2025-12-01T00:00:00.000Z",
    "updatedAt": "2026-03-01T00:00:00.000Z",
    "expiresAt": "2026-02-28T00:00:00.000Z",
  },
]
```

```jsonc
// src/features/connections/__fixtures__/connection-detail.json
{
  "id": "conn_slack_001",
  "connectorName": "slack",
  "displayName": "Engineering Slack",
  "scope": "tenant",
  "authType": "oauth2",
  "status": "active",
  "hasCredentials": true,
  "createdAt": "2026-01-15T10:00:00.000Z",
  "updatedAt": "2026-02-01T14:30:00.000Z",
  "expiresAt": "2026-07-15T10:00:00.000Z",
  "category": "messaging",
  "metadata": {
    "workspace": "T01234ABC",
    "team_name": "Engineering",
    "bot_user_id": "U01234BOT",
  },
}
```

```jsonc
// src/features/connections/__fixtures__/connector-catalog.json
[
  {
    "name": "slack",
    "displayName": "Slack",
    "description": "Connect to Slack workspaces for messaging and notifications",
    "category": "messaging",
    "authType": "oauth2",
    "triggers": [
      {
        "name": "message_received",
        "displayName": "Message Received",
        "description": "Triggered when a new message is posted",
      },
    ],
    "actions": [
      {
        "name": "send_message",
        "displayName": "Send Message",
        "description": "Send a message to a Slack channel",
      },
      { "name": "create_channel", "displayName": "Create Channel" },
    ],
    "oauth2": {
      "authorizationUrl": "https://slack.com/oauth/v2/authorize",
      "tokenUrl": "https://slack.com/api/oauth.v2.access",
      "defaultScopes": ["chat:write", "channels:read"],
      "scopeSeparator": ",",
      "pkce": false,
    },
  },
  {
    "name": "jira",
    "displayName": "Jira",
    "description": "Connect to Jira for issue tracking",
    "category": "project_management",
    "authType": "api_key",
    "actions": [
      { "name": "create_issue", "displayName": "Create Issue" },
      { "name": "update_issue", "displayName": "Update Issue" },
    ],
  },
  {
    "name": "custom_http",
    "displayName": "Custom HTTP",
    "description": "Generic HTTP connector for custom APIs",
    "category": "custom",
    "authType": "bearer",
  },
]
```

```jsonc
// src/features/connections/__fixtures__/channel-connection.json
[
  {
    "id": "chconn_slack_001",
    "projectId": "proj_1",
    "channelType": "slack",
    "displayName": "Eng Support Bot",
    "externalIdentifier": "T01234ABC",
    "hasCredentials": true,
    "config": { "default_channel": "#support" },
    "status": "active",
    "deploymentId": "dep_prod_1",
    "environment": "production",
    "webhookUrl": "https://runtime.example.com/webhooks/slack/chconn_slack_001",
    "createdAt": "2026-01-15T10:00:00.000Z",
    "updatedAt": "2026-02-01T14:30:00.000Z",
  },
  {
    "id": "chconn_teams_002",
    "projectId": "proj_1",
    "channelType": "msteams",
    "displayName": null,
    "externalIdentifier": "teams-tenant-id",
    "hasCredentials": true,
    "config": {},
    "status": "active",
    "deploymentId": null,
    "environment": null,
    "webhookUrl": null,
    "createdAt": "2026-02-10T08:00:00.000Z",
    "updatedAt": "2026-02-10T08:00:00.000Z",
  },
]
```

```jsonc
// src/features/connections/__fixtures__/channel-oauth.json
{
  "authorize": {
    "success": true,
    "authUrl": "https://slack.com/oauth/v2/authorize?client_id=xxx&scope=chat:write&state=state_abc",
    "state": "state_abc",
  },
  "callback": {
    "success": true,
    "channelType": "slack",
    "credentials": { "bot_token": "xoxb-test-token", "access_token": "xoxp-test-token" },
    "externalIdentifier": "T01234ABC",
    "displayName": "Engineering Workspace",
    "metadata": { "team_id": "T01234ABC", "team_name": "Engineering" },
    "projectId": "proj_1",
  },
}
```

#### 5b. Verify fixtures parse against schemas

```typescript
// Add to src/features/connections/__tests__/connections.contract.test.ts (append)

import connectionSummaryFixture from '../__fixtures__/connection-summary.json';
import connectionDetailFixture from '../__fixtures__/connection-detail.json';
import connectorCatalogFixture from '../__fixtures__/connector-catalog.json';
import channelConnectionFixture from '../__fixtures__/channel-connection.json';
import channelOAuthFixture from '../__fixtures__/channel-oauth.json';

describe('fixtures validate against schemas', () => {
  it('connection-summary.json', () => {
    for (const item of connectionSummaryFixture) {
      expect(() => ConnectionSummarySchema.parse(item)).not.toThrow();
    }
  });

  it('connection-detail.json', () => {
    expect(() => ConnectionDetailSchema.parse(connectionDetailFixture)).not.toThrow();
  });

  it('connector-catalog.json', () => {
    for (const item of connectorCatalogFixture) {
      expect(() => ConnectorSummarySchema.parse(item)).not.toThrow();
    }
  });

  it('channel-connection.json', () => {
    for (const item of channelConnectionFixture) {
      expect(() => ChannelConnectionSummarySchema.parse(item)).not.toThrow();
    }
  });

  it('channel-oauth authorize', () => {
    expect(() => ChannelOAuthAuthorizeSchema.parse(channelOAuthFixture.authorize)).not.toThrow();
  });

  it('channel-oauth callback', () => {
    expect(() => ChannelOAuthCallbackSchema.parse(channelOAuthFixture.callback)).not.toThrow();
  });
});
```

#### 5c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/connections/__tests__/connections.contract.test.ts
npx prettier --write "src/features/connections/__fixtures__/*.json" "src/features/connections/__tests__/connections.contract.test.ts"
git add src/features/connections/__fixtures__/ src/features/connections/__tests__/connections.contract.test.ts
git commit -m "[ABLP-2] test(studio): add connections golden fixtures with schema validation"
```

---

### Task 6: Connections Barrel Exports

#### 6a. Write the barrel

```typescript
// src/features/connections/index.ts

/**
 * Connections Feature Module
 *
 * Unified API for project connectors, SDK channels, channel connections,
 * and channel OAuth flows.
 */

// Contracts (Zod schemas)
export {
  ConnectionSummarySchema,
  ConnectionDetailSchema,
  ConnectorSummarySchema,
  ChannelConnectionSummarySchema,
  SDKChannelSchema,
  ChannelOAuthAuthorizeSchema,
  ChannelOAuthCallbackSchema,
  ConnectionScopeSchema,
  ConnectionAuthTypeSchema,
  ConnectionStatusSchema,
  ConnectionCategorySchema,
  ConnectionSummaryRawSchema,
  ConnectionListResponseSchema,
  ConnectionDetailResponseSchema,
  ConnectorListResponseSchema,
  ChannelConnectionListResponseSchema,
  SDKChannelListResponseSchema,
  SDKChannelTypeSchema,
} from './connections.contract';

// Types
export type {
  ConnectionSummary,
  ConnectionDetail,
  ConnectorSummary,
  ChannelConnectionSummary,
  SDKChannel,
  ChannelOAuthAuthorizeResponse,
  ChannelOAuthCallbackResult,
  ConnectionSummaryRaw,
  ConnectionScope,
  ConnectionAuthType,
  ConnectionStatus,
  ConnectionCategory,
  ConnectionTestResult,
  ConnectionsLoadingState,
  ConnectionsErrorState,
  CreateConnectionInput,
  UpdateConnectionInput,
  CreateChannelConnectionInput,
  UpdateChannelConnectionInput,
} from './connections.types';

// Store
export { useConnectionsStore } from './connections.store';

// API
export { connectionsApi } from './connections.api';
```

#### 6b. Verify & commit

```bash
npx prettier --write apps/studio/src/features/connections/index.ts
pnpm build --filter=studio 2>&1 | tail -5
git add apps/studio/src/features/connections/index.ts
git commit -m "[ABLP-2] feat(studio): add connections feature barrel exports"
```

---

### Task 7: Connections Integration (Bridge to Legacy)

This task re-exports the new module from the old API locations so existing consumers migrate incrementally.

#### 7a. Write the test

```typescript
// src/features/connections/__tests__/connections.integration.test.ts

import { describe, it, expect } from 'vitest';

describe('connections barrel re-exports', () => {
  it('re-exports ConnectionSummary type from feature module', async () => {
    const mod = await import('@/features/connections');
    expect(mod.ConnectionSummarySchema).toBeDefined();
    expect(mod.connectionsApi).toBeDefined();
    expect(mod.useConnectionsStore).toBeDefined();
  });

  it('connectionsApi has all expected methods', async () => {
    const { connectionsApi } = await import('@/features/connections');
    // Project connections (8)
    expect(connectionsApi.listConnections).toBeTypeOf('function');
    expect(connectionsApi.getConnection).toBeTypeOf('function');
    expect(connectionsApi.createConnection).toBeTypeOf('function');
    expect(connectionsApi.updateConnection).toBeTypeOf('function');
    expect(connectionsApi.deleteConnection).toBeTypeOf('function');
    expect(connectionsApi.testConnection).toBeTypeOf('function');
    expect(connectionsApi.handleOAuthCallback).toBeTypeOf('function');
    expect(connectionsApi.listConnectors).toBeTypeOf('function');
    // SDK channels (4)
    expect(connectionsApi.fetchChannels).toBeTypeOf('function');
    expect(connectionsApi.createChannel).toBeTypeOf('function');
    expect(connectionsApi.updateChannel).toBeTypeOf('function');
    expect(connectionsApi.deleteChannel).toBeTypeOf('function');
    // Channel connections (5)
    expect(connectionsApi.fetchChannelConnections).toBeTypeOf('function');
    expect(connectionsApi.fetchChannelConnection).toBeTypeOf('function');
    expect(connectionsApi.createChannelConnection).toBeTypeOf('function');
    expect(connectionsApi.updateChannelConnection).toBeTypeOf('function');
    expect(connectionsApi.deleteChannelConnection).toBeTypeOf('function');
    // Channel OAuth (2)
    expect(connectionsApi.initiateChannelOAuth).toBeTypeOf('function');
    expect(connectionsApi.exchangeChannelOAuthCode).toBeTypeOf('function');
  });
});
```

#### 7b. Hook migration guide

Existing hooks (`useConnections`, `useAvailableConnectors`) continue to work as-is during migration. New code should import from the feature module:

```typescript
// BEFORE (old path — still works during transition):
import { useConnections } from '@/hooks/useConnections';
import { useAvailableConnectors } from '@/hooks/useAvailableConnectors';

// AFTER (new path — preferred):
import { useConnectionsStore, connectionsApi } from '@/features/connections';
import type { ConnectionSummary, ConnectorSummary } from '@/features/connections';
```

Components in `src/components/connections/` (11 files) consume the hooks. Migration order:

1. `ConnectionsPage.tsx` — top-level, uses both hooks
2. `ConnectionCard.tsx` — uses `ConnectionSummary` type
3. `CatalogCard.tsx` — uses `ConnectorSummary` type
4. `ConnectionExpandPanel.tsx` — uses `ConnectionDetail` + test action
5. `CreateConnectionModal.tsx` — uses `createConnection` API
6. `OAuthFlowDialog.tsx` — uses OAuth API
7. `ConnectionStatusBar.tsx` — pure presentational (type-only change)
8. `ConnectorLogo.tsx` — pure presentational (no change needed)
9. `connector-categories.ts` — utility (no change needed)
10. `agent-desktop-registry.ts` — utility (no change needed)

Each component migration is a separate PR to keep diffs small.

#### 7c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/connections/__tests__/connections.integration.test.ts
npx prettier --write src/features/connections/__tests__/connections.integration.test.ts
git add src/features/connections/__tests__/connections.integration.test.ts
git commit -m "[ABLP-2] test(studio): add connections integration tests and migration guide"
```

---

## Chunk 2: Agent Detail Feature Module (Tasks 8–15)

---

### Task 8: Agent Detail Contract Schemas

**TDD: Write test → see it fail → implement → pass → commit**

#### 8a. Write the test

```typescript
// src/features/agent-detail/__tests__/agent-detail.contract.test.ts

import { describe, it, expect } from 'vitest';
import {
  IdentitySectionSchema,
  ToolParameterSchema,
  ToolSectionSchema,
  GatherFieldSchema,
  FlowStepSchema,
  FlowSectionSchema,
  RulesSectionSchema,
  ConstraintSchema,
  GuardrailSchema,
  CoordinationSectionSchema,
  DelegateSchema,
  HandoffSchema,
  EscalationSectionSchema,
  BehaviorSectionSchema,
  BehaviorProfileRefSchema,
  LifecycleSectionSchema,
  ErrorHandlerSchema,
  CompletionConditionSchema,
  MemoryConfigSchema,
  SectionModelsSchema,
  AgentDetailsSchema,
  CompilationResponseSchema,
} from '../agent-detail.contract';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
describe('IdentitySectionSchema', () => {
  it('accepts minimal identity', () => {
    const data = { goal: 'Help users', persona: '', limitations: [] };
    expect(IdentitySectionSchema.parse(data)).toMatchObject({ goal: 'Help users' });
  });

  it('accepts full identity with model config', () => {
    const data = {
      mode: 'reasoning',
      goal: 'Help users',
      persona: 'Friendly assistant',
      limitations: ['No PII', 'No medical advice'],
      model: 'gpt-4o',
      temperature: 0.7,
      maxTokens: 4096,
      enableThinking: true,
    };
    expect(IdentitySectionSchema.parse(data)).toEqual(data);
  });

  it('accepts enableThinking as null (inherit from project)', () => {
    const data = { goal: '', persona: '', limitations: [], enableThinking: null };
    expect(IdentitySectionSchema.parse(data).enableThinking).toBeNull();
  });

  it('rejects missing goal', () => {
    expect(() => IdentitySectionSchema.parse({ persona: '', limitations: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
describe('ToolSectionSchema', () => {
  const minimal = {
    name: 'lookup_order',
    description: 'Look up an order',
    parameters: [],
    returns: { type: 'object' },
    hints: {},
  };

  it('accepts minimal tool', () => {
    expect(ToolSectionSchema.parse(minimal)).toMatchObject({ name: 'lookup_order' });
  });

  it('accepts tool with http binding', () => {
    const tool = {
      ...minimal,
      toolType: 'http',
      httpBinding: { endpoint: 'https://api.example.com/orders', method: 'GET' },
    };
    expect(ToolSectionSchema.parse(tool).httpBinding?.endpoint).toBe(
      'https://api.example.com/orders',
    );
  });

  it('accepts tool with mcp binding', () => {
    const tool = {
      ...minimal,
      toolType: 'mcp',
      mcpBinding: { server: 'my-server', tool: 'lookup' },
    };
    expect(ToolSectionSchema.parse(tool).mcpBinding?.server).toBe('my-server');
  });

  it('accepts tool with sandbox binding', () => {
    const tool = {
      ...minimal,
      toolType: 'sandbox',
      sandboxBinding: {
        runtime: 'python3',
        codePreview: 'print("hello")',
        timeoutMs: 5000,
        memoryMb: 128,
      },
    };
    expect(ToolSectionSchema.parse(tool).sandboxBinding?.runtime).toBe('python3');
  });

  it('accepts tool with confirmation config', () => {
    const tool = {
      ...minimal,
      confirmation: { require: 'always', immutableParams: ['orderId'] },
    };
    expect(ToolSectionSchema.parse(tool).confirmation?.require).toBe('always');
  });

  it('accepts tool with piiAccess', () => {
    const tool = { ...minimal, piiAccess: 'tools' };
    expect(ToolSectionSchema.parse(tool).piiAccess).toBe('tools');
  });

  it('rejects invalid toolType', () => {
    expect(() => ToolSectionSchema.parse({ ...minimal, toolType: 'grpc' })).toThrow();
  });

  it('rejects invalid confirmation require value', () => {
    expect(() =>
      ToolSectionSchema.parse({ ...minimal, confirmation: { require: 'sometimes' } }),
    ).toThrow();
  });
});

describe('ToolParameterSchema', () => {
  it('accepts required parameter', () => {
    const param = { name: 'orderId', type: 'string', required: true };
    expect(ToolParameterSchema.parse(param)).toMatchObject({ name: 'orderId' });
  });

  it('accepts parameter with default value', () => {
    const param = { name: 'limit', type: 'number', required: false, defaultValue: 10 };
    expect(ToolParameterSchema.parse(param).defaultValue).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Gather
// ---------------------------------------------------------------------------
describe('GatherFieldSchema', () => {
  const minimal = { name: 'email', prompt: 'What is your email?', type: 'string', required: true };

  it('accepts minimal gather field', () => {
    expect(GatherFieldSchema.parse(minimal)).toMatchObject({ name: 'email' });
  });

  it('accepts field with validation', () => {
    const field = {
      ...minimal,
      validation: { type: 'regex', rule: '^.+@.+$', errorMessage: 'Invalid email' },
    };
    expect(GatherFieldSchema.parse(field).validation?.type).toBe('regex');
  });

  it('accepts field with PII sensitivity config', () => {
    const field = {
      ...minimal,
      sensitive: true,
      sensitiveDisplay: 'mask',
      maskConfig: { showFirst: 2, showLast: 4, char: '*' },
      transient: true,
    };
    expect(GatherFieldSchema.parse(field).sensitive).toBe(true);
  });

  it('accepts field with extraction pattern', () => {
    const field = { ...minimal, extractionPattern: '\\d{3}-\\d{4}', extractionGroup: 0 };
    expect(GatherFieldSchema.parse(field).extractionPattern).toBe('\\d{3}-\\d{4}');
  });

  it('rejects invalid sensitiveDisplay', () => {
    expect(() => GatherFieldSchema.parse({ ...minimal, sensitiveDisplay: 'encrypt' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------
describe('FlowStepSchema', () => {
  it('accepts minimal flow step', () => {
    const step = { name: 'greet', hasGather: false, hasBranching: false, reasoning: false };
    expect(FlowStepSchema.parse(step)).toMatchObject({ name: 'greet' });
  });

  it('accepts reasoning step with full config', () => {
    const step = {
      name: 'analyze',
      hasGather: false,
      hasBranching: false,
      reasoning: true,
      goal: 'Analyze the user request',
      exitWhen: 'analysis_complete',
      maxTurns: 5,
      availableTools: ['search', 'lookup'],
    };
    expect(FlowStepSchema.parse(step).maxTurns).toBe(5);
  });
});

describe('FlowSectionSchema', () => {
  it('accepts flow with steps and entry point', () => {
    const flow = {
      steps: [
        { name: 'greet', hasGather: false, hasBranching: false, reasoning: false },
        { name: 'process', hasGather: true, hasBranching: true, reasoning: false },
      ],
      entryPoint: 'greet',
    };
    expect(FlowSectionSchema.parse(flow).steps).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
describe('ConstraintSchema', () => {
  it('accepts constraint with on_fail respond', () => {
    const c = { condition: 'age >= 18', onFail: { type: 'respond', message: 'Must be 18+' } };
    expect(ConstraintSchema.parse(c)).toMatchObject({ condition: 'age >= 18' });
  });
});

describe('GuardrailSchema', () => {
  it('accepts full guardrail', () => {
    const g = {
      name: 'pii-filter',
      description: 'Filter PII',
      check: 'builtin:pii',
      action: { type: 'block', message: 'PII detected' },
      provider: 'builtin-pii',
      category: 'safety',
      threshold: 0.8,
      kind: 'input',
      priority: 1,
      streaming: true,
    };
    expect(GuardrailSchema.parse(g).threshold).toBe(0.8);
  });
});

describe('RulesSectionSchema', () => {
  it('accepts empty rules', () => {
    expect(RulesSectionSchema.parse({ constraints: [], guardrails: [] })).toEqual({
      constraints: [],
      guardrails: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Coordination
// ---------------------------------------------------------------------------
describe('DelegateSchema', () => {
  it('accepts delegate', () => {
    const d = { agent: 'billing-agent', when: 'billing query', purpose: 'Handle billing' };
    expect(DelegateSchema.parse(d)).toMatchObject({ agent: 'billing-agent' });
  });
});

describe('HandoffSchema', () => {
  it('accepts handoff', () => {
    const h = {
      to: 'sales-agent',
      when: 'sales query',
      summary: 'Transfer to sales',
      returnable: true,
    };
    expect(HandoffSchema.parse(h)).toMatchObject({ to: 'sales-agent' });
  });
});

describe('EscalationSectionSchema', () => {
  it('accepts empty escalation', () => {
    expect(
      EscalationSectionSchema.parse({ triggers: [], contextForHuman: [], onHumanComplete: [] }),
    ).toBeDefined();
  });

  it('accepts escalation with routing', () => {
    const esc = {
      triggers: [{ when: 'frustrated', reason: 'User upset', priority: 'high' }],
      contextForHuman: ['conversation_summary'],
      onHumanComplete: [{ condition: 'resolved', action: 'complete' }],
      routing: {
        connectionId: 'conn_123',
        queue: 'support',
        skills: ['billing'],
        priority: 1,
        postAgentAction: 'return',
      },
    };
    expect(EscalationSectionSchema.parse(esc).routing?.queue).toBe('support');
  });

  it('accepts escalation routing with voice config', () => {
    const esc = {
      triggers: [],
      contextForHuman: [],
      onHumanComplete: [],
      routing: {
        connectionId: 'conn_456',
        postAgentAction: 'end',
        voice: {
          transferMethod: 'refer',
          sipHeaders: { 'X-Custom': 'value' },
        },
      },
    };
    expect(EscalationSectionSchema.parse(esc).routing?.voice?.transferMethod).toBe('refer');
  });
});

describe('CoordinationSectionSchema', () => {
  it('accepts full coordination', () => {
    const coord = {
      delegates: [{ agent: 'helper', when: 'need help', purpose: 'Assist' }],
      handoffs: [{ to: 'closer', when: 'done', summary: 'Closing', returnable: false }],
      escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
    };
    expect(CoordinationSectionSchema.parse(coord).delegates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------
describe('BehaviorProfileRefSchema', () => {
  it('accepts behavior profile', () => {
    const p = {
      name: 'formal',
      priority: 1,
      whenSummary: 'business context',
      overrideCategories: ['instructions', 'voice'],
    };
    expect(BehaviorProfileRefSchema.parse(p)).toMatchObject({ name: 'formal' });
  });
});

describe('BehaviorSectionSchema', () => {
  it('accepts empty profiles', () => {
    expect(BehaviorSectionSchema.parse({ profiles: [] })).toEqual({ profiles: [] });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
describe('ErrorHandlerSchema', () => {
  it('accepts error handler', () => {
    const h = { type: 'tool_error', respond: 'Sorry, try again', then: 'retry' };
    expect(ErrorHandlerSchema.parse(h)).toMatchObject({ type: 'tool_error' });
  });
});

describe('CompletionConditionSchema', () => {
  it('accepts completion condition', () => {
    const c = { when: 'all_fields_gathered', respond: 'Thank you!' };
    expect(CompletionConditionSchema.parse(c)).toMatchObject({ when: 'all_fields_gathered' });
  });
});

describe('MemoryConfigSchema', () => {
  it('accepts memory config', () => {
    const m = {
      sessionVars: ['userId'],
      persistentPaths: ['user.preferences'],
      rememberTriggers: 2,
      recallInstructions: 1,
    };
    expect(MemoryConfigSchema.parse(m)).toMatchObject({ sessionVars: ['userId'] });
  });
});

describe('LifecycleSectionSchema', () => {
  it('accepts full lifecycle', () => {
    const lc = {
      hasOnStart: true,
      onStartRespond: 'Welcome!',
      onStartCall: 'init_tool',
      hasHooks: true,
      hooks: ['before_agent', 'after_turn'],
      errorHandlers: [{ type: 'tool_error', then: 'continue' }],
      completionConditions: [{ when: 'goal_met' }],
      memoryConfig: {
        sessionVars: [],
        persistentPaths: [],
        rememberTriggers: 0,
        recallInstructions: 0,
      },
    };
    expect(LifecycleSectionSchema.parse(lc).hasOnStart).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Composite schemas
// ---------------------------------------------------------------------------
describe('SectionModelsSchema', () => {
  const emptySections = {
    identity: { goal: '', persona: '', limitations: [] },
    tools: [],
    gather: [],
    flow: null,
    rules: { constraints: [], guardrails: [] },
    coordination: {
      delegates: [],
      handoffs: [],
      escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
    },
    behavior: { profiles: [] },
    lifecycle: {
      hasOnStart: false,
      hasHooks: false,
      hooks: [],
      errorHandlers: [],
      completionConditions: [],
      memoryConfig: {
        sessionVars: [],
        persistentPaths: [],
        rememberTriggers: 0,
        recallInstructions: 0,
      },
    },
  };

  it('accepts empty section models', () => {
    expect(SectionModelsSchema.parse(emptySections)).toBeDefined();
  });

  it('accepts section models with flow', () => {
    const withFlow = {
      ...emptySections,
      flow: {
        steps: [{ name: 'start', hasGather: false, hasBranching: false, reasoning: false }],
        entryPoint: 'start',
      },
    };
    expect(SectionModelsSchema.parse(withFlow).flow).not.toBeNull();
  });
});

describe('AgentDetailsSchema', () => {
  it('accepts full agent details', () => {
    const agent = {
      id: 'agent_123',
      name: 'support-agent',
      filePath: 'agents/support.abl',
      type: 'agent',
      mode: 'reasoning',
      toolCount: 5,
      gatherFieldCount: 3,
      isSupervisor: false,
      dsl: 'AGENT support-agent\nGOAL: Help users',
      ir: {},
      errors: [],
    };
    expect(AgentDetailsSchema.parse(agent)).toMatchObject({ id: 'agent_123' });
  });

  it('accepts supervisor agent', () => {
    const agent = {
      id: 'agent_456',
      name: 'supervisor',
      type: 'supervisor',
      mode: 'reasoning',
      toolCount: 0,
      gatherFieldCount: 0,
      isSupervisor: true,
      dsl: 'AGENT supervisor\nSUPERVISOR: true',
    };
    expect(AgentDetailsSchema.parse(agent).isSupervisor).toBe(true);
  });

  it('rejects invalid type', () => {
    expect(() =>
      AgentDetailsSchema.parse({
        id: 'x',
        name: 'x',
        type: 'workflow',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: '',
      }),
    ).toThrow();
  });
});

describe('CompilationResponseSchema', () => {
  it('accepts successful compilation', () => {
    const resp = { success: true, ir: { identity: { goal: 'test' } } };
    expect(CompilationResponseSchema.parse(resp).success).toBe(true);
  });

  it('accepts failed compilation', () => {
    const resp = { success: false, errors: ['Syntax error at line 5'] };
    expect(CompilationResponseSchema.parse(resp).errors).toHaveLength(1);
  });
});
```

#### 8b. Implement the contract

```typescript
// src/features/agent-detail/agent-detail.contract.ts

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Identity section
// ---------------------------------------------------------------------------

export const IdentitySectionSchema = z.object({
  /** @deprecated MODE removed in unified agent type. Derive from flow presence. */
  mode: z.string().optional(),
  goal: z.string(),
  persona: z.string(),
  limitations: z.array(z.string()),
  model: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  /** null = inherit from project, true = enabled, false = disabled */
  enableThinking: z.boolean().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Tools section
// ---------------------------------------------------------------------------

export const ToolParameterSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
  required: z.boolean(),
  defaultValue: z.unknown().optional(),
});

export const ToolSectionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.array(ToolParameterSchema),
  returns: z.object({ type: z.string() }),
  toolType: z.enum(['http', 'mcp', 'lambda', 'sandbox']).optional(),
  httpBinding: z
    .object({
      endpoint: z.string(),
      method: z.string(),
    })
    .optional(),
  mcpBinding: z
    .object({
      server: z.string(),
      tool: z.string(),
    })
    .optional(),
  sandboxBinding: z
    .object({
      runtime: z.string(),
      codePreview: z.string(),
      timeoutMs: z.number().optional(),
      memoryMb: z.number().optional(),
    })
    .optional(),
  hints: z.record(z.unknown()),
  confirmation: z
    .object({
      require: z.enum(['always', 'never', 'when_side_effects']),
      immutableParams: z.array(z.string()).optional(),
    })
    .optional(),
  piiAccess: z.enum(['tools', 'user', 'logs', 'llm']).optional(),
});

// ---------------------------------------------------------------------------
// Gather section
// ---------------------------------------------------------------------------

export const GatherFieldSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  type: z.string(),
  required: z.boolean(),
  defaultValue: z.unknown().optional(),
  validation: z
    .object({
      type: z.string(),
      rule: z.string(),
      errorMessage: z.string(),
    })
    .optional(),
  extractionHints: z.array(z.string()).optional(),
  infer: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  sensitiveDisplay: z.enum(['redact', 'mask', 'replace']).optional(),
  maskConfig: z
    .object({
      showFirst: z.number(),
      showLast: z.number(),
      char: z.string(),
    })
    .optional(),
  transient: z.boolean().optional(),
  extractionPattern: z.string().optional(),
  extractionGroup: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Flow section
// ---------------------------------------------------------------------------

export const FlowStepSchema = z.object({
  name: z.string(),
  respond: z.string().optional(),
  call: z.string().optional(),
  then: z.string().optional(),
  hasGather: z.boolean(),
  hasBranching: z.boolean(),
  reasoning: z.boolean(),
  goal: z.string().optional(),
  exitWhen: z.string().optional(),
  maxTurns: z.number().optional(),
  availableTools: z.array(z.string()).optional(),
});

export const FlowSectionSchema = z.object({
  steps: z.array(FlowStepSchema),
  entryPoint: z.string(),
});

// ---------------------------------------------------------------------------
// Rules section (constraints + guardrails)
// ---------------------------------------------------------------------------

export const ConstraintSchema = z.object({
  condition: z.string(),
  onFail: z.object({
    type: z.string(),
    message: z.string().optional(),
    target: z.string().optional(),
    reason: z.string().optional(),
  }),
});

export const GuardrailSchema = z.object({
  name: z.string(),
  description: z.string(),
  check: z.string(),
  action: z.object({
    type: z.string(),
    message: z.string().optional(),
  }),
  provider: z.string().optional(),
  category: z.string().optional(),
  threshold: z.number().optional(),
  severityActions: z.record(z.string()).optional(),
  llmCheck: z.string().optional(),
  kind: z.string().optional(),
  priority: z.number().optional(),
  streaming: z.boolean().optional(),
});

export const RulesSectionSchema = z.object({
  constraints: z.array(ConstraintSchema),
  guardrails: z.array(GuardrailSchema),
});

// ---------------------------------------------------------------------------
// Coordination section (delegates + handoffs + escalation)
// ---------------------------------------------------------------------------

export const DelegateSchema = z.object({
  agent: z.string(),
  when: z.string(),
  purpose: z.string(),
});

export const HandoffSchema = z.object({
  to: z.string(),
  when: z.string(),
  summary: z.string(),
  returnable: z.boolean(),
});

export const EscalationRoutingSchema = z.object({
  connectionId: z.string(),
  queue: z.string().optional(),
  skills: z.array(z.string()).optional(),
  priority: z.number().optional(),
  postAgentAction: z.enum(['return', 'end']),
  voice: z
    .object({
      transferMethod: z.enum(['invite', 'refer', 'bye']).optional(),
      sipHeaders: z.record(z.string()).optional(),
    })
    .optional(),
  providerConfig: z.record(z.unknown()).optional(),
});

export const EscalationSectionSchema = z.object({
  triggers: z.array(
    z.object({
      when: z.string(),
      reason: z.string(),
      priority: z.string(),
      tags: z.array(z.string()).optional(),
    }),
  ),
  contextForHuman: z.array(z.string()),
  onHumanComplete: z.array(
    z.object({
      condition: z.string(),
      action: z.string(),
    }),
  ),
  routing: EscalationRoutingSchema.optional(),
});

export const CoordinationSectionSchema = z.object({
  delegates: z.array(DelegateSchema),
  handoffs: z.array(HandoffSchema),
  escalation: EscalationSectionSchema,
});

// ---------------------------------------------------------------------------
// Behavior section
// ---------------------------------------------------------------------------

export const BehaviorProfileRefSchema = z.object({
  name: z.string(),
  priority: z.number(),
  whenSummary: z.string(),
  overrideCategories: z.array(z.string()),
});

export const BehaviorSectionSchema = z.object({
  profiles: z.array(BehaviorProfileRefSchema),
});

// ---------------------------------------------------------------------------
// Lifecycle section
// ---------------------------------------------------------------------------

export const ErrorHandlerSchema = z.object({
  type: z.string(),
  respond: z.string().optional(),
  then: z.string(),
});

export const CompletionConditionSchema = z.object({
  when: z.string(),
  respond: z.string().optional(),
});

export const MemoryConfigSchema = z.object({
  sessionVars: z.array(z.string()),
  persistentPaths: z.array(z.string()),
  rememberTriggers: z.number(),
  recallInstructions: z.number(),
});

export const LifecycleSectionSchema = z.object({
  hasOnStart: z.boolean(),
  onStartRespond: z.string().optional(),
  onStartCall: z.string().optional(),
  hasHooks: z.boolean(),
  hooks: z.array(z.string()),
  errorHandlers: z.array(ErrorHandlerSchema),
  completionConditions: z.array(CompletionConditionSchema),
  memoryConfig: MemoryConfigSchema,
});

// ---------------------------------------------------------------------------
// Composite: all section models
// ---------------------------------------------------------------------------

export const SectionModelsSchema = z.object({
  identity: IdentitySectionSchema,
  tools: z.array(ToolSectionSchema),
  gather: z.array(GatherFieldSchema),
  flow: FlowSectionSchema.nullable(),
  rules: RulesSectionSchema,
  coordination: CoordinationSectionSchema,
  behavior: BehaviorSectionSchema,
  lifecycle: LifecycleSectionSchema,
});

// ---------------------------------------------------------------------------
// Agent details (mirrors types/index.ts AgentDetails)
// ---------------------------------------------------------------------------

export const AgentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  filePath: z.string().optional(),
  type: z.enum(['agent', 'supervisor']),
  mode: z.enum(['reasoning', 'scripted']),
  toolCount: z.number(),
  gatherFieldCount: z.number(),
  isSupervisor: z.boolean(),
});

export const AgentDetailsSchema = AgentInfoSchema.extend({
  dsl: z.string(),
  ir: z.unknown().optional(),
  errors: z.array(z.string()).optional(),
  suggestedTests: z.array(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Compilation response
// ---------------------------------------------------------------------------

export const CompilationResponseSchema = z.object({
  success: z.boolean(),
  ir: z.unknown().optional(),
  errors: z.array(z.string()).optional(),
});
```

#### 8c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/agent-detail/__tests__/agent-detail.contract.test.ts
npx prettier --write src/features/agent-detail/agent-detail.contract.ts src/features/agent-detail/__tests__/agent-detail.contract.test.ts
git add src/features/agent-detail/agent-detail.contract.ts src/features/agent-detail/__tests__/agent-detail.contract.test.ts
git commit -m "[ABLP-2] feat(studio): add agent-detail contract schemas with Zod"
```

---

### Task 9: Agent Detail Types

**TDD: Write test → see it fail → implement → pass → commit**

#### 9a. Write the test

```typescript
// src/features/agent-detail/__tests__/agent-detail.types.test.ts

import { describe, it, expectTypeOf } from 'vitest';
import type {
  IdentitySection,
  ToolSection,
  ToolParameter,
  GatherField,
  FlowStep,
  FlowSection,
  RulesSection,
  Constraint,
  Guardrail,
  CoordinationSection,
  Delegate,
  Handoff,
  EscalationSection,
  EscalationRouting,
  BehaviorSection,
  BehaviorProfileRef,
  LifecycleSection,
  ErrorHandler,
  CompletionCondition,
  MemoryConfig,
  SectionModels,
  AgentInfo,
  AgentDetails,
  CompilationResponse,
  SectionId,
  SaveStatus,
  SectionKey,
} from '../agent-detail.types';

describe('agent-detail types', () => {
  it('SectionId is the correct union', () => {
    expectTypeOf<SectionId>().toEqualTypeOf<
      'IDENTITY' | 'TOOLS' | 'GATHER' | 'FLOW' | 'RULES' | 'COORDINATION' | 'BEHAVIOR' | 'LIFECYCLE'
    >();
  });

  it('SaveStatus is the correct union', () => {
    expectTypeOf<SaveStatus>().toEqualTypeOf<'idle' | 'saving' | 'saved' | 'error'>();
  });

  it('SectionKey maps SectionId to SectionModels keys', () => {
    expectTypeOf<SectionKey>().toEqualTypeOf<keyof SectionModels>();
  });

  it('IdentitySection has goal field', () => {
    expectTypeOf<IdentitySection>().toHaveProperty('goal');
  });

  it('ToolSection has name and parameters', () => {
    expectTypeOf<ToolSection>().toHaveProperty('name');
    expectTypeOf<ToolSection>().toHaveProperty('parameters');
  });

  it('SectionModels has all 8 keys', () => {
    expectTypeOf<SectionModels>().toHaveProperty('identity');
    expectTypeOf<SectionModels>().toHaveProperty('tools');
    expectTypeOf<SectionModels>().toHaveProperty('gather');
    expectTypeOf<SectionModels>().toHaveProperty('flow');
    expectTypeOf<SectionModels>().toHaveProperty('rules');
    expectTypeOf<SectionModels>().toHaveProperty('coordination');
    expectTypeOf<SectionModels>().toHaveProperty('behavior');
    expectTypeOf<SectionModels>().toHaveProperty('lifecycle');
  });

  it('AgentDetails extends AgentInfo', () => {
    expectTypeOf<AgentDetails>().toMatchTypeOf<AgentInfo>();
  });

  it('CompilationResponse has success field', () => {
    expectTypeOf<CompilationResponse>().toHaveProperty('success');
  });
});
```

#### 9b. Implement the types

```typescript
// src/features/agent-detail/agent-detail.types.ts

/**
 * Agent Detail Types — derived from Zod schemas via z.infer.
 *
 * IMPORTANT: All types here are single-source-of-truth from the contract schemas.
 * Never define a parallel interface — always use z.infer<typeof Schema>.
 */

import type { z } from 'zod';
import type {
  IdentitySectionSchema,
  ToolSectionSchema,
  ToolParameterSchema,
  GatherFieldSchema,
  FlowStepSchema,
  FlowSectionSchema,
  RulesSectionSchema,
  ConstraintSchema,
  GuardrailSchema,
  CoordinationSectionSchema,
  DelegateSchema,
  HandoffSchema,
  EscalationSectionSchema,
  EscalationRoutingSchema,
  BehaviorSectionSchema,
  BehaviorProfileRefSchema,
  LifecycleSectionSchema,
  ErrorHandlerSchema,
  CompletionConditionSchema,
  MemoryConfigSchema,
  SectionModelsSchema,
  AgentInfoSchema,
  AgentDetailsSchema,
  CompilationResponseSchema,
} from './agent-detail.contract';

// ---------------------------------------------------------------------------
// Section data types (z.infer)
// ---------------------------------------------------------------------------

export type IdentitySection = z.infer<typeof IdentitySectionSchema>;
export type ToolSection = z.infer<typeof ToolSectionSchema>;
export type ToolParameter = z.infer<typeof ToolParameterSchema>;
export type GatherField = z.infer<typeof GatherFieldSchema>;
export type FlowStep = z.infer<typeof FlowStepSchema>;
export type FlowSection = z.infer<typeof FlowSectionSchema>;
export type RulesSection = z.infer<typeof RulesSectionSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type Guardrail = z.infer<typeof GuardrailSchema>;
export type CoordinationSection = z.infer<typeof CoordinationSectionSchema>;
export type Delegate = z.infer<typeof DelegateSchema>;
export type Handoff = z.infer<typeof HandoffSchema>;
export type EscalationSection = z.infer<typeof EscalationSectionSchema>;
export type EscalationRouting = z.infer<typeof EscalationRoutingSchema>;
export type BehaviorSection = z.infer<typeof BehaviorSectionSchema>;
export type BehaviorProfileRef = z.infer<typeof BehaviorProfileRefSchema>;
export type LifecycleSection = z.infer<typeof LifecycleSectionSchema>;
export type ErrorHandler = z.infer<typeof ErrorHandlerSchema>;
export type CompletionCondition = z.infer<typeof CompletionConditionSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type SectionModels = z.infer<typeof SectionModelsSchema>;
export type AgentInfo = z.infer<typeof AgentInfoSchema>;
export type AgentDetails = z.infer<typeof AgentDetailsSchema>;
export type CompilationResponse = z.infer<typeof CompilationResponseSchema>;

// ---------------------------------------------------------------------------
// Enum-like types
// ---------------------------------------------------------------------------

/** Section identifiers for the accordion layout */
export type SectionId =
  | 'IDENTITY'
  | 'TOOLS'
  | 'GATHER'
  | 'FLOW'
  | 'RULES'
  | 'COORDINATION'
  | 'BEHAVIOR'
  | 'LIFECYCLE';

/** Save indicator states */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** Maps SectionId to SectionModels keys */
export type SectionKey = keyof SectionModels;

/**
 * Mapping from SectionId to the corresponding SectionModels key.
 * Used to type-safely look up section data by SectionId.
 */
export const SECTION_ID_TO_KEY: Record<SectionId, SectionKey> = {
  IDENTITY: 'identity',
  TOOLS: 'tools',
  GATHER: 'gather',
  FLOW: 'flow',
  RULES: 'rules',
  COORDINATION: 'coordination',
  BEHAVIOR: 'behavior',
  LIFECYCLE: 'lifecycle',
} as const;
```

#### 9c. Verify & commit

```bash
cd apps/studio && npx vitest run --typecheck src/features/agent-detail/__tests__/agent-detail.types.test.ts
npx prettier --write src/features/agent-detail/agent-detail.types.ts src/features/agent-detail/__tests__/agent-detail.types.test.ts
git add src/features/agent-detail/agent-detail.types.ts src/features/agent-detail/__tests__/agent-detail.types.test.ts
git commit -m "[ABLP-2] feat(studio): add agent-detail z.infer types and SectionId enum"
```

---

### Task 10: IR Section Parser (Pure Function)

**TDD: Write test → see it fail → implement → pass → commit**

This is the most complex pure function extraction — 310 LOC from `store/agent-detail-store.ts`. The parser converts raw AgentIR (snake_case) to UI-friendly section models (camelCase).

#### 10a. Write the test

```typescript
// src/features/agent-detail/__tests__/ir-parser.test.ts

import { describe, it, expect } from 'vitest';
import { parseIRToSections, computeVisibleSections } from '../ir-parser';
import type { SectionModels } from '../agent-detail.types';
import {
  REASONING_AGENT_IR,
  SCRIPTED_AGENT_IR,
  SUPERVISOR_AGENT_IR,
  MINIMAL_AGENT_IR,
} from '../__fixtures__/agent-ir-fixtures';

// ---------------------------------------------------------------------------
// parseIRToSections
// ---------------------------------------------------------------------------
describe('parseIRToSections', () => {
  describe('with reasoning agent IR', () => {
    let sections: SectionModels;

    it('parses without throwing', () => {
      sections = parseIRToSections(REASONING_AGENT_IR);
      expect(sections).toBeDefined();
    });

    it('extracts identity goal and persona', () => {
      sections = parseIRToSections(REASONING_AGENT_IR);
      expect(sections.identity.goal).toBe('Help users manage their orders');
      expect(sections.identity.persona).toBe('Friendly support agent');
    });

    it('does not set mode (deprecated)', () => {
      sections = parseIRToSections(REASONING_AGENT_IR);
      expect(sections.identity.mode).toBeUndefined();
    });

    it('extracts model config from execution', () => {
      sections = parseIRToSections(REASONING_AGENT_IR);
      expect(sections.identity.model).toBe('gpt-4o');
      expect(sections.identity.temperature).toBe(0.7);
    });

    it('filters out system tools', () => {
      sections = parseIRToSections(REASONING_AGENT_IR);
      expect(sections.tools.every((t) => t.name !== '__system_respond')).toBe(true);
    });

    it('parses tool parameters with camelCase defaultValue', () => {
      sections = parseIRToSections(REASONING_AGENT_IR);
      const lookupTool = sections.tools.find((t) => t.name === 'lookup_order');
      expect(lookupTool).toBeDefined();
      expect(lookupTool!.parameters[0].name).toBe('orderId');
      expect(lookupTool!.parameters[0].required).toBe(true);
    });

    it('parses http binding', () => {
      sections = parseIRToSections(REASONING_AGENT_IR);
      const httpTool = sections.tools.find((t) => t.toolType === 'http');
      expect(httpTool?.httpBinding?.endpoint).toBeDefined();
    });

    it('returns null flow for reasoning agents without flow', () => {
      sections = parseIRToSections(REASONING_AGENT_IR);
      expect(sections.flow).toBeNull();
    });

    it('parses constraints', () => {
      sections = parseIRToSections(REASONING_AGENT_IR);
      expect(sections.rules.constraints.length).toBeGreaterThan(0);
      expect(sections.rules.constraints[0].condition).toBeDefined();
      expect(sections.rules.constraints[0].onFail.type).toBeDefined();
    });

    it('parses guardrails with provider and kind', () => {
      sections = parseIRToSections(REASONING_AGENT_IR);
      expect(sections.rules.guardrails.length).toBeGreaterThan(0);
      expect(sections.rules.guardrails[0].name).toBeDefined();
    });
  });

  describe('with scripted agent IR', () => {
    let sections: SectionModels;

    it('parses flow steps', () => {
      sections = parseIRToSections(SCRIPTED_AGENT_IR);
      expect(sections.flow).not.toBeNull();
      expect(sections.flow!.steps.length).toBeGreaterThan(0);
      expect(sections.flow!.entryPoint).toBeDefined();
    });

    it('parses flow step reasoning zones', () => {
      sections = parseIRToSections(SCRIPTED_AGENT_IR);
      const reasoningStep = sections.flow!.steps.find((s) => s.reasoning);
      if (reasoningStep) {
        expect(reasoningStep.goal).toBeDefined();
        expect(reasoningStep.exitWhen).toBeDefined();
      }
    });

    it('parses gather fields with validation', () => {
      sections = parseIRToSections(SCRIPTED_AGENT_IR);
      expect(sections.gather.length).toBeGreaterThan(0);
      const emailField = sections.gather.find((f) => f.name === 'email');
      expect(emailField?.validation?.type).toBe('regex');
    });

    it('parses gather field PII sensitivity', () => {
      sections = parseIRToSections(SCRIPTED_AGENT_IR);
      const ssnField = sections.gather.find((f) => f.sensitive);
      if (ssnField) {
        expect(ssnField.sensitiveDisplay).toBeDefined();
      }
    });

    it('parses lifecycle on_start', () => {
      sections = parseIRToSections(SCRIPTED_AGENT_IR);
      expect(sections.lifecycle.hasOnStart).toBe(true);
      expect(sections.lifecycle.onStartRespond).toBeDefined();
    });

    it('parses lifecycle hooks', () => {
      sections = parseIRToSections(SCRIPTED_AGENT_IR);
      expect(sections.lifecycle.hasHooks).toBe(true);
      expect(sections.lifecycle.hooks.length).toBeGreaterThan(0);
    });

    it('parses lifecycle error handlers', () => {
      sections = parseIRToSections(SCRIPTED_AGENT_IR);
      expect(sections.lifecycle.errorHandlers.length).toBeGreaterThan(0);
      expect(sections.lifecycle.errorHandlers[0].then).toBeDefined();
    });

    it('parses lifecycle completion conditions', () => {
      sections = parseIRToSections(SCRIPTED_AGENT_IR);
      expect(sections.lifecycle.completionConditions.length).toBeGreaterThan(0);
    });

    it('parses memory config', () => {
      sections = parseIRToSections(SCRIPTED_AGENT_IR);
      expect(sections.lifecycle.memoryConfig.sessionVars.length).toBeGreaterThan(0);
    });
  });

  describe('with supervisor agent IR', () => {
    let sections: SectionModels;

    it('parses delegates', () => {
      sections = parseIRToSections(SUPERVISOR_AGENT_IR);
      expect(sections.coordination.delegates.length).toBeGreaterThan(0);
      expect(sections.coordination.delegates[0].agent).toBeDefined();
    });

    it('parses handoffs', () => {
      sections = parseIRToSections(SUPERVISOR_AGENT_IR);
      expect(sections.coordination.handoffs.length).toBeGreaterThan(0);
      expect(sections.coordination.handoffs[0].to).toBeDefined();
      expect(sections.coordination.handoffs[0].returnable).toBeDefined();
    });

    it('parses escalation triggers', () => {
      sections = parseIRToSections(SUPERVISOR_AGENT_IR);
      expect(sections.coordination.escalation.triggers.length).toBeGreaterThan(0);
    });

    it('parses escalation routing', () => {
      sections = parseIRToSections(SUPERVISOR_AGENT_IR);
      expect(sections.coordination.escalation.routing).toBeDefined();
      expect(sections.coordination.escalation.routing?.connectionId).toBeDefined();
    });

    it('parses behavior profiles', () => {
      sections = parseIRToSections(SUPERVISOR_AGENT_IR);
      expect(sections.behavior.profiles.length).toBeGreaterThan(0);
      expect(sections.behavior.profiles[0].overrideCategories.length).toBeGreaterThan(0);
    });
  });

  describe('with minimal/empty IR', () => {
    it('returns safe defaults for empty object', () => {
      const sections = parseIRToSections({});
      expect(sections.identity.goal).toBe('');
      expect(sections.tools).toEqual([]);
      expect(sections.gather).toEqual([]);
      expect(sections.flow).toBeNull();
      expect(sections.rules.constraints).toEqual([]);
      expect(sections.rules.guardrails).toEqual([]);
      expect(sections.coordination.delegates).toEqual([]);
      expect(sections.coordination.handoffs).toEqual([]);
      expect(sections.coordination.escalation.triggers).toEqual([]);
      expect(sections.behavior.profiles).toEqual([]);
      expect(sections.lifecycle.hasOnStart).toBe(false);
    });

    it('returns safe defaults for minimal IR', () => {
      const sections = parseIRToSections(MINIMAL_AGENT_IR);
      expect(sections.identity.goal).toBe('Minimal agent');
      expect(sections.tools).toEqual([]);
    });
  });

  describe('tool binding variants', () => {
    it('parses mcp binding', () => {
      const ir = {
        tools: [
          {
            name: 'mcp_tool',
            description: 'MCP tool',
            tool_type: 'mcp',
            mcp_binding: { server: 'my-server', tool: 'my-tool' },
          },
        ],
      };
      const sections = parseIRToSections(ir);
      expect(sections.tools[0].mcpBinding?.server).toBe('my-server');
    });

    it('parses sandbox binding with truncated code preview', () => {
      const longCode = 'x'.repeat(300);
      const ir = {
        tools: [
          {
            name: 'sandbox_tool',
            description: 'Sandbox tool',
            tool_type: 'sandbox',
            sandbox_binding: { runtime: 'python3', code_content: longCode, timeout_ms: 5000 },
          },
        ],
      };
      const sections = parseIRToSections(ir);
      expect(sections.tools[0].sandboxBinding?.codePreview.length).toBe(200);
      expect(sections.tools[0].sandboxBinding?.timeoutMs).toBe(5000);
    });

    it('parses tool confirmation config', () => {
      const ir = {
        tools: [
          {
            name: 'dangerous_tool',
            description: 'A tool',
            confirmation: { require: 'always', immutable_params: ['id'] },
          },
        ],
      };
      const sections = parseIRToSections(ir);
      expect(sections.tools[0].confirmation?.require).toBe('always');
      expect(sections.tools[0].confirmation?.immutableParams).toEqual(['id']);
    });
  });
});

// ---------------------------------------------------------------------------
// computeVisibleSections
// ---------------------------------------------------------------------------
describe('computeVisibleSections', () => {
  it('returns 7 sections when flow is null', () => {
    const sections = parseIRToSections({});
    const visible = computeVisibleSections(sections);
    expect(visible).toHaveLength(7);
    expect(visible).not.toContain('FLOW');
  });

  it('returns 8 sections when flow is present', () => {
    const sections = parseIRToSections(SCRIPTED_AGENT_IR);
    const visible = computeVisibleSections(sections);
    expect(visible).toHaveLength(8);
    expect(visible).toContain('FLOW');
  });

  it('FLOW is inserted after GATHER', () => {
    const sections = parseIRToSections(SCRIPTED_AGENT_IR);
    const visible = computeVisibleSections(sections);
    const gatherIdx = visible.indexOf('GATHER');
    const flowIdx = visible.indexOf('FLOW');
    expect(flowIdx).toBe(gatherIdx + 1);
  });

  it('always includes IDENTITY first', () => {
    const sections = parseIRToSections({});
    const visible = computeVisibleSections(sections);
    expect(visible[0]).toBe('IDENTITY');
  });
});
```

#### 10b. Implement the parser

Extract `parseIRToSections` and `computeVisibleSections` as standalone pure functions. This is a **direct extraction** — the logic is identical to `store/agent-detail-store.ts` lines 334–640.

```typescript
// src/features/agent-detail/ir-parser.ts

/**
 * IR Section Parser — pure functions to convert raw AgentIR into UI-friendly section models.
 *
 * Extracted from store/agent-detail-store.ts (lines 334-640).
 * Snake_case IR fields → camelCase UI models. System tools filtered out.
 *
 * Data source: Runtime compiler output (AgentIR). The IR uses snake_case
 * per the compiler convention; this parser normalizes to camelCase for React.
 */

import type {
  SectionModels,
  IdentitySection,
  ToolSection,
  GatherField,
  FlowSection,
  FlowStep,
  RulesSection,
  CoordinationSection,
  EscalationSection,
  BehaviorSection,
  LifecycleSection,
  SectionId,
} from './agent-detail.types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Parse an AgentIR object into UI-friendly section models.
 * Filters out system tools and converts snake_case to camelCase.
 */
export function parseIRToSections(ir: any): SectionModels {
  const identity = parseIdentity(ir);
  const tools = parseTools(ir);
  const gather = parseGather(ir);
  const flow = parseFlow(ir);
  const rules = parseRules(ir);
  const coordination = parseCoordination(ir);
  const behavior = parseBehavior(ir);
  const lifecycle = parseLifecycle(ir);

  return { identity, tools, gather, flow, rules, coordination, behavior, lifecycle };
}

/**
 * Determine which sections should be visible based on parsed data.
 * All sections are always visible so users can add content to empty ones.
 * FLOW is shown when the agent has flow definitions.
 */
export function computeVisibleSections(sections: SectionModels): SectionId[] {
  const visible: SectionId[] = [
    'IDENTITY',
    'TOOLS',
    'GATHER',
    'RULES',
    'COORDINATION',
    'BEHAVIOR',
    'LIFECYCLE',
  ];

  // FLOW is shown when the agent has flow definitions
  if (sections.flow) {
    visible.splice(3, 0, 'FLOW');
  }

  return visible;
}

// ---------------------------------------------------------------------------
// Internal parsers
// ---------------------------------------------------------------------------

function parseIdentity(ir: any): IdentitySection {
  return {
    mode: undefined, // MODE removed — derive from flow presence
    goal: ir.identity?.goal ?? '',
    persona: ir.identity?.persona ?? '',
    limitations: ir.identity?.limitations ?? [],
    model: ir.execution?.model,
    temperature: ir.execution?.temperature,
    maxTokens: ir.execution?.max_tokens,
    enableThinking: null, // Default: inherit from project
  };
}

function parseTools(ir: any): ToolSection[] {
  const rawTools = ir.tools ?? [];
  return rawTools
    .filter((t: any) => !t.system)
    .map((t: any) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: (t.parameters ?? []).map((p: any) => ({
        name: p.name,
        type: p.type,
        description: p.description,
        required: p.required ?? false,
        defaultValue: p.default,
      })),
      returns: { type: t.returns?.type ?? 'unknown' },
      toolType: t.tool_type,
      httpBinding: t.http_binding
        ? { endpoint: t.http_binding.endpoint, method: t.http_binding.method }
        : undefined,
      mcpBinding: t.mcp_binding
        ? { server: t.mcp_binding.server, tool: t.mcp_binding.tool }
        : undefined,
      sandboxBinding: t.sandbox_binding
        ? {
            runtime: t.sandbox_binding.runtime,
            codePreview: (t.sandbox_binding.code_content || '').slice(0, 200),
            timeoutMs: t.sandbox_binding.timeout_ms,
            memoryMb: t.sandbox_binding.memory_mb,
          }
        : undefined,
      hints: t.hints ?? {},
      confirmation: t.confirmation
        ? {
            require: t.confirmation.require,
            immutableParams: t.confirmation.immutable_params,
          }
        : undefined,
      piiAccess: t.pii_access,
    }));
}

function parseGather(ir: any): GatherField[] {
  const fields = ir.gather?.fields ?? [];
  return fields.map((f: any) => ({
    name: f.name,
    prompt: f.prompt ?? '',
    type: f.type ?? 'string',
    required: f.required ?? false,
    defaultValue: f.default,
    validation: f.validation
      ? {
          type: f.validation.type,
          rule: f.validation.rule,
          errorMessage: f.validation.error_message,
        }
      : undefined,
    extractionHints: f.extraction_hints,
    infer: f.infer,
    sensitive: f.sensitive,
    sensitiveDisplay: f.sensitive_display,
    maskConfig: f.mask_config
      ? {
          showFirst: f.mask_config.show_first,
          showLast: f.mask_config.show_last,
          char: f.mask_config.char,
        }
      : undefined,
    transient: f.transient,
    extractionPattern: f.extraction_pattern,
    extractionGroup: f.extraction_group,
  }));
}

function parseFlow(ir: any): FlowSection | null {
  if (!ir.flow) return null;

  const stepNames: string[] = ir.flow.steps ?? [];
  const definitions: Record<string, any> = ir.flow.definitions ?? {};

  const steps: FlowStep[] = stepNames.map((name: string) => {
    const def = definitions[name] ?? {};
    const rz = def.reasoning_zone; // ReasoningZoneIR | undefined
    return {
      name: def.name ?? name,
      respond: def.respond,
      call: def.call,
      then: def.then,
      hasGather: Boolean(def.gather),
      hasBranching: Boolean(def.on_input?.length || def.on_result?.length),
      reasoning: Boolean(rz),
      goal: rz?.goal,
      exitWhen: rz?.exit_when,
      maxTurns: rz?.max_turns,
      availableTools: rz?.available_tools,
    };
  });

  return {
    steps,
    entryPoint: ir.flow.entry_point ?? stepNames[0] ?? '',
  };
}

function parseRules(ir: any): RulesSection {
  const constraints = (ir.constraints?.constraints ?? []).map((c: any) => ({
    condition: c.condition,
    onFail: {
      type: c.on_fail?.type ?? 'respond',
      message: c.on_fail?.message,
      target: c.on_fail?.target,
      reason: c.on_fail?.reason,
    },
  }));

  const guardrails = (ir.constraints?.guardrails ?? []).map((g: any) => ({
    name: g.name,
    description: g.description ?? '',
    check: g.check ?? '',
    action: {
      type: g.action?.type ?? 'block',
      message: g.action?.message,
    },
    provider: g.provider,
    category: g.category,
    threshold: g.threshold,
    severityActions: g.severity_actions,
    llmCheck: g.llm_check,
    kind: g.kind,
    priority: g.priority,
    streaming: g.streaming,
  }));

  return { constraints, guardrails };
}

function parseEscalation(ir: any): EscalationSection {
  const esc = ir.coordination?.escalation;
  const defaultPriority = 'medium';
  if (!esc) return { triggers: [], contextForHuman: [], onHumanComplete: [] };
  return {
    triggers: (esc.triggers ?? []).map((t: any) => ({
      when: t.when ?? '',
      reason: t.reason ?? '',
      priority: t.priority ?? defaultPriority,
      tags: t.tags,
    })),
    contextForHuman: esc.context_for_human ?? [],
    onHumanComplete: (esc.on_human_complete ?? []).map((h: any) => ({
      condition: h.condition ?? '',
      action: h.action ?? '',
    })),
    routing: esc.routing
      ? {
          connectionId: esc.routing.connection ?? '',
          queue: esc.routing.queue,
          skills: esc.routing.skills,
          priority: esc.routing.priority,
          postAgentAction: (esc.routing.post_agent as 'return' | 'end') ?? 'return',
          voice: esc.routing.voice
            ? {
                transferMethod: esc.routing.voice.transfer_method,
                sipHeaders: esc.routing.voice.sip_headers,
              }
            : undefined,
          providerConfig: esc.routing.provider_config,
        }
      : undefined,
  };
}

function parseCoordination(ir: any): CoordinationSection {
  const delegates = (ir.coordination?.delegates ?? []).map((d: any) => ({
    agent: d.agent,
    when: d.when ?? '',
    purpose: d.purpose ?? '',
  }));

  const handoffs = (ir.coordination?.handoffs ?? []).map((h: any) => ({
    to: h.to,
    when: h.when ?? '',
    summary: h.context?.summary ?? '',
    returnable: h.return ?? false,
  }));

  const escalation = parseEscalation(ir);

  return { delegates, handoffs, escalation };
}

function parseBehavior(ir: any): BehaviorSection {
  const profiles = (ir.behavior_profiles ?? []).map((p: any) => {
    const overrideCategories: string[] = [];
    if (p.instructions) overrideCategories.push('instructions');
    if (p.constraints && p.constraints.length > 0) overrideCategories.push('constraints');
    if (p.tools_hide?.length > 0 || p.tools_add?.length > 0) overrideCategories.push('tools');
    if (p.voice) overrideCategories.push('voice');
    if (p.response_rules) overrideCategories.push('response_rules');
    if (p.gather_overrides) overrideCategories.push('gather');
    if (p.flow_modifications || p.flow_replace) overrideCategories.push('flow');

    return {
      name: p.name,
      priority: p.priority ?? 0,
      whenSummary: p.when ?? '',
      overrideCategories,
    };
  });

  return { profiles };
}

function parseLifecycle(ir: any): LifecycleSection {
  const onStart = ir.on_start;
  const hooks = ir.hooks;
  const errorHandling = ir.error_handling;
  const completion = ir.completion;
  const memory = ir.memory;

  const hookNames: string[] = [];
  if (hooks?.before_agent) hookNames.push('before_agent');
  if (hooks?.after_agent) hookNames.push('after_agent');
  if (hooks?.before_turn) hookNames.push('before_turn');
  if (hooks?.after_turn) hookNames.push('after_turn');

  const errorHandlers = (errorHandling?.handlers ?? []).map((h: any) => ({
    type: h.type,
    respond: h.respond,
    then: h.then ?? 'continue',
  }));

  const completionConditions = (completion?.conditions ?? []).map((c: any) => ({
    when: c.when,
    respond: c.respond,
  }));

  const memoryConfig = {
    sessionVars: (memory?.session ?? []).map((s: any) => s.name),
    persistentPaths: (memory?.persistent ?? []).map((p: any) => p.path),
    rememberTriggers: (memory?.remember ?? []).length,
    recallInstructions: (memory?.recall ?? []).length,
  };

  return {
    hasOnStart: Boolean(onStart),
    onStartRespond: onStart?.respond,
    onStartCall: onStart?.call,
    hasHooks: hookNames.length > 0,
    hooks: hookNames,
    errorHandlers,
    completionConditions,
    memoryConfig,
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
```

#### 10c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/agent-detail/__tests__/ir-parser.test.ts
npx prettier --write src/features/agent-detail/ir-parser.ts src/features/agent-detail/__tests__/ir-parser.test.ts
git add src/features/agent-detail/ir-parser.ts src/features/agent-detail/__tests__/ir-parser.test.ts
git commit -m "[ABLP-2] feat(studio): extract IR section parser as pure function with TDD"
```

---

### Task 11: Agent Detail Store (Pure State, Devtools, Slimmed)

**TDD: Write test → see it fail → implement → pass → commit**

The store is now significantly slimmer because `parseIRToSections` and `computeVisibleSections` are imported from `ir-parser.ts` rather than inlined.

#### 11a. Write the test

```typescript
// src/features/agent-detail/__tests__/agent-detail.store.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { useAgentDetailStore, selectIsExpanded, selectSectionData } from '../agent-detail.store';
import { REASONING_AGENT_IR, SCRIPTED_AGENT_IR } from '../__fixtures__/agent-ir-fixtures';

describe('useAgentDetailStore', () => {
  beforeEach(() => {
    useAgentDetailStore.getState().reset();
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------
  describe('initial state', () => {
    it('starts with null agentId', () => {
      expect(useAgentDetailStore.getState().agentId).toBeNull();
    });

    it('starts with empty sections', () => {
      const { sections } = useAgentDetailStore.getState();
      expect(sections.identity.goal).toBe('');
      expect(sections.tools).toEqual([]);
      expect(sections.flow).toBeNull();
    });

    it('starts with idle save status', () => {
      expect(useAgentDetailStore.getState().saveStatus).toBe('idle');
    });

    it('starts with no expanded section', () => {
      expect(useAgentDetailStore.getState().expandedSection).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // loadFromIR
  // -------------------------------------------------------------------------
  describe('loadFromIR', () => {
    it('sets agentId', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      expect(useAgentDetailStore.getState().agentId).toBe('agent_123');
    });

    it('extracts agentName from metadata', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      expect(useAgentDetailStore.getState().agentName).toBe('support-agent');
    });

    it('extracts agentDescription from identity.goal', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      expect(useAgentDetailStore.getState().agentDescription).toBe(
        'Help users manage their orders',
      );
    });

    it('stores rawIR', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      expect(useAgentDetailStore.getState().rawIR).toBe(REASONING_AGENT_IR);
    });

    it('parses sections via ir-parser', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      const { sections } = useAgentDetailStore.getState();
      expect(sections.identity.goal).toBe('Help users manage their orders');
      expect(sections.tools.length).toBeGreaterThan(0);
    });

    it('computes visible sections', () => {
      useAgentDetailStore.getState().loadFromIR(SCRIPTED_AGENT_IR, 'agent_456');
      const { visibleSections } = useAgentDetailStore.getState();
      expect(visibleSections).toContain('FLOW');
    });

    it('resets save status to idle', () => {
      useAgentDetailStore.getState().setSaveStatus('error', 'something broke');
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      expect(useAgentDetailStore.getState().saveStatus).toBe('idle');
      expect(useAgentDetailStore.getState().saveError).toBeNull();
    });

    it('preserves expandedSection when reloading same agent', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      useAgentDetailStore.getState().expandSection('TOOLS');
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      expect(useAgentDetailStore.getState().expandedSection).toBe('TOOLS');
    });

    it('resets expandedSection when switching agents', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      useAgentDetailStore.getState().expandSection('TOOLS');
      useAgentDetailStore.getState().loadFromIR(SCRIPTED_AGENT_IR, 'agent_456');
      expect(useAgentDetailStore.getState().expandedSection).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // updateSection
  // -------------------------------------------------------------------------
  describe('updateSection', () => {
    it('updates a specific section', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      useAgentDetailStore.getState().updateSection('identity', {
        goal: 'Updated goal',
        persona: 'New persona',
        limitations: [],
      });
      expect(useAgentDetailStore.getState().sections.identity.goal).toBe('Updated goal');
    });

    it('recomputes visibleSections after update', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      // Reasoning agent has no flow, so FLOW should not be visible
      expect(useAgentDetailStore.getState().visibleSections).not.toContain('FLOW');

      // Add a flow section
      useAgentDetailStore.getState().updateSection('flow', {
        steps: [{ name: 'start', hasGather: false, hasBranching: false, reasoning: false }],
        entryPoint: 'start',
      });
      expect(useAgentDetailStore.getState().visibleSections).toContain('FLOW');
    });

    it('does not affect other sections', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      const toolsBefore = useAgentDetailStore.getState().sections.tools;
      useAgentDetailStore.getState().updateSection('identity', {
        goal: 'Changed',
        persona: '',
        limitations: [],
      });
      expect(useAgentDetailStore.getState().sections.tools).toBe(toolsBefore);
    });
  });

  // -------------------------------------------------------------------------
  // expandSection / collapseSection
  // -------------------------------------------------------------------------
  describe('expandSection / collapseSection', () => {
    it('expands a section', () => {
      useAgentDetailStore.getState().expandSection('IDENTITY');
      expect(useAgentDetailStore.getState().expandedSection).toBe('IDENTITY');
    });

    it('switches expanded section', () => {
      useAgentDetailStore.getState().expandSection('IDENTITY');
      useAgentDetailStore.getState().expandSection('TOOLS');
      expect(useAgentDetailStore.getState().expandedSection).toBe('TOOLS');
    });

    it('collapses section', () => {
      useAgentDetailStore.getState().expandSection('IDENTITY');
      useAgentDetailStore.getState().collapseSection();
      expect(useAgentDetailStore.getState().expandedSection).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // setSaveStatus
  // -------------------------------------------------------------------------
  describe('setSaveStatus', () => {
    it('sets saving status', () => {
      useAgentDetailStore.getState().setSaveStatus('saving');
      expect(useAgentDetailStore.getState().saveStatus).toBe('saving');
    });

    it('sets error with message', () => {
      useAgentDetailStore.getState().setSaveStatus('error', 'Network failure');
      expect(useAgentDetailStore.getState().saveStatus).toBe('error');
      expect(useAgentDetailStore.getState().saveError).toBe('Network failure');
    });

    it('clears error when no message provided', () => {
      useAgentDetailStore.getState().setSaveStatus('error', 'fail');
      useAgentDetailStore.getState().setSaveStatus('idle');
      expect(useAgentDetailStore.getState().saveError).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------
  describe('reset', () => {
    it('resets all state to initial', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      useAgentDetailStore.getState().expandSection('TOOLS');
      useAgentDetailStore.getState().setSaveStatus('error', 'boom');
      useAgentDetailStore.getState().reset();

      const state = useAgentDetailStore.getState();
      expect(state.agentId).toBeNull();
      expect(state.agentName).toBe('');
      expect(state.expandedSection).toBeNull();
      expect(state.saveStatus).toBe('idle');
      expect(state.sections.identity.goal).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Selectors
  // -------------------------------------------------------------------------
  describe('selectors', () => {
    it('selectIsExpanded returns true for expanded section', () => {
      useAgentDetailStore.getState().expandSection('IDENTITY');
      const state = useAgentDetailStore.getState();
      expect(selectIsExpanded('IDENTITY')(state)).toBe(true);
      expect(selectIsExpanded('TOOLS')(state)).toBe(false);
    });

    it('selectSectionData returns section data by key', () => {
      useAgentDetailStore.getState().loadFromIR(REASONING_AGENT_IR, 'agent_123');
      const state = useAgentDetailStore.getState();
      const identity = selectSectionData('identity')(state);
      expect(identity.goal).toBe('Help users manage their orders');
    });
  });
});
```

#### 11b. Implement the store

```typescript
// src/features/agent-detail/agent-detail.store.ts

/**
 * Agent Detail Store — pure Zustand state for the agent detail page.
 *
 * Slim store: parsing logic lives in ir-parser.ts, contract schemas in
 * agent-detail.contract.ts. This store only manages state transitions.
 *
 * NOT persisted — ephemeral, reloaded each time an agent is opened.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { parseIRToSections, computeVisibleSections } from './ir-parser';
import type { SectionModels, SectionId, SaveStatus } from './agent-detail.types';

// =============================================================================
// EMPTY DEFAULTS
// =============================================================================

const EMPTY_SECTIONS: SectionModels = {
  identity: { goal: '', persona: '', limitations: [] },
  tools: [],
  gather: [],
  flow: null,
  rules: { constraints: [], guardrails: [] },
  coordination: {
    delegates: [],
    handoffs: [],
    escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
  },
  behavior: { profiles: [] },
  lifecycle: {
    hasOnStart: false,
    hasHooks: false,
    hooks: [],
    errorHandlers: [],
    completionConditions: [],
    memoryConfig: {
      sessionVars: [],
      persistentPaths: [],
      rememberTriggers: 0,
      recallInstructions: 0,
    },
  },
};

const INITIAL_STATE = {
  agentId: null as string | null,
  agentName: '',
  agentDescription: '',
  rawIR: null as Record<string, unknown> | null,
  sections: EMPTY_SECTIONS,
  visibleSections: [] as SectionId[],
  expandedSection: null as SectionId | null,
  saveStatus: 'idle' as SaveStatus,
  saveError: null as string | null,
};

// =============================================================================
// STORE INTERFACE
// =============================================================================

interface AgentDetailState {
  // Agent metadata
  agentId: string | null;
  agentName: string;
  agentDescription: string;

  // Raw IR for reference
  rawIR: Record<string, unknown> | null;

  // Parsed section data
  sections: SectionModels;

  // Which sections are visible
  visibleSections: SectionId[];

  // Currently expanded accordion section
  expandedSection: SectionId | null;

  // Save state
  saveStatus: SaveStatus;
  saveError: string | null;

  // Actions
  loadFromIR: (ir: any, agentId: string) => void;
  updateSection: <K extends keyof SectionModels>(key: K, data: SectionModels[K]) => void;
  expandSection: (section: SectionId) => void;
  collapseSection: () => void;
  setSaveStatus: (status: SaveStatus, error?: string) => void;
  reset: () => void;
}

// =============================================================================
// STORE
// =============================================================================

export const useAgentDetailStore = create<AgentDetailState>()(
  devtools(
    (set) => ({
      ...INITIAL_STATE,

      loadFromIR: (ir, agentId) => {
        const sections = parseIRToSections(ir);
        const visibleSections = computeVisibleSections(sections);

        set(
          (state) => ({
            agentId,
            agentName: ir.metadata?.name ?? '',
            agentDescription: ir.identity?.goal ?? '',
            rawIR: ir,
            sections,
            visibleSections,
            // Preserve expanded section when reloading the same agent (auto-save reload),
            // reset only when switching to a different agent
            expandedSection: state.agentId === agentId ? state.expandedSection : null,
            saveStatus: 'idle' as SaveStatus,
            saveError: null,
          }),
          false,
          'loadFromIR',
        );
      },

      updateSection: (key, data) =>
        set(
          (state) => {
            const sections = { ...state.sections, [key]: data };
            return { sections, visibleSections: computeVisibleSections(sections) };
          },
          false,
          'updateSection',
        ),

      expandSection: (section) => set({ expandedSection: section }, false, 'expandSection'),

      collapseSection: () => set({ expandedSection: null }, false, 'collapseSection'),

      setSaveStatus: (status, error) =>
        set({ saveStatus: status, saveError: error ?? null }, false, 'setSaveStatus'),

      reset: () => set({ ...INITIAL_STATE, sections: { ...EMPTY_SECTIONS } }, false, 'reset'),
    }),
    { name: 'agent-detail-store' },
  ),
);

// =============================================================================
// SELECTORS
// =============================================================================

export const selectIsExpanded = (sectionId: SectionId) => (state: AgentDetailState) =>
  state.expandedSection === sectionId;

export const selectSectionData =
  <K extends keyof SectionModels>(key: K) =>
  (state: AgentDetailState): SectionModels[K] =>
    state.sections[key];
```

#### 11c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/agent-detail/__tests__/agent-detail.store.test.ts
npx prettier --write src/features/agent-detail/agent-detail.store.ts src/features/agent-detail/__tests__/agent-detail.store.test.ts
git add src/features/agent-detail/agent-detail.store.ts src/features/agent-detail/__tests__/agent-detail.store.test.ts
git commit -m "[ABLP-2] feat(studio): add agent-detail store with devtools and extracted parser"
```

---

### Task 12: Agent Detail API Layer

**TDD: Write test → see it fail → implement → pass → commit**

#### 12a. Write the test

```typescript
// src/features/agent-detail/__tests__/agent-detail.api.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { agentDetailApi } from '../agent-detail.api';
import { REASONING_AGENT_IR } from '../__fixtures__/agent-ir-fixtures';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

describe('agentDetailApi', () => {
  const projectId = 'proj_123';
  const agentName = 'support-agent';

  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // loadAgent
  // -------------------------------------------------------------------------
  describe('loadAgent', () => {
    it('fetches agent detail and returns validated data', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          agent: {
            id: 'agent_123',
            name: agentName,
            type: 'agent',
            mode: 'reasoning',
            toolCount: 3,
            gatherFieldCount: 0,
            isSupervisor: false,
            dsl: 'AGENT support-agent',
            ir: REASONING_AGENT_IR,
          },
        }),
      );

      const result = await agentDetailApi.loadAgent(projectId, agentName);
      expect(result.name).toBe(agentName);
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}`,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404));
      await expect(agentDetailApi.loadAgent(projectId, agentName)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // saveAgent
  // -------------------------------------------------------------------------
  describe('saveAgent', () => {
    it('patches agent and returns response', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await agentDetailApi.saveAgent(projectId, agentName, { description: 'Updated' });
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}`,
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // compileAgent
  // -------------------------------------------------------------------------
  describe('compileAgent', () => {
    it('posts DSL and returns compilation result', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, ir: { identity: { goal: 'test' } } }),
      );

      const result = await agentDetailApi.compileAgent(projectId, agentName);
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}/compile`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('returns errors on compilation failure', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: false, errors: ['Syntax error'] }));

      const result = await agentDetailApi.compileAgent(projectId, agentName);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Syntax error');
    });
  });

  // -------------------------------------------------------------------------
  // lockAgent
  // -------------------------------------------------------------------------
  describe('lockAgent', () => {
    it('posts lock request', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ locked: true, lockedBy: 'user_1' }));

      const result = await agentDetailApi.lockAgent(projectId, agentName);
      expect(result.locked).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}/lock`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getVersions / getVersion
  // -------------------------------------------------------------------------
  describe('getVersions', () => {
    it('fetches version list', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ versions: [{ version: 1, createdAt: '2026-01-01' }] }),
      );

      const result = await agentDetailApi.getVersions(projectId);
      expect(result.versions).toHaveLength(1);
    });
  });

  describe('getVersion', () => {
    it('fetches specific version', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ version: 1, settings: {} }));

      const result = await agentDetailApi.getVersion(projectId, 1);
      expect(result.version).toBe(1);
    });
  });
});
```

#### 12b. Implement the API layer

```typescript
// src/features/agent-detail/agent-detail.api.ts

/**
 * Agent Detail API Layer
 *
 * Centralizes all API calls for the agent detail page.
 *
 * Data sources:
 *   - GET    /api/projects/:id/agents/:agentId       → Agent detail + DSL + IR
 *   - PATCH  /api/projects/:id/agents/:agentId       → Update agent metadata
 *   - POST   /api/projects/:id/agents/:agentId/compile → Compile DSL → IR
 *   - POST   /api/projects/:id/agents/:agentId/lock  → Acquire edit lock
 *   - GET    /api/projects/:id/settings/versions      → List project versions
 *   - GET    /api/projects/:id/settings/versions/:v   → Get specific version
 */

import { CompilationResponseSchema } from './agent-detail.contract';
import type { CompilationResponse } from './agent-detail.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`API ${init?.method ?? 'GET'} ${url} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

function agentUrl(projectId: string, agentName: string, suffix = '') {
  return `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}${suffix}`;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

async function loadAgent(
  projectId: string,
  agentName: string,
): Promise<{ agent: Record<string, unknown> } & Record<string, unknown>> {
  const data = await fetchJSON<{ agent: Record<string, unknown> }>(agentUrl(projectId, agentName), {
    method: 'GET',
  });
  return data;
}

async function saveAgent(
  projectId: string,
  agentName: string,
  updates: { name?: string; agentPath?: string; description?: string },
): Promise<Record<string, unknown>> {
  return fetchJSON(agentUrl(projectId, agentName), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

async function compileAgent(projectId: string, agentName: string): Promise<CompilationResponse> {
  const raw = await fetchJSON<unknown>(agentUrl(projectId, agentName, '/compile'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return CompilationResponseSchema.parse(raw);
}

async function lockAgent(
  projectId: string,
  agentName: string,
): Promise<{ locked: boolean; lockedBy?: string }> {
  return fetchJSON(agentUrl(projectId, agentName, '/lock'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

async function getVersions(
  projectId: string,
): Promise<{ versions: Array<{ version: number; createdAt: string }> }> {
  return fetchJSON(`/api/projects/${projectId}/settings/versions`, {
    method: 'GET',
  });
}

async function getVersion(projectId: string, version: number): Promise<Record<string, unknown>> {
  return fetchJSON(`/api/projects/${projectId}/settings/versions/${version}`, {
    method: 'GET',
  });
}

// ---------------------------------------------------------------------------
// Public API object
// ---------------------------------------------------------------------------

export const agentDetailApi = {
  loadAgent,
  saveAgent,
  compileAgent,
  lockAgent,
  getVersions,
  getVersion,
} as const;
```

#### 12c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/agent-detail/__tests__/agent-detail.api.test.ts
npx prettier --write src/features/agent-detail/agent-detail.api.ts src/features/agent-detail/__tests__/agent-detail.api.test.ts
git add src/features/agent-detail/agent-detail.api.ts src/features/agent-detail/__tests__/agent-detail.api.test.ts
git commit -m "[ABLP-2] feat(studio): add agent-detail API layer with validated fetch"
```

---

### Task 13: Agent Detail Fixtures

Golden test data for reasoning, scripted, and supervisor agent IR. Used by Tasks 10-11 tests.

#### 13a. Create fixtures

```typescript
// src/features/agent-detail/__fixtures__/agent-ir-fixtures.ts

/**
 * Golden IR fixtures for agent detail tests.
 *
 * These match the shape produced by the ABL compiler (snake_case).
 * The ir-parser converts them to camelCase section models.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Reasoning agent — no flow, has tools, constraints, guardrails */
export const REASONING_AGENT_IR: Record<string, any> = {
  metadata: { name: 'support-agent', version: '1.0' },
  identity: {
    goal: 'Help users manage their orders',
    persona: 'Friendly support agent',
    limitations: ['Cannot process refunds over $500', 'No medical advice'],
  },
  execution: {
    model: 'gpt-4o',
    temperature: 0.7,
    max_tokens: 4096,
  },
  tools: [
    {
      name: 'lookup_order',
      description: 'Look up an order by ID',
      tool_type: 'http',
      parameters: [
        { name: 'orderId', type: 'string', required: true },
        { name: 'includeHistory', type: 'boolean', required: false, default: false },
      ],
      returns: { type: 'object' },
      http_binding: { endpoint: 'https://api.example.com/orders/{orderId}', method: 'GET' },
      hints: { cacheable: true },
    },
    {
      name: 'update_order',
      description: 'Update order status',
      parameters: [
        { name: 'orderId', type: 'string', required: true },
        { name: 'status', type: 'string', required: true },
      ],
      returns: { type: 'object' },
      hints: {},
      confirmation: { require: 'always', immutable_params: ['orderId'] },
      pii_access: 'tools',
    },
    {
      name: '__system_respond',
      description: 'Internal system tool',
      system: true,
      parameters: [],
      returns: { type: 'void' },
      hints: {},
    },
  ],
  constraints: {
    constraints: [
      {
        condition: 'user.verified == true',
        on_fail: { type: 'respond', message: 'Please verify your account first.' },
      },
      {
        condition: 'order.total < 500',
        on_fail: { type: 'escalate', reason: 'High-value order requires supervisor' },
      },
    ],
    guardrails: [
      {
        name: 'pii-filter',
        description: 'Block PII in responses',
        check: 'builtin:pii',
        action: { type: 'block', message: 'PII detected' },
        provider: 'builtin-pii',
        category: 'safety',
        threshold: 0.9,
        kind: 'output',
        priority: 1,
        streaming: false,
      },
    ],
  },
};

/** Scripted agent — has flow, gather, lifecycle, memory */
export const SCRIPTED_AGENT_IR: Record<string, any> = {
  metadata: { name: 'onboarding-agent', version: '1.0' },
  identity: {
    goal: 'Guide users through account setup',
    persona: 'Helpful onboarding assistant',
    limitations: [],
  },
  execution: {
    model: 'gpt-4o-mini',
  },
  tools: [
    {
      name: 'create_account',
      description: 'Create user account',
      parameters: [
        { name: 'email', type: 'string', required: true },
        { name: 'name', type: 'string', required: true },
      ],
      returns: { type: 'object' },
      hints: {},
    },
  ],
  gather: {
    fields: [
      {
        name: 'email',
        prompt: 'What is your email address?',
        type: 'string',
        required: true,
        validation: { type: 'regex', rule: '^.+@.+\\..+$', error_message: 'Invalid email' },
        extraction_hints: ['email address', 'e-mail'],
      },
      {
        name: 'name',
        prompt: 'What is your full name?',
        type: 'string',
        required: true,
      },
      {
        name: 'ssn',
        prompt: 'Please provide your SSN for verification',
        type: 'string',
        required: false,
        sensitive: true,
        sensitive_display: 'mask',
        mask_config: { show_first: 0, show_last: 4, char: '*' },
        transient: true,
      },
    ],
  },
  flow: {
    entry_point: 'welcome',
    steps: ['welcome', 'collect_info', 'analyze', 'confirm'],
    definitions: {
      welcome: {
        name: 'welcome',
        respond: 'Welcome! Let me help you set up your account.',
        then: 'collect_info',
      },
      collect_info: {
        name: 'collect_info',
        gather: true,
        then: 'analyze',
      },
      analyze: {
        name: 'analyze',
        reasoning_zone: {
          goal: 'Verify the provided information is complete',
          exit_when: 'verification_complete',
          max_turns: 3,
          available_tools: ['create_account'],
        },
        then: 'confirm',
      },
      confirm: {
        name: 'confirm',
        respond: 'Your account has been created!',
        on_input: [{ condition: 'modify', then: 'collect_info' }],
      },
    },
  },
  on_start: {
    respond: 'Hello! I am your onboarding assistant.',
  },
  hooks: {
    before_agent: { call: 'init_session' },
    after_turn: { call: 'log_turn' },
  },
  error_handling: {
    handlers: [
      { type: 'tool_error', respond: 'Something went wrong, let me try again.', then: 'retry' },
      { type: 'timeout', then: 'continue' },
    ],
  },
  completion: {
    conditions: [
      { when: 'account_created', respond: 'All done! Your account is ready.' },
      { when: 'user_cancelled' },
    ],
  },
  memory: {
    session: [{ name: 'userId' }, { name: 'onboardingStep' }],
    persistent: [{ path: 'user.preferences' }],
    remember: [{ trigger: 'account_created' }],
    recall: [{ instruction: 'previous_preferences' }],
  },
};

/** Supervisor agent — has delegates, handoffs, escalation, behavior profiles */
export const SUPERVISOR_AGENT_IR: Record<string, any> = {
  metadata: { name: 'supervisor-agent', version: '1.0' },
  identity: {
    goal: 'Route customer inquiries to the right specialist',
    persona: 'Professional routing supervisor',
    limitations: ['Cannot handle queries directly'],
  },
  execution: {
    model: 'gpt-4o',
  },
  tools: [],
  coordination: {
    delegates: [
      { agent: 'billing-agent', when: 'billing inquiry', purpose: 'Handle billing questions' },
      { agent: 'tech-agent', when: 'technical issue', purpose: 'Handle technical support' },
    ],
    handoffs: [
      {
        to: 'sales-agent',
        when: 'sales opportunity',
        context: { summary: 'Transfer to sales team' },
        return: true,
      },
      {
        to: 'complaints-agent',
        when: 'complaint',
        context: { summary: 'Escalate complaint' },
        return: false,
      },
    ],
    escalation: {
      triggers: [
        {
          when: 'customer.sentiment < -0.5',
          reason: 'Negative sentiment',
          priority: 'high',
          tags: ['urgent'],
        },
        { when: 'wait_time > 300', reason: 'Long wait', priority: 'medium' },
      ],
      context_for_human: ['conversation_summary', 'customer_history'],
      on_human_complete: [
        { condition: 'resolved', action: 'complete' },
        { condition: 'unresolved', action: 'escalate_further' },
      ],
      routing: {
        connection: 'conn_zendesk_001',
        queue: 'tier2-support',
        skills: ['billing', 'technical'],
        priority: 2,
        post_agent: 'return',
        voice: {
          transfer_method: 'refer',
          sip_headers: { 'X-Priority': 'high' },
        },
        provider_config: { maxWaitTime: 120 },
      },
    },
  },
  behavior_profiles: [
    {
      name: 'formal',
      priority: 1,
      when: 'business hours and enterprise customer',
      instructions: 'Use formal language',
      constraints: [{ condition: 'no_slang' }],
      voice: { tone: 'professional' },
    },
    {
      name: 'casual',
      priority: 0,
      when: 'after hours or consumer customer',
      instructions: 'Use casual language',
      tools_hide: ['enterprise_lookup'],
      response_rules: { maxLength: 500 },
      gather_overrides: { confirmAll: true },
    },
  ],
};

/** Minimal agent — just identity, nothing else */
export const MINIMAL_AGENT_IR: Record<string, any> = {
  metadata: { name: 'minimal-agent' },
  identity: {
    goal: 'Minimal agent',
  },
};

/* eslint-enable @typescript-eslint/no-explicit-any */
```

#### 13b. Verify & commit

```bash
npx prettier --write apps/studio/src/features/agent-detail/__fixtures__/agent-ir-fixtures.ts
git add apps/studio/src/features/agent-detail/__fixtures__/agent-ir-fixtures.ts
git commit -m "[ABLP-2] test(studio): add golden IR fixtures for agent detail tests"
```

---

### Task 14: Agent Detail Barrel Exports

#### 14a. Create index.ts

```typescript
// src/features/agent-detail/index.ts

/**
 * Agent Detail Feature Module — barrel exports.
 *
 * Usage:
 *   import { useAgentDetailStore, agentDetailApi } from '@/features/agent-detail';
 *   import type { SectionModels, SectionId } from '@/features/agent-detail';
 */

// Contract schemas (for runtime validation)
export {
  IdentitySectionSchema,
  ToolSectionSchema,
  ToolParameterSchema,
  GatherFieldSchema,
  FlowStepSchema,
  FlowSectionSchema,
  RulesSectionSchema,
  ConstraintSchema,
  GuardrailSchema,
  CoordinationSectionSchema,
  DelegateSchema,
  HandoffSchema,
  EscalationSectionSchema,
  EscalationRoutingSchema,
  BehaviorSectionSchema,
  BehaviorProfileRefSchema,
  LifecycleSectionSchema,
  ErrorHandlerSchema,
  CompletionConditionSchema,
  MemoryConfigSchema,
  SectionModelsSchema,
  AgentInfoSchema,
  AgentDetailsSchema,
  CompilationResponseSchema,
} from './agent-detail.contract';

// Types (z.infer derived)
export type {
  IdentitySection,
  ToolSection,
  ToolParameter,
  GatherField,
  FlowStep,
  FlowSection,
  RulesSection,
  Constraint,
  Guardrail,
  CoordinationSection,
  Delegate,
  Handoff,
  EscalationSection,
  EscalationRouting,
  BehaviorSection,
  BehaviorProfileRef,
  LifecycleSection,
  ErrorHandler,
  CompletionCondition,
  MemoryConfig,
  SectionModels,
  AgentInfo,
  AgentDetails,
  CompilationResponse,
  SectionId,
  SaveStatus,
  SectionKey,
} from './agent-detail.types';

export { SECTION_ID_TO_KEY } from './agent-detail.types';

// IR parser (pure functions)
export { parseIRToSections, computeVisibleSections } from './ir-parser';

// Store
export { useAgentDetailStore, selectIsExpanded, selectSectionData } from './agent-detail.store';

// API layer
export { agentDetailApi } from './agent-detail.api';
```

#### 14b. Verify & commit

```bash
npx prettier --write apps/studio/src/features/agent-detail/index.ts
git add apps/studio/src/features/agent-detail/index.ts
git commit -m "[ABLP-2] feat(studio): add agent-detail barrel exports"
```

---

### Task 15: Agent Detail Integration

**TDD: Write test → see it fail → implement → pass → commit**

#### 15a. Write integration test

```typescript
// src/features/agent-detail/__tests__/agent-detail.integration.test.ts

import { describe, it, expect } from 'vitest';

describe('agent-detail feature module integration', () => {
  it('exports all contract schemas', async () => {
    const mod = await import('@/features/agent-detail');
    expect(mod.IdentitySectionSchema).toBeDefined();
    expect(mod.ToolSectionSchema).toBeDefined();
    expect(mod.GatherFieldSchema).toBeDefined();
    expect(mod.FlowStepSchema).toBeDefined();
    expect(mod.FlowSectionSchema).toBeDefined();
    expect(mod.RulesSectionSchema).toBeDefined();
    expect(mod.ConstraintSchema).toBeDefined();
    expect(mod.GuardrailSchema).toBeDefined();
    expect(mod.CoordinationSectionSchema).toBeDefined();
    expect(mod.BehaviorSectionSchema).toBeDefined();
    expect(mod.LifecycleSectionSchema).toBeDefined();
    expect(mod.SectionModelsSchema).toBeDefined();
    expect(mod.AgentDetailsSchema).toBeDefined();
    expect(mod.CompilationResponseSchema).toBeDefined();
  });

  it('exports pure parser functions', async () => {
    const mod = await import('@/features/agent-detail');
    expect(mod.parseIRToSections).toBeTypeOf('function');
    expect(mod.computeVisibleSections).toBeTypeOf('function');
  });

  it('exports store and selectors', async () => {
    const mod = await import('@/features/agent-detail');
    expect(mod.useAgentDetailStore).toBeDefined();
    expect(mod.selectIsExpanded).toBeTypeOf('function');
    expect(mod.selectSectionData).toBeTypeOf('function');
  });

  it('exports API layer with all methods', async () => {
    const { agentDetailApi } = await import('@/features/agent-detail');
    expect(agentDetailApi.loadAgent).toBeTypeOf('function');
    expect(agentDetailApi.saveAgent).toBeTypeOf('function');
    expect(agentDetailApi.compileAgent).toBeTypeOf('function');
    expect(agentDetailApi.lockAgent).toBeTypeOf('function');
    expect(agentDetailApi.getVersions).toBeTypeOf('function');
    expect(agentDetailApi.getVersion).toBeTypeOf('function');
  });

  it('exports SECTION_ID_TO_KEY mapping', async () => {
    const { SECTION_ID_TO_KEY } = await import('@/features/agent-detail');
    expect(SECTION_ID_TO_KEY.IDENTITY).toBe('identity');
    expect(SECTION_ID_TO_KEY.TOOLS).toBe('tools');
    expect(SECTION_ID_TO_KEY.GATHER).toBe('gather');
    expect(SECTION_ID_TO_KEY.FLOW).toBe('flow');
    expect(SECTION_ID_TO_KEY.RULES).toBe('rules');
    expect(SECTION_ID_TO_KEY.COORDINATION).toBe('coordination');
    expect(SECTION_ID_TO_KEY.BEHAVIOR).toBe('behavior');
    expect(SECTION_ID_TO_KEY.LIFECYCLE).toBe('lifecycle');
  });

  it('parser output validates against contract schemas', async () => {
    const { parseIRToSections, SectionModelsSchema } = await import('@/features/agent-detail');
    const { REASONING_AGENT_IR } =
      await import('@/features/agent-detail/__fixtures__/agent-ir-fixtures');

    const sections = parseIRToSections(REASONING_AGENT_IR);
    // The parsed output should pass Zod validation
    expect(() => SectionModelsSchema.parse(sections)).not.toThrow();
  });
});
```

#### 15b. Bridge re-exports from old store

Add a deprecation comment and re-export from the old store location so existing components continue to work during migration:

```typescript
// src/store/agent-detail-store.ts  (append to existing file — DO NOT delete existing exports)

/**
 * @deprecated Import from '@/features/agent-detail' instead.
 * This file re-exports for backward compatibility during component migration.
 * Remove once all 14 components in components/agent-detail/ are migrated.
 *
 * Migration tracking:
 * - [ ] SectionCard.tsx (213 LOC) — uses SectionId, expandSection
 * - [ ] IdentitySection.tsx (375 LOC) — uses IdentitySectionData, updateSection
 * - [ ] ToolsSection.tsx (812 LOC) — uses ToolSectionData[], updateSection
 * - [ ] GatherSection.tsx (283 LOC) — uses GatherFieldData[], updateSection
 * - [ ] FlowSection.tsx (303 LOC) — uses FlowSectionData, updateSection
 * - [ ] FlowMiniGraph.tsx (290 LOC) — uses FlowSectionData (read-only)
 * - [ ] RulesSection.tsx (463 LOC) — uses RulesSectionData, updateSection
 * - [ ] CoordinationSection.tsx (383 LOC) — uses CoordinationSectionData, updateSection
 * - [ ] BehaviorSection.tsx (149 LOC) — uses BehaviorSectionData (read-only)
 * - [ ] LifecycleSection.tsx (523 LOC) — uses LifecycleSectionData, updateSection
 * - [ ] DslEditorOverlay.tsx (169 LOC) — uses rawIR, agentName
 * - [ ] ChatSlideOver.tsx (101 LOC) — uses agentId, agentName
 * - [ ] StaleToolBanner.tsx (129 LOC) — uses tools section (read-only)
 * - [ ] VersionsSlideOver.tsx (106 LOC) — uses agentId
 *
 * Total: 14 components, 4,299 LOC
 *
 * Migration order (by import complexity, simplest first):
 *   1. ChatSlideOver — 2 fields, read-only
 *   2. VersionsSlideOver — 1 field, read-only
 *   3. StaleToolBanner — 1 section, read-only
 *   4. BehaviorSection — read-only section display
 *   5. FlowMiniGraph — read-only section display
 *   6. SectionCard — expand/collapse only
 *   7. DslEditorOverlay — reads rawIR + agentName
 *   8. GatherSection — section + updateSection
 *   9. FlowSection — section + updateSection
 *  10. IdentitySection — section + updateSection + model config
 *  11. CoordinationSection — section + updateSection (complex sub-sections)
 *  12. RulesSection — section + updateSection (constraints + guardrails)
 *  13. LifecycleSection — section + updateSection (most sub-sections)
 *  14. ToolsSection — section + updateSection (largest component, 812 LOC)
 *
 * Each component migration is a separate PR to keep diffs small.
 */
```

#### 15c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/agent-detail/__tests__/agent-detail.integration.test.ts
npx prettier --write src/features/agent-detail/__tests__/agent-detail.integration.test.ts
git add src/features/agent-detail/__tests__/agent-detail.integration.test.ts
git commit -m "[ABLP-2] test(studio): add agent-detail integration tests and component migration plan"
```

---

## Chunk 3: Cross-cutting + Verification (Tasks 16–19)

### Task 16 — Hook Migration (delegate to `connections.api.ts`)

**Goal:** Refactor `useConnections` and `useAvailableConnectors` to delegate fetching to the new `connections.api.ts` layer while preserving the same public API and SWR caching behavior.

#### 16a. Test: useConnections delegates to connections.api

- [ ] Create `src/features/connections/__tests__/useConnections.test.ts`

```typescript
/**
 * useConnections Hook Migration Tests
 *
 * Verifies the hook delegates fetching to connections.api.ts
 * while preserving SWR caching and the same public API shape.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SWRConfig } from 'swr';
import { createElement, type ReactNode } from 'react';

// Mock the connections API module
vi.mock('@/features/connections/connections.api', () => ({
  fetchConnectionsList: vi.fn(),
}));

import { fetchConnectionsList } from '@/features/connections/connections.api';
import { useConnections } from '@/hooks/useConnections';

const mockedFetch = vi.mocked(fetchConnectionsList);

// Wrapper to disable SWR cache between tests
function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    SWRConfig,
    { value: { dedupingInterval: 0, provider: () => new Map() } },
    children,
  );
}

describe('useConnections (migrated)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty list when projectId is null', () => {
    const { result } = renderHook(() => useConnections(null), { wrapper });
    expect(result.current.connections).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('delegates fetching to connections.api.fetchConnectionsList', async () => {
    const mockConnections = [
      {
        id: 'conn-1',
        connectorName: 'slack',
        displayName: 'My Slack',
        scope: 'tenant' as const,
        authType: 'oauth2' as const,
        status: 'active' as const,
        hasCredentials: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    mockedFetch.mockResolvedValueOnce({
      success: true,
      data: mockConnections,
    });

    const { result } = renderHook(() => useConnections('project-1'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockedFetch).toHaveBeenCalledWith('project-1');
    expect(result.current.connections).toEqual(mockConnections);
    expect(result.current.error).toBeNull();
  });

  it('exposes error when fetch fails', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useConnections('project-1'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Error: Network error');
    });

    expect(result.current.connections).toEqual([]);
  });

  it('exposes a refresh function that re-fetches', async () => {
    mockedFetch.mockResolvedValue({ success: true, data: [] });

    const { result } = renderHook(() => useConnections('project-1'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Trigger refresh
    result.current.refresh();

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });
  });
});
```

#### 16b. Test: useAvailableConnectors delegates to connections.api

- [ ] Create `src/features/connections/__tests__/useAvailableConnectors.test.ts`

```typescript
/**
 * useAvailableConnectors Hook Migration Tests
 *
 * Verifies the hook delegates fetching to connections.api.ts
 * while preserving SWR caching and the same public API shape.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SWRConfig } from 'swr';
import { createElement, type ReactNode } from 'react';

vi.mock('@/features/connections/connections.api', () => ({
  fetchConnectorCatalog: vi.fn(),
}));

import { fetchConnectorCatalog } from '@/features/connections/connections.api';
import { useAvailableConnectors } from '@/hooks/useAvailableConnectors';

const mockedFetch = vi.mocked(fetchConnectorCatalog);

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    SWRConfig,
    { value: { dedupingInterval: 0, provider: () => new Map() } },
    children,
  );
}

describe('useAvailableConnectors (migrated)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty list when projectId is null', () => {
    const { result } = renderHook(() => useAvailableConnectors(null), {
      wrapper,
    });
    expect(result.current.connectors).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('delegates fetching to connections.api.fetchConnectorCatalog', async () => {
    const mockConnectors = [
      {
        name: 'slack',
        displayName: 'Slack',
        description: 'Slack connector',
        category: 'messaging',
        authType: 'oauth2' as const,
      },
    ];

    mockedFetch.mockResolvedValueOnce({
      success: true,
      data: mockConnectors,
    });

    const { result } = renderHook(() => useAvailableConnectors('project-1'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockedFetch).toHaveBeenCalledWith('project-1');
    expect(result.current.connectors).toEqual(mockConnectors);
    expect(result.current.error).toBeNull();
  });

  it('normalizes legacy auth.type to authType', async () => {
    const legacyConnector = {
      name: 'custom',
      displayName: 'Custom',
      // authType missing, but legacy `auth.type` present — API layer normalizes this
    };

    mockedFetch.mockResolvedValueOnce({
      success: true,
      data: [legacyConnector],
    });

    const { result } = renderHook(() => useAvailableConnectors('project-1'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.connectors).toHaveLength(1);
    });
  });

  it('exposes a refresh function', async () => {
    mockedFetch.mockResolvedValue({ success: true, data: [] });

    const { result } = renderHook(() => useAvailableConnectors('project-1'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    result.current.refresh();

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });
  });
});
```

#### 16c. Implement: Refactor useConnections

- [ ] Update `src/hooks/useConnections.ts` — delegate to `connections.api.ts`

```typescript
/**
 * useConnections Hook
 *
 * Fetches and manages the connections list for a project.
 * Uses SWR for dedup, stale-while-revalidate, and background refresh.
 *
 * MIGRATED: Delegates fetching to features/connections/connections.api.ts.
 * The hook retains SWR orchestration and the same public API.
 */

'use client';

import useSWR from 'swr';
import { type ConnectionSummary } from '@/features/connections/connections.types';
import { fetchConnectionsList } from '@/features/connections/connections.api';

// Re-export the type so existing consumers of `import { ConnectionSummary } from '../api/connections'`
// that migrated to this hook still resolve.
export type { ConnectionSummary };

interface UseConnectionsReturn {
  connections: ConnectionSummary[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useConnections(projectId: string | null): UseConnectionsReturn {
  const key = projectId ? ['connections', projectId] : null;

  const { data, error, isLoading, mutate } = useSWR(key, () => fetchConnectionsList(projectId!), {
    keepPreviousData: true,
  });

  return {
    connections: data?.data ?? [],
    isLoading,
    error: error ? String(error) : null,
    refresh: () => {
      void mutate();
    },
  };
}
```

#### 16d. Implement: Refactor useAvailableConnectors

- [ ] Update `src/hooks/useAvailableConnectors.ts` — delegate to `connections.api.ts`

```typescript
/**
 * useAvailableConnectors Hook
 *
 * Fetches available connector packages for a project.
 * Uses SWR for dedup, stale-while-revalidate, and background refresh.
 *
 * MIGRATED: Delegates fetching to features/connections/connections.api.ts.
 * The hook retains SWR orchestration and the same public API.
 */

'use client';

import useSWR from 'swr';
import { type ConnectorSummary } from '@/features/connections/connections.types';
import { fetchConnectorCatalog } from '@/features/connections/connections.api';

// Re-export for backward compatibility
export type { ConnectorSummary };

interface UseAvailableConnectorsReturn {
  connectors: ConnectorSummary[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAvailableConnectors(projectId: string | null): UseAvailableConnectorsReturn {
  const key = projectId ? ['connectors', projectId] : null;

  const { data, error, isLoading, mutate } = useSWR(key, () => fetchConnectorCatalog(projectId!), {
    keepPreviousData: true,
  });

  return {
    connectors: data?.data ?? [],
    isLoading,
    error: error ? String(error) : null,
    refresh: () => {
      void mutate();
    },
  };
}
```

#### 16e. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/connections/__tests__/useConnections.test.ts src/features/connections/__tests__/useAvailableConnectors.test.ts
npx prettier --write src/hooks/useConnections.ts src/hooks/useAvailableConnectors.ts src/features/connections/__tests__/useConnections.test.ts src/features/connections/__tests__/useAvailableConnectors.test.ts
git add src/hooks/useConnections.ts src/hooks/useAvailableConnectors.ts src/features/connections/__tests__/useConnections.test.ts src/features/connections/__tests__/useAvailableConnectors.test.ts
git commit -m "[ABLP-2] refactor(studio): migrate useConnections and useAvailableConnectors to delegate to connections.api"
```

---

### Task 17 — Barrel Re-exports for Backward Compatibility

**Goal:** Replace original API/store files with thin barrel re-exports from feature modules. Existing consumers keep working without import changes.

#### 17a. Test: barrel re-exports resolve correctly

- [ ] Create `src/features/connections/__tests__/barrel-reexports.test.ts`

```typescript
/**
 * Barrel Re-export Tests
 *
 * Verifies that the old import paths still resolve to the same
 * types and functions after migration to feature modules.
 */

import { describe, it, expect } from 'vitest';

describe('barrel re-exports: connections', () => {
  it('src/api/connections.ts re-exports all connection types and functions', async () => {
    const barrel = await import('@/api/connections');

    // Types are verified at compile time; verify runtime exports
    expect(barrel.listConnections).toBeTypeOf('function');
    expect(barrel.getConnection).toBeTypeOf('function');
    expect(barrel.createConnection).toBeTypeOf('function');
    expect(barrel.updateConnection).toBeTypeOf('function');
    expect(barrel.deleteConnection).toBeTypeOf('function');
    expect(barrel.testConnection).toBeTypeOf('function');
    expect(barrel.handleOAuthCallback).toBeTypeOf('function');
    expect(barrel.normalizeConnection).toBeTypeOf('function');
  });

  it('src/api/channels.ts re-exports all channel types and functions', async () => {
    const barrel = await import('@/api/channels');

    expect(barrel.fetchChannels).toBeTypeOf('function');
    expect(barrel.createChannel).toBeTypeOf('function');
    expect(barrel.updateChannel).toBeTypeOf('function');
    expect(barrel.deleteChannel).toBeTypeOf('function');
  });

  it('src/api/channel-connections.ts re-exports all channel-connection functions', async () => {
    const barrel = await import('@/api/channel-connections');

    expect(barrel.fetchConnections).toBeTypeOf('function');
    expect(barrel.fetchConnection).toBeTypeOf('function');
    expect(barrel.createConnection).toBeTypeOf('function');
    expect(barrel.updateConnection).toBeTypeOf('function');
    expect(barrel.deleteConnection).toBeTypeOf('function');
  });

  it('src/api/channel-oauth.ts re-exports all OAuth functions', async () => {
    const barrel = await import('@/api/channel-oauth');

    expect(barrel.initiateChannelOAuth).toBeTypeOf('function');
    expect(barrel.exchangeChannelOAuthCode).toBeTypeOf('function');
  });
});

describe('barrel re-exports: agent-detail', () => {
  it('src/store/agent-detail-store.ts re-exports all store exports', async () => {
    const barrel = await import('@/store/agent-detail-store');

    // Store hook
    expect(barrel.useAgentDetailStore).toBeTypeOf('function');

    // Pure functions
    expect(barrel.parseIRToSections).toBeTypeOf('function');
    expect(barrel.computeVisibleSections).toBeTypeOf('function');

    // Selectors
    expect(barrel.selectIsExpanded).toBeTypeOf('function');
    expect(barrel.selectSectionData).toBeTypeOf('function');
  });
});
```

#### 17b. Implement: Replace `src/api/connections.ts` with barrel

- [ ] Replace `src/api/connections.ts` contents

```typescript
/**
 * Connections API Client — Barrel Re-export
 *
 * MIGRATED: All implementation moved to features/connections/connections.api.ts.
 * This file re-exports everything for backward compatibility.
 *
 * Consumers should migrate imports to:
 *   import { ... } from '@/features/connections'
 */

export {
  // Types
  type ConnectionSummary,
  type ConnectionDetail,
  type ConnectionSummaryRaw,
  // Functions
  normalizeConnection,
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  handleOAuthCallback,
} from '@/features/connections/connections.api';
```

#### 17c. Implement: Replace `src/api/channels.ts` with barrel

- [ ] Replace `src/api/channels.ts` contents

```typescript
/**
 * Channels API Client — Barrel Re-export
 *
 * MIGRATED: All implementation moved to features/connections/connections.api.ts.
 * This file re-exports everything for backward compatibility.
 */

export {
  // Types
  type SDKChannel,
  type CreateChannelInput,
  type UpdateChannelInput,
  // Functions
  fetchChannels,
  createChannel,
  updateChannel,
  deleteChannel,
} from '@/features/connections/connections.api';
```

#### 17d. Implement: Replace `src/api/channel-connections.ts` with barrel

- [ ] Replace `src/api/channel-connections.ts` contents

```typescript
/**
 * Channel Connections API Client — Barrel Re-export
 *
 * MIGRATED: All implementation moved to features/connections/connections.api.ts.
 * This file re-exports everything for backward compatibility.
 */

export {
  // Types
  type ChannelEnvironment,
  type ChannelConnectionSummary,
  type CreateConnectionInput as CreateChannelConnectionInput,
  type UpdateConnectionInput as UpdateChannelConnectionInput,
  // Functions — use original names for backward compat
  fetchConnections,
  fetchConnection,
  // Note: createConnection, updateConnection, deleteConnection collide with
  // connector-connection names. Re-exported under channel-specific aliases.
  createConnection,
  updateConnection,
  deleteConnection,
} from '@/features/connections/connections.api';
```

> **Implementation note:** If the feature API renames these to avoid collision (e.g., `createChannelConnection`), update the barrel to use `export { createChannelConnection as createConnection }` so callers see the original name.

#### 17e. Implement: Replace `src/api/channel-oauth.ts` with barrel

- [ ] Replace `src/api/channel-oauth.ts` contents

```typescript
/**
 * Channel OAuth API Client — Barrel Re-export
 *
 * MIGRATED: All implementation moved to features/connections/connections.api.ts.
 * This file re-exports everything for backward compatibility.
 */

export {
  // Types
  type ChannelOAuthAuthorizeResponse,
  type ChannelOAuthCallbackResult,
  // Functions
  initiateChannelOAuth,
  exchangeChannelOAuthCode,
} from '@/features/connections/connections.api';
```

#### 17f. Implement: Replace `src/store/agent-detail-store.ts` with barrel

- [ ] Replace `src/store/agent-detail-store.ts` contents

```typescript
/**
 * Agent Detail Store — Barrel Re-export
 *
 * MIGRATED: All implementation moved to features/agent-detail/.
 * This file re-exports everything for backward compatibility.
 *
 * Consumers should migrate imports to:
 *   import { ... } from '@/features/agent-detail'
 */

// ---- Types ----
export type {
  SectionId,
  SaveStatus,
  IdentitySectionData,
  ToolSectionData,
  ToolParameterData,
  GatherFieldData,
  FlowStepData,
  FlowSectionData,
  RulesSectionData,
  ConstraintData,
  GuardrailData,
  EscalationRouting,
  EscalationSectionData,
  CoordinationSectionData,
  DelegateData,
  HandoffData,
  BehaviorProfileRef,
  BehaviorSectionData,
  LifecycleSectionData,
  ErrorHandlerData,
  CompletionConditionData,
  MemoryConfigData,
  SectionModels,
} from '@/features/agent-detail';

// ---- Store ----
export { useAgentDetailStore } from '@/features/agent-detail';

// ---- Pure functions ----
export { parseIRToSections, computeVisibleSections } from '@/features/agent-detail';

// ---- Selectors ----
export { selectIsExpanded, selectSectionData } from '@/features/agent-detail';
```

#### 17g. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/connections/__tests__/barrel-reexports.test.ts
pnpm build --filter=studio
npx prettier --write src/api/connections.ts src/api/channels.ts src/api/channel-connections.ts src/api/channel-oauth.ts src/store/agent-detail-store.ts src/features/connections/__tests__/barrel-reexports.test.ts
git add src/api/connections.ts src/api/channels.ts src/api/channel-connections.ts src/api/channel-oauth.ts src/store/agent-detail-store.ts src/features/connections/__tests__/barrel-reexports.test.ts
git commit -m "[ABLP-2] refactor(studio): replace original API/store files with barrel re-exports from feature modules"
```

---

### Task 18 — Integration Tests

**Goal:** End-to-end lifecycle tests for both feature modules using fixtures from Tasks 5 and 13.

#### 18a. Connections integration test: full CRUD lifecycle

- [ ] Create `src/features/connections/__tests__/connections.integration.test.ts`

```typescript
/**
 * Connections Feature — Integration Test
 *
 * Full CRUD lifecycle: list → create → test → delete.
 * Uses the store + API layer together against mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';

// Import from the feature barrel
import { useConnectionsStore, ConnectionSummarySchema } from '@/features/connections';

// Use fixtures from Task 5
import connectionSummaryFixture from '@/features/connections/__fixtures__/connection-summary.json';
import connectionDetailFixture from '@/features/connections/__fixtures__/connection-detail.json';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Connections Feature — CRUD Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store between tests
    act(() => {
      useConnectionsStore.getState().reset();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists connections and validates against schema', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [connectionSummaryFixture] }),
    );

    const store = useConnectionsStore.getState();
    await act(async () => {
      await store.loadConnections('project-1');
    });

    const state = useConnectionsStore.getState();
    expect(state.connections).toHaveLength(1);

    // Validate fixture conforms to Zod schema
    const parsed = ConnectionSummarySchema.safeParse(state.connections[0]);
    expect(parsed.success).toBe(true);
  });

  it('creates a connection and adds it to the list', async () => {
    // Initial list
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    const store = useConnectionsStore.getState();
    await act(async () => {
      await store.loadConnections('project-1');
    });

    expect(useConnectionsStore.getState().connections).toHaveLength(0);

    // Create
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: connectionSummaryFixture }),
    );

    await act(async () => {
      await store.createConnection('project-1', {
        connectorName: 'slack',
        displayName: 'My Slack',
      });
    });

    expect(useConnectionsStore.getState().connections).toHaveLength(1);
    expect(useConnectionsStore.getState().connections[0].displayName).toBe(
      connectionSummaryFixture.displayName,
    );
  });

  it('tests a connection and stores the result', async () => {
    // Seed list
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [connectionSummaryFixture] }),
    );

    const store = useConnectionsStore.getState();
    await act(async () => {
      await store.loadConnections('project-1');
    });

    const connId = useConnectionsStore.getState().connections[0].id;

    // Test endpoint
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { message: 'Connected' } }),
    );

    await act(async () => {
      await store.testConnection('project-1', connId);
    });

    const testResult = useConnectionsStore.getState().testResults[connId];
    expect(testResult).toBeDefined();
    expect(testResult.success).toBe(true);
  });

  it('deletes a connection and removes it from the list', async () => {
    // Seed list
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [connectionSummaryFixture] }),
    );

    const store = useConnectionsStore.getState();
    await act(async () => {
      await store.loadConnections('project-1');
    });

    expect(useConnectionsStore.getState().connections).toHaveLength(1);

    const connId = useConnectionsStore.getState().connections[0].id;

    // Delete
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

    await act(async () => {
      await store.deleteConnection('project-1', connId);
    });

    expect(useConnectionsStore.getState().connections).toHaveLength(0);
  });

  it('handles API errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404),
    );

    const store = useConnectionsStore.getState();

    await act(async () => {
      await store.loadConnections('project-1').catch(() => {
        /* expected */
      });
    });

    const state = useConnectionsStore.getState();
    expect(state.error).toBeTruthy();
    expect(state.connections).toHaveLength(0);
  });
});
```

#### 18b. Agent Detail integration test: load IR → parse → update → verify

- [ ] Create `src/features/agent-detail/__tests__/agent-detail.crud-integration.test.ts`

```typescript
/**
 * Agent Detail Feature — Integration Test
 *
 * Load agent IR → parse sections → update a section → verify store state.
 * Uses the store + ir-parser together.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act } from '@testing-library/react';

import {
  useAgentDetailStore,
  parseIRToSections,
  computeVisibleSections,
  selectSectionData,
  selectIsExpanded,
} from '@/features/agent-detail';

// Use fixtures from Task 13
import fullIR from '@/features/agent-detail/__fixtures__/agent-ir-full.json';
import minimalIR from '@/features/agent-detail/__fixtures__/agent-ir-minimal.json';

describe('Agent Detail Feature — Integration', () => {
  beforeEach(() => {
    act(() => {
      useAgentDetailStore.getState().reset();
    });
  });

  describe('load and parse IR', () => {
    it('loads a full IR and populates all sections', () => {
      act(() => {
        useAgentDetailStore.getState().loadFromIR(fullIR, 'agent-1');
      });

      const state = useAgentDetailStore.getState();
      expect(state.agentId).toBe('agent-1');
      expect(state.sections.identity.goal).toBeTruthy();
      expect(state.sections.tools.length).toBeGreaterThan(0);
      expect(state.visibleSections).toContain('IDENTITY');
      expect(state.visibleSections).toContain('TOOLS');
    });

    it('loads a minimal IR without errors', () => {
      act(() => {
        useAgentDetailStore.getState().loadFromIR(minimalIR, 'agent-2');
      });

      const state = useAgentDetailStore.getState();
      expect(state.agentId).toBe('agent-2');
      expect(state.sections.tools).toEqual([]);
      expect(state.sections.gather).toEqual([]);
      expect(state.sections.flow).toBeNull();
    });
  });

  describe('section updates', () => {
    it('updates identity section and recomputes visibility', () => {
      act(() => {
        useAgentDetailStore.getState().loadFromIR(fullIR, 'agent-1');
      });

      const updatedIdentity = {
        ...useAgentDetailStore.getState().sections.identity,
        goal: 'Updated goal text',
        persona: 'Updated persona',
      };

      act(() => {
        useAgentDetailStore.getState().updateSection('identity', updatedIdentity);
      });

      const state = useAgentDetailStore.getState();
      expect(state.sections.identity.goal).toBe('Updated goal text');
      expect(state.sections.identity.persona).toBe('Updated persona');
    });

    it('updates tools section with a new tool', () => {
      act(() => {
        useAgentDetailStore.getState().loadFromIR(fullIR, 'agent-1');
      });

      const currentTools = useAgentDetailStore.getState().sections.tools;
      const newTool = {
        name: 'new_tool',
        description: 'A new tool',
        parameters: [],
        returns: { type: 'string' },
        hints: {},
      };

      act(() => {
        useAgentDetailStore.getState().updateSection('tools', [...currentTools, newTool]);
      });

      const tools = useAgentDetailStore.getState().sections.tools;
      expect(tools).toHaveLength(currentTools.length + 1);
      expect(tools[tools.length - 1].name).toBe('new_tool');
    });
  });

  describe('accordion state', () => {
    it('expands and collapses sections', () => {
      act(() => {
        useAgentDetailStore.getState().loadFromIR(fullIR, 'agent-1');
      });

      act(() => {
        useAgentDetailStore.getState().expandSection('TOOLS');
      });

      expect(selectIsExpanded('TOOLS')(useAgentDetailStore.getState())).toBe(true);
      expect(selectIsExpanded('IDENTITY')(useAgentDetailStore.getState())).toBe(false);

      act(() => {
        useAgentDetailStore.getState().collapseSection();
      });

      expect(useAgentDetailStore.getState().expandedSection).toBeNull();
    });

    it('preserves expanded section when reloading same agent', () => {
      act(() => {
        useAgentDetailStore.getState().loadFromIR(fullIR, 'agent-1');
        useAgentDetailStore.getState().expandSection('RULES');
      });

      // Reload same agent (e.g., after auto-save)
      act(() => {
        useAgentDetailStore.getState().loadFromIR(fullIR, 'agent-1');
      });

      expect(useAgentDetailStore.getState().expandedSection).toBe('RULES');
    });

    it('resets expanded section when switching to different agent', () => {
      act(() => {
        useAgentDetailStore.getState().loadFromIR(fullIR, 'agent-1');
        useAgentDetailStore.getState().expandSection('RULES');
      });

      act(() => {
        useAgentDetailStore.getState().loadFromIR(minimalIR, 'agent-2');
      });

      expect(useAgentDetailStore.getState().expandedSection).toBeNull();
    });
  });

  describe('selectors', () => {
    it('selectSectionData returns correct section', () => {
      act(() => {
        useAgentDetailStore.getState().loadFromIR(fullIR, 'agent-1');
      });

      const identity = selectSectionData('identity')(useAgentDetailStore.getState());
      expect(identity.goal).toBeTruthy();
    });
  });

  describe('save status tracking', () => {
    it('transitions through save states', () => {
      act(() => {
        useAgentDetailStore.getState().loadFromIR(fullIR, 'agent-1');
      });

      expect(useAgentDetailStore.getState().saveStatus).toBe('idle');

      act(() => {
        useAgentDetailStore.getState().setSaveStatus('saving');
      });
      expect(useAgentDetailStore.getState().saveStatus).toBe('saving');

      act(() => {
        useAgentDetailStore.getState().setSaveStatus('saved');
      });
      expect(useAgentDetailStore.getState().saveStatus).toBe('saved');
    });

    it('records save errors', () => {
      act(() => {
        useAgentDetailStore.getState().setSaveStatus('error', 'Network timeout');
      });

      const state = useAgentDetailStore.getState();
      expect(state.saveStatus).toBe('error');
      expect(state.saveError).toBe('Network timeout');
    });
  });

  describe('parseIRToSections (pure function)', () => {
    it('returns all section keys', () => {
      const sections = parseIRToSections(fullIR);
      expect(Object.keys(sections)).toEqual(
        expect.arrayContaining([
          'identity',
          'tools',
          'gather',
          'flow',
          'rules',
          'coordination',
          'behavior',
          'lifecycle',
        ]),
      );
    });

    it('handles empty IR gracefully', () => {
      const sections = parseIRToSections({});
      expect(sections.identity.goal).toBe('');
      expect(sections.tools).toEqual([]);
      expect(sections.flow).toBeNull();
    });
  });

  describe('computeVisibleSections', () => {
    it('includes FLOW when flow data is present', () => {
      const sections = parseIRToSections(fullIR);
      if (sections.flow) {
        const visible = computeVisibleSections(sections);
        expect(visible).toContain('FLOW');
      }
    });

    it('excludes FLOW when flow data is null', () => {
      const sections = parseIRToSections(minimalIR);
      const visible = computeVisibleSections(sections);
      expect(visible).not.toContain('FLOW');
    });
  });
});
```

#### 18c. Verify & commit

```bash
cd apps/studio && npx vitest run src/features/connections/__tests__/connections.integration.test.ts src/features/agent-detail/__tests__/agent-detail.crud-integration.test.ts
npx prettier --write src/features/connections/__tests__/connections.integration.test.ts src/features/agent-detail/__tests__/agent-detail.crud-integration.test.ts
git add src/features/connections/__tests__/connections.integration.test.ts src/features/agent-detail/__tests__/agent-detail.crud-integration.test.ts
git commit -m "[ABLP-2] test(studio): add connections CRUD and agent-detail integration tests"
```

---

### Task 19 — Build Verification

**Goal:** Confirm the full studio build passes, all feature tests pass, no regressions in existing tests, and no circular dependencies.

#### 19a. Full studio build

- [ ] Run full build

```bash
pnpm build --filter=studio
```

**Expected:** Clean build with zero type errors. If errors occur, fix them before proceeding.

#### 19b. Run all feature module tests

- [ ] Run connections feature tests

```bash
cd apps/studio && npx vitest run src/features/connections/__tests__/
```

- [ ] Run agent-detail feature tests

```bash
cd apps/studio && npx vitest run src/features/agent-detail/__tests__/
```

**Expected:** All tests pass (contracts, stores, API layers, hooks, integration, barrel re-exports).

#### 19c. Run existing test suites — verify no regressions

- [ ] Run full studio test suite

```bash
cd apps/studio && npx vitest run
```

**Expected:** All pre-existing tests pass. Zero regressions from the barrel re-exports in Task 17.

#### 19d. Check for circular dependencies

- [ ] Verify no circular imports exist in feature modules

```bash
# Use madge if available, otherwise manual check
npx madge --circular --extensions ts,tsx apps/studio/src/features/connections/ apps/studio/src/features/agent-detail/ 2>/dev/null || echo "madge not available — manual check below"

# Manual check: feature modules should NOT import from src/api/ or src/store/ (only the reverse)
# The barrels in src/api/ and src/store/ import FROM features, never the other way.
grep -r "from.*'\.\./\.\./api/" apps/studio/src/features/ && echo "CIRCULAR: feature imports from src/api/" || echo "OK: no feature → src/api/ imports"
grep -r "from.*'\.\./\.\./store/" apps/studio/src/features/ && echo "CIRCULAR: feature imports from src/store/" || echo "OK: no feature → src/store/ imports"
```

**Expected:**

- No circular dependencies detected.
- Feature modules import only from `@/lib/`, `@/config/`, `@/components/`, or other features — never from `@/api/` or `@/store/` (those are now barrel wrappers).

#### 19e. Summary checklist

- [ ] `pnpm build --filter=studio` — zero errors
- [ ] All `src/features/connections/__tests__/` — pass
- [ ] All `src/features/agent-detail/__tests__/` — pass
- [ ] Full `npx vitest run` — zero regressions
- [ ] No circular dependencies between features ↔ legacy barrels
- [ ] All barrel re-exports resolve (Task 17 test)

#### 19f. Final commit

```bash
npx prettier --write apps/studio/src/features/**/*.ts apps/studio/src/features/**/*.tsx
git add -A
git commit -m "[ABLP-2] chore(studio): Phase 3 build verification — all tests pass, no circular deps"
```
