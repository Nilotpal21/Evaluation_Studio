/**
 * @vitest-environment happy-dom
 */

/**
 * Regression test: StringsProvider double-wrap clobbering bug.
 *
 * BUG: ChatWidget unconditionally wraps its content in a StringsProvider with
 * `strings={undefined}`. When ChatWidget is rendered inside an outer
 * StringsProvider that supplies localized strings, the inner provider
 * clobbers them because `{ ...defaultStrings, ...undefined }` collapses
 * to just `defaultStrings`.
 *
 * This test renders a nested StringsProvider scenario that mirrors
 * AgentProvider (outer, with localized strings) > ChatWidget (inner,
 * strings=undefined) and asserts that useStrings() inside the inner
 * provider still returns the outer localized strings.
 *
 * EXPECTED: This test FAILS until the bug is fixed.
 */

import React, { act } from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { StringsProvider, useStrings } from '../react/strings/StringsProvider.js';
import { defaultStrings } from '../react/strings/defaults.js';
import type { SDKStrings } from '../react/strings/types.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  vi.restoreAllMocks();
});

/**
 * Helper component that reads useStrings() and dumps selected keys as JSON
 * so the test can assert on context values.
 */
function StringsConsumer(): React.ReactElement {
  const s = useStrings();
  return React.createElement(
    'div',
    { 'data-testid': 'strings-consumer' },
    JSON.stringify({
      sendButton: s.sendButton,
      inputPlaceholder: s.inputPlaceholder,
      typingIndicator: s.typingIndicator,
    }),
  );
}

// ---------------------------------------------------------------------------
// Regression: nested StringsProvider with strings=undefined clobbers outer
// ---------------------------------------------------------------------------
describe('StringsProvider nesting (double-wrap bug)', () => {
  const spanishStrings: Partial<SDKStrings> = {
    sendButton: 'Enviar',
    inputPlaceholder: 'Escribe un mensaje...',
    typingIndicator: 'El agente esta escribiendo',
  };

  test('inner StringsProvider with strings=undefined should NOT clobber outer localized strings', async () => {
    // This mirrors the real scenario:
    //   <AgentProvider>            -- renders outer StringsProvider with localized strings
    //     <ChatWidget>             -- renders inner StringsProvider with strings={undefined}
    //       <StringsConsumer />    -- calls useStrings()
    //     </ChatWidget>
    //   </AgentProvider>
    await act(async () => {
      root.render(
        // Outer provider: simulates AgentProvider supplying localized strings
        React.createElement(
          StringsProvider,
          { strings: spanishStrings },
          // Inner provider: simulates ChatWidget wrapping with strings=undefined
          React.createElement(
            StringsProvider,
            { strings: undefined },
            React.createElement(StringsConsumer),
          ),
        ),
      );
      await Promise.resolve();
    });

    const el = container.querySelector('[data-testid="strings-consumer"]') as HTMLElement;
    expect(el).toBeTruthy();
    const data = JSON.parse(el.textContent!);

    // These assertions demonstrate the bug: the inner StringsProvider with
    // strings=undefined should inherit the outer provider's localized values,
    // but instead it resets them to English defaults.
    expect(data.sendButton).toBe(spanishStrings.sendButton);
    expect(data.inputPlaceholder).toBe(spanishStrings.inputPlaceholder);
    expect(data.typingIndicator).toBe(spanishStrings.typingIndicator);
  });

  test('inner StringsProvider with explicit strings should override outer (expected behavior)', async () => {
    const frenchStrings: Partial<SDKStrings> = {
      sendButton: 'Envoyer',
    };

    await act(async () => {
      root.render(
        // Outer provider: Spanish
        React.createElement(
          StringsProvider,
          { strings: spanishStrings },
          // Inner provider: French (explicit override — this is fine)
          React.createElement(
            StringsProvider,
            { strings: frenchStrings },
            React.createElement(StringsConsumer),
          ),
        ),
      );
      await Promise.resolve();
    });

    const el = container.querySelector('[data-testid="strings-consumer"]') as HTMLElement;
    expect(el).toBeTruthy();
    const data = JSON.parse(el.textContent!);

    // When explicit strings are passed to the inner provider, they should win.
    // Keys not in frenchStrings merge with defaults (NOT with outer provider —
    // that's a separate enhancement, not a bug).
    expect(data.sendButton).toBe('Envoyer');
    // inputPlaceholder and typingIndicator fall back to defaults because the
    // inner StringsProvider merges with defaultStrings, not the outer context.
    expect(data.inputPlaceholder).toBe(defaultStrings.inputPlaceholder);
    expect(data.typingIndicator).toBe(defaultStrings.typingIndicator);
  });

  test('single StringsProvider with localized strings works correctly (baseline)', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          StringsProvider,
          { strings: spanishStrings },
          React.createElement(StringsConsumer),
        ),
      );
      await Promise.resolve();
    });

    const el = container.querySelector('[data-testid="strings-consumer"]') as HTMLElement;
    expect(el).toBeTruthy();
    const data = JSON.parse(el.textContent!);

    // Single provider with localized strings: works fine
    expect(data.sendButton).toBe(spanishStrings.sendButton);
    expect(data.inputPlaceholder).toBe(spanishStrings.inputPlaceholder);
    expect(data.typingIndicator).toBe(spanishStrings.typingIndicator);
  });
});
