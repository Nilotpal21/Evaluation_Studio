'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiFetch } from '@/lib/api-client';
import type { CsatData } from './preview-chat-utils';

interface CsatRatingCardProps {
  prompt: string;
  csatData: CsatData;
  projectId: string;
}

const CSAT_EMOJIS = ['😞', '😐', '😊', '😄', '🤩'];

function CsatButtons({
  surveyType,
  selected,
  onSelect,
}: {
  surveyType: CsatData['surveyType'];
  selected: number | null;
  onSelect: (score: number) => void;
}) {
  const t = useTranslations('preview.csat');

  if (surveyType === 'likeDislike') {
    return (
      <div className="flex gap-3" role="group" aria-label={t('rate_experience')}>
        {[
          { label: t('thumbs_yes'), score: 1 },
          { label: t('thumbs_no'), score: 0 },
        ].map(({ label, score }) => (
          <button
            key={score}
            type="button"
            aria-label={label}
            aria-pressed={selected === score}
            onClick={() => onSelect(score)}
            className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
              selected === score
                ? 'border-accent bg-accent text-accent-foreground'
                : 'border-default bg-background text-foreground hover:bg-background-subtle'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    );
  }

  if (surveyType === 'nps') {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('rate_experience')}>
          {Array.from({ length: 11 }, (_, i) => i).map((score) => (
            <button
              key={score}
              type="button"
              aria-label={t('score_label', { score })}
              aria-pressed={selected === score}
              onClick={() => onSelect(score)}
              className={`h-8 w-8 rounded-md border text-sm font-medium transition-colors ${
                selected === score
                  ? 'border-accent bg-accent text-accent-foreground'
                  : 'border-default bg-background text-foreground hover:bg-background-subtle'
              }`}
            >
              {score}
            </button>
          ))}
        </div>
        <div className="flex justify-between text-xs text-muted">
          <span>{t('not_likely')}</span>
          <span>{t('extremely_likely')}</span>
        </div>
      </div>
    );
  }

  // Default: csat — 5 emoji buttons
  return (
    <div className="flex gap-2" role="group" aria-label={t('rate_experience')}>
      {CSAT_EMOJIS.map((emoji, idx) => {
        const score = idx + 1;
        return (
          <button
            key={score}
            type="button"
            aria-label={t('star_label', { score })}
            aria-pressed={selected === score}
            onClick={() => onSelect(score)}
            className={`flex flex-col items-center rounded-lg border px-3 py-2 text-xl transition-colors ${
              selected === score
                ? 'border-accent bg-accent'
                : 'border-default bg-background hover:bg-background-subtle'
            }`}
          >
            {emoji}
            <span className="mt-1 text-xs text-muted">{score}</span>
          </button>
        );
      })}
    </div>
  );
}

export function CsatRatingCard({ prompt, csatData, projectId }: CsatRatingCardProps) {
  const t = useTranslations('preview.csat');
  const [selected, setSelected] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'submitted' | 'error'>('idle');
  const [gratitude, setGratitude] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async () => {
    if (selected === null || status === 'submitting' || status === 'submitted') return;
    setStatus('submitting');
    setErrorMsg('');

    try {
      const res = await apiFetch(`/api/projects/${projectId}/agent-transfer/csat/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: csatData.provider,
          userId: csatData.userId,
          channel: csatData.channel,
          botId: csatData.botId,
          orgId: csatData.orgId,
          conversationId: csatData.conversationId,
          score: selected,
          surveyType: csatData.surveyType,
          comments: comment || undefined,
        }),
      });

      const data = (await res.json()) as {
        success: boolean;
        data?: { message?: string };
        error?: { message?: string };
      };

      if (!res.ok) {
        throw new Error(data?.error?.message ?? t('error_failed'));
      }

      setGratitude(data.data?.message ?? t('thank_you'));
      setStatus('submitted');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('error_failed'));
      setStatus('error');
    }
  };

  if (status === 'submitted') {
    return (
      <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-background-subtle px-4 py-3 text-foreground">
        <p className="text-sm">{gratitude}</p>
      </div>
    );
  }

  return (
    <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-background-subtle px-4 py-3 text-foreground space-y-3">
      <p className="text-sm">{prompt}</p>

      <CsatButtons surveyType={csatData.surveyType} selected={selected} onSelect={setSelected} />

      {selected !== null && (
        <>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t('optional_comment')}
            maxLength={1000}
            rows={2}
            className="w-full resize-none rounded-lg border border-default bg-background px-3 py-2 text-sm text-foreground placeholder-subtle focus:outline-none focus:border-border-focus"
          />

          {status === 'error' && <p className="text-xs text-error">{errorMsg}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={status === 'submitting'}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
            >
              {status === 'submitting' ? t('submitting') : t('submit')}
            </button>
            {status === 'error' && (
              <button
                type="button"
                onClick={handleSubmit}
                className="rounded-lg border border-default px-4 py-2 text-sm font-medium text-foreground hover:bg-background-subtle"
              >
                {t('retry')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
