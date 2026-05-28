'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { ArrowRight, BookOpen, Clock } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api-client';
import { useAcademyStore, selectAcademyProgress } from '@/store/academy-store';
import type { CourseCertification } from '@/store/academy-store';
import {
  ModuleCard,
  type ModuleCardData,
  type ModuleCardProgress,
} from '@/components/academy/ModuleCard';
import { AcademyBreadcrumbs } from '@/components/academy/AcademyBreadcrumbs';
import { LevelBadge } from '@/components/academy/LevelBadge';
import { ProgressBar } from '@/components/academy/ProgressBar';
import { CertificationSection } from '@/components/academy/CertificationSection';
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';

interface CourseDetail {
  id: string;
  title: string;
  description: string;
  level: string;
  estimatedMinutes: number;
  modules: string[];
  certification?: CourseCertification;
}

interface ModuleFromApi {
  id: string;
  title: string;
  lessons: Array<{ id: string; title: string }>;
}

export default function AcademyCourseDetailPage() {
  const t = useTranslations('academy');
  const router = useRouter();
  const params = useParams();
  const courseId = typeof params.courseId === 'string' ? params.courseId : '';

  const progress = useAcademyStore(selectAcademyProgress);
  const fetchProgress = useAcademyStore((s) => s.fetchProgress);

  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [modules, setModules] = useState<ModuleFromApi[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProgress();
  }, [fetchProgress]);

  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;

    async function loadCourse() {
      setLoading(true);
      setError(null);
      try {
        // Fetch course details
        const courseRes = await apiFetch(`/api/academy/courses/${courseId}`);
        if (!courseRes.ok) {
          const body = await courseRes.json().catch(() => ({}));
          const msg =
            body?.error?.message ?? body?.error ?? `Failed to load course (${courseRes.status})`;
          if (!cancelled) setError(typeof msg === 'string' ? msg : String(msg));
          return;
        }
        const courseData = await courseRes.json();
        const courseObj: CourseDetail = courseData.data ?? courseData;
        if (!cancelled) setCourse(courseObj);

        // Fetch each module's details
        const modulePromises = courseObj.modules.map(async (modId: string) => {
          const modRes = await apiFetch(`/api/academy/modules/${modId}`);
          if (!modRes.ok) return null;
          const modData = await modRes.json();
          return (modData.data ?? modData) as ModuleFromApi;
        });

        const moduleResults = await Promise.all(modulePromises);
        const loadedModules = moduleResults.filter((m): m is ModuleFromApi => m !== null);
        if (!cancelled) setModules(loadedModules);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadCourse();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const handleModuleClick = useCallback(
    (moduleId: string) => {
      router.push(`/academy/modules/${moduleId}?courseId=${courseId}`);
    },
    [router, courseId],
  );

  const getModuleProgress = useCallback(
    (moduleId: string): ModuleCardProgress | null => {
      const modulesObj = progress?.modules;
      if (!modulesObj) return null;
      const mp = modulesObj[moduleId];
      if (!mp) return null;
      return {
        contentRead: mp.contentRead,
        quizPassed: mp.quizPassed,
        bestScore: mp.bestScore,
      };
    },
    [progress],
  );

  // Compute course-level progress: passed=100%, read-only=50%, not started=0%
  const { passedCount, totalCount, progressPercent } = useMemo(() => {
    const total = course?.modules.length ?? 0;
    if (total === 0) return { passedCount: 0, totalCount: 0, progressPercent: 0 };

    const modulesObj = progress?.modules;
    if (!modulesObj) return { passedCount: 0, totalCount: total, progressPercent: 0 };

    let passed = 0;
    let readOnly = 0;
    for (const modId of course!.modules) {
      const mp = modulesObj[modId];
      if (mp?.quizPassed) {
        passed++;
      } else if (mp?.contentRead) {
        readOnly++;
      }
    }

    return {
      passedCount: passed,
      totalCount: total,
      progressPercent: Math.round((passed * 100 + readOnly * 50) / total),
    };
  }, [course, progress]);

  // Determine if certification badge is earned (all modules passed)
  const certificationEarned = useMemo(() => {
    if (!course?.certification?.required) return false;
    if (totalCount === 0) return false;
    return passedCount === totalCount;
  }, [course, passedCount, totalCount]);

  // Find first incomplete module for "Continue Learning" CTA
  const continueModuleId = useMemo(() => {
    if (!course || !progress?.modules) return null;
    for (const modId of course.modules) {
      const mp = progress.modules[modId];
      if (!mp?.quizPassed) return modId;
    }
    return null;
  }, [course, progress]);

  // Breadcrumb configuration for the certification badge
  const badgeConfig = useMemo(() => {
    if (!course?.certification) return null;
    const config = useAcademyStore.getState().config;
    const badge = config?.badges?.find((b) => b.id === course.certification?.badge);
    return badge ?? null;
  }, [course]);

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <SkeletonText lines={1} className="w-48" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-64 rounded" />
          <Skeleton className="h-4 w-full rounded" />
          <Skeleton className="h-4 w-32 rounded" />
        </div>
        <Skeleton className="h-2.5 w-full rounded-full" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-error-subtle bg-error-subtle p-4">
        <p className="text-sm text-error">{error}</p>
      </div>
    );
  }

  if (!course) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-foreground-muted">{t('course_not_found')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumbs */}
      <AcademyBreadcrumbs
        items={[
          { label: t('title'), href: '/academy' },
          { label: t('courses'), href: '/academy/courses' },
          { label: course.title },
        ]}
      />

      {/* Course header */}
      <div>
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-foreground">{course.title}</h2>
          <LevelBadge level={course.level} />
        </div>
        <p className="mt-1 text-sm text-foreground-muted">{course.description}</p>
        <div className="mt-2 flex items-center gap-3 text-xs text-foreground-subtle">
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {t('estimated_time', { minutes: course.estimatedMinutes })}
          </span>
          <span>·</span>
          <span>{t('module_count', { count: course.modules.length })}</span>
        </div>
      </div>

      {/* Progress bar */}
      <ProgressBar
        value={progressPercent}
        label={t('course_progress', { passed: passedCount, total: totalCount })}
      />

      {/* Continue Learning CTA */}
      {continueModuleId && (
        <Link
          href={`/academy/modules/${continueModuleId}?courseId=${courseId}`}
          className="hover-lift flex items-center gap-2 self-start rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground transition-default hover:bg-accent-muted"
        >
          {t('continue_learning_cta')}
          <ArrowRight className="h-4 w-4" />
        </Link>
      )}

      {/* Modules list */}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-foreground">{t('modules_heading')}</h3>
        {modules.length === 0 ? (
          <EmptyState icon={<BookOpen className="h-6 w-6" />} title={t('no_modules')} />
        ) : (
          modules.map((mod, idx) => (
            <ModuleCard
              key={mod.id}
              module={mod as ModuleCardData}
              progress={getModuleProgress(mod.id)}
              onClick={handleModuleClick}
              index={idx}
              showConnector={idx > 0}
            />
          ))
        )}
      </div>

      {/* Certification section */}
      {course.certification?.required && (
        <CertificationSection
          badgeId={course.certification.badge}
          badgeTitle={badgeConfig?.title ?? course.certification.badge}
          earned={certificationEarned}
        />
      )}
    </div>
  );
}
