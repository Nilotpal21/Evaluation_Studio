import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { ConnectorConnection } from '../models/connector-connection.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

const validConnection = () => ({
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  connectorName: 'slack',
  displayName: 'Slack Integration',
  scope: 'tenant' as const,
  authProfileId: 'ap-1',
});

describe('ConnectorConnection', () => {
  it('sets default fields on instantiation', () => {
    const conn = new ConnectorConnection(validConnection());
    expect(conn._id).toBeDefined();
    expect(conn.tenantId).toBe('tenant-1');
    expect(conn.projectId).toBe('proj-1');
    expect(conn.connectorName).toBe('slack');
    expect(conn.displayName).toBe('Slack Integration');
    expect(conn.scope).toBe('tenant');
    expect(conn.userId).toBeNull();
    expect(conn.authProfileId).toBe('ap-1');
    expect(conn.status).toBe('active');
  });

  it('accepts optional metadata', () => {
    const conn = new ConnectorConnection({
      ...validConnection(),
      metadata: {
        baseUrl: 'https://smartassist.example.com',
        appId: 'app-123',
      },
    });
    const err = conn.validateSync();
    expect(err).toBeUndefined();
    expect(conn.metadata).toEqual({
      baseUrl: 'https://smartassist.example.com',
      appId: 'app-123',
    });
  });

  it('requires tenantId', () => {
    const data = validConnection();
    delete (data as any).tenantId;
    const err = new ConnectorConnection(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validConnection();
    delete (data as any).projectId;
    const err = new ConnectorConnection(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires connectorName', () => {
    const data = validConnection();
    delete (data as any).connectorName;
    const err = new ConnectorConnection(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.connectorName).toBeDefined();
  });

  it('requires displayName', () => {
    const data = validConnection();
    delete (data as any).displayName;
    const err = new ConnectorConnection(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.displayName).toBeDefined();
  });

  it('requires scope', () => {
    const data = validConnection();
    delete (data as any).scope;
    const err = new ConnectorConnection(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.scope).toBeDefined();
  });

  it('requires authProfileId', () => {
    const data = validConnection();
    delete (data as any).authProfileId;
    const err = new ConnectorConnection(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.authProfileId).toBeDefined();
  });

  it('validates scope enum', () => {
    const err = new ConnectorConnection({
      ...validConnection(),
      scope: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.scope).toBeDefined();
  });

  it('accepts valid scope values', () => {
    for (const scope of ['tenant', 'user']) {
      const err = new ConnectorConnection({ ...validConnection(), scope }).validateSync();
      expect(err).toBeUndefined();
    }
  });

  it('validates status enum', () => {
    const err = new ConnectorConnection({
      ...validConnection(),
      status: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    for (const status of ['active', 'expired', 'revoked']) {
      const conn = new ConnectorConnection({ ...validConnection(), status });
      const err = conn.validateSync();
      expect(err).toBeUndefined();
      expect(conn.status).toBe(status);
    }
  });

  it('enforces unique tenantId+projectId+connectorName+authProfileId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ConnectorConnection.create(validConnection());
    await expect(ConnectorConnection.create(validConnection())).rejects.toThrow(/duplicate key/i);
  });

  it('allows same connector with different authProfileId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ConnectorConnection.create(validConnection());
    const differentProfile = {
      ...validConnection(),
      authProfileId: 'ap-2',
    };
    const doc = await ConnectorConnection.create(differentProfile);
    expect(doc.authProfileId).toBe('ap-2');
  });

  it('allows same connector with different scope and userId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await ConnectorConnection.create(validConnection());
    const userScoped = {
      ...validConnection(),
      scope: 'user',
      userId: 'user-1',
      authProfileId: 'ap-user',
    };
    const doc = await ConnectorConnection.create(userScoped);
    expect(doc.scope).toBe('user');
    expect(doc.userId).toBe('user-1');
  });
});
