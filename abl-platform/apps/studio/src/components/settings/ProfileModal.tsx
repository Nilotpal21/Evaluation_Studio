'use client';

/**
 * Profile Slide-Out Panel
 *
 * Shows user profile info and account details.
 * Triggered from the UserMenu dropdown.
 */

import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { X, Mail, Building2, Shield, Copy, Check } from 'lucide-react';
import { springs } from '../../lib/animation';
import { OVERLAY_BACKDROP } from '@agent-platform/design-tokens';
import { useAuthStore } from '../../store/auth-store';
import { Avatar } from '../ui/Avatar';

export function ProfileModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const t = useTranslations('settings.profile');
  const { user, tenantId } = useAuthStore();

  if (!user) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className={OVERLAY_BACKDROP}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          {/* Slide-out panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={springs.gentle}
            className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-md bg-background-elevated border-l border-default shadow-xl flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-default shrink-0">
              <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
              <button
                onClick={onClose}
                className="text-muted hover:text-foreground transition-default p-1.5 rounded-md hover:bg-background-muted"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-6">
              {/* Avatar + name */}
              <div className="flex items-center gap-4 mb-8">
                <Avatar name={user.name || user.email} src={user.avatarUrl} size="lg" />
                <div className="min-w-0">
                  <p className="text-base font-medium text-foreground truncate">
                    {user.name || t('default_name')}
                  </p>
                  <p className="text-sm text-muted truncate">{user.email}</p>
                </div>
              </div>

              {/* Info rows */}
              <div className="space-y-4">
                <InfoRow
                  icon={<Mail className="w-4 h-4" />}
                  label={t('email')}
                  value={user.email}
                />
                {tenantId && (
                  <InfoRow
                    icon={<Building2 className="w-4 h-4" />}
                    label={t('organization')}
                    value={tenantId}
                    copyable
                    copyLabel={t('copy_to_clipboard')}
                  />
                )}
                <InfoRow
                  icon={<Shield className="w-4 h-4" />}
                  label={t('user_id')}
                  value={user.id}
                  copyable
                  copyLabel={t('copy_to_clipboard')}
                />
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function InfoRow({
  icon,
  label,
  value,
  copyable,
  copyLabel,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  copyable?: boolean;
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may fail in insecure contexts
    }
  };

  return (
    <div className="flex items-start gap-3">
      <span className="text-muted shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted mb-0.5">{label}</p>
        <div className="flex items-center gap-1.5">
          <p className="text-sm text-foreground truncate font-mono">{value}</p>
          {copyable && (
            <button
              onClick={handleCopy}
              className="p-0.5 rounded text-muted hover:text-foreground transition-default shrink-0"
              title={copyLabel}
            >
              {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
