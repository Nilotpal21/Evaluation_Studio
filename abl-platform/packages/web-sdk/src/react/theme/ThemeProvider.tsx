'use client';

/**
 * SDKThemeProvider — Sets CSS custom properties on a wrapper div.
 *
 * Merges partial user theme with defaults. All SDK components reference
 * var(--sdk-*) so they pick up the values automatically.
 */

import React, { useMemo } from 'react';
import type { SDKTheme } from './types.js';
import { defaultTheme } from './default-theme.js';

export interface SDKThemeProviderProps {
  theme?: Partial<SDKTheme>;
  children?: React.ReactNode;
}

/** Map SDKTheme keys to CSS custom property names */
const themeKeyToCSSVar: Record<keyof SDKTheme, string> = {
  primaryColor: '--sdk-primary',
  primaryHoverColor: '--sdk-primary-hover',
  backgroundColor: '--sdk-bg',
  surfaceColor: '--sdk-surface',
  textColor: '--sdk-text',
  textMutedColor: '--sdk-text-muted',
  borderColor: '--sdk-border',
  userBubbleColor: '--sdk-user-bubble',
  userBubbleTextColor: '--sdk-user-bubble-text',
  assistantBubbleColor: '--sdk-assistant-bubble',
  assistantBubbleTextColor: '--sdk-assistant-bubble-text',
  errorColor: '--sdk-error',
  warningColor: '--sdk-warning',
  borderRadius: '--sdk-radius',
  fontFamily: '--sdk-font-family',
  fontSize: '--sdk-font-size',
};

export function SDKThemeProvider({ theme, children }: SDKThemeProviderProps): React.ReactElement {
  const merged = useMemo<SDKTheme>(() => ({ ...defaultTheme, ...theme }), [theme]);

  const style = useMemo(() => {
    const vars: Record<string, string> = {};
    for (const key of Object.keys(themeKeyToCSSVar) as Array<keyof SDKTheme>) {
      vars[themeKeyToCSSVar[key]] = merged[key];
    }
    return vars;
  }, [merged]);

  return React.createElement(
    'div',
    { style: { ...style, height: '100%' }, 'data-sdk-theme': '' },
    children,
  );
}
