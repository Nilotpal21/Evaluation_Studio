'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, XCircle, Trophy, Award, RotateCcw } from 'lucide-react';
import { motion, useMotionValue, useTransform, animate } from 'framer-motion';
import confetti from 'canvas-confetti';

export interface QuizResultData {
  score: number;
  passed: boolean;
  pointsAwarded: number;
  results: Array<{
    questionId: string;
    correct: boolean;
    explanation: string;
  }>;
  newBadges: string[];
  rank: string;
}

interface QuizResultsProps {
  result: QuizResultData;
  onRetry: () => void;
}

export function QuizResults({ result, onRetry }: QuizResultsProps) {
  const t = useTranslations('academy');

  const scorePercent = Math.round(result.score * 100);

  // Animated score counter
  const motionValue = useMotionValue(0);
  const rounded = useTransform(motionValue, (v) => Math.round(v));
  const [displayScore, setDisplayScore] = useState(0);

  useEffect(() => {
    const controls = animate(motionValue, scorePercent, {
      duration: 1.5,
      ease: 'easeOut',
    });
    const unsubscribe = rounded.on('change', (v) => setDisplayScore(v));
    return () => {
      controls.stop();
      unsubscribe();
    };
  }, [scorePercent, motionValue, rounded]);

  // Confetti on pass
  const confettiFired = useRef(false);

  useEffect(() => {
    if (result.passed && !confettiFired.current) {
      confettiFired.current = true;
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
      });
    }
  }, [result.passed]);

  return (
    <div className="flex flex-col gap-6">
      {/* Score header */}
      <div
        className={`flex flex-col items-center gap-3 rounded-xl border p-6 ${
          result.passed ? 'border-success bg-success-subtle' : 'border-error bg-error-subtle'
        }`}
      >
        {result.passed ? (
          <Trophy className="h-10 w-10 text-success" />
        ) : (
          <XCircle className="h-10 w-10 text-error" />
        )}
        <div className="text-center">
          <p className="text-2xl font-bold text-foreground">{displayScore}%</p>
          <p className="text-sm font-medium text-foreground-muted">
            {result.passed ? t('quiz_passed') : t('quiz_failed')}
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs text-foreground-muted">
          <span>{t('points_awarded', { points: result.pointsAwarded })}</span>
          <span className="text-foreground-subtle">·</span>
          <span>{t('rank_label', { rank: result.rank })}</span>
        </div>
      </div>

      {/* New badges */}
      {result.newBadges.length > 0 && (
        <div className="rounded-lg border border-accent bg-accent-subtle p-4">
          <div className="mb-2 flex items-center gap-2">
            <Award className="h-4 w-4 text-accent" />
            <h4 className="text-sm font-semibold text-foreground">{t('new_badges')}</h4>
          </div>
          <div className="flex flex-wrap gap-2">
            {result.newBadges.map((badge, i) => (
              <motion.span
                key={badge}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{
                  delay: 1.5 + i * 0.15,
                  type: 'spring',
                  stiffness: 400,
                  damping: 30,
                }}
                className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground"
              >
                {badge}
              </motion.span>
            ))}
          </div>
        </div>
      )}

      {/* Per-question results */}
      <div className="flex flex-col gap-3">
        <h4 className="text-sm font-semibold text-foreground">{t('question_results')}</h4>
        {result.results.map((r, idx) => (
          <div
            key={r.questionId}
            className={`rounded-lg border p-4 ${
              r.correct
                ? 'border-success-subtle bg-success-subtle'
                : 'border-error-subtle bg-error-subtle'
            }`}
          >
            <div className="mb-1 flex items-center gap-2">
              {r.correct ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <XCircle className="h-4 w-4 text-error" />
              )}
              <span className="text-sm font-medium text-foreground">
                {t('question_number', { number: idx + 1 })}
              </span>
            </div>
            <p className="ml-6 text-xs leading-relaxed text-foreground-muted">{r.explanation}</p>
          </div>
        ))}
      </div>

      {/* Retry button */}
      {!result.passed && (
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-2 self-start rounded-lg border border-border bg-background-elevated px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-background-muted"
        >
          <RotateCcw className="h-4 w-4" />
          {t('retry_quiz')}
        </button>
      )}
    </div>
  );
}
