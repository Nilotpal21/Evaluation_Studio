'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Check } from 'lucide-react';
import { ProgressBar } from './ProgressBar';

interface ModuleProgress {
  contentRead: boolean;
  quizPassed: boolean;
}

interface ModuleSidebarProps {
  courseId: string;
  courseTitle: string;
  modules: Array<{ id: string; title: string }>;
  currentModuleId: string;
  progress: Record<string, ModuleProgress> | null;
}

export function ModuleSidebar({
  courseId,
  courseTitle,
  modules,
  currentModuleId,
  progress,
}: ModuleSidebarProps) {
  const t = useTranslations('academy');
  const router = useRouter();

  const passedCount = modules.filter((m) => progress?.[m.id]?.quizPassed).length;
  const readOnlyCount = modules.filter(
    (m) => progress?.[m.id]?.contentRead && !progress?.[m.id]?.quizPassed,
  ).length;
  // Combined progress: passed=100%, read-only=50%, not started=0%
  const progressValue =
    modules.length > 0 ? Math.round((passedCount * 100 + readOnlyCount * 50) / modules.length) : 0;

  return (
    <aside className="sticky top-0 flex max-h-screen flex-col overflow-y-auto">
      {/* Back link */}
      <Link
        href={`/academy/courses/${courseId}`}
        className="flex items-center gap-1.5 px-3 py-3 text-xs font-medium text-foreground-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('back_to_course')}
      </Link>

      {/* Course title + progress */}
      <div className="border-b border-border px-3 pb-3">
        <h3 className="text-sm font-semibold text-foreground">{courseTitle}</h3>
        <p className="mt-1 text-xs text-foreground-muted">
          {t('modules_passed_of', { passed: passedCount, total: modules.length })}
        </p>
        <div className="mt-2">
          <ProgressBar value={progressValue} />
        </div>
      </div>

      {/* Module list */}
      <nav className="flex flex-col gap-0.5 px-1.5 py-2">
        {modules.map((mod, idx) => {
          const isActive = mod.id === currentModuleId;
          const modProgress = progress?.[mod.id];
          const quizPassed = modProgress?.quizPassed ?? false;
          const contentRead = modProgress?.contentRead ?? false;

          return (
            <button
              key={mod.id}
              type="button"
              onClick={() => router.push(`/academy/modules/${mod.id}?courseId=${courseId}`)}
              className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors ${
                isActive
                  ? 'border-l-2 border-accent bg-accent/5 font-medium text-foreground'
                  : 'text-foreground-muted hover:bg-background-muted hover:text-foreground'
              }`}
            >
              {/* Status indicator */}
              {quizPassed ? (
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success">
                  <Check className="h-2.5 w-2.5 text-success-foreground" />
                </span>
              ) : contentRead ? (
                <span className="h-4 w-4 shrink-0 rounded-full bg-accent" />
              ) : (
                <span className="h-4 w-4 shrink-0 rounded-full border-2 border-foreground-subtle/30" />
              )}

              <span className="min-w-0 truncate">
                {idx + 1}. {mod.title}
              </span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
