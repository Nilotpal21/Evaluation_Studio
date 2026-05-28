import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConnectionsAssembler,
  extractAuthProfileRequirementsFromConnections,
} from '../export/layer-assemblers/connections-assembler.js';

vi.mock('@agent-platform/database', () => ({
  ConnectorConnection: { find: vi.fn(), countDocuments: vi.fn() },
  ConnectorConfig: { find: vi.fn(), countDocuments: vi.fn() },
  SearchIndex: { find: vi.fn(), countDocuments: vi.fn() },
  SearchSource: { find: vi.fn(), countDocuments: vi.fn() },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  ConnectorConnection,
  ConnectorConfig,
  SearchIndex,
  SearchSource,
} from '@agent-platform/database';

const CTX = { projectId: 'proj-1', tenantId: 'tenant-1' };

function mockLean(data: unknown[]) {
  const leanResult = Object.assign(Promise.resolve(data), {
    select: () => Promise.resolve(data),
  });
  return { lean: () => leanResult };
}

describe('ConnectionsAssembler', () => {
  let assembler: ConnectionsAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
    assembler = new ConnectionsAssembler();
    (SearchIndex.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (SearchSource.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
  });

  it('should have layer name "connections"', () => {
    expect(assembler.layer).toBe('connections');
  });

  it('should strip encrypted credentials from connections', async () => {
    (ConnectorConnection.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'conn-1',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          connectorName: 'slack',
          displayName: 'Slack Integration',
          scope: 'tenant',
          authType: 'oauth2',
          encryptedCredentials: 'encrypted-secret-data',
          encryptionKeyVersion: 1,
          oauth2RefreshToken: 'refresh-token-secret',
          status: 'active',
          scopes: ['chat:write'],
        },
      ]),
    );
    (ConnectorConfig.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);

    expect(result.files.has('connections/connectors/slack_integration.connection.json')).toBe(true);
    const conn = JSON.parse(
      result.files.get('connections/connectors/slack_integration.connection.json')!,
    );

    // Must NOT contain secrets
    expect(conn).not.toHaveProperty('encryptedCredentials');
    expect(conn).not.toHaveProperty('encryptionKeyVersion');
    expect(conn).not.toHaveProperty('oauth2RefreshToken');
    expect(conn).not.toHaveProperty('_id');
    expect(conn).not.toHaveProperty('tenantId');
    expect(conn).not.toHaveProperty('projectId');

    // Should retain safe fields
    expect(conn.connectorName).toBe('slack');
    expect(conn.authType).toBe('oauth2');
    expect(conn.status).toBe('active');
  });

  it('should export connector configs with sync state stripped', async () => {
    (ConnectorConnection.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (SearchIndex.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([{ _id: 'idx-1' }]));
    (SearchSource.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([{ _id: 'src-1' }]));
    (ConnectorConfig.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'cfg-1',
          tenantId: 'tenant-1',
          sourceId: 'src-1',
          connectorType: 'sharepoint',
          oauthTokenId: 'token-1',
          connectionConfig: { tenantUrl: 'https://contoso.sharepoint.com' },
          syncState: { totalDocuments: 500 },
          errorState: { consecutiveFailures: 0 },
          configurationSource: 'manual',
        },
      ]),
    );

    const result = await assembler.assemble(CTX);

    expect(result.files.has('connections/configs/sharepoint.connector-config.json')).toBe(true);
    const cfg = JSON.parse(
      result.files.get('connections/configs/sharepoint.connector-config.json')!,
    );

    expect(cfg).not.toHaveProperty('oauthTokenId');
    expect(cfg).not.toHaveProperty('syncState');
    expect(cfg).not.toHaveProperty('errorState');
    expect(cfg.connectorType).toBe('sharepoint');
    expect(cfg.sourceId).toBe('src-1');
    expect(cfg.connectionConfig.tenantUrl).toBe('https://contoso.sharepoint.com');
    expect(SearchIndex.find).toHaveBeenCalledWith({ projectId: 'proj-1', tenantId: 'tenant-1' });
    expect(SearchSource.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      indexId: { $in: ['idx-1'] },
    });
    expect(ConnectorConfig.find).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      sourceId: { $in: ['src-1'] },
    });
  });

  it('should count entities correctly', async () => {
    (ConnectorConnection.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    (SearchIndex.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([{ _id: 'idx-1' }]));
    (SearchSource.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([{ _id: 'src-1' }, { _id: 'src-2' }]),
    );
    (ConnectorConfig.countDocuments as ReturnType<typeof vi.fn>).mockResolvedValue(2);

    const count = await assembler.countEntities(CTX);
    expect(count).toBe(5);
    expect(ConnectorConfig.countDocuments).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      sourceId: { $in: ['src-1', 'src-2'] },
    });
  });

  it('should return empty result when no connections exist', async () => {
    (ConnectorConnection.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));
    (ConnectorConfig.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);
    expect(result.files.size).toBe(0);
    expect(result.entityCount).toBe(0);
  });

  it('should collect auth profile refs during assembly', async () => {
    (ConnectorConnection.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'conn-1',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          connectorName: 'slack',
          displayName: 'Slack Integration',
          authProfileId: 'profile-123',
          authProfileName: 'slack-oauth-profile',
          authProfile: {
            authType: 'oauth2',
            scope: 'project',
            visibility: 'shared',
            config: { scopes: 'chat:write' },
          },
        },
      ]),
    );
    (ConnectorConfig.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    await assembler.assemble(CTX);

    expect(assembler.lastAuthProfileRefs).toHaveLength(1);
    expect(assembler.lastAuthProfileRefs[0].name).toBe('slack-oauth-profile');
    expect(assembler.lastAuthProfileRefs[0].authType).toBe('oauth2');
    expect(assembler.lastAuthProfileRefs[0].referencedBy).toContain('Slack Integration');
  });

  it('should strip authProfileId from exported connection files', async () => {
    (ConnectorConnection.find as ReturnType<typeof vi.fn>).mockReturnValue(
      mockLean([
        {
          _id: 'conn-1',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          connectorName: 'slack',
          displayName: 'Slack',
          authProfileId: 'profile-123',
          status: 'active',
        },
      ]),
    );
    (ConnectorConfig.find as ReturnType<typeof vi.fn>).mockReturnValue(mockLean([]));

    const result = await assembler.assemble(CTX);
    const conn = JSON.parse(result.files.get('connections/connectors/slack.connection.json')!);
    expect(conn).not.toHaveProperty('authProfileId');
  });
});

describe('extractAuthProfileRequirementsFromConnections', () => {
  it('extracts auth profile requirements from connections', () => {
    const connections = [
      {
        connectorName: 'slack',
        displayName: 'Slack',
        authProfileId: 'p1',
        authProfileName: 'slack-profile',
        authProfile: {
          authType: 'oauth2',
          scope: 'project',
          visibility: 'shared',
          config: { scopes: 'chat:write' },
        },
      },
    ];
    const refs = extractAuthProfileRequirementsFromConnections(connections);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('slack-profile');
    expect(refs[0].authType).toBe('oauth2');
    expect(refs[0].connectionMode).toBe('shared');
  });

  it('deduplicates profiles referenced by multiple connections', () => {
    const connections = [
      {
        connectorName: 'slack',
        displayName: 'Slack A',
        authProfileName: 'shared-profile',
        authProfile: { authType: 'api_key', scope: 'tenant' },
      },
      {
        connectorName: 'teams',
        displayName: 'Teams B',
        authProfileName: 'shared-profile',
        authProfile: { authType: 'api_key', scope: 'tenant' },
      },
    ];
    const refs = extractAuthProfileRequirementsFromConnections(connections);
    expect(refs).toHaveLength(1);
    expect(refs[0].referencedBy).toEqual(['Slack A', 'Teams B']);
  });

  it('returns empty array when no connections have auth profiles', () => {
    const connections = [{ connectorName: 'http', displayName: 'HTTP Call' }];
    const refs = extractAuthProfileRequirementsFromConnections(connections);
    expect(refs).toHaveLength(0);
  });

  it('marks personal visibility as per_user connectionMode', () => {
    const connections = [
      {
        connectorName: 'gmail',
        displayName: 'Gmail',
        authProfileName: 'personal-gmail',
        authProfile: { authType: 'oauth2', scope: 'project', visibility: 'personal' },
      },
    ];
    const refs = extractAuthProfileRequirementsFromConnections(connections);
    expect(refs[0].connectionMode).toBe('per_user');
  });

  it('redacts secret-like config values', () => {
    const connections = [
      {
        connectorName: 'api',
        displayName: 'API',
        authProfileName: 'api-profile',
        authProfile: {
          authType: 'api_key',
          scope: 'project',
          config: { apiKey: 'sk-12345', baseUrl: 'https://api.example.com' },
        },
      },
    ];
    const refs = extractAuthProfileRequirementsFromConnections(connections);
    expect(refs[0].config.apiKey).toBe('***REDACTED***');
    expect(refs[0].config.baseUrl).toBe('https://api.example.com');
  });
});
