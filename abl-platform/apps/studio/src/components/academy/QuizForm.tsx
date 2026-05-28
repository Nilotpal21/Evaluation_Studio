'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ProgressBar } from './ProgressBar';

export interface QuizFormQuestion {
  id: string;
  type: 'mcq' | 'fill-blank';
  stem: string;
  options?: Array<{ id: string; text: string }>;
}

interface QuizFormProps {
  questions: QuizFormQuestion[];
  onSubmit: (answers: Array<{ questionId: string; answer: string }>) => void;
  submitting?: boolean;
}

const slideVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 200 : -200,
    opacity: 0,
  }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({
    x: direction > 0 ? -200 : 200,
    opacity: 0,
  }),
};

export function QuizForm({ questions, onSubmit, submitting }: QuizFormProps) {
  const t = useTranslations('academy');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);

  const total = questions.length;
  const currentQ = questions[step];
  const isFirst = step === 0;
  const isLast = step === total - 1;

  const handleChange = useCallback((questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  }, []);

  const handlePrev = useCallback(() => {
    setDirection(-1);
    setStep((s) => Math.max(0, s - 1));
  }, []);

  const handleNext = useCallback(() => {
    setDirection(1);
    setStep((s) => Math.min(total - 1, s + 1));
  }, [total]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const submission = questions.map((q) => ({
        questionId: q.id,
        answer: answers[q.id] ?? '',
      }));
      onSubmit(submission);
    },
    [answers, questions, onSubmit],
  );

  const allAnswered = questions.every((q) => {
    const answer = answers[q.id];
    return answer !== undefined && answer.trim() !== '';
  });

  const currentAnswered = currentQ ? (answers[currentQ.id] ?? '').trim() !== '' : false;

  const progressPercent = total > 0 ? Math.round(((step + 1) / total) * 100) : 0;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* Step indicator + progress */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-foreground-muted">
          {t('quiz_step', { current: step + 1, total })}
        </span>
        <ProgressBar value={progressPercent} />
      </div>

      {/* Animated question card */}
      <div className="relative min-h-[200px] overflow-hidden">
        <AnimatePresence mode="wait" custom={direction}>
          {currentQ && (
            <motion.div
              key={currentQ.id}
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="rounded-lg border border-border bg-background-elevated p-5"
            >
              <p className="mb-4 text-sm font-medium text-foreground">
                <span className="mr-2 text-foreground-muted">{step + 1}.</span>
                {currentQ.stem}
              </p>

              {currentQ.type === 'mcq' && currentQ.options ? (
                <div className="flex flex-col gap-2">
                  {currentQ.options.map((opt) => (
                    <label
                      key={opt.id}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-2.5 text-sm transition-all ${
                        answers[currentQ.id] === opt.id
                          ? 'border-accent bg-accent-subtle text-foreground'
                          : 'border-border-muted bg-background-subtle text-foreground-muted hover:border-border hover:bg-background-muted'
                      }`}
                    >
                      <input
                        type="radio"
                        name={currentQ.id}
                        value={opt.id}
                        checked={answers[currentQ.id] === opt.id}
                        onChange={() => handleChange(currentQ.id, opt.id)}
                        className="sr-only"
                        aria-label={opt.text}
                      />
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                          answers[currentQ.id] === opt.id
                            ? 'border-accent bg-accent'
                            : 'border-foreground-subtle'
                        }`}
                      >
                        {answers[currentQ.id] === opt.id && (
                          <span className="h-1.5 w-1.5 rounded-full bg-accent-foreground" />
                        )}
                      </span>
                      {opt.text}
                    </label>
                  ))}
                </div>
              ) : (
                <input
                  type="text"
                  value={answers[currentQ.id] ?? ''}
                  onChange={(e) => handleChange(currentQ.id, e.target.value)}
                  placeholder={t('fill_blank_placeholder')}
                  aria-label={t('fill_blank_aria', { number: step + 1 })}
                  className="w-full rounded-lg border border-border bg-background-subtle px-4 py-2.5 text-sm text-foreground placeholder:text-foreground-subtle focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus"
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Navigation buttons */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={handlePrev}
          disabled={isFirst}
          className="flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground-muted transition-default hover:bg-background-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" />
          {t('quiz_previous')}
        </button>

        {isLast ? (
          <button
            type="submit"
            disabled={!allAnswered || submitting}
            className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? t('submitting') : t('submit_quiz')}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleNext}
            disabled={!currentAnswered}
            className="flex items-center gap-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-default hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('quiz_next')}
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </div>
    </form>
  );
}
