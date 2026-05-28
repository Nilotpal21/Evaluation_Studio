'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { personas, tenant } from '@/lib/mock-data';
import { usePersona, personaKeys } from '@/lib/persona';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

const hueClasses: Record<string, string> = {
  purple: 'bg-purple/20 text-purple',
  success: 'bg-success-subtle text-success',
  info: 'bg-info-subtle text-info',
  warning: 'bg-warning-subtle text-warning',
};

export function PersonaSwitcher() {
  const activeKey = usePersona((s) => s.activeKey);
  const setActive = usePersona((s) => s.setActive);
  const signOut = useAuth((s) => s.signOut);
  const active = personas[activeKey];
  const router = useRouter();

  const handleSignOut = () => {
    signOut();
    router.push('/login');
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(
            'size-7 rounded-full border border-border flex items-center justify-center text-[11px] font-medium transition-colors hover:border-foreground-muted',
            hueClasses[active.avatarHue],
          )}
          aria-label={`Switch persona — currently ${active.role}`}
        >
          {active.initials}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[280px] rounded-lg border border-border bg-background-elevated shadow-xl p-1 animate-fade-in"
        >
          <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-foreground-meta font-medium">
            Workspace
          </div>
          <div className="mx-1 px-3 py-2 rounded-md bg-background-muted">
            <div className="text-sm font-medium">{tenant.name}</div>
            <div className="text-[11px] text-foreground-muted mt-0.5">
              {tenant.charter} charter · {tenant.region} · $
              {(tenant.assetsUSD / 1e9).toFixed(1)}B assets
            </div>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border-muted" />
          <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-foreground-meta font-medium">
            Switch persona
          </div>
          {personaKeys.map((key) => {
            const p = personas[key];
            const isActive = key === activeKey;
            return (
              <DropdownMenu.Item
                key={key}
                onSelect={() => {
                  setActive(key);
                  router.push(p.home);
                }}
                className="flex items-center gap-2.5 px-3 py-2 rounded-md text-xs cursor-pointer outline-none focus:bg-background-muted data-[highlighted]:bg-background-muted"
              >
                <span
                  className={cn(
                    'size-7 rounded-full flex items-center justify-center text-[11px] font-medium shrink-0',
                    hueClasses[p.avatarHue],
                  )}
                >
                  {p.initials}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-foreground font-medium">{p.name}</span>
                  <span className="block text-[11px] text-foreground-muted">{p.role}</span>
                </span>
                {isActive && <Check className="size-3.5 text-foreground-muted shrink-0" />}
              </DropdownMenu.Item>
            );
          })}
          <DropdownMenu.Separator className="my-1 h-px bg-border-muted" />
          <DropdownMenu.Item
            onSelect={handleSignOut}
            className="flex items-center gap-2.5 px-3 py-2 rounded-md text-xs text-foreground-muted cursor-pointer outline-none focus:bg-background-muted data-[highlighted]:bg-background-muted hover:text-foreground"
          >
            <LogOut className="size-3.5" />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
