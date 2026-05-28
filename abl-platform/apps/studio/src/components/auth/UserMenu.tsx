/**
 * User Menu Component
 *
 * Linear-inspired dropdown menu showing user info, workspace switcher,
 * settings, and logout. Uses semantic tokens for theme-awareness.
 */

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  LogOut,
  User as UserIcon,
  ChevronDown,
  Shield,
  Key,
  Building2,
  Check,
  Loader2,
  Monitor,
  Sun,
  Moon,
  BookOpen,
  Plus,
  GraduationCap,
  Store,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '../../store/auth-store';
import { useNavigationStore } from '../../store/navigation-store';
import { logout, scheduleTokenRefresh } from '../../api/auth';
import { apiFetch } from '../../lib/api-client';
import { useThemeStore } from '../../store/theme-store';
import { canAccessWorkspaceAdmin } from '../../lib/auth-token';
import { Avatar } from '../ui/Avatar';
import { ProfilePanel } from './ProfilePanel';
import { ApiKeysPanel } from '../settings/ApiKeysPanel';
import { checkDomainAllowed, getAllowedDomains } from '../../lib/docs/access';

interface Workspace {
  tenantId: string;
  tenantName: string;
  role: string;
}

export function UserMenu() {
  const t = useTranslations('user_menu');
  const { user, tenantId, setAuth, accessToken } = useAuthStore();
  const { navigate } = useNavigationStore();
  const { mode, setMode } = useThemeStore();
  const [isOpen, setIsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [showWorkspaces, setShowWorkspaces] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const docsAllowed = user?.email ? checkDomainAllowed(user.email, getAllowedDomains()) : false;
  const canOpenWorkspaceAdmin = canAccessWorkspaceAdmin(accessToken);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setShowWorkspaces(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadWorkspaces = async () => {
    if (loadingWorkspaces) return;
    setLoadingWorkspaces(true);
    try {
      const res = await apiFetch('/api/auth/tenants');
      if (res.ok) {
        const data = await res.json();
        setWorkspaces(data.tenants ?? []);
      }
    } catch {
      // Silently fail — user can retry
    } finally {
      setLoadingWorkspaces(false);
    }
  };

  const handleSwitchWorkspace = async (targetTenantId: string) => {
    if (targetTenantId === tenantId || switchingTo) return;
    setSwitchingTo(targetTenantId);

    try {
      const res = await apiFetch('/api/auth/tenants/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: targetTenantId }),
      });

      if (res.ok) {
        const data = await res.json();
        if (user && data.accessToken) {
          setAuth(user, data.accessToken, data.tenantId);
          if (data.expiresIn) {
            scheduleTokenRefresh(data.expiresIn);
          }
        }
        setIsOpen(false);
        setShowWorkspaces(false);
        // Reload to refresh all data for the new workspace
        window.location.href = '/';
      }
    } catch {
      // Silently fail
    } finally {
      setSwitchingTo(null);
    }
  };

  if (!user) {
    return null;
  }

  const handleLogout = async () => {
    setIsOpen(false);
    await logout();
  };

  const handleShowWorkspaces = () => {
    setShowWorkspaces(!showWorkspaces);
    if (!showWorkspaces) {
      loadWorkspaces();
    }
  };

  const handleCreateWorkspace = () => {
    setIsOpen(false);
    setShowWorkspaces(false);
    window.location.href = '/onboarding';
  };

  const currentWorkspace = workspaces.find((ws) => ws.tenantId === tenantId);
  const otherWorkspaces = workspaces.filter((ws) => ws.tenantId !== tenantId);

  return (
    <>
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          data-testid="user-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-background-muted transition-default"
        >
          <Avatar name={user.name || user.email} src={user.avatarUrl} size="sm" />
          <span className="text-sm text-foreground hidden sm:inline truncate max-w-[120px]">
            {user.name || user.email}
          </span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>

        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
              data-testid="user-menu-dropdown"
              className="absolute right-0 mt-2 w-64 bg-background-elevated border border-default rounded-xl shadow-lg z-50 overflow-hidden"
            >
              {/* User info */}
              <div className="px-4 py-3 border-b border-default">
                <p className="text-sm font-medium text-foreground truncate">
                  {user.name || t('default_name')}
                </p>
                <p className="text-xs text-muted truncate">{user.email}</p>
              </div>

              {/* Workspace switcher */}
              <div className="border-b border-default">
                <button
                  onClick={handleShowWorkspaces}
                  data-testid="user-menu-workspace-toggle"
                  className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-muted hover:text-foreground hover:bg-background-muted transition-default"
                >
                  <span className="shrink-0 opacity-70">
                    <Building2 className="w-4 h-4" />
                  </span>
                  <span className="flex-1 text-left">{t('switch_workspace')}</span>
                  <ChevronDown
                    className={`w-3 h-3 text-subtle transition-transform ${showWorkspaces ? 'rotate-180' : ''}`}
                  />
                </button>

                <AnimatePresence>
                  {showWorkspaces && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="overflow-hidden"
                    >
                      <div className="px-2 pb-2 max-h-48 overflow-y-auto">
                        {loadingWorkspaces && (
                          <div className="flex items-center justify-center py-3">
                            <Loader2 className="w-4 h-4 text-muted animate-spin" />
                          </div>
                        )}

                        {!loadingWorkspaces && workspaces.length === 0 && (
                          <p className="text-xs text-subtle px-2 py-2">
                            {t('no_other_workspaces')}
                          </p>
                        )}

                        {!loadingWorkspaces &&
                          workspaces.map((ws) => {
                            const isCurrent = ws.tenantId === tenantId;
                            const isSwitching = switchingTo === ws.tenantId;

                            return (
                              <button
                                key={ws.tenantId}
                                onClick={() => handleSwitchWorkspace(ws.tenantId)}
                                disabled={isCurrent || !!switchingTo}
                                className={`flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-lg text-sm transition-default ${
                                  isCurrent
                                    ? 'bg-accent-subtle text-accent'
                                    : 'text-muted hover:text-foreground hover:bg-background-muted disabled:opacity-50'
                                }`}
                              >
                                <div className="w-6 h-6 rounded-md bg-background-muted flex items-center justify-center text-xs font-medium text-muted shrink-0">
                                  {ws.tenantName.charAt(0).toUpperCase()}
                                </div>
                                <div className="flex-1 min-w-0 text-left">
                                  <p className="truncate text-sm">{ws.tenantName}</p>
                                  <p className="text-xs text-subtle">{ws.role}</p>
                                </div>
                                {isCurrent && (
                                  <Check className="w-3.5 h-3.5 text-accent shrink-0" />
                                )}
                                {isSwitching && (
                                  <Loader2 className="w-3.5 h-3.5 text-muted animate-spin shrink-0" />
                                )}
                              </button>
                            );
                          })}

                        {!loadingWorkspaces && user?.canCreateWorkspace !== false && (
                          <button
                            onClick={handleCreateWorkspace}
                            data-testid="user-menu-create-workspace"
                            className="flex items-center gap-2.5 w-full mt-2 px-2.5 py-1.5 rounded-lg text-sm text-muted hover:text-foreground hover:bg-background-muted transition-default"
                          >
                            <span className="shrink-0 opacity-70">
                              <Plus className="w-4 h-4" />
                            </span>
                            <span className="flex-1 text-left">{t('create_workspace')}</span>
                          </button>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Menu items */}
              <div className="py-1">
                <MenuItem
                  icon={<UserIcon className="w-4 h-4" />}
                  label={t('profile')}
                  onClick={() => {
                    setIsOpen(false);
                    setProfileOpen(true);
                  }}
                />
                <MenuItem
                  icon={<Key className="w-4 h-4" />}
                  label={t('api_keys')}
                  onClick={() => {
                    setIsOpen(false);
                    setApiKeysOpen(true);
                  }}
                />
                {canOpenWorkspaceAdmin && (
                  <MenuItem
                    icon={<Shield className="w-4 h-4" />}
                    label={t('admin')}
                    shortcut="G A"
                    onClick={() => {
                      setIsOpen(false);
                      navigate('/admin/members');
                    }}
                  />
                )}
              </div>

              {/* Docs & Academy links */}
              <div className="py-1 border-t border-default">
                {docsAllowed && (
                  <MenuItem
                    icon={<BookOpen className="w-4 h-4" />}
                    label={t('docs')}
                    onClick={() => {
                      setIsOpen(false);
                      window.open('/docs', '_blank', 'noopener,noreferrer');
                    }}
                  />
                )}
                <MenuItem
                  icon={<GraduationCap className="w-4 h-4" />}
                  label={t('academy')}
                  onClick={() => {
                    setIsOpen(false);
                    window.location.href = '/academy';
                  }}
                />
                <MenuItem
                  icon={<Store className="w-4 h-4" />}
                  label={t('templateStore')}
                  onClick={() => {
                    setIsOpen(false);
                    window.location.href = '/marketplace';
                  }}
                />
              </div>

              {/* Theme selector — single row */}
              <div className="py-2 px-4 border-t border-default">
                <div className="flex items-center gap-1 rounded-lg bg-background-muted p-0.5">
                  {(
                    [
                      { value: 'system', icon: Monitor, label: t('theme_system') },
                      { value: 'light', icon: Sun, label: t('theme_light') },
                      { value: 'dark', icon: Moon, label: t('theme_dark') },
                    ] as const
                  ).map(({ value, icon: Icon, label }) => (
                    <button
                      key={value}
                      onClick={() => setMode(value)}
                      data-testid={`theme-${value}`}
                      className={`flex items-center justify-center gap-1.5 flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-default ${
                        mode === value
                          ? 'bg-background-elevated text-foreground shadow-sm'
                          : 'text-muted hover:text-foreground'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Logout */}
              <div className="py-1 border-t border-default">
                <MenuItem
                  icon={<LogOut className="w-4 h-4" />}
                  label={t('sign_out')}
                  variant="danger"
                  onClick={handleLogout}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <ProfilePanel open={profileOpen} onClose={() => setProfileOpen(false)} />
      <ApiKeysPanel open={apiKeysOpen} onClose={() => setApiKeysOpen(false)} />
    </>
  );
}

function MenuItem({
  icon,
  label,
  shortcut,
  variant = 'default',
  end,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  variant?: 'default' | 'danger';
  end?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 w-full px-4 py-2 text-sm transition-default ${
        variant === 'danger'
          ? 'text-error hover:bg-error-subtle'
          : 'text-muted hover:text-foreground hover:bg-background-muted'
      }`}
    >
      <span className="shrink-0 text-current opacity-70">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {shortcut && <span className="text-xs text-subtle font-mono">{shortcut}</span>}
      {end && <span className="shrink-0">{end}</span>}
    </button>
  );
}
