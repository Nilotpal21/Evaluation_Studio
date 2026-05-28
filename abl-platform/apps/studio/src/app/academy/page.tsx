'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  useAcademyStore,
  selectAcademyConfig,
  selectAcademyProgress,
  selectAcademyCourses,
  selectAcademyLoading,
  selectAcademyError,
} from '@/store/academy-store';
import type { AcademyPersonaCourseMapEntry, StoreCourseConfig } from '@/store/academy-store';
import { ArrowRight, BookOpen, GraduationCap } from 'lucide-react';
import Link from 'next/link';
import { PersonaCard } from '@/components/academy/PersonaCard';
import { CourseCard } from '@/components/academy/CourseCard';
import type { CourseModuleProgress } from '@/components/academy/CourseCard';
import { ProgressBar } from '@/components/academy/ProgressBar';
import { DashboardStats } from '@/components/academy/DashboardStats';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';

/** Compute overall progress percent for a set of courses */
function computePersonaProgress(
  personaCourses: StoreCourseConfig[],
  modules: Record<string, { contentRead: boolean; quizPassed: boolean }> | undefined,
): number {
  if (!modules) return 0;
  let modulesDone = 0;
  let modulesReadOnly = 0;
  let totalModules = 0;
  for (const course of personaCourses) {
    totalModules += course.modules.length;
    for (const modId of course.modules) {
      const mp = modules[modId];
      if (mp?.quizPassed) {
        modulesDone++;
      } else if (mp?.contentRead) {
        modulesReadOnly++;
      }
    }
  }
  return totalModules > 0
    ? Math.round((modulesDone * 100 + modulesReadOnly * 50) / totalModules)
    : 0;
}

export default function AcademyDashboardPage() {
  const t = useTranslations('academy');
  const router = useRouter();

  const config = useAcademyStore(selectAcademyConfig);
  const progress = useAcademyStore(selectAcademyProgress);
  const courses = useAcademyStore(selectAcademyCourses);
  const loading = useAcademyStore(selectAcademyLoading);
  const error = useAcademyStore(selectAcademyError);
  const fetchConfig = useAcademyStore((s) => s.fetchConfig);
  const fetchProgress = useAcademyStore((s) => s.fetchProgress);
  const setPersona = useAcademyStore((s) => s.setPersona);

  useEffect(() => {
    fetchConfig();
    fetchProgress();
  }, [fetchConfig, fetchProgress]);

  const handlePersonaSelect = useCallback(
    (personaId: string) => {
      setPersona(personaId);
    },
    [setPersona],
  );

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
          map.set(modId, {
            contentRead: mp.contentRead,
            quizPassed: mp.quizPassed,
          });
        }
      }
      return map;
    },
    [progress],
  );

  /** Per-persona progress for the card selector */
  const personaProgressMap = useMemo(() => {
    const map: Record<string, number> = {};
    if (!config?.personas || !courses) return map;
    for (const persona of config.personas) {
      const courseMap = config.personaCourseMap?.[persona.id];
      const personaCourseIds = new Set(courseMap?.courses ?? []);
      const personaCourses = courses.filter((c) => personaCourseIds.has(c.id));
      map[persona.id] = computePersonaProgress(personaCourses, progress?.modules);
    }
    return map;
  }, [config, courses, progress?.modules]);

  // Loading state
  if (loading && !config) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="rounded-lg border border-error-subtle bg-error-subtle p-4">
        <p className="text-sm text-error">{error}</p>
      </div>
    );
  }

  const selectedPersonaId = progress?.selectedPersona ?? null;

  return (
    <div className="flex flex-col gap-6">
      {/* Hero — compact when a persona is selected */}
      <div className="flex flex-col items-center gap-2 py-4 text-center">
        {config?.version && (
          <span className="inline-flex rounded-full bg-accent-subtle px-3 py-0.5 text-xs font-medium text-accent">
            v{config.version}
          </span>
        )}
        <h1 className="text-xl font-bold text-accent sm:text-2xl">{t('hero_title')}</h1>
        {!selectedPersonaId && (
          <p className="max-w-2xl text-sm leading-relaxed text-foreground-muted">
            {t('hero_subtitle')}
          </p>
        )}
      </div>

      {/* Persona selector row — always visible */}
      {config?.personas && config.personas.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground-muted">
            <GraduationCap className="h-3.5 w-3.5" />
            {t('select_persona')}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {config.personas.map((persona) => {
              const courseMap = config.personaCourseMap?.[persona.id];
              return (
                <PersonaCard
                  key={persona.id}
                  persona={persona}
                  selected={persona.id === selectedPersonaId}
                  onSelect={handlePersonaSelect}
                  courseCount={courseMap?.courses?.length}
                  estimatedHours={courseMap?.estimatedHours}
                  progressPercent={personaProgressMap[persona.id]}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Prompt to select if no persona is active */}
      {!selectedPersonaId && (
        <p className="text-center text-sm text-foreground-muted">{t('select_path')}</p>
      )}

      {/* Dashboard content for selected persona */}
      {selectedPersonaId && progress && (
        <PersonaDashboard
          config={config}
          progress={progress}
          courses={courses}
          selectedPersonaId={selectedPersonaId}
          onCourseClick={handleCourseClick}
          buildCourseProgress={buildCourseProgress}
          t={t}
        />
      )}
    </div>
  );
}

// ─── Persona Dashboard Sub-Component ──────────────────────────────────────────

interface PersonaDashboardProps {
  config: ReturnType<typeof selectAcademyConfig>;
  progress: NonNullable<ReturnType<typeof selectAcademyProgress>>;
  courses: StoreCourseConfig[] | null;
  selectedPersonaId: string;
  onCourseClick: (courseId: string) => void;
  buildCourseProgress: (modules: string[]) => Map<string, CourseModuleProgress> | null;
  t: ReturnType<typeof useTranslations<'academy'>>;
}

function PersonaDashboard({
  config,
  progress,
  courses,
  selectedPersonaId,
  onCourseClick,
  buildCourseProgress,
  t,
}: PersonaDashboardProps) {
  const persona = config?.personas?.find((p) => p.id === selectedPersonaId);
  const courseMap: AcademyPersonaCourseMapEntry | undefined =
    config?.personaCourseMap?.[selectedPersonaId];
  const personaCourseIds = courseMap?.courses ?? [];

  // Filter courses for this persona
  const personaCourses = useMemo(() => {
    if (!courses) return [];
    const idSet = new Set(personaCourseIds);
    return courses.filter((c) => idSet.has(c.id));
  }, [courses, personaCourseIds]);

  // Compute overall progress: passed=100%, read-only=50%, not started=0%
  const { completedCourses, totalModulesDone, overallPercent } = useMemo(() => {
    const modulesObj = progress.modules ?? {};
    let completed = 0;
    let modulesDone = 0;
    let modulesReadOnly = 0;
    let totalModules = 0;

    for (const course of personaCourses) {
      totalModules += course.modules.length;
      let allPassed = course.modules.length > 0;
      for (const modId of course.modules) {
        const mp = modulesObj[modId];
        if (mp?.quizPassed) {
          modulesDone++;
        } else if (mp?.contentRead) {
          modulesReadOnly++;
          allPassed = false;
        } else {
          allPassed = false;
        }
      }
      if (allPassed) {
        completed++;
      }
    }

    const percent =
      totalModules > 0 ? Math.round((modulesDone * 100 + modulesReadOnly * 50) / totalModules) : 0;

    return {
      completedCourses: completed,
      totalModulesDone: modulesDone,
      overallPercent: percent,
    };
  }, [personaCourses, progress.modules]);

  // Find next incomplete module for "Continue Learning" CTA
  const continueLink = useMemo(() => {
    const modulesObj = progress.modules ?? {};
    for (const course of personaCourses) {
      for (const modId of course.modules) {
        if (!modulesObj[modId]?.quizPassed) {
          return `/academy/modules/${modId}?courseId=${course.id}`;
        }
      }
    }
    return null;
  }, [personaCourses, progress.modules]);

  const stats = [
    {
      key: 'courses',
      label: t('stat_courses'),
      value: t('stat_courses_progress', {
        completed: completedCourses,
        total: personaCourses.length,
      }),
    },
    {
      key: 'modules',
      label: t('stat_modules_done'),
      value: String(totalModulesDone),
    },
    {
      key: 'points',
      label: t('stat_points'),
      value: String(progress.points ?? 0),
    },
    {
      key: 'time',
      label: t('stat_est_time'),
      value: courseMap?.estimatedHours
        ? t('course_time_hours', { hours: courseMap.estimatedHours })
        : '\u2014',
    },
  ];

  return (
    <>
      {/* Overall progress bar */}
      <ProgressBar value={overallPercent} label={`${overallPercent}%`} />

      {/* Stats row + Continue Learning CTA */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {stats.map((stat) => (
          <div
            key={stat.key}
            className="flex flex-col gap-1 rounded-xl border border-border bg-background-elevated p-3"
          >
            <span className="text-xs text-foreground-muted">{stat.label}</span>
            <p className="text-lg font-semibold text-foreground">{stat.value}</p>
          </div>
        ))}
        {continueLink && (
          <Link
            href={continueLink}
            className="hover-lift flex flex-col items-center justify-center gap-1.5 rounded-xl bg-accent p-3 text-center transition-default hover:bg-accent-muted"
          >
            <span className="text-sm font-semibold text-accent-foreground">
              {t('continue_learning_cta')}
            </span>
            <ArrowRight className="h-4 w-4 text-accent-foreground" />
          </Link>
        )}
      </div>

      {/* Course cards grid — primary content */}
      {personaCourses.length === 0 ? (
        <EmptyState icon={<BookOpen className="h-6 w-6" />} title={t('no_courses')} />
      ) : (
        <div className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground-muted">
            <BookOpen className="h-3.5 w-3.5" />
            {t('courses')}
          </h2>
          <div className="stagger-children grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {personaCourses.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                progress={buildCourseProgress(course.modules)}
                onClick={onCourseClick}
                level={course.level}
                estimatedMinutes={course.estimatedMinutes}
              />
            ))}
          </div>
        </div>
      )}

      {/* Gamification stats: rank, streak, badges — below courses */}
      <DashboardStats
        points={progress.points ?? 0}
        badges={progress.badges ?? []}
        streakDays={progress.streakDays ?? []}
        lastActiveDate={progress.lastActiveDate ?? null}
        allBadges={config?.badges ?? []}
        ranks={config?.ranks ?? []}
      />
    </>
  );
}
