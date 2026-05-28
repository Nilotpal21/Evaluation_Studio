'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Award, Check, Lock } from 'lucide-react';
import confetti from 'canvas-confetti';

interface CertificationSectionProps {
  badgeId: string;
  badgeTitle: string;
  earned: boolean;
}

export function CertificationSection({ badgeId, badgeTitle, earned }: CertificationSectionProps) {
  const t = useTranslations('academy');

  // Confetti when certification is earned
  const prevEarned = useRef(earned);
  const confettiFired = useRef(false);

  useEffect(() => {
    if (earned && (!prevEarned.current || !confettiFired.current)) {
      confettiFired.current = true;
      confetti({
        particleCount: 80,
        spread: 60,
        origin: { y: 0.7 },
      });
    }
    prevEarned.current = earned;
  }, [earned]);

  return (
    <div
      data-badge-id={badgeId}
      className={`rounded-lg border p-5 ${
        earned
          ? 'animate-fade-in-scale gradient-glow-accent border-success bg-success-subtle'
          : 'border-border bg-background-elevated'
      }`}
    >
      <div className="flex items-center gap-4">
        {/* Badge icon */}
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${
            earned
              ? 'bg-success text-success-foreground'
              : 'bg-background-muted text-foreground-muted'
          }`}
        >
          {earned ? <Award className="h-6 w-6" /> : <Lock className="h-6 w-6" />}
        </div>

        {/* Text content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">{t('certification_badge')}</h4>
            {earned && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success px-2 py-0.5 text-[10px] font-medium text-success-foreground">
                <Check className="h-3 w-3" />
                {t('certification_earned')}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-foreground-muted">{badgeTitle}</p>
          {!earned && (
            <p className="mt-1 text-xs text-foreground-subtle">{t('certification_required')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
