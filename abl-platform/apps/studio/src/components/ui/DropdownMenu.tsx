'use client';

import { clsx } from 'clsx';
import * as RadixDropdown from '@radix-ui/react-dropdown-menu';

interface DropdownMenuProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  sideOffset?: number;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}

export function DropdownMenu({
  trigger,
  children,
  align = 'end',
  side = 'bottom',
  sideOffset = 6,
  className,
  onOpenChange,
}: DropdownMenuProps) {
  return (
    <RadixDropdown.Root onOpenChange={onOpenChange}>
      <RadixDropdown.Trigger asChild>{trigger}</RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content
          align={align}
          side={side}
          sideOffset={sideOffset}
          className={clsx(
            'z-50 min-w-44 overflow-hidden rounded-xl',
            'border border-default bg-background-elevated/95 shadow-2xl backdrop-blur-md',
            'supports-[backdrop-filter]:bg-background-elevated/88',
            'p-1.5 animate-fade-in-scale bg-noise',
            className,
          )}
        >
          {children}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}

interface DropdownMenuItemProps {
  children: React.ReactNode;
  onSelect: () => void;
  variant?: 'default' | 'danger';
  icon?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

export function DropdownMenuItem({
  children,
  onSelect,
  variant = 'default',
  icon,
  disabled,
  className,
}: DropdownMenuItemProps) {
  return (
    <RadixDropdown.Item
      onSelect={onSelect}
      disabled={disabled}
      className={clsx(
        'flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg cursor-pointer outline-none transition-default',
        'data-[highlighted]:bg-accent-subtle',
        variant === 'danger'
          ? 'text-error data-[highlighted]:text-error'
          : 'text-muted data-[highlighted]:text-foreground',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
    >
      {icon}
      {children}
    </RadixDropdown.Item>
  );
}

export function DropdownMenuSeparator() {
  return <RadixDropdown.Separator className="h-px bg-border my-1" />;
}

export function DropdownMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <RadixDropdown.Label className="px-3 py-1.5 text-xs font-medium text-subtle uppercase tracking-wide">
      {children}
    </RadixDropdown.Label>
  );
}
