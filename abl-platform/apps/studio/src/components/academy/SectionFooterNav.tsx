'use client';

import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { MarkdownSection } from '@/lib/academy/split-markdown-sections';

interface ModuleRef {
  id: string;
  title: string;
}

interface SectionFooterNavProps {
  /** Current section index, or 'quiz' */
  currentSection: number | 'quiz';
  /** All sections in the current module */
  sections: MarkdownSection[];
  /** Current course ID for URL building */
  courseId: string;
  /** Current module ID */
  moduleId: string;
  /** Previous module in the course (null if first) */
  prevModule: ModuleRef | null;
  /** Next module in the course (null if last) */
  nextModule: ModuleRef | null;
  /** Called when user navigates */
  onNavigate: (moduleId: string, section: number | 'quiz') => void;
}

export function SectionFooterNav({
  currentSection,
  sections,
  moduleId,
  prevModule,
  nextModule,
  onNavigate,
}: SectionFooterNavProps) {
  const t = useTranslations('academy');

  const totalContentSections = sections.length;
  const sectionIndex = currentSection === 'quiz' ? totalContentSections : currentSection;
  // Total steps: all content sections + 1 quiz
  const totalSteps = totalContentSections + 1;

  // ─── Prev logic ────────────────────────────────────────
  let prevLabel: string | null = null;
  let onPrev: (() => void) | null = null;

  if (currentSection === 'quiz') {
    // Quiz → last content section
    if (totalContentSections > 0) {
      const lastIdx = totalContentSections - 1;
      prevLabel = t('prev_section', { title: sections[lastIdx].title });
      onPrev = () => onNavigate(moduleId, lastIdx);
    }
  } else if (currentSection > 0) {
    // Content section → previous content section
    prevLabel = t('prev_section', { title: sections[currentSection - 1].title });
    onPrev = () => onNavigate(moduleId, currentSection - 1);
  } else if (currentSection === 0 && prevModule) {
    // First section → previous module
    prevLabel = t('prev_module_label', { title: prevModule.title });
    onPrev = () => onNavigate(prevModule.id, 0);
  }

  // ─── Next logic ────────────────────────────────────────
  let nextLabel: string | null = null;
  let onNext: (() => void) | null = null;

  if (currentSection === 'quiz') {
    // Quiz → next module
    if (nextModule) {
      nextLabel = t('next_module_label', { title: nextModule.title });
      onNext = () => onNavigate(nextModule.id, 0);
    }
  } else if (currentSection < totalContentSections - 1) {
    // Content section → next content section
    nextLabel = t('next_section', { title: sections[currentSection + 1].title });
    onNext = () => onNavigate(moduleId, currentSection + 1);
  } else {
    // Last content section → quiz
    nextLabel = t('continue_to_quiz');
    onNext = () => onNavigate(moduleId, 'quiz');
  }

  return (
    <nav className="flex items-center justify-between border-t border-border bg-background px-4 py-3">
      {/* Previous */}
      <div className="min-w-0 flex-1">
        {onPrev ? (
          <button
            type="button"
            onClick={onPrev}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-foreground-muted transition-colors hover:bg-background-muted hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4 shrink-0" />
            <span className="truncate">{prevLabel}</span>
          </button>
        ) : (
          <span />
        )}
      </div>

      {/* Step indicator */}
      <span className="shrink-0 text-xs text-foreground-subtle">
        {t('section_of', { current: sectionIndex + 1, total: totalSteps })}
      </span>

      {/* Next */}
      <div className="min-w-0 flex-1 text-right">
        {onNext ? (
          <button
            type="button"
            onClick={onNext}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted"
          >
            <span className="truncate">{nextLabel}</span>
            <ChevronRight className="h-4 w-4 shrink-0" />
          </button>
        ) : (
          <span />
        )}
      </div>
    </nav>
  );
}
