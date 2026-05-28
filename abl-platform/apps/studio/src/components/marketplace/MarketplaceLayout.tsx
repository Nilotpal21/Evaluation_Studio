'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { KoreIcon } from '../ui/KoreLogo';
import { MarketplaceSidebar } from './MarketplaceSidebar';
import { refreshAccessToken, scheduleTokenRefresh } from '../../api/auth';
import { useAuthStore } from '../../store/auth-store';

export function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('marketplace');
  const tShell = useTranslations('app_shell');
  const accessToken = useAuthStore((s) => s.accessToken);

  // The marketplace is a standalone route group (not inside AppShell).
  // When navigating here via full page load, the in-memory accessToken is lost.
  // Proactively refresh it using the httpOnly refresh cookie so that
  // API calls include the Authorization header (needed for tenant-scoped browse).
  useEffect(() => {
    if (!accessToken) {
      refreshAccessToken()
        .then((tokens) => {
          useAuthStore.getState().setTokens(tokens.accessToken);
          scheduleTokenRefresh(tokens.expiresIn);
        })
        .catch(() => {
          // Not logged in — marketplace still works (public browse, no tenant filter)
        });
    }
  }, [accessToken]);

  return (
    <div className="flex h-full flex-col overflow-hidden text-foreground bg-noise bg-background">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center border-b px-4 border-default glass relative z-10">
        <div className="flex items-center gap-2">
          <a href="/" className="flex items-center gap-2 hover:opacity-80 transition-default">
            <KoreIcon className="text-foreground" size={20} />
            <span className="text-sm font-semibold text-foreground">
              {tShell('agent_platform')}
            </span>
          </a>
          <span className="text-muted mx-1">|</span>
          <span className="text-sm font-semibold text-foreground">{t('nav.templateStore')}</span>
        </div>
      </header>

      {/* Body: sidebar + content */}
      <div className="flex-1 flex overflow-hidden">
        <MarketplaceSidebar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
