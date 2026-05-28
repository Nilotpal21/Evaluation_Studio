/**
 * Tests for DropdownOptionsService — runtime resolution of dynamic dropdown
 * options for a connector action prop.
 *
 * ConnectorRegistry is real; connection lookup and auth resolution are
 * stubbed via the ConnectionResolver-shaped dep.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DropdownOptionsService,
  DropdownOptionsServiceError,
} from '../services/dropdown-options-service.js';
import { ConnectorRegistry } from '../registry.js';
import type {
  Connector,
  ConnectorAction,
  ConnectorTrigger,
  DynamicPropertiesState,
  DropdownState,
  ResolveOptionsContext,
} from '../types.js';
import type { ConnectionResolver } from '../auth/connection-resolver.js';

function makeAction(overrides: Partial<ConnectorAction> = {}): ConnectorAction {
  return {
    name: 'add_row',
    displayName: 'Add Row',
    description: '',
    props: [
      {
        name: 'spreadsheetId',
        displayName: 'Spreadsheet',
        type: 'dropdown',
        required: true,
        refreshers: [],
      },
      {
        name: 'sheetId',
        displayName: 'Sheet',
        type: 'dropdown',
        required: true,
        refreshers: ['spreadsheetId'],
      },
      { name: 'title', displayName: 'Title', type: 'string', required: false },
    ],
    async run() {
      return null;
    },
    resolveOptions: vi.fn(
      async (_propName, _ctx: ResolveOptionsContext): Promise<DropdownState> => ({
        disabled: false,
        options: [{ label: 'Sheet1', value: 'sheet-1' }],
      }),
    ),
    ...overrides,
  };
}

function makeConnector(action: ConnectorAction): Connector {
  return {
    name: 'google-sheets',
    displayName: 'Google Sheets',
    version: '1.0.0',
    description: '',
    auth: { type: 'oauth2' },
    triggers: [],
    actions: [action],
  };
}

function makeResolver(overrides: Partial<ConnectionResolver> = {}): ConnectionResolver {
  return {
    resolve: vi.fn(async () => ({
      connection: {
        _id: 'conn-1',
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'google-sheets',
        authProfileId: 'ap-1',
        scope: 'tenant',
        status: 'active',
      } as unknown as Parameters<ConnectionResolver['resolveAuth']>[0],
      scope: 'tenant' as const,
    })),
    resolveAuth: vi.fn(async () => ({ access_token: 'tok_123' })),
    ...overrides,
  } as unknown as ConnectionResolver;
}

function makeSvc(action: ConnectorAction, resolver = makeResolver()) {
  const registry = new ConnectorRegistry();
  registry.register(makeConnector(action));
  const svc = new DropdownOptionsService({ registry, connectionResolver: resolver });
  return { svc, registry, resolver };
}

describe('DropdownOptionsService.resolveActionProp', () => {
  it('resolves options via the action resolver, passing auth + propsValue', async () => {
    const action = makeAction();
    const { svc, resolver } = makeSvc(action);

    const result = await svc.resolveActionProp({
      tenantId: 't1',
      projectId: 'p1',
      connectorName: 'google-sheets',
      actionName: 'add_row',
      propName: 'sheetId',
      connectionId: 'conn-1',
      propsValue: { spreadsheetId: 'sheet-abc' },
    });

    expect(result.options).toEqual([{ label: 'Sheet1', value: 'sheet-1' }]);
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn-1', tenantId: 't1', projectId: 'p1' }),
    );
    expect(action.resolveOptions).toHaveBeenCalledWith(
      'sheetId',
      expect.objectContaining({
        auth: { access_token: 'tok_123' },
        propsValue: { spreadsheetId: 'sheet-abc' },
      }),
    );
  });

  it('throws VALIDATION_ERROR when connectionId is missing', async () => {
    const { svc } = makeSvc(makeAction());
    await expect(
      svc.resolveActionProp({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'google-sheets',
        actionName: 'add_row',
        propName: 'sheetId',
        connectionId: '',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws CONNECTOR_NOT_FOUND for unknown connector', async () => {
    const { svc } = makeSvc(makeAction());
    await expect(
      svc.resolveActionProp({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'nope',
        actionName: 'add_row',
        propName: 'sheetId',
        connectionId: 'conn-1',
      }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_NOT_FOUND' });
  });

  it('throws ACTION_NOT_FOUND for unknown action', async () => {
    const { svc } = makeSvc(makeAction());
    await expect(
      svc.resolveActionProp({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'google-sheets',
        actionName: 'delete_all',
        propName: 'sheetId',
        connectionId: 'conn-1',
      }),
    ).rejects.toMatchObject({ code: 'ACTION_NOT_FOUND' });
  });

  it('throws PROP_NOT_DYNAMIC when the prop has no refreshers', async () => {
    const { svc } = makeSvc(makeAction());
    await expect(
      svc.resolveActionProp({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'google-sheets',
        actionName: 'add_row',
        propName: 'title',
        connectionId: 'conn-1',
      }),
    ).rejects.toMatchObject({ code: 'PROP_NOT_DYNAMIC' });
  });

  it('throws PROP_NOT_DYNAMIC when the action has no resolveOptions', async () => {
    const action = makeAction();
    delete (action as Partial<ConnectorAction>).resolveOptions;
    const { svc } = makeSvc(action);
    await expect(
      svc.resolveActionProp({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'google-sheets',
        actionName: 'add_row',
        propName: 'sheetId',
        connectionId: 'conn-1',
      }),
    ).rejects.toMatchObject({ code: 'PROP_NOT_DYNAMIC' });
  });

  it('wraps connection-resolver errors as CONNECTION_NOT_FOUND', async () => {
    const resolver = makeResolver({
      resolve: vi.fn(async () => {
        throw new Error('Connection not found');
      }),
    } as Partial<ConnectionResolver>);
    const { svc } = makeSvc(makeAction(), resolver);
    await expect(
      svc.resolveActionProp({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'google-sheets',
        actionName: 'add_row',
        propName: 'sheetId',
        connectionId: 'conn-missing',
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
  });

  it('wraps resolver throws as RESOLVE_FAILED', async () => {
    const action = makeAction({
      resolveOptions: vi.fn(async () => {
        throw new Error('google api 401');
      }),
    });
    const { svc } = makeSvc(action);
    await expect(
      svc.resolveActionProp({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'google-sheets',
        actionName: 'add_row',
        propName: 'sheetId',
        connectionId: 'conn-1',
      }),
    ).rejects.toMatchObject({
      code: 'RESOLVE_FAILED',
      message: expect.stringContaining('google api 401'),
    });
  });

  it('exports a DropdownOptionsServiceError that carries the error code', async () => {
    const { svc } = makeSvc(makeAction());
    try {
      await svc.resolveActionProp({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'nope',
        actionName: 'add_row',
        propName: 'sheetId',
        connectionId: 'conn-1',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DropdownOptionsServiceError);
    }
  });
});

// ─── resolveActionDynamicProps ───────────────────────────────────────────────

describe('resolveActionDynamicProps', () => {
  const mockFields: DynamicPropertiesState = {
    summary: { name: 'summary', displayName: 'Summary', type: 'string', required: true },
    assignee: {
      name: 'assignee',
      displayName: 'Assignee',
      type: 'dropdown',
      required: false,
      options: [{ label: 'Alice', value: 'user-1' }],
    },
  };

  function makeDynamicAction(overrides: Partial<ConnectorAction> = {}): ConnectorAction {
    return {
      name: 'create_issue',
      displayName: 'Create Issue',
      description: '',
      props: [
        {
          name: 'projectId',
          displayName: 'Project',
          type: 'dropdown',
          required: true,
          refreshers: [],
        },
        {
          name: 'issueFields',
          displayName: 'Fields',
          type: 'dynamic_properties',
          required: true,
          refreshers: ['projectId'],
        },
      ],
      async run() {
        return null;
      },
      resolveDynamicProps: vi.fn(async () => mockFields),
      ...overrides,
    };
  }

  it('returns the field map on success', async () => {
    const action = makeDynamicAction();
    const registry = new ConnectorRegistry();
    registry.register(makeConnector(action));
    const svc = new DropdownOptionsService({ registry, connectionResolver: makeResolver() });

    const result = await svc.resolveActionDynamicProps({
      tenantId: 't1',
      projectId: 'p1',
      connectorName: 'google-sheets',
      actionName: 'create_issue',
      propName: 'issueFields',
      connectionId: 'conn-1',
      propsValue: { projectId: '10001' },
    });

    expect(result).toHaveProperty('summary');
    expect(result.summary.type).toBe('string');
    expect(result.summary.required).toBe(true);
    expect(result).toHaveProperty('assignee');
    expect(result.assignee.options?.[0].label).toBe('Alice');
  });

  it('passes propsValue into the resolver context', async () => {
    const action = makeDynamicAction();
    const registry = new ConnectorRegistry();
    registry.register(makeConnector(action));
    const svc = new DropdownOptionsService({ registry, connectionResolver: makeResolver() });

    await svc.resolveActionDynamicProps({
      tenantId: 't1',
      projectId: 'p1',
      connectorName: 'google-sheets',
      actionName: 'create_issue',
      propName: 'issueFields',
      connectionId: 'conn-1',
      propsValue: { projectId: '10001', issueTypeId: '10007' },
    });

    const resolveFn = action.resolveDynamicProps as ReturnType<typeof vi.fn>;
    const ctx = resolveFn.mock.calls[0][1] as ResolveOptionsContext;
    expect(ctx.propsValue).toMatchObject({ projectId: '10001', issueTypeId: '10007' });
  });

  it('throws PROP_NOT_DYNAMIC_PROPERTIES when action has no resolveDynamicProps', async () => {
    const action = makeAction(); // standard action — no resolveDynamicProps
    const registry = new ConnectorRegistry();
    registry.register(makeConnector(action));
    const svc = new DropdownOptionsService({ registry, connectionResolver: makeResolver() });

    await expect(
      svc.resolveActionDynamicProps({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'google-sheets',
        actionName: 'add_row',
        propName: 'sheetId',
        connectionId: 'conn-1',
      }),
    ).rejects.toMatchObject({ code: 'PROP_NOT_DYNAMIC_PROPERTIES' });
  });

  it('throws CONNECTOR_NOT_FOUND for unknown connector', async () => {
    const registry = new ConnectorRegistry();
    const svc = new DropdownOptionsService({ registry, connectionResolver: makeResolver() });

    await expect(
      svc.resolveActionDynamicProps({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'nope',
        actionName: 'create_issue',
        propName: 'issueFields',
        connectionId: 'conn-1',
      }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_NOT_FOUND' });
  });

  it('throws RESOLVE_FAILED when resolveDynamicProps throws', async () => {
    const action = makeDynamicAction();
    (action.resolveDynamicProps as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Jira API down'),
    );
    const registry = new ConnectorRegistry();
    registry.register(makeConnector(action));
    const svc = new DropdownOptionsService({ registry, connectionResolver: makeResolver() });

    await expect(
      svc.resolveActionDynamicProps({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'google-sheets',
        actionName: 'create_issue',
        propName: 'issueFields',
        connectionId: 'conn-1',
      }),
    ).rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
  });

  it('throws VALIDATION_ERROR when connectionId is missing', async () => {
    const action = makeDynamicAction();
    const registry = new ConnectorRegistry();
    registry.register(makeConnector(action));
    const svc = new DropdownOptionsService({ registry, connectionResolver: makeResolver() });

    await expect(
      svc.resolveActionDynamicProps({
        tenantId: 't1',
        projectId: 'p1',
        connectorName: 'google-sheets',
        actionName: 'create_issue',
        propName: 'issueFields',
        connectionId: '',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
