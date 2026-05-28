/**
 * Theme & Strings Provider Tests (INT-8, INT-9)
 *
 * SDKThemeProvider applies CSS custom properties.
 * StringsProvider overrides default strings.
 * Components use string context.
 */

import React, { act } from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { SDKThemeProvider } from '../react/theme/ThemeProvider.js';
import { StringsProvider, useStrings } from '../react/strings/StringsProvider.js';
import { defaultTheme } from '../react/theme/default-theme.js';
import { defaultStrings } from '../react/strings/defaults.js';

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

// ---------------------------------------------------------------------------
// SDKThemeProvider
// ---------------------------------------------------------------------------
describe('SDKThemeProvider', () => {
  test('applies default CSS custom properties', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          SDKThemeProvider,
          null,
          React.createElement('div', { 'data-testid': 'child' }, 'Hello'),
        ),
      );
      await Promise.resolve();
    });
    const wrapper = container.querySelector('[data-sdk-theme]') as HTMLElement;
    expect(wrapper).toBeTruthy();
    // Check that CSS vars are set on the wrapper
    expect(wrapper.style.getPropertyValue('--sdk-primary')).toBe(defaultTheme.primaryColor);
    expect(wrapper.style.getPropertyValue('--sdk-bg')).toBe(defaultTheme.backgroundColor);
    expect(wrapper.style.getPropertyValue('--sdk-text')).toBe(defaultTheme.textColor);
    expect(wrapper.style.getPropertyValue('--sdk-radius')).toBe(defaultTheme.borderRadius);
    expect(wrapper.style.getPropertyValue('--sdk-font-family')).toBe(defaultTheme.fontFamily);
  });

  test('merges custom theme with defaults', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          SDKThemeProvider,
          { theme: { primaryColor: '#ff0000', fontSize: '16px' } },
          React.createElement('div', { 'data-testid': 'child' }, 'Hello'),
        ),
      );
      await Promise.resolve();
    });
    const wrapper = container.querySelector('[data-sdk-theme]') as HTMLElement;
    expect(wrapper).toBeTruthy();
    // Custom values override
    expect(wrapper.style.getPropertyValue('--sdk-primary')).toBe('#ff0000');
    expect(wrapper.style.getPropertyValue('--sdk-font-size')).toBe('16px');
    // Default values still present
    expect(wrapper.style.getPropertyValue('--sdk-bg')).toBe(defaultTheme.backgroundColor);
  });

  test('children are rendered inside the wrapper', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          SDKThemeProvider,
          null,
          React.createElement('span', { 'data-testid': 'inner' }, 'Content'),
        ),
      );
      await Promise.resolve();
    });
    const inner = container.querySelector('[data-testid="inner"]');
    expect(inner).toBeTruthy();
    expect(inner?.textContent).toBe('Content');
    // It should be inside the data-sdk-theme wrapper
    const wrapper = container.querySelector('[data-sdk-theme]');
    expect(wrapper?.contains(inner!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StringsProvider
// ---------------------------------------------------------------------------
describe('StringsProvider', () => {
  // Helper component that displays strings from context
  function StringsDisplay(): React.ReactElement {
    const s = useStrings();
    return React.createElement(
      'div',
      { 'data-testid': 'strings-out' },
      JSON.stringify({
        sendButton: s.sendButton,
        inputPlaceholder: s.inputPlaceholder,
        typingIndicator: s.typingIndicator,
      }),
    );
  }

  test('provides default strings', async () => {
    await act(async () => {
      root.render(React.createElement(StringsProvider, null, React.createElement(StringsDisplay)));
      await Promise.resolve();
    });
    const el = container.querySelector('[data-testid="strings-out"]') as HTMLElement;
    const data = JSON.parse(el.textContent!);
    expect(data.sendButton).toBe(defaultStrings.sendButton);
    expect(data.inputPlaceholder).toBe(defaultStrings.inputPlaceholder);
    expect(data.typingIndicator).toBe(defaultStrings.typingIndicator);
  });

  test('overrides specific strings while keeping defaults', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          StringsProvider,
          { strings: { sendButton: 'Enviar' } },
          React.createElement(StringsDisplay),
        ),
      );
      await Promise.resolve();
    });
    const el = container.querySelector('[data-testid="strings-out"]') as HTMLElement;
    const data = JSON.parse(el.textContent!);
    expect(data.sendButton).toBe('Enviar');
    // Default values remain
    expect(data.inputPlaceholder).toBe(defaultStrings.inputPlaceholder);
    expect(data.typingIndicator).toBe(defaultStrings.typingIndicator);
  });

  test('components use overridden strings', async () => {
    const { TypingIndicator } = await import('../react/components/TypingIndicator.js');
    await act(async () => {
      root.render(
        React.createElement(
          StringsProvider,
          { strings: { typingIndicator: 'El agente escribe' } },
          React.createElement(TypingIndicator),
        ),
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('El agente escribe');
  });
});
