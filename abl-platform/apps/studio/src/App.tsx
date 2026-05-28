/**
 * Main App Component
 *
 * Root component with:
 * - Authentication handling (Google OAuth)
 * - Toast notifications (sonner)
 * - Command palette (K)
 */

import { useEffect, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { AppShell } from './components/navigation/AppShell';
import { CommandPalette, useCommandPalette } from './components/CommandPalette';
import { useAuthStore } from './store/auth-store';
import { useThemeStore } from './store/theme-store';
import { useArchAIStore } from './lib/arch-ai/store/arch-ai-store';
import { useProjectStore } from './store/project-store';
import { useEvalsStore } from './store/evals-store';
import { showEvalSuggestionIfNeeded } from './components/evals/shared/EvalSuggestionToast';
import { initializeAuth } from './api/auth';
import { AuthCallback } from './components/AuthCallback';
import { DeviceAuth } from './components/DeviceAuth';
import { OfflineConnectionOverlay } from './components/OfflineConnectionOverlay';
import { LoginButton } from './components/auth';
import { Loader2, Lock, WifiOff } from 'lucide-react';
import { KoreIcon } from './components/ui/KoreLogo';
import { useOnlineStatus } from './hooks/useOnlineStatus';

// Simple router based on URL path
function getRoute(): 'main' | 'auth-callback' | 'auth-device' | 'auth-error' {
  const path = window.location.pathname;
  if (path === '/auth/callback') return 'auth-callback';
  if (path === '/auth/device') return 'auth-device';
  if (path === '/auth/error') return 'auth-error';
  return 'main';
}

function App() {
  const t = useTranslations('app_shell');
  const { isLoading: authLoading, isAuthenticated, idleLockReason, clearIdleLock } = useAuthStore();
  const { resolved: resolvedTheme } = useThemeStore();
  const [showSplash, setShowSplash] = useState(true);
  const [route, setRoute] = useState(getRoute);
  const { open: commandPaletteOpen, setOpen: setCommandPaletteOpen } = useCommandPalette();
  const authInitRef = useRef(false);
  const isOffline = useOnlineStatus();

  // Initialize auth once on mount (ref guards against Strict Mode / double mount)
  useEffect(() => {
    if (authInitRef.current) return;
    authInitRef.current = true;
    void initializeAuth();
  }, []);

  // Listen for route changes
  useEffect(() => {
    const handlePopState = () => setRoute(getRoute());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Hide splash once auth resolves
  useEffect(() => {
    if (!authLoading) {
      const timer = setTimeout(() => setShowSplash(false), 500);
      return () => clearTimeout(timer);
    }
  }, [authLoading]);

  // Suggest re-running evals after Architect modifies an agent
  const lastAgentEdit = useArchAIStore((s) => s.lastAgentEditTimestamp);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id);
  const prevEditRef = useRef(lastAgentEdit);
  useEffect(() => {
    if (lastAgentEdit && lastAgentEdit !== prevEditRef.current && currentProjectId) {
      prevEditRef.current = lastAgentEdit;
      showEvalSuggestionIfNeeded(currentProjectId, () => {
        useEvalsStore.getState().setActiveTab('runs');
      });
    }
  }, [lastAgentEdit, currentProjectId]);

  const offlineOverlay = isOffline ? (
    <OfflineConnectionOverlay
      title={t('offline.title')}
      description={t('offline.description')}
      retryLabel={t('offline.try_again')}
      onRetry={() => window.location.reload()}
    />
  ) : null;

  // Handle auth callback route
  if (route === 'auth-callback') {
    return (
      <>
        <AuthCallback
          onComplete={() => {
            window.history.pushState({}, '', '/');
            setRoute('main');
          }}
        />
        {offlineOverlay}
      </>
    );
  }

  // Handle device auth route
  if (route === 'auth-device') {
    return (
      <>
        <DeviceAuth />
        {offlineOverlay}
      </>
    );
  }

  // Handle auth error route
  if (route === 'auth-error') {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error') || t('unknown_error');

    return (
      <>
        <div className="h-screen bg-background flex flex-col items-center justify-center px-4">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center max-w-sm"
          >
            <div className="w-12 h-12 rounded-full bg-error-subtle flex items-center justify-center mx-auto mb-4">
              <WifiOff className="w-6 h-6 text-error" />
            </div>
            <h1 className="text-xl font-semibold text-foreground mb-2">{t('auth_error_title')}</h1>
            <p className="text-muted text-sm mb-6">{error}</p>
            <button
              onClick={() => {
                window.history.pushState({}, '', '/');
                setRoute('main');
              }}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-default text-sm font-medium btn-press"
            >
              {t('return_to_app')}
            </button>
          </motion.div>
        </div>
        {offlineOverlay}
      </>
    );
  }

  // Show splash while loading auth
  if (authLoading || showSplash) {
    return (
      <>
        <SplashScreen isAuthLoading={authLoading} />
        {offlineOverlay}
      </>
    );
  }

  // Show login screen when not authenticated
  if (!isAuthenticated) {
    return (
      <>
        <LoginScreen />
        {offlineOverlay}
      </>
    );
  }

  return (
    <>
      {/* Toast container */}
      <Toaster
        position="bottom-right"
        closeButton
        toastOptions={{
          duration: 3000,
        }}
        theme={resolvedTheme}
      />

      {/* Command palette */}
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />

      {/* Main layout - takes full screen */}
      <div className="h-screen">
        <AppShell />
      </div>

      {idleLockReason && (
        <IdleLockOverlay
          title={t('idle_lock.title')}
          description={t('idle_lock.description')}
          continueLabel={t('idle_lock.continue')}
          onContinue={clearIdleLock}
        />
      )}

      {offlineOverlay}
    </>
  );
}

// Login screen — Vercel-inspired, clean and centered
function LoginScreen() {
  const t = useTranslations('auth.login_screen');
  return (
    <div className="h-screen bg-background flex flex-col items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="text-center w-full max-w-sm"
      >
        {/* Logo */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.1, duration: 0.3 }}
          className="mb-8"
        >
          <KoreIcon className="text-foreground mx-auto" size={40} />
        </motion.div>

        <h1 className="text-2xl font-semibold text-foreground mb-2">{t('title')}</h1>
        <p className="text-muted text-sm mb-8">{t('subtitle')}</p>

        <div className="space-y-3">
          <LoginButton />
        </div>

        <p className="mt-8 text-center text-xs text-subtle">
          {t('no_account')}{' '}
          <a href="/auth/signup" className="text-foreground hover:underline">
            {t('sign_up')}
          </a>
        </p>
      </motion.div>
    </div>
  );
}

// Splash screen — minimal loading state
function SplashScreen({ isAuthLoading }: { isAuthLoading?: boolean }) {
  const t = useTranslations('app_shell.splash');
  return (
    <div className="h-screen bg-background flex flex-col items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        className="text-center"
      >
        <KoreIcon className="text-foreground mx-auto mb-6" size={32} />
        <div className="flex items-center gap-2 text-muted justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">{isAuthLoading ? t('checking_auth') : t('connecting')}</span>
        </div>
      </motion.div>
    </div>
  );
}

function IdleLockOverlay({
  title,
  description,
  continueLabel,
  onContinue,
}: {
  title: string;
  description: string;
  continueLabel: string;
  onContinue: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] bg-overlay/80 backdrop-blur-sm flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md rounded-2xl border border-default bg-background-elevated shadow-xl p-6"
      >
        <div className="w-12 h-12 rounded-full bg-warning-subtle flex items-center justify-center mb-4">
          <Lock className="w-6 h-6 text-warning" />
        </div>
        <h2 className="text-lg font-semibold text-foreground mb-2">{title}</h2>
        <p className="text-sm text-muted mb-6 leading-relaxed">{description}</p>
        <button
          onClick={onContinue}
          className="w-full px-4 py-2.5 rounded-lg bg-accent text-accent-foreground hover:opacity-90 transition-default text-sm font-medium btn-press"
        >
          {continueLabel}
        </button>
      </motion.div>
    </div>
  );
}

export default App;
