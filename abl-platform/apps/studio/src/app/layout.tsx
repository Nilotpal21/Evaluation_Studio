import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { RuntimeConfigProvider, type RuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getLocale } from 'next-intl/server';
import { getDirection } from '@agent-platform/i18n';
import { getPublicRuntimeConfig } from '@/config/runtime.server';
import { Providers } from './providers';

const geistSans = localFont({
  src: '../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2',
  variable: '--font-sans',
  display: 'swap',
  weight: '100 900',
});

const geistMono = localFont({
  src: '../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2',
  variable: '--font-mono',
  display: 'swap',
  weight: '100 900',
});

// Force dynamic rendering so process.env is read at request time, not build time.
// Without this, Next.js statically renders the layout during `next build` when
// RUNTIME_WS_URL and other deployment-specific vars are not yet available.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Agent Platform',
  description: 'Agent Platform - Build, test, and debug AI agents',
  icons: {
    icon: '/favicon.svg',
  },
};

// Inline theme-init script (static string, no user input — safe from XSS).
// Reads the user's theme preference from localStorage before first paint to
// prevent a flash of the wrong theme.
const THEME_INIT_SCRIPT = `(function(){try{var s=JSON.parse(localStorage.getItem('kore-theme-storage')||'{}');var m=(s.state&&s.state.mode)||'system';var t=m==='system'?window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light':m;document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})()`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const publicRuntimeConfig = getPublicRuntimeConfig();

  // Read env vars at REQUEST TIME (server component — never inlined by webpack).
  // These flow to client components via the RuntimeConfigProvider context.
  const runtimeConfig: RuntimeConfig = {
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
    linkedinClientId: process.env.LINKEDIN_CLIENT_ID || '',
    enableDevLogin: process.env.ENABLE_DEV_LOGIN === 'true',
    runtimeUrl: publicRuntimeConfig.apiUrl,
    wsUrl: process.env.RUNTIME_WS_URL || publicRuntimeConfig.wsUrl,
    sdkWsUrl: process.env.RUNTIME_SDK_WS_URL || publicRuntimeConfig.sdkWsUrl,
    livekitUrl: process.env.LIVEKIT_URL || '',
  };

  const locale = await getLocale();
  const messages = await getMessages();
  const dir = getDirection(locale);

  return (
    <html
      lang={locale}
      dir={dir}
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {/* Hidden SVG grain filter — referenced by GrainOverlay via data URI (kept here as fallback id anchor) */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
        >
          <defs>
            <filter id="grain-filter" x="0%" y="0%" width="100%" height="100%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.65"
                numOctaves="4"
                stitchTiles="stitch"
              />
              <feColorMatrix type="saturate" values="0" />
            </filter>
          </defs>
        </svg>
        <Providers>
          <NextIntlClientProvider messages={messages}>
            <RuntimeConfigProvider config={runtimeConfig}>{children}</RuntimeConfigProvider>
          </NextIntlClientProvider>
        </Providers>
      </body>
    </html>
  );
}
