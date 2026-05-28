import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
  onConfirm: () => void;
  loading?: boolean;
  loadingLabel?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  loading = false,
  loadingLabel = 'Loading...',
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2',
            'rounded-lg border border-border',
            'bg-background-subtle p-6 shadow-xl',
            'focus:outline-none',
          )}
        >
          <div className="flex items-start justify-between">
            <Dialog.Title className="text-lg font-semibold text-foreground">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="rounded-md p-1 text-foreground-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-2 text-sm text-foreground-muted">
            {description}
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close asChild>
              <button
                className={cn(
                  'rounded-md border border-border px-4 py-2 text-sm font-medium',
                  'text-foreground-muted',
                  'hover:bg-background-muted',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                )}
                disabled={loading}
              >
                {cancelLabel}
              </button>
            </Dialog.Close>
            <button
              onClick={onConfirm}
              disabled={loading}
              className={cn(
                'rounded-md px-4 py-2 text-sm font-medium',
                'focus:outline-none focus-visible:ring-2',
                variant === 'destructive'
                  ? 'bg-error text-error-foreground hover:bg-error-muted focus-visible:ring-error'
                  : 'bg-accent text-accent-foreground hover:bg-accent-muted focus-visible:ring-accent',
                loading && 'cursor-not-allowed opacity-50',
              )}
            >
              {loading ? loadingLabel : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
