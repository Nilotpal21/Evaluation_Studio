/**
 * ConfirmDialog Component
 *
 * Confirmation dialog for destructive or important actions.
 */

import React from 'react';
import { useTranslations } from 'next-intl';
import { Dialog } from './Dialog';
import { Button } from './Button';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: 'danger' | 'primary';
  loading?: boolean;
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  variant = 'danger',
  loading,
  children,
}: ConfirmDialogProps) {
  const t = useTranslations('common');

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm">
      <div className="flex flex-col items-center text-center">
        <div
          className={`w-12 h-12 rounded-full flex items-center justify-center mb-4 ${
            variant === 'danger' ? 'bg-error-subtle' : 'bg-accent-subtle'
          }`}
        >
          <AlertTriangle
            className={`w-6 h-6 ${variant === 'danger' ? 'text-error' : 'text-accent'}`}
          />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-1">{title}</h3>
        <p className="text-sm text-muted mb-6">{description}</p>
        {children}
        <div className="flex gap-3 w-full">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('cancel')}
          </Button>
          <Button
            variant={variant === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
            className="flex-1"
          >
            {confirmLabel || t('confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
