'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { LayoutDashboard, BookOpen, Trophy } from 'lucide-react';
import { useAcademyStore, selectAcademyProgress } from '@/store/academy-store';

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

export function AcademySidebar() {
  const pathname = usePathname();
  const t = useTranslations('academy');
  const progress = useAcademyStore(selectAcademyProgress);

  return (
    <nav className="flex w-60 shrink-0 flex-col border-r border-default bg-background-subtle sidebar-bg">
      <div className="flex flex-1 flex-col gap-1 p-3">
        {NAV_ITEMS.map(({ href, labelKey, icon: Icon }) => {
          const isActive =
            href === '/academy' ? pathname === '/academy' : pathname.startsWith(href);

          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-default ${
                isActive
                  ? 'bg-gradient-brand-subtle text-accent border-l-2 border-accent'
                  : 'text-muted hover:text-foreground hover:bg-background-muted'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{t(labelKey)}</span>
            </Link>
          );
        })}
      </div>
      {progress && (
        <div className="mt-auto border-t border-default px-3 py-3">
          <div className="flex items-center gap-3 text-xs text-foreground-muted">
            <span>{t('your_points', { points: progress.points ?? 0 })}</span>
            <span className="text-foreground-subtle">·</span>
            <span>{t('your_badges_count', { count: progress.badges?.length ?? 0 })}</span>
          </div>
        </div>
      )}
    </nav>
  );
}
