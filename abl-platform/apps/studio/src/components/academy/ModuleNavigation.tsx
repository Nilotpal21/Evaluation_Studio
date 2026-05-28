'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface ModuleRef {
  id: string;
  title: string;
}

interface ModuleNavigationProps {
  prevModule?: ModuleRef | null;
  nextModule?: ModuleRef | null;
  courseId?: string;
}

function buildModuleHref(moduleId: string, courseId?: string): string {
  const base = `/academy/modules/${moduleId}`;
  return courseId ? `${base}?courseId=${courseId}` : base;
}

export function ModuleNavigation({ prevModule, nextModule, courseId }: ModuleNavigationProps) {
  const t = useTranslations('academy');

  if (!prevModule && !nextModule) {
    return null;
  }

  return (
    <nav className="flex items-center justify-between border-t border-border pt-4">
      {/* Previous */}
      <div>
        {prevModule ? (
          <Link
            href={buildModuleHref(prevModule.id, courseId)}
            className="hover-lift flex items-center gap-1.5 text-sm text-foreground-muted transition-default hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="flex flex-col">
              <span className="text-xs text-foreground-muted">{t('prev_module')}</span>
              <span className="font-medium text-foreground">{prevModule.title}</span>
            </span>
          </Link>
        ) : (
          <span />
        )}
      </div>

      {/* Next */}
      <div>
        {nextModule ? (
          <Link
            href={buildModuleHref(nextModule.id, courseId)}
            className="hover-lift flex items-center gap-1.5 text-right text-sm text-foreground-muted transition-default hover:text-foreground"
          >
            <span className="flex flex-col">
              <span className="text-xs text-foreground-muted">{t('next_module')}</span>
              <span className="font-medium text-foreground">{nextModule.title}</span>
            </span>
            <ChevronRight className="h-4 w-4" />
          </Link>
        ) : (
          <span />
        )}
      </div>
    </nav>
  );
}
