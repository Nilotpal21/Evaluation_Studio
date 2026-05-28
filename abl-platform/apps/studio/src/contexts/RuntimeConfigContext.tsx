'use client';

import { createContext, useContext } from 'react';

/**
 * Runtime configuration injected by the server component (layout.tsx).
 *
 * These values are read from process.env at REQUEST TIME on the server,
 * avoiding Next.js build-time inlining of NEXT_PUBLIC_* variables.
 * This lets a single Docker image work across all environments.
 */
export interface RuntimeConfig {
  /** Google OAuth client ID — empty means Google OAuth is not configured */
  googleClientId: string;
  /** Microsoft OAuth client ID — empty means Microsoft OAuth is not configured */
  microsoftClientId: string;
  /** LinkedIn OAuth client ID — empty means LinkedIn OAuth is not configured */
  linkedinClientId: string;
  /** Whether the dev-login endpoint is enabled (ENABLE_DEV_LOGIN=true) */
  enableDevLogin: boolean;
  /** Runtime service base URL (e.g. https://agents-dev.kore.ai). Empty = same origin (nginx proxy). */
  runtimeUrl: string;
  /** Public WebSocket URL for the main app (e.g. wss://agents-dev.kore.ai/ws) */
  wsUrl: string;
  /** Public WebSocket URL for SDK previews (e.g. wss://agents-dev.kore.ai/ws/sdk) */
  sdkWsUrl: string;
  /** LiveKit server URL for voice features */
  livekitUrl: string;
}

const defaultConfig: RuntimeConfig = {
  googleClientId: '',
  microsoftClientId: '',
  linkedinClientId: '',
  enableDevLogin: false,
  runtimeUrl: '',
  wsUrl: '',
  sdkWsUrl: '',
  livekitUrl: '',
};

const RuntimeConfigContext = createContext<RuntimeConfig>(defaultConfig);

export function RuntimeConfigProvider({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: React.ReactNode;
}) {
  return <RuntimeConfigContext.Provider value={config}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
  return useContext(RuntimeConfigContext);
}
