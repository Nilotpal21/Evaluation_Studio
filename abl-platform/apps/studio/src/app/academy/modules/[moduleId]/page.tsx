'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { Menu } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-client';
import { useAcademyStore, selectAcademyProgress } from '@/store/academy-store';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/shadcn/sheet';
import { MarkdownContent } from '@/components/academy/MarkdownContent';
import { QuizForm, type QuizFormQuestion } from '@/components/academy/QuizForm';
import { QuizResults, type QuizResultData } from '@/components/academy/QuizResults';
import { AcademyBreadcrumbs } from '@/components/academy/AcademyBreadcrumbs';
import { ModuleStepSidebar } from '@/components/academy/ModuleStepSidebar';
import { SectionFooterNav } from '@/components/academy/SectionFooterNav';
import { ProgressBar } from '@/components/academy/ProgressBar';
import { VideoPlayer } from '@/components/academy/VideoPlayer';
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton';
import { splitMarkdownSections, type MarkdownSection } from '@/lib/academy/split-markdown-sections';

interface VideoRef {
  url: string;
  title: string;
  durationSeconds: number;
}

interface ModuleInfo {
  id: string;
  title: string;
  lessons: Array<{ id: string; title: string }>;
  videos?: Record<string, VideoRef>;
}

interface CourseContext {
  id: string;
  title: string;
  modules: Array<{ id: string; title: string }>;
}

export default function AcademyModuleViewerPage() {
  const t = useTranslations('academy');
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const moduleId = typeof params.moduleId === 'string' ? params.moduleId : '';
  const courseId = searchParams.get('courseId') ?? undefined;

  // Parse section from URL: number or 'quiz'
  const sectionParam = searchParams.get('section');
  const currentSection: number | 'quiz' = useMemo(() => {
    if (sectionParam === 'quiz') return 'quiz';
    const parsed = parseInt(sectionParam ?? '0', 10);
    return isNaN(parsed) ? 0 : parsed;
  }, [sectionParam]);

  const progress = useAcademyStore(selectAcademyProgress);
  const fetchProgress = useAcademyStore((s) => s.fetchProgress);

  const [moduleInfo, setModuleInfo] = useState<ModuleInfo | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [quizQuestions, setQuizQuestions] = useState<QuizFormQuestion[] | null>(null);
  const [quizResult, setQuizResult] = useState<QuizResultData | null>(null);
  const [loading, setLoading] = useState(true);
  const [markingRead, setMarkingRead] = useState(false);
  const [submittingQuiz, setSubmittingQuiz] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [courseContext, setCourseContext] = useState<CourseContext | null>(null);

  const contentLoadedRef = useRef(false);
  const quizLoadedRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchProgress();
  }, [fetchProgress]);

  // Load module info
  useEffect(() => {
    if (!moduleId) return;
    let cancelled = false;

    async function loadModuleInfo() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/academy/modules/${moduleId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg =
            body?.error?.message ?? body?.error ?? `Failed to load module (${res.status})`;
          if (!cancelled) setError(typeof msg === 'string' ? msg : String(msg));
          return;
        }
        const data = await res.json();
        if (!cancelled) setModuleInfo(data.data ?? data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadModuleInfo();
    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  // Load course context when courseId is present
  useEffect(() => {
    if (!courseId) {
      setCourseContext(null);
      return;
    }
    let cancelled = false;

    async function loadCourse() {
      try {
        const res = await apiFetch(`/api/academy/courses/${courseId}`);
        if (!res.ok) return;
        const data = await res.json();
        const course = data.data ?? data;
        if (!cancelled && course) {
          const moduleIds: string[] = course.modules ?? [];
          const moduleDetails: Array<{ id: string; title: string }> = [];

          const results = await Promise.allSettled(
            moduleIds.map(async (id: string) => {
              const modRes = await apiFetch(`/api/academy/modules/${id}`);
              if (!modRes.ok) return { id, title: id };
              const modData = await modRes.json();
              const mod = modData.data ?? modData;
              return { id: mod.id ?? id, title: mod.title ?? id };
            }),
          );

          for (const result of results) {
            if (result.status === 'fulfilled') {
              moduleDetails.push(result.value);
            }
          }

          if (!cancelled) {
            setCourseContext({
              id: course.id ?? courseId,
              title: course.title ?? '',
              modules: moduleDetails,
            });
          }
        }
      } catch {
        // Course context is optional — failure is non-critical
      }
    }

    loadCourse();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  // Load content eagerly (always needed for section splitting)
  useEffect(() => {
    if (!moduleId || contentLoadedRef.current) return;
    let cancelled = false;

    async function loadContent() {
      try {
        const res = await apiFetch(`/api/academy/modules/${moduleId}/content`);
        if (!res.ok) return;
        const data = await res.json();
        const contentStr =
          typeof data?.data === 'string'
            ? data.data
            : typeof data?.data?.content === 'string'
              ? data.data.content
              : '';
        if (!cancelled) {
          setContent(contentStr);
          contentLoadedRef.current = true;
        }
      } catch {
        // Content load failure is non-critical
      }
    }

    loadContent();
    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  // Load quiz when quiz section is active
  useEffect(() => {
    if (currentSection !== 'quiz' || !moduleId || quizLoadedRef.current) return;
    let cancelled = false;

    async function loadQuiz() {
      try {
        const res = await apiFetch(`/api/academy/modules/${moduleId}/quiz`);
        if (!res.ok) return;
        const data = await res.json();
        const quizData = data.data ?? data;
        if (!cancelled && quizData?.questions) {
          setQuizQuestions(quizData.questions);
          quizLoadedRef.current = true;
        }
      } catch {
        // Quiz load failure is non-critical
      }
    }

    loadQuiz();
    return () => {
      cancelled = true;
    };
  }, [currentSection, moduleId]);

  // Split markdown into sections
  const sections: MarkdownSection[] = useMemo(() => {
    if (!content) return [];
    return splitMarkdownSections(content, moduleInfo?.title ?? t('section_intro'));
  }, [content, moduleInfo?.title, t]);

  // Clamp section index to valid range
  const validSection: number | 'quiz' = useMemo(() => {
    if (currentSection === 'quiz') return 'quiz';
    if (sections.length === 0) return 0;
    return Math.min(currentSection, sections.length - 1);
  }, [currentSection, sections.length]);

  // Scroll content to top when section changes
  useEffect(() => {
    scrollContainerRef.current?.scrollTo(0, 0);
  }, [validSection]);

  const handleNavigate = useCallback(
    (targetModuleId: string, section: number | 'quiz') => {
      const cid = courseId ?? courseContext?.id;
      const params = new URLSearchParams();
      if (cid) params.set('courseId', cid);
      params.set('section', String(section));
      router.push(`/academy/modules/${targetModuleId}?${params.toString()}`);
    },
    [router, courseId, courseContext?.id],
  );

  const handleMarkRead = useCallback(async () => {
    if (!moduleId) return;
    setMarkingRead(true);
    try {
      const res = await apiFetch(`/api/academy/modules/${moduleId}/read`, {
        method: 'POST',
      });
      if (res.ok) {
        await fetchProgress();
        toast.success(t('mark_read_success'));
      }
    } catch {
      // Mark-read failure is non-critical
    } finally {
      setMarkingRead(false);
    }
  }, [moduleId, fetchProgress, t]);

  const handleQuizSubmit = useCallback(
    async (answers: Array<{ questionId: string; answer: string }>) => {
      if (!moduleId) return;
      setSubmittingQuiz(true);
      try {
        const res = await apiFetch(`/api/academy/modules/${moduleId}/quiz`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg =
            body?.error?.message ?? body?.error ?? `Quiz submission failed (${res.status})`;
          setError(typeof msg === 'string' ? msg : String(msg));
          return;
        }
        const data = await res.json();
        const quizData = data.data ?? data;
        setQuizResult(quizData);
        toast.success(quizData.passed ? t('quiz_passed') : t('quiz_failed'));
        await fetchProgress();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmittingQuiz(false);
      }
    },
    [moduleId, fetchProgress, t],
  );

  const handleQuizRetry = useCallback(() => {
    setQuizResult(null);
  }, []);

  // Compute prev/next modules from course context
  const { prevModule, nextModule } = useMemo(() => {
    if (!courseContext) return { prevModule: null, nextModule: null };
    const idx = courseContext.modules.findIndex((m) => m.id === moduleId);
    if (idx < 0) return { prevModule: null, nextModule: null };
    return {
      prevModule: idx > 0 ? courseContext.modules[idx - 1] : null,
      nextModule: idx < courseContext.modules.length - 1 ? courseContext.modules[idx + 1] : null,
    };
  }, [courseContext, moduleId]);

  // Build breadcrumb items
  const breadcrumbs = useMemo(() => {
    const items: Array<{ label: string; href?: string }> = [
      { label: t('title'), href: '/academy' },
    ];
    if (courseContext) {
      items.push({
        label: courseContext.title,
        href: `/academy/courses/${courseContext.id}`,
      });
    }
    items.push({ label: moduleInfo?.title ?? t('loading') });
    return items;
  }, [courseContext, moduleInfo, t]);

  // Build sidebar progress map
  const sidebarProgress = useMemo(() => {
    if (!progress?.modules) return null;
    const map: Record<string, { contentRead: boolean; quizPassed: boolean }> = {};
    for (const [id, modProgress] of Object.entries(progress.modules)) {
      map[id] = {
        contentRead: modProgress.contentRead,
        quizPassed: modProgress.quizPassed,
      };
    }
    return map;
  }, [progress?.modules]);

  const isRead = progress?.modules?.[moduleId]?.contentRead ?? false;

  // Section-level progress: currentSection / totalSections
  const sectionProgressPercent = useMemo(() => {
    if (sections.length === 0) return 0;
    const totalSteps = sections.length + 1; // content sections + quiz
    const currentStep = validSection === 'quiz' ? sections.length : validSection;
    return Math.round(((currentStep + 1) / totalSteps) * 100);
  }, [sections.length, validSection]);

  // Sidebar content (shared between desktop and mobile)
  const sidebarContent = courseContext ? (
    <ModuleStepSidebar
      courseId={courseContext.id}
      courseTitle={courseContext.title}
      modules={courseContext.modules}
      currentModuleId={moduleId}
      currentSection={validSection}
      sections={sections}
      progress={sidebarProgress}
    />
  ) : null;

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <SkeletonText lines={1} className="w-64" />
        <Skeleton className="h-64 w-full rounded-lg" />
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

  if (!moduleInfo) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-foreground-muted">{t('module_not_found')}</p>
      </div>
    );
  }

  return (
    <div className={`grid grid-cols-1 gap-6 ${courseContext ? 'lg:grid-cols-[280px_1fr]' : ''}`}>
      {/* Left: Unified sidebar — desktop */}
      {sidebarContent && <div className="hidden lg:block">{sidebarContent}</div>}

      {/* Center: main content area — fixed header/footer with scrollable content */}
      <div className="flex min-w-0 flex-col" style={{ height: 'calc(100vh - 64px)' }}>
        {/* Sticky header: breadcrumbs + title + progress */}
        <div className="shrink-0 border-b border-border bg-background pb-3">
          <div className="flex items-center gap-2 px-1">
            {/* Mobile sidebar sheet trigger */}
            {sidebarContent && (
              <div className="lg:hidden">
                <Sheet>
                  <SheetTrigger asChild>
                    <button
                      type="button"
                      className="rounded-lg border border-border p-2 transition-default hover:bg-background-muted"
                      aria-label={t('menu')}
                    >
                      <Menu className="h-4 w-4" />
                    </button>
                  </SheetTrigger>
                  <SheetContent side="left" className="w-72 p-0">
                    {sidebarContent}
                  </SheetContent>
                </Sheet>
              </div>
            )}
            <AcademyBreadcrumbs items={breadcrumbs} />
          </div>

          {/* Module header */}
          <div className="mt-3 px-1">
            <h2 className="text-lg font-semibold text-foreground">{moduleInfo.title}</h2>
            {validSection !== 'quiz' && sections[validSection] && (
              <p className="mt-1 text-xs text-foreground-muted">{sections[validSection].title}</p>
            )}
          </div>

          {/* Section progress bar */}
          <div className="mt-2 px-1">
            <ProgressBar value={sectionProgressPercent} />
          </div>
        </div>

        {/* Scrollable content area */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-1 py-4">
          {validSection === 'quiz' ? (
            // ─── Quiz view ─────────────────────────────────────
            <div>
              {quizResult ? (
                <QuizResults result={quizResult} onRetry={handleQuizRetry} />
              ) : quizQuestions ? (
                <QuizForm
                  questions={quizQuestions}
                  onSubmit={handleQuizSubmit}
                  submitting={submittingQuiz}
                />
              ) : (
                <p className="text-sm text-foreground-muted">{t('loading')}</p>
              )}
            </div>
          ) : (
            // ─── Section content view ──────────────────────────
            <div className="flex flex-col gap-4">
              {/* Video player — shown above text when section has a video */}
              {typeof validSection === 'number' &&
                sections[validSection] &&
                moduleInfo?.videos?.[sections[validSection].id] && (
                  <VideoPlayer
                    url={moduleInfo.videos[sections[validSection].id].url}
                    title={moduleInfo.videos[sections[validSection].id].title}
                  />
                )}

              {content !== null && sections[validSection] ? (
                <MarkdownContent content={sections[validSection].content} />
              ) : (
                <Skeleton className="h-64 w-full rounded-lg" />
              )}

              {/* Mark as read button — show on last content section if not yet read */}
              {!isRead &&
                content !== null &&
                typeof validSection === 'number' &&
                validSection === sections.length - 1 && (
                  <button
                    type="button"
                    onClick={handleMarkRead}
                    disabled={markingRead}
                    className="self-start rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {markingRead ? t('marking_read') : t('mark_as_read')}
                  </button>
                )}

              {isRead &&
                typeof validSection === 'number' &&
                validSection === sections.length - 1 && (
                  <p className="text-xs font-medium text-success">{t('already_read')}</p>
                )}
            </div>
          )}
        </div>

        {/* Fixed footer navigation */}
        {courseContext && (
          <div className="shrink-0">
            <SectionFooterNav
              currentSection={validSection}
              sections={sections}
              courseId={courseContext.id}
              moduleId={moduleId}
              prevModule={prevModule}
              nextModule={nextModule}
              onNavigate={handleNavigate}
            />
          </div>
        )}
      </div>
    </div>
  );
}
