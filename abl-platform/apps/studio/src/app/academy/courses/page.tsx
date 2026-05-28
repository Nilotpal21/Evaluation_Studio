'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { useAcademyStore, selectAcademyProgress } from '@/store/academy-store';
import { BookOpen } from 'lucide-react';
import {
  CourseCard,
  type CourseCardData,
  type CourseModuleProgress,
} from '@/components/academy/CourseCard';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';

interface CourseFromApi {
  id: string;
  title: string;
  description: string;
  modules: string[];
}

export default function AcademyCoursesPage() {
  const t = useTranslations('academy');
  const router = useRouter();

  const progress = useAcademyStore(selectAcademyProgress);
  const fetchProgress = useAcademyStore((s) => s.fetchProgress);

  const [courses, setCourses] = useState<CourseFromApi[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProgress();
  }, [fetchProgress]);

  useEffect(() => {
    let cancelled = false;

    async function loadCourses() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch('/api/academy/courses');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg =
            body?.error?.message ?? body?.error ?? `Failed to load courses (${res.status})`;
          if (!cancelled) setError(typeof msg === 'string' ? msg : String(msg));
          return;
        }
        const data = await res.json();
        if (!cancelled) setCourses(data.data ?? data ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadCourses();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCourseClick = useCallback(
    (courseId: string) => {
      router.push(`/academy/courses/${courseId}`);
    },
    [router],
  );

  /** Build a progress map for a given course's modules from the flat progress record */
  const buildCourseProgress = useCallback(
    (courseModules: string[]): Map<string, CourseModuleProgress> | null => {
      const modulesObj = progress?.modules;
      if (!modulesObj) return null;

      const map = new Map<string, CourseModuleProgress>();
      for (const modId of courseModules) {
        const mp = modulesObj[modId];
        if (mp) {
          map.set(modId, { contentRead: mp.contentRead, quizPassed: mp.quizPassed });
        }
      }
      return map;
    },
    [progress],
  );

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('courses')}</h2>
        <p className="mt-1 text-sm text-foreground-muted">{t('courses_subtitle')}</p>
      </div>

      {courses.length === 0 ? (
        <EmptyState icon={<BookOpen className="h-6 w-6" />} title={t('no_courses')} />
      ) : (
        <div className="stagger-children grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {courses.map((course) => (
            <CourseCard
              key={course.id}
              course={course as CourseCardData}
              progress={buildCourseProgress(course.modules)}
              onClick={handleCourseClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
