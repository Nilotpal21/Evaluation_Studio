/**
 * QuestionPrompt Component
 *
 * Displays contextual questions from the backend's decision engine
 * when crawl confidence is too low to auto-decide. Users answer 2-3
 * questions (choice or range/number), then the responses are sent back
 * to finalise the crawl strategy.
 */

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { HelpCircle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

export interface PromptQuestion {
  id: string;
  text?: string; // Legacy field
  question?: string; // Backend field
  type?: 'choice' | 'range' | 'number';
  options?: Array<{
    value: string;
    label: string;
    description?: string;
  }>;
  range?: { min: number; max: number; step?: number };
  defaultValue?: string | number;
}

interface QuestionPromptProps {
  questions: PromptQuestion[];
  onSubmit: (responses: Array<{ questionId: string; value: string }>) => void;
  onCancel: () => void;
  submitting?: boolean;
}

function getDefaultAnswer(q: PromptQuestion): string {
  if (q.defaultValue !== undefined && q.defaultValue !== null) {
    return String(q.defaultValue);
  }
  if (q.range) {
    return String(q.range.min);
  }
  if (q.options?.length) {
    const recommended = q.options.find((o) => (o as { recommended?: boolean }).recommended);
    return recommended?.value ?? q.options[0]?.value ?? '';
  }
  return '';
}

export function QuestionPrompt({ questions, onSubmit, onCancel, submitting }: QuestionPromptProps) {
  const t = useTranslations('search_ai.question_prompt');
  const [answers, setAnswers] = useState<Record<string, string>>({});

  // Initialise answers from defaults once so range/number questions are pre-filled and Start Crawl is enabled
  useEffect(() => {
    setAnswers((prev) => {
      const initial: Record<string, string> = {};
      questions.forEach((q) => {
        initial[q.id] = getDefaultAnswer(q);
      });
      return initial;
    });
  }, [questions]);

  const allAnswered = questions.every((q) => {
    const a = answers[q.id];
    return a !== undefined && a !== null && String(a).trim() !== '';
  });

  const handleSubmit = () => {
    const responses = Object.entries(answers)
      .filter(([_, answer]) => answer !== undefined && String(answer).trim() !== '')
      .map(([questionId, answer]) => ({ questionId, value: answer }));
    onSubmit(responses);
  };

  return (
    <Card padding="lg" hoverable={false}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-info-subtle flex items-center justify-center shrink-0">
            <HelpCircle className="w-5 h-5 text-info" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">{t('title')}</h3>
            <p className="text-sm text-muted mt-0.5">{t('description')}</p>
          </div>
        </div>

        {/* Questions */}
        {questions.map((question) => {
          const isRange = question.type === 'range' || question.type === 'number';
          const range = question.range;
          const hasOptions = question.options && question.options.length > 0;

          return (
            <div key={question.id} className="space-y-3">
              <p className="text-sm font-medium text-foreground">
                {question.question || question.text}
              </p>
              {hasOptions && (
                <div className="space-y-2">
                  {(question.options || []).map((option) => {
                    const isSelected = answers[question.id] === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() =>
                          setAnswers((prev) => ({ ...prev, [question.id]: option.value }))
                        }
                        className={`w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-default ${
                          isSelected
                            ? 'border-accent bg-accent-subtle'
                            : 'border-default hover:border-accent hover:bg-background-muted'
                        }`}
                      >
                        <span
                          className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                            isSelected ? 'border-accent' : 'border-default'
                          }`}
                        >
                          {isSelected && <span className="w-2 h-2 rounded-full bg-accent" />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-foreground">
                            {option.label}
                          </span>
                          {option.description && (
                            <p className="text-xs text-muted mt-0.5">{option.description}</p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {isRange && range && (
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={range.min}
                    max={range.max}
                    step={range.step ?? 1}
                    value={Number(answers[question.id]) || range.min}
                    onChange={(e) =>
                      setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))
                    }
                    className="flex-1 h-2 rounded-lg appearance-none cursor-pointer accent-accent"
                  />
                  <Input
                    type="number"
                    min={range.min}
                    max={range.max}
                    step={range.step ?? 1}
                    value={answers[question.id] ?? range.min}
                    onChange={(e) =>
                      setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))
                    }
                    className="w-20 shrink-0"
                  />
                </div>
              )}
            </div>
          );
        })}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleSubmit}
            disabled={!allAnswered || submitting}
            loading={submitting}
          >
            {t('start_crawl')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
