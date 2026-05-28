'use client';

import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, LayoutDashboard, BookOpen, Trophy } from 'lucide-react';

interface NavItem {
  href: string;
  labelKey: 'dashboard' | 'courses' | 'leaderboard';
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/academy', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/academy/courses', labelKey: 'courses', icon: BookOpen },
  { href: '/academy/leaderboard', labelKey: 'leaderboard', icon: Trophy },
];

export function AcademyLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('academy');
  const pathname = usePathname();

  // Module viewer pages have their own navigation — hide the global nav tabs
  const isModulePage = pathname.startsWith('/academy/modules/');

  return (
    <div className="flex h-full flex-col overflow-hidden text-foreground bg-noise bg-background">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4 border-default glass relative z-10">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-semibold text-foreground">{t('title')}</h1>
          {!isModulePage && (
            <nav className="flex items-center gap-1">
              {NAV_ITEMS.map(({ href, labelKey, icon: Icon }) => {
                const isActive =
                  href === '/academy' ? pathname === '/academy' : pathname.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-default ${
                      isActive
                        ? 'bg-accent-subtle text-accent'
                        : 'text-foreground-muted hover:text-foreground hover:bg-background-muted'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {t(labelKey)}
                  </Link>
                );
              })}
            </nav>
          )}
        </div>
        <Link
          href="/"
          className="flex items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('back_to_studio')}
        </Link>
      </header>

      {/* Body: full-width main content */}
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
