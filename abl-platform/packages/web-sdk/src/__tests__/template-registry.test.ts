import { describe, it, expect, vi } from 'vitest';
import { TemplateRegistry, MAX_RENDERERS } from '../templates/registry.js';
import type { TemplateRenderer, TemplateContext } from '../templates/types.js';
import type { Message } from '../core/types.js';

function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeDummyRenderer(type: string, shouldMatch: boolean): TemplateRenderer<string> {
  return {
    type,
    extract: () => (shouldMatch ? `data-${type}` : undefined),
    render: (_data: string, _ctx: TemplateContext) => null as unknown as React.ReactElement,
    renderDOM: (_data: string, _ctx: TemplateContext) => document.createElement('div'),
  };
}

describe('TemplateRegistry', () => {
  it('registers built-in renderers when the React entry is imported', async () => {
    vi.resetModules();

    const { defaultRegistry } = await import('../templates/registry.js');
    expect(defaultRegistry.size).toBe(0);

    await import('../react/index.js');

    expect(defaultRegistry.size).toBeGreaterThan(0);
    const matchedTypes = defaultRegistry
      .match(
        makeMessage({
          richContent: {
            markdown: '**hello from react entry**',
          } as Message['richContent'],
        }),
      )
      .map((match) => match.renderer.type);
    expect(matchedTypes).toContain('markdown');
  }, 15000);

  it('registers and matches renderers in registration order', () => {
    const registry = new TemplateRegistry();
    const r1 = makeDummyRenderer('alpha', true);
    const r2 = makeDummyRenderer('beta', true);

    registry.register(r1);
    registry.register(r2);

    const matches = registry.match(makeMessage());
    expect(matches).toHaveLength(2);
    expect(matches[0].renderer.type).toBe('alpha');
    expect(matches[0].data).toBe('data-alpha');
    expect(matches[1].renderer.type).toBe('beta');
    expect(matches[1].data).toBe('data-beta');
  });

  it('only returns renderers whose extract() returns defined data', () => {
    const registry = new TemplateRegistry();
    registry.register(makeDummyRenderer('match', true));
    registry.register(makeDummyRenderer('skip', false));
    registry.register(makeDummyRenderer('also-match', true));

    const matches = registry.match(makeMessage());
    expect(matches).toHaveLength(2);
    expect(matches[0].renderer.type).toBe('match');
    expect(matches[1].renderer.type).toBe('also-match');
  });

  it('returns empty array when no renderers match', () => {
    const registry = new TemplateRegistry();
    registry.register(makeDummyRenderer('a', false));
    registry.register(makeDummyRenderer('b', false));

    const matches = registry.match(makeMessage());
    expect(matches).toEqual([]);
  });

  it('returns empty array when no renderers are registered', () => {
    const registry = new TemplateRegistry();
    const matches = registry.match(makeMessage());
    expect(matches).toEqual([]);
  });

  it('tracks the number of registered renderers via size', () => {
    const registry = new TemplateRegistry();
    expect(registry.size).toBe(0);

    registry.register(makeDummyRenderer('a', true));
    expect(registry.size).toBe(1);

    registry.register(makeDummyRenderer('b', true));
    expect(registry.size).toBe(2);
  });

  it('throws when MAX_RENDERERS is exceeded', () => {
    const registry = new TemplateRegistry();

    for (let i = 0; i < MAX_RENDERERS; i++) {
      registry.register(makeDummyRenderer(`r-${i}`, true));
    }
    expect(registry.size).toBe(MAX_RENDERERS);

    expect(() => {
      registry.register(makeDummyRenderer('one-too-many', true));
    }).toThrow(/maximum of 50 renderers reached/);
  });

  it('warns with error details and emits matchError when extract() throws', () => {
    const registry = new TemplateRegistry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const message = makeMessage({ id: 'msg-broken' });
    const extractError = new Error('extract exploded');
    extractError.stack =
      'Error: extract exploded\n    at failingRenderer.extract (registry.test.ts:1:1)';
    const matchErrors: Array<{
      rendererType: string;
      sourceMessage: Message;
      error: Error;
    }> = [];

    registry.on('matchError', (event) => {
      matchErrors.push(event);
    });

    registry.register({
      type: 'broken',
      extract: () => {
        throw extractError;
      },
      render: () => null as unknown as React.ReactElement,
      renderDOM: () => document.createElement('div'),
    });
    registry.register(makeDummyRenderer('healthy', true));

    const matches = registry.match(message);

    expect(matches).toHaveLength(1);
    expect(matches[0].renderer.type).toBe('healthy');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('renderer "broken"');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('message: extract exploded');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('at failingRenderer.extract');
    expect(matchErrors).toHaveLength(1);
    expect(matchErrors[0]?.rendererType).toBe('broken');
    expect(matchErrors[0]?.sourceMessage).toBe(message);
    expect(matchErrors[0]?.error).toBe(extractError);

    warnSpy.mockRestore();
  });
});
