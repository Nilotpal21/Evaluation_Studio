import { describe, it, expect } from 'vitest';
import { CreateAuthProfileSchema } from '@agent-platform/shared/validation';
import {
  assertActivepiecesAuthProfileBridgeSupported,
  mapAuth,
  mapPropertyType,
  mapProperty,
  mapAction,
  mapTrigger,
  mapPieceToConnector,
  type APPiece,
  type APPieceAuth,
  type APProperty,
  type APAction,
  type APTrigger,
} from '../adapters/activepieces/type-mapper.js';
import { importPieces, generateConnectorSource } from '../adapters/activepieces/importer.js';

describe('Activepieces Type Mapper', () => {
  describe('mapAuth', () => {
    it('maps OAuth2 auth', () => {
      const apAuth: APPieceAuth = { type: 'OAUTH2' };
      expect(mapAuth(apAuth)).toEqual({ type: 'oauth2' });
    });

    it('maps SECRET_TEXT to api_key', () => {
      const apAuth: APPieceAuth = { type: 'SECRET_TEXT', displayName: 'API Token' };
      const result = mapAuth(apAuth);
      expect(result.type).toBe('api_key');
      expect(result.fields?.[0].name).toBe('apiKey');
      expect(result.fields?.[0].displayName).toBe('API Token');
      expect(result.fields?.[0].sensitive).toBe(true);
    });

    it('maps SECRET_TEXT with default displayName when none provided', () => {
      const result = mapAuth({ type: 'SECRET_TEXT' });
      expect(result.type).toBe('api_key');
      expect(result.fields?.[0].displayName).toBe('API Key');
    });

    it('maps BASIC_AUTH auth', () => {
      const result = mapAuth({ type: 'BASIC_AUTH' });
      expect(result.type).toBe('basic');
      expect(result.fields).toHaveLength(2);
      expect(result.fields?.[0].name).toBe('username');
      expect(result.fields?.[0].sensitive).toBe(false);
      expect(result.fields?.[1].name).toBe('password');
      expect(result.fields?.[1].sensitive).toBe(true);
    });

    it('prefers OAuth2 when auth is declared as an array', () => {
      const result = mapAuth([
        {
          type: 'OAUTH2',
          authUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scope: ['read', 'write'],
        },
        { type: 'CUSTOM_AUTH' },
      ]);
      expect(result.type).toBe('oauth2');
      expect(result.oauth2?.authorizationUrl).toBe('https://example.com/auth');
      expect(result.oauth2?.scopes).toEqual(['read', 'write']);
    });

    it('falls back to the first entry when array has no OAuth2', () => {
      const result = mapAuth([
        { type: 'SECRET_TEXT', displayName: 'API Token' },
        { type: 'CUSTOM_AUTH' },
      ]);
      expect(result.type).toBe('api_key');
    });

    it('maps empty auth array to none', () => {
      expect(mapAuth([])).toEqual({ type: 'none' });
    });

    it('maps CUSTOM_AUTH with props', () => {
      const result = mapAuth({
        type: 'CUSTOM_AUTH',
        props: {
          apiKey: { type: 'SHORT_TEXT', displayName: 'API Key', required: true },
          baseUrl: { type: 'SHORT_TEXT', displayName: 'Base URL', required: true },
        },
      });
      expect(result.type).toBe('custom');
      expect(result.fields).toHaveLength(2);
      expect(result.fields?.[0].name).toBe('apiKey');
      expect(result.fields?.[0].sensitive).toBe(true);
      expect(result.fields?.[1].name).toBe('baseUrl');
    });

    it('maps CUSTOM_AUTH without props to empty fields', () => {
      const result = mapAuth({ type: 'CUSTOM_AUTH' });
      expect(result.type).toBe('custom');
      expect(result.fields).toEqual([]);
    });

    it('fails fast when CUSTOM_AUTH is bridged to an auth profile', () => {
      const mappedAuth = mapAuth({
        type: 'CUSTOM_AUTH',
        props: {
          'X-API-Key': { type: 'SHORT_TEXT', displayName: 'API Key', required: true },
        },
      });

      expect(mappedAuth.type).toBe('custom');
      expect(() => assertActivepiecesAuthProfileBridgeSupported(mappedAuth)).toThrow(
        /CUSTOM_AUTH cannot be bridged to auth profiles/i,
      );
    });

    it('documents that auth profiles reject authType=custom', () => {
      const result = CreateAuthProfileSchema.safeParse({
        name: 'Activepieces Custom Auth',
        projectId: 'proj-1',
        scope: 'project',
        visibility: 'shared',
        authType: 'custom',
        config: { headers: { 'X-API-Key': 'API Key' } },
        secrets: { headerValues: { 'X-API-Key': 'secret-value' } },
      });

      expect(result.success).toBe(false);
    });

    it('maps NONE to none', () => {
      expect(mapAuth({ type: 'NONE' })).toEqual({ type: 'none' });
    });

    it('maps undefined to none', () => {
      expect(mapAuth(undefined)).toEqual({ type: 'none' });
    });

    it('does NOT attach validateAuth — that is the runtime adapter’s job', () => {
      // mapAuth is shared with the build-time codegen path, so it stays
      // structural. validateAuth is attached by wrapActivepiecesPiece via
      // wrapPieceValidate. See wrapPieceValidate / runtime-adapter tests.
      const result = mapAuth({ type: 'SECRET_TEXT', validate: async () => ({ valid: true }) });
      expect(result.validateAuth).toBeUndefined();
    });
  });

  describe('mapPropertyType', () => {
    it('maps SHORT_TEXT -> string', () => {
      expect(mapPropertyType('SHORT_TEXT')).toBe('string');
    });

    it('maps LONG_TEXT -> string', () => {
      expect(mapPropertyType('LONG_TEXT')).toBe('string');
    });

    it('maps NUMBER -> number', () => {
      expect(mapPropertyType('NUMBER')).toBe('number');
    });

    it('maps CHECKBOX -> boolean', () => {
      expect(mapPropertyType('CHECKBOX')).toBe('boolean');
    });

    it('maps DROPDOWN -> dropdown', () => {
      expect(mapPropertyType('DROPDOWN')).toBe('dropdown');
    });

    it('maps STATIC_DROPDOWN -> dropdown', () => {
      expect(mapPropertyType('STATIC_DROPDOWN')).toBe('dropdown');
    });

    it('maps MULTI_SELECT_DROPDOWN -> multi_select_dropdown', () => {
      expect(mapPropertyType('MULTI_SELECT_DROPDOWN')).toBe('multi_select_dropdown');
    });

    it('maps DYNAMIC -> dynamic_dropdown', () => {
      expect(mapPropertyType('DYNAMIC')).toBe('dynamic_dropdown');
    });

    it('maps ARRAY -> array', () => {
      expect(mapPropertyType('ARRAY')).toBe('array');
    });

    it('maps OBJECT -> json', () => {
      expect(mapPropertyType('OBJECT')).toBe('json');
    });

    it('maps JSON -> json', () => {
      expect(mapPropertyType('JSON')).toBe('json');
    });

    it('maps DATE_TIME -> date', () => {
      expect(mapPropertyType('DATE_TIME')).toBe('date');
    });

    it('maps FILE -> file', () => {
      expect(mapPropertyType('FILE')).toBe('file');
    });
  });

  describe('mapProperty', () => {
    it('maps a basic property with all fields', () => {
      const prop: APProperty = {
        type: 'SHORT_TEXT',
        displayName: 'Channel Name',
        required: true,
        description: 'The Slack channel',
      };
      const result = mapProperty('channel', prop);
      expect(result).toMatchObject({
        name: 'channel',
        displayName: 'Channel Name',
        type: 'string',
        required: true,
        description: 'The Slack channel',
      });
    });

    it('defaults required to false when not specified', () => {
      const prop: APProperty = {
        type: 'NUMBER',
        displayName: 'Count',
      };
      const result = mapProperty('count', prop);
      expect(result.required).toBe(false);
    });

    it('includes defaultValue when present', () => {
      const prop: APProperty = {
        type: 'NUMBER',
        displayName: 'Limit',
        defaultValue: 10,
      };
      const result = mapProperty('limit', prop);
      expect(result.defaultValue).toBe(10);
    });

    it('omits defaultValue when not present', () => {
      const prop: APProperty = {
        type: 'SHORT_TEXT',
        displayName: 'Name',
      };
      const result = mapProperty('name', prop);
      expect(result.defaultValue).toBeUndefined();
    });

    it('includes dropdown options for STATIC_DROPDOWN', () => {
      const prop: APProperty = {
        type: 'STATIC_DROPDOWN',
        displayName: 'Priority',
        options: [
          { label: 'High', value: 'high' },
          { label: 'Low', value: 'low' },
        ],
      };
      const result = mapProperty('priority', prop);
      expect(result.options).toHaveLength(2);
      expect(result.options?.[0]).toEqual({ label: 'High', value: 'high' });
    });

    it('includes dropdown options for DROPDOWN type', () => {
      const prop: APProperty = {
        type: 'DROPDOWN',
        displayName: 'Status',
        options: [{ label: 'Active', value: 'active' }],
      };
      const result = mapProperty('status', prop);
      expect(result.options).toHaveLength(1);
    });

    it('does not include options for non-dropdown types', () => {
      const prop: APProperty = {
        type: 'SHORT_TEXT',
        displayName: 'Text',
        options: [{ label: 'X', value: 'x' }], // should be ignored
      };
      const result = mapProperty('text', prop);
      expect(result.options).toBeUndefined();
    });

    it('omits description when not present', () => {
      const prop: APProperty = {
        type: 'CHECKBOX',
        displayName: 'Enabled',
      };
      const result = mapProperty('enabled', prop);
      expect(result.description).toBeUndefined();
    });
  });

  describe('mapAction', () => {
    it('maps an action with props', () => {
      const action: APAction = {
        name: 'send_message',
        displayName: 'Send Message',
        description: 'Sends a message to a channel',
        props: {
          channel: { type: 'SHORT_TEXT', displayName: 'Channel', required: true },
          text: { type: 'LONG_TEXT', displayName: 'Text', required: true },
        },
      };
      const result = mapAction(action);
      expect(result.name).toBe('send_message');
      expect(result.displayName).toBe('Send Message');
      expect(result.description).toBe('Sends a message to a channel');
      expect(result.props).toHaveLength(2);
      expect(result.run).toBeDefined();
    });

    it('maps an action with empty props', () => {
      const action: APAction = {
        name: 'ping',
        displayName: 'Ping',
        description: 'Health check',
        props: {},
      };
      const result = mapAction(action);
      expect(result.props).toHaveLength(0);
    });

    it('run throws indicating runtime binding is required', async () => {
      const action: APAction = {
        name: 'test_action',
        displayName: 'Test',
        description: 'Test',
        props: {},
      };
      const result = mapAction(action);
      await expect(result.run({} as never)).rejects.toThrow(
        'Action test_action requires runtime binding',
      );
    });
  });

  describe('mapTrigger', () => {
    it('maps a WEBHOOK trigger', () => {
      const trigger: APTrigger = {
        name: 'new_message',
        displayName: 'New Message',
        description: 'Fires on new message',
        type: 'WEBHOOK',
        props: {},
      };
      const result = mapTrigger(trigger);
      expect(result.name).toBe('new_message');
      expect(result.triggerType).toBe('event');
    });

    it('maps a POLLING trigger', () => {
      const trigger: APTrigger = {
        name: 'new_issue',
        displayName: 'New Issue',
        description: 'Fires on new issue',
        type: 'POLLING',
        props: {},
      };
      const result = mapTrigger(trigger);
      expect(result.triggerType).toBe('cron');
    });

    it('preserves sampleData when present', () => {
      const trigger: APTrigger = {
        name: 'new_event',
        displayName: 'New Event',
        description: 'Fires on event',
        type: 'WEBHOOK',
        props: {},
        sampleData: { id: '123', type: 'event' },
      };
      const result = mapTrigger(trigger);
      expect(result.sampleData).toEqual({ id: '123', type: 'event' });
    });

    it('maps trigger props', () => {
      const trigger: APTrigger = {
        name: 'new_file',
        displayName: 'New File',
        description: 'Fires on file upload',
        type: 'POLLING',
        props: {
          folder: { type: 'SHORT_TEXT', displayName: 'Folder', required: true },
        },
      };
      const result = mapTrigger(trigger);
      expect(result.props).toHaveLength(1);
      expect(result.props[0].name).toBe('folder');
    });
  });

  describe('mapPieceToConnector', () => {
    it('maps a full piece definition', () => {
      const piece: APPiece = {
        name: '@activepieces/piece-slack',
        displayName: 'Slack',
        description: 'Slack integration',
        version: '0.45.0',
        auth: { type: 'OAUTH2' },
        actions: {
          send_message: {
            name: 'send_message',
            displayName: 'Send Message',
            description: 'Send a message',
            props: {
              channel: { type: 'SHORT_TEXT', displayName: 'Channel', required: true },
            },
          },
        },
        triggers: {
          new_message: {
            name: 'new_message',
            displayName: 'New Message',
            description: 'New message received',
            type: 'WEBHOOK',
            props: {},
          },
        },
      };

      const result = mapPieceToConnector(piece);
      expect(result.name).toBe('@activepieces/piece-slack');
      expect(result.displayName).toBe('Slack');
      expect(result.version).toBe('0.45.0');
      expect(result.auth.type).toBe('oauth2');
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].name).toBe('send_message');
      expect(result.triggers).toHaveLength(1);
      expect(result.triggers[0].triggerType).toBe('event');
    });

    it('maps a piece with no auth', () => {
      const piece: APPiece = {
        name: 'piece-utils',
        displayName: 'Utilities',
        description: 'Utility tools',
        version: '1.0.0',
        actions: {},
        triggers: {},
      };
      const result = mapPieceToConnector(piece);
      expect(result.auth.type).toBe('none');
      expect(result.actions).toHaveLength(0);
      expect(result.triggers).toHaveLength(0);
    });

    it('maps a piece with multiple actions and triggers', () => {
      const piece: APPiece = {
        name: 'piece-github',
        displayName: 'GitHub',
        description: 'GitHub integration',
        version: '2.0.0',
        auth: { type: 'SECRET_TEXT', displayName: 'Token' },
        actions: {
          create_issue: {
            name: 'create_issue',
            displayName: 'Create Issue',
            description: 'Create a GitHub issue',
            props: {
              repo: { type: 'SHORT_TEXT', displayName: 'Repository', required: true },
              title: { type: 'SHORT_TEXT', displayName: 'Title', required: true },
            },
          },
          create_pr: {
            name: 'create_pr',
            displayName: 'Create PR',
            description: 'Create a pull request',
            props: {
              repo: { type: 'SHORT_TEXT', displayName: 'Repository', required: true },
            },
          },
        },
        triggers: {
          new_issue: {
            name: 'new_issue',
            displayName: 'New Issue',
            description: 'Fires on new issue',
            type: 'WEBHOOK',
            props: {},
          },
          new_push: {
            name: 'new_push',
            displayName: 'New Push',
            description: 'Fires on push',
            type: 'POLLING',
            props: {},
          },
        },
      };
      const result = mapPieceToConnector(piece);
      expect(result.actions).toHaveLength(2);
      expect(result.triggers).toHaveLength(2);
    });
  });
});

describe('Activepieces Importer', () => {
  it('imports multiple pieces', () => {
    const pieces: APPiece[] = [
      {
        name: 'piece-a',
        displayName: 'A',
        description: 'Service A',
        version: '1.0.0',
        actions: {},
        triggers: {},
      },
      {
        name: 'piece-b',
        displayName: 'B',
        description: 'Service B',
        version: '2.0.0',
        actions: {},
        triggers: {},
      },
    ];
    const result = importPieces(pieces);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('piece-a');
    expect(result[1].name).toBe('piece-b');
  });

  it('returns empty array for empty input', () => {
    const result = importPieces([]);
    expect(result).toHaveLength(0);
  });

  describe('generateConnectorSource', () => {
    it('generates valid TypeScript source with correct structure', () => {
      const piece: APPiece = {
        name: 'piece-test',
        displayName: 'Test Connector',
        description: 'A test connector',
        version: '1.0.0',
        auth: { type: 'SECRET_TEXT' },
        actions: {
          do_thing: {
            name: 'do_thing',
            displayName: 'Do Thing',
            description: 'Does a thing',
            props: {
              input: { type: 'SHORT_TEXT', displayName: 'Input', required: true },
            },
          },
        },
        triggers: {},
      };

      const source = generateConnectorSource(piece);
      expect(source).toContain("name: 'piece-test'");
      expect(source).toContain("displayName: 'Test Connector'");
      expect(source).toContain('testConnector');
      expect(source).toContain('do_thing');
      expect(source).toContain('Property.string');
      expect(source).toContain("import { Property } from '../../properties.js'");
      expect(source).toContain("import type { Connector } from '../../types.js'");
    });

    it('generates correct variable name from scoped npm package', () => {
      const piece: APPiece = {
        name: '@activepieces/piece-slack',
        displayName: 'Slack',
        description: 'Slack integration',
        version: '0.45.0',
        auth: { type: 'OAUTH2' },
        actions: {},
        triggers: {},
      };

      const source = generateConnectorSource(piece);
      expect(source).toContain('slackConnector');
    });

    it('generates trigger code with correct strategy', () => {
      const piece: APPiece = {
        name: 'piece-webhook-test',
        displayName: 'Webhook Test',
        description: 'Test webhooks',
        version: '1.0.0',
        actions: {},
        triggers: {
          on_event: {
            name: 'on_event',
            displayName: 'On Event',
            description: 'Fires on event',
            type: 'WEBHOOK',
            props: {
              eventType: {
                type: 'STATIC_DROPDOWN',
                displayName: 'Event Type',
                options: [
                  { label: 'Created', value: 'created' },
                  { label: 'Updated', value: 'updated' },
                ],
              },
            },
          },
        },
      };

      const source = generateConnectorSource(piece);
      expect(source).toContain("triggerType: 'event'");
      expect(source).toContain('on_event');
      expect(source).toContain('Property.dropdown');
    });

    it('escapes single quotes in strings', () => {
      const piece: APPiece = {
        name: 'piece-escape',
        displayName: "It's a test",
        description: "Don't break",
        version: '1.0.0',
        actions: {},
        triggers: {},
      };

      const source = generateConnectorSource(piece);
      expect(source).toContain("It\\'s a test");
      expect(source).toContain("Don\\'t break");
    });

    it('maps number properties to Property.number', () => {
      const piece: APPiece = {
        name: 'piece-numbers',
        displayName: 'Numbers',
        description: 'Number props',
        version: '1.0.0',
        actions: {
          set_value: {
            name: 'set_value',
            displayName: 'Set Value',
            description: 'Sets a numeric value',
            props: {
              amount: { type: 'NUMBER', displayName: 'Amount', required: true },
            },
          },
        },
        triggers: {},
      };

      const source = generateConnectorSource(piece);
      expect(source).toContain('Property.number');
    });

    it('maps boolean properties to Property.boolean', () => {
      const piece: APPiece = {
        name: 'piece-booleans',
        displayName: 'Booleans',
        description: 'Boolean props',
        version: '1.0.0',
        actions: {
          toggle: {
            name: 'toggle',
            displayName: 'Toggle',
            description: 'Toggles a flag',
            props: {
              enabled: { type: 'CHECKBOX', displayName: 'Enabled', required: false },
            },
          },
        },
        triggers: {},
      };

      const source = generateConnectorSource(piece);
      expect(source).toContain('Property.boolean');
    });

    it('maps JSON/OBJECT properties to Property.json', () => {
      const piece: APPiece = {
        name: 'piece-json',
        displayName: 'JSON',
        description: 'JSON props',
        version: '1.0.0',
        actions: {
          send_payload: {
            name: 'send_payload',
            displayName: 'Send Payload',
            description: 'Sends JSON payload',
            props: {
              body: { type: 'JSON', displayName: 'Body', required: true },
            },
          },
        },
        triggers: {},
      };

      const source = generateConnectorSource(piece);
      expect(source).toContain('Property.json');
    });
  });
});
