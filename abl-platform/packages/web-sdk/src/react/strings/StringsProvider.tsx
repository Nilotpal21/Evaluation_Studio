'use client';

/**
 * StringsProvider — React context for SDK UI localization.
 *
 * Merges partial user strings with English defaults. Components call
 * useStrings() to access the resolved strings.
 */

import React, { createContext, useContext, useMemo } from 'react';
import type { SDKStrings } from './types.js';
import { defaultStrings } from './defaults.js';

const StringsContext = createContext<SDKStrings>(defaultStrings);

export interface StringsProviderProps {
  strings?: Partial<SDKStrings>;
  children?: React.ReactNode;
}

export function StringsProvider({ strings, children }: StringsProviderProps): React.ReactElement {
  const parent = useContext(StringsContext);
  const merged = useMemo<SDKStrings>(
    () => (strings === undefined ? parent : { ...defaultStrings, ...strings }),
    [strings, parent],
  );
  return React.createElement(StringsContext.Provider, { value: merged }, children);
}

/**
 * Access the current SDK strings (merged with defaults).
 */
export function useStrings(): SDKStrings {
  return useContext(StringsContext);
}
